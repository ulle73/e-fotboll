// src/services/evCalculatorService.js
import * as logger from '../utils/logger.js';
import { poissonOverProbability, poissonUnderProbability } from '../utils/poisson.js';

/**
 * Beräknar Expected Value (EV) för en given match.
 * @param {object} match - Matchobjektet.
 * @param {object} odds - Odds för matchen.
 * @param {object} homePlayerStats - Statistik för hemmaspelaren.
 * @param {object} awayPlayerStats - Statistik för bortaspelaren.
 * @returns {object} Ett objekt med EV för över/under 2.5 mål, eller null om beräkning inte är möjlig.
 */
export const calculateEvForMatch = (match, odds, homePlayerStats, awayPlayerStats) => {
  const homeName = match.event.homeName;
  const awayName = match.event.awayName;
  const matchId = match.event.id;

  // Anta att vi använder 'weighted.raz_optimal.avgGoalsFor' som lambda för totala mål
  // Detta är en enkel uppskattning och kan förfinas
  const homeLambda = homePlayerStats.weighted.raz_optimal.avgGoalsFor;
  const awayLambda = awayPlayerStats.weighted.raz_optimal.avgGoalsFor;
  const totalLambda = homeLambda + awayLambda; // Enkel uppskattning för totala mål

  const evResults = [];

  if (!odds || !Array.isArray(odds.odds?.betOffers)) {
    logger.warn(`[EV Service] Inga betOffers hittades för match ${matchId}.`);
    return evResults;
  }

  for (const betOffer of odds.odds.betOffers) {
    const isTotalGoalsMarket =
      (betOffer.criterion?.englishLabel === 'Total Goals' || betOffer.criterion?.label === 'Totala mål') &&
      (betOffer.betOfferType?.englishName === 'Over/Under' || betOffer.betOfferType?.name === 'Över/Under');

    if (!isTotalGoalsMarket || !Array.isArray(betOffer.outcomes) || betOffer.outcomes.length !== 2) {
      continue;
    }

    const overOutcome = betOffer.outcomes.find(o => o.type === 'OT_OVER');
    const underOutcome = betOffer.outcomes.find(o => o.type === 'OT_UNDER');

    if (!overOutcome || !underOutcome) {
      logger.warn(`[EV Service] Kunde inte hitta både Över och Under utfall för betOffer ${betOffer.id} i match ${matchId}.`);
      continue;
    }

    const line = overOutcome.line / 1000; // Linan är t.ex. 4500 för 4.5 mål
    const overOdds = overOutcome.odds / 1000; // Odds är t.ex. 1240 för 1.24
    const underOdds = underOutcome.odds / 1000;

    // Beräkna sannolikheter med Poisson
    // P(X > line) = 1 - P(X <= line)
    const probOver = poissonOverProbability(Math.floor(line), totalLambda);
    // P(X < line) = P(X <= line - 1)
    const probUnder = poissonUnderProbability(Math.ceil(line), totalLambda);

    // Beräkna Expected Value (EV)
    const evOver = (probOver * overOdds) - 1;
    const evUnder = (probUnder * underOdds) - 1;

    evResults.push({
      line,
      overOdds,
      underOdds,
      probOver,
      probUnder,
      evOver,
      evUnder,
      homeLambda,
      awayLambda,
      totalLambda,
    });
  }

  return evResults;
};
