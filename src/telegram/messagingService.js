import fs from 'fs/promises';
import * as logger from '../utils/logger.js';
import { formatLocalDateTime } from '../utils/time.js';
import { buildUnibetEventUrl } from '../utils/unibetLinks.js';

// --- Config Loading & Unit Logic ---

const TELEGRAM_RULES_PATH = new URL('../../config/telegramUnitRules.json', import.meta.url);

function resolveNumber(value, fallback = null) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export async function loadTelegramUnitRules() {
  try {
    const raw = await fs.readFile(TELEGRAM_RULES_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logger.warn(`Kunde inte läsa telegramUnitRules.json: ${err.message}`);
    return [];
  }
}

function pickTelegramUnit(odds, evValue, unitRules) {
  const numericOdds = Number(odds);
  const numericEv = Number(evValue);
  if (!Number.isFinite(numericOdds) || !Number.isFinite(numericEv)) return null;

  for (const rule of unitRules) {
    const minOdds = resolveNumber(rule.minOdds, -Infinity);
    const maxOdds = resolveNumber(rule.maxOdds, Infinity);
    const minEv = resolveNumber(rule.minEv, 0);
    const maxEv = resolveNumber(rule.maxEv, Infinity);
    if (
      numericOdds >= minOdds &&
      numericOdds <= maxOdds &&
      numericEv >= minEv &&
      numericEv <= maxEv
    ) {
      const unit = Number(rule.unit);
      return Number.isFinite(unit) ? unit : null;
    }
  }
  return null;
}

function formatUnitLabel(unit) {
  if (!Number.isFinite(unit)) return '';
  const rounded =
    Number.isInteger(unit) ? unit.toFixed(0) : unit.toFixed(2).replace(/\.?0+$/, '');
  return `${rounded}u`;
}

// --- Play Selection & Formatting ---

function escapeMarkdown(text = '') {
    return text; // Assuming no real escaping is needed as per original file
}

/**
 * Filters and selects the best plays to be sent to Telegram.
 */
export function selectPlaysForTelegram(telegramEvResults, config, unitRules) {
    const { maxLines, maxPlays, scopeWhitelist } = config;
    const asPercent = (value) => `${((value ?? 0) * 100).toFixed(2)}%`;
    const formatTrueOdds = (prob) => (prob > 0 ? (1 / prob).toFixed(2) : 'N/A');

    // 1. Filter by scope FIRST
    const allowedScopeResults = telegramEvResults.filter(result => 
        scopeWhitelist.has((result.scope || '').toLowerCase())
    );

    // 2. Prioritize and Slice the filtered results
    const prioritizedResults = allowedScopeResults
        .sort((a, b) => {
            const scoreA = Math.max(a.evOver ?? -Infinity, a.evUnder ?? -Infinity);
            const scoreB = Math.max(b.evOver ?? -Infinity, b.evUnder ?? -Infinity);
            return scoreB - scoreA || (Number(a.line) || 0) - (Number(b.line) || 0);
        })
        .slice(0, maxLines);

    const plays = [];
    prioritizedResults.forEach((result) => {
        const { line, overOdds, underOdds, probOver, probUnder, evOver, evUnder, criterionLabel, scope } = result;
        const overUnit = pickTelegramUnit(overOdds, evOver, unitRules);
        const underUnit = pickTelegramUnit(underOdds, evUnder, unitRules);

        // No longer need scopeAllowed check here as it's done above
        if (overUnit !== null) {
            plays.push({
                label: `⬆️ Over ${line}`,
                line,
                odds: overOdds,
                trueOdds: formatTrueOdds(probOver),
                ev: asPercent(evOver),
                scopeLabel: escapeMarkdown(criterionLabel || ''),
                scope: scope || 'total',
                selection: 'over',
                rawEv: evOver,
                rawOdds: overOdds,
                unit: overUnit,
            });
        }

        if (underUnit !== null) {
            plays.push({
                label: `⬇️ Under ${line}`,
                line,
                odds: underOdds,
                trueOdds: formatTrueOdds(probUnder),
                ev: asPercent(evUnder),
                scopeLabel: escapeMarkdown(criterionLabel || ''),
                scope: scope || 'total',
                selection: 'under',
                rawEv: evUnder,
                rawOdds: underOdds,
                unit: underUnit,
            });
        }
    });

    if (!plays.length) return [];

    const playMap = new Map();
    plays.forEach((play) => {
        const key = `${play.selection}::${play.scope || 'total'}::${play.line}`;
        const existing = playMap.get(key);
        if (!existing || Number(play.rawEv) > Number(existing.rawEv)) {
            playMap.set(key, play);
        }
    });

    const prioritizedPlays = Array.from(playMap.values()).sort((a, b) => (Number(b.rawEv) || 0) - (Number(a.rawEv) || 0));

    const baseSelection = prioritizedPlays.slice(0, maxPlays);
    const extraSelections = prioritizedPlays
        .slice(maxPlays)
        .filter((play) => (Number(play.rawOdds) || 0) > 5 && (Number(play.rawEv) || 0) > 1);

    return [...baseSelection, ...extraSelections];
}

/**
 * Formats the Telegram message for a given match and its selected plays.
 */
export function formatTelegramMessage(selectedPlays, match) {
    const { homeName, awayName, start, id } = match.event;
    const kickoffDate = new Date(start);
    const eventUrl = buildUnibetEventUrl(id);

    let matchSummaryMessage = `\n
⏰  ${formatLocalDateTime(kickoffDate)}

⚽️  ${homeName} vs ${awayName}

`;

    const messageSections = selectedPlays.map((play) => {
        const unitLine = formatUnitLabel(play.unit);
        const lines = [
          play.label,
          `🏷️  ${play.scopeLabel}`,
          `🎲  Odds: ${play.odds}`,
        ];
        if (unitLine) {
            lines.push(`💰  Unit: ${unitLine}`);
        }
        return lines.join('\n');
    });

    matchSummaryMessage += messageSections.join('\n\n');

//     if (eventUrl) {
//         matchSummaryMessage += `
// 🔗  ${eventUrl}`;
//     }
    return matchSummaryMessage;
}
