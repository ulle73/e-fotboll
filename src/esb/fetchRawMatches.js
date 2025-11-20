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
  valueFromCandidates,
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
const MAX_PAGES = 200;
const RECENT_TOURNAMENT_PAGES = 5; // Begränsa till senaste X sidor per spelare för att snabba upp hämtningen.
const MAX_MATCHES_PER_PLAYER = 50; // Högst N matcher per spelare per körning.
const DEFAULT_SINCE_HOURS = 48;
const LAST_RUN_COLLECTION = 'esb_metadata';
const LAST_RUN_DOC_ID = 'fetchRawMatchesLastRun';
const FUTURE_MATCH_GRACE_MINUTES = 5;
const FUTURE_MATCH_GRACE_MS = FUTURE_MATCH_GRACE_MINUTES * 60 * 1000;

const fetchJson = async (url, timeoutMs = 20000) => fetchJsonWithPuppeteer(url, timeoutMs);

const getMatchId = (match) =>
  match?.id ?? match?.matchId ?? match?.match_id ?? match?._id ?? match?.eventId ?? null;

const DISALLOWED_TOURNAMENT_TOKEN_PARTS = [
  '2x6',
  '2x6min',
  '2x6 min',
  '2x 6min',
  '2x 6 min',
  'volta',
  'Volta'
];

const tournamentHasBlockedToken = (tournament) => {
  const tokens = [tournament?.token, tournament?.token_internatinal];

  return tokens.some((token) => {
    if (token === null || token === undefined) return false;
    const lower = String(token).toLowerCase();
    const compact = lower.replace(/\s+/g, '');

    return (
      DISALLOWED_TOURNAMENT_TOKEN_PARTS.some((blocked) => lower.includes(blocked)) ||
      compact.includes('2x6') ||
      compact.includes('2x6min')
    );
  });
};

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

const parseScoreString = (value) => {
  if (typeof value !== 'string') return null;
  const parts = value.split(/[:\-]/).map((v) => v.trim());
  if (parts.length !== 2) return null;
  const [home, away] = parts.map((v) => Number.parseInt(v, 10));
  if (Number.isFinite(home) && Number.isFinite(away)) {
    return { home, away };
  }
  return null;
};

const toNumber = (val) => {
  if (val === undefined || val === null || Number.isNaN(val)) return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
};

const getScoreValue = (match, side) => {
  const directCandidates =
    side === 'home'
      ? ['goalsHome', 'homeGoals', 'homeScore', 'home_score', 'scoreHome', 'home', 'score1']
      : ['goalsAway', 'awayGoals', 'awayScore', 'away_score', 'scoreAway', 'away', 'score2'];

  for (const field of directCandidates) {
    const num = toNumber(match?.[field]);
    if (num !== null) return num;
  }

  const participantField = side === 'home' ? 'participant1' : 'participant2';
  const shortField = side === 'home' ? 'p1' : 'p2';
  const participantObj = match?.[participantField] || match?.[shortField];
  const participantScore = toNumber(participantObj?.score);
  if (participantScore !== null) return participantScore;

  const nestedSources = ['score', 'result', 'finalScore', 'finalResult', 'fulltime', 'ft'];
  for (const src of nestedSources) {
    const container = match?.[src];
    if (typeof container === 'object' && container !== null) {
      const num = toNumber(
        valueFromCandidates(container, [
          side,
          `${side}Score`,
          `${side}_score`,
          `${side}Goals`,
          `${side}_goals`,
          side === 'home' ? 'home_score' : 'away_score',
        ]),
      );
      if (num !== null) return num;
    } else if (typeof container === 'string') {
      const parsed = parseScoreString(container);
      if (parsed) return side === 'home' ? parsed.home : parsed.away;
    }
  }

  const resultString =
    match?.resultString || match?.scoreString || match?.score_line || match?.result || match?.score;
  const parsed = parseScoreString(resultString);
  if (parsed) return side === 'home' ? parsed.home : parsed.away;

  return null;
};

const matchHasFinalScore = (match) => {
  const homeScore = getScoreValue(match, 'home');
  const awayScore = getScoreValue(match, 'away');
  return Number.isFinite(homeScore) && Number.isFinite(awayScore);
};

const parseSinceTs = async (db) => {
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
    const lastRunDoc = await db.collection(LAST_RUN_COLLECTION).findOne({ _id: LAST_RUN_DOC_ID });
    const ts = Date.parse(lastRunDoc?.lastRunIso);
    if (Number.isFinite(ts)) return ts;
  } catch (err) {
    logger.info(`Kunde inte läsa last-run från DB, fortsätter med default: ${err.message}`);
  }

  return Date.now() - DEFAULT_SINCE_HOURS * 60 * 60 * 1000;
};

const saveLastRun = async (runIso, db) => {
  try {
    await db
      .collection(LAST_RUN_COLLECTION)
      .updateOne({ _id: LAST_RUN_DOC_ID }, { $set: { lastRunIso: runIso } }, { upsert: true });
  } catch (err) {
    logger.info(`Kunde inte spara last-run till DB: ${err.message}`);
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
  const allRawRecords = []; // New array to collect records
  let consecutiveBlockedTournaments = 0;
  const nowTs = Date.now();
  let insertedForPlayer = 0;

  const template = urls.api?.participantsTournaments;
  if (!template) throw new Error('participantsTournaments saknas i urls.json');

  const participantKey = player?.slug || player?.nickname || player?.id;
  if (!participantKey) throw new Error('Player saknar slug/nickname/id för tournaments-URL');

  logger.step(
    `Startar bearbetning för spelare ${player.nickname} (${player.slug || player.id})`,
  );

  let stopProcessingPlayer = false;
  const maxTournamentPages = Math.min(MAX_PAGES, RECENT_TOURNAMENT_PAGES);

  for (let page = 1; page <= maxTournamentPages; page += 1) {
    if (stopProcessingPlayer || fetchedMatches >= MAX_MATCHES_PER_PLAYER) {
      logger.info(
        `Har redan hämtat ${fetchedMatches} matcher för ${player.nickname}, stoppar fler turneringar (tidig avbrytning på sidnivå).`,
      );
      break;
    }

    const tournamentPageUrl = replacePlaceholders(template, { participantId: participantKey, page });
    logger.info(`Hämtar tournaments för spelare ${participantKey}, sida ${page}: ${tournamentPageUrl}`);
    let tournamentsOnPage = [];
    try {
      const payload = await fetchJson(tournamentPageUrl);
      tournamentsOnPage = extractArray(payload, 'tournaments');
    } catch (err) {
      logger.error(`Kunde inte hämta tournaments för spelare ${participantKey}, sida ${page}: ${err.message}`);
      continue;
    }

    if (!tournamentsOnPage.length) {
      logger.info(`Inga fler tournament-sidor för spelare ${participantKey}, stannar.`);
      break;
    }

    // Process tournaments on this page
    for (let i = 0; i < tournamentsOnPage.length; i += 1) {
      if (stopProcessingPlayer || fetchedMatches >= MAX_MATCHES_PER_PLAYER) {
        logger.info(
          `Har redan hämtat ${fetchedMatches} matcher för ${player.nickname}, stoppar fler turneringar (tidig avbrytning på turneringsnivå).`,
        );
        break;
      }

      const tournament = tournamentsOnPage[i];
      const tournamentId =
        tournament?.tournamentId ?? tournament?.id ?? tournament?._id ?? tournament?.tournament_id;
      if (!tournamentId) {
        logger.error(`Hittade inget tournamentId för index ${i} (spelare ${player.nickname}), hoppar över`);
        continue;
      }

      if (tournamentHasBlockedToken(tournament)) {
        consecutiveBlockedTournaments += 1;
        const tokenLabel = [tournament?.token, tournament?.token_internatinal].filter(Boolean).join(' / ') || 'okänd';
        logger.info(
          `Hoppar över tournament ${tournamentId} (spelare ${player.nickname}) pga spärrad token: ${tokenLabel} (${consecutiveBlockedTournaments} i rad).`,
        );

        if (consecutiveBlockedTournaments >= 3) {
          logger.info(
            `${consecutiveBlockedTournaments} spärrade turneringar i rad hittades för ${player.nickname}, går vidare till nästa spelare.`,
          );
          stopProcessingPlayer = true;
        }
        continue;
      }
      consecutiveBlockedTournaments = 0;

      try {
        const matchPayload = await fetchTournamentMatches(tournamentId, urls);
        const recentMatches = [];
        let foundOldMatchInTournament = false;

        for (const match of matchPayload.matches) {
          const id = getMatchId(match);
          const ts = toTs(getMatchDate(match));
          const kickoffIsoRaw = getMatchDate(match);

          if (ts && ts > nowTs + FUTURE_MATCH_GRACE_MS) {
            logger.debug?.(
              `Hoppar över framtida match ${id ?? 'okänd'} (kickoff ${new Date(ts).toISOString()})`
            );
            continue;
          }

          if (!matchHasFinalScore(match)) {
            logger.debug?.(
              `Hoppar över match ${id ?? 'okänd'} utan färdigt resultat (kickoff ${kickoffIsoRaw ?? 'okänd'})`
            );
            continue;
          }

          // Om matchen är äldre än sinceTs, eller redan sedd, sluta bearbeta fler matcher i denna turnering
          if (ts && ts < sinceTs) {
            logger.info(`Match ${id} för tournament ${tournamentId} är äldre än sinceTs, stoppar bearbetning av denna turnering.`);
            foundOldMatchInTournament = true;
            stopProcessingPlayer = true; // Signalera att vi kan sluta bearbeta spelaren också
            break;
          }
          if (id !== null && id !== undefined) {
            const key = String(id);
            if (seenIds.has(key)) {
              logger.info(`Match ${id} för tournament ${tournamentId} har redan setts, stoppar bearbetning av denna turnering.`);
              foundOldMatchInTournament = true;
              stopProcessingPlayer = true; // Signalera att vi kan sluta bearbeta spelaren också
              break;
            }
            seenIds.add(key);
          }
          recentMatches.push(match);
        }

        if (foundOldMatchInTournament) {
          continue; // Gå till nästa turnering om vi hittade en gammal match och ska sluta
        }

        if (!recentMatches.length) {
          logger.info(`Inga nya matcher hittades för tournament ${tournamentId} (spelare ${player.nickname}).`);
          continue;
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
        allRawRecords.push(record); // Collect the record
        logger.success(
          `Sparade ${limitedMatches.length} nya matcher: ${record.meta.filePath} (totalt ${fetchedMatches} för ${player.nickname})`,
        );
      } catch (err) {
        logger.error(
          `Kunde inte hämta/spara matcher för tournament ${tournamentId} (spelare ${player.nickname}): ${err.message}`,
        );
        continue;
      }
    }
  }

  // Apply MAX_MATCHES_PER_PLAYER limit to the collected raw records
  const finalRawRecords = allRawRecords.slice(0, MAX_MATCHES_PER_PLAYER);

  if (finalRawRecords.length > 0) {
    try {
      await db.collection('esb_raw_matches').insertMany(finalRawRecords, { ordered: false });
      insertedForPlayer = finalRawRecords.length;
      logger.success(`Sparade ${finalRawRecords.length} rå-matcher till DB för ${player.nickname}`);
    } catch (err) {
      logger.error(`Kunde inte spara rå-matcher till DB för ${player.nickname}: ${err.message}`);
    }
  }

  return insertedForPlayer;
};

export const main = async () => {
  const db = await getDb();
  const sinceTs = await parseSinceTs(db);
  const runIso = nowIso();
  logger.step(`Hämtar matcher sedan ${new Date(sinceTs).toISOString()}`);

  const urls = await readJson(URLS_PATH);
  if (!urls) throw new Error('Kunde inte läsa config/urls.json');

  await ensureDir(RAW_ROOT);

  try {
    const players = await db.collection('esb_players').find({ source: 'esportsbattle' }).toArray();
    if (!players.length) {
      throw new Error(`Inga spelare hittades i DB (esb_players). Kör fetchAllPlayers först.`);
    }

    const playerTasks = players.map((player) => async () => {
      try {
        return await processPlayer(player, urls, sinceTs, db);
      } catch (err) {
        logger.error(`Fel vid process för spelare ${player.nickname}: ${err.message}`);
        return 0;
      }
    });
    const insertedCounts = await runWithConcurrency(playerTasks, 2);
    const totalInserted = insertedCounts.reduce((sum, value) => sum + (value || 0), 0);

    await saveLastRun(runIso, db);
    logger.success(`Klar med fetchRawMatches – totalt ${totalInserted} rå-matcher sparade i DB`);
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
