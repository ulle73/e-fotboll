import { calculateEvForMatch } from './evCalculatorService.js';
import { nowIso } from '../esb/utils.js';

/**
 * Calculates EV for all specified formulas for a single match.
 */
export function calculateAllEvsForMatch(matchData, formulas, telegramFormula) {
    const { match, odds, homePlayerStats, awayPlayerStats } = matchData;
    const allEvResults = [];
    let telegramEvResults = [];

    for (const formula of formulas) {
        const evResults = calculateEvForMatch(match, odds, homePlayerStats, awayPlayerStats, formula);
        if (evResults && evResults.length) {
            allEvResults.push(...evResults);
        }
        if (formula === telegramFormula) {
            telegramEvResults = evResults || [];
        }
    }
    return { allEvResults, telegramEvResults };
}

/**
 * Prepares the documents for backtesting based on EV results.
 */
export function prepareBacktestingDocs(evResults, match, odds) {
    const { id: eventId, name, homeName, awayName, start } = match.event;
    const now = nowIso();

    return evResults.map(res => {
        const baseDoc = {
            eventId,
            eventName: name || `${homeName} - ${awayName}`,
            homeName,
            awayName,
            kickoff: start,
            snapshotId: odds.snapshotId || null,
            snapshotTime: odds.snapshotTime || null,
            snapshotTimeUtc: odds.snapshotTimeUtc || null,
            snapshotFilePath: odds.snapshotFilePath || null,
            formula: res.formula,
            line: res.line,
            scope: res.scope,
            criterionLabel: res.criterionLabel,
            expectedGoals: res.expectedGoals,
            result: null,
            settled: false,
            source: 'unibet',
            createdAt: now,
            spread: false,
        };

        const overBet = {
            ...baseDoc,
            selection: 'over',
            offeredOdds: res.overOdds,
            trueOdds: res.probOver > 0 ? (1 / res.probOver).toFixed(2) : null,
            probability: res.probOver,
            ev: res.evOver,
        };

        const underBet = {
            ...baseDoc,
            selection: 'under',
            offeredOdds: res.underOdds,
            trueOdds: res.probUnder > 0 ? (1 / res.probUnder).toFixed(2) : null,
            probability: res.probUnder,
            ev: res.evUnder,
        };

        return [overBet, underBet];
    }).flat();
}
