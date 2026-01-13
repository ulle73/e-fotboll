# ML Goals Prediction System

This directory contains machine learning models for predicting expected goals in esports football matches.

## Setup

1. Install Python dependencies:
```bash
pip install -r requirements.txt
```

2. Ensure your `.env` file has MongoDB connection details (same as the main project).

## Workflow

### 1. Prepare Training Data
Extract historical match data and player statistics:
```bash
python data_prep.py
```
This creates `ml/training_data.csv` with features and targets.

### 2. Train Models
Train XGBoost models for each scope (total, home, away, firstHalf goals):
```bash
python train.py
```
Models and scalers are saved in `ml/models/`.

### 3. Test Predictions
Test predictions for a specific match:
```bash
python predict.py <event_id>
```

Or predict from stats directly:
```bash
python predict_from_stats.py <temp_stats.json>
```

## Integration

The ML predictions are integrated into the main EV calculator as the `ml_predicted` formula.

- Added to the formulas list in `src/ev_calculator.js`
- `calculateExpectedGoals` now supports async ML predictions
- Falls back to `raz_optimal` if ML models are unavailable

## Model Details

- **Algorithm**: XGBoost Regressor
- **Features**: Player stats (GF, GA, weighted averages, recent form, league averages)
- **Targets**: goalsHome, goalsAway, totalGoals, firstHalfGoals
- **Evaluation**: MAE, RMSE on test set

## Files

- `requirements.txt`: Python dependencies
- `data_prep.py`: Data extraction and feature engineering
- `train.py`: Model training script
- `predict.py`: Prediction utilities
- `predict_from_stats.py`: Node.js integration script
- `models/`: Trained models and scalers (created after training)
- `training_data.csv`: Prepared dataset (created after data prep)

## Usage in Production

1. Run data preparation periodically to include new matches
2. Retrain models when sufficient new data is available
3. Monitor model performance via the EV formula reports
4. The system automatically uses ML predictions when models are available