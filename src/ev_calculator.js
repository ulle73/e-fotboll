import fs from 'fs/promises';
import { closeBrowser } from "./utils/browser.js";
import * as logger from "./utils/logger.js";
import { getDb, closeDb } from "./db/mongoClient.js";
import { runUnibetFetchMatches } from "./services/unibetFetchMatches.js";
import bot from './telegramBot.js'; // Importera bot-instansen
import { calculateEvForMatch } from './services/evCalculatorService.js'; // Importera den nya EV-tjänsten
import { formatLocalDateTime } from './utils/time.js';
import { buildUnibetEventUrl } from './utils/unibetLinks.js';
import { nowIso } from './esb/utils.js';

const TELEGRAM_SCOPE_WHITELIST = new Set(['total']); // Lägg till 'home', 'away', 'firstHalf' vid behov
const TELEGRAM_RULES_PATH = new URL('../config/telegramUnitRules.json', import.meta.url);
let TELEGRAM_UNIT_RULES = [];

const resolveNumber = (value, fallback = null) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

const loadTelegramUnitRules = async () => {
  try {
    const raw = await fs.readFile(TELEGRAM_RULES_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logger.warn(`Kunde inte läsa telegramUnitRules.json: ${err.message}`);
    return [];
  }
};

const pickTelegramUnit = (odds, evValue) => {
  const numericOdds = Number(odds);
  const numericEv = Number(evValue);
  if (!Number.isFinite(numericOdds) || !Number.isFinite(numericEv)) return null;

  for (const rule of TELEGRAM_UNIT_RULES) {
    const minOdds = resolveNumber(rule.minOdds, -Infinity);
    const maxOdds = resolveNumber(rule.maxOdds, Infinity);
    const minEv = resolveNumber(rule.minEv, 0);
    const maxEv = resolveNumber(rule.maxEv, Infinity);
    if (
      numericOdds >= minOdds &&
      numericOdds <= maxOdds &&
      numericEv >= minEv &&
      numericEv <= maxEv
    ) {
      const unit = Number(rule.unit);
      return Number.isFinite(unit) ? unit : null;
    }
  }
  return null;
};

const formatUnitLabel = (unit) => {
  if (!Number.isFinite(unit)) return '';
  const rounded =
    Number.isInteger(unit) ? unit.toFixed(0) : unit.toFixed(2).replace(/\.?0+$/, '');
  return `${rounded}u`;
};

const stopBotPollingSafely = async () => {
  if (typeof bot?.stopPolling === 'function') {
    try {
      await bot.stopPolling();
    } catch (err) {
      logger.warn(`Kunde inte stoppa Telegram-polling: ${err.message}`);
    }
  }
};

// TODO: Implement EV calculation logic here
const calculateEvPerMatch = async () => {
  logger.info("Starting EV calculation per match...");
  const db = await getDb();
  if (!TELEGRAM_UNIT_RULES.length) {
    TELEGRAM_UNIT_RULES = await loadTelegramUnitRules();
  }

  const unibetMatchesCollection = db.collection('unibet-matches');
  const unibetOddsCollection = db.collection('unibet-odds');
  const playerStatsCollection = db.collection('player_stats');
  const evBetsCollection = db.collection('ev-bets');
  const formulas = [
    'raz_optimal',
    'form_agressive',
    'equal_weighted',
    'form_heavy',
    'exp_decay',
    'median_based',
    'trimmed_mean',
    'volatility_adjusted',
    'recency_trigger',
  ];
  const evBetDocs = [];
  const UPCOMING_WINDOW_MINUTES = 10;
  
 
  logger.info(`**************************DB name: ${db.databaseName}`);

  const playerCount = await db.collection("player_stats").countDocuments();
  logger.info(`*************************Antal player_stats-dokument: ${playerCount}`);


  const now = new Date();
  const nowUtc = new Date(now.toUTCString()); // Konvertera aktuell lokal tid till UTC Date-objekt
  const windowEndUtc = new Date(nowUtc.getTime() + UPCOMING_WINDOW_MINUTES * 60 * 1000);

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
    return matchStartTime > nowUtc && matchStartTime <= windowEndUtc;
  });

  if (!upcomingMatches.length) {
    logger.info(`Inga matcher hittades som startar inom de närmaste ${UPCOMING_WINDOW_MINUTES} minuterna.`);
    return;
  }

  logger.info(`Hittade ${upcomingMatches.length} matcher som startar inom ${UPCOMING_WINDOW_MINUTES} minuter.`);

  for (const match of upcomingMatches) {
    const matchId = match.event.id;
    const homeName = match.event.homeName;
    const awayName = match.event.awayName;
    const kickoffUtcIso = new Date(match.event.start).toISOString();
    const kickoffDate = new Date(match.event.start);
    const eventUrl = buildUnibetEventUrl(matchId);
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
    
    let razEvResults = [];
    for (const formula of formulas) {
      const evResults = calculateEvForMatch(match, odds, homePlayerStats, awayPlayerStats, formula);
      if (evResults && evResults.length) {
        // Spara alla spel (over/under) för backtesting
        evResults.forEach((res) => {
          const trueOverOdds = res.probOver > 0 ? (1 / res.probOver).toFixed(2) : null;
          const trueUnderOdds = res.probUnder > 0 ? (1 / res.probUnder).toFixed(2) : null;
          evBetDocs.push({
            eventId: matchId,
            eventName: match.event.name || `${homeName} - ${awayName}`,
            homeName,
            awayName,
            kickoff: match.event.start,
            snapshotId: odds.snapshotId || null,
            snapshotTime: odds.snapshotTime || null,
            snapshotTimeUtc: odds.snapshotTimeUtc || null,
            snapshotFilePath: odds.snapshotFilePath || null,
            formula,
            line: res.line,
            scope: res.scope,
            criterionLabel: res.criterionLabel,
            selection: 'over',
            offeredOdds: res.overOdds,
            trueOdds: trueOverOdds,
            probability: res.probOver,
            ev: res.evOver,
            expectedGoals: res.expectedGoals,
            result: null,
            settled: false,
            source: 'unibet',
            createdAt: nowIso(),
          });
          evBetDocs.push({
            eventId: matchId,
            eventName: match.event.name || `${homeName} - ${awayName}`,
            homeName,
            awayName,
            kickoff: match.event.start,
            snapshotId: odds.snapshotId || null,
            snapshotTime: odds.snapshotTime || null,
            snapshotTimeUtc: odds.snapshotTimeUtc || null,
            snapshotFilePath: odds.snapshotFilePath || null,
            formula,
            line: res.line,
            scope: res.scope,
            criterionLabel: res.criterionLabel,
            selection: 'under',
            offeredOdds: res.underOdds,
            trueOdds: trueUnderOdds,
            probability: res.probUnder,
            ev: res.evUnder,
            expectedGoals: res.expectedGoals,
            result: null,
            settled: false,
            source: 'unibet',
            createdAt: nowIso(),
          });
        });
      }
      if (formula === 'raz_optimal') {
        razEvResults = evResults || [];
      }
    }

    if (!razEvResults || razEvResults.length === 0) {
      logger.info(`Inga EV-resultat kunde beräknas för match ${matchId}.`);
      continue;
    }

    const sortedResults = [...razEvResults].sort((a, b) => (Number(a.line) || 0) - (Number(b.line) || 0));

    let matchSummaryMessage = `⚽️  *${homeName} vs ${awayName}*  ⚽️

⏰  ${formatKickoff(kickoffDate)}

-------------------------

`;
    const sections = [];

    sortedResults.forEach((result) => {
      const { line, overOdds, underOdds, probOver, probUnder, evOver, evUnder, criterionLabel } = result;
      const probOverPct = asPercent(probOver);
      const probUnderPct = asPercent(probUnder);
      const evOverPct = asPercent(evOver);
      const evUnderPct = asPercent(evUnder);
      const trueOverOdds = formatTrueOdds(probOver);
      const trueUnderOdds = formatTrueOdds(probUnder);

      const plays = [];

      const scopeAllowed = TELEGRAM_SCOPE_WHITELIST.has((result.scope || '').toLowerCase());
      const overUnit = pickTelegramUnit(overOdds, evOver);
      const underUnit = pickTelegramUnit(underOdds, evUnder);

      if (
        scopeAllowed &&
        (shouldShowAllEv || evOver > evThreshold) &&
        overUnit !== null
      ) {
        plays.push({
          label: `⬆️  Over ${line}`,
          odds: overOdds,
          trueOdds: trueOverOdds,
          ev: evOverPct,
          highlight: evOver > evThreshold,
          scopeLabel: criterionLabel,
          unit: overUnit,
        });
      }

      if (
        scopeAllowed &&
        (shouldShowAllEv || evUnder > evThreshold) &&
        underUnit !== null
      ) {
        plays.push({
          label: `⬇️  Under ${line}`,
          odds: underOdds,
          trueOdds: trueUnderOdds,
          ev: evUnderPct,
          highlight: evUnder > evThreshold,
          scopeLabel: criterionLabel,
          unit: underUnit,
        });
      }

      if (!plays.length) return;

      plays.forEach((play) => {
        const unitLine = formatUnitLabel(play.unit);
        const section = `${play.label}
🏷️  ${play.scopeLabel}
🎲  Odds: ${play.odds}
🎯  True odds: ${play.trueOdds}
💰  EV: ${play.ev}
${unitLine ? `📏  Unit: ${unitLine}\n` : ''}`;
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

    if (eventUrl) {
      matchSummaryMessage += `🔗 ${eventUrl}\n`;
    }

    await bot.sendMessage(match.chatId || process.env.TELEGRAM_CHAT_ID, matchSummaryMessage, { parse_mode: 'Markdown' });
  }

  logger.info("EV calculation per match completed.");

  if (evBetDocs.length) {
    try {
      const ops = evBetDocs.map((doc) => {
        const filter = {
          eventId: doc.eventId,
          snapshotTime: doc.snapshotTime ?? null,
          formula: doc.formula,
          selection: doc.selection,
          line: doc.line,
          scope: doc.scope,
          criterionLabel: doc.criterionLabel,
        };
        return { replaceOne: { filter, replacement: doc, upsert: true } };
      });
      const res = await evBetsCollection.bulkWrite(ops, { ordered: false });
      const upserts = res.upsertedCount || 0;
      const modified = res.modifiedCount || 0;
      logger.success(`Sparade ${upserts} nya och uppdaterade ${modified} EV-spel i DB (ev-bets)`);
    } catch (err) {
      logger.error(`Kunde inte spara EV-spel i DB: ${err.message}`);
    }
  }
};

const main = async () => {
  try {
    await runUnibetFetchMatches();
    await calculateEvPerMatch();
  } catch (error) {
    logger.error("Ett fel uppstod i EV-kalkylatorn:", error);
  } finally {
    await stopBotPollingSafely();
    await closeBrowser();
    await closeDb();
  }
};

main();
