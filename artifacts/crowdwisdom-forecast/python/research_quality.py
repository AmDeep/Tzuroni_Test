"""Coverage qualification and a bounded, printable one-page sentiment outlook."""
from __future__ import annotations

import html
import math
import pandas as pd


def assess_coverage(frame, posts, window=None):
    start = pd.Timestamp(window["start"]) if window else frame["day"].min()
    end = pd.Timestamp(window["end"]) if window else frame["day"].max() + pd.Timedelta(days=1)
    start, end = start.tz_convert("UTC"), end.tz_convert("UTC")
    weeks = max(1, math.ceil((end - start).total_seconds() / (7 * 86400)))
    timestamps = pd.to_datetime([p["timestamp"] for p in posts], utc=True, errors="coerce")
    timestamps = timestamps[(timestamps >= start) & (timestamps < end)]
    active = frame.loc[frame["postVolume"] > 0]
    # Corpus aggregates use true session labels and are assessed in that window.
    observed = timestamps if window else pd.DatetimeIndex(active["day"])
    bins = {min(weeks - 1, int((stamp - start).total_seconds() // (7 * 86400))) for stamp in observed if start <= stamp < end}
    ratio = len(active) / len(frame) if len(frame) else 0
    capped = bool(window and len(posts) >= window["maxPosts"])
    warnings = []
    if len(bins) < weeks:
        warnings.append(f"Posts do not cover {weeks - len(bins)} of {weeks} weekly windows.")
    if ratio < 0.8:
        warnings.append(f"Only {ratio:.1%} of price sessions contain posts; research coverage is not qualified.")
    if capped:
        warnings.append("Post ceiling reached; the scrape is a capped sample, not an exhaustive X archive.")
    if frame["day"].max() < pd.Timestamp.now(tz="UTC").floor("D") - pd.Timedelta(days=7):
        warnings.append("Price/sentiment window is historical or stale, not a current trading outlook.")
    return {
        "coverageQualified": ratio >= 0.8 and len(bins) / weeks >= 0.8 and not capped,
        "requestedStart": start.isoformat(), "requestedEnd": end.isoformat(),
        "observedStart": observed.min().isoformat() if len(observed) else None,
        "observedEnd": observed.max().isoformat() if len(observed) else None,
        "coveredWeeks": len(bins), "totalWeeks": weeks,
        "weeklyCoverageRatio": len(bins) / weeks, "activeSessionRatio": ratio,
        "postCapReached": capped, "warnings": warnings,
    }


def outlook(asset, frame, quality, score, label, performance, rl):
    asof = frame["day"].iloc[-1].strftime("%Y-%m-%d")
    stale = frame["day"].iloc[-1] < pd.Timestamp.now(tz="UTC").floor("D") - pd.Timedelta(days=7)
    title = f"{asset}: {'historical' if stale else 'latest available'} sentiment outlook"
    recent, prior = frame.tail(7), frame.iloc[-14:-7]
    recent_count, prior_count = int(recent.postVolume.sum()), int(prior.postVolume.sum())
    sentiment_read = (
        f"Sentiment: {label}, score {score:+.3f}."
        if recent_count else
        "Sentiment: unavailable. No posts were observed in the latest seven sessions; "
        "a zero-filled model feature is not evidence of neutral sentiment."
    )
    paragraphs = [
        f"As of {asof}. {'Historical evaluation—not a current signal.' if stale else 'Latest available daily session; not an intraday forecast.'}",
        f"{sentiment_read} The latest seven sessions contain {recent_count:,} posts versus {prior_count:,} in the prior seven. Text sentiment is descriptive, not proof of price causality.",
        f"Coverage: {int(frame.postVolume.sum()):,} posts across {len(frame):,} price sessions; {quality['activeSessionRatio']:.1%} of sessions and {quality['coveredWeeks']} of {quality['totalWeeks']} weekly windows contain posts. {'Coverage passes the stated research threshold, not an exhaustiveness test.' if quality['coverageQualified'] else 'Coverage does not pass the research threshold; do not treat this as comprehensive sentiment.'}",
        f"Forecast evidence: one-step out-of-sample persistence-baseline MAE is {performance.get('baselineMae')}. Price estimates and empirical intervals are uncertain. n+0 is a held-back latest-session nowcast, not the observed close.",
        f"Reinforcement learning: {rl['method']}; {rl['status']}. The policy learns short/flat/long actions from rewards net of execution and borrow costs. Evaluation uses chronological folds and fixed seeds; price forecasts remain a separate supervised model.",
        "News is separately sourced recent context, excluded from all predictive states and rewards. Consult the linked news panel; news fetched today is not historical as-of evidence.",
        "Limitations: VADER can misread financial language, irony, bots, and selection bias. Snapshot engagement and followers are excluded from new predictive features. Costs and liquidity are illustrative. No guaranteed profitability or recommendation.",
    ]
    markdown = f"# {title}\n\n" + "\n\n".join(paragraphs)
    body = "".join(f"<p>{html.escape(p)}</p>" for p in paragraphs)
    document = f"""<!doctype html><html lang="en"><meta charset="utf-8"><title>{html.escape(title)}</title>
<style>@page{{size:A4;margin:16mm}}*{{box-sizing:border-box}}body{{font:11pt/1.4 system-ui,sans-serif;color:#25313c;max-width:178mm;margin:16mm auto}}h1{{font-size:22pt;line-height:1.2}}p{{margin:0 0 12pt}}footer{{font-size:9pt;border-top:1px solid #aaa;padding-top:8pt}}@media print{{body{{margin:0;max-width:none}}}}</style>
<h1>{html.escape(title)}</h1>{body}<footer>CrowdWisdom Forecast Lab · One-page research outlook · Not investment advice</footer></html>"""
    return markdown, document
