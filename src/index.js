import { closeBrowser } from "./utils/browser.js";
import * as logger from "./utils/logger.js";
import { closeDb } from "./db/mongoClient.js";
import { runUnibetFetchMatches } from "./services/unibetFetchMatches.js";

const main = async () => {
  try {
    await runUnibetFetchMatches();
  } catch (error) {
    logger.error("Ett fel uppstod:", error);
  } finally {
    await closeBrowser();
    await closeDb();
  }
};

main();
