import path from 'path';
import { fileURLToPath } from 'url';
import { ensureDir, pathRelativeToRoot, replacePlaceholders, slugify, writeJson, runWithConcurrency } from './utils.js';
import * as logger from '../utils/logger.js';
import { fetchJsonWithPuppeteer, shutdownPuppeteer } from './puppeteerFetch.js';
import { getDb, closeDb } from '../db/mongoClient.js';
import { loadUrls } from '../config/urls.js';



const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;

const OUTPUT_PATH = pathRelativeToRoot('data', 'esb', 'all_players.json');
const MAX_PAGES = 1000;

const fetchJson = async (url, timeoutMs = 20000) => fetchJsonWithPuppeteer(url, timeoutMs);

const normalizeParticipant = (participant, urls) => {
  const id = participant?.id ?? participant?.participantId ?? participant?._id;
  const nickname =
    participant?.nickname ??
    participant?.nickName ??
    participant?.name ??
    participant?.title ??
    participant?.slug ??
    '';
  const slug = participant?.slug || slugify(nickname);
  const country = participant?.country ?? participant?.countryName ?? participant?.nationality ?? null;
  const countryCode =
    participant?.countryCode ??
    participant?.country_code ??
    participant?.countryAbbr ??
    participant?.countryShortName ??
    null;
  const imageUrl = participant?.imageUrl ?? participant?.image ?? participant?.photo ?? participant?.avatar ?? null;

  const profileApi = urls.pageRoutes?.rosterProfile
    ? replacePlaceholders(urls.pageRoutes.rosterProfile, { participantId: id })
    : null;

  const compareApiTemplate = urls.pageRoutes?.rosterCompare ?? null;
  const profilePage = urls.siteRoot ? `${urls.siteRoot.replace(/\/$/, '')}/player/${slug}` : null;

  return {
    id,
    slug,
    nickname,
    country,
    countryCode,
    imageUrl,
    profileApi,
    profilePage,
    compareApiTemplate,
    source: 'esportsbattle',
  };
};

const extractParticipantsArray = (payload) => {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.participants)) return payload.participants;
  return [];
};

const fetchParticipants = async (urls) => {
  const template = urls.pageRoutes?.rosterIndex;
  if (!template) {
    throw new Error('rosterIndex saknas i urls.json');
  }

  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = replacePlaceholders(template, { page });
    logger.info(`Hämtar participants page ${page}: ${url}`);
    const payload = await fetchJson(url);
    const participants = extractParticipantsArray(payload);
    if (!participants.length) {
      logger.info(`Inga fler spelare hittades på sida ${page}, avbryter paginering.`);
      break;
    }
    participants.forEach((p) => all.push(normalizeParticipant(p, urls)));
    logger.info(`Ack spelare: ${all.length}`);
  }
  return all;
};

const fetchParticipantDetail = async (player, urls) => {
  const profileTemplate = urls.pageRoutes?.rosterProfile;
  const participantKey = player.slug || player.nickname || player.id;
  if (!profileTemplate || !participantKey) return null;
  const url = replacePlaceholders(profileTemplate, { participantId: participantKey });
  logger.info(`Hämtar profil för ${participantKey}: ${url}`);
  const detail = await fetchJson(url);
  return { ...player, detail, participantKey };
};

export const main = async () => {
  logger.step('Startar fetchAllPlayers');
  const urls = await loadUrls();
  await ensureDir(path.dirname(OUTPUT_PATH));

  const basePlayers = await fetchParticipants(urls);
  const playerDetailTasks = basePlayers.map((base) => async () => {
    try {
      const detailed = await fetchParticipantDetail(base, urls);
      return detailed?.detail || detailed || base;
    } catch (err) {
      logger.error(`Kunde inte hämta profil för ${base.nickname || base.id}: ${err.message}`);
      return base;
    }
  });

  const players = await runWithConcurrency(playerDetailTasks, 5);

  logger.step(`Sparar ${players.length} spelare till ${OUTPUT_PATH} (direkt API-respons per spelare)`);
  await writeJson(OUTPUT_PATH, players);

  const db = await getDb();
  try {
    const col = db.collection('esb_players');
    await col.deleteMany({ source: 'esportsbattle' });
    const docs = players.map((p) => ({ ...p, source: p.source ?? 'esportsbattle' }));
    if (docs.length) {
      await col.insertMany(docs, { ordered: false });
      logger.success(`Sparade ${docs.length} spelare i DB (esb_players)`);
    } else {
      logger.info('Inga spelare att spara i DB');
    }
  } finally {
    // await closeDb(); // Moved to index.js
  }

  logger.success('Klar med fetchAllPlayers');
  // await shutdownPuppeteer(); // Moved to index.js
};

if (isMain) {
  main().catch((err) => {
    logger.error('Fel i fetchAllPlayers', err);
    process.exitCode = 1;
  });
}
