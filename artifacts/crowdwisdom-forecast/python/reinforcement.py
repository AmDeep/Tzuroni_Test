"""Seeded, cost-aware tabular Q-learning with strictly chronological evaluation.

No policy sees a test reward while training. States available at session t-1
choose a position executed at session t's close, earning t -> t+1 returns.
"""
from __future__ import annotations

import numpy as np
from sklearn.model_selection import TimeSeriesSplit

STATE_COLUMNS = ["sentimentScore", "returnLag5", "volatility20", "volumeLog"]
SEEDS = [42, 43, 44]
EPISODES = 50
ACTIONS = np.array([-1, 0, 1])


def fit_policy(x, returns, costs, annualization, seed, episodes=EPISODES):
    """Learn a Bellman Q table; thresholds are fitted on training states only."""
    edges = np.quantile(x, [1 / 3, 2 / 3], axis=0)
    states = encode(x, edges)
    q = np.zeros((81, 3, 3))
    rng = np.random.default_rng(seed)
    execution = sum(costs[k] for k in ("transactionCostBps", "slippageBps", "marketImpactBps")) / 10000
    borrow = costs["annualBorrowRateBps"] / 10000 / annualization
    updates = 0
    for episode in range(episodes):
        previous = 1  # Flat inventory is part of the Markov state.
        epsilon = max(0.03, 0.35 * (1 - episode / episodes))
        for t, state in enumerate(states):
            values = q[state, previous]
            action = int(rng.integers(3)) if rng.random() < epsilon else greedy(values)
            net = ACTIONS[action] * returns[t] - abs(ACTIONS[action] - ACTIONS[previous]) * execution
            net -= borrow if action == 0 else 0
            terminal = t == len(states) - 1
            if terminal:
                net -= abs(ACTIONS[action]) * execution
            # Fixed downside penalty, never selected on test results.
            reward = 100 * net - 0.1 * min(100 * net, 0) ** 2
            target = reward if terminal else reward + 0.95 * np.max(q[states[t + 1], action])
            q[state, previous, action] += 0.12 * (target - q[state, previous, action])
            previous = action
            updates += 1
    return {"q": q, "edges": edges, "updates": updates}


def encode(x, edges):
    bins = (x > edges[0]).astype(int) + (x > edges[1]).astype(int)
    return (bins * np.array([1, 3, 9, 27])).sum(axis=1).astype(int)


def greedy(values):
    # An unvisited or tied state stays flat rather than taking arbitrary shorts.
    return 1 if values[1] == np.max(values) else int(np.argmax(values))


def act(policy, x, previous=1):
    positions = []
    for state in encode(x, policy["edges"]):
        previous = greedy(policy["q"][state, previous])
        positions.append(int(ACTIONS[previous]))
    return np.asarray(positions)


def evaluate_policy(frame, costs, annualization, statistics):
    execution = "Prior-session features; execute next-session close; hold one session. Test policies frozen; no test-reward updates."
    base = {"method": "Tabular Q-learning (Bellman TD control)", "execution": execution,
            "episodes": EPISODES, "seeds": SEEDS,
            "limitations": ["Simulated fills and illustrative costs; no live trading.",
                             "A profitable policy is not guaranteed. No test-set policy selection.",
                             "Quantile states may be unseen in new regimes; ties remain flat."]}
    # One full session of execution delay prevents use of a close before filling at it.
    lagged = frame[STATE_COLUMNS].shift(1)
    future = frame["close"].shift(-1) / frame["close"] - 1
    valid = lagged.notna().all(axis=1) & future.notna()
    x = lagged.loc[valid].to_numpy(dtype=float)
    returns = future.loc[valid].to_numpy(dtype=float)
    dates = frame.loc[valid, "day"].dt.strftime("%Y-%m-%d").to_numpy()
    if len(returns) < 60:
        return {**base, "status": "insufficient", "reason": "At least 60 usable delayed-execution transitions are required.", "sampleSize": 0, "folds": 0}, None
    splitter = list(TimeSeriesSplit(n_splits=3, gap=1).split(x))
    indices = np.concatenate([test for _, test in splitter])
    all_positions = []
    seed_results = []
    for seed in SEEDS:
        positions = []
        for train, test in splitter:
            policy = fit_policy(x[train], returns[train], costs, annualization, seed)
            previous = int(positions[-1]) + 1 if positions else 1
            positions.extend(act(policy, x[test], previous).tolist())
        positions = np.asarray(positions)
        all_positions.append(positions)
        stats = statistics(positions, np.log1p(returns[indices]), costs, annualization)
        seed_results.append({"name": f"Seed {seed}", "metrics": stats})
    # Majority vote, specified before any test results. No best-seed cherry picking.
    ensemble = np.median(np.asarray(all_positions), axis=0)
    metrics = statistics(ensemble, np.log1p(returns[indices]), costs, annualization)
    benchmarks = []
    for name, positions in [
        ("Buy and hold", np.ones(len(indices))),
        ("Cash", np.zeros(len(indices))),
        ("Lagged momentum", np.sign(x[indices, 1])),
    ]:
        benchmarks.append({"name": name, "metrics": statistics(positions, np.log1p(returns[indices]), costs, annualization)})
    final_policies = [fit_policy(x, returns, costs, annualization, seed) for seed in SEEDS]
    latest = frame[STATE_COLUMNS].iloc[[-1]].to_numpy(dtype=float)
    selected = int(np.median([act(policy, latest)[0] for policy in final_policies]))
    artifact = {
        "version": 1, "stateColumns": STATE_COLUMNS, "seeds": SEEDS,
        "learningRate": 0.12, "discount": 0.95, "downsidePenalty": 0.1,
        "policies": [{"q": p["q"].tolist(), "edges": p["edges"].tolist(),
                      "updates": p["updates"]} for p in final_policies],
    }
    return {
        **base, "status": "ready", "reason": "Three purged expanding folds; fixed three-seed ensemble.",
        "sampleSize": len(indices), "folds": 3, "metrics": metrics,
        "seedResults": seed_results, "benchmarks": benchmarks,
        "testStart": str(dates[indices[0]]), "testEnd": str(dates[indices[-1]]),
        "selectedAction": {-1: "short", 0: "flat", 1: "long"}[selected],
        "beatsBuyHold": metrics["netTotalReturn"] > benchmarks[0]["metrics"]["netTotalReturn"],
        "foldWindows": [{"trainEnd": str(dates[train[-1]]), "testStart": str(dates[test[0]]),
                         "testEnd": str(dates[test[-1]])} for train, test in splitter],
    }, artifact
