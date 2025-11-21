import { closeBrowser } from "./utils/browser.js";
import * as logger from "./utils/logger.js";
import { getDb, closeDb } from "./db/mongoClient.js";
import { runUnibetFetchMatches } from "./services/unibetFetchMatches.js";
import bot from './telegram/bot.js';
import controlBot from './telegram/controlBot.js'; // Import control bot
import { calculateAllEvsForMatch, prepareBacktestingDocs } from './services/calculationService.js';
import { getUpcomingMatches } from './services/matchService.js';
import { loadTelegramUnitRules, selectPlaysForTelegram, formatTelegramMessage } from './telegram/messagingService.js';
import { selectPositiveEvLines, formatControlMessage } from './telegram/controlBotService.js'; // Import control bot services
import { findPlayerStats, chunkArray } from './utils/sharedUtils.js';

// --- Constants ---
const TELEGRAM_FORMULA = process.env.TELEGRAM_FORMULA || 'raz_optimal';
const TELEGRAM_MAX_LINES = Number.isFinite(Number(process.env.TELEGRAM_MAX_LINES)) ? Math.max(1, Number(process.env.TELEGRAM_MAX_LINES)) : 3;
const TELEGRAM_MAX_PLAYS = Number.isFinite(Number(process.env.TELEGRAM_MAX_PLAYS)) ? Math.max(1, Number(process.env.TELEGRAM_MAX_PLAYS)) : 1;
const BULK_WRITE_CHUNK_SIZE = Number.isFinite(Number(process.env.EV_BULK_CHUNK_SIZE)) ? Math.max(50, Number(process.env.EV_BULK_CHUNK_SIZE)) : 200;
const BULK_WRITE_MAX_TIME_MS = Number.isFinite(Number(process.env.EV_BULK_MAX_TIME_MS)) ? Math.max(30000, Number(process.env.EV_BULK_MAX_TIME_MS)) : 120000;
const TELEGRAM_SCOPE_WHITELIST = new Set(['total']);
const CONTROL_BOT_CHAT_ID = process.env.CONTROL_BOT_CHAT_ID;

// --- Helper Functions ---

const stopBotPollingSafely = async () => {
    if (typeof bot?.stopPolling === 'function') {
        try {
            await bot.stopPolling();
        } catch (err) {
            logger.warn(`Kunde inte stoppa Telegram-polling: ${err.message}`);
        }
    }
    // No need to stop polling for controlBot as it's not polling
};

async function saveEvBetsToDb(db, evBetDocs, selectedPlayTracker) {
    if (!evBetDocs.length) return;
        // ... (rest of the function is unchanged)
    const evBetsCollection = db.collection('ev-bets');
    try {
        const spreads = new Map();
        selectedPlayTracker.forEach((plays, eventId) => {
            spreads.set(eventId, new Set(plays));
        });

        const ops = evBetDocs.map((doc) => {
            const spreadKey = `${doc.eventId}::${doc.formula}::${doc.selection}::${doc.scope || 'total'}::${doc.line}`;
            const spread = spreads.get(doc.eventId)?.has(spreadKey) || false;
            const enrichedDoc = { ...doc, spread };
            const filter = {
                eventId: doc.eventId,
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
        for (const chunk of chunks) {
            const res = await evBetsCollection.bulkWrite(chunk, { ordered: false, maxTimeMS: BULK_WRITE_MAX_TIME_MS });
            totalUpserts += res.upsertedCount || 0;
            totalModified += res.modifiedCount || 0;
        }
        logger.success(`Sparade ${totalUpserts} nya och uppdaterade ${totalModified} EV-spel i DB (ev-bets)`);
    } catch (err) {
        logger.error(`Kunde inte spara EV-spel i DB: ${err.message}`);
    }
}

// --- Main Orchestrator ---

async function runEvCalculation() {
    logger.info("Starting EV calculation process...");
    const db = await getDb();
    const unitRules = await loadTelegramUnitRules();

    const collections = {
        odds: db.collection('unibet-odds'),
        playerStats: db.collection('player_stats'),
        matches: db.collection('unibet-matches'),
    };

    const formulas = [ 'raz_optimal', 'form_agressive', 'equal_weighted', 'form_heavy', 'exp_decay', 'median_based', 'trimmed_mean', 'volatility_adjusted', 'recency_trigger' ];
    const allEvBetDocs = [];
    const selectedPlayTracker = new Map();
    const UPCOMING_WINDOW_MINUTES = 10;

    const upcomingMatches = await getUpcomingMatches(collections.matches, UPCOMING_WINDOW_MINUTES);

    for (const match of upcomingMatches) {
        const { id: matchId, homeName, awayName } = match.event;
        const homePlayerNick = homeName.match(/\((.*?)\)/)?.[1] || homeName;
        const awayPlayerNick = awayName.match(/\((.*?)\)/)?.[1] || awayName;

        const odds = await collections.odds.findOne({ eventId: matchId }, { sort: { createdAt: -1 } });
        if (!odds) {
            logger.warn(`Inga odds hittades för match ${matchId} (${homeName} vs ${awayName}).`);
            continue;
        }

        const homePlayerStats = await findPlayerStats(collections.playerStats, homePlayerNick);
        const awayPlayerStats = await findPlayerStats(collections.playerStats, awayPlayerNick);

        if (!homePlayerStats || !awayPlayerStats) {
            logger.warn(`Spelarstatistik saknas för match ${matchId} (${homeName} vs ${awayName}).`);
            continue;
        }
        
        logger.info(`Processing matchId: ${matchId} - ⚽ ${homeName} vs ${awayName}`);

        const { allEvResults, telegramEvResults } = calculateAllEvsForMatch({ match, odds, homePlayerStats, awayPlayerStats }, formulas, TELEGRAM_FORMULA);

        if (allEvResults.length) {
            const backtestingDocs = prepareBacktestingDocs(allEvResults, match, odds);
            allEvBetDocs.push(...backtestingDocs);
        }

        if (!telegramEvResults.length) {
            logger.info(`Inga EV-resultat kunde beräknas för ${matchId} med formeln ${TELEGRAM_FORMULA}.`);
            continue;
        }

        // --- Main Bot Logic ---
        const telegramConfig = {
            maxLines: TELEGRAM_MAX_LINES,
            maxPlays: TELEGRAM_MAX_PLAYS,
            scopeWhitelist: TELEGRAM_SCOPE_WHITELIST,
        };
        const selectedPlays = selectPlaysForTelegram(telegramEvResults, telegramConfig, unitRules);

        if (selectedPlays.length > 0) {
            const message = formatTelegramMessage(selectedPlays, match);
            await bot.sendMessage(match.chatId || process.env.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
            const spreadIds = new Set(selectedPlays.map(play => `${matchId}::${TELEGRAM_FORMULA}::${play.selection}::${play.scope || 'total'}::${play.line}`));
            selectedPlayTracker.set(matchId, new Set([...(selectedPlayTracker.get(matchId) || []), ...spreadIds]));
        } else {
            logger.info(`Inga spel uppfyllde sändningskriterierna (EV > 0 & telegramUnitRules) för ${homeName} vs ${awayName}.`);
        }

        // --- Control Bot Logic ---
        if (controlBot && CONTROL_BOT_CHAT_ID) {
            const positiveEvLines = selectPositiveEvLines(telegramEvResults);
            const controlMessage = formatControlMessage(positiveEvLines, match);
            await controlBot.sendMessage(CONTROL_BOT_CHAT_ID, controlMessage, { parse_mode: 'Markdown' });
        }
    }

    logger.info("EV calculation per match completed.");
    await saveEvBetsToDb(db, allEvBetDocs, selectedPlayTracker);
}

const main = async () => {
  try {
    await runUnibetFetchMatches();
        // ... (rest of the function is unchanged)
    await runEvCalculation();
  } catch (error) {
    logger.error("Ett fel uppstod i EV-kalkylatorn:", error);
  } finally {
    await stopBotPollingSafely();
    await closeBrowser();
    await closeDb();
  }
};

main();
