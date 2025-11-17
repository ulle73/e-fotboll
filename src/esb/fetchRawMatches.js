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
} from './utils.js';
import * as logger from '../utils/logger.js';
import { fetchJsonWithPuppeteer, shutdownPuppeteer } from './puppeteerFetch.js';
// import { getDb, closeDb } from '../db/mongoClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;

const URLS_PATH = pathRelativeToRoot('config', 'urls.json');
const PLAYERS_PATH = pathRelativeToRoot('data', 'esb', 'all_players.json');
const RAW_ROOT = pathRelativeToRoot('data', 'esb', 'raw_matches');
const MAX_PAGES = 200;
// Begränsa till senaste X sidor per spelare för att snabba upp hämtningen.
const RECENT_TOURNAMENT_PAGES = 5;
// Hämta högst N matcher per spelare (senaste).
const MAX_MATCHES_PER_PLAYER = 200;

const fetchJson = async (url, timeoutMs = 20000) => fetchJsonWithPuppeteer(url, timeoutMs);

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

const saveRawMatches = async (player, tournament, matchPayload, index) => {
  const dir = path.join(RAW_ROOT, safePlayerDir(player));
  await ensureDir(dir);
  const fileName = `${tournamentSlug(tournament, index)}.json`;
  const filePath = path.join(dir, fileName);

  const record = {
    player,
    tournament,
    fetchedAtIso: nowIso(),
    source: 'esportsbattle',
    matches: matchPayload.matches,
    meta: {
      requestUrl: matchPayload.url,
    },
    rawResponse: matchPayload.payload,
  };

  await writeJson(filePath, record);
  return filePath;
};

const processPlayer = async (player, urls) => {
  let fetchedMatches = 0;
  let tournaments = [];
  try {
    tournaments = await fetchParticipantTournaments(player, urls);
  } catch (err) {
    logger.error(`Kunde inte hämta tournaments för ${player.nickname}: ${err.message}`);
    return;
  }

  logger.step(`Spelare ${player.nickname} (${player.slug || player.id}) har ${tournaments.length} tournaments`);

  // const db = await getDb();

  for (let i = 0; i < tournaments.length; i += 1) {
    if (fetchedMatches >= MAX_MATCHES_PER_PLAYER) {
      logger.info(
        `Har redan hämtat ${fetchedMatches} matcher för ${player.nickname}, stoppar fler tournaments.`,
      );
      break;
    }

    const tournament = tournaments[i];
    const tournamentId =
      tournament?.tournamentId ?? tournament?.id ?? tournament?._id ?? tournament?.tournament_id;
    if (!tournamentId) {
      logger.error(`Hittade inget tournamentId för index ${i} (spelare ${player.nickname}), hoppar över`);
      continue;
    }

    try {
      const matchPayload = await fetchTournamentMatches(tournamentId, urls);
      const savedPath = await saveRawMatches(player, tournament, matchPayload, i);
      const count = Array.isArray(matchPayload.matches) ? matchPayload.matches.length : 0;
      fetchedMatches += count;
      logger.success(`Sparade ${count} rå-matcher: ${savedPath} (totalt ${fetchedMatches})`);

      // await db.collection('esb_raw_matches').insertOne({ player, tournament, raw: matchPayload, savedPath });
    } catch (err) {
      logger.error(
        `Kunde inte hämta/spara matcher för tournament ${tournamentId} (spelare ${player.nickname}): ${err.message}`,
      );
      continue;
    }
  }

  // await closeDb();
};

export const main = async () => {
  const urls = await readJson(URLS_PATH);
  if (!urls) throw new Error('Kunde inte läsa config/urls.json');

  await ensureDir(RAW_ROOT);

  const players = await readJson(PLAYERS_PATH, []);
  if (!players.length) {
    throw new Error(`Inga spelare hittades i ${PLAYERS_PATH}. Kör fetchAllPlayers först.`);
  }

  for (const player of players) {
    try {
      await processPlayer(player, urls);
    } catch (err) {
      logger.error(`Fel vid process för spelare ${player.nickname}: ${err.message}`);
      continue;
    }
  }

  logger.success('Klar med fetchRawMatches');
  await shutdownPuppeteer();
};

if (isMain) {
  main().catch((err) => {
    logger.error('Fel i fetchRawMatches', err);
    process.exitCode = 1;
  });
}
