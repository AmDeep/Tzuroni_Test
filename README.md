# Tzuroni_Test

# CrowdWisdom Forecast Lab

Python sentiment/price research with six price horizons and a separate **actual
Q-learning trading policy**. Not investment advice and not a promise of positive
returns.

## Quick start

Assessment handoff: [evaluation](docs/EVALUATION.md),
[one-page outlook](docs/SENTIMENT_OUTLOOK.md),
[provider identifiers and secure access](docs/PROVIDER_HANDOFF.md),
[requirements audit](docs/REQUIREMENTS_AUDIT.md), and
[response draft](docs/RESPONSE_DRAFT.md). The audit explicitly distinguishes
implemented features from incomplete recent data collection and submission.

Requirements: Node 24, pnpm, Python 3.11+, uv, PostgreSQL. From the repository root:

```sh
pnpm install --frozen-lockfile
uv sync --frozen
# Configure variables using your secret manager, never commit their values.
```

The web UI is at `/`, API endpoints at `/api`. Configure the variables below in
your shell or secret manager before starting. For local development, copy
`.env.example` to `.env`, fill the values privately, then export them:

```sh
set -a; . ./.env; set +a
# Use the locked Python environment when the API launches model training.
export PYTHON_BIN="$(uv run --frozen python -c 'import sys; print(sys.executable)')"
pnpm --filter @workspace/db run push
# Terminal 1:
PORT=8080 pnpm --filter @workspace/api-server run dev
# Terminal 2 (same exported environment):
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/crowdwisdom-forecast run dev
```

The web development server proxies `/api` to port 8080. Override
`API_PROXY_TARGET` if needed. Set `PYTHON_BIN` to the Python executable managed by
uv when it is not on PATH. The launcher also recognizes an existing
`.pythonlibs/bin/python`, then falls back to `python3`.

Required configuration:
- `DATABASE_URL`: PostgreSQL, supplied by your secret manager.
- `APIFY_API_TOKEN`: direct Apify API access.
- `TAVILY_API_KEY`: Tavily search access.
- `EXA_API_KEY`: direct Exa API access; required to reproduce the Exa news search.
- Google Cloud Storage and Application Default Credentials are needed only for
  the optional installed historical ZIP archive. CSV evaluation requires neither.
  Never put credentials in a report, source file, Git history, or ordinary email.

The submitted live-data example intentionally uses the Apify Free account.
The actor returned ten posts; this is not full 180-day X coverage. A reviewer
can run the pipeline with their own credentials or supplied historical CSVs.
Read the data limitations before interpreting the results.

## Reproduce an evaluation

1. Start an asset research run in the app. The default Apify actor is
   **`apidojo~tweet-scraper`**. The UI allows another actor, but its input/output
   schema must be compatible.
2. Default lookback is 180 days. Ticker, cashtag and company/keyword searches are
   combined into dated weekly queries. A configured **post ceiling is a ceiling,
   not proof of exhaustive collection**. Check the saved coverage qualification.
3. Or import timestamped posts and one closing price per valid exchange session.
   Choose a calendar explicitly if the ticker is ambiguous. Invalid/nontrading
   session rows and duplicate session prices are rejected, not silently repaired.
4. Or install the licensed historical corpus described below and select one of
   AAPL, AMZN, GOOG, MSFT, TSLA.
5. Select the completed run from history. Download its Markdown evaluation report
   and printable A4 one-page outlook. Old evaluations remain immutable.

All actual actor IDs, actor-run IDs, requested windows, price/post inputs, model
outputs, daily joins and news snapshots are stored per run. Reports record costs,
source provenance and errors. Source endpoints and online datasets can change;
reproduce against the same saved inputs, not a new scrape presented as identical.

## Model and validation

For a portable evaluation without the web app, database or cloud services:

```sh
uv run --frozen python artifacts/crowdwisdom-forecast/python/run_csv.py --asset AAPL \
  --prices /path/to/prices.csv --posts /path/to/posts.csv --calendar XNYS \
  --output generated-artifacts/evaluation.json
```

- Supervised `HistGradientBoostingRegressor`, fixed random state 42; direct
  log-return targets for n+1 through n+5.
- n+0 is a genuine held-back latest-session nowcast from **prior-session inputs**.
  It is not the current observed close or a live intraday nowcast.
- Expanding chronological folds with horizon-dependent purging. Insufficient
  data produces unavailable estimates, not invented forecasts.
- VADER text sentiment, post volume, lagged price/return and volatility only.
  Snapshot engagement/followers are extracted but excluded from new predictive
  states, including sentiment weights. News is separate context only.
- `reinforcement.py` implements tabular **Bellman Q-learning**, not a classifier
  relabelled as RL: short/flat/long actions, prior inventory state, transaction,
  slippage, impact and borrow costs, downside-penalized rewards and TD updates.
- Three expanding folds, one-transition purge, seeds **42, 43, 44**, 50 training
  episodes, learning rate **0.12**, discount **0.95**, downside penalty **0.1**.
  State quantiles fit on training data only; no test-reward updates. The fixed
  seed ensemble is not selected by test performance.
- RL sees prior-session features, executes the next session close and holds one
  session. Compare the same OOS periods against buy-and-hold, cash and lagged
  momentum. All seed results, folds and limitations are reported.
- Full Q tables and fitted quantile boundaries are persisted in each new run's
  model output as `policyArtifact`; the application never executes real trades.

## Historical source

[Top-company historical tweet corpus](https://www.kaggle.com/datasets/omermetinn/tweets-about-the-top-companies-from-2015-to-2020)
(CC0-1.0). The supplied Google Doc is a catalogue, not a raw tweet file.
Download the source ZIP from Kaggle under its access/terms and run:

```sh
uv run --frozen python artifacts/crowdwisdom-forecast/python/prepare_top_company_corpus.py \
  --archive /path/to/source.zip --output /tmp/manifest.json
```

The source contains 3,717,964 unique usable posts. Company associations can overlap.
Views and followers are absent and are not reconstructed. After-close posts can
map to the following exchange session. The dataset is historical
evidence, never a current outlook. The importer records source hash, population,
license and aggregation method. New aggregations do not alter completed runs.

To register the archive and prepared manifest in PostgreSQL and your private
Google Cloud Storage bucket, configure `DEFAULT_OBJECT_STORAGE_BUCKET_ID` and
standard Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`,
workload identity, or an attached service account), then run:

```sh
pnpm --filter @workspace/scripts exec tsx \
  ../artifacts/api-server/src/scripts/register-corpus.ts \
  /path/to/source.zip /tmp/manifest.json
```

To rebuild an already-installed corpus from its private archive:

```sh
pnpm --filter @workspace/scripts exec tsx \
  ../artifacts/api-server/src/tools/rebuild-corpus.ts
```

Large source files, preparation output and exported reports belong in
`generated-artifacts/` (ignored by Git/deployment), not in Git history.

## Verification

```sh
pnpm run typecheck
uv run --frozen pnpm test
# Also exercise real PostgreSQL lease/fencing/rollback fixtures:
RUN_WORKER_DB_TESTS=1 pnpm --filter @workspace/api-server test
```

Tests use fixed estimators and synthetic reward trajectories for deterministic
math, purging, nowcast isolation, Q updates, calendar validation and API contracts.
These tests establish implementation behavior, **not financial performance**.

## Research and operations limits

No guarantee of signal quality, comprehensive X coverage or investment returns.
VADER is not finance-specific; bots, sarcasm and sampling bias remain. Exchange
and provider coverage is finite. Simulated fills and costs are illustrative.
The supervised paper strategy's same-close execution remains idealized; use the
delayed-execution RL comparisons for the separately specified policy.

The API worker must remain running to make progress. Leases/recovery survive
process restarts, but a suspended process cannot train; unattended production
completion needs a continuously running worker deployment. This is an operational
prerequisite, not something a browser poll can guarantee.

## Submission

Repository: https://github.com/AmDeep/Tzuroni_Test

See `docs/REQUIREMENTS_AUDIT.md` for every requirement and its evidence,
`docs/EVALUATION.md` for measured results and limitations, and
`docs/SUBMISSION.md` for the exact email checklist. Tokens belong in a secure
reviewer handoff, never the public repository. The final email has not been sent.
No submission date or deadline compliance is invented.
