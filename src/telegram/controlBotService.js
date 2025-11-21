import { formatLocalDateTime } from '../utils/time.js';
import { buildUnibetEventUrl } from '../utils/unibetLinks.js';

/**
 * Selects all lines with a positive EV from the calculation results.
 * @param {Array} telegramEvResults - The array of EV results for a match.
 * @returns {Array} An array of plays with positive EV.
 */
export function selectPositiveEvLines(telegramEvResults) {
    const positiveEvPlays = [];

    telegramEvResults.forEach(result => {
        const { line, overOdds, underOdds, probOver, probUnder, evOver, evUnder, criterionLabel, scope } = result;

        // Check for positive EV on the "Over" bet
        if (evOver > 0) {
            positiveEvPlays.push({
                label: `⬆️ Over ${line}`,
                selection: 'Over',
                line,
                odds: overOdds,
                trueOdds: probOver > 0 ? (1 / probOver).toFixed(2) : 'N/A',
                ev: `${(evOver * 100).toFixed(2)}%`,
                scopeLabel: criterionLabel || scope,
            });
        }

        // Check for positive EV on the "Under" bet
        if (evUnder > 0) {
            positiveEvPlays.push({
                label: `⬇️ Under ${line}`,
                selection: 'Under',
                line,
                odds: underOdds,
                trueOdds: probUnder > 0 ? (1 / probUnder).toFixed(2) : 'N/A',
                ev: `${(evUnder * 100).toFixed(2)}%`,
                scopeLabel: criterionLabel || scope,
            });
        }
    });

    // Sort by EV descending
    return positiveEvPlays.sort((a, b) => parseFloat(b.ev) - parseFloat(a.ev));
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
