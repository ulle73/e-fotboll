/**
 * Beräknar förväntade mål för respektive lag och totalt baserat på
 * gjorda och insläppta mål.
 *
 * Förväntade mål home: (homeGF + awayGA) / 2
 * Förväntade mål away: (awayGF + homeGA) / 2
 * Total: home + away
 */
export const calculateExpectedGoals = (homeStats, awayStats) => {
  const gfHome = homeStats?.weighted?.raz_optimal?.avgGoalsFor ?? 0;
  const gaHome = homeStats?.weighted?.raz_optimal?.avgGoalsAgainst ?? 0;
  const gfAway = awayStats?.weighted?.raz_optimal?.avgGoalsFor ?? 0;
  const gaAway = awayStats?.weighted?.raz_optimal?.avgGoalsAgainst ?? 0;

  const fhGfHome =
    homeStats?.weighted?.raz_optimal?.firstHalfAvgGoalsFor ?? homeStats?.firstHalfAvgGoalsFor ?? 0;
  const fhGaHome =
    homeStats?.weighted?.raz_optimal?.firstHalfAvgGoalsAgainst ??
    homeStats?.firstHalfAvgGoalsAgainst ??
    0;
  const fhGfAway =
    awayStats?.weighted?.raz_optimal?.firstHalfAvgGoalsFor ?? awayStats?.firstHalfAvgGoalsFor ?? 0;
  const fhGaAway =
    awayStats?.weighted?.raz_optimal?.firstHalfAvgGoalsAgainst ??
    awayStats?.firstHalfAvgGoalsAgainst ??
    0;

  const expectedHome = (gfHome + gaAway) / 2;
  const expectedAway = (gfAway + gaHome) / 2;
  const total = expectedHome + expectedAway;
  const expectedHomeFirstHalf = (fhGfHome + fhGaAway) / 2;
  const expectedAwayFirstHalf = (fhGfAway + fhGaHome) / 2;
  const totalFirstHalf = expectedHomeFirstHalf + expectedAwayFirstHalf;

  return {
    expectedHome,
    expectedAway,
    total,
    expectedHomeFirstHalf,
    expectedAwayFirstHalf,
    totalFirstHalf,
  };
};

export const pickLambdaForScope = (scope, expectedGoals) => {
  if (scope === 'home') return expectedGoals.expectedHome;
  if (scope === 'away') return expectedGoals.expectedAway;
  if (scope === 'firstHalf') return expectedGoals.totalFirstHalf ?? expectedGoals.total;
  return expectedGoals.total;
};
