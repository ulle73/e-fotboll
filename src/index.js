import { fetchStartingWithinData } from "./services/unibet.js";
import { closeBrowser } from "./utils/browser.js";
import * as logger from "./utils/logger.js";
import { filterEvents } from "./utils/filter.js";
import fs from "fs";
import path from "path";

const main = async () => {
  try {
    logger.info("Hämtar data från Unibet...");
    const data = await fetchStartingWithinData();

    const allowedGroups = ["Esports Battle (2x4min)"];
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
  } catch (error) {
    logger.error("Ett fel uppstod:", error);
  } finally {
    await closeBrowser();
  }
};

main();
