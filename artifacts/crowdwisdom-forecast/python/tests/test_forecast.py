import math
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd
from sklearn.model_selection import TimeSeriesSplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import forecast


def synthetic_bars(count: int) -> list[dict[str, object]]:
    timestamps = forecast.xcals.get_calendar("XNYS", start="2025-01-01", end="2027-01-01").sessions[:count]
    closes = 100 * np.exp(
        np.cumsum([0.001 + 0.009 * math.sin(index / 5) for index in range(count)])
    )
    return [
        {"timestamp": timestamp.isoformat(), "close": float(close)}
        for timestamp, close in zip(timestamps, closes)
    ]


class MeanReturnModel:
    def fit(self, features: np.ndarray, targets: np.ndarray) -> "MeanReturnModel":
        self.mean_return = float(np.mean(targets))
        return self

    def predict(self, features: np.ndarray) -> np.ndarray:
        return np.full(len(features), self.mean_return, dtype=float)


class ForecastHorizonTests(unittest.TestCase):
    def test_forecast_and_metrics_cover_six_direct_horizons(self) -> None:
        bars = synthetic_bars(100)
        with patch.object(forecast, "make_model", side_effect=MeanReturnModel):
            output = forecast.run(
                {
                    "assetSymbol": "TEST",
                    "priceBars": bars,
                    "posts": [],
                }
            )

        self.assertEqual([row["horizon"] for row in output["forecast"]], list(range(6)))
        self.assertIn("X sentiment is unavailable", output["summary"])
        self.assertIn("Sentiment: unavailable.", output["outlookMarkdown"])
        self.assertNotIn("post volume, engagement,", output["summary"])
        self.assertEqual([row["horizon"] for row in output["metrics"]], list(range(1, 6)))
        self.assertIsNotNone(output["forecast"][0]["predictedClose"])
        self.assertNotEqual(output["forecast"][0]["predictedClose"], bars[-1]["close"])
        for point in output["forecast"][1:]:
            self.assertTrue(math.isfinite(point["predictedClose"]))
        for metric in output["metrics"]:
            self.assertGreater(metric["sampleSize"], 0)
        self.assertIn("No X posts were available", output["summary"])
        self.assertIsInstance(output["performance"]["baselineMae"], float)

    def test_walk_forward_purges_future_labels_and_uses_each_prediction_base_close(self) -> None:
        count = 90
        horizon = 3
        marker = np.arange(count, dtype=float)
        closes = 80 * np.exp(
            np.cumsum([0.002 + 0.013 * math.sin(index / 4) for index in range(count)])
        )
        frame = pd.DataFrame({"marker": marker, "close": closes})
        fitted_targets: list[np.ndarray] = []
        tested_markers: list[np.ndarray] = []

        class RecordingModel:
            def fit(self, x: np.ndarray, y: np.ndarray) -> "RecordingModel":
                fitted_targets.append(y.copy())
                self.prediction = float(np.mean(y))
                return self

            def predict(self, x: np.ndarray) -> np.ndarray:
                tested_markers.append(x[:, 0].copy())
                return np.full(len(x), self.prediction, dtype=float)

        with patch.object(forecast, "make_model", side_effect=RecordingModel):
            metric, prediction, actual = forecast.evaluate_horizon(
                frame, ["marker"], horizon
            )

        target = np.log(frame["close"].shift(-horizon) / frame["close"])
        usable_indices = np.flatnonzero(target.notna().to_numpy())
        split_count = min(5, max(2, len(usable_indices) // 15))
        splits = list(
            TimeSeriesSplit(n_splits=split_count, gap=horizon).split(usable_indices)
        )
        self.assertEqual(len(fitted_targets), split_count + 1)

        expected_test_indices: list[int] = []
        expected_predictions: list[float] = []
        for fold_index, (train, test) in enumerate(splits):
            train_rows = usable_indices[train]
            test_rows = usable_indices[test]
            self.assertLess(
                train_rows[-1] + horizon,
                test_rows[0],
                "training labels must finish before the validation fold starts",
            )
            expected_test_indices.extend(test_rows.tolist())
            expected_predictions.extend(
                [float(np.mean(target.iloc[train_rows]))] * len(test_rows)
            )
            np.testing.assert_array_equal(
                tested_markers[fold_index], marker[test_rows]
            )

        np.testing.assert_allclose(prediction, expected_predictions)
        np.testing.assert_allclose(actual, target.iloc[expected_test_indices].to_numpy())
        base_prices = closes[expected_test_indices]
        actual_prices = np.exp(actual) * base_prices
        predicted_prices = np.exp(prediction) * base_prices
        expected_mae = float(np.mean(np.abs(actual_prices - predicted_prices)))
        expected_baseline_mae = float(np.mean(np.abs(base_prices - actual_prices)))
        self.assertAlmostEqual(metric["mae"], expected_mae, places=10)
        self.assertAlmostEqual(metric["baselineMae"], expected_baseline_mae, places=10)

    def test_daily_alignment_uses_market_local_dates_and_next_session_posts(self) -> None:
        bars = [
            {"timestamp": "2025-01-02T20:00:00-05:00", "close": 105},
            {"timestamp": "2024-12-31T12:00:00Z", "close": 100},
            {"timestamp": "2025-01-03T18:00:00Z", "close": 111},
        ]
        posts = [
            {
                "timestamp": "2025-01-03T09:00:00-02:00",
                "text": "up",
                "sentimentLabel": "bullish",
            },
            {
                "timestamp": "not a date",
                "text": "ignored",
                "sentimentLabel": "bearish",
            },
        ]

        frame = forecast.assemble_frame(bars, posts, "TEST")

        self.assertEqual(frame["day"].dt.strftime("%Y-%m-%d").tolist(), [
            "2024-12-31",
            "2025-01-02",
            "2025-01-03",
        ])
        self.assertEqual(frame["close"].tolist(), [100, 105, 111])
        self.assertEqual(frame["postVolume"].tolist(), [0, 0, 1])
        self.assertEqual(frame["sentimentScore"].tolist(), [0.0, 0.0, 1.0])
        self.assertEqual(frame.attrs["marketCalendar"], "XNYS")

    def test_sparse_history_and_empty_posts_return_structured_output(self) -> None:
        bars = synthetic_bars(30)
        with patch.object(forecast, "make_model", side_effect=MeanReturnModel):
            output = forecast.run(
                {"assetSymbol": "SPARSE", "priceBars": bars, "posts": []}
            )

        self.assertEqual(len(output["forecast"]), 6)
        self.assertEqual(len(output["metrics"]), 5)
        self.assertTrue(all(metric["sampleSize"] == 0 for metric in output["metrics"]))
        self.assertTrue(
            all(point["lowerBound"] is None for point in output["forecast"][1:])
        )
        self.assertTrue(any("No X posts" in warning for warning in output["warnings"]))
        self.assertEqual(
            output["sentimentCoverage"],
            {
                "postStartDate": None,
                "postEndDate": None,
                "activePostDays": 0,
                "activePriceDays": 0,
                "priceWindowDays": 30,
                "coverageRatio": 0.0,
                "isSparse": True,
            },
        )
        self.assertTrue(any("Social sentiment coverage is sparse" in warning for warning in output["warnings"]))
        with self.assertRaisesRegex(ValueError, "At least 20"):
            forecast.run(
                {"assetSymbol": "SHORT", "priceBars": synthetic_bars(19), "posts": []}
            )

    def test_sparse_post_coverage_reports_span_and_active_days_without_dropping_forecasts(self) -> None:
        bars = synthetic_bars(125)
        posts = [
            {
                "timestamp": "2025-01-12T08:00:00Z",
                "text": f"post {index}",
                "sentimentLabel": "positive",
            }
            for index in range(10)
        ]

        with patch.object(forecast, "make_model", side_effect=MeanReturnModel):
            output = forecast.run(
                {"assetSymbol": "TSLA", "priceBars": bars, "posts": posts}
            )

        self.assertEqual(
            output["sentimentCoverage"],
            {
                "postStartDate": "2025-01-13",
                "postEndDate": "2025-01-13",
                "activePostDays": 1,
                "activePriceDays": 1,
                "priceWindowDays": 125,
                "coverageRatio": 1 / 125,
                "isSparse": True,
            },
        )
        self.assertEqual(len(output["forecast"]), 6)
        self.assertIn("1 of 125 price days", output["summary"])
        self.assertIn("sentiment features have limited coverage", output["summary"])

    def test_sharpe_sortino_and_drawdown_match_known_returns(self) -> None:
        actual = np.log(np.array([1.10, 0.90, 0.95, 1.20]))
        predictions = np.array([1.0, -1.0, 1.0, -1.0])
        returns = np.sign(predictions) * np.expm1(actual)
        downside_deviation = float(
            np.sqrt(np.mean(np.square(np.minimum(returns, 0))))
        )
        equity = np.cumprod(1 + returns)
        peaks = np.maximum.accumulate(np.concatenate(([1.0], equity)))[1:]
        expected_drawdown = float(np.min(equity / peaks - 1))

        result = forecast.strategy_statistics(predictions, actual)
        zero_cost_result = forecast.strategy_statistics(
            predictions,
            actual,
            {
                "transactionCostBps": 0,
                "slippageBps": 0,
                "marketImpactBps": 0,
                "annualBorrowRateBps": 0,
            },
        )

        self.assertAlmostEqual(
            zero_cost_result["sharpe"],
            float(np.mean(returns) / np.std(returns, ddof=1) * np.sqrt(252)),
        )
        self.assertAlmostEqual(
            zero_cost_result["sortino"],
            float(np.mean(returns) / downside_deviation * np.sqrt(252)),
        )
        self.assertAlmostEqual(zero_cost_result["maxDrawdown"], expected_drawdown)
        self.assertLess(result["netTotalReturn"], result["grossTotalReturn"])
        self.assertLessEqual(result["maxDrawdown"], result["grossMaxDrawdown"])
        expected_costs = np.array([1, 2, 2, 3]) * 5 / 10000
        expected_costs += np.array([0, 1, 0, 1]) * 300 / 10000 / 252
        self.assertAlmostEqual(result["netTotalReturn"], np.prod(1 + returns - expected_costs) - 1)
        self.assertIsNone(forecast.strategy_statistics(np.array([1]), np.array([0.1]))["sharpe"])

    def test_sessions_handle_dst_holidays_weekends_and_early_closes(self) -> None:
        timestamps = [pd.Timestamp(value) for value in [
            "2025-03-07T21:01:00Z",  # Friday after 16:00 EST.
            "2025-03-10T19:59:00Z",  # Monday before 16:00 EDT.
            "2025-03-10T20:01:00Z",
            "2025-07-04T14:00:00Z",  # Independence Day.
            "2025-11-28T17:59:00Z",  # Day after Thanksgiving: 13:00 EST close.
            "2025-11-28T18:01:00Z",
        ]]
        sessions, calendar = forecast.session_map(timestamps, "TSLA")
        self.assertEqual(calendar, "XNYS")
        self.assertEqual(sessions, [
            "2025-03-10", "2025-03-10", "2025-03-11",
            "2025-07-07", "2025-11-28", "2025-12-01",
        ])
        crypto_sessions, calendar = forecast.session_map(timestamps, "BTC-USD")
        self.assertEqual(calendar, "UTC-24/7")
        self.assertEqual(crypto_sessions[0], "2025-03-07")
        self.assertEqual(crypto_sessions[3], "2025-07-04")


if __name__ == "__main__":
    unittest.main()
