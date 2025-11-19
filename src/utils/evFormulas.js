/**
 * Beräknar förväntade mål för respektive lag och totalt baserat på
 * gjorda och insläppta mål.
 *
 * Förväntade mål home: (homeGF + awayGA) / 2
 * Förväntade mål away: (awayGF + homeGA) / 2
 * Total: home + away
 */
export const calculateExpectedGoals = (homeStats, awayStats, formulaKey = 'raz_optimal') => {
  const pickSet = (stats, key) => {
    const weighted = stats?.weighted?.[key];
    return {
      gf: weighted?.avgGoalsFor ?? stats?.avgGoalsFor ?? 0,
      ga: weighted?.avgGoalsAgainst ?? stats?.avgGoalsAgainst ?? 0,
      fhGf:
        weighted?.firstHalfAvgGoalsFor ??
        stats?.weighted?.raz_optimal?.firstHalfAvgGoalsFor ??
        stats?.firstHalfAvgGoalsFor ??
        0,
      fhGa:
        weighted?.firstHalfAvgGoalsAgainst ??
        stats?.weighted?.raz_optimal?.firstHalfAvgGoalsAgainst ??
        stats?.firstHalfAvgGoalsAgainst ??
        0,
    };
  };

  const homeSet = pickSet(homeStats, formulaKey);
  const awaySet = pickSet(awayStats, formulaKey);
  const gfHome = homeSet.gf;
  const gaHome = homeSet.ga;
  const gfAway = awaySet.gf;
  const gaAway = awaySet.ga;

  const fhGfHome = homeSet.fhGf;
  const fhGaHome = homeSet.fhGa;
  const fhGfAway = awaySet.fhGf;
  const fhGaAway = awaySet.fhGa;

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
