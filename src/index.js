import { fetchStartingWithinData } from "./services/unibet.js";
import { closeBrowser } from "./utils/browser.js";
import * as logger from "./utils/logger.js";
import { filterEvents } from "./utils/filter.js";
import { getDb, closeDb } from "./db/mongoClient.js";
import fs from "fs";
import path from "path";

const buildOddsUrl = (eventId) => {
  const params = new URLSearchParams({
    lang: "sv_SE",
    market: "SE",
    ncid: Date.now().toString(),
  });
  return `https://eu.offering-api.kambicdn.com/offering/v2018/ubse/betoffer/event/${eventId}.json?${params.toString()}`;
};

const fetchEventOdds = async (eventId) => {
  const url = buildOddsUrl(eventId);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for event ${eventId}`);
  }
  return res.json();
};

const main = async () => {
  try {
    logger.info("Hämtar data från Unibet...");
    const data = await fetchStartingWithinData();

    const allowedGroups = [
      'esports battle (2x4',
    ];
    const filteredData = filterEvents(data, "esports_football", allowedGroups);

    // -------------------------------
    // 📌 GENERERA DATUM & TID FÖR SNAPSHOT
    // -------------------------------
    const now = new Date();

    const datePart = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const timePart = now
      .toISOString()
      .split("T")[1]
      .replace(/:/g, "-") // HH:mm:ss → HH-mm-ss
      .replace("Z", ""); // ta bort Z

    // -------------------------------
    // 📁 BYGG MAPPSTRUKTUR
    // -------------------------------
    const baseDir = "data/matches";
    const dateDir = path.join(baseDir, datePart);

    if (!fs.existsSync(dateDir)) {
      fs.mkdirSync(dateDir, { recursive: true });
    }

    // -------------------------------
    // 📄 FILNAMN BASERAT PÅ SNAPSHOT-TIDEN
    // -------------------------------
    const filename = `${datePart}T${timePart}.json`;
    const filePath = path.join(dateDir, filename);

    // -------------------------------
    // 💾 SPARA ALLA MATCHER I EN ENDA FIL
    // -------------------------------
    fs.writeFileSync(filePath, JSON.stringify(filteredData, null, 2));

    logger.success(`Snapshot sparad: ${filePath}`);

    // -------------------------------
    // 🗄️ SPARA SNAPSHOT I MONGODB
    // -------------------------------
    const db = await getDb();
    const snapshot = {
      createdAt: now,
      snapshotTime: now,
      filePath,
      matchCount: filteredData.length,
      matches: filteredData,
      source: "unibet-startingWithin",
    };
    const { insertedId } = await db
      .collection("unibet-matches")
      .insertOne(snapshot);

    logger.success(`Snapshot sparat i MongoDB (unibet-matches): ${insertedId}`);

    // -------------------------------
    // 🎯 HÄMTA OCH SPARA ODDS FÖR VARJE MATCH
    // -------------------------------
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
      await db.collection("unibet-odds").insertMany(oddsDocs);
      logger.success(
        `Odds sparade i MongoDB (unibet-odds): ${oddsDocs.length} dokument`
      );
    } else {
      logger.info("Inga odds sparades (inga matcher eller alla misslyckades).");
    }
  } catch (error) {
    logger.error("Ett fel uppstod:", error);
  } finally {
    await closeBrowser();
    await closeDb();
  }
};

main();
