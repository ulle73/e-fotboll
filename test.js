
// src/debug/scrapeTotalCorner.js
import puppeteer from "puppeteer";

const MATCH_URL =
  "https://www.totalcorner.com/stats/Man-City-%28Koftovsky%29-vs-Arsenal-%28tonexo%29/184881148";

async function scrapeLivePanel(page) {
  return await page.evaluate(() => {
    // Hitta panelen med "Live Events" i heading
    const panelHeadings = Array.from(document.querySelectorAll(".panel-heading"));
    const panelHeading = panelHeadings.find((el) =>
      el.textContent.trim().includes("Live Events")
    );

    if (!panelHeading) {
      console.warn("Hittade ingen 'Live Events'-panel");
      return null;
    }

    const panel = panelHeading.closest(".panel");
    const panelBody = panel.querySelector(".panel-body");

    // --- 1) Grundinfo: status, score, corner ---
    const pTags = Array.from(panelBody.children).filter((el) => el.tagName === "P");
    const firstP = pTags[0];
    const secondP = pTags[1];

    const firstPText = firstP.textContent.replace(/\s+/g, " ").trim();
    const secondPText = secondP.textContent.replace(/\s+/g, " ").trim();

    // Status-minut
    const statusSpan = firstP.querySelector("span.red")?.textContent.trim() || "";

    // Score: 3 - 3
    const scoreMatch = firstPText.match(/Score:\s*([\d]+)\s*-\s*([\d]+)/i);
    const scoreHome = scoreMatch ? parseInt(scoreMatch[1], 10) : null;
    const scoreAway = scoreMatch ? parseInt(scoreMatch[2], 10) : null;

    // Corner: 2 - 4
    const cornerMatch = firstPText.match(/Corner:\s*([\d]+)\s*-\s*([\d]+)/i);
    const cornerHome = cornerMatch ? parseInt(cornerMatch[1], 10) : null;
    const cornerAway = cornerMatch ? parseInt(cornerMatch[2], 10) : null;

    // Handicap, Goals från andra <p>
    const handicapMatch = secondPText.match(/Handicap:\s*([^,]+)/i);
    const goalsMatch = secondPText.match(/Goals:\s*([0-9.]+)/i);

    const handicap = handicapMatch ? handicapMatch[1].trim() : null;
    const goalLine = goalsMatch ? parseFloat(goalsMatch[1]) : null;

    // --- 2) Stats-barerna (Shoot on target, Shoot off target, Attack, Dangerous Attack) ---
    const scoreBarItems = Array.from(panelBody.querySelectorAll(".score-bar-item"));

    const stats = scoreBarItems.map((el) => {
      const row = el.querySelector(".row");
      const leftVal = row.querySelector(".small-2.text-left")?.textContent.trim() || "";
      const label = row.querySelector(".small-6.text-center")?.textContent.trim() || "";
      const rightVal = row.querySelector(".small-2.text-right")?.textContent.trim() || "";

      return {
        label, // t.ex. "Shoot on target"
        home: leftVal === "" ? null : Number(leftVal),
        away: rightVal === "" ? null : Number(rightVal),
      };
    });

    // --- 3) Händelselistan (mål, hörnor, osv) ---
    const events = [];
    const eventLis = Array.from(panel.querySelectorAll("ul.list-group li.list-group-item"));

    eventLis.forEach((li) => {
      const img = li.querySelector("img");
      const textRaw = li.textContent.replace(/\s+/g, " ").trim();

      const iconSrc = img?.src || "";

      let eventType = "other";
      if (iconSrc.includes("goal.png")) eventType = "goal";
      else if (iconSrc.includes("corner.png")) eventType = "corner";

      // Försök plocka ut "minut" och beskrivning:
      // Ex: "1' - 1st Goal - FC Salzburg (Hyper)"
      let minute = null;
      let description = textRaw;

      const minuteMatch = textRaw.match(/^([^'-]+['’][^-\s]*)\s*-\s*(.*)$/);
      if (minuteMatch) {
        minute = minuteMatch[1].trim(); // t.ex. "1'"
        description = minuteMatch[2].trim();
      }

      events.push({
        type: eventType,
        minute,
        description,
        iconSrc,
      });
    });

    return {
      status: statusSpan, // t.ex "8 '"
      score: {
        home: scoreHome,
        away: scoreAway,
      },
      corners: {
        home: cornerHome,
        away: cornerAway,
      },
      handicap,
      goalLine,
      stats, // array med Shoot on/off target, Attack, Dangerous Attack
      events, // händelselista
    };
  });
}

async function main() {
  try {
    console.log("Startar browser...");
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    // Lite "snällt" user-agent så vi ser ut som en vanlig browser
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    );

    console.log("Navigerar till sidan...");
    await page.goto(MATCH_URL, { waitUntil: "networkidle2" });

    console.log("Parsar live-data...");
    const data = await scrapeLivePanel(page);

    console.dir(data, { depth: null });

    await browser.close();
  } catch (err) {
    console.error("Fel vid scraping:", err.message);
  }
}

main();
