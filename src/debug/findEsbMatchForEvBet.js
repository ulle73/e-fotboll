// src/debug/findEsbMatchForEvBet.js
import { ObjectId } from 'mongodb';
import { getDb, closeDb } from '../db/mongoClient.js';

const argValue = (key) => {
  const prefix = `--${key}=`;
  const entry = process.argv.find((arg) => arg.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : undefined;
};

const toNumberSafe = (val) => {
  if (val === null || val === undefined) return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
};

const parseIsoDate = (value) => {
  const ts = value ? Date.parse(value) : NaN;
  return Number.isFinite(ts) ? new Date(ts) : null;
};

const nicknameFromDisplayName = (name) => {
  if (!name) return null;
  const parenMatch = name.match(/\((.*?)\)/);
  if (parenMatch && parenMatch[1]) return parenMatch[1].trim();
  return name.trim();
};

const toleranceMinutes = toNumberSafe(argValue('tolerance')) ?? 60;
const betIdArg = argValue('betId');
const eventIdArg = argValue('eventId');
const fallbackHomeArg = argValue('home');
const fallbackAwayArg = argValue('away');
const fallbackKickoffArg = argValue('kickoff');

if (!betIdArg && !eventIdArg && !(fallbackHomeArg && fallbackAwayArg && fallbackKickoffArg)) {
  console.error(
    'Ange minst --betId=<mongoId>, --eventId=<id> eller manuellt paket med --home --away --kickoff.'
  );
  process.exit(1);
}

const fetchEvBet = async (db) => {
  const col = db.collection('ev-bets');
  if (betIdArg) {
    const bet = await col.findOne({ _id: new ObjectId(betIdArg) });
    if (bet) return bet;
    console.warn(`Hittade ingen EV-bet med _id=${betIdArg}`);
  }
  if (eventIdArg) {
    const eventId = Number(eventIdArg);
    const cursor = col
      .find({ eventId })
      .sort({ createdAt: -1 })
      .limit(1);
    const bet = await cursor.next();
    if (bet) return bet;
    console.warn(`Hittade ingen EV-bet med eventId=${eventId}`);
  }
  if (fallbackHomeArg && fallbackAwayArg && fallbackKickoffArg) {
    return {
      _id: 'manual',
      eventId: toNumberSafe(eventIdArg),
      homeName: fallbackHomeArg,
      awayName: fallbackAwayArg,
      kickoff: fallbackKickoffArg,
    };
  }
  return null;
};

const matchKickoffDate = (match) => {
  const candidates = [match?.kickoff, match?.date];
  for (const candidate of candidates) {
    const parsed = parseIsoDate(candidate);
    if (parsed) return parsed;
  }
  return null;
};

const formatMatchSummary = (match) => {
  const kickoff = match?.kickoff ?? match?.date ?? 'okänd tid';
  return [
    `esbMatchId=${match?.esbMatchId ?? 'okänd'}`,
    `matchId=${match?.matchId ?? 'okänd'}`,
    `eventId=${match?.eventId ?? 'okänd'}`,
    `kickoff=${kickoff}`,
    `result=${match?.goalsHome}-${match?.goalsAway}`,
  ].join(' | ');
};

const main = async () => {
  const db = await getDb();
  try {
    const bet = await fetchEvBet(db);
    if (!bet) {
      console.error('Kunde inte hitta någon EV-bet eller manuellt data saknas.');
      process.exitCode = 1;
      return;
    }

    const kickoffDate = parseIsoDate(bet.kickoff);
    if (!kickoffDate) {
      console.error('EV-bet saknar kickoff-tid, kan inte matcha.');
      process.exitCode = 1;
      return;
    }

    const homeNick = nicknameFromDisplayName(bet.homeName);
    const awayNick = nicknameFromDisplayName(bet.awayName);
    if (!homeNick || !awayNick) {
      console.error('Kunde inte extrahera spelarnamn från EV-bet.');
      process.exitCode = 1;
      return;
    }

    const matchesCol = db.collection('esb_matches');
    const query = {
      source: 'esportsbattle',
      homePlayerNick: homeNick,
      awayPlayerNick: awayNick,
    };

    const candidates = await matchesCol.find(query).toArray();
    if (!candidates.length) {
      console.warn(
        `Inga normaliserade matcher hittades för ${homeNick} vs ${awayNick}. Försök med annat intervall eller kontrollera stavning.`
      );
      process.exitCode = 1;
      return;
    }

    const targetTs = kickoffDate.getTime();
    const enriched = candidates
      .map((match) => {
        const matchDate = matchKickoffDate(match);
        if (!matchDate) return null;
        const diffMinutes = Math.abs(matchDate.getTime() - targetTs) / (60 * 1000);
        return { match, diffMinutes };
      })
      .filter(Boolean)
      .sort((a, b) => a.diffMinutes - b.diffMinutes);

    const withinTolerance = enriched.filter((entry) => entry.diffMinutes <= toleranceMinutes);
    const bestCandidates = withinTolerance.length ? withinTolerance : enriched.slice(0, 3);

    if (!bestCandidates.length) {
      console.warn('Hittade inga matcher med giltig kickoff-tid att jämföra.');
      process.exitCode = 1;
      return;
    }

    console.log(
      `EV-bet ${bet._id} (${homeNick} vs ${awayNick}) kickoff=${kickoffDate.toISOString()}`
    );
    if (!withinTolerance.length) {
      console.warn(
        `Inga matcher inom ${toleranceMinutes} minuter hittades. Visar närmaste kandidater istället.`
      );
    }
    bestCandidates.forEach((entry, idx) => {
      const label = withinTolerance.length ? 'Träff' : 'Kandidat';
      console.log(
        `${idx + 1}. ${label} (diff ${entry.diffMinutes.toFixed(1)} min): ${formatMatchSummary(
          entry.match
        )}`
      );
    });

    if (bestCandidates[0]) {
      const match = bestCandidates[0].match;
      console.log('\nResultat att spara på EV-bet:');
      console.log({
        esbMatchId: match.esbMatchId,
        matchId: match.matchId ?? null,
        eventId: match.eventId ?? null,
        finalScore: `${match.goalsHome}-${match.goalsAway}`,
      });
    }
  } finally {
    await closeDb();
  }
};

main().catch((err) => {
  console.error('Fel i findEsbMatchForEvBet:', err);
  process.exitCode = 1;
});
