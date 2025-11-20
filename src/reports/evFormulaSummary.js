// src/reports/evFormulaSummary.js
import { getDb, closeDb } from '../db/mongoClient.js';

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

const summarizeBets = (bets, filters = {}) => {
  const {
    evMin = 0,
    evMax = null,
    minOdds = null,
    maxOdds = null,
  } = filters;

  const aggregate = new Map();
  const totalsByFormula = new Map();
  let processed = 0;

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

    processed += 1;
    const formula = bet.formula || 'unknown';
    const scope = bet.scope || 'total';
    const key = `${formula}:::${scope}`;

    if (!aggregate.has(key)) {
      aggregate.set(key, {
        formula,
        scope,
        bets: 0,
        wins: 0,
        pushes: 0,
        losses: 0,
        expectedSum: 0,
        actualSum: 0,
      });
    }
    const bucket = aggregate.get(key);
    bucket.bets += 1;
    const result = (bet.result || '').toLowerCase();
    if (result === 'win') bucket.wins += 1;
    else if (result === 'push') bucket.pushes += 1;
    else bucket.losses += 1;
    bucket.expectedSum += expectedValue;
    const actual = computeActualReturn(bet);
    if (Number.isFinite(actual)) {
      bucket.actualSum += actual;
    }

    if (!totalsByFormula.has(formula)) {
      totalsByFormula.set(formula, {
        formula,
        bets: 0,
        wins: 0,
        pushes: 0,
        losses: 0,
        expectedSum: 0,
        actualSum: 0,
      });
    }
    const total = totalsByFormula.get(formula);
    total.bets += 1;
    if (result === 'win') total.wins += 1;
    else if (result === 'push') total.pushes += 1;
    else total.losses += 1;
    total.expectedSum += expectedValue;
    if (Number.isFinite(actual)) {
      total.actualSum += actual;
    }
  }

  if (!processed) return null;

  const rows = Array.from(aggregate.values()).map((row) => ({
    ...row,
    expectedPerBet: row.bets ? row.expectedSum / row.bets : 0,
    actualPerBet: row.bets ? row.actualSum / row.bets : 0,
    roi: row.bets ? row.actualSum / row.bets : 0,
  }));

  rows.sort((a, b) => {
    if (a.expectedPerBet === b.expectedPerBet) {
      if (a.formula === b.formula) return a.scope.localeCompare(b.scope);
      return a.formula.localeCompare(b.formula);
    }
    return a.expectedPerBet - b.expectedPerBet;
  });

  const totals = Array.from(totalsByFormula.values()).map((total) => ({
    ...total,
    expectedPerBet: total.bets ? total.expectedSum / total.bets : 0,
    actualPerBet: total.bets ? total.actualSum / total.bets : 0,
    roi: total.bets ? total.actualSum / total.bets : 0,
  })).sort((a, b) => a.formula.localeCompare(b.formula));

  return { rows, totals, processed };
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

const runOptimalReport = (bets, args) => {
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
  const oddsRanges = (parseRangeList(args['optimal-odds-ranges']) ?? defaultRanges).map(
    (range) => ({
      ...range,
      label: formatRangeLabel(range.min, range.max),
    }),
  );
  const minBets = Number(args['optimal-min-bets']) ?? 50;

  const bestByFormula = new Map();
  const scenarioRows = [];

  for (const evMin of evSteps) {
    for (const range of oddsRanges) {
      const summary = summarizeBets(bets, {
        evMin,
        minOdds: range.min,
        maxOdds: range.max,
      });
      if (!summary) continue;
      summary.totals.forEach((total) => {
        if (total.bets < minBets) return;
        const entry = {
          ...total,
          evMin,
          minOdds: range.min,
          maxOdds: range.max,
          oddsLabel: range.label,
        };
        scenarioRows.push(entry);
        const current = bestByFormula.get(total.formula);
        if (!current || total.roi > current.roi) {
          bestByFormula.set(total.formula, entry);
        }
      });
    }
  }

  if (!scenarioRows.length) {
    console.log('Hittade inga kombinationer som uppfyllde kraven för --optimal.');
    return;
  }

  const headline =
    'formula          | bets | exp/bet   | act/bet   | ROI      | EV>= | odds range';
  console.log(`\nBästa kombination per formula (minst ${minBets} spel per formel):`);
  console.log(headline);
  console.log('-----------------+------+-----------+-----------+----------+------+------------');
  Array.from(bestByFormula.values())
    .sort((a, b) => a.roi - b.roi)
    .forEach((entry) => {
      console.log(
        `${entry.formula.padEnd(16)} | ${String(entry.bets).padStart(4)} | ${formatPct(
          entry.expectedPerBet,
        ).padStart(10)} | ${formatPct(entry.actualPerBet).padStart(10)} | ${formatPct(
          entry.roi,
        ).padStart(8)} | ${entry.evMin.toFixed(2).padStart(4)} | ${entry.oddsLabel.padEnd(10)}`,
      );
    });
};

const main = async () => {
  const args = parseArgs();
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
    const toDateValue = toDate(args.to);
    if (fromDate) kickoffFilter.$gte = fromDate.toISOString();
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
      runOptimalReport(bets, args);
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
