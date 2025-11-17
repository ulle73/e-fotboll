// src/services/unibetFetchMatches.js
import { fetchStartingWithinData } from "./unibet.js";
import { fetchEventOdds } from "./unibetOdds.js";
import { filterEvents } from "../utils/filter.js";
import * as logger from "../utils/logger.js";
import { insertUnibetSnapshot } from "../db/unibetMatchesRepository.js";
import { insertUnibetOddsBatch } from "../db/unibetOddsRepository.js";
import fs from "fs";
import path from "path";

export async function runUnibetFetchMatches() {
  logger.info("Hämtar data från Unibet...");
  const data = await fetchStartingWithinData();

  const allowedGroups = ["esports battle (2x4", "esports battle (2x6"];
  const filteredData = filterEvents(data, "esports_football", allowedGroups);

  const now = new Date();

  const datePart = now.toISOString().split("T")[0]; // YYYY-MM-DD
  const timePart = now
    .toISOString()
    .split("T")[1]
    .replace(/:/g, "-") // HH:mm:ss → HH-mm-ss
    .replace("Z", ""); // ta bort Z

  const baseDir = "data/matches";
  const dateDir = path.join(baseDir, datePart);

  if (!fs.existsSync(dateDir)) {
    fs.mkdirSync(dateDir, { recursive: true });
  }

  const filename = `${datePart}T${timePart}.json`;
  const filePath = path.join(dateDir, filename);

  fs.writeFileSync(filePath, JSON.stringify(filteredData, null, 2));
  logger.success(`Snapshot sparad: ${filePath}`);

  const snapshot = {
    createdAt: now,
    snapshotTime: now,
    filePath,
    matchCount: filteredData.length,
    matches: filteredData,
    source: "unibet-startingWithin",
  };
  const insertedId = await insertUnibetSnapshot(snapshot);
  logger.success(`Snapshot sparat i MongoDB (unibet-matches): ${insertedId}`);

  const oddsDocs = [];
  for (const item of filteredData) {
    const eventId = item?.event?.id;
    if (!eventId) {
      continue;
    }
    try {
      const odds = await fetchEventOdds(eventId);
      oddsDocs.push({
        snapshotId: insertedId,
        snapshotFilePath: filePath,
        snapshotTime: now,
        eventId,
        eventName: item?.event?.name || item?.event?.englishName || null,
        group: item?.event?.group || item?.event?.groupName || null,
        createdAt: now,
        source: "unibet-betoffer",
        odds,
      });
    } catch (err) {
      logger.error(`Kunde inte hämta odds för event ${eventId}:`, err.message);
    }
  }

  if (oddsDocs.length > 0) {
    const { insertedCount } = await insertUnibetOddsBatch(oddsDocs);
    logger.success(
      `Odds sparade i MongoDB (unibet-odds): ${insertedCount} dokument`
    );
  } else {
    logger.info("Inga odds sparades (inga matcher eller alla misslyckades).");
  }
}
