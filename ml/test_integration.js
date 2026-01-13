// Quick test to verify ML integration
import { calculateExpectedGoals } from '../src/utils/evFormulas.js';

// Mock player stats
const mockHomeStats = {
  avgGoalsFor: 2.0,
  avgGoalsAgainst: 1.5,
  totalMatches: 10,
  weighted: {
    raz_optimal: {
      avgGoalsFor: 2.1,
      avgGoalsAgainst: 1.4,
      firstHalfAvgGoalsFor: 1.0,
      firstHalfAvgGoalsAgainst: 0.7
    }
  },
  leagueAverages: {
    avgTotalGoals: 3.5,
    avgHomeGoals: 1.75,
    avgAwayGoals: 1.75
  }
};

const mockAwayStats = {
  avgGoalsFor: 1.8,
  avgGoalsAgainst: 1.6,
  totalMatches: 12,
  weighted: {
    raz_optimal: {
      avgGoalsFor: 1.9,
      avgGoalsAgainst: 1.5,
      firstHalfAvgGoalsFor: 0.9,
      firstHalfAvgGoalsAgainst: 0.8
    }
  },
  leagueAverages: {
    avgTotalGoals: 3.5,
    avgHomeGoals: 1.75,
    avgAwayGoals: 1.75
  }
};

async function testFormulas() {
  console.log('Testing formula integration...\n');

  const formulas = ['raz_optimal', 'ml_predicted'];

  for (const formula of formulas) {
    try {
      console.log(`Testing ${formula}:`);
      const result = await calculateExpectedGoals(mockHomeStats, mockAwayStats, formula);
      console.log(`  Total: ${result.total.toFixed(2)}`);
      console.log(`  Home: ${result.expectedHome.toFixed(2)}`);
      console.log(`  Away: ${result.expectedAway.toFixed(2)}`);
      console.log(`  First Half: ${result.totalFirstHalf.toFixed(2)}`);
      console.log('');
    } catch (error) {
      console.error(`Error with ${formula}:`, error.message);
    }
  }
}

testFormulas();