To: gilad@crowdwisdomtrading.com

Subject: Quantitative Data Scientist assessment — repository and evaluation

Hello Gilad,

I’m sharing the implementation and evaluation for the CrowdWisdomTrading
X sentiment and price-prediction assessment.

Repository: https://github.com/AmDeep/Tzuroni_Test

The attached Markdown evaluation reports price-forecast accuracy and separate
Q-learning performance, including Sharpe ratio, Sortino ratio, maximum drawdown,
execution costs, fixed-seed results and buy-and-hold comparisons. The attached
one-page outlook states the current evidence and limitations. Actor identifiers
and reproduction steps are included in the provider handoff document and README.
Provider credentials must be delivered separately through an agreed secure
channel; they are not included in the public repository or attachments.

The Python pipeline implements six horizons, n+0 through n+5, exchange-session
alignment, database joins, sentiment-versus-price charts and purged walk-forward
validation. It also includes a genuine Bellman Q-learning policy. Tavily and Exa
news provide context only, separate from sentiment-and-price model inputs.

For transparency, this submission uses an Apify Free account. The actor
returned only ten posts despite the 180-day request. This does not satisfy full
180-day social coverage, and current X sentiment is unavailable. The separate historical evaluation uses the licensed
historical corpus; it is not presented as current sentiment. The measured results
do not demonstrate a profitable or superior trading strategy.

The requirements audit records every implementation item, these data limitations
and the separate secure token handoff explicitly. This submission should not
be interpreted as satisfying the full recent-data coverage requirement.

Regards

---

Owner note: this draft has not been sent. Attach EVALUATION.md,
SENTIMENT_OUTLOOK.md and PROVIDER_HANDOFF.md when responding. Replace the recent
coverage disclosure only after a new collection actually passes coverage checks.
Do not claim credentials were delivered until they were. The assessment's
5–7-day deadline depends on the real assignment start and actual send date;
neither can be established by a draft or a code commit.
