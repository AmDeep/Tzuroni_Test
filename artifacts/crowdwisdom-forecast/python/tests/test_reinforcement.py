import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import forecast
import reinforcement as rl
from research_quality import assess_coverage


class ResearchRobustnessTests(unittest.TestCase):
    def frame(self, count=130):
        dates = pd.date_range("2025-01-01", periods=count, tz="UTC")
        bars = [{"timestamp": str(d), "close": float(100 * np.exp(i * .001 + .02 * np.sin(i / 8)))} for i, d in enumerate(dates)]
        return forecast.assemble_frame(bars, [], "BTC-USD"), bars

    def test_bellman_updates_are_real_reproducible_and_reward_sensitive(self):
        x = np.tile([.1, .02, .01, 3.], (40, 1))
        costs = {key: 0 for key in forecast.DEFAULT_COST_ASSUMPTIONS}
        p = rl.fit_policy(x, np.full(40, .01), costs, 252, 42)
        again = rl.fit_policy(x, np.full(40, .01), costs, 252, 42)
        negative = rl.fit_policy(x, np.full(40, -.01), costs, 252, 42)
        self.assertEqual(p["updates"], 40 * rl.EPISODES)
        np.testing.assert_array_equal(p["q"], again["q"])
        self.assertTrue(np.any(p["q"] != 0))
        self.assertFalse(np.array_equal(p["q"], negative["q"]))
        self.assertEqual(rl.act(p, x[-1:])[0], 1)
        self.assertEqual(rl.act(negative, x[-1:])[0], -1)

    def test_training_never_receives_test_rewards_and_all_seeds_are_reported(self):
        frame, _ = self.frame()
        calls = []
        original = rl.fit_policy
        def recorded(x, y, costs, annualization, seed):
            calls.append((x.copy(), y.copy(), seed))
            return original(x, y, costs, annualization, seed, episodes=3)
        with patch.object(rl, "fit_policy", side_effect=recorded):
            result, artifact = rl.evaluate_policy(frame, forecast.DEFAULT_COST_ASSUMPTIONS, 365, forecast.strategy_statistics)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(len(result["seedResults"]), 3)
        self.assertEqual(len(artifact["policies"]), 3)
        self.assertEqual(len(calls), 12)  # 3 folds + final fit, for each seed
        for window in result["foldWindows"]:
            self.assertLess(window["trainEnd"], window["testStart"])
        x = frame[rl.STATE_COLUMNS].shift(1)
        future = frame.close.shift(-1) / frame.close - 1
        valid = x.notna().all(axis=1) & future.notna()
        expected = future.loc[valid].to_numpy()
        for index in (0, 3, 6):
            self.assertLess(len(calls[index][1]), len(expected))
            np.testing.assert_array_equal(calls[index][1], expected[:len(calls[index][1])])
        np.testing.assert_array_equal(calls[-1][1], expected)
        self.assertEqual({b["name"] for b in result["benchmarks"]}, {"Buy and hold", "Cash", "Lagged momentum"})

    def test_nowcast_does_not_use_the_latest_observed_close(self):
        from sklearn.dummy import DummyRegressor
        _, bars = self.frame(90)
        with patch.object(forecast, "make_model", side_effect=lambda: DummyRegressor()), patch.object(forecast, "evaluate_policy", return_value=({
            "method": "fixture", "status": "insufficient"}, None)):
            first = forecast.run({"assetSymbol": "BTC-USD", "priceBars": bars})
            bars[-1]["close"] *= 2
            second = forecast.run({"assetSymbol": "BTC-USD", "priceBars": bars})
        self.assertEqual(first["forecast"][0]["predictedClose"], second["forecast"][0]["predictedClose"])
        self.assertNotEqual(second["forecast"][0]["predictedClose"], second["currentPrice"])

    def test_prices_on_closed_days_and_duplicate_sessions_are_rejected(self):
        for symbol, day in [("AAPL", "2025-07-04"), ("RY.TO", "2025-07-01"), ("VOD.L", "2025-05-05")]:
            with self.subTest(symbol=symbol), self.assertRaisesRegex(ValueError, "not a trading day"):
                forecast.assemble_frame([{"timestamp": day, "close": 100}, {"timestamp": "2025-07-07", "close": 101}], [], symbol)
        with self.assertRaisesRegex(ValueError, "Duplicate trading-session"):
            forecast.assemble_frame([{"timestamp": "2025-01-03T15:00Z", "close": 100}, {"timestamp": "2025-01-03T20:00Z", "close": 101}], [], "AAPL")
        self.assertEqual(len(forecast.assemble_frame([{"timestamp": "2025-01-04", "close": 100}], [], "BTC-USD")), 1)

    def test_snapshot_engagement_cannot_change_predictive_sentiment(self):
        bars = [{"timestamp": "2025-01-03", "close": 100}]
        posts = [{"timestamp": "2025-01-03T15:00Z", "text": "good", "likes": 1},
                 {"timestamp": "2025-01-03T15:00Z", "text": "bad", "likes": 1}]
        first = forecast.assemble_frame(bars, posts, "AAPL")
        posts[0]["likes"] = 999999
        second = forecast.assemble_frame(bars, posts, "AAPL")
        self.assertEqual(first.sentimentScore.iloc[0], second.sentimentScore.iloc[0])

    def test_incomplete_window_cannot_claim_qualified_coverage(self):
        frame, _ = self.frame()
        quality = assess_coverage(frame, [], {"start": "2025-01-01T00:00Z", "end": "2025-05-11T00:00Z", "maxPosts": 1000})
        self.assertFalse(quality["coverageQualified"])
        self.assertEqual(quality["coveredWeeks"], 0)
        self.assertTrue(quality["warnings"])


if __name__ == "__main__":
    unittest.main()
