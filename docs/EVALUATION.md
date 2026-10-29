# Sentiment/price forecasting and Q-learning evaluation

## Scope

This is a reviewed Markdown evaluation, not a claim of investable performance.
All figures below are from completed saved evaluations. The app
provides full per-run Markdown reports with horizon metrics, provenance, coverage,
news context, costs, fold windows and every seed result.

## Data and validation

Historical TSLA evaluation: 1,096,868 source posts and 1,259 XNYS price sessions.
The licensed CC0 source is
[Top-company historical tweet corpus](https://www.kaggle.com/datasets/omermetinn/tweets-about-the-top-companies-from-2015-to-2020).
The full cross-company preparation processes 3,717,964 unique usable posts, not
a small sample. The Google Doc supplied with the assessment is a dataset catalogue.
Historical views/followers are absent. Retrospective engagement is not a predictive
weight or feature. This dataset is historical, not the latest 180 days.

Price forecasts use VADER text sentiment, post volume and lagged price/return/
volatility features with `HistGradientBoostingRegressor`, random state 42.
Targets are direct horizon log returns; expanding chronological folds purge
horizon overlap. n+0 withholds the latest session and uses only prior inputs:
estimated close **27.6604**, observed close **28.6840**. This is a held-back
nowcast, not a live intraday forecast. n+1 through n+5 are separately estimated;
the app/report shows MAE, RMSE, R² and directional accuracy for each horizon.

Recorded estimates as of the historical endpoint (not current targets):

| Horizon | Estimated close | Empirical residual interval |
|---|---:|---:|
| n+0 | 27.66 | 26.71–28.61 |
| n+1 | 28.80 | 27.82–29.78 |
| n+2 | 28.27 | 26.75–29.68 |
| n+3 | 27.92 | 26.10–29.64 |
| n+4 | 27.82 | 25.63–29.97 |
| n+5 | 27.56 | 25.21–30.02 |

Out-of-sample price-forecast metrics:

| Horizon | MAE | RMSE | R² | Directional accuracy | Samples |
|---|---:|---:|---:|---:|---:|
| n+1 | 0.4173 | 0.5874 | −0.1445 | 49.90% | 1,030 |
| n+2 | 0.6067 | 0.8429 | −0.1701 | 51.26% | 1,030 |
| n+3 | 0.7661 | 1.0444 | −0.1893 | 53.69% | 1,030 |
| n+4 | 0.9041 | 1.2079 | −0.1965 | 49.37% | 1,025 |
| n+5 | 1.0310 | 1.3627 | −0.2221 | 48.88% | 1,025 |

MAE/RMSE are in price units. Negative R² and near-chance direction accuracy are
reported, not hidden. These forecasts do not establish predictive superiority.
Residual intervals are empirical estimates, not guaranteed coverage bounds.

The RL policy is tabular Bellman Q-learning, with short/flat/long actions,
training-only quantile states and previous inventory. Fifty training episodes
per seed, learning rate 0.12, discount 0.95, downside penalty 0.1, fixed seeds
42/43/44. Three expanding folds use a one-transition purge; test policies are
frozen and never updated using test rewards. The fixed median-vote ensemble is
not selected from the best-performing seed.

Policy decisions use prior-session features, execute at the next session close,
and earn the following session return. Costs are 1 bp commission, 3 bp slippage,
1 bp impact per one-way unit turnover, plus 300 bp annual short borrow.
Statistics use 252 sessions/year; these costs are illustrative, not broker quotes.

## Historical out-of-sample policy results

Evaluation sample: **939 out-of-sample sessions**.
Both policy and benchmarks use the same held-out observations and cost assumptions.

| Policy | Net return | Sharpe ratio | Sortino ratio | Max drawdown |
|---|---:|---:|---:|---:|
| Fixed-seed Q-learning ensemble | +3.89% | 0.1576 | 0.2444 | −34.19% |
| Buy-and-hold | +71.99% | 0.5453 | 0.8075 | −53.51% |

Seed net returns: **42: −7.90%; 43: +14.78%; 44: +24.73%**.
All are disclosed rather than reporting only the best seed. Ensemble gross
return was +29.82%; net return after modeled costs was +3.89%.

**Conclusion:** the RL policy is genuinely trained, but did **not** outperform
buy-and-hold. Lower drawdown in this sample does not establish superiority,
statistical significance, or a deployable trading edge.

## Recent collection and adverse result

A real request asked Apify for 180 days and up to 5,000 TSLA posts. It returned
only **10 posts**, covering **1/26 weekly windows** and **2/124 price sessions
(1.6%)**. The actor reported an account-plan restriction. Requesting a date window
is not proof that the returned dataset covers it. This run is **unqualified**.

The resulting 87-session RL test produced:

| Policy | Net return | Sharpe ratio | Sortino ratio | Max drawdown |
|---|---:|---:|---:|---:|
| Q-learning ensemble, insufficient social coverage | −35.01% | −2.8551 | −3.2108 | −35.81% |
| Buy-and-hold, same period | +7.65% | 0.6754 | 0.9500 | −29.86% |

This adverse result is not omitted. It must not be presented as a validated
sentiment strategy. A new qualified recent collection is needed after provider
access is resolved; do not relabel the historical evaluation as current.

## Limitations and reproduction

- VADER can misread finance-specific language, sarcasm, spam and bots.
- Missing views/followers are not reconstructed. Engagement observed retrospectively
  cannot be used as though it were available at the historical decision time.
- No tick-level execution, liquidity constraints or calibrated market-impact model.
- Seed variation, regime change, sampling bias and multiple-testing risk remain.
- News is separate context, not a model input. Current news in a historical
  report is explicitly not historical-as-of evidence.
- Old completed evaluations are retained unchanged when methods or assumptions change.
- Full Q tables and fitted boundaries are saved as policy artifacts for new runs.
- Reproduce with the README, the cited source or supplied CSVs, locked dependencies,
  fixed seeds, identical calendars and cost assumptions. A fresh scrape is not
  identical to the saved input dataset.
