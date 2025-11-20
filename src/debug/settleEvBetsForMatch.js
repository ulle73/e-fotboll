// src/debug/settleEvBetsForMatch.js
import { ObjectId } from 'mongodb';
import { getDb, closeDb } from '../db/mongoClient.js';
import { nowIso } from '../esb/utils.js';

const argValue = (key) => {
  const prefix = `--${key}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : undefined;
};

const toNumberSafe = (value, fallback = null) => {
  if (value === undefined || value === null) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const nicknameFromDisplayName = (name) => {
  if (!name) return null;
  const match = name.match(/\((.*?)\)/);
  if (match && match[1]) return match[1].trim();
  return name.trim();
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseIsoDate = (value) => {
  if (!value) return null;
  const ts = Date.parse(value);
  if (Number.isFinite(ts)) return new Date(ts);
  return null;
};

const matchDateValue = (matchDoc) => {
  const candidates = [matchDoc?.kickoff, matchDoc?.date];
  for (const candidate of candidates) {
    const parsed = parseIsoDate(candidate);
    if (parsed) return parsed;
  }
  return null;
};

const scopeScore = (matchDoc, scope) => {
  if (!matchDoc) return null;
  const goalsHome = toNumberSafe(matchDoc.goalsHome, null);
  const goalsAway = toNumberSafe(matchDoc.goalsAway, null);
  const total =
    Number.isFinite(goalsHome) && Number.isFinite(goalsAway) ? goalsHome + goalsAway : null;
  const fhHome = toNumberSafe(matchDoc.prevPeriodsScoresHome, null);
  const fhAway = toNumberSafe(matchDoc.prevPeriodsScoresAway, null);
  const fhTotal =
    Number.isFinite(fhHome) && Number.isFinite(fhAway) ? fhHome + fhAway : null;

  switch ((scope || 'total').toLowerCase()) {
    case 'home':
      return goalsHome;
    case 'away':
      return goalsAway;
    case 'firsthalf':
      return fhTotal;
    default:
      return total;
  }
};

const settleOutcome = (score, lineValue, selection) => {
  if (!Number.isFinite(score)) {
    return { result: 'unresolved', note: 'score missing', score };
  }
  const line = toNumberSafe(lineValue, null);
  if (!Number.isFinite(line)) {
    return { result: 'unresolved', note: 'line missing', score };
  }
  const pick = (selection || '').toLowerCase();
  if (pick !== 'over' && pick !== 'under') {
    return { result: 'unresolved', note: 'selection unknown', score };
  }
  if (Math.abs(score - line) < 1e-9) {
    return { result: 'push', score };
  }
  if (pick === 'over') {
    return { result: score > line ? 'win' : 'loss', score };
  }
  return { result: score < line ? 'win' : 'loss', score };
};

const DEFAULT_TOLERANCE_MINUTES = Number(process.env.SETTLE_TOLERANCE_MINUTES ?? 120);
const toleranceMinutes = toNumberSafe(argValue('tolerance'), DEFAULT_TOLERANCE_MINUTES);
const parseOptionalInt = (value) => {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : null;
};
const maxEventsArg = parseOptionalInt(argValue('maxEvents'));
const maxEventsToProcess = maxEventsArg !== null ? Math.max(1, maxEventsArg) : null;
const betIdArg = argValue('betId');
const eventIdArg = toNumberSafe(argValue('eventId'), null);

const buildBetQuery = () => {
  if (betIdArg) {
    return { _id: new ObjectId(betIdArg) };
  }
  if (Number.isFinite(eventIdArg)) {
    return { eventId: eventIdArg, settled: false };
  }
  return { settled: false };
};

const fetchCandidateEvents = async (col) => {
  if (betIdArg) {
    const bet = await col.findOne(buildBetQuery());
    return bet ? [bet] : [];
  }

  if (Number.isFinite(eventIdArg)) {
    const bet = await col.findOne({ eventId: eventIdArg, settled: false });
    return bet ? [bet] : [];
  }

  const baseFilter = { settled: false };
  const eventIds = await col.distinct('eventId', { ...baseFilter, eventId: { $ne: null } });
  const limitedIds =
    maxEventsToProcess !== null ? eventIds.slice(0, maxEventsToProcess) : eventIds;

  const docs = [];
  for (const id of limitedIds) {
    const bet = await col.findOne({ eventId: id, settled: false });
    if (bet) {
      docs.push(bet);
    }
  }

  // Hantera ev-bets som saknar eventId (extremfall) – behandla varje bet individuellt
  if (!eventIds.length) {
    const fallbackCursor = col.find(baseFilter);
    const fallbackBets =
      maxEventsToProcess !== null
        ? await fallbackCursor.limit(maxEventsToProcess).toArray()
        : await fallbackCursor.toArray();
    return fallbackBets;
  }

  return docs;
};

const chooseBestMatch = (matchDocs, kickoffIso) => {
  if (!matchDocs.length) return null;
  const target = parseIsoDate(kickoffIso);
  if (!target) return null;
  const toleranceMs = toleranceMinutes * 60 * 1000;

  let bestWithin = null;
  let bestOverall = null;

  for (const doc of matchDocs) {
    const matchDate = matchDateValue(doc);
    if (!matchDate) continue;
    const diff = Math.abs(matchDate.getTime() - target.getTime());
    if (!bestOverall || diff < bestOverall.diff) {
      bestOverall = { doc, diff };
    }
    if (diff <= toleranceMs && (!bestWithin || diff < bestWithin.diff)) {
      bestWithin = { doc, diff };
    }
  }

  if (bestWithin) return bestWithin.doc;
  if (bestOverall) {
    const diffMinutes = (bestOverall.diff / (60 * 1000)).toFixed(1);
    console.warn(
      `⚠️  Ingen ESB-match inom ${toleranceMinutes} minuter hittades. Använder närmaste kandidat (diff ${diffMinutes} min).`
    );
    return bestOverall.doc;
  }
  return null;
};

const findEsbMatchForBet = async (matchesCol, bet) => {
  const homeNickRaw = nicknameFromDisplayName(bet.homeName);
  const awayNickRaw = nicknameFromDisplayName(bet.awayName);
  const kickoff = bet.kickoff;
  if (!homeNickRaw || !awayNickRaw || !kickoff) {
    console.warn(`Bet ${bet._id} saknar data för matchning (home/away/kickoff).`);
    return null;
  }

  const homeRegex = new RegExp(`^${escapeRegExp(homeNickRaw)}$`, 'i');
  const awayRegex = new RegExp(`^${escapeRegExp(awayNickRaw)}$`, 'i');

  const candidates = await matchesCol
    .find({
      source: 'esportsbattle',
      $or: [
        { homePlayerNick: homeRegex, awayPlayerNick: awayRegex },
        { homePlayerNick: awayRegex, awayPlayerNick: homeRegex },
      ],
    })
    .toArray();

  if (!candidates.length) return null;

  return chooseBestMatch(candidates, kickoff);
};

const settleBetGroup = async (db, bet, matchesCol, evBetsCol) => {
  const groupedBets = await evBetsCol
    .find({ eventId: bet.eventId, settled: false })
    .toArray();

  if (!groupedBets.length) {
    console.warn(`Inga osatta bets hittades för event ${bet.eventId}.`);
    return { updated: 0, matchDoc: null };
  }

  const matchDoc = await findEsbMatchForBet(matchesCol, bet);
  if (!matchDoc) {
    console.warn(
      `Hittade ingen ESB-match för event ${bet.eventId} (${bet.homeName} vs ${bet.awayName}).`
    );
    return { updated: 0, matchDoc: null };
  }

  let updated = 0;
  for (const evBet of groupedBets) {
    const score = scopeScore(matchDoc, evBet.scope);
    const outcome = settleOutcome(score, evBet.line, evBet.selection);
    if (outcome.result === 'unresolved') {
      console.warn(
        `Hoppar över bet ${evBet._id} pga ${outcome.note} (scope=${evBet.scope}, line=${evBet.line}).`
      );
      continue;
    }

    const updateDoc = {
      result: outcome.result,
      settled: true,
      settledAt: nowIso(),
      esbMatchId: matchDoc.esbMatchId,
      esbMatchDocId: matchDoc._id,
      esbMatchKickoff: matchDoc.kickoff ?? matchDoc.date ?? null,
      esbMatchGoalsHome: matchDoc.goalsHome ?? null,
      esbMatchGoalsAway: matchDoc.goalsAway ?? null,
      esbMatchFirstHalfHome: matchDoc.prevPeriodsScoresHome ?? null,
      esbMatchFirstHalfAway: matchDoc.prevPeriodsScoresAway ?? null,
      esbMatchScopeScore: outcome.score,
    };

    await evBetsCol.updateOne({ _id: evBet._id }, { $set: updateDoc });
    updated += 1;
    console.log(
      `Rättade bet ${evBet._id} (event ${evBet.eventId}) => ${outcome.result} (score ${outcome.score}).`
    );
  }

  if (updated === groupedBets.length) {
    await matchesCol.updateOne(
      { _id: matchDoc._id },
      { $set: { corrected: true, correctedAt: nowIso() } }
    );
    console.log(`Markerade match ${matchDoc.esbMatchId} som corrected=true.`);
  }

  return { updated, matchDoc };
};

const main = async () => {
  const db = await getDb();
  try {
    const evBetsCol = db.collection('ev-bets');
    const matchesCol = db.collection('esb_matches');

    const candidateBets = await fetchCandidateEvents(evBetsCol);
    if (!candidateBets.length) {
      console.log('Inga ev-bets matchade filtret (kanske redan settled?).');
      return;
    }

    const processedEvents = new Set();
    let totalUpdated = 0;
    for (const bet of candidateBets) {
      if (!bet) continue;
      if (processedEvents.has(bet.eventId)) continue;
      processedEvents.add(bet.eventId);

      const { updated } = await settleBetGroup(db, bet, matchesCol, evBetsCol);
      totalUpdated += updated;
    }

    console.log(`Totalt uppdaterade bets: ${totalUpdated}`);
  } finally {
    await closeDb();
  }
};

main().catch((err) => {
  console.error('Fel i settleEvBetsForMatch:', err);
  process.exitCode = 1;
});
