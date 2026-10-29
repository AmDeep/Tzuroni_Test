#!/usr/bin/env python3
"""Train and evaluate a leakage-aware, six-horizon price forecast."""

from __future__ import annotations

import json
import math
import re
import sys
from bisect import bisect_left
from pathlib import Path
from typing import Any

import exchange_calendars as xcals
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.model_selection import TimeSeriesSplit
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
from reinforcement import evaluate_policy
from research_quality import assess_coverage, outlook


HORIZONS = range(1, 6)
analyzer = SentimentIntensityAnalyzer()
MARKET_CALENDARS = json.loads(Path(__file__).with_name("market-calendars.json").read_text())
DEFAULT_COST_ASSUMPTIONS = {
    "transactionCostBps": 1.0,
    "slippageBps": 3.0,
    "marketImpactBps": 1.0,
    "annualBorrowRateBps": 300.0,
}


def is_24_hour_asset(asset_symbol: str) -> bool:
    symbol = asset_symbol.upper().strip()
    if symbol in {"BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "LTC"}:
        return True
    return bool(re.search(r"(?:[-/](?:USD|USDT|USDC|BUSD))$", symbol))


def calendar_name_for_asset(asset_symbol: str, market_calendar: str | None = None) -> str:
    if market_calendar:
        if market_calendar not in MARKET_CALENDARS:
            raise ValueError(f"Unsupported exchange calendar: {market_calendar}")
        return market_calendar
    if is_24_hour_asset(asset_symbol):
        return "UTC-24/7"
    symbol = asset_symbol.upper().strip()
    for name, metadata in MARKET_CALENDARS.items():
        if any(symbol.endswith(suffix) for suffix in metadata["suffixes"]):
            return name
    if re.search(r"[=^]", symbol) or ("." in symbol and not re.fullmatch(r"[A-Z0-9]+\.[AB]", symbol)):
        raise ValueError(f"No supported exchange calendar for {asset_symbol}; no U.S. calendar was substituted.")
    return "XNYS"


def session_map(
    timestamps: list[pd.Timestamp], asset_symbol: str, market_calendar: str | None = None,
) -> tuple[list[str | None], str]:
    """Assign posts to the active or next local session using actual close times."""
    name = calendar_name_for_asset(asset_symbol, market_calendar)
    if name == "UTC-24/7":
        return (
            [timestamp.floor("D").strftime("%Y-%m-%d") for timestamp in timestamps],
            "UTC-24/7",
        )
    if not timestamps:
        return [], name

    start = min(timestamps).date() - pd.Timedelta(days=7)
    end = max(timestamps).date() + pd.Timedelta(days=14)
    calendar = xcals.get_calendar(name, start=str(start), end=str(end))
    schedule = calendar.schedule.loc[str(start):str(end)]
    labels = [pd.Timestamp(value).strftime("%Y-%m-%d") for value in schedule.index]
    closes = [
        pd.Timestamp(value).tz_convert("UTC")
        for value in schedule["close"].tolist()
    ]
    mapped: list[str | None] = []
    for timestamp in timestamps:
        local_date = timestamp.tz_convert(MARKET_CALENDARS[name]["timeZone"]).strftime("%Y-%m-%d")
        index = bisect_left(labels, local_date)
        if index < len(labels) and labels[index] == local_date and timestamp > closes[index]:
            index += 1
        mapped.append(labels[index] if index < len(labels) else None)
    return mapped, name


def price_session_dates(
    timestamps: pd.Series, asset_symbol: str, market_calendar: str | None = None,
) -> tuple[pd.Series, str]:
    name = calendar_name_for_asset(asset_symbol, market_calendar)
    if name == "UTC-24/7":
        return timestamps.dt.floor("D"), "UTC-24/7"
    local_dates = timestamps.dt.tz_convert(MARKET_CALENDARS[name]["timeZone"]).dt.strftime("%Y-%m-%d")
    # Date-only CSV exports represent session labels, not UTC instants.
    date_only = (
        (timestamps.dt.hour == 0)
        & (timestamps.dt.minute == 0)
        & (timestamps.dt.second == 0)
    )
    local_dates.loc[date_only] = timestamps.loc[date_only].dt.strftime("%Y-%m-%d")
    return pd.to_datetime(local_dates, utc=True), name


def number(value: Any) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else 0.0
    except (TypeError, ValueError):
        return 0.0


def sentiment_for_post(post: dict[str, Any]) -> float:
    label = str(post.get("sentimentLabel") or "").strip().lower()
    if label in {"bullish", "positive", "buy"}:
        return 1.0
    if label in {"bearish", "negative", "sell"}:
        return -1.0
    if label in {"neutral", "hold"}:
        return 0.0
    text = str(post.get("text") or "")
    return float(analyzer.polarity_scores(text)["compound"])


def assemble_frame(
    bars: list[dict[str, Any]], posts: list[dict[str, Any]], asset_symbol: str = "",
    daily_sentiment: list[dict[str, Any]] | None = None,
    market_calendar: str | None = None,
) -> pd.DataFrame:
    price = pd.DataFrame(bars)
    if price.empty:
        raise ValueError("No price bars were supplied.")
    price["timestamp"] = pd.to_datetime(price["timestamp"], utc=True, errors="coerce")
    price["close"] = pd.to_numeric(price["close"], errors="coerce")
    if price["timestamp"].isna().any() or price["close"].isna().any() or (price["close"] <= 0).any():
        raise ValueError("Every price row needs a valid timestamp and positive finite close.")
    if not np.isfinite(price["close"]).all():
        raise ValueError("Every price close must be finite.")
    price = price.sort_values("timestamp")
    price["day"], market_calendar = price_session_dates(
        price["timestamp"], asset_symbol, market_calendar
    )
    if price["day"].duplicated().any():
        duplicate = price.loc[price["day"].duplicated(), "day"].iloc[0].strftime("%Y-%m-%d")
        raise ValueError(f"Duplicate trading-session price: {duplicate}. Supply exactly one price per session.")
    if market_calendar != "UTC-24/7":
        calendar = xcals.get_calendar(market_calendar, start=str((price["day"].min() - pd.Timedelta(days=7)).date()), end=str((price["day"].max() + pd.Timedelta(days=7)).date()))
        allowed = set(calendar.sessions.strftime("%Y-%m-%d"))
        invalid = [day for day in price["day"].dt.strftime("%Y-%m-%d") if day not in allowed]
        if invalid:
            raise ValueError(f"Price dated {invalid[0]} is not a trading day on {market_calendar}; prices are not rolled forward.")
    frame = price.groupby("day", as_index=False).agg(
        timestamp=("timestamp", "last"), close=("close", "last")
    )
    frame.attrs["marketCalendar"] = market_calendar

    if daily_sentiment:
        if posts:
            raise ValueError("Supply raw posts or preaggregated corpus data, not both.")
        daily = pd.DataFrame(daily_sentiment)
        daily["day"] = pd.to_datetime(daily["sessionDate"], utc=True, errors="raise")
        if daily["day"].duplicated().any():
            raise ValueError("Corpus data contains duplicate sessions.")
        frame = frame.merge(daily[["day", "sentimentScore", "postVolume", "engagement"]], on="day", how="left")
    elif posts:
        social = pd.DataFrame(posts)
        social["timestamp"] = pd.to_datetime(
            social.get("timestamp"), utc=True, errors="coerce"
        )
        social = social.dropna(subset=["timestamp"]).copy()
        social["day"], post_calendar = session_map(
            social["timestamp"].tolist(), asset_symbol, market_calendar
        )
        social = social.dropna(subset=["day"]).copy()
        social["day"] = pd.to_datetime(social["day"], utc=True)
        if post_calendar != market_calendar:
            raise ValueError(
                "Post and price data were assigned different market calendars."
            )
        social["sentiment"] = social.apply(
            lambda row: sentiment_for_post(row.to_dict()), axis=1
        )
        zero_counts = pd.Series(0, index=social.index, dtype=float)
        social["engagement"] = (
            pd.to_numeric(social.get("likes", zero_counts), errors="coerce").fillna(0)
            + 2
            * pd.to_numeric(social.get("reposts", zero_counts), errors="coerce").fillna(0)
            + 0.1
            * pd.to_numeric(social.get("views", zero_counts), errors="coerce").fillna(0)
        )
        social["followers"] = pd.to_numeric(
            social.get("authorFollowers", zero_counts), errors="coerce"
        ).fillna(0)
        # Snapshot engagement/follower counts may be observed after the signal.
        # Extract and retain them, but do not leak them into predictive features.
        social["weight"] = 1.0
        social["weightedSentiment"] = social["sentiment"] * social["weight"]
        daily = (
            social.groupby("day")
            .agg(
                weightedSentiment=("weightedSentiment", "sum"),
                sentimentWeight=("weight", "sum"),
                postVolume=("text", "count"),
                engagement=("engagement", "mean"),
            )
            .reset_index()
        )
        daily["sentimentScore"] = (
            daily["weightedSentiment"] / daily["sentimentWeight"].replace(0, np.nan)
        )
        daily["engagement"] = np.log1p(daily["engagement"].clip(lower=0))
        frame = frame.merge(
            daily[["day", "sentimentScore", "postVolume", "engagement"]],
            on="day",
            how="left",
        )
    else:
        frame["sentimentScore"] = np.nan
        frame["postVolume"] = 0
        frame["engagement"] = 0.0

    frame["sentimentScore"] = frame["sentimentScore"].fillna(0).clip(-1, 1)
    frame["postVolume"] = frame["postVolume"].fillna(0).astype(int)
    frame["engagement"] = frame["engagement"].fillna(0.0)
    log_close = np.log(frame["close"])
    frame["return1d"] = log_close.diff()
    frame["logClose"] = log_close
    for lag in (1, 2, 3, 5, 10, 20):
        frame[f"returnLag{lag}"] = log_close.diff(lag)
    frame["volatility5"] = frame["return1d"].rolling(5, min_periods=3).std()
    frame["volatility20"] = frame["return1d"].rolling(20, min_periods=5).std()
    frame["sentimentLag1"] = frame["sentimentScore"].shift(1)
    frame["sentimentLag2"] = frame["sentimentScore"].shift(2)
    frame["volumeLog"] = np.log1p(frame["postVolume"])

    frame = frame.replace([np.inf, -np.inf], np.nan)
    frame.attrs["marketCalendar"] = market_calendar or calendar_name_for_asset(asset_symbol)
    return frame


def make_model() -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(
        learning_rate=0.06,
        max_iter=120,
        max_leaf_nodes=7,
        l2_regularization=1.0,
        random_state=42,
    )


def safe_float(value: Any) -> float | None:
    if value is None or not np.isfinite(value):
        return None
    return float(value)


def evaluate_horizon(
    frame: pd.DataFrame, features: list[str], horizon: int
) -> tuple[dict[str, Any], np.ndarray, np.ndarray]:
    target = np.log(frame["close"].shift(-horizon) / frame["close"])
    usable = frame[features].notna().all(axis=1) & target.notna()
    x = frame.loc[usable, features].to_numpy(dtype=float)
    y = target.loc[usable].to_numpy(dtype=float)
    indices = np.flatnonzero(usable.to_numpy())

    if len(y) < 12:
        return (
            {
                "horizon": horizon,
                "mae": None,
                "rmse": None,
                "r2": None,
                "directionalAccuracy": None,
                "sampleSize": 0,
                "warnings": ["At least 12 usable observations are needed."],
            },
            np.array([]),
            np.array([]),
        )

    folds = min(5, max(2, len(y) // 15))
    splitter = TimeSeriesSplit(n_splits=folds, gap=horizon)
    oos_pred: list[float] = []
    oos_actual: list[float] = []
    oos_base_prices: list[float] = []
    for train_indices, test_indices in splitter.split(x):
        # TimeSeriesSplit's gap purges labels whose future close overlaps a test fold.
        if len(train_indices) < 8:
            continue
        model = make_model()
        model.fit(x[train_indices], y[train_indices])
        oos_pred.extend(model.predict(x[test_indices]).tolist())
        oos_actual.extend(y[test_indices].tolist())
        oos_base_prices.extend(
            frame["close"].iloc[indices[test_indices]].astype(float).tolist()
        )

    pred = np.asarray(oos_pred, dtype=float)
    actual = np.asarray(oos_actual, dtype=float)
    if len(actual) == 0:
        return (
            {
                "horizon": horizon,
                "mae": None,
                "rmse": None,
                "r2": None,
                "directionalAccuracy": None,
                "sampleSize": 0,
                "warnings": ["Walk-forward folds did not contain enough training rows."],
            },
            pred,
            actual,
        )

    final_model = make_model()
    final_model.fit(x, y)
    current_x = frame[features].iloc[[-1]].to_numpy(dtype=float)
    forecast_log_return = float(final_model.predict(current_x)[0])
    predicted_price = float(frame["close"].iloc[-1] * np.exp(forecast_log_return))
    base_prices = np.asarray(oos_base_prices, dtype=float)
    price_actual = np.exp(actual) * base_prices
    price_pred = np.exp(pred) * base_prices
    residuals = actual - pred
    interval_low, interval_high = np.quantile(residuals, [0.1, 0.9])
    prediction = {
        "horizon": horizon,
        "predictedClose": predicted_price,
        "predictedReturn": float(np.expm1(forecast_log_return)),
        "lowerBound": float(frame["close"].iloc[-1] * np.exp(forecast_log_return + interval_low)),
        "upperBound": float(frame["close"].iloc[-1] * np.exp(forecast_log_return + interval_high)),
    }
    score = {
        "horizon": horizon,
        "mae": safe_float(np.mean(np.abs(price_actual - price_pred))),
        "rmse": safe_float(np.sqrt(np.mean(np.square(price_actual - price_pred)))),
        "r2": safe_float(1 - np.sum(np.square(actual - pred)) / np.sum(np.square(actual - np.mean(actual))))
        if len(actual) > 1 and np.var(actual) > 0
        else None,
        "directionalAccuracy": safe_float(np.mean(np.sign(pred) == np.sign(actual))),
        "sampleSize": int(len(actual)),
        "baselineMae": safe_float(
            np.mean(
                np.abs(
                    base_prices - price_actual
                )
            )
        ),
    }
    score["prediction"] = prediction
    return score, pred, actual


def strategy_statistics(
    predictions: np.ndarray,
    actual: np.ndarray,
    cost_assumptions: dict[str, Any] | None = None,
    annualization: int = 252,
) -> dict[str, Any]:
    if len(actual) < 2:
        return {
            "sharpe": None,
            "sortino": None,
            "maxDrawdown": None,
            "grossSharpe": None,
            "grossSortino": None,
            "grossMaxDrawdown": None,
        }

    assumptions = dict(DEFAULT_COST_ASSUMPTIONS)
    if cost_assumptions:
        for key in assumptions:
            value = number(cost_assumptions.get(key, assumptions[key]))
            assumptions[key] = float(np.clip(value, 0, 5000))

    positions = np.sign(predictions)
    gross_returns = np.clip(positions * np.expm1(actual), -0.99, None)
    previous_positions = np.concatenate(([0.0], positions[:-1]))
    turnover = np.abs(positions - previous_positions)
    turnover[-1] += abs(positions[-1])  # Liquidate the final position.
    one_way_cost_bps = (
        assumptions["transactionCostBps"]
        + assumptions["slippageBps"]
        + assumptions["marketImpactBps"]
    )
    execution_cost = turnover * one_way_cost_bps / 10_000
    borrow_cost = (
        (positions < 0).astype(float)
        * assumptions["annualBorrowRateBps"]
        / 10_000
        / annualization
    )
    net_returns = np.clip(gross_returns - execution_cost - borrow_cost, -0.99, None)

    def summarize(returns: np.ndarray) -> dict[str, float | None]:
        std = float(np.std(returns, ddof=1))
        downside = np.minimum(returns, 0)
        downside_dev = float(np.sqrt(np.mean(np.square(downside))))
        equity = np.cumprod(1 + returns)
        peaks = np.maximum.accumulate(np.concatenate(([1.0], equity)))[1:]
        drawdown = equity / peaks - 1
        return {
            "sharpe": safe_float(np.mean(returns) / std * np.sqrt(annualization)) if std else None,
            "sortino": safe_float(np.mean(returns) / downside_dev * np.sqrt(annualization))
            if downside_dev
            else None,
            "maxDrawdown": safe_float(np.min(drawdown)),
            "totalReturn": safe_float(float(equity[-1] - 1)),
        }

    gross = summarize(gross_returns)
    net = summarize(net_returns)
    return {
        **net,
        "grossSharpe": gross["sharpe"],
        "grossSortino": gross["sortino"],
        "grossMaxDrawdown": gross["maxDrawdown"],
        "grossTotalReturn": gross["totalReturn"],
        "netTotalReturn": net["totalReturn"],
        "annualization": annualization,
        "oneWayExecutionCostBps": one_way_cost_bps,
        "assumptions": assumptions,
        "strategy": "One-step long/short direction, net of configurable execution and borrow costs",
    }


def run(payload: dict[str, Any]) -> dict[str, Any]:
    posts = payload.get("posts") or []
    bars = payload.get("priceBars") or []
    asset_symbol = str(payload.get("assetSymbol", ""))
    daily_sentiment = payload.get("dailySentiment") or []
    market_metadata = payload.get("marketMetadata") or {}
    market_calendar = calendar_name_for_asset(asset_symbol, market_metadata.get("calendar"))
    if market_metadata.get("timeZone") not in (None, MARKET_CALENDARS[market_calendar]["timeZone"]):
        raise ValueError("Resolved exchange timezone conflicts with its calendar.")
    frame = assemble_frame(bars, posts, asset_symbol, daily_sentiment, market_calendar)
    post_count = sum(int(row["postVolume"]) for row in daily_sentiment) if daily_sentiment else len(posts)
    if len(frame) < 20:
        raise ValueError("At least 20 unique daily price bars are required.")

    features = [
        "logClose",
        "sentimentScore",
        "sentimentLag1",
        "sentimentLag2",
        "volumeLog",
        "returnLag1",
        "returnLag2",
        "returnLag3",
        "returnLag5",
        "returnLag10",
        "returnLag20",
        "volatility5",
        "volatility20",
    ]

    metrics: list[dict[str, Any]] = []
    # n+0 is a genuine held-back latest-session prediction. The observed latest
    # close and latest-session sentiment are never inputs to this estimate.
    nowcast_metric, _, _ = evaluate_horizon(frame.iloc[:-1].copy(), features, 1)
    nowcast_prediction = nowcast_metric.pop("prediction", None)
    forecast: list[dict[str, Any]] = [{
        **(nowcast_prediction or {"predictedClose": None, "predictedReturn": None, "lowerBound": None, "upperBound": None}),
        "horizon": 0, "kind": "prior-session nowcast",
    }]
    one_step_pred = np.array([])
    one_step_actual = np.array([])
    one_step_baseline_mae = None
    for horizon in HORIZONS:
        metric, pred, actual = evaluate_horizon(frame, features, horizon)
        forecast.append(metric.pop("prediction", {
            "horizon": horizon,
            "predictedClose": None,
            "predictedReturn": None,
            "lowerBound": None,
            "upperBound": None,
        }))
        if horizon == 1:
            one_step_pred, one_step_actual = pred, actual
            one_step_baseline_mae = metric.get("baselineMae")
        metrics.append({k: metric.get(k) for k in (
            "horizon", "mae", "rmse", "r2", "directionalAccuracy", "sampleSize"
        )})

    recent_week = frame.tail(7)
    previous_week = frame.tail(14).head(7)

    def weighted_sentiment(rows: pd.DataFrame) -> float:
        active = rows.loc[rows["postVolume"] > 0]
        if active.empty:
            return 0.0
        return float(
            np.average(active["sentimentScore"], weights=active["postVolume"])
        )

    latest_sentiment = weighted_sentiment(recent_week)
    previous_sentiment = weighted_sentiment(previous_week)
    latest_volume = int(recent_week["postVolume"].sum())
    previous_volume = int(previous_week["postVolume"].sum())
    last_post_rows = frame.loc[frame["postVolume"] > 0]
    last_post_day = (
        last_post_rows["day"].iloc[-1].strftime("%Y-%m-%d")
        if not last_post_rows.empty
        else None
    )
    close = frame["close"].to_numpy(dtype=float)
    return_7d = float(close[-1] / close[max(0, len(close) - 8)] - 1)
    return_30d = float(close[-1] / close[max(0, len(close) - 31)] - 1)
    price_direction = "positive" if return_7d > 0.002 else (
        "negative" if return_7d < -0.002 else "flat"
    )
    label = "positive" if latest_sentiment > 0.05 else (
        "negative" if latest_sentiment < -0.05 else "neutral"
    )
    warnings = []
    if len(frame) < 60:
        warnings.append("Fewer than 60 daily bars are available; out-of-sample metrics may be unstable.")
    if not posts and not daily_sentiment:
        warnings.append("No X posts were available; model sentiment features are zero-filled, not an observed neutral signal.")
    elif latest_volume == 0:
        warnings.append("No posts were observed in the latest seven sessions; current sentiment is unavailable.")
    post_timestamps = pd.to_datetime(
        pd.Series(
            [post.get("timestamp") for post in posts if isinstance(post, dict)],
            dtype="object",
        ),
        utc=True,
        errors="coerce",
    ).dropna()
    mapped_post_days = (
        [row["sessionDate"] for row in daily_sentiment if row["postVolume"] > 0]
        if daily_sentiment else session_map(post_timestamps.tolist(), asset_symbol, market_calendar)[0]
    )
    post_days = (
        pd.to_datetime(
            [day for day in mapped_post_days if day is not None], utc=True
        )
        .drop_duplicates()
        .sort_values()
    )
    price_days = set(frame["day"])
    active_price_days = sum(day in price_days for day in post_days)
    price_window_days = len(price_days)
    coverage_ratio = (
        active_price_days / price_window_days if price_window_days else 0.0
    )
    sparse_coverage = bool(price_window_days and coverage_ratio < 0.2)
    post_coverage = {
        "postStartDate": (
            post_days[0].strftime("%Y-%m-%d") if len(post_days) else None
        ),
        "postEndDate": (
            post_days[-1].strftime("%Y-%m-%d") if len(post_days) else None
        ),
        "activePostDays": int(len(post_days)),
        "activePriceDays": int(active_price_days),
        "priceWindowDays": int(price_window_days),
        "coverageRatio": float(coverage_ratio),
        "isSparse": sparse_coverage,
    }
    if sparse_coverage:
        date_span = (
            f"from {post_coverage['postStartDate']} to {post_coverage['postEndDate']}"
            if post_days.size
            else "with no usable post dates"
        )
        warnings.append(
            f"Social sentiment coverage is sparse: {active_price_days} of "
            f"{price_window_days} price days ({coverage_ratio:.1%}) had posts, "
            f"across {len(post_days)} active post days {date_span}. Forecasts and "
            "evaluation metrics remain available, but sentiment features have limited coverage."
        )
    training_dates = frame["day"].dt.strftime("%Y-%m-%d")
    sentiment_change = latest_sentiment - previous_sentiment
    if sentiment_change > 0.05:
        sentiment_momentum = "improved"
    elif sentiment_change < -0.05:
        sentiment_momentum = "weakened"
    else:
        sentiment_momentum = "was broadly unchanged"
    alignment = (
        "sentiment and price direction are aligned"
        if (latest_sentiment > 0.05 and return_7d > 0)
        or (latest_sentiment < -0.05 and return_7d < 0)
        else "sentiment and price direction are mixed or diverging"
    )
    if not latest_volume:
        alignment = "sentiment/price alignment cannot be assessed without recent posts"
    current_read = (
        f"Current read — over the latest seven {market_calendar} sessions, {payload.get('assetSymbol', 'the asset')} X sentiment is "
        f"{label} (post-count-weighted score {latest_sentiment:+.3f}) across {latest_volume} posts. "
        if latest_volume else
        f"Current read — {payload.get('assetSymbol', 'the asset')} X sentiment is unavailable: "
        f"no posts were observed in the latest seven {market_calendar} sessions. "
        "Zero-filled model features are not evidence of neutral sentiment. "
    )
    current_read += (
        f"It {sentiment_momentum} by {sentiment_change:+.3f} versus the prior seven-session window "
        f"({previous_volume} posts). "
        if latest_volume and previous_volume else
        "A sentiment change comparison is unavailable because one or both seven-session windows lack posts. "
    )
    one_step = dict(metrics[0]) if metrics else {}
    if one_step_baseline_mae is not None:
        one_step["baselineMae"] = one_step_baseline_mae
    validation_line = (
        f"The n+1 walk-forward test contains {one_step.get('sampleSize', 0)} out-of-sample points, "
        f"with {one_step.get('directionalAccuracy'):.1%} directional accuracy and "
        f"MAE {one_step.get('mae'):.4f} versus persistence MAE "
        f"{one_step.get('baselineMae'):.4f}."
        if isinstance(one_step.get("directionalAccuracy"), (float, int))
        and isinstance(one_step.get("mae"), (float, int))
        and isinstance(one_step.get("baselineMae"), (float, int))
        else "The available history is too short for a stable n+1 out-of-sample comparison."
    )
    summary = (
        current_read + "The most recent post date in the dataset is "
        f"{last_post_day or 'not available'}.\n\n"
        f"\n\nPrice context — "
        f"The asset returned {return_7d:+.2%} over seven daily bars and {return_30d:+.2%} over "
        f"30 daily bars. For the latest week, {alignment}; this is descriptive, not a causal claim. "
        f"Coverage is {len(frame)} daily bars and {post_count} posts from "
        f"{training_dates.iloc[0]} to {training_dates.iloc[-1]} {market_calendar}.\n\n"
        f"Social post coverage — posts span "
        f"{post_coverage['postStartDate'] or 'no usable dates'} to "
        f"{post_coverage['postEndDate'] or 'no usable dates'} across "
        f"{len(post_days)} active post days; {active_price_days} of "
        f"{price_window_days} price days ({coverage_ratio:.1%}) had posts.\n\n"
        f"\n\nModel evidence and cautions — "
        f"{validation_line} The model uses only time-aligned post sentiment, post volume, "
        "lagged price/return/volatility features. Snapshot engagement/followers are excluded from new predictive features. Recent news is fetched "
        "for context only and is excluded from model inputs. Walk-forward results may be unstable when "
        "the post sample is sparse or market conditions change; price forecasts and strategy statistics "
        "are research outputs, not investment advice. Strategy statistics are net of the configured "
        "transaction, slippage, market-impact, and annual borrow-rate assumptions; these are illustrative "
        "inputs and must be replaced with asset-, venue-, and broker-specific costs."
    )
    if warnings:
        summary += " Data limitations: " + " ".join(warnings)

    oos = metrics[0] if metrics else {}
    cost_assumptions = payload.get("costAssumptions")
    performance = strategy_statistics(
        one_step_pred,
        one_step_actual,
        cost_assumptions if isinstance(cost_assumptions, dict) else None,
        365 if is_24_hour_asset(asset_symbol) else 252,
    )
    performance["oneStepSampleSize"] = int(len(one_step_actual))
    performance["baselineMae"] = one_step_baseline_mae
    rl, policy_artifact = evaluate_policy(
        frame, {**DEFAULT_COST_ASSUMPTIONS, **(cost_assumptions or {})},
        365 if market_calendar == "UTC-24/7" else 252, strategy_statistics,
    )
    quality = assess_coverage(frame, posts, payload.get("requestedWindow"))
    outlook_markdown, outlook_html = outlook(asset_symbol, frame, quality, latest_sentiment, label, performance, rl)

    series = []
    for row in frame.tail(180).to_dict(orient="records"):
        series.append(
            {
                "timestamp": row["timestamp"].isoformat().replace("+00:00", "Z"),
                "sessionDate": row["day"].strftime("%Y-%m-%d"),
                "close": float(row["close"]),
                "sentimentScore": float(row["sentimentScore"]),
                "postVolume": int(row["postVolume"]),
                "return1d": safe_float(row["return1d"]),
            }
        )

    aligned_daily_data = [
        {
            "sessionDate": row["day"].strftime("%Y-%m-%d"),
            "timestamp": row["timestamp"].isoformat().replace("+00:00", "Z"),
            "close": float(row["close"]),
            "sentimentScore": float(row["sentimentScore"]),
            "postVolume": int(row["postVolume"]),
            "engagement": float(row["engagement"]),
            "return1d": safe_float(row["return1d"]),
        }
        for row in frame.to_dict(orient="records")
    ]

    return {
        "assetSymbol": payload.get("assetSymbol", ""),
        "status": "ready",
        "hasData": True,
        "lastUpdated": pd.Timestamp.now(tz="UTC").isoformat().replace("+00:00", "Z"),
        "currentPrice": float(frame["close"].iloc[-1]),
        "sentimentScore": latest_sentiment,
        "sentimentLabel": label,
        "postCount": post_count,
        "priceCount": len(frame),
        "series": series,
        "alignedDailyData": aligned_daily_data,
        "marketCalendar": market_calendar,
        "marketTimezone": MARKET_CALENDARS[market_calendar]["timeZone"],
        "marketExchange": market_metadata.get("exchange", asset_symbol),
        "marketCalendarSource": market_metadata.get("source", "ticker"),
        "modelVersion": "session-qlearning-v1",
        "reinforcementLearning": rl,
        "policyArtifact": policy_artifact,
        "dataQuality": quality,
        "outlookMarkdown": outlook_markdown,
        "outlookHtml": outlook_html,
        "forecast": forecast,
        "metrics": metrics,
        "summary": summary,
        "performance": performance,
        "dataWindow": {
            "start": training_dates.iloc[0],
            "end": training_dates.iloc[-1],
        },
        "sentimentCoverage": post_coverage,
        "warnings": warnings,
    }


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        response = run(request)
        sys.stdout.write(json.dumps(response, allow_nan=False))
    except Exception as exc:  # The API receives a structured failure, never a traceback.
        sys.stderr.write(str(exc))
        sys.exit(1)
