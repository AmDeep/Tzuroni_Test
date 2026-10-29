"""Portable reproduction without a database, cloud integration, or web server."""
import argparse
import csv
import json
from pathlib import Path
from forecast import run, MARKET_CALENDARS

parser = argparse.ArgumentParser()
parser.add_argument("--asset", required=True)
parser.add_argument("--prices", required=True, help="CSV: timestamp,close")
parser.add_argument("--posts", required=True, help="CSV: timestamp,text; optional engagement fields")
parser.add_argument("--calendar", choices=list(MARKET_CALENDARS))
parser.add_argument("--output", required=True)
args = parser.parse_args()
with open(args.prices, newline="") as source:
    bars = [{"timestamp": r["timestamp"], "close": float(r["close"])} for r in csv.DictReader(source)]
with open(args.posts, newline="") as source:
    posts = list(csv.DictReader(source))
payload = {"assetSymbol": args.asset, "priceBars": bars, "posts": posts}
if args.calendar:
    payload["marketMetadata"] = {"calendar": args.calendar, "timeZone": MARKET_CALENDARS[args.calendar]["timeZone"], "source": "user"}
result = run(payload)
Path(args.output).parent.mkdir(parents=True, exist_ok=True)
Path(args.output).write_text(json.dumps(result, allow_nan=False))
print(f"Saved reproducible forecast, evaluation, Q tables and outlook to {args.output}")
