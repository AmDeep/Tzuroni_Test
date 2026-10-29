# TSLA — sentiment evidence and outlook

**Exchange timezone: America/New_York. Current X sentiment: UNAVAILABLE.**

## Current assessment

The latest seven evaluated sessions contain **zero observed X posts**, as do
the preceding seven. There is therefore no defensible bullish, bearish or neutral
current X sentiment classification, and no observed sentiment change to compare
with price. Zero-filled sentiment features are missing-data handling, not evidence
of neutral investor opinion. This document is the available-evidence outlook;
it does **not** satisfy a well-covered current sentiment outlook.

Price-only context in the saved evaluation is a **+9.82%** change over seven
sessions and **+12.89%** over thirty sessions. Those price changes do not establish
what investors currently say on X and are not a causal sentiment finding.

## Coverage and sources

The Apify request covered a 180-day window with a 5,000-post ceiling.
It returned **10 posts**, mapped to just two exchange sessions.
Only **2 of 124 sessions (1.6%)** and
**1 of 26 weekly windows** have posts. The actor explicitly reported a Free-plan
ten-item limit. This submission intentionally uses that Free-account result.
The request window is not the observed data window.

Tavily and Exa are operational: a live combined TSLA news request returned ten
articles with no provider errors. News is separately sourced context, never a
predictive feature, a substitute for missing X posts, or historical-as-of evidence.

## Model evidence and decision

The recent run's n+1 walk-forward MAE was **10.1597**, worse than the persistence
baseline's **8.2718**, with **45.9%** directional accuracy. Its separate Q-learning
policy returned **−35.01% net**, Sharpe **−2.8551**, Sortino **−3.2108** and maximum
drawdown **−35.81%**. These results do not support deploying a sentiment strategy.
The historical CC0 evaluation is useful for training/testing but is not current.

The pipeline supports n+0 through n+5; n+0 is a held-back latest-session estimate,
not an observed close relabeled as a forecast or a live intraday prediction.
Illustrative commission, slippage, impact and borrow costs are included in policy
evaluation. VADER errors, bots, sampling bias, regime change and liquidity remain
limitations. No investment recommendation is made.

**Submission decision:** provide this available-evidence outlook with the
Free-account limitation disclosed. Establishing a qualified current signal would
require an adequately distributed 180-day X sample, verified returned dates and
fields, and regenerated forecasts and validation. That evidence is not claimed.
Preserved
older reports may call a zero-filled score neutral; new reports explicitly
distinguish an unavailable observation from observed neutral text.
