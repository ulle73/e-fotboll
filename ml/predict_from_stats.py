import json
import sys
import os
import pandas as pd
import numpy as np
import joblib

def predict_from_stats(stats_file):
    # Load stats
    with open(stats_file, 'r') as f:
        data = json.load(f)

    home_stats = data['homeStats']
    away_stats = data['awayStats']

    # Load models
    models = {}
    scalers = {}
    scopes = ['total', 'home', 'away', 'firstHalf']

    for scope in scopes:
        model_path = f'ml/models/{scope}_goals_model.pkl'
        scaler_path = f'ml/models/{scope}_goals_scaler.pkl'

        if os.path.exists(model_path) and os.path.exists(scaler_path):
            models[scope] = joblib.load(model_path)
            scalers[scope] = joblib.load(scaler_path)

    if not models:
        print("No models available")
        return

    # Extract features (same as in predict.py)
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

    # Load training data to get feature order
    if os.path.exists('ml/training_data.csv'):
        train_df = pd.read_csv('ml/training_data.csv')
        exclude_cols = ['goalsHome', 'goalsAway', 'totalGoals', 'firstHalfGoals', 'eventId', 'homeNick', 'awayNick']
        feature_cols = [col for col in train_df.columns if col not in exclude_cols]
    else:
        print("Training data not found")
        return

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
            predictions[scope] = max(0, float(pred))
        else:
            # Fallback values
            if scope == 'total':
                predictions[scope] = 3.5
            elif scope in ['home', 'away']:
                predictions[scope] = 1.75
            else:  # firstHalf
                predictions[scope] = 1.4

    # Output JSON
    print(json.dumps(predictions))

if __name__ == '__main__':
    if len(sys.argv) > 1:
        predict_from_stats(sys.argv[1])
    else:
        print("Usage: python predict_from_stats.py <stats_json_file>")