import csv
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import forecast
from prepare_top_company_corpus import prepare


class CorpusTests(unittest.TestCase):
    def test_streamed_corpus_deduplicates_ids_and_preserves_multi_company_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive_path, output = Path(temporary) / "source.zip", Path(temporary) / "daily.json"
            with zipfile.ZipFile(archive_path, "w") as archive:
                def write(name, rows):
                    content = io.StringIO()
                    csv.writer(content).writerows(rows)
                    archive.writestr(name, content.getvalue())
                write("Company_Tweet.csv", [
                    ["tweet_id", "ticker_symbol"], [1, "AAPL"], [1, "TSLA"], [1, "AAPL"], [2, "AAPL"], [3, "MSFT"],
                ])
                write("Tweet.csv", [
                    ["tweet_id", "post_date", "body", "like_num", "retweet_num"],
                    [1, 1420113600, "Strong growth and excellent profits", 10, 2],
                    [1, 1420113600, "Duplicate must not count", 10, 2],
                    [2, 1420232401, "Awful losses", 0, 0],
                    [3, 1420232401, " ", 0, 0],
                ])
            prepare(str(archive_path), str(output))
            result = json.loads(output.read_text())
            self.assertEqual(result["sourceRows"], 4)
            self.assertEqual(result["uniqueUsablePosts"], 2)
            self.assertEqual(result["duplicatesRemoved"], 1)
            self.assertEqual(result["invalidRowsRemoved"], 1)
            self.assertEqual(result["assets"]["AAPL"]["postCount"], 2)
            self.assertEqual(result["assets"]["TSLA"]["postCount"], 1)
            self.assertEqual(result["assets"]["MSFT"]["postCount"], 0)
            self.assertEqual(result["sampling"], "none")
            self.assertEqual(len(result["sha256"]), 64)

    def test_preaggregated_sentiment_matches_raw_post_features_and_coverage(self):
        dates = forecast.xcals.get_calendar("XNYS", start="2019-01-01", end="2020-01-01").sessions[:100]
        bars = [{"timestamp": date.isoformat(), "close": 100 + i / 10} for i, date in enumerate(dates)]
        posts = [
            {"timestamp": "2019-02-01T16:00:00Z", "text": "Strong growth", "likes": 2, "reposts": 1},
            {"timestamp": "2019-02-01T18:00:00Z", "text": "Awful losses", "likes": 1, "reposts": 0},
            {"timestamp": "2019-03-01T18:00:00Z", "text": "Excellent earnings", "likes": 3, "reposts": 2},
        ]
        raw = forecast.assemble_frame(bars, posts, "TSLA")
        active = raw.loc[raw.postVolume > 0]
        daily = [{"sessionDate": row.day.strftime("%Y-%m-%d"), "sentimentScore": row.sentimentScore, "postVolume": row.postVolume, "engagement": row.engagement} for row in active.itertuples()]
        preaggregated = forecast.assemble_frame(bars, [], "TSLA", daily)
        for column in ["sentimentScore", "sentimentLag1", "sentimentLag2", "postVolume", "volumeLog", "engagement"]:
            np.testing.assert_allclose(raw[column], preaggregated[column], equal_nan=True)
        with patch.object(forecast, "make_model"):
            # Check reporting without needing to fit five estimators.
            with patch.object(forecast, "evaluate_horizon", return_value=({"horizon": 1, "sampleSize": 0}, np.array([]), np.array([]))):
                result = forecast.run({"assetSymbol": "TSLA", "posts": [], "priceBars": bars, "dailySentiment": daily})
        self.assertEqual(result["postCount"], 3)
        self.assertEqual(result["sentimentCoverage"]["activePostDays"], 2)
        self.assertNotIn("No X posts were available", result["summary"])


if __name__ == "__main__":
    unittest.main()
