import sys
import unittest
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from research_quality import outlook


class OutlookEvidenceTests(unittest.TestCase):
    def render(self, volumes):
        frame = pd.DataFrame({
            "day": pd.date_range(end=pd.Timestamp.now(tz="UTC").floor("D"), periods=14),
            "postVolume": volumes,
        })
        quality = {
            "activeSessionRatio": sum(v > 0 for v in volumes) / 14,
            "coveredWeeks": 1, "totalWeeks": 2, "coverageQualified": False,
        }
        return outlook(
            "TEST", frame, quality, 0.0, "neutral", {"baselineMae": 1.0},
            {"method": "Q-learning", "status": "ready"},
        )

    def test_no_recent_posts_are_unavailable_not_neutral(self):
        markdown, document = self.render([3] * 7 + [0] * 7)
        for text in (markdown, document):
            self.assertIn("Sentiment: unavailable.", text)
            self.assertNotIn("Sentiment: neutral", text)
            self.assertIn("not evidence of neutral sentiment", text)

    def test_observed_neutral_posts_remain_neutral(self):
        markdown, _ = self.render([0] * 7 + [2] * 7)
        self.assertIn("Sentiment: neutral, score +0.000.", markdown)
        self.assertIn("14 posts versus 0", markdown)

    def test_empty_dataset_does_not_claim_an_observed_signal(self):
        markdown, _ = self.render([0] * 14)
        self.assertIn("Sentiment: unavailable.", markdown)
        self.assertIn("0 posts across 14 price sessions", markdown)


if __name__ == "__main__":
    unittest.main()
