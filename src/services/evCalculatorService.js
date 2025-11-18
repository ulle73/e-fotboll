// src/services/evCalculatorService.js
import * as logger from '../utils/logger.js';
import { poissonOverProbability, poissonUnderProbability } from '../utils/poisson.js';
import { calculateExpectedGoals, pickLambdaForScope } from '../utils/evFormulas.js';

// Lista över criterion.id som ska behandlas (lägg till/ta bort vid behov)
const ALLOWED_CRITERION_IDS = [1001159926, 1001159633, 1001159967];
const ALLOWED_BETOFFERTYPE_IDS = [6];

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

  const expectedGoals = calculateExpectedGoals(homePlayerStats, awayPlayerStats);

  const evResults = [];

  if (!odds || !Array.isArray(odds.odds?.betOffers)) {
    logger.warn(`[EV Service] Inga betOffers hittades för match ${matchId}.`);
    return evResults;
  }

  for (const betOffer of odds.odds.betOffers) {
    const isTotalGoalsMarket =
      ALLOWED_CRITERION_IDS.includes(betOffer.criterion?.id) &&
      ALLOWED_BETOFFERTYPE_IDS.includes(betOffer.betOfferType?.id);

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

    // Bestäm om marknaden avser home/away/total beroende på criterion-label
    const criterionLabelRaw = betOffer.criterion?.label || betOffer.criterion?.englishLabel || '';
    const label = `${betOffer.criterion?.englishLabel || ''} ${betOffer.criterion?.label || ''}`.toLowerCase();
    let scope = 'total';
    if (label.includes(homeName.toLowerCase())) {
      scope = 'home';
    } else if (label.includes(awayName.toLowerCase())) {
      scope = 'away';
    }

    const lambda = pickLambdaForScope(scope, expectedGoals);

    // Beräkna sannolikheter med Poisson
    // P(X > line) = 1 - P(X <= line)
    const probOver = poissonOverProbability(Math.floor(line), lambda);
    // P(X < line) = P(X <= line - 1)
    const probUnder = poissonUnderProbability(Math.ceil(line), lambda);

    // Beräkna Expected Value (EV)
    const evOver = (probOver * overOdds) - 1;
    const evUnder = (probUnder * underOdds) - 1;

    evResults.push({
      line,
      overOdds,
      underOdds,
      scope,
      criterionLabel: criterionLabelRaw || scope,
      probOver,
      probUnder,
      evOver,
      evUnder,
      expectedGoals,
    });
  }

  return evResults;
};
