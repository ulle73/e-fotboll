import fs from 'fs/promises';
import { getDb, closeDb } from '../db/mongoClient.js';

const parseArgs = () => {
  const args = {};
  process.argv.slice(2).forEach((raw) => {
    if (!raw.startsWith('--')) return;
    const [key, ...rest] = raw.slice(2).split('=');
    args[key] = rest.length ? rest.join('=') : true;
  });
  return args;
};

const parseFloatSafe = (value, fallback) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const parseList = (value) => {
  if (!value) return null;
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
};

const buildRanges = (start = 1, end = 5, step = 0.2) => {
  const ranges = [];
  let lower = start;
  while (lower < end) {
    const upper = Math.min(lower + step, end);
    ranges.push({ min: lower, max: upper });
    lower = upper;
  }
  ranges.push({ min: end, max: Infinity });
  return ranges;
};

const formatRangeLabel = (min, max) => {
  const lower = min.toFixed(2).replace(/\.?0+$/, '');
  if (!Number.isFinite(max) || max === Infinity) return `${lower}+`;
  const upper = max.toFixed(2).replace(/\.?0+$/, '');
  return `${lower}-${upper}`;
};

const formatPct = (value) => `${(value * 100).toFixed(2)}%`;

const loadUnitRules = async () => {
  try {
    const jsonPath = new URL('../../config/telegramUnitRules.json', import.meta.url);
    const raw = await fs.readFile(jsonPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`Kunde inte läsa telegramUnitRules.json: ${err.message}`);
    return [];
  }
};

const intersectRange = (aMin = Number.NEGATIVE_INFINITY, aMax = Number.POSITIVE_INFINITY, bMin = Number.NEGATIVE_INFINITY, bMax = Number.POSITIVE_INFINITY) => {
  const lower = Math.max(aMin, bMin);
  const upper = Math.min(aMax, bMax);
  if (lower >= upper) return null;
  const bounds = {};
  if (Number.isFinite(lower) && lower !== Number.NEGATIVE_INFINITY) bounds.$gte = lower;
  if (Number.isFinite(upper) && upper !== Number.POSITIVE_INFINITY) bounds.$lt = upper;
  return bounds;
};

const main = async () => {
  const args = parseArgs();
  const start = parseFloatSafe(args.min, 1);
  const end = parseFloatSafe(args.max, 5);
  const step = parseFloatSafe(args.step, 0.2);
  const minEv = parseFloatSafe(args['min-ev'], null);
  const maxEv = parseFloatSafe(args['max-ev'], null);
  const selectionValues = parseList(args.selection);
  const scopeValues = parseList(args.scope)?.map((s) => s.toLowerCase());
  const formulaValues = parseList(args.formula);
  const unitExact = parseFloatSafe(args.unit, null);
  const unitRange =
    typeof args['unit-range'] === 'string'
      ? args['unit-range'].split('-').map((v) => parseFloatSafe(v, null))
      : null;

  const selectionFilter = selectionValues?.length ? { selection: { $in: selectionValues } } : {};
  const scopeFilter = scopeValues?.length ? { scope: { $in: scopeValues } } : {};
  const formulaFilter = formulaValues?.length ? { formula: { $in: formulaValues } } : {};
  const baseFilter = { ...selectionFilter, ...scopeFilter, ...formulaFilter };
  const ranges = buildRanges(start, end, step);
  let unitRules = [];
  if (unitExact !== null || (unitRange && unitRange.length === 2)) {
    const rules = await loadUnitRules();
    unitRules = rules.filter((rule) => {
      const unit = Number(rule.unit);
      if (!Number.isFinite(unit)) return false;
      if (unitExact !== null && unit !== unitExact) return false;
      if (unitRange && unitRange.length === 2) {
        const [uMin, uMax] = unitRange;
        if (Number.isFinite(uMin) && unit < uMin) return false;
        if (Number.isFinite(uMax) && unit > uMax) return false;
      }
      return true;
    });
    if (!unitRules.length) {
      console.log('Inga unit-regler matchade kriteriet, ingen data att visa.');
      return;
    }
  }

  const db = await getDb();
  try {
    const col = db.collection('ev-bets');
    const baseEvCondition = {
      ...(Number.isFinite(minEv) ? { $gte: minEv } : { $gt: 0 }),
      ...(Number.isFinite(maxEv) ? { $lte: maxEv } : {}),
    };
    const baseQuery = { ...baseFilter };
    const oldestBet = await col
      .find({ ...baseQuery, ev: baseEvCondition })
      .sort({ kickoff: 1 })
      .limit(1)
      .next();
    const newestBet = await col
      .find({ ...baseQuery, ev: baseEvCondition })
      .sort({ kickoff: -1 })
      .limit(1)
      .next();

    const stats = [];
    for (const range of ranges) {
      let query;
      if (unitRules.length) {
        const orClauses = [];
        unitRules.forEach((rule) => {
          const oddsClause = intersectRange(
            range.min,
            Number.isFinite(range.max) ? range.max : Number.POSITIVE_INFINITY,
            rule.minOdds,
            rule.maxOdds,
          );
          if (!oddsClause) return;

          const evClause = intersectRange(
            baseEvCondition.$gte ?? baseEvCondition.$gt ?? Number.NEGATIVE_INFINITY,
            baseEvCondition.$lte ?? Number.POSITIVE_INFINITY,
            rule.minEv,
            rule.maxEv,
          );
          if (!evClause) return;
          orClauses.push({
            ev: evClause,
            offeredOdds: oddsClause,
          });
        });
        if (!orClauses.length) continue;
        query = { ...baseQuery, $or: orClauses };
      } else {
        query = {
          ...baseQuery,
          ev: baseEvCondition,
          offeredOdds: {
            $gte: range.min,
            ...(Number.isFinite(range.max) ? { $lt: range.max } : {}),
          },
        };
      }

      const count = await col.countDocuments(query);
      stats.push({ ...range, count });
    }

  console.log(`\n🎯 Oddsstatistik (${start}-${end} med steg ${step}):`);
  console.log(
    `Filter: ${
      scopeValues?.length ? `scope=${scopeValues.join(',')}` : 'scope=alla'
    }, ${selectionValues?.length ? `selection=${selectionValues.join(',')}` : 'selection=alla'}, ${
      formulaValues?.length ? `formula=${formulaValues.join(',')}` : 'formula=alla'
    }, unit ${unitExact !== null ? unitExact : unitRange && unitRange.length === 2 ? `${unitRange[0]}-${unitRange[1]}` : 'alla'}, EV ${
      Number.isFinite(minEv) ? `≥ ${formatPct(minEv).replace('%', '')}%` : '> 0%'
    }${Number.isFinite(maxEv) ? ` och ≤ ${formatPct(maxEv).replace('%', '')}%` : ''}`
  );
  if (oldestBet || newestBet) {
    const oldest = oldestBet?.kickoff ?? oldestBet?.snapshotTime ?? 'okänd';
    const newest = newestBet?.kickoff ?? newestBet?.snapshotTime ?? 'okänd';
    console.log(`Data från ${oldest} till ${newest}`);
  }

    let totalCount = 0;
    stats.forEach((row) => {
      totalCount += row.count;
    });
    stats.forEach((row) => {
      const percentage = totalCount > 0 ? ((row.count / totalCount) * 100).toFixed(2) : '0.00';
      console.log(
        `• ${formatRangeLabel(row.min, row.max).padEnd(12)} : ${row.count
          .toString()
          .padStart(6)} spel (${percentage}%)`,
      );
    });
    console.log('------------------------------------');
    console.log(`Totalt antal spel: ${totalCount}`);
    console.log();
  } finally {
    await closeDb();
  }
};

main().catch((err) => {
  console.error('Fel i listOddsRanges:', err);
  process.exitCode = 1;
});
