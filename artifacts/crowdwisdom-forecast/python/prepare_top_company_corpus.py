#!/usr/bin/env python3
"""Stream the licensed Kaggle corpus into reproducible, full-population daily features."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import zipfile
from datetime import datetime, timezone

import exchange_calendars as xcals
import numpy as np
import pandas as pd

from forecast import analyzer

SYMBOLS = ["AAPL", "AMZN", "GOOG", "MSFT", "TSLA"]
SOURCE = "https://www.kaggle.com/datasets/omermetinn/tweets-about-the-top-companies-from-2015-to-2020"


def prepare(archive_path: str, output_path: str) -> None:
    with open(archive_path, "rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    calendar = xcals.get_calendar("XNYS", start="2014-12-01", end="2021-01-31")
    # Use epoch seconds explicitly; pandas may use microsecond datetime resolution.
    closes = np.array([int(value.timestamp()) for value in calendar.schedule["close"]])
    sessions = calendar.schedule.index.strftime("%Y-%m-%d").to_numpy()
    totals = {symbol: np.zeros((len(sessions), 4)) for symbol in SYMBOLS}
    min_epoch, max_epoch = math.inf, -math.inf
    processed = used = duplicates = invalid = 0
    with zipfile.ZipFile(archive_path) as archive:
        links = pd.read_csv(archive.open("Company_Tweet.csv"), dtype={"tweet_id": "int64", "ticker_symbol": "category"})
        ids, inverse = np.unique(links.tweet_id.to_numpy(), return_inverse=True)
        flags = np.zeros(len(ids), dtype=np.uint8)
        bits = links.ticker_symbol.astype(str).map({symbol: 1 << i for i, symbol in enumerate(SYMBOLS)}).fillna(0).to_numpy(dtype=np.uint8)
        np.bitwise_or.at(flags, inverse, bits)
        del links, inverse, bits
        seen = np.zeros(len(ids), dtype=bool)
        chunks = pd.read_csv(
            archive.open("Tweet.csv"), chunksize=20000, keep_default_na=False,
            usecols=["tweet_id", "post_date", "body", "like_num", "retweet_num"],
            dtype={"tweet_id": "int64", "post_date": "int64", "body": str},
        )
        for chunk in chunks:
            processed += len(chunk)
            positions = np.searchsorted(ids, chunk.tweet_id.to_numpy())
            valid = positions < len(ids)
            valid &= ids[np.minimum(positions, len(ids) - 1)] == chunk.tweet_id.to_numpy()
            invalid += int((~valid).sum())
            chunk = chunk.loc[valid].copy()
            positions = positions[valid]
            _, first = np.unique(positions, return_index=True)
            keep = np.zeros(len(positions), dtype=bool)
            keep[first] = True
            keep &= ~seen[positions]
            duplicates += int((~keep).sum())
            chunk = chunk.iloc[np.flatnonzero(keep)]
            positions = positions[keep]
            seen[positions] = True
            epochs = chunk.post_date.to_numpy()
            session_indices = np.searchsorted(closes, epochs, side="left")
            valid = (session_indices < len(sessions)) & (epochs >= int(datetime(2015, 1, 1, tzinfo=timezone.utc).timestamp())) & chunk.body.str.strip().ne("").to_numpy()
            invalid += int((~valid).sum())
            chunk = chunk.iloc[np.flatnonzero(valid)]
            positions, epochs, session_indices = positions[valid], epochs[valid], session_indices[valid]
            if not len(chunk):
                continue
            min_epoch, max_epoch = min(min_epoch, int(epochs.min())), max(max_epoch, int(epochs.max()))
            engagement = np.maximum(pd.to_numeric(chunk.like_num, errors="coerce").fillna(0).to_numpy(), 0) + 2 * np.maximum(pd.to_numeric(chunk.retweet_num, errors="coerce").fillna(0).to_numpy(), 0)
            # Only text/timestamp is known point-in-time. Retrospective
            # engagement is retained descriptively, never used as a weight.
            weights = np.ones(len(engagement))
            sentiment = np.array([analyzer.polarity_scores(body)["compound"] for body in chunk.body])
            for i, symbol in enumerate(SYMBOLS):
                include = flags[positions] & (1 << i) != 0
                day_indices = session_indices[include]
                values = totals[symbol]
                for column, amount in enumerate((sentiment[include] * weights[include], weights[include], np.ones(int(include.sum())), engagement[include])):
                    values[:, column] += np.bincount(day_indices, weights=amount, minlength=len(sessions))
            used += len(chunk)
            if processed % 200000 == 0:
                print(f"Processed {processed:,} posts", flush=True)
    assets = {}
    for symbol, values in totals.items():
        daily = [{
            "sessionDate": str(sessions[i]),
            "sentimentScore": float(row[0] / row[1]),
            "postVolume": int(row[2]),
            "engagement": float(np.log1p(row[3] / row[2])),
        } for i, row in enumerate(values) if row[2] > 0]
        assets[symbol] = {"postCount": sum(row["postVolume"] for row in daily), "daily": daily}
    result = {
        "id": "top-companies-2015-2019", "title": "Tweets about the Top Companies from 2015 to 2020",
        "sourceUrl": SOURCE, "license": "CC0-1.0", "sha256": digest,
        "preparedAt": datetime.now(timezone.utc).isoformat(),
        "startDate": datetime.fromtimestamp(min_epoch, timezone.utc).isoformat(),
        "endDate": datetime.fromtimestamp(max_epoch, timezone.utc).isoformat(),
        "sourceRows": processed, "uniqueUsablePosts": used, "duplicatesRemoved": duplicates,
        "invalidRowsRemoved": invalid, "sampling": "none",
        "method": "Unweighted VADER text sentiment; XNYS close-aware sessions; no retrospective engagement in predictive features",
        "limitations": ["Author follower counts and views are absent from this corpus and are not inferred.", "Retrospective engagement is descriptive only and excluded from predictive features and sentiment weighting.", "Historical forecasts are as of the corpus end, not current trading signals."],
        "assets": assets,
    }
    with open(output_path, "w") as destination:
        json.dump(result, destination, allow_nan=False)
    print(json.dumps({key: value for key, value in result.items() if key != "assets"}), flush=True)
    print(json.dumps({symbol: {"postCount": asset["postCount"], "sessions": len(asset["daily"])} for symbol, asset in assets.items()}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    prepare(args.archive, args.output)
