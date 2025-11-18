import { closeBrowser } from "./utils/browser.js";
import * as logger from "./utils/logger.js";
import { getDb, closeDb } from "./db/mongoClient.js";
import { runUnibetFetchMatches } from "./services/unibetFetchMatches.js";
import bot from './telegramBot.js'; // Importera bot-instansen
import { calculateEvForMatch } from './services/evCalculatorService.js'; // Importera den nya EV-tjänsten
import { formatLocalDateTime } from './utils/time.js';

// TODO: Implement EV calculation logic here
const calculateEvPerMatch = async () => {
  logger.info("Starting EV calculation per match...");
  const db = await getDb();

  const unibetMatchesCollection = db.collection('unibet-matches');
  const unibetOddsCollection = db.collection('unibet-odds');
  const playerStatsCollection = db.collection('player_stats');

  const now = new Date();
  const nowUtc = new Date(now.toUTCString()); // Konvertera aktuell lokal tid till UTC Date-objekt
  const twentyMinutesFromNowUtc = new Date(nowUtc.getTime() + 20 * 60 * 1000); // Lägg till 20 minuter till UTC-tid

  // Hämta den senaste snapshoten från unibet_matches
  const latestSnapshot = await unibetMatchesCollection.findOne(
    {},
    { sort: { createdAt: -1 } } // Sortera efter senast skapad för att få den senaste
  );

  if (!latestSnapshot || !Array.isArray(latestSnapshot.matches) || latestSnapshot.matches.length === 0) {
    logger.info("Inga senaste match-snapshots hittades i databasen.");
    return;
  }

  const allMatchesInSnapshot = latestSnapshot.matches;
  const upcomingMatches = allMatchesInSnapshot.filter(match => {
    const matchStartTime = new Date(match.event.start); // Detta är redan ett UTC Date-objekt
    return matchStartTime > nowUtc && matchStartTime <= twentyMinutesFromNowUtc;
  });

  if (!upcomingMatches.length) {
    logger.info("Inga matcher hittades som startar inom de närmaste 20 minuterna.");
    return;
  }

  logger.info(`Hittade ${upcomingMatches.length} matcher som startar inom 20 minuter.`);

  for (const match of upcomingMatches) {
    const matchId = match.event.id;
    const homeName = match.event.homeName;
    const awayName = match.event.awayName;
    const kickoffUtcIso = new Date(match.event.start).toISOString();
    const kickoffDate = new Date(match.event.start);
    const asPercent = (value) => `${((value ?? 0) * 100).toFixed(2)}%`;
    const formatTrueOdds = (prob) => {
      if (!prob || prob <= 0) return 'N/A';
      return (1 / prob).toFixed(2);
    };
    const shouldShowAllEv = false; // Sätt till true om du vill se även negativa EV
    const evThreshold = 0; // Använd 0 för alla positiva, 0.05 för >5% etc.
    const formatKickoff = (date) => formatLocalDateTime(date);

    // Extrahera bara smeknamnet från t.ex. "Czechia (Kodak)" -> "Kodak"
    const homePlayerNick = homeName.match(/\((.*?)\)/)?.[1] || homeName;
    const awayPlayerNick = awayName.match(/\((.*?)\)/)?.[1] || awayName;

    // Hämta odds för matchen
    const odds = await unibetOddsCollection.findOne({ eventId: matchId });
    if (!odds) {
      logger.warn(`Inga odds hittades för match ${matchId} (${homeName} vs ${awayName}).`);
      continue;
    }

    // Hämta spelarstatistik för hemma- och bortalag
    const homePlayerStats = await playerStatsCollection.findOne({ playerNick: homePlayerNick });
    const awayPlayerStats = await playerStatsCollection.findOne({ playerNick: awayPlayerNick });

    if (!homePlayerStats || !awayPlayerStats) {
      logger.warn(`Spelarstatistik saknas för match ${matchId} (${homeName} vs ${awayName}).`);
      continue;
    }

    logger.info(`⚽ ${homeName} vs ${awayName}`);
    logger.info(`🕒 Kickoff (UTC): ${kickoffUtcIso}`);
    
    const evResults = calculateEvForMatch(match, odds, homePlayerStats, awayPlayerStats);

    if (!evResults || evResults.length === 0) {
      logger.info(`Inga EV-resultat kunde beräknas för match ${matchId}.`);
      continue;
    }

    const sortedResults = [...evResults].sort((a, b) => (Number(a.line) || 0) - (Number(b.line) || 0));

    let matchSummaryMessage = `⚽️  *${homeName} vs ${awayName}*  ⚽️

⏰  ${formatKickoff(kickoffDate)}

-------------------------

`;
    const sections = [];

    sortedResults.forEach((result) => {
      const { line, overOdds, underOdds, probOver, probUnder, evOver, evUnder } = result;
      const probOverPct = asPercent(probOver);
      const probUnderPct = asPercent(probUnder);
      const evOverPct = asPercent(evOver);
      const evUnderPct = asPercent(evUnder);
      const trueOverOdds = formatTrueOdds(probOver);
      const trueUnderOdds = formatTrueOdds(probUnder);

      const plays = [];

      if (shouldShowAllEv || evOver > evThreshold) {
        plays.push({
          label: `⬆️  Over ${line}`,
          odds: overOdds,
          trueOdds: trueOverOdds,
          ev: evOverPct,
          highlight: evOver > evThreshold,
        });
      }

      if (shouldShowAllEv || evUnder > evThreshold) {
        plays.push({
          label: `⬇️  Under ${line}`,
          odds: underOdds,
          trueOdds: trueUnderOdds,
          ev: evUnderPct,
          highlight: evUnder > evThreshold,
        });
      }

      if (!plays.length) return;

      plays.forEach((play) => {
        const section = `${play.label}
🎲  Odds: ${play.odds}
🎯  True odds: ${play.trueOdds}
💰  EV: ${play.ev}
`;
        sections.push(section);

        // Vill du logga även negativa, byt shouldShowAllEv till true ovan
        logger.info(section.replace(/\n+$/, ''));
      });
    });

    if (!sections.length) {
      logger.info(`Ingen positiv EV hittades för ${homeName} vs ${awayName}.`);
      continue;
    }

    matchSummaryMessage += sections.join('\n-------------------------\n\n') + '\n\n-------------------------\n';

    await bot.sendMessage(match.chatId || process.env.TELEGRAM_CHAT_ID, matchSummaryMessage, { parse_mode: 'Markdown' });
  }

  logger.info("EV calculation per match completed.");
};

const main = async () => {
  try {
    await runUnibetFetchMatches();
    await calculateEvPerMatch();
  } catch (error) {
    logger.error("Ett fel uppstod i EV-kalkylatorn:", error);
  } finally {
    await closeBrowser();
    await closeDb();
  }
};

main();
