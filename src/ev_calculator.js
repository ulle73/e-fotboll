import { closeBrowser } from "./utils/browser.js";
import * as logger from "./utils/logger.js";
import { getDb, closeDb } from "./db/mongoClient.js";
import { runUnibetFetchMatches } from "./services/unibetFetchMatches.js";
import bot from './telegramBot.js'; // Importera bot-instansen
import { calculateEvForMatch } from './services/evCalculatorService.js'; // Importera den nya EV-tjänsten

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

    logger.info(`[DEBUG] Match: ${match.event.name}`);
    logger.info(`[DEBUG] Match Start Time (UTC): ${matchStartTime.toISOString()}`);
    logger.info(`[DEBUG] Current Time (UTC): ${nowUtc.toISOString()}`);
    logger.info(`[DEBUG] 20 Minutes From Now (UTC): ${twentyMinutesFromNowUtc.toISOString()}`);
    logger.info(`[DEBUG] Condition 1 (matchStartTime > nowUtc): ${matchStartTime > nowUtc}`);
    logger.info(`[DEBUG] Condition 2 (matchStartTime <= twentyMinutesFromNowUtc): ${matchStartTime <= twentyMinutesFromNowUtc}`);
    logger.info(`[DEBUG] Combined Condition: ${matchStartTime > nowUtc && matchStartTime <= twentyMinutesFromNowUtc}`);

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

    // Extrahera bara smeknamnet från t.ex. "Czechia (Kodak)" -> "Kodak"
    const homePlayerNick = homeName.match(/\((.*?)\)/)?.[1] || homeName;
    const awayPlayerNick = awayName.match(/\((.*?)\)/)?.[1] || awayName;

    // Hämta odds för matchen
    const odds = await unibetOddsCollection.findOne({ eventId: matchId });
    if (!odds) {
      logger.warn(`Inga odds hittades för match ${matchId} (${homeName} vs ${awayName}).`);
      continue;
    }

    // Logga hela odds-objektet för att se strukturen
    logger.info(`[DEBUG] Odds object for match ${matchId}: ${JSON.stringify(odds.odds)}`);

    // Hämta spelarstatistik för hemma- och bortalag
    const homePlayerStats = await playerStatsCollection.findOne({ playerNick: homePlayerNick });
    const awayPlayerStats = await playerStatsCollection.findOne({ playerNick: awayPlayerNick });

    if (!homePlayerStats || !awayPlayerStats) {
      logger.warn(`Spelarstatistik saknas för match ${matchId} (${homeName} vs ${awayName}).`);
      continue;
    }

    logger.info(`Bearbetar match: ${homeName} vs ${awayName} (Kickoff: ${match.event.start})`);
    
    const evResults = calculateEvForMatch(match, odds, homePlayerStats, awayPlayerStats);

    if (!evResults || evResults.length === 0) {
      logger.info(`Inga EV-resultat kunde beräknas för match ${matchId}.`);
      continue;
    }

    let matchSummaryMessage = `*Match: ${homeName} vs ${awayName}*
Kickoff: ${match.event.start}
`;
    let foundPositiveEv = false; // Används för att markera om någon positiv EV hittades

    for (const result of evResults) {
      const { line, overOdds, underOdds, probOver, probUnder, evOver, evUnder } = result;

      // Logga linan och dess odds
      logger.info(`[DEBUG] Linje ${line} Mål: Över ${line} Odds: ${overOdds}, Under ${line} Odds: ${underOdds}`);

      let lineMessage = `
--- Linje ${line} Mål ---
`;
      lineMessage += `Unibet Odds: Över ${line}: ${overOdds}, Under ${line}: ${underOdds}
`;
      lineMessage += `Poisson Sannolikhet: Över ${line}: ${(probOver * 100).toFixed(2)}%, Under ${line}: ${(probUnder * 100).toFixed(2)}%
`;
      lineMessage += `EV Över ${line}: ${(evOver * 100).toFixed(2)}%
`;
      lineMessage += `EV Under ${line}: ${(evUnder * 100).toFixed(2)}%
`;

      if (evOver > 0.05) { // Exempel: Positiv EV över 5%
        lineMessage += `🚨 HÖG EV PÅ ÖVER ${line} MÅL! 🚨`;
        foundPositiveEv = true;
      } else if (evUnder > 0.05) {
        lineMessage += `🚨 HÖG EV PÅ UNDER ${line} MÅL! 🚨`;
        foundPositiveEv = true;
      }
      matchSummaryMessage += lineMessage;
    }

    // Skicka alltid meddelandet, men markera om det finns positiv EV
    if (foundPositiveEv) {
      await bot.sendMessage(match.chatId || process.env.TELEGRAM_CHAT_ID, matchSummaryMessage, { parse_mode: 'Markdown' });
    } else {
      logger.info(`Ingen signifikant EV hittades för ${homeName} vs ${awayName} på någon linje. Skickar ändå meddelande med alla resultat.`);
      await bot.sendMessage(match.chatId || process.env.TELEGRAM_CHAT_ID, matchSummaryMessage, { parse_mode: 'Markdown' });
    }
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
