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

    const evMin = toNumber(args['min-ev']) ?? 0;
    const evMax = toNumber(args['max-ev']);
    const minOdds = toNumber(args['min-odds']);
    const maxOdds = toNumber(args['max-odds']);

    const aggregate = new Map();
    const totalsByFormula = new Map();

    for (const bet of bets) {
      const expectedValue = computeExpectedEv(bet);
      if (!Number.isFinite(expectedValue)) {
        continue;
      }
      if (expectedValue < evMin) {
        continue;
      }
      if (Number.isFinite(evMax) && expectedValue > evMax) {
        continue;
      }
      const odds = toNumber(bet.offeredOdds);
      if (Number.isFinite(minOdds) && (!Number.isFinite(odds) || odds < minOdds)) {
        continue;
      }
      if (Number.isFinite(maxOdds) && (!Number.isFinite(odds) || odds > maxOdds)) {
        continue;
      }
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
          missingExpected: 0,
          missingActual: 0,
        });
      }
      const bucket = aggregate.get(key);
      bucket.bets += 1;
      if (bet.result === 'win') bucket.wins += 1;
      else if (bet.result === 'push') bucket.pushes += 1;
      else bucket.losses += 1;

      const expected = expectedValue;
      bucket.expectedSum += expected;
      const actual = computeActualReturn(bet);
      if (actual === null) bucket.missingActual += 1;
      else bucket.actualSum += actual;

      if (!totalsByFormula.has(formula)) {
        totalsByFormula.set(formula, {
          formula,
          bets: 0,
          expectedSum: 0,
          actualSum: 0,
          wins: 0,
          pushes: 0,
          losses: 0,
        });
      }
      const total = totalsByFormula.get(formula);
      total.bets += 1;
      if (expected !== null) total.expectedSum += expected;
      if (actual !== null) total.actualSum += actual;
      if (bet.result === 'win') total.wins += 1;
      else if (bet.result === 'push') total.pushes += 1;
      else total.losses += 1;
    }

    const rows = Array.from(aggregate.values()).map((row) => {
      const expectedPerBet =
        row.bets && row.expectedSum !== 0 ? row.expectedSum / row.bets : 0;
      const actualPerBet =
        row.bets && row.actualSum !== 0 ? row.actualSum / row.bets : 0;
      const roi =
        row.bets && row.actualSum !== 0
          ? row.actualSum / row.bets
          : 0;
      return {
        ...row,
        expectedPerBet,
        actualPerBet,
        roi,
      };
    });

    rows.sort((a, b) => {
      if (a.expectedPerBet === b.expectedPerBet) {
        if (a.formula === b.formula) return a.scope.localeCompare(b.scope);
        return a.formula.localeCompare(b.formula);
      }
      return a.expectedPerBet - b.expectedPerBet;
    });

    const asRowString = (row) => {
      const expectedPct = formatPct(row.expectedPerBet);
      const actualPct = formatPct(row.actualPerBet);
      const roiPct = formatPct(row.roi);
      return `${row.formula.padEnd(16)} | ${row.scope.padEnd(9)} | ${String(
        row.bets,
      ).padStart(5)} | ${String(row.wins).padStart(5)} | ${String(
        row.pushes,
      ).padStart(5)} | ${String(row.losses).padStart(5)} | ${expectedPct.padStart(
        10,
      )} | ${actualPct.padStart(10)} | ${roiPct.padStart(8)}`;
    };

    console.log('\nEV resultat per formula och scope (1u insats):');
    console.log(
      'formula          | scope     | bets | wins | push | loss | exp/bet   | act/bet   | ROI',
    );
    console.log(
      '-----------------+-----------+------+------+------+-------+-----------+-----------+---------',
    );
    rows.forEach((row) => console.log(asRowString(row)));

    console.log('\nTOTAL per formula:');
    console.log('formula          | bets | wins | push | loss | exp/bet   | act/bet   | ROI');
    console.log(
      '-----------------+------+------+------+-------+-----------+-----------+---------',
    );
    Array.from(totalsByFormula.values())
      .sort((a, b) => a.formula.localeCompare(b.formula))
      .forEach((total) => {
        const expectedPerBet =
          total.bets && total.expectedSum !== 0
            ? total.expectedSum / total.bets
            : 0;
        const actualPerBet =
          total.bets && total.actualSum !== 0
            ? total.actualSum / total.bets
            : 0;
        const roi =
          total.bets && total.actualSum !== 0
            ? formatPct(total.actualSum / total.bets)
            : '0.00%';
        console.log(
          `${total.formula.padEnd(16)} | ${String(total.bets).padStart(5)} | ${String(
            total.wins,
          ).padStart(5)} | ${String(total.pushes).padStart(5)} | ${String(
            total.losses,
          ).padStart(5)} | ${formatPct(expectedPerBet).padStart(10)} | ${formatPct(
            actualPerBet,
          ).padStart(10)} | ${roi.padStart(8)}`,
        );
      });
  } finally {
    await closeDb();
  }
};

main().catch((err) => {
  console.error('Fel i evFormulaSummary:', err);
  process.exitCode = 1;
});
