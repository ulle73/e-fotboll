import { closeBrowser } from "./utils/browser.js";
import * as logger from "./utils/logger.js";
import { closeDb } from "./db/mongoClient.js";
import { runUnibetFetchMatches } from "./services/unibetFetchMatches.js";
import { main as fetchAllPlayers } from "./esb/fetchAllPlayers.js";
import { main as fetchRawMatches } from "./esb/fetchRawMatches.js";
import { main as normalizeMatches } from "./esb/normalizeMatches.js";
import { main as buildPlayerStats } from "./esb/buildPlayerStats.js";

const main = async () => {
  try {
    await runUnibetFetchMatches();
    await Promise.all([fetchAllPlayers(), fetchRawMatches()]);
    await normalizeMatches();
    await buildPlayerStats();
  } catch (error) {
    logger.error("Ett fel uppstod:", error);
  } finally {
    await closeBrowser();
    await closeDb();
  }
};

main();
