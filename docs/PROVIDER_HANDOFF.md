# Provider access and reproduction handoff

Repository: https://github.com/AmDeep/Tzuroni_Test

## Providers and identifiers actually used

| Provider | Purpose | Required private configuration |
|---|---|---|
| Apify | Dated ticker, cashtag and company-keyword X searches | `APIFY_API_TOKEN`, with access to the actor and sufficient account credits/access |
| Tavily | Recent asset-news context, not model input | `TAVILY_API_KEY` |
| Exa | Complementary news context, not model input | `EXA_API_KEY` |

- Actor name: **`apidojo~tweet-scraper`**.
- Actor resource ID: **`61RPP7dywgiy0JPD0`**.
- Existing limited collection run: **`ghrWLnhsSWY6IrOkX`**.
- Existing limited dataset: **`JWfrw5lnlSDwDhvE2`**.
- Search terms: `TSLA`, `$TSLA`, `Tesla`, combined into dated weekly searches.
- Requested collection: a 180-day window; at most 5,000 posts.
- Received: ten posts, not a qualified 180-day dataset.

Identifiers above are not credentials. Provider retention can expire stored
datasets; a fresh scrape will not reproduce the exact posts from a previous run.
The historical corpus source, locked dependencies, calendars, seeds and execution
cost assumptions are documented in README and EVALUATION.

## Latest access verification

Direct Tavily and Exa calls returned a combined ten TSLA news articles with no
provider errors. Both the saved direct Apify key and the connected Apify account
returned `FREE` and `isPaying=false`.
The previous actor log explicitly restricts Free accounts to ten items.
The owner has chosen to submit using the Free account with this limitation
disclosed. No upgrade or additional collection is required to assemble this
limited-data submission package. It must not be described as a qualified
180-day social dataset. Do not evade the cap with repeated free runs.

## Secure credential delivery — owner action

The assessment explicitly requests provider tokens. This requirement is **not
completed by listing environment-variable names**. No reviewer credentials have
been delivered.

1. Create separate reviewer credentials or grant provider-supported reviewer
   access where available. Use the narrowest permissions and spending limits the
   provider supports; do not assume every provider has fine-grained scopes.
2. Verify each credential against the intended account. For Apify, disclose
   the Free-plan ten-post restriction and check available credits before any run.
3. Share the values privately through an agreed access-controlled secret-sharing
   channel with the reviewer. Do not put them in Git, these reports, screenshots,
   ordinary email, or the downloadable package.
4. Confirm receipt privately, then revoke/rotate temporary credentials after review.

The reviewer sets the three environment variables privately and follows README.
Only after actual secure delivery should the submission checklist mark the token
handoff complete. The package deliberately contains no provider credentials.
