# Assessment submission checklist

## Prepared in this project
- Source pipeline and dependency lockfiles (`pnpm-lock.yaml`, `uv.lock`).
- README with setup, source, actor, algorithms, seeds and verification commands.
- Per-run downloadable Markdown evaluation: Sharpe, Sortino, max drawdown,
  supervised metrics, RL/benchmark results, costs, coverage and source provenance.
- Per-run one-page printable HTML sentiment outlook plus Markdown.
- Saved Q-learning policy artifacts and immutable evaluation history.
- Source published to https://github.com/AmDeep/Tzuroni_Test, preserving the
  repository's initial README and commit history. The publication excludes keys,
  private datasets, agent memory, attachments and workspace history.
- Reviewed Markdown evaluation: `EVALUATION.md`.
- One-page available-evidence outlook: `SENTIMENT_OUTLOOK.md`, explicitly marking
  current sentiment unavailable rather than calling missing posts neutral.
- Actor identifiers and secure token handoff steps: `PROVIDER_HANDOFF.md`.
- Ready-to-copy response with Free-account limitations: `RESPONSE_DRAFT.md`.

## Submission decision

The owner has chosen to use the Apify Free account and submit the available
deliverables with the ten-post limitation disclosed. No upgrade is requested.
The software implements the requested workflow, but this decision does not turn
the limited dataset into qualified 180-day coverage or a supported current
sentiment signal.

## Owner actions to send the package
1. Give the reviewer appropriately scoped provider access through an approved
   secure channel; do not paste account keys into the repository or this document.
   Required providers: Apify, Tavily, Exa. Default actor: `apidojo~tweet-scraper`.
2. Send the response in `RESPONSE_DRAFT.md` with `EVALUATION.md`,
   `SENTIMENT_OUTLOOK.md` and `PROVIDER_HANDOFF.md`; include
   `REQUIREMENTS_AUDIT.md` for the requirement-by-requirement explanation.
   Keep the Free-account and historical-data disclosures.
3. Record the real assignment start/submission
   dates to establish whether the 5–7 day requirement was met.

## What a reviewer can reproduce

- Install the locked dependencies, configure PostgreSQL and provider credentials,
  and run the full application using README.
- Run the six-horizon forecast and actual Q-learning evaluation against their
  supplied CSV inputs without provider APIs, the database or cloud storage.
- Download the cited historical corpus under its terms, prepare its complete
  aggregates, and register it using their own optional cloud storage.
- Inspect source, tests, measured metrics, actor/run identifiers and all caveats.
- A clone does not contain the private workspace database or raw corpus.
  The source data must be supplied/downloaded separately.
- Exact published metrics require the same inputs, dependencies, settings,
  calendars and seeds. A fresh scrape can differ; Free access does not reproduce
  a hypothetical complete recent dataset.

## Email delivery

Recipient: `gilad@crowdwisdomtrading.com`.
Use `RESPONSE_DRAFT.md`; the downloadable package also contains an unsent `.eml`
draft with the Markdown attachments already embedded. No email has been sent.
