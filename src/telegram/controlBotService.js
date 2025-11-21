import { formatLocalDateTime } from '../utils/time.js';
import { buildUnibetEventUrl } from '../utils/unibetLinks.js';

/**
 * Selects all lines with a positive EV from the calculation results.
 * @param {Array} telegramEvResults - The array of EV results for a match.
 * @returns {Array} An array of plays with positive EV.
 */
export function selectPositiveEvLines(telegramEvResults) {
    const totalPlays = [];
    const homePlays = [];
    const awayPlays = [];
    const otherPlays = [];

    telegramEvResults.forEach(result => {
        const { line, overOdds, underOdds, probOver, probUnder, evOver, evUnder, criterionLabel, scope } = result;

        const createPlayObject = (selection, ev, odds, prob) => ({
            label: `${selection === 'Over' ? '⬆️' : '⬇️'}  ${selection} ${line}`,
            selection,
            line,
            odds,
            trueOdds: prob > 0 ? (1 / prob).toFixed(2) : 'N/A',
            ev: `${(ev * 100).toFixed(2)}%`,
            scopeLabel: criterionLabel || scope,
            scope: scope,
        });

        if (evOver > 0) {
            const play = createPlayObject('Over', evOver, overOdds, probOver);
            if (play.scope === 'total') totalPlays.push(play);
            else if (play.scope === 'home') homePlays.push(play);
            else if (play.scope === 'away') awayPlays.push(play);
            else otherPlays.push(play);
        }

        if (evUnder > 0) {
            const play = createPlayObject('Under', evUnder, underOdds, probUnder);
            if (play.scope === 'total') totalPlays.push(play);
            else if (play.scope === 'home') homePlays.push(play);
            else if (play.scope === 'away') awayPlays.push(play);
            else otherPlays.push(play);
        }
    });

    const sortByLine = (a, b) => a.line - b.line;

    totalPlays.sort(sortByLine);
    homePlays.sort(sortByLine);
    awayPlays.sort(sortByLine);
    otherPlays.sort(sortByLine);

    return [...totalPlays, ...homePlays, ...awayPlays, ...otherPlays];
}

/**
 * Formats the detailed control message.
 * @param {Array} plays - The array of positive EV plays.
 * @param {object} match - The match object.
 * @returns {string} The formatted message string.
 */
export function formatControlMessage(plays, match) {
  const { homeName, awayName, start, id } = match.event;
  const kickoffDate = new Date(start);
  const eventUrl = buildUnibetEventUrl(id);

  let message = `\n`; // Leading newline
  message += `⏰  ${formatLocalDateTime(kickoffDate)}\n\n`; 
  message += `⚽️  ${homeName} vs ${awayName}  ⚽️\n\n`; 

  if (plays.length === 0) {
    message += "-------------------------\n";
    message += "_Inga positiva EV-linor hittades._";
    return message;
  }

  const playSections = plays.map((play) => {
    let section = `${play.label}\n`;
    section += `🏷️  ${play.scopeLabel}\n`;
    section += `🎲  Odds: ${play.odds}\n`;
    section += `🎯  True odds: ${play.trueOdds}\n`;
    section += `💰  EV: ${play.ev}\n`; // Removed bolding
    return section;
  });

  message += "-------------------------\n\n"; // Separator before first play
  message += playSections.join("\n-------------------------\n\n"); // Join with separator and extra newlines

  if (eventUrl) {
    message += "\n-------------------------\n"; // Separator before link
    message += `🔗 ${eventUrl}`;
  }

  return message;
}
