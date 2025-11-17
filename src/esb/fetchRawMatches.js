import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ensureDir,
  nowIso,
  pathRelativeToRoot,
  readJson,
  replacePlaceholders,
  slugify,
  writeJson,
  runWithConcurrency,
} from './utils.js';
import * as logger from '../utils/logger.js';
import { fetchJsonWithPuppeteer, shutdownPuppeteer } from './puppeteerFetch.js';
import { getDb, closeDb } from '../db/mongoClient.js';

// ---------------------------------
// INFO url: https://football.esportsbattle.com/api/participants/{participantId}/tournaments?page={page}
// INFO url: https://football.esportsbattle.com/api/tournaments/{tournamentId}/matches
// INFO url: https://football.esportsbattle.com/api/tournaments/{tournamentId}/results
// ---------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;

const URLS_PATH = pathRelativeToRoot('config', 'urls.json');

const RAW_ROOT = pathRelativeToRoot('data', 'esb', 'raw_matches');
const LAST_RUN_PATH = path.join(RAW_ROOT, '.last_run.json');
const MAX_PAGES = 200;
const RECENT_TOURNAMENT_PAGES = 5; // Begränsa till senaste X sidor per spelare för att snabba upp hämtningen.
const MAX_MATCHES_PER_PLAYER = 200; // Högst N matcher per spelare per körning.
const DEFAULT_SINCE_HOURS = 48;

const fetchJson = async (url, timeoutMs = 20000) => fetchJsonWithPuppeteer(url, timeoutMs);

const getMatchId = (match) =>
  match?.id ?? match?.matchId ?? match?.match_id ?? match?._id ?? match?.eventId ?? null;

const getMatchDate = (match) =>
  match?.kickoff ??
  match?.date ??
  match?.startTime ??
  match?.startDate ??
  match?.start_date ??
  match?.matchTime ??
  null;

const toTs = (value) => {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

const parseSinceTs = async () => {
  const argDate = process.argv.find((a) => a.startsWith('--date='));
  const argHours = process.argv.find((a) => a.startsWith('--sinceHours='));

  if (argDate) {
    const iso = argDate.split('=').slice(1).join('=');
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return parsed;
    logger.info(`Kunde inte tolka --date=${iso}, fortsätter med last-run/default.`);
  }

  if (argHours) {
    const hours = Number.parseFloat(argHours.split('=').pop());
    if (Number.isFinite(hours) && hours > 0) return Date.now() - hours * 60 * 60 * 1000;
    logger.info('Kunde inte tolka --sinceHours, fortsätter med last-run/default.');
  }

  try {
    const lastRun = await readJson(LAST_RUN_PATH, null);
    const ts = Date.parse(lastRun?.lastRunIso);
    if (Number.isFinite(ts)) return ts;
  } catch (err) {
    // Ignorera last-run-fel och gå vidare till default.
  }

  return Date.now() - DEFAULT_SINCE_HOURS * 60 * 60 * 1000;
};

const saveLastRun = async (runIso) => {
  try {
    await writeJson(LAST_RUN_PATH, { lastRunIso: runIso });
  } catch (err) {
    logger.info(`Kunde inte spara last-run: ${err.message}`);
  }
};

const extractArray = (payload, primaryKey) => {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (primaryKey && Array.isArray(payload[primaryKey])) return payload[primaryKey];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
};

const fetchParticipantTournaments = async (player, urls) => {
  const template = urls.api?.participantsTournaments;
  if (!template) throw new Error('participantsTournaments saknas i urls.json');

  const participantKey = player?.slug || player?.nickname || player?.id;
  if (!participantKey) throw new Error('Player saknar slug/nickname/id för tournaments-URL');

  const tournaments = [];
  const maxPages = Math.min(MAX_PAGES, RECENT_TOURNAMENT_PAGES);
  for (let page = 1; page <= maxPages; page += 1) {
    const url = replacePlaceholders(template, { participantId: participantKey, page });
    logger.info(`Hämtar tournaments för spelare ${participantKey}, sida ${page}: ${url}`);
    const payload = await fetchJson(url);
    const pageItems = extractArray(payload, 'tournaments');
    if (!pageItems.length) {
      logger.info(`Inga fler tournament-sidor för spelare ${participantKey}, stannar.`);
      break;
    }
    tournaments.push(...pageItems);
  }
  return tournaments;
};

const pickMatches = (payload) => {
  const candidates = [
    extractArray(payload, 'matches'),
    extractArray(payload?.data, 'matches'),
    extractArray(payload?.result, 'matches'),
    extractArray(payload?.result),
    extractArray(payload?.data),
  ];
  return candidates.find((arr) => arr.length) || [];
};

const fetchTournamentMatches = async (tournamentId, urls) => {
  const matchTemplate = urls.api?.tournamentMatches;
  const resultsTemplate = urls.api?.tournamentResults;
  const template = matchTemplate || resultsTemplate;

  if (!template) throw new Error('tournamentMatches eller tournamentResults saknas i urls.json');

  const url = replacePlaceholders(template, { tournamentId });
  logger.info(`Hämtar matcher för tournament ${tournamentId}: ${url}`);
  const payload = await fetchJson(url);
  const matches = pickMatches(payload);
  return { url, payload, matches };
};

const safePlayerDir = (player) => slugify(player?.nickname) || `player-${player?.id ?? 'unknown'}`;

const uniqueFilePath = async (dir, baseName) => {
  let name = `${baseName}.json`;
  let filePath = path.join(dir, name);
  let counter = 1;
  while (true) {
    try {
      await fs.access(filePath);
      name = `${baseName}-${counter}.json`;
      filePath = path.join(dir, name);
      counter += 1;
    } catch (err) {
      if (err.code === 'ENOENT') return filePath;
      throw err;
    }
  }
};

const tournamentSlug = (tournament, idx) => {
  const base =
    tournament?.slug ??
    tournament?.name ??
    tournament?.title ??
    tournament?.tournament ??
    tournament?.id ??
    tournament?.tournamentId ??
    `tournament-${idx + 1}`;
  return slugify(base);
};

const loadKnownMatchIds = async (player, db) => {
  const known = new Set();
  try {
    const rawMatches = await db.collection('esb_raw_matches').find(
      { 'player.id': player.id, source: 'esportsbattle' },
      { projection: { 'matches.id': 1, 'matches.matchId': 1, 'matches.match_id': 1, 'matches._id': 1, 'matches.eventId': 1 } }
    ).toArray();

    rawMatches.forEach(doc => {
      const matches = Array.isArray(doc?.matches) ? doc.matches : [];
      matches.forEach(m => {
        const id = getMatchId(m);
        if (id !== null && id !== undefined) known.add(String(id));
      });
    });
  } catch (err) {
    logger.error(`Kunde inte läsa befintliga match-ID:n från DB för ${player.nickname}: ${err.message}`);
  }
  return known;
};

const saveRawMatches = async (player, tournament, matchPayload, index, matches, filteredSinceIso) => {
  const dir = path.join(RAW_ROOT, safePlayerDir(player));
  await ensureDir(dir);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const baseName = `${dateStamp}`;
  const filePath = await uniqueFilePath(dir, baseName);

  const record = {
    player,
    tournament,
    fetchedAtIso: nowIso(),
    source: 'esportsbattle',
    matches,
    meta: {
      requestUrl: matchPayload.url,
      filteredSince: filteredSinceIso,
      tournamentSlug: tournamentSlug(tournament, index),
      filePath,
    },
    rawResponse: matchPayload.payload,
  };

  await writeJson(filePath, record);
  return record;
};

const processPlayer = async (player, urls, sinceTs, db) => {
  const knownIds = await loadKnownMatchIds(player, db);
  const seenIds = new Set(knownIds);
  let fetchedMatches = 0;
  let tournaments = [];
  const allRawRecords = []; // New array to collect records
  try {
    tournaments = await fetchParticipantTournaments(player, urls);
  } catch (err) {
    logger.error(`Kunde inte hämta tournaments för ${player.nickname}: ${err.message}`);
    return;
  }

  logger.step(
    `Spelare ${player.nickname} (${player.slug || player.id}) har ${tournaments.length} tournaments (paginerat)`,
  );

  const tournamentMatchTasks = tournaments.map((tournament, i) => async () => {
    const tournamentId =
      tournament?.tournamentId ?? tournament?.id ?? tournament?._id ?? tournament?.tournament_id;
    if (!tournamentId) {
      logger.error(`Hittade inget tournamentId för index ${i} (spelare ${player.nickname}), hoppar över`);
      return null; // Return null for skipped tournaments
    }

    try {
      const matchPayload = await fetchTournamentMatches(tournamentId, urls);
      const recentMatches = [];

      for (const match of matchPayload.matches) {
        const id = getMatchId(match);
        const ts = toTs(getMatchDate(match));
        if (sinceTs && ts && ts < sinceTs) continue;
        if (id !== null && id !== undefined) {
          const key = String(id);
          if (seenIds.has(key)) continue;
          seenIds.add(key);
        }
        recentMatches.push(match);
      }

      if (!recentMatches.length) {
        logger.info(`Inga nya matcher hittades för tournament ${tournamentId} (spelare ${player.nickname}).`);
        return null; // Return null for no new matches
      }

      const limitedMatches = recentMatches.slice(0, MAX_MATCHES_PER_PLAYER - fetchedMatches);
      fetchedMatches += limitedMatches.length;
      const filteredSinceIso = new Date(sinceTs).toISOString();
      const record = await saveRawMatches(
        player,
        tournament,
        { ...matchPayload },
        i,
        limitedMatches,
        filteredSinceIso,
      );
      logger.success(
        `Sparade ${limitedMatches.length} nya matcher: ${record.meta.filePath} (totalt ${fetchedMatches} för ${player.nickname})`,
      );
      return record;
    } catch (err) {
      logger.error(
        `Kunde inte hämta/spara matcher för tournament ${tournamentId} (spelare ${player.nickname}): ${err.message}`,
      );
      return null; // Return null on error
    }
  });

  const results = await runWithConcurrency(tournamentMatchTasks, 3);
  allRawRecords.push(...results.filter(Boolean)); // Collect valid records

  if (allRawRecords.length > 0) {
    try {
      await db.collection('esb_raw_matches').insertMany(allRawRecords, { ordered: false });
      logger.success(`Sparade ${allRawRecords.length} rå-matcher till DB för ${player.nickname}`);
    } catch (err) {
      logger.error(`Kunde inte spara rå-matcher till DB för ${player.nickname}: ${err.message}`);
    }
  }
};

export const main = async () => {
  const sinceTs = await parseSinceTs();
  const runIso = nowIso();
  logger.step(`Hämtar matcher sedan ${new Date(sinceTs).toISOString()}`);

  const urls = await readJson(URLS_PATH);
  if (!urls) throw new Error('Kunde inte läsa config/urls.json');

  await ensureDir(RAW_ROOT);

  const db = await getDb();

  try {
    const players = await db.collection('esb_players').find({ source: 'esportsbattle' }).toArray();
    if (!players.length) {
      throw new Error(`Inga spelare hittades i DB (esb_players). Kör fetchAllPlayers först.`);
    }

    const playerTasks = players.map((player) => async () => {
      try {
        await processPlayer(player, urls, sinceTs, db);
      } catch (err) {
        logger.error(`Fel vid process för spelare ${player.nickname}: ${err.message}`);
      }
    });
    await runWithConcurrency(playerTasks, 2);

    await saveLastRun(runIso);
    logger.success('Klar med fetchRawMatches');
  } finally {
    // await shutdownPuppeteer(); // Moved to index.js
    // await closeDb(); // Moved to index.js
  }
};

if (isMain) {
  main().catch((err) => {
    logger.error('Fel i fetchRawMatches', err);
    process.exitCode = 1;
  });
}
