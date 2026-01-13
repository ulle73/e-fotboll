import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import mean_absolute_error, mean_squared_error
import xgboost as xgb
import joblib
import os

def train_models():
    # Load data
    df = pd.read_csv('training_data.csv')
    print(f"Loaded {len(df)} samples")

    # Define feature columns (exclude targets and IDs)
    exclude_cols = ['goalsHome', 'goalsAway', 'totalGoals', 'firstHalfGoals', 'eventId', 'homeNick', 'awayNick']
    feature_cols = [col for col in df.columns if col not in exclude_cols]

    print(f"Using {len(feature_cols)} features: {feature_cols[:10]}...")

    # Fill NaN values
    df = df.fillna(0)

    # Define targets
    targets = {
        'total': 'totalGoals',
        'home': 'goalsHome',
        'away': 'goalsAway',
        'firstHalf': 'firstHalfGoals'
    }

    # Create models directory
    os.makedirs('ml/models', exist_ok=True)

    models = {}
    scalers = {}

    for scope, target_col in targets.items():
        print(f"\nTraining model for {scope} goals...")

        # Prepare data
        X = df[feature_cols]
        y = df[target_col]

        # Remove samples with NaN targets
        valid_idx = ~y.isna()
        X = X[valid_idx]
        y = y[valid_idx]

        print(f"Valid samples for {scope}: {len(X)}")

        if len(X) < 100:
            print(f"Skipping {scope} due to insufficient data")
            continue

        # Split data
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

        # Scale features
        scaler = StandardScaler()
        X_train_scaled = scaler.fit_transform(X_train)
        X_test_scaled = scaler.transform(X_test)

        # Train XGBoost model
        model = xgb.XGBRegressor(
            n_estimators=100,
            max_depth=6,
            learning_rate=0.1,
            random_state=42,
            n_jobs=-1
        )

        model.fit(X_train_scaled, y_train)

        # Evaluate
        y_pred = model.predict(X_test_scaled)
        mae = mean_absolute_error(y_test, y_pred)
        rmse = np.sqrt(mean_squared_error(y_test, y_pred))

        print(".3f")
        print(".3f")
        print(".3f")

        # Calculate additional metrics
        r2 = model.score(X_test_scaled, y_test)
        mean_actual = y_test.mean()
        mae_percentage = (mae / mean_actual) * 100

        print(".3f")
        print(".3f")

        # Save model and scaler
        model_path = f'models/{scope}_goals_model.pkl'
        scaler_path = f'models/{scope}_goals_scaler.pkl'

        joblib.dump(model, model_path)
        joblib.dump(scaler, scaler_path)

        print(f"Saved model to {model_path}")
        print(f"Saved scaler to {scaler_path}")

        # Save metrics
        metrics = {
            'mae': mae,
            'rmse': rmse,
            'r2': r2,
            'mae_percentage': mae_percentage,
            'mean_actual': mean_actual,
            'samples': len(X_train) + len(X_test)
        }

        with open(f'models/{scope}_metrics.json', 'w') as f:
            import json
            json.dump(metrics, f, indent=2)

        models[scope] = model
        scalers[scope] = scaler

    print("\nTraining completed!")
    return models, scalers

if __name__ == '__main__':
    train_models()