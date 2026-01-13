import os
import pandas as pd
import numpy as np
from pymongo import MongoClient
from dotenv import load_dotenv
from datetime import datetime, timedelta

# Load environment variables
load_dotenv()

# MongoDB connection
MONGODB_URI = os.getenv('MONGODB_URI') or os.getenv('MONGO_URI')
MONGODB_DB_NAME = os.getenv('MONGODB_DB_NAME') or os.getenv('MONGO_DB') or 'esportsbattle'

def get_db():
    client = MongoClient(MONGODB_URI)
    return client[MONGODB_DB_NAME]

def prepare_training_data():
    db = get_db()

    # Check available collections
    collections = db.list_collection_names()
    print(f"Available collections: {collections}")

    # Use esb_matches collection which contains the actual match results
    print("Using esb_matches collection for training data")

    # Get completed matches with goals
    esb_matches = list(db['esb_matches'].find({
        'source': 'esportsbattle',
        'goalsHome': {'$exists': True},
        'goalsAway': {'$exists': True}
    }))
    print(f"Found {len(esb_matches)} esb matches with goals")

    if not esb_matches:
        print("No esb matches with goals found.")
        print("Check that matches have been scraped and have goalsHome/goalsAway fields.")
        return pd.DataFrame()

    # Print sample document
    print("Sample esb match document:")
    sample = esb_matches[0]
    print(sample)
    print("Available fields:", list(sample.keys()))

    # Convert to DataFrame
    results_df = pd.DataFrame(esb_matches)

    # Rename columns to match expected format
    results_df = results_df.rename(columns={
        'goalsHome': 'goalsHome',
        'goalsAway': 'goalsAway',
        'homePlayerNick': 'homeNick',
        'awayPlayerNick': 'awayNick'
    })

    # Add eventId if missing (we'll use esbMatchId or create one)
    if 'eventId' not in results_df.columns:
        results_df['eventId'] = results_df.get('esbMatchId', results_df.index)

    print(f"Matches with data: {len(results_df)}")

    # Filter matches with complete goal data
    results_df = results_df.dropna(subset=['goalsHome', 'goalsAway'])
    results_df['totalGoals'] = results_df['goalsHome'] + results_df['goalsAway']

    # Calculate first half goals from prevPeriodsScores
    results_df['firstHalfGoals'] = (
        results_df.get('prevPeriodsScoresHome', 0).fillna(0) +
        results_df.get('prevPeriodsScoresAway', 0).fillna(0)
    )

    print(f"Matches with complete data: {len(results_df)}")

    # Get player stats
    player_stats = list(db.player_stats.find({'source': 'esportsbattle'}))
    stats_df = pd.DataFrame(player_stats)
    print(f"Found {len(player_stats)} player stats records")

    # Create a mapping of player nick to latest stats
    # For simplicity, use the most recent stats for each player
    stats_df['createdAt'] = pd.to_datetime(stats_df.get('createdAt', pd.Timestamp.now()))
    stats_df = stats_df.sort_values('createdAt').drop_duplicates('playerNick', keep='last')

    # Create features for each match
    training_data = []

    for _, match in results_df.iterrows():
        home_nick = match['homeNick']
        away_nick = match['awayNick']

        # Get stats for both players
        home_stats = stats_df[stats_df['playerNick'] == home_nick]
        away_stats = stats_df[stats_df['playerNick'] == away_nick]

        if home_stats.empty or away_stats.empty:
            continue

        home_stats = home_stats.iloc[0]
        away_stats = away_stats.iloc[0]

        # Extract features
        features = {}

        # Home player features
        for key in ['avgGoalsFor', 'avgGoalsAgainst', 'totalMatches', 'firstHalfAvgGoalsFor', 'firstHalfAvgGoalsAgainst']:
            features[f'home_{key}'] = home_stats.get(key, 0)

        # Away player features
        for key in ['avgGoalsFor', 'avgGoalsAgainst', 'totalMatches', 'firstHalfAvgGoalsFor', 'firstHalfAvgGoalsAgainst']:
            features[f'away_{key}'] = away_stats.get(key, 0)

        # Weighted stats if available
        if 'weighted' in home_stats and 'raz_optimal' in home_stats['weighted']:
            weighted_home = home_stats['weighted']['raz_optimal']
            features['home_weighted_avgGoalsFor'] = weighted_home.get('avgGoalsFor', features['home_avgGoalsFor'])
            features['home_weighted_avgGoalsAgainst'] = weighted_home.get('avgGoalsAgainst', features['home_avgGoalsAgainst'])

        if 'weighted' in away_stats and 'raz_optimal' in away_stats['weighted']:
            weighted_away = away_stats['weighted']['raz_optimal']
            features['away_weighted_avgGoalsFor'] = weighted_away.get('avgGoalsFor', features['away_avgGoalsFor'])
            features['away_weighted_avgGoalsAgainst'] = weighted_away.get('avgGoalsAgainst', features['away_avgGoalsAgainst'])

        # Recent form if available
        if 'last8' in home_stats:
            features['home_last8_avgGoalsFor'] = home_stats['last8'].get('avgGoalsFor', features['home_avgGoalsFor'])
        if 'last8' in away_stats:
            features['away_last8_avgGoalsFor'] = away_stats['last8'].get('avgGoalsFor', features['away_avgGoalsFor'])

        # League averages
        league_avg = home_stats.get('leagueAverages', {'avgTotalGoals': 3.5, 'avgHomeGoals': 1.75, 'avgAwayGoals': 1.75})
        features['league_avgTotalGoals'] = league_avg.get('avgTotalGoals', 3.5)
        features['league_avgHomeGoals'] = league_avg.get('avgHomeGoals', 1.75)
        features['league_avgAwayGoals'] = league_avg.get('avgAwayGoals', 1.75)

        # Targets
        first_half_home = match.get('prevPeriodsScoresHome', 0) or 0
        first_half_away = match.get('prevPeriodsScoresAway', 0) or 0

        targets = {
            'goalsHome': match['goalsHome'],
            'goalsAway': match['goalsAway'],
            'totalGoals': match['totalGoals'],
            'firstHalfGoals': first_half_home + first_half_away
        }

        # Combine
        row = {**features, **targets, 'eventId': match.get('eventId', match.get('esbMatchId', str(match.name))), 'homeNick': home_nick, 'awayNick': away_nick}
        training_data.append(row)

    # Create DataFrame
    df = pd.DataFrame(training_data)
    print(f"Prepared {len(df)} training samples")

    if len(df) == 0:
        print("No training data could be prepared. Check that:")
        print("1. Match results exist with goalsHome/goalsAway fields")
        print("2. Player stats exist for the players in those matches")
        print("3. Player names can be extracted from match data")
        return df

    # Save to CSV
    df.to_csv('training_data.csv', index=False)
    print("Saved training data to training_data.csv")

    return df

if __name__ == '__main__':
    prepare_training_data()