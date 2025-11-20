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
const TELEGRAM_FORMULA = process.env.TELEGRAM_FORMULA || 'raz_optimal';
const TELEGRAM_MAX_LINES = Number.isFinite(Number(process.env.TELEGRAM_MAX_LINES))
  ? Math.max(1, Number(process.env.TELEGRAM_MAX_LINES))
  : 3;
const TELEGRAM_MAX_PLAYS = Number.isFinite(Number(process.env.TELEGRAM_MAX_PLAYS))
  ? Math.max(1, Number(process.env.TELEGRAM_MAX_PLAYS))
  : 1;
const BULK_WRITE_CHUNK_SIZE = Number.isFinite(Number(process.env.EV_BULK_CHUNK_SIZE))
  ? Math.max(50, Number(process.env.EV_BULK_CHUNK_SIZE))
  : 200;
const BULK_WRITE_MAX_TIME_MS = Number.isFinite(Number(process.env.EV_BULK_MAX_TIME_MS))
  ? Math.max(30000, Number(process.env.EV_BULK_MAX_TIME_MS))
  : 120000;

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

const escapeMarkdown = (text = '') => text;

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
  const selectedPlayTracker = new Map();
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
    const homePlayerStats = await findPlayerStats(playerStatsCollection, homePlayerNick);
    const awayPlayerStats = await findPlayerStats(playerStatsCollection, awayPlayerNick);

    if (!homePlayerStats || !awayPlayerStats) {
      logger.warn(`Spelarstatistik saknas för match ${matchId} (${homeName} vs ${awayName}).`);
      continue;
    }

    logger.info(`⚽ ${homeName} vs ${awayName}`);
    logger.info(`🕒 Kickoff (UTC): ${kickoffUtcIso}`);
    
    let telegramEvResults = [];
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
          spread: false,
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
          spread: false,
        });
        });
      }
      if (formula === TELEGRAM_FORMULA) {
        telegramEvResults = evResults || [];
      }
    }

    if (!telegramEvResults || telegramEvResults.length === 0) {
      logger.info(
        `Inga EV-resultat kunde beräknas för ${matchId} med formeln ${TELEGRAM_FORMULA}.`,
      );
      continue;
    }

    const prioritizedResults = [...telegramEvResults]
      .sort((a, b) => {
        const scoreA = Math.max(a.evOver ?? Number.NEGATIVE_INFINITY, a.evUnder ?? Number.NEGATIVE_INFINITY);
        const scoreB = Math.max(b.evOver ?? Number.NEGATIVE_INFINITY, b.evUnder ?? Number.NEGATIVE_INFINITY);
        return scoreB - scoreA || (Number(a.line) || 0) - (Number(b.line) || 0);
      })
      .slice(0, TELEGRAM_MAX_LINES);

    let matchSummaryMessage = `⏰ ${formatKickoff(kickoffDate)}

⚽️ ${homeName} vs ${awayName} ⚽️

`;
    const plays = [];
    prioritizedResults.forEach((result) => {
      const { line, overOdds, underOdds, probOver, probUnder, evOver, evUnder, criterionLabel } =
        result;
      const probOverPct = asPercent(probOver);
      const probUnderPct = asPercent(probUnder);
      const evOverPct = asPercent(evOver);
      const evUnderPct = asPercent(evUnder);
      const trueOverOdds = formatTrueOdds(probOver);
      const trueUnderOdds = formatTrueOdds(probUnder);
      const scopeAllowed = TELEGRAM_SCOPE_WHITELIST.has((result.scope || '').toLowerCase());
      const overUnit = pickTelegramUnit(overOdds, evOver);
      const underUnit = pickTelegramUnit(underOdds, evUnder);

      if (scopeAllowed && (shouldShowAllEv || evOver > evThreshold) && overUnit !== null) {
        plays.push({
          label: `⬆️ Over ${line}`,
          line,
          odds: overOdds,
          trueOdds: trueOverOdds,
          ev: evOverPct,
          highlight: evOver > evThreshold,
          scopeLabel: escapeMarkdown(criterionLabel || ''),
          scope: result.scope || 'total',
          selection: 'over',
          rawEv: evOver,
          rawOdds: overOdds,
          unit: overUnit,
        });
      }

      if (scopeAllowed && (shouldShowAllEv || evUnder > evThreshold) && underUnit !== null) {
        plays.push({
          label: `⬇️ Under ${line}`,
          line,
          odds: underOdds,
          trueOdds: trueUnderOdds,
          ev: evUnderPct,
          highlight: evUnder > evThreshold,
          scopeLabel: escapeMarkdown(criterionLabel || ''),
          scope: result.scope || 'total',
          selection: 'under',
          rawEv: evUnder,
          rawOdds: underOdds,
          unit: underUnit,
        });
      }
    });

  if (!plays.length) {
      logger.info(`Ingen positiv EV hittades för ${homeName} vs ${awayName}.`);
      continue;
    }

    const playMap = new Map();
    plays.forEach((play) => {
      const key = `${play.selection}::${play.scope || 'total'}::${play.line}`;
      const existing = playMap.get(key);
      if (!existing || Number(play.rawEv) > Number(existing.rawEv)) {
        playMap.set(key, play);
      }
    });

    const prioritizedPlays = Array.from(playMap.values()).sort((a, b) => {
      const evA = Number(a.rawEv) || 0;
      const evB = Number(b.rawEv) || 0;
      return evB - evA;
    });

    const baseSelection = prioritizedPlays.slice(0, TELEGRAM_MAX_PLAYS);
    const extraSelections = prioritizedPlays
      .slice(TELEGRAM_MAX_PLAYS)
      .filter((play) => (Number(play.rawOdds) || 0) > 5 && (Number(play.rawEv) || 0) > 1);
    const selectedPlays = [...baseSelection, ...extraSelections];
    const spreadIds = new Set(
      selectedPlays.map(
        (play) =>
          `${matchId}::${TELEGRAM_FORMULA}::${play.selection}::${play.scope || 'total'}::${
            play.line
          }`,
      ),
    );
    if (!selectedPlays.length) {
      logger.info(`Inga spel uppfyllde Telegram-kraven för ${homeName} vs ${awayName}.`);
      continue;
    }

    const messageSections = selectedPlays.map((play) => {
      const unitLine = formatUnitLabel(play.unit);
      const lines = [
        play.label,
        `🏷️ ${play.scopeLabel}`,
        `🎲 Odds: ${play.odds}`,
      ];
      if (unitLine) {
        lines.push(`💰 Unit: ${unitLine}`);
      }
      return lines.join('\n');
    });

    matchSummaryMessage += messageSections.join('\n\n');

    // if (eventUrl) {
    //   matchSummaryMessage += `🔗 ${eventUrl}\n`;
    // }

    await bot.sendMessage(match.chatId || process.env.TELEGRAM_CHAT_ID, matchSummaryMessage, {
      parse_mode: 'Markdown',
    });
    const existing = selectedPlayTracker.get(matchId) || new Set();
    spreadIds.forEach((key) => existing.add(key));
    selectedPlayTracker.set(matchId, existing);
  }

  logger.info("EV calculation per match completed.");

  if (evBetDocs.length) {
    try {
      const spreads = new Map();
      selectedPlayTracker.forEach((plays, eventId) => {
        spreads.set(eventId, new Set(plays));
      });
      const ops = evBetDocs.map((doc) => {
        const spreadKey = `${doc.eventId}::${doc.formula}::${doc.selection}::${
          doc.scope || 'total'
        }::${doc.line}`;
        const spread =
          spreads.get(doc.eventId)?.has(spreadKey) ||
          false;
        const enrichedDoc = { ...doc, spread };
        const filter = {
          eventId: doc.eventId,
          snapshotTime: doc.snapshotTime ?? null,
          formula: doc.formula,
          selection: doc.selection,
          line: doc.line,
          scope: doc.scope,
          criterionLabel: doc.criterionLabel,
        };
        return { replaceOne: { filter, replacement: enrichedDoc, upsert: true } };
      });
      const chunks = chunkArray(ops, BULK_WRITE_CHUNK_SIZE);
      let totalUpserts = 0;
      let totalModified = 0;
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const res = await evBetsCollection.bulkWrite(chunk, {
          ordered: false,
          maxTimeMS: BULK_WRITE_MAX_TIME_MS,
        });
        totalUpserts += res.upsertedCount || 0;
        totalModified += res.modifiedCount || 0;
      }
      logger.success(
        `Sparade ${totalUpserts} nya och uppdaterade ${totalModified} EV-spel i DB (ev-bets)`,
      );
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
const escapeRegex = (value = '') =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findPlayerStats = async (collection, playerNick) => {
  if (!playerNick) return null;
  const direct = await collection.findOne({ playerNick });
  if (direct) return direct;
  const regex = new RegExp(`^${escapeRegex(playerNick)}$`, 'i');
  return collection.findOne({ playerNick: regex });
};

const chunkArray = (arr, chunkSize) => {
  const size = Math.max(1, chunkSize);
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
};
