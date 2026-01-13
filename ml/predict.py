import pandas as pd
import numpy as np
import joblib
import os
from pymongo import MongoClient
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# MongoDB connection
MONGODB_URI = os.getenv('MONGODB_URI') or os.getenv('MONGO_URI')
MONGODB_DB_NAME = os.getenv('MONGODB_DB_NAME') or os.getenv('MONGO_DB') or 'esportsbattle'

def get_db():
    client = MongoClient(MONGODB_URI)
    return client[MONGODB_DB_NAME]

def load_models():
    models = {}
    scalers = {}
    scopes = ['total', 'home', 'away', 'firstHalf']

    for scope in scopes:
        model_path = f'ml/models/{scope}_goals_model.pkl'
        scaler_path = f'ml/models/{scope}_goals_scaler.pkl'

        if os.path.exists(model_path) and os.path.exists(scaler_path):
            models[scope] = joblib.load(model_path)
            scalers[scope] = joblib.load(scaler_path)
            print(f"Loaded {scope} model")
        else:
            print(f"Model for {scope} not found")

    return models, scalers

def extract_features_for_match(home_stats, away_stats):
    """Extract features for a match, matching the training data format"""
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

    return features

def predict_goals(home_stats, away_stats):
    """Predict expected goals for all scopes"""
    models, scalers = load_models()

    if not models:
        print("No models loaded")
        return None

    # Extract features
    features = extract_features_for_match(home_stats, away_stats)

    # Load training data to get feature order
    if os.path.exists('ml/training_data.csv'):
        train_df = pd.read_csv('ml/training_data.csv')
        exclude_cols = ['goalsHome', 'goalsAway', 'totalGoals', 'firstHalfGoals', 'eventId', 'homeNick', 'awayNick']
        feature_cols = [col for col in train_df.columns if col not in exclude_cols]
    else:
        print("Training data not found, cannot determine feature order")
        return None

    # Create feature vector
    feature_vector = []
    for col in feature_cols:
        feature_vector.append(features.get(col, 0))

    X = np.array([feature_vector])

    predictions = {}

    for scope in ['total', 'home', 'away', 'firstHalf']:
        if scope in models:
            scaler = scalers[scope]
            model = models[scope]

            X_scaled = scaler.transform(X)
            pred = model.predict(X_scaled)[0]
            predictions[scope] = max(0, pred)  # Ensure non-negative
        else:
            predictions[scope] = None

    return predictions

def predict_for_match(event_id):
    """Predict goals for a specific match by eventId"""
    db = get_db()

    # Find match
    match_doc = db['unibet-matches'].find_one({'event.id': event_id})
    if not match_doc:
        print(f"Match {event_id} not found")
        return None

    match_info = match_doc['event']
    home_name = match_info['homeName']
    away_name = match_info['awayName']

    # Extract player nicks
    home_nick = home_name.split('(')[-1].rstrip(')') if '(' in home_name else home_name
    away_nick = away_name.split('(')[-1].rstrip(')') if '(' in away_name else away_name

    # Get player stats
    from pymongo import MongoClient
    player_stats_col = db.player_stats

    home_stats = player_stats_col.find_one({'playerNick': home_nick, 'source': 'esportsbattle'})
    away_stats = player_stats_col.find_one({'playerNick': away_nick, 'source': 'esportsbattle'})

    if not home_stats or not away_stats:
        print(f"Stats not found for {home_nick} vs {away_nick}")
        return None

    predictions = predict_goals(home_stats, away_stats)
    return predictions

if __name__ == '__main__':
    # Example usage
    if len(os.sys.argv) > 1:
        event_id = os.sys.argv[1]
        predictions = predict_for_match(event_id)
        if predictions:
            print(f"Predictions for {event_id}:")
            for scope, pred in predictions.items():
                print(f"  {scope}: {pred:.2f}")
    else:
        print("Usage: python predict.py <event_id>")