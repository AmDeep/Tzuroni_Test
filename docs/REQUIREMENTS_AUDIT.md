# Assessment requirements audit

Reference: **CrowdWisdomTrading X Sentiment Price Prediction agent — Intern
position assessment**, supplied by the applicant. This maps every requirement;
implemented capability is not the same as completed data collection or submission.

Historical-source catalogue supplied by the assessment:
https://docs.google.com/document/d/1w-Y86OjkiOjlIIth0VgTAohql9zcGi3uoDNYTaTsZuw/edit

## Scope and technical requirements

| Document requirement | Implementation / evidence | Status |
|---|---|---|
| Python ML / reinforcement-learning pipeline | `python/forecast.py`, `python/reinforcement.py`, portable `python/run_csv.py` under `artifacts/crowdwisdom-forecast/` | Implemented; genuine Bellman Q updates, not a renamed classifier |
| Chosen asset; X sentiment and price only | Any supported ticker, one at a time; VADER, post volume, lagged prices/returns/volatility. News and retrospective engagement/followers excluded from predictive features | Implemented, subject to provider and exchange coverage |
| Historical tweets linked through the Google Doc | The linked document is a dataset catalogue. The selected CC0 historical top-company source is installed and fully aggregated; 3,717,964 usable source posts, five companies | Historical training implemented, not recent 180-day data; historical views/followers absent |
| Apify ticker, cashtag and keyword searches | `buildAssetSearchTerms`, `buildWindowedSearchTerms`, `/api/research/runs`; default `apidojo~tweet-scraper` | Implemented; terms combined into weekly dated searches |
| Last 180 days of X posts and matching historical prices | Configurable 180-day request and bounded post count; actual weekly/session coverage measured and saved | **Data limitation accepted for this submission, not requirement fulfillment:** Free account returned 10 posts, 1/26 weeks, 2/124 price sessions; matching prices were collected |
| Timestamps, text, likes, reposts, views, author followers | `normalizeApifyPosts`; timestamped post records in PostgreSQL | Extractor implemented. Fields absent from a source cannot be reconstructed; the historical corpus lacks views/followers |
| UTC/EST alignment to price bars | Exchange calendars and close-aware local session mapping with daylight-saving transitions; explicit CSV calendar choice; reject holidays and duplicates | Implemented. Other supported markets use their own timezones |
| Join datasets in a database | Per-run raw inputs plus normalized `research_daily_features` joined session rows; run-linked news snapshots | Implemented; Python computes the alignment and PostgreSQL persists it |
| Most recent relevant Tavily news | Per-run and on-demand news, cached by asset with source links, timestamps and provider errors | Direct Tavily API implemented. Recent news is context only; never misrepresented as historical-as-of news |
| Exa included in submission | Direct Exa search, deduplication and independent provider error reporting | Configured and verified: live TSLA news request returned 10 combined articles from Exa and Tavily with no provider errors. Uses `EXA_API_KEY`; no hosted connector dependency. Reviewer credential handoff remains separate |
| Time-based feature engineering | Text sentiment, post count, lagged returns, rolling volatility and price features; direct horizon targets | Implemented; snapshot engagement excluded to prevent leakage |
| One-page current sentiment outlook | Per-run A4 HTML and Markdown exports; historical, sparse and stale labels; reviewed `SENTIMENT_OUTLOOK.md` | Available-evidence outlook delivered; new reports label zero recent posts unavailable, not neutral. A well-covered current X sentiment signal is not established |
| Prices at n+0 through n+5 | Six displayed horizons; n+0 is a prior-input, held-back latest-session estimate; direct models for n+1…n+5 | Implemented. n+0 is not live intraday prediction; insufficient data is unavailable, not fabricated |
| Rigorous out-of-sample / walk-forward validation | Expanding folds, horizon purge; training-only quantile states and frozen RL test policies; fixed seeds, delayed RL execution and baselines | Implemented. Results are research evidence, not a profitability guarantee |
| Charts of X sentiment against price over time | Dashboard price/sentiment time-series chart and horizon/metric matrices | Implemented in `src/App.tsx`; visual chart requires the web app |

## Required submission items

| Exact document item | Evidence / remaining action | Status |
|---|---|---|
| GitHub/GitLab link | https://github.com/AmDeep/Tzuroni_Test | Published; source, lockfiles, setup, examples, tests and audit |
| APIFY/Tavily/Exa tokens and actor IDs for reproduction | `.env.example`, README, `PROVIDER_HANDOFF.md`, actor `apidojo~tweet-scraper` / `61RPP7dywgiy0JPD0`, and actual run/dataset IDs. Reviewer keys must be provided privately, not in public source or ordinary email | **Actor IDs documented; reviewer token handoff NOT completed** |
| PDF or Markdown evaluation with Sharpe, Sortino and Max Drawdown | `docs/EVALUATION.md` is a reviewed Markdown report with measured results and limitations. The app exports full per-run reports | Included; results do not show RL beating buy-and-hold |
| Submission by email to `gilad@crowdwisdomtrading.com`, including Apify/Tavily/Exa | `RESPONSE_DRAFT.md` and packaged unsent `.eml` with attachments; send repository link and reports, arrange secure provider access | Prepared for owner to send; **NOT SENT** |
| Complete within one week / 5–7 days | No authoritative assignment start date and final sent timestamp have been supplied | **Cannot establish compliance** |

## Reproduction boundaries

- Start with `README.md`; no account keys or private input archives are committed.
- `python/run_csv.py` can evaluate supplied CSVs without the web app, database or cloud storage.
- The optional historical archive uses standard Google Cloud Storage Application
  Default Credentials. A fresh clone does not contain private database state or
  the large source archive; download the cited source and register it as documented.
- Deployment must keep the API worker running for unattended completion.
- Historical test metrics are not current signals. News fetched now is not evidence
  that those articles were available during the historical test period.
- The owner has chosen Free-account submission with explicit limitations; no
  further account upgrade is requested. This changes the submission decision,
  not the measured social coverage.
- **The assessment is not fully submitted or fully data-qualified yet.** Do not
  replace these outstanding items with a blanket “all requirements satisfied.”
