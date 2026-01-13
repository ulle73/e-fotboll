import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Beräknar förväntade mål för respektive lag och totalt baserat på
 * gjorda och insläppta mål.
 *
 * Förväntade mål home: (homeGF + awayGA) / 2
 * Förväntade mål away: (awayGF + homeGA) / 2
 * Total: home + away
 */
export const calculateExpectedGoals = async (homeStats, awayStats, formulaKey = 'raz_optimal') => {
  // Special handling for ML formula
  if (formulaKey === 'ml_predicted') {
    return await calculateMLFormula(homeStats, awayStats);
  }

  // Special handling for new formulas
  if (formulaKey.startsWith('new_')) {
    return calculateNewFormula(homeStats, awayStats, formulaKey);
  }

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

const calculateMLFormula = async (homeStats, awayStats) => {
  return new Promise((resolve, reject) => {
    // Create a temporary file with the stats
    const tempData = JSON.stringify({ homeStats, awayStats });
    const tempFile = join(__dirname, '../../ml/temp_stats.json');

    // Write temp file
    fs.writeFile(tempFile, tempData)

    // Call Python script
    const pythonProcess = spawn('python', ['ml/predict_from_stats.py', tempFile], {
      cwd: join(__dirname, '../..')
    });

    let output = '';
    let errorOutput = '';

    pythonProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    pythonProcess.on('close', (code) => {
      // Clean up temp file
      try {
        fs.unlink(tempFile);
      } catch (e) {
        // Ignore cleanup errors
      }

      if (code !== 0) {
        console.error('ML prediction failed:', errorOutput);
        // Fallback to raz_optimal
        resolve(calculateExpectedGoals(homeStats, awayStats, 'raz_optimal'));
        return;
      }

      try {
        const predictions = JSON.parse(output.trim());
        resolve({
          expectedHome: predictions.home || 1.75,
          expectedAway: predictions.away || 1.75,
          total: predictions.total || 3.5,
          expectedHomeFirstHalf: predictions.home * 0.4 || 0.7,
          expectedAwayFirstHalf: predictions.away * 0.4 || 0.7,
          totalFirstHalf: predictions.firstHalf || 1.4
        });
      } catch (e) {
        console.error('Failed to parse ML output:', e);
        // Fallback
        resolve(calculateExpectedGoals(homeStats, awayStats, 'raz_optimal'));
      }
    });

    pythonProcess.on('error', (error) => {
      console.error('Failed to start ML process:', error);
      // Fallback
      resolve(calculateExpectedGoals(homeStats, awayStats, 'raz_optimal'));
    });
  });
};

const calculateNewFormula = (homeStats, awayStats, formulaKey) => {
  const leagueAvg = homeStats?.leagueAverages || { avgTotalGoals: 3.5, avgHomeGoals: 1.75, avgAwayGoals: 1.75 };

  // Base stats using raz_optimal for consistency
  const homeWeighted = homeStats?.weighted?.raz_optimal || {};
  const awayWeighted = awayStats?.weighted?.raz_optimal || {};

  const gfHome = homeWeighted.avgGoalsFor || 0;
  const gaHome = homeWeighted.avgGoalsAgainst || 0;
  const gfAway = awayWeighted.avgGoalsFor || 0;
  const gaAway = awayWeighted.avgGoalsAgainst || 0;

  let expectedHome, expectedAway;

  switch (formulaKey) {
    case 'new_attack_defense':
      // Conservative adjustment to base formula using attack/defense concept
      const baseHome = (gfHome + gaAway) / 2;
      const baseAway = (gfAway + gaHome) / 2;

      // Simple attack/defense adjustment: boost if strong attack vs weak defense
      const homeAttackBonus = (gfHome - gaHome) * 0.1; // Positive if scores more than concedes
      const awayAttackBonus = (gfAway - gaAway) * 0.1;

      expectedHome = baseHome + homeAttackBonus;
      expectedAway = baseAway + awayAttackBonus;

      // Ensure non-negative and reasonable bounds
      expectedHome = Math.max(0, Math.min(expectedHome, baseHome * 2));
      expectedAway = Math.max(0, Math.min(expectedAway, baseAway * 2));
      break;

    case 'new_bayesian':
      // Bayesian adjustment with league priors
      const priorWeight = 0.2;
      const priorMatches = 10;

      const adjHomeGF = (gfHome * homeStats.totalMatches + leagueAvg.avgHomeGoals * priorMatches) /
                       (homeStats.totalMatches + priorMatches);
      const adjHomeGA = (gaHome * homeStats.totalMatches + leagueAvg.avgAwayGoals * priorMatches) /
                       (homeStats.totalMatches + priorMatches);
      const adjAwayGF = (gfAway * awayStats.totalMatches + leagueAvg.avgAwayGoals * priorMatches) /
                       (awayStats.totalMatches + priorMatches);
      const adjAwayGA = (gaAway * awayStats.totalMatches + leagueAvg.avgHomeGoals * priorMatches) /
                       (awayStats.totalMatches + priorMatches);

      expectedHome = (adjHomeGF + adjAwayGA) / 2;
      expectedAway = (adjAwayGF + adjHomeGA) / 2;
      break;

    case 'new_momentum':
      // Include recent form momentum
      const homeRecent = homeStats.last8?.avgGoalsFor || gfHome;
      const awayRecent = awayStats.last8?.avgGoalsFor || gfAway;
      const momentumFactor = 1 + ((homeRecent - gfHome) - (awayRecent - gfAway)) * 0.1;

      expectedHome = ((gfHome + gaAway) / 2) * momentumFactor;
      expectedAway = ((gfAway + gaHome) / 2) / momentumFactor;
      break;

    case 'new_quality_adjusted':
      // Adjust based on opponent quality (defense strength)
      const homeQuality = awayStats.avgGoalsAgainst / leagueAvg.avgTotalGoals; // Lower is better defense
      const awayQuality = homeStats.avgGoalsAgainst / leagueAvg.avgTotalGoals;

      expectedHome = ((gfHome + gaAway) / 2) * (2 - homeQuality); // Boost against weak opponents
      expectedAway = ((gfAway + gaHome) / 2) * (2 - awayQuality);
      break;

    default:
      // Fallback to standard calculation
      expectedHome = (gfHome + gaAway) / 2;
      expectedAway = (gfAway + gaHome) / 2;
  }

  const total = expectedHome + expectedAway;

  // For first half, use same logic but with first half stats
  const fhGfHome = homeWeighted.firstHalfAvgGoalsFor || 0;
  const fhGaHome = homeWeighted.firstHalfAvgGoalsAgainst || 0;
  const fhGfAway = awayWeighted.firstHalfAvgGoalsFor || 0;
  const fhGaAway = awayWeighted.firstHalfAvgGoalsAgainst || 0;

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
