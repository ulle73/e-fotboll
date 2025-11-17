import { closeBrowser } from "./utils/browser.js";
import * as logger from "./utils/logger.js";
import { closeDb } from "./db/mongoClient.js";
import { runUnibetFetchMatches } from "./services/unibetFetchMatches.js";

// TODO: Implement EV calculation logic here
const calculateEvPerMatch = async () => {
  logger.info("Starting EV calculation per match...");
  // This function will need to:
  // 1. Read Unibet matches and odds from MongoDB.
  // 2. Fetch relevant statistics (e.g., player stats from esb_player_stats collection).
  // 3. Perform EV calculation for each match.
  // 4. Store the calculated EV in a new MongoDB collection or update existing match records.
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
