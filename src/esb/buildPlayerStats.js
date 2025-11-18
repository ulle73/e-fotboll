import path from 'path';
import { fileURLToPath } from 'url';
import { nowIso, pathRelativeToRoot, readJson, writeJson } from './utils.js';
import * as logger from '../utils/logger.js';
import { getDb, closeDb } from '../db/mongoClient.js';

// ---------------------------------
// INFO url: (ingen extern URL; läser lokalt från data/esb/normalized_matches.json)
// ---------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;


const OUTPUT_PATH = pathRelativeToRoot('data', 'esb', 'player_stats.json');

const normalizeModeKey = (modeRaw) => {
  const val = (modeRaw ?? 'unknown').toString().toLowerCase();
  if (val.includes('2x4')) return '2x4';
  if (val.includes('2x6')) return '2x6';
  return val || 'unknown';
};

const toNumberSafe = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const toTimestamp = (value) => {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

const summarize = (rows) => {
  const totalMatches = rows.length;
  const goalsFor = rows.reduce((sum, r) => sum + r.goalsFor, 0);
  const goalsAgainst = rows.reduce((sum, r) => sum + r.goalsAgainst, 0);
  const avgGoalsFor = totalMatches ? goalsFor / totalMatches : 0;
  const avgGoalsAgainst = totalMatches ? goalsAgainst / totalMatches : 0;
  const avgTotalGoals = totalMatches ? (goalsFor + goalsAgainst) / totalMatches : 0;
  return { totalMatches, goalsFor, goalsAgainst, avgGoalsFor, avgGoalsAgainst, avgTotalGoals };
};

const summarizeWindow = (rows, limit) => summarize(rows.slice(0, limit));

const weightedAverage = (weights, slices) => {
  const metrics = ['avgGoalsFor', 'avgGoalsAgainst', 'avgTotalGoals'];
  const entries = Object.entries(weights).filter(([key, weight]) => weight && slices[key]);
  const totalWeight = entries.reduce((sum, [, weight]) => sum + weight, 0);
  const result = Object.fromEntries(metrics.map((metric) => [metric, 0]));
  if (!totalWeight) return result;

  entries.forEach(([key, weight]) => {
    const slice = slices[key] || {};
    metrics.forEach((metric) => {
      result[metric] += weight * (slice[metric] ?? 0);
    });
  });

  metrics.forEach((metric) => {
    result[metric] = result[metric] / totalWeight;
  });

  return result;
};

const buildStats = (normalized) => {
  // Filtrera bort matcher som inte har resultat (dvs. planerade matcher)
  const completedMatches = normalized.filter(
    (match) => match.goalsHome !== null && match.goalsAway !== null,
  );

  const map = new Map();

  const pushMatch = (playerNick, modeRaw, goalsFor, goalsAgainst, kickoff) => {
    const mode = normalizeModeKey(modeRaw);
    const key = `${playerNick}:::${mode}`;
    const entry = map.get(key) || [];
    entry.push({ playerNick, mode, goalsFor, goalsAgainst, kickoff });
    map.set(key, entry);
  };

  completedMatches.forEach((match) => {
    const { homePlayerNick, awayPlayerNick, goalsHome, goalsAway, mode, kickoff, date } = match;
    const ts = toTimestamp(kickoff || date);
    pushMatch(homePlayerNick, mode, toNumberSafe(goalsHome), toNumberSafe(goalsAway), ts);
    pushMatch(awayPlayerNick, mode, toNumberSafe(goalsAway), toNumberSafe(goalsHome), ts);
  });

  const stats = [];
  for (const [key, rows] of map.entries()) {
    if (!rows.length) continue;
    const sorted = rows.sort((a, b) => b.kickoff - a.kickoff);
    const base = summarize(sorted);
    const slices = {
      last8: summarizeWindow(sorted, 8),
      last20: summarizeWindow(sorted, 20),
      last50: summarizeWindow(sorted, 50),
      last100: summarizeWindow(sorted, 100),
    };

    const weighted30_70 = weightedAverage({ last20: 0.3, last50: 0.7 }, slices);
    const weighted50_30_20 = weightedAverage({ last8: 0.5, last20: 0.3, last50: 0.2 }, slices);
    const weighted33s = weightedAverage({ last20: 1 / 3, last50: 1 / 3, last100: 1 / 3 }, slices);

    const [playerNick, mode] = key.split(':::');
    stats.push({
      playerNick,
      mode,
      ...base,
      last8: slices.last8,
      last20: slices.last20,
      last50: slices.last50,
      last100: slices.last100,
      weighted: {
        raz_optimal: weighted30_70,
        form_agressive: weighted50_30_20,
        equal_weighted: weighted33s,
      },
      updatedAtIso: nowIso(),
    });
  }

  return stats;
};

export const main = async () => {
  const db = await getDb();
  const matches = await db.collection('esb_matches').find({ source: 'esportsbattle' }).toArray();
  if (!matches.length) {
    throw new Error(`Inga matcher hittades i DB (esb_matches). Kör normalizeMatches först.`);
  }

  const stats = buildStats(matches);
  logger.step(`Beräknade stats för ${stats.length} player/mode-kombinationer`);

  await writeJson(OUTPUT_PATH, stats);

 
  try {
    const col = db.collection('player_stats');
    await col.deleteMany({ source: 'esportsbattle' });
    const docs = stats.map((s) => ({ ...s, source: 'esportsbattle' }));
    if (docs.length) {
      await col.insertMany(docs, { ordered: false });
      logger.success(`Sparade ${docs.length} player_stats i DB`);
    } else {
      logger.info('Inga player_stats att spara i DB');
    }
  } finally {
    await closeDb();
  }

  logger.success(`Sparade player_stats till ${OUTPUT_PATH}`);
};

if (isMain) {
  main().catch((err) => {
    logger.error('Fel i buildPlayerStats', err);
    process.exitCode = 1;
  });
}
