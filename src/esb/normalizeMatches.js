import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import {
  pathRelativeToRoot,
  projectRoot,
  readJson,
  valueFromCandidates,
  writeJson,
  runWithConcurrency,
} from './utils.js';
import * as logger from '../utils/logger.js';
import { getDb, closeDb } from '../db/mongoClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;


const OUTPUT_PATH = pathRelativeToRoot('data', 'esb', 'normalized_matches.json');



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

const resolveNickname = (candidate) => {
  if (candidate === undefined || candidate === null) return null;
  if (typeof candidate === 'string') return candidate;
  if (typeof candidate === 'object') {
    return (
      candidate.nickname ??
      candidate.nickName ??
      candidate.name ??
      candidate.title ??
      candidate.player ??
      candidate.slug ??
      null
    );
  }
  return null;
};

const getNickname = (match, side) => {
  const fields =
    side === 'home'
      ? ['homePlayer', 'home', 'homeParticipant', 'player1', 'firstPlayer', 'teamHome', 'participant1', 'p1']
      : ['awayPlayer', 'away', 'awayParticipant', 'player2', 'secondPlayer', 'teamAway', 'participant2', 'p2'];

  for (const field of fields) {
    const nick = resolveNickname(match?.[field]);
    if (nick) return nick;
  }

  const participants = match?.participants || match?.players || match?.teams;
  if (Array.isArray(participants) && participants.length >= 2) {
    const idx = side === 'home' ? 0 : 1;
    const nick = resolveNickname(participants[idx]);
    if (nick) return nick;
  }

  return null;
};

const getScore = (match, side) => {
  const directCandidates =
    side === 'home'
      ? ['goalsHome', 'homeGoals', 'homeScore', 'home_score', 'scoreHome', 'home', 'score1']
      : ['goalsAway', 'awayGoals', 'awayScore', 'away_score', 'scoreAway', 'away', 'score2'];

  for (const field of directCandidates) {
    const num = toNumber(match?.[field]);
    if (num !== null) return num;
  }

  // participant1/participant2 eller p1/p2 med score-fält
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

const getDateValue = (match) =>
  valueFromCandidates(match, [
    'kickoff',
    'kickoffTime',
    'start',
    'startAt',
    'start_at',
    'startDate',
    'startTime',
    'time',
    'date',
    'matchDate',
    'begin_at',
  ]);

const getMode = (match) =>
  valueFromCandidates(match, ['mode', 'modeName', 'matchType', 'type', 'format', 'gameMode'], 'unknown');

const extractMatchesFromRaw = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw.matches)) return raw.matches;
  if (Array.isArray(raw.data?.matches)) return raw.data.matches;
  if (Array.isArray(raw.data)) return raw.data;
  if (Array.isArray(raw.rawResponse?.data)) return raw.rawResponse.data;
  if (Array.isArray(raw.rawResponse?.matches)) return raw.rawResponse.matches;
  return [];
};

const normalizeMatch = (match, context) => {
  const dateValue = getDateValue(match);
  const mode = getMode(match) || 'unknown';
  const homePlayerNick = getNickname(match, 'home') ?? 'UnknownHome';
  const awayPlayerNick = getNickname(match, 'away') ?? 'UnknownAway';
  const goalsHome = getScore(match, 'home');
  const goalsAway = getScore(match, 'away');
  const kickoffIso = dateValue ? new Date(dateValue).toISOString() : null;
  const totalGoals =
    Number.isFinite(goalsHome) && Number.isFinite(goalsAway) ? goalsHome + goalsAway : null;
  const keyString = `${dateValue ?? 'n/a'}|${mode}|${homePlayerNick}|${awayPlayerNick}|${goalsHome}|${goalsAway}`;
  const esbMatchId = crypto.createHash('sha1').update(keyString).digest('hex');

  return {
    esbMatchId,
    source: 'esportsbattle',
    date: dateValue ?? null,
    mode,
    kickoff: kickoffIso,
    homePlayerNick,
    awayPlayerNick,
    goalsHome: Number.isFinite(goalsHome) ? goalsHome : null,
    goalsAway: Number.isFinite(goalsAway) ? goalsAway : null,
    totalGoals,
    rawIds: [context.relativePath],
  };
};

const deduplicateMatches = (rawEntries) => {
  const map = new Map();

  rawEntries.forEach((entry) => {
    const matches = extractMatchesFromRaw(entry.data);
    matches.forEach((match, idx) => {
      const normalized = normalizeMatch(match, entry);
      // Filtrera bort matcher som inte har resultat (dvs. planerade matcher)
      if (normalized.goalsHome === null || normalized.goalsAway === null) {
        return;
      }
      const key = `${normalized.date}|${normalized.mode}|${normalized.homePlayerNick}|${normalized.awayPlayerNick}|${normalized.goalsHome}|${normalized.goalsAway}`;
      const existing = map.get(key);
      if (existing) {
        if (!existing.rawIds.includes(entry.relativePath)) {
          existing.rawIds.push(entry.relativePath);
        }
      } else {
        map.set(key, normalized);
      }
    });
  });

  return Array.from(map.values());
};

export const main = async () => {
  const db = await getDb();
  const rawMatchesCollection = db.collection('esb_raw_matches');
  const rawMatchDocuments = await rawMatchesCollection.find({ source: 'esportsbattle' }).toArray();
  logger.step(`Läser ${rawMatchDocuments.length} råa matchdokument från DB`);

  const rawEntries = rawMatchDocuments.map((doc) => ({
    filePath: doc.meta?.filePath || 'N/A', // Keep for compatibility, though not used for reading
    relativePath: doc.meta?.filePath || 'N/A', // Keep for compatibility, though not used for reading
    data: doc,
  }));

  const normalized = deduplicateMatches(rawEntries);
  logger.step(`Normaliserat antal matcher: ${normalized.length}`);

  await writeJson(OUTPUT_PATH, normalized);

 
  try {
    const col = db.collection('esb_matches');
    await col.deleteMany({ source: 'esportsbattle' });
    if (normalized.length) {
      await col.insertMany(normalized, { ordered: false });
      logger.success(`Sparade ${normalized.length} matcher i DB (esb_matches)`);
    } else {
      logger.info('Inga matcher att spara i DB');
    }
  } finally {
    await closeDb();
  }

  logger.success(`Sparade normaliserade matcher till ${OUTPUT_PATH}`);
};

if (isMain) {
  main().catch((err) => {
    logger.error('Fel i normalizeMatches', err);
    process.exitCode = 1;
  });
}
