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
  const selectionFilter = selectionValues?.length ? { selection: { $in: selectionValues } } : {};
  const scopeFilter = scopeValues?.length ? { scope: { $in: scopeValues } } : {};
  const formulaFilter = formulaValues?.length ? { formula: { $in: formulaValues } } : {};
  const baseFilter = { ...selectionFilter, ...scopeFilter, ...formulaFilter };
  const ranges = buildRanges(start, end, step);

  const db = await getDb();
  try {
    const col = db.collection('ev-bets');
  const evFilter = { ...(Number.isFinite(minEv) ? { $gte: minEv } : {}), ...(Number.isFinite(maxEv) ? { $lte: maxEv } : {}) };
  const baseQuery = {
    ...baseFilter,
    ...(Object.keys(evFilter).length ? { ev: evFilter } : { ev: { $gt: 0 } }),
  };
    const oldestBet = await col.find(baseQuery).sort({ kickoff: 1 }).limit(1).next();
    const newestBet = await col.find(baseQuery).sort({ kickoff: -1 }).limit(1).next();

    const stats = [];
    for (const range of ranges) {
      const query = {
        ...baseQuery,
        offeredOdds: { $gte: range.min, ...(Number.isFinite(range.max) ? { $lt: range.max } : {}) },
      };
      const count = await col.countDocuments(query);
      stats.push({ ...range, count });
    }

  console.log(`\n🎯 Oddsstatistik (${start}-${end} med steg ${step}):`);
  console.log(
    `Filter: ${
      scopeValues?.length ? `scope=${scopeValues.join(',')}` : 'scope=alla'
    }, ${selectionValues?.length ? `selection=${selectionValues.join(',')}` : 'selection=alla'}, ${
      formulaValues?.length ? `formula=${formulaValues.join(',')}` : 'formula=alla'
    }, EV ${
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
      console.log(`• ${formatRangeLabel(row.min, row.max).padEnd(12)} : ${row.count.toString().padStart(6)} spel`);
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
