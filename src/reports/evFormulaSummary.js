// src/reports/evFormulaSummary.js
import fs from 'fs/promises';
import { getDb, closeDb } from '../db/mongoClient.js';

const TELEGRAM_RULES_PATH = new URL('../../config/telegramUnitRules.json', import.meta.url);

// ----------------------------------------------------------- //

// node src/reports/evFormulaSummary.js --optimal --optimal-min-bets=1000

// ----------------------------------------------------------- //

const parseArgs = () => {
  const args = {};
  process.argv.slice(2).forEach((raw) => {
    if (!raw.startsWith('--')) return;
    const [key, ...rest] = raw.slice(2).split('=');
    const value = rest.length ? rest.join('=') : true;
    args[key] = value;
  });
  if (args['range-odds']) {
    const [min, max] = String(args['range-odds'])
      .split('-')
      .map((v) => Number(v));
    if (Number.isFinite(min)) args['min-odds'] = min;
    if (Number.isFinite(max)) args['max-odds'] = max;
  }
  return args;
};

const toArray = (value) => {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
};

const toNumber = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const toDate = (value) => {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? new Date(ts) : null;
};

const parseNumberList = (value) => {
  if (!value) return null;
  return String(value)
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((num) => Number.isFinite(num));
};

const parseRangeList = (value) => {
  if (!value) return null;
  return String(value)
    .split(';')
    .map((chunk) => {
      if (!chunk.trim()) return null;
      const [minStr, maxStr] = chunk.split('-');
      const min = minStr === '' || minStr === undefined ? null : Number(minStr);
      const max = maxStr === '' || maxStr === undefined ? null : Number(maxStr);
      if (min !== null && !Number.isFinite(min)) return null;
      if (max !== null && !Number.isFinite(max)) return null;
      return { min, max };
    })
    .filter(Boolean);
};

const formatRangeLabel = (min, max) => {
  if (min !== null && max !== null) return `${min}-${max}`;
  if (min !== null) return `${min}+`;
  if (max !== null) return `<=${max}`;
  return 'all';
};

const resolveNumber = (value, fallback = null) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

const describeRule = (rule, index) => {
  const oddsPart = `${resolveNumber(rule.minOdds, '-∞')}–${resolveNumber(rule.maxOdds, '∞')}`;
  const evPart = `${resolveNumber(rule.minEv, 0)}–${resolveNumber(rule.maxEv, '∞')}`;
  return `regel #${index + 1} (odds ${oddsPart}, EV ${evPart})`;
};

const matchTelegramUnitRule = (odds, evValue, unitRules = []) => {
  const numericOdds = Number(odds);
  const numericEv = Number(evValue);
  if (!Number.isFinite(numericOdds) || !Number.isFinite(numericEv)) {
    return {
      unit: null,
      ruleLabel: null,
      ruleIndex: null,
      minOdds: null,
      maxOdds: null,
      minEv: null,
      maxEv: null,
      matchedRule: false,
    };
  }

  for (let i = 0; i < unitRules.length; i += 1) {
    const rule = unitRules[i];
    const minOdds = resolveNumber(rule.minOdds, -Infinity);
    const maxOdds = resolveNumber(rule.maxOdds, Infinity);
    const minEv = resolveNumber(rule.minEv, 0);
    const maxEv = resolveNumber(rule.maxEv, Infinity);
    if (
      numericOdds >= minOdds &&
      numericOdds <= maxOdds &&
      numericEv >= minEv &&
      numericEv <= maxEv
    ) {
      const unit = Number(rule.unit);
      const label = describeRule(rule, i);
      return {
        unit: Number.isFinite(unit) ? unit : null,
        ruleLabel: label,
        ruleIndex: i,
        minOdds,
        maxOdds,
        minEv,
        maxEv,
        matchedRule: true,
      };
    }
  }
  return {
    unit: null,
    ruleLabel: null,
    ruleIndex: null,
    minOdds: null,
    maxOdds: null,
    minEv: null,
    maxEv: null,
    matchedRule: false,
  };
};

const pickTelegramUnit = (odds, evValue, unitRules = []) => {
  const { unit } = matchTelegramUnitRule(odds, evValue, unitRules);
  return unit;
};

const loadTelegramUnitRules = async () => {
  try {
    const raw = await fs.readFile(TELEGRAM_RULES_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`Kunde inte läsa telegramUnitRules.json: ${err.message}`);
    return [];
  }
};

const KNOWN_SCOPES = ['total', 'home', 'away', 'firstHalf'];
const KNOWN_SELECTIONS = ['over', 'under'];

const normalizeScope = (value) => {
  if (value === undefined || value === null) return 'total';
  const str = String(value).trim();
  if (!str) return 'total';
  const lower = str.toLowerCase();
  if (lower === 'home') return 'home';
  if (lower === 'away') return 'away';
  if (lower === 'total') return 'total';
  if (
    lower === 'firsthalf' ||
    lower === 'first_half' ||
    lower === 'first-half' ||
    lower === 'first half' ||
    lower === '1h' ||
    lower === '1st half'
  ) {
    return 'firstHalf';
  }
  return 'total';
};

const normalizeSelection = (value) => {
  if (value === undefined || value === null) return 'unknown';
  const str = String(value).trim().toLowerCase();
  if (str === 'over') return 'over';
  if (str === 'under') return 'under';
  return 'unknown';
};

const buildScopeCombos = () => {
  const combos = [];
  const maxMask = 1 << KNOWN_SCOPES.length;
  for (let mask = 1; mask < maxMask; mask += 1) {
    const scopes = [];
    for (let i = 0; i < KNOWN_SCOPES.length; i += 1) {
      if (mask & (1 << i)) {
        scopes.push(KNOWN_SCOPES[i]);
      }
    }
    const label = scopes.length === KNOWN_SCOPES.length ? 'all' : scopes.join('+');
    combos.push({ scopes, label });
  }
  return combos;
};

const buildSelectionCombos = () => [
  { selections: ['over'], label: 'over' },
  { selections: ['under'], label: 'under' },
  { selections: [...KNOWN_SELECTIONS], label: 'over+under' },
];

const computeActualReturn = (bet) => {
  const odds = toNumber(bet.offeredOdds);
  switch ((bet.result || '').toLowerCase()) {
    case 'win':
      return Number.isFinite(odds) ? odds - 1 : null;
    case 'loss':
      return -1;
    case 'push':
      return 0;
    default:
      return null;
  }
};

const computeExpectedEv = (bet) => {
  const evField = toNumber(bet.ev);
  if (Number.isFinite(evField)) return evField;
  const probability = toNumber(bet.probability);
  const odds = toNumber(bet.offeredOdds);
  if (!Number.isFinite(probability) || !Number.isFinite(odds)) return null;
  return probability * odds - 1;
};

const formatPct = (value) => `${(value * 100).toFixed(2)}%`;
const formatUnitSigned = (value, digits = 2) => {
  if (!Number.isFinite(value)) return 'n/a';
  const str = Math.abs(value).toFixed(digits).replace(/\.?0+$/, '');
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${str}u`;
};

const formatStakeLabel = (value) =>
  `${Number(value).toFixed(2).replace(/\.?0+$/, '')}u`;

const resolveFallbackRange = (odds) => {
  const n = Number(odds);
  if (!Number.isFinite(n))
    return { label: 'finns ej med i regler (odds n/a)', minOdds: null, maxOdds: null };
  if (n < 1.01) return { label: 'finns ej med i regler <1.01', minOdds: -Infinity, maxOdds: 1.01 };
  if (n >= 1.01 && n < 1.3)
    return { label: 'finns ej med i regler 1.01-1.3', minOdds: 1.01, maxOdds: 1.3 };
  if (n >= 1.3 && n < 1.6)
    return { label: 'finns ej med i regler 1.3-1.6', minOdds: 1.3, maxOdds: 1.6 };
  if (n >= 6 && n < 9) return { label: 'finns ej med i regler 6-9', minOdds: 6, maxOdds: 9 };
  if (n >= 9) return { label: 'finns ej med i regler 9+', minOdds: 9, maxOdds: Infinity };
  return { label: 'finns ej med i regler (other)', minOdds: null, maxOdds: null };
};

const summarizeBets = (bets, filters = {}, options = {}) => {
  const {
    evMin = 0,
    evMax = null,
    minOdds = null,
    maxOdds = null,
    allowedScopes = null,
    allowedSelections = null,
  } = filters;
  const { getStake = null, collectStakeStats = false } = options;

  const aggregate = new Map();
  const totalsByFormula = new Map();
  const stakeStats = collectStakeStats
    ? { totalBets: 0, totalStake: 0, totalActual: 0, buckets: new Map() }
    : null;
  const stakeStatsByFormula = collectStakeStats ? new Map() : null;
  let processed = 0;
  const normalizedScopes =
    allowedScopes && allowedScopes.size
      ? new Set(Array.from(allowedScopes).map((scope) => normalizeScope(scope)))
      : null;
  const normalizedSelections =
    allowedSelections && allowedSelections.size
      ? new Set(
          Array.from(allowedSelections)
            .map((selection) => normalizeSelection(selection))
            .filter((selection) => selection !== 'unknown'),
        )
      : null;

  const resolveStakeInfo = (bet, ctx) => {
    if (typeof getStake !== 'function') return { stake: 1, ruleLabel: null, matchedRule: null };
    const raw = getStake(bet, ctx);
    if (raw && typeof raw === 'object') {
      const stakeVal = Number(raw.stake);
      return {
        stake: Number.isFinite(stakeVal) && stakeVal > 0 ? stakeVal : 1,
        ruleLabel: raw.ruleLabel ?? null,
        matchedRule: raw.matchedRule ?? null,
        ruleMeta: raw.ruleMeta ?? null,
      };
    }
    const stakeVal = Number(raw);
    return {
      stake: Number.isFinite(stakeVal) && stakeVal > 0 ? stakeVal : 1,
      ruleLabel: null,
      matchedRule: null,
      ruleMeta: null,
    };
  };

  const updateStakeStats = (statsObj, label, stake, actual, meta = null) => {
    if (!statsObj) return;
    statsObj.totalBets += 1;
    statsObj.totalStake += stake;
    if (Number.isFinite(actual)) statsObj.totalActual += actual;
    if (!statsObj.buckets.has(label)) {
      statsObj.buckets.set(label, {
        label,
        bets: 0,
        stakeSum: 0,
        actualSum: 0,
        matchedRule: meta?.matchedRule ?? null,
        unit: meta?.unit ?? null,
        minOdds: meta?.minOdds ?? null,
        maxOdds: meta?.maxOdds ?? null,
      });
    }
    const bucket = statsObj.buckets.get(label);
    bucket.bets += 1;
    bucket.stakeSum += stake;
    if (Number.isFinite(actual)) bucket.actualSum += actual;
  };

  for (const bet of bets) {
    const expectedValue = computeExpectedEv(bet);
    if (!Number.isFinite(expectedValue)) continue;
    if (expectedValue < evMin) continue;
    if (Number.isFinite(evMax) && expectedValue > evMax) continue;
    const odds = toNumber(bet.offeredOdds);
    if (Number.isFinite(minOdds) && (!Number.isFinite(odds) || odds < minOdds)) {
      continue;
    }
    if (Number.isFinite(maxOdds) && (!Number.isFinite(odds) || odds > maxOdds)) {
      continue;
    }

    const scope = normalizeScope(bet.scope);
    if (normalizedScopes && !normalizedScopes.has(scope)) {
      continue;
    }
    const selection = normalizeSelection(bet.selection);
    if (selection === 'unknown') continue;
    if (normalizedSelections && !normalizedSelections.has(selection)) {
      continue;
    }

    const stakeInfo = resolveStakeInfo(bet, { expectedValue, odds, scope, selection });
    const stake = stakeInfo.stake;
    const stakeLabel = (() => {
      if (stakeInfo.matchedRule === false) return resolveFallbackRange(odds).label;
      if (stakeInfo.ruleLabel) return stakeInfo.ruleLabel;
      return `stake ${formatStakeLabel(stake)}`;
    })();
  const stakeMeta =
    stakeInfo.matchedRule === false
        ? { ...resolveFallbackRange(odds), matchedRule: false, unit: 0.5 }
        : { ...(stakeInfo.ruleMeta ?? {}), matchedRule: true };

    processed += 1;
    const formula = bet.formula || 'unknown';
    const key = `${formula}:::${scope}`;

    if (!aggregate.has(key)) {
      aggregate.set(key, {
        formula,
        scope,
        bets: 0,
        stakeSum: 0,
        wins: 0,
        pushes: 0,
        losses: 0,
        expectedSum: 0,
        actualSum: 0,
      });
    }
    const bucket = aggregate.get(key);
    bucket.bets += 1;
    bucket.stakeSum += stake;
    const result = (bet.result || '').toLowerCase();
    if (result === 'win') bucket.wins += 1;
    else if (result === 'push') bucket.pushes += 1;
    else bucket.losses += 1;
    bucket.expectedSum += expectedValue * stake;
    const actual = computeActualReturn(bet);
    const actualWeighted = Number.isFinite(actual) ? actual * stake : null;
    if (Number.isFinite(actualWeighted)) {
      bucket.actualSum += actualWeighted;
    }

    if (!totalsByFormula.has(formula)) {
      totalsByFormula.set(formula, {
        formula,
        bets: 0,
        stakeSum: 0,
        wins: 0,
        pushes: 0,
        losses: 0,
        expectedSum: 0,
        actualSum: 0,
      });
    }
    const total = totalsByFormula.get(formula);
    total.bets += 1;
    total.stakeSum += stake;
    if (result === 'win') total.wins += 1;
    else if (result === 'push') total.pushes += 1;
    else total.losses += 1;
    total.expectedSum += expectedValue * stake;
    if (Number.isFinite(actualWeighted)) {
      total.actualSum += actualWeighted;
    }

    if (collectStakeStats) {
      updateStakeStats(stakeStats, stakeLabel, stake, actualWeighted, stakeMeta);
      if (!stakeStatsByFormula.has(formula)) {
        stakeStatsByFormula.set(formula, {
          totalBets: 0,
          totalStake: 0,
          totalActual: 0,
          buckets: new Map(),
        });
      }
      updateStakeStats(stakeStatsByFormula.get(formula), stakeLabel, stake, actualWeighted, stakeMeta);
    }
  }

  if (!processed) return null;

  const transformStakeStats = (stats) => {
    if (!stats) return null;
    return {
      totalBets: stats.totalBets,
      totalStake: stats.totalStake,
      totalActual: stats.totalActual,
      averageStake: stats.totalBets ? stats.totalStake / stats.totalBets : 0,
      buckets: Array.from(stats.buckets.values())
        .map((bucket) => ({
          label: bucket.label,
          bets: bucket.bets,
          stakeSum: bucket.stakeSum,
          averageStake: bucket.bets ? bucket.stakeSum / bucket.bets : 0,
          actualSum: bucket.actualSum,
          pctOfTotalActual:
            Number.isFinite(stats.totalActual) && stats.totalActual !== 0
              ? bucket.actualSum / stats.totalActual
              : null,
          matchedRule: bucket.matchedRule ?? null,
          unit: bucket.unit ?? null,
          minOdds: bucket.minOdds,
          maxOdds: bucket.maxOdds,
        }))
        .sort((a, b) => {
          const aFallback = a.matchedRule === false;
          const bFallback = b.matchedRule === false;
          if (aFallback !== bFallback) return aFallback ? 1 : -1; // regler först, fallback sist
          const aMin = Number.isFinite(a.minOdds) ? a.minOdds : Infinity;
          const bMin = Number.isFinite(b.minOdds) ? b.minOdds : Infinity;
          if (aMin !== bMin) return aMin - bMin;
          return b.stakeSum - a.stakeSum;
        }),
    };
  };

  const rows = Array.from(aggregate.values()).map((row) => {
    const stakeTotal = row.stakeSum || 0;
    return {
      ...row,
      expectedPerBet: stakeTotal ? row.expectedSum / stakeTotal : 0,
      actualPerBet: stakeTotal ? row.actualSum / stakeTotal : 0,
      roi: stakeTotal ? row.actualSum / stakeTotal : 0,
      averageStake: row.bets ? stakeTotal / row.bets : 0,
    };
  });

  rows.sort((a, b) => {
    if (a.expectedPerBet === b.expectedPerBet) {
      if (a.formula === b.formula) return a.scope.localeCompare(b.scope);
      return a.formula.localeCompare(b.formula);
    }
    return a.expectedPerBet - b.expectedPerBet;
  });

  const totals = Array.from(totalsByFormula.values()).map((total) => {
    const stakeTotal = total.stakeSum || 0;
    return {
      ...total,
      expectedPerBet: stakeTotal ? total.expectedSum / stakeTotal : 0,
      actualPerBet: stakeTotal ? total.actualSum / stakeTotal : 0,
      roi: stakeTotal ? total.actualSum / stakeTotal : 0,
      averageStake: total.bets ? stakeTotal / total.bets : 0,
    };
  }).sort((a, b) => a.formula.localeCompare(b.formula));

  const stakeStatsOut = collectStakeStats ? transformStakeStats(stakeStats) : null;
  const stakeStatsByFormulaOut =
    collectStakeStats && stakeStatsByFormula
      ? Object.fromEntries(
          Array.from(stakeStatsByFormula.entries()).map(([formula, stats]) => [
            formula,
            transformStakeStats(stats),
          ]),
        )
      : null;

  return { rows, totals, processed, stakeStats: stakeStatsOut, stakeStatsByFormula: stakeStatsByFormulaOut };
};

const printSummaryTables = (summary) => {
  const { rows, totals } = summary;
  const rowHeadline =
    'formula          | scope     | bets | wins | push | loss | exp/bet   | act/bet   | ROI';
  console.log('\nEV resultat per formula och scope (1u insats):');
  console.log(rowHeadline);
  console.log('-----------------+-----------+------+------+------+-------+-----------+-----------+---------');
  rows.forEach((row) => {
    console.log(
      `${row.formula.padEnd(16)} | ${row.scope.padEnd(9)} | ${String(row.bets).padStart(5)} | ${String(row.wins).padStart(5)} | ${String(row.pushes).padStart(5)} | ${String(row.losses).padStart(5)} | ${formatPct(row.expectedPerBet).padStart(10)} | ${formatPct(row.actualPerBet).padStart(10)} | ${formatPct(row.roi).padStart(8)}`
    );
  });

  console.log('\nTOTAL per formula:');
  console.log('formula          | bets | wins | push | loss | exp/bet   | act/bet   | ROI');
  console.log('-----------------+------+------+------+-------+-----------+-----------+---------');
  totals.forEach((total) => {
    console.log(
      `${total.formula.padEnd(16)} | ${String(total.bets).padStart(5)} | ${String(total.wins).padStart(5)} | ${String(total.pushes).padStart(5)} | ${String(total.losses).padStart(5)} | ${formatPct(total.expectedPerBet).padStart(10)} | ${formatPct(total.actualPerBet).padStart(10)} | ${formatPct(total.roi).padStart(8)}`
    );
  });
};

const runOptimalReport = (bets, args, options = {}) => {
  const {
    unitRules = [],
    stakingEnabled = false,
    allowedScopes = null,
    allowedSelections = null,
  } = options;
  const applyStaking = stakingEnabled;
  const stakeResolver = applyStaking
    ? (bet, { expectedValue, odds }) => {
        const match = matchTelegramUnitRule(odds, expectedValue, unitRules);
        const { unit, ruleLabel } = match;
        if (Number.isFinite(unit) && unit > 0) {
          return { stake: unit, ruleLabel, matchedRule: true, ruleMeta: { ...match, unit } };
        }
        return { stake: 0.5, ruleLabel: 'fallback', matchedRule: false, ruleMeta: null };
      }
    : null;
  const defaultEvSteps = [0, 0.02, 0.05, 0.08, 0.1, 0.15, 0.2];
  const defaultRanges = [
    { min: null, max: null },
    { min: 1.05, max: null },
    { min: 1.05, max: 1.5 },
    { min: 1.05, max: 1.8 },
    { min: 1.1, max: 2.0 },
    { min: 1.2, max: 2.5 },
    { min: 1.3, max: null },
  ];
  const evSteps = parseNumberList(args['optimal-ev-steps']) ?? defaultEvSteps;

  const minOddsArg = toNumber(args['min-odds']);
  const maxOddsArg = toNumber(args['max-odds']);

  const clampRangeToOddsArgs = (range) => {
    const origMin = Number.isFinite(range?.min) ? range.min : null;
    const origMax = Number.isFinite(range?.max) ? range.max : null;
    const min = Number.isFinite(minOddsArg)
      ? origMin === null
        ? minOddsArg
        : Math.max(origMin, minOddsArg)
      : origMin;
    const max = Number.isFinite(maxOddsArg)
      ? origMax === null
        ? maxOddsArg
        : Math.min(origMax, maxOddsArg)
      : origMax;
    if (Number.isFinite(min) && Number.isFinite(max) && min > max) return null;
    return { min, max };
  };

  const oddsRangesRaw = parseRangeList(args['optimal-odds-ranges']) ?? defaultRanges;
  const oddsRanges = [];
  const seenRanges = new Set();
  oddsRangesRaw.forEach((range) => {
    const clamped = clampRangeToOddsArgs(range);
    if (!clamped) return;
    const key = `${clamped.min ?? 'null'}::${clamped.max ?? 'null'}`;
    if (seenRanges.has(key)) return;
    seenRanges.add(key);
    oddsRanges.push({
      ...clamped,
      label: formatRangeLabel(clamped.min, clamped.max),
    });
  });
  const rawMinBets = toNumber(args['optimal-min-bets']);
  const minBets = Number.isFinite(rawMinBets) ? Math.max(1, Math.trunc(rawMinBets)) : 50;
  const normalizedScopeFilter =
    allowedScopes && Array.isArray(allowedScopes) && allowedScopes.length
      ? Array.from(
          new Set(
            allowedScopes
              .map((scope) => normalizeScope(scope))
              .filter((scope) => KNOWN_SCOPES.includes(scope)),
          ),
        )
      : null;

  const normalizedSelectionFilter =
    allowedSelections && Array.isArray(allowedSelections) && allowedSelections.length
      ? Array.from(
          new Set(
            allowedSelections
              .map((selection) => normalizeSelection(selection))
              .filter((selection) => selection !== 'unknown'),
          ),
        )
      : null;

  const scopeCombos =
    normalizedScopeFilter && normalizedScopeFilter.length
      ? [
          {
            scopes: normalizedScopeFilter,
            label:
              normalizedScopeFilter.length === KNOWN_SCOPES.length
                ? 'all'
                : normalizedScopeFilter.join('+'),
          },
        ]
      : buildScopeCombos();

  const selectionCombos =
    normalizedSelectionFilter && normalizedSelectionFilter.length
      ? [
          {
            selections: normalizedSelectionFilter,
            label:
              normalizedSelectionFilter.length === KNOWN_SELECTIONS.length
                ? 'over+under'
                : normalizedSelectionFilter.join('+'),
          },
        ]
      : buildSelectionCombos();

  if (
    (normalizedScopeFilter && normalizedScopeFilter.length) ||
    (normalizedSelectionFilter && normalizedSelectionFilter.length)
  ) {
    const scopeLabel =
      normalizedScopeFilter && normalizedScopeFilter.length
        ? normalizedScopeFilter.join('+')
        : 'all scopes';
    const selectionLabel =
      normalizedSelectionFilter && normalizedSelectionFilter.length
        ? normalizedSelectionFilter.join('+')
        : 'over+under';
    console.log(
      `\nOptimal-läget låser scopes till: ${scopeLabel} och selections till: ${selectionLabel}.`,
    );
  }
  if (Number.isFinite(minOddsArg) || Number.isFinite(maxOddsArg)) {
    console.log(
      `Optimal-läget begränsar oddsintervall till: ${formatRangeLabel(
        Number.isFinite(minOddsArg) ? minOddsArg : null,
        Number.isFinite(maxOddsArg) ? maxOddsArg : null,
      )}.`,
    );
  }

  const bestByFormula = new Map();
  const scenarioRows = [];
  let totalCombosTested = 0;
  if (applyStaking && !unitRules.length) {
    console.warn(
      'Staking-flaggan är satt men inga regler hittades; faller tillbaka till 1u för alla spel.',
    );
  }

  for (const evMin of evSteps) {
    for (const range of oddsRanges) {
      for (const scopeCombo of scopeCombos) {
        for (const selectionCombo of selectionCombos) {
          totalCombosTested += 1;
          const summary = summarizeBets(
            bets,
            {
              evMin,
              minOdds: range.min,
              maxOdds: range.max,
              allowedScopes: new Set(scopeCombo.scopes),
              allowedSelections: new Set(selectionCombo.selections),
            },
            stakeResolver ? { getStake: stakeResolver, collectStakeStats: true } : {},
          );
          if (!summary) continue;
          summary.totals.forEach((total) => {
            if (total.bets < minBets) return;
            const entry = {
              ...total,
              evMin,
              minOdds: range.min,
              maxOdds: range.max,
              oddsLabel: range.label,
              scopeLabel: scopeCombo.label,
              selectionLabel: selectionCombo.label,
              scopes: scopeCombo.scopes,
              selections: selectionCombo.selections,
              stakeStats: stakeResolver ? summary.stakeStatsByFormula?.[total.formula] ?? null : null,
            };
            scenarioRows.push(entry);
            const current = bestByFormula.get(total.formula);
            if (!current || total.roi > current.roi) {
              bestByFormula.set(total.formula, entry);
            }
          });
        }
      }
    }
  }

  if (!scenarioRows.length) {
    console.log(`Totalt testade kombinationer: ${totalCombosTested}`);
    console.log('Hittade inga kombinationer som uppfyllde kraven för --optimal.');
    return;
  }

  if (applyStaking) {
    console.log(
      '\nStaking aktiverad: viktar EV/ROI per unit med regler från config/telegramUnitRules.json.',
    );
  }

  const valueLabel = applyStaking ? 'unit' : 'bet';
  const headline =
    `formula          | bets | exp/${valueLabel}   | act/${valueLabel}   | ROI      | EV>= | odds range | scopes        | selections`;
  console.log(
    `\nBästa kombination per formula (minst ${minBets} spel per formel, scope- och selection-kombination):`
  );
  console.log(headline);
  console.log(
    '-----------------+------+-----------+-----------+----------+------+------------+------------------+------------'
  );
  Array.from(bestByFormula.values())
    .sort((a, b) => a.roi - b.roi)
    .forEach((entry) => {
      console.log(
        `${entry.formula.padEnd(16)} | ${String(entry.bets).padStart(4)} | ${formatPct(
          entry.expectedPerBet,
        ).padStart(10)} | ${formatPct(entry.actualPerBet).padStart(10)} | ${formatPct(
          entry.roi,
        ).padStart(8)} | ${entry.evMin.toFixed(2).padStart(4)} | ${entry.oddsLabel.padEnd(
          10,
        )} | ${entry.scopeLabel.padEnd(16)} | ${entry.selectionLabel.padEnd(10)}`,
      );
    });
  console.log(`Totalt testade kombinationer: ${totalCombosTested}`);

  if (applyStaking) {
    console.log('\nStake-fördelning för respektive bästa kombination:');
    Array.from(bestByFormula.values())
      .sort((a, b) => a.formula.localeCompare(b.formula))
      .forEach((entry) => {
        const stats = entry.stakeStats;
        if (!stats) {
          console.log(`- ${entry.formula}: inga stake-stats (föll tillbaka till 1u)`);
          return;
        }
        console.log(
          `- ${entry.formula}: ${stats.totalBets} bets, total stake ${stats.totalStake.toFixed(
            2,
          )}u, snitt ${stats.averageStake.toFixed(2)}u, utfall ${formatUnitSigned(
            stats.totalActual,
          )}`,
        );
        const formatOddsRange = (min, max) => {
          if (Number.isFinite(min) && Number.isFinite(max)) return `${min}-${max}`;
          if (Number.isFinite(min) && !Number.isFinite(max)) return `${min}+`;
          if (!Number.isFinite(min) && Number.isFinite(max)) return `<=${max}`;
          return 'okänt odds-intervall';
        };

        const bucketsOrdered = stats.buckets;
        const matchedBuckets = bucketsOrdered.filter((b) => b.matchedRule !== false);
        const fallbackBuckets = bucketsOrdered.filter((b) => b.matchedRule === false);

        const printBucket = (bucket, isFallback = false) => {
          const pctLabel = Number.isFinite(bucket.pctOfTotalActual)
            ? `${formatPct(bucket.pctOfTotalActual)} av totalen`
            : 'n/a';
          const oddsLabel = formatOddsRange(bucket.minOdds, bucket.maxOdds);
          const unitLabel = Number.isFinite(bucket.unit)
            ? `${bucket.unit.toFixed(2).replace(/\.?0+$/, '')}u`
            : 'okänd unit';
          const prefix = isFallback ? '    • finns ej med i regler:' : '    •';
          console.log(
            `${prefix} odds ${oddsLabel} | unit ${unitLabel} | ${bucket.bets} bets | stake ${bucket.stakeSum.toFixed(
              2,
            )}u | utfall ${formatUnitSigned(bucket.actualSum)} (${pctLabel})`,
          );
        };

        matchedBuckets.forEach((bucket) => printBucket(bucket, false));
        if (fallbackBuckets.length) {
          fallbackBuckets.forEach((bucket) => printBucket(bucket, true));
        }
      });
  }
};

const main = async () => {
  const args = parseArgs();
  const stakingArg = args['optimal-staking'];
  const stakingEnabled =
    stakingArg !== undefined &&
    String(stakingArg).toLowerCase() !== 'false' &&
    String(stakingArg).toLowerCase() !== '0';
  const unitRules = stakingEnabled ? await loadTelegramUnitRules() : [];
  const db = await getDb();
  try {
    const col = db.collection('ev-bets');
    const query = { settled: true };

    const formulas = toArray(args.formula);
    if (formulas?.length) query.formula = { $in: formulas };

    const scopes = toArray(args.scope);
    if (scopes?.length) query.scope = { $in: scopes };

    const selections = toArray(args.selection);
    if (selections?.length) query.selection = { $in: selections };

    const kickoffFilter = {};
    const fromDate = toDate(args.from);
    const dateAfter = toDate(args.date);
    const toDateValue = toDate(args.to);

    // Combine --date (inclusive lower bound) with --from by taking the later date if both are set.
    const lowerBounds = [fromDate, dateAfter].filter(Boolean);
    if (lowerBounds.length) {
      const latestLowerBound = new Date(Math.max(...lowerBounds.map((d) => d.getTime())));
      kickoffFilter.$gte = latestLowerBound.toISOString();
    }
    if (toDateValue) kickoffFilter.$lte = toDateValue.toISOString();
    if (Object.keys(kickoffFilter).length) {
      query.kickoff = kickoffFilter;
    }

    const snapshotFilter = {};
    const fromSnapshot = toDate(args['snapshot-from']);
    const toSnapshot = toDate(args['snapshot-to']);
    if (fromSnapshot) snapshotFilter.$gte = fromSnapshot.toISOString();
    if (toSnapshot) snapshotFilter.$lte = toSnapshot.toISOString();
    if (Object.keys(snapshotFilter).length) {
      query.snapshotTimeUtc = snapshotFilter;
    }

    const bets = await col.find(query).toArray();
    if (!bets.length) {
      console.log('Inga settled EV-bets matchade filtret.');
      return;
    }

    if (args.optimal) {
      runOptimalReport(bets, args, {
        unitRules,
        stakingEnabled,
        allowedScopes: scopes || null,
        allowedSelections: selections || null,
      });
      return;
    }

    const summary = summarizeBets(bets, {
      evMin: toNumber(args['min-ev']) ?? 0,
      evMax: toNumber(args['max-ev']),
      minOdds: toNumber(args['min-odds']),
      maxOdds: toNumber(args['max-odds']),
    });

    if (!summary) {
      console.log('Inga bets kvar efter filtrering.');
      return;
    }

    printSummaryTables(summary);
  } finally {
    await closeDb();
  }
};

main().catch((err) => {
  console.error('Fel i evFormulaSummary:', err);
  process.exitCode = 1;
});
