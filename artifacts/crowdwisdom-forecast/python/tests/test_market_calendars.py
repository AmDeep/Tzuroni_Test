import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import forecast


ASSETS = {
    "XTSE": "RY.TO", "XLON": "VOD.L", "XETR": "SAP.DE", "XPAR": "AIR.PA",
    "XASX": "BHP.AX", "XHKG": "0700.HK", "XTKS": "7203.T",
}


class FixedModel:
    def fit(self, x, y):
        return self

    def predict(self, x):
        return np.full(len(x), 0.001)


class LocalCalendarTests(unittest.TestCase):
    def mapped(self, calendar, timestamps):
        result, resolved = forecast.session_map(
            [pd.Timestamp(value) for value in timestamps], ASSETS[calendar]
        )
        self.assertEqual(resolved, calendar)
        return result

    def test_foreign_holidays_do_not_use_us_sessions(self):
        fixtures = [
            ("XTSE", "2025-07-01T14:00:00Z", "2025-07-02"),
            ("XLON", "2025-05-05T10:00:00Z", "2025-05-06"),
            ("XETR", "2025-05-01T10:00:00Z", "2025-05-02"),
            ("XPAR", "2025-05-01T10:00:00Z", "2025-05-02"),
            ("XASX", "2025-01-27T01:00:00Z", "2025-01-28"),
            ("XHKG", "2025-07-01T02:00:00Z", "2025-07-02"),
            ("XTKS", "2025-05-05T02:00:00Z", "2025-05-07"),
        ]
        for calendar, timestamp, expected in fixtures:
            with self.subTest(calendar=calendar):
                self.assertEqual(self.mapped(calendar, [timestamp]), [expected])

    def test_early_closes_use_exact_local_close_and_next_open_day(self):
        fixtures = [
            ("XTSE", "2025-12-24T18:00:00Z", "2025-12-29"),
            ("XLON", "2025-12-24T12:30:00Z", "2025-12-29"),
            ("XETR", "2025-12-30T13:00:00Z", "2026-01-02"),
            ("XPAR", "2025-12-24T13:05:00Z", "2025-12-29"),
            ("XASX", "2025-12-24T03:10:00Z", "2025-12-29"),
            ("XHKG", "2025-01-28T04:00:00Z", "2025-02-03"),
            # Tokyo observes neither Christmas nor a Christmas Eve early close.
            ("XTKS", "2025-12-24T06:30:00Z", "2025-12-25"),
        ]
        for calendar, close, next_day in fixtures:
            with self.subTest(calendar=calendar):
                instant = pd.Timestamp(close)
                mapped = self.mapped(calendar, [
                    (instant - pd.Timedelta(seconds=1)).isoformat(),
                    instant.isoformat(),
                    (instant + pd.Timedelta(seconds=1)).isoformat(),
                ])
                self.assertEqual(mapped, [close[:10], close[:10], next_day])

    def test_dst_both_directions_and_markets_without_dst(self):
        fixtures = {
            "XTSE": [("2025-03-07", "21:00"), ("2025-03-10", "20:00"), ("2025-10-31", "20:00"), ("2025-11-03", "21:00")],
            "XLON": [("2025-03-28", "16:30"), ("2025-03-31", "15:30"), ("2025-10-24", "15:30"), ("2025-10-27", "16:30")],
            "XETR": [("2025-03-28", "16:30"), ("2025-03-31", "15:30"), ("2025-10-24", "15:30"), ("2025-10-27", "16:30")],
            "XPAR": [("2025-03-28", "16:30"), ("2025-03-31", "15:30"), ("2025-10-24", "15:30"), ("2025-10-27", "16:30")],
            "XASX": [("2025-04-04", "05:00"), ("2025-04-07", "06:00"), ("2025-10-03", "06:00"), ("2025-10-07", "05:00")],
            "XHKG": [("2025-03-07", "08:00"), ("2025-03-10", "08:00"), ("2025-10-24", "08:00"), ("2025-10-27", "08:00")],
            "XTKS": [("2025-03-07", "06:30"), ("2025-03-10", "06:30"), ("2025-10-24", "06:30"), ("2025-10-27", "06:30")],
        }
        for calendar, dates in fixtures.items():
            for day, utc_close in dates:
                with self.subTest(calendar=calendar, day=day):
                    instant = pd.Timestamp(f"{day}T{utc_close}:00Z")
                    mapped = self.mapped(calendar, [
                        (instant - pd.Timedelta(seconds=1)).isoformat(),
                        (instant + pd.Timedelta(seconds=1)).isoformat(),
                    ])
                    self.assertEqual(mapped[0], day)
                    self.assertGreater(mapped[1], day)

    def test_local_price_dates_utc_rollover_and_date_only_labels(self):
        fixtures = [
            ("7203.T", ["2025-01-09T23:30:00Z", "2025-01-10T00:00:00Z"]),
            ("RY.TO", ["2025-01-11T00:30:00Z", "2025-01-10T00:00:00Z"]),
        ]
        for asset, values in fixtures:
            days, calendar = forecast.price_session_dates(pd.Series(pd.to_datetime(values, utc=True)), asset)
            self.assertEqual(days.dt.strftime("%Y-%m-%d").tolist(), ["2025-01-10"] * 2)
            self.assertEqual(calendar, "XTKS" if asset.endswith(".T") else "XTSE")

    def test_metadata_is_preserved_in_model_output_and_joined_features(self):
        sessions = forecast.xcals.get_calendar("XTSE").sessions_in_range("2025-01-02", "2025-05-09")
        payload = {
            "assetSymbol": "GLOBAL",
            "marketMetadata": {"calendar": "XTSE", "timeZone": "America/Toronto", "exchange": "TOR", "source": "provider"},
            "priceBars": [{"timestamp": day.strftime("%Y-%m-%d"), "close": 100 + i / 10} for i, day in enumerate(sessions)],
            "posts": [{"timestamp": "2025-01-03T18:00:00Z", "text": "growth", "sentimentLabel": "positive"}],
        }
        with patch.object(forecast, "make_model", return_value=FixedModel()):
            output = forecast.run(payload)
        self.assertEqual(output["marketCalendar"], "XTSE")
        self.assertEqual(output["marketTimezone"], "America/Toronto")
        self.assertEqual(output["marketExchange"], "TOR")
        self.assertEqual(output["marketCalendarSource"], "provider")
        self.assertEqual(sum(row["postVolume"] for row in output["alignedDailyData"]), 1)
        self.assertIn("XTSE", output["summary"])

    def test_unsupported_markets_fail_instead_of_assuming_new_york(self):
        for asset in ["RELIANCE.NS", "ABC.ZZ", "EURUSD=X", "^GSPC"]:
            with self.subTest(asset=asset), self.assertRaisesRegex(ValueError, "No supported exchange calendar"):
                forecast.calendar_name_for_asset(asset)
        self.assertEqual(forecast.calendar_name_for_asset("BRK.B"), "XNYS")
        with self.assertRaisesRegex(ValueError, "Unsupported exchange calendar"):
            forecast.session_map([], "AAPL", "UNKNOWN")

    def test_sydney_utc_previous_day_bars_keep_local_session_labels_in_series_and_report_window(self):
        sessions = forecast.xcals.get_calendar("XASX").sessions_in_range("2025-01-02", "2025-03-11")
        payload = {
            "assetSymbol": "BHP.AX",
            "priceBars": [
                {"timestamp": (pd.Timestamp(day).tz_localize("UTC") - pd.Timedelta(hours=1)).isoformat(), "close": 100 + i / 10}
                for i, day in enumerate(sessions)
            ],
            "posts": [],
        }
        with patch.object(forecast, "make_model", return_value=FixedModel()):
            output = forecast.run(payload)
        self.assertEqual(output["marketCalendar"], "XASX")
        self.assertEqual(output["dataWindow"]["start"], "2025-01-02")
        self.assertEqual(output["dataWindow"]["end"], "2025-03-11")
        self.assertEqual(output["series"][-1]["sessionDate"], "2025-03-11")
        self.assertEqual(output["series"][-1]["timestamp"], "2025-03-10T23:00:00Z")
