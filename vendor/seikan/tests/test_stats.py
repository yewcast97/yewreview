"""Statistics tests with known inputs.

Every statistic in ``analysis.stats`` is NOMINAL and per-cell: nothing here selects, ranks or
search-corrects a cell, so these tests pin measurement arithmetic and independence — never a
winner, a family-wise correction, or an inferential verdict.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from scipy import stats as sps

from seikan.analysis.stats import (
    ASSOC_MIN_N,
    BUCKET_MIN_N,
    EPISODE_LIST_MAX,
    STATISTICS_VERSION,
    _bucket_monotonicity,
    _fwd_ffts,
    _rotation_means,
    _rotation_num_den,
    _tail_p,
    baseline_summary,
    cell_conditional_buckets,
    concentration,
    conditional_buckets,
    cscv_pbo,
    episode_bootstrap_ci,
    episode_ledger,
    episode_stats,
    feature_outcome_association,
    independent_count,
    newey_west_mean,
    overlap_clusters,
    pool_quantiles,
    pooled_reliability_summary,
    reliability_summary,
    subperiod_edges,
    subperiod_means,
    summarize,
    summarize_table,
)


def _episodes(rets, bars_held=None, reasons=None, feature=None) -> pd.DataFrame:
    n = len(rets)
    data = {
        "ret": rets,
        "bars_held": bars_held if bars_held is not None else [5] * n,
        "exit_reason": reasons if reasons is not None else ["horizon"] * n,
    }
    if feature is not None:
        data["feat"] = feature
    return pd.DataFrame(data)


def test_statistics_version_is_stamped():
    assert STATISTICS_VERSION == 1


# ---- summarize: one pool's descriptives ------------------------------------


def test_summarize_basic():
    rets = [0.01, -0.02, 0.03, 0.04, -0.01]
    s = summarize(_episodes(rets))
    assert s["n"] == 5 and s["n_valid"] == 5
    assert s["mean_ret"] == pytest.approx(np.mean(rets))
    assert s["hit_rate"] == pytest.approx(3 / 5)
    t_ref, p_ref = sps.ttest_1samp(rets, 0.0)
    assert s["t_iid"] == pytest.approx(t_ref)
    assert s["p_iid"] == pytest.approx(p_ref)
    wins = [r for r in rets if r > 0]
    losses = [r for r in rets if r < 0]
    assert s["win_loss_ratio"] == pytest.approx(np.mean(wins) / abs(np.mean(losses)))
    assert s["skewness"] == pytest.approx(sps.skew(np.asarray(rets, dtype=float)))
    # no equity-curve framing and no iid bootstrap CI: the observer measures a pool, not a curve
    assert not (
        {"total_ret", "ann_factor", "mean_ret_annualized", "boot_ci_lo", "boot_ci_hi"} & s.keys()
    )


def test_summarize_empty():
    s = summarize(pd.DataFrame({"ret": [], "bars_held": [], "exit_reason": []}))
    assert s["n"] == 0
    assert np.isnan(s["mean_ret"])


def test_summarize_drops_nan_returns():
    s = summarize(_episodes([0.01, float("nan"), 0.03]))
    assert s["n"] == 3 and s["n_valid"] == 2
    assert s["mean_ret"] == pytest.approx(0.02)


def test_summarize_shape_metrics_known_answers():
    # kurtosis (Pearson) of [1,2,3,4]: m2=1.25, m4=2.5625 → 2.5625/1.5625 = 1.64
    s = summarize(_episodes([1.0, 2.0, 3.0, 4.0]))
    assert s["kurtosis"] == pytest.approx(1.64)
    rets = list(np.linspace(-0.05, 0.05, 100))
    s = summarize(_episodes(rets))
    p5, p95 = np.percentile(rets, [5, 95])
    assert s["tail_ratio"] == pytest.approx(abs(p95 / p5))
    assert s["cvar_5"] == pytest.approx(np.mean([r for r in rets if r <= p5]))


# ---- pool_quantiles: the five-point shape read ------------------------------


def test_pool_quantiles_hand_computed_linear_interpolation():
    # The interpolation rule is part of the contract, not an implementation detail: p50 must be the
    # same median `summarize` reports and the shoulders the same rule `summarize`'s p5/p95 and the
    # episode bootstrap's CI use, or two blocks of one report would disagree about the same pool.
    # np.percentile's default linear rule on [1..10] (index = p/100 · 9):
    #   p10 → 0.9  → 1 + 0.9·(2−1)  = 1.9      p25 → 2.25 → 3 + 0.25·(4−3) = 3.25
    #   p50 → 4.5  → 5 + 0.5·(6−5)  = 5.5      p75 → 6.75 → 7 + 0.75·(8−7) = 7.75
    #   p90 → 8.1  → 9 + 0.1·(10−9) = 9.1
    q = pool_quantiles(np.arange(1, 11, dtype=float))
    assert q == {"p10": 1.9, "p25": 3.25, "p50": 5.5, "p75": 7.75, "p90": 9.1}


def test_pool_quantiles_single_observation_is_that_observation_five_times():
    # An n=1 pool has no shape to read: every point IS the one observation. The block reports it
    # rather than refusing, because the count that qualifies it rides alongside (`mae_quantiles.n`)
    # or IS the pool (`ret_quantiles` has no n of its own — it is the cell's n).
    q = pool_quantiles(np.array([0.042]))
    assert q == {"p10": 0.042, "p25": 0.042, "p50": 0.042, "p75": 0.042, "p90": 0.042}


def test_pool_quantiles_empty_pool_is_five_nans_never_zero():
    # "No evidence" must serialize to null, never to 0.0 — a zero quantile reads as a measured
    # outcome and would let a cell that fired nothing look like a cell that fired flat.
    q = pool_quantiles(np.array([]))
    assert set(q) == {"p10", "p25", "p50", "p75", "p90"}
    assert all(np.isnan(v) for v in q.values())


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_pool_quantiles_drops_non_finite_values(bad):
    # THE property the excursion blocks depend on: an `mae`/`mfe` censored by a window hole is NaN
    # on a row whose `ret` closed, so a poisoned pool must read exactly like the pool without it —
    # not NaN throughout (one hole erasing the block), and not zero-filled (a hole minting a mark).
    # ±inf gets the same treatment: it is unmeasurable, not an extreme observation.
    clean = np.array([1.0, 2.0, 3.0, 4.0])
    poisoned = np.array([1.0, bad, 2.0, 3.0, bad, 4.0])
    assert pool_quantiles(poisoned) == pool_quantiles(clean)
    assert pool_quantiles(poisoned)["p50"] == pytest.approx(2.5)


def test_pool_quantiles_points_are_ordered():
    # Order statistics are ordered by construction; pinning it is what makes a reader's "the p10
    # shoulder" reading of the block safe without re-sorting it.
    rng = np.random.RandomState(19)
    for _ in range(20):
        q = pool_quantiles(rng.randn(int(rng.randint(2, 200))) * 0.03)
        assert q["p10"] <= q["p25"] <= q["p50"] <= q["p75"] <= q["p90"]


# ---- baseline_summary: the statistical half of a baseline row ----------------


def test_baseline_summary_hand_computed_and_key_set_pins_the_seam():
    # The key set IS the seam contract: baseline_summary owns exactly the fields the return
    # array can carry; n_anchor_bars and the exclusions breakdown are the RUNNER'S count fields
    # (properties of the anchor geometry), mounted beside these — never computed here.
    rets = np.array([0.01, -0.02, 0.03, 0.04])
    b = baseline_summary(rets)
    assert set(b) == {
        "n_eligible", "mean_ret", "std_ret", "hit_rate",
        "ret_quantiles", "worst_ret", "best_ret",
    }
    assert b["n_eligible"] == 4
    assert b["mean_ret"] == pytest.approx(0.015)
    assert b["std_ret"] == pytest.approx(float(np.std(rets, ddof=1)))
    assert b["hit_rate"] == pytest.approx(0.75)
    assert b["ret_quantiles"] == pool_quantiles(rets)  # same interpolation rule, p50 = median
    assert b["worst_ret"] == pytest.approx(-0.02)
    assert b["best_ret"] == pytest.approx(0.04)


def test_baseline_summary_empty_pool_is_all_null_never_zeros():
    # A zero base rate is a MEASURED outcome; a pool with no observations measured nothing.
    b = baseline_summary(np.array([]))
    assert b["n_eligible"] == 0  # the one honest zero: a count, not a statistic
    for k in ("mean_ret", "std_ret", "hit_rate", "worst_ret", "best_ret"):
        assert np.isnan(b[k])
    assert all(np.isnan(v) for v in b["ret_quantiles"].values())


def test_baseline_summary_drops_non_finite_and_counts_only_what_it_described():
    dirty = np.array([0.01, float("nan"), 0.03, float("inf"), float("-inf")])
    assert baseline_summary(dirty) == baseline_summary(np.array([0.01, 0.03]))
    assert baseline_summary(dirty)["n_eligible"] == 2


def test_baseline_summary_single_observation_has_no_dispersion():
    b = baseline_summary(np.array([0.02]))
    assert b["n_eligible"] == 1 and b["mean_ret"] == pytest.approx(0.02)
    assert np.isnan(b["std_ret"])  # one observation has no dispersion — null, never 0.0
    assert b["worst_ret"] == pytest.approx(0.02) and b["best_ret"] == pytest.approx(0.02)


def test_baseline_summary_is_pool_agnostic_under_concatenation():
    # The basket pooled row is the SAME function over the concatenated (bar × member) eligible
    # observations — nothing in it knows which pool it is describing, so concatenation order
    # cannot move any field.
    a = np.array([0.01, -0.02, 0.03])
    b = np.array([0.005, 0.02])
    pooled = baseline_summary(np.concatenate([a, b]))
    swapped = baseline_summary(np.concatenate([b, a]))
    assert pooled == swapped
    assert pooled["n_eligible"] == 5


# ---- summarize_table: the grid breakdown, and NOTHING pooled ---------------


def _grid_trades() -> pd.DataFrame:
    """Two cells (horizon 3 and 7) over one target, with an entry-time feature column."""
    rng = np.random.RandomState(0)
    rows = []
    for h in (3, 7):
        for i in range(40):
            rows.append(
                {
                    "horizon": h,
                    "target": "t",
                    "ret": float(rng.normal(0.001, 0.01)),
                    "bars_held": h,
                    "exit_reason": "horizon",
                    "feat": float(i),
                }
            )
    return pd.DataFrame(rows)


def test_summarize_table_emits_exactly_the_grid_keys_and_no_pooled_headline():
    # THE identity invariant at the statistics layer: a grid has no single headline, so
    # summarize_table publishes only per-cell rows and rollups. Spreading a pooled mean /
    # hit-rate / t-stat across the top level would invite reading one number as "the result".
    # No pooled panels either (conditional_buckets / bucket_monotonicity): a pooled qcut is
    # grid-composition-dependent — dishonest conditioning, not redundancy — and the per-cell
    # read is cell_conditional_buckets.
    out = summarize_table(_grid_trades(), ["horizon"], ["t"])
    assert set(out) == {
        "stats_table",
        "by_target",
        "by_param",
        "params",
        "targets",
        "n_stats_rows",
    }
    assert out["n_stats_rows"] == 2 and out["params"] == ["horizon"] and out["targets"] == ["t"]
    assert set(out["by_param"]["horizon"]) == {3, 7}


@pytest.mark.parametrize(
    "pooled_key",
    [
        "n", "n_valid", "mean_ret", "hit_rate", "t_iid", "p_iid", "win_loss_ratio",
        "skewness", "kurtosis", "tail_ratio", "cvar_5", "mean_bars_held",
        "median_bars_held", "max_bars_held", "median_ret", "std_ret", "exit_reasons",
        "conditional_buckets", "bucket_monotonicity",
    ],
)
def test_summarize_table_does_not_spread_a_pooled_scalar(pooled_key):
    # Named one-by-one so a regression says exactly which scalar — or which pooled panel — leaked
    # to the top level.
    assert pooled_key not in summarize_table(_grid_trades(), ["horizon"], ["t"])


def test_summarize_table_rows_carry_their_own_descriptives():
    trades = _grid_trades()
    out = summarize_table(trades, ["horizon"], ["t"])
    for row in out["stats_table"]:
        cell = trades[(trades["horizon"] == row["horizon"]) & (trades["target"] == row["target"])]
        assert row["n"] == len(cell)
        assert row["mean_ret"] == pytest.approx(cell["ret"].mean())


def test_summarize_table_rows_surface_the_full_descriptive_set():
    # The table rows carry EVERY descriptive `summarize` computes — the shape and holding-path
    # metrics included — each equal to summarize() of that pool.
    trades = _grid_trades()
    out = summarize_table(trades, ["horizon"], ["t"])
    full = ["median_ret", "std_ret", "kurtosis", "tail_ratio", "cvar_5",
            "median_bars_held", "max_bars_held"]
    assert out["stats_table"]
    for row in out["stats_table"]:
        cell = trades[(trades["horizon"] == row["horizon"]) & (trades["target"] == row["target"])]
        s = summarize(cell)
        for m in full:
            assert m in row
            assert row[m] == pytest.approx(s[m], nan_ok=True)


def test_summarize_table_empty_pool_is_an_empty_grid_not_an_error():
    out = summarize_table(pd.DataFrame(columns=["horizon", "target", "ret"]), ["horizon"], ["t"])
    assert out["stats_table"] == [] and out["n_stats_rows"] == 0
    assert out["by_target"] == {} and out["by_param"] == {}


# ---- conditional buckets + monotonicity ------------------------------------


def test_conditional_buckets_monotone():
    # ret increases with feature → bucket mean_ret should be increasing
    feat = np.linspace(0, 1, 100)
    rets = feat * 0.1
    ep = _episodes(list(rets), feature=list(feat))
    table = conditional_buckets(ep, "feat", q=4)
    assert len(table) == 4
    assert table["mean_ret"].is_monotonic_increasing
    assert table["n"].sum() == 100


def test_conditional_buckets_missing_feature_raises():
    with pytest.raises(KeyError):
        conditional_buckets(_episodes([0.01, 0.02]), "nope")


def _recs(means: list[float], n: int = 10) -> list[dict]:
    return [{"bucket": str(i), "n": n, "mean_ret": m, "hit_rate": 0.5} for i, m in enumerate(means)]


def test_bucket_monotonicity_increasing_is_rho_one():
    mono = _bucket_monotonicity(_recs([-0.02, 0.0, 0.01, 0.03]))
    assert mono is not None and mono["rho"] == pytest.approx(1.0) and mono["sign"] == 1


def test_bucket_monotonicity_decreasing_is_rho_negative_one():
    mono = _bucket_monotonicity(_recs([0.03, 0.01, 0.0, -0.02]))
    assert mono["rho"] == pytest.approx(-1.0) and mono["sign"] == -1


def test_bucket_monotonicity_non_monotone_is_weak():
    mono = _bucket_monotonicity(_recs([0.0, 0.05, -0.01, 0.04]))  # zig-zag → weak rank signal
    assert mono is not None and abs(mono["rho"]) < 1.0


def test_bucket_monotonicity_needs_three_buckets():
    assert _bucket_monotonicity(_recs([0.01, 0.03])) is None
    # empty / all-empty buckets don't count toward the three
    assert _bucket_monotonicity([{"n": 0, "mean_ret": 0.01}] * 4) is None


def test_bucket_monotonicity_constant_means_is_none():
    # a degenerate cell (all bucket means equal) has no rank signal — None, and no scipy warning
    assert _bucket_monotonicity(_recs([0.01, 0.01, 0.01, 0.01])) is None


def test_bucket_monotonicity_json_safe():
    mono = _bucket_monotonicity(_recs([-0.01, 0.0, 0.02]))
    assert isinstance(mono["rho"], float) and isinstance(mono["sign"], int)
    assert not isinstance(mono["rho"], np.generic) and not isinstance(mono["sign"], np.generic)


# ---- cell_conditional_buckets: per-cell conditioning, explicit refusals ----------


def test_cell_conditional_buckets_monotone_plant():
    feat = np.linspace(0.0, 1.0, 100)
    trades = _episodes(list(feat * 0.1), feature=list(feat))
    out = cell_conditional_buckets(trades, ["feat"])
    assert set(out) == {"conditional_buckets", "bucket_monotonicity"}  # the two keys it mounts
    block = out["conditional_buckets"]["feat"]
    assert block["reason"] is None
    assert len(block["buckets"]) == 4
    assert sum(b["n"] for b in block["buckets"]) == 100
    means = [b["mean_ret"] for b in block["buckets"]]
    assert means == sorted(means)  # ascending feature order carries the planted monotone edge
    mono = out["bucket_monotonicity"]["feat"]
    assert mono["rho"] == pytest.approx(1.0) and mono["sign"] == 1


def test_cell_conditional_buckets_refusal_no_closed_observations():
    empty = pd.DataFrame(columns=["ret", "bars_held", "exit_reason", "feat"])
    out = cell_conditional_buckets(empty, ["feat"])
    assert out["conditional_buckets"]["feat"] == {
        "buckets": [], "reason": "no_closed_observations",
    }
    assert out["bucket_monotonicity"] == {}
    # an all-NaN feature column carries no observation of the feature either
    t = _episodes([0.01] * 25, feature=[float("nan")] * 25)
    assert (
        cell_conditional_buckets(t, ["feat"])["conditional_buckets"]["feat"]["reason"]
        == "no_closed_observations"
    )


def test_cell_conditional_buckets_refusal_insufficient_observations():
    t = _episodes(
        [0.01] * (BUCKET_MIN_N - 1), feature=[float(i) for i in range(BUCKET_MIN_N - 1)]
    )
    out = cell_conditional_buckets(t, ["feat"])
    assert out["conditional_buckets"]["feat"] == {
        "buckets": [], "reason": "insufficient_observations",
    }
    # the floor is BUCKET_MIN_N = 20, inclusive: exactly 20 valid rows bucket
    assert BUCKET_MIN_N == 20
    t20 = _episodes(
        list(np.linspace(0.0, 0.1, BUCKET_MIN_N)),
        feature=[float(i) for i in range(BUCKET_MIN_N)],
    )
    assert cell_conditional_buckets(t20, ["feat"])["conditional_buckets"]["feat"]["reason"] is None


def test_cell_conditional_buckets_refusal_insufficient_distinct_values():
    t = _episodes([0.01] * 40, feature=[7.0] * 40)  # constant feature — no quantile split exists
    out = cell_conditional_buckets(t, ["feat"])
    assert out["conditional_buckets"]["feat"] == {
        "buckets": [], "reason": "insufficient_distinct_values",
    }
    assert "feat" not in out["bucket_monotonicity"]  # a refused feature grades nothing


def test_cell_conditional_buckets_per_feature_reasons_are_independent():
    feat = np.linspace(0.0, 1.0, 60)
    t = _episodes(list(feat * 0.1), feature=list(feat))
    t["flat"] = 1.0
    out = cell_conditional_buckets(t, ["feat", "flat"])
    assert out["conditional_buckets"]["feat"]["reason"] is None
    assert out["conditional_buckets"]["flat"]["reason"] == "insufficient_distinct_values"
    # every requested feature has an entry: refusals are explicit, never absent
    assert set(out["conditional_buckets"]) == {"feat", "flat"}


# ---- feature_outcome_association: per-(cell × feature × target) Spearman ----------


def test_feature_outcome_association_planted_monotone_is_rho_one():
    vals = np.arange(20, dtype=float)
    out = feature_outcome_association(vals, vals**3)  # monotone but nonlinear: rank rho is 1
    assert out["rho"] == pytest.approx(1.0) and out["n"] == 20 and out["reason"] is None


def test_feature_outcome_association_planted_inverse_is_rho_minus_one():
    vals = np.arange(15, dtype=float)
    out = feature_outcome_association(vals, -vals)
    assert out["rho"] == pytest.approx(-1.0) and out["n"] == 15 and out["reason"] is None


def test_feature_outcome_association_floor_is_assoc_min_n_inclusive():
    assert ASSOC_MIN_N == 10
    nine = np.arange(9, dtype=float)
    assert feature_outcome_association(nine, nine) == {
        "rho": None, "n": 9, "reason": "insufficient_observations",
    }
    ten = np.arange(10, dtype=float)
    assert feature_outcome_association(ten, ten)["reason"] is None


def test_feature_outcome_association_drops_non_finite_pairs():
    # pairwise-finite: a NaN/inf on EITHER side drops the pair, and n counts what was ranked
    vals = np.concatenate([np.arange(10, dtype=float), [float("nan"), 5.0, float("inf")]])
    rets = np.concatenate([np.arange(10, dtype=float) * 0.1, [0.5, float("nan"), 0.7]])
    out = feature_outcome_association(vals, rets)
    assert out["n"] == 10 and out["rho"] == pytest.approx(1.0) and out["reason"] is None
    # dropping below the floor refuses with the count it actually had
    short = feature_outcome_association(
        np.array([1.0, 2.0, float("nan")]), np.array([0.1, 0.2, 0.3])
    )
    assert short == {"rho": None, "n": 2, "reason": "insufficient_observations"}


def test_feature_outcome_association_constant_input_is_no_rank_variation():
    # rho = 0 would claim a MEASURED absence of association; an undefined rank statistic is a
    # refusal with a reason instead.
    const = np.full(12, 3.0)
    varying = np.arange(12, dtype=float)
    assert feature_outcome_association(const, varying) == {
        "rho": None, "n": 12, "reason": "no_rank_variation",
    }
    assert feature_outcome_association(varying, const) == {
        "rho": None, "n": 12, "reason": "no_rank_variation",
    }


def test_feature_outcome_association_emits_no_p_value():
    # Deliberate: an overlap-inflated Spearman p is exactly the over-trustable number the
    # doctrine forbids, and there is no honest event-time correction to put in its place.
    out = feature_outcome_association(
        np.arange(30, dtype=float), np.random.RandomState(1).randn(30)
    )
    assert set(out) == {"rho", "n", "reason"}


# ---- event-time Newey-West HAC ---------------------------------------------


def test_newey_west_h1_matches_ols_se():
    # h=1 windows cannot overlap — the event-time HAC reduces to the plain OLS SE of the mean.
    rng = np.random.RandomState(0)
    rets = rng.normal(0.01, 0.02, size=200)
    t0, se0, _p0 = newey_west_mean(rets, np.arange(200), h=1)
    expected_se = np.sqrt(np.var(rets) / rets.shape[0])  # HAC lag-0 = population var / n
    assert se0 == pytest.approx(expected_se, rel=1e-9)
    assert t0 == pytest.approx(rets.mean() / expected_se, rel=1e-9)


def test_newey_west_widens_se_under_overlap():
    # Overlapping window-sums induce strong positive autocorrelation (MA): on a contiguous
    # every-bar pool the event-time HAC SE (bar gap = event lag) must be materially wider than
    # the iid SE, so the honest t is much smaller than the naive t.
    rng = np.random.RandomState(1)
    w, T = 20, 600
    x = rng.normal(0.001, 1.0, T + w)
    rets = np.array([x[i:i + w].mean() for i in range(T)])  # overlapping → MA(w-1)
    bars = np.arange(T)
    _, se_iid, _ = newey_west_mean(rets, bars, h=1)
    t_hac, se_hac, _ = newey_west_mean(rets, bars, h=w)
    t_iid, _, _ = newey_west_mean(rets, bars, h=1)
    assert se_hac > 1.5 * se_iid
    assert abs(t_hac) < abs(t_iid)


def test_newey_west_contiguous_matches_classic_bartlett():
    # On a contiguous every-bar pool (bar gap d = event lag k) the event-time estimator must
    # reproduce the classic overlap HAC with truncation lag h-1 EXACTLY: w_k = 1 - k/h both ways.
    rng = np.random.RandomState(7)
    rets = rng.normal(0.002, 0.01, size=120)
    h = 12
    t_new, se_new, _ = newey_west_mean(rets, np.arange(rets.size), h=h)
    dev = rets - rets.mean()
    n = rets.size
    s = float(dev @ dev) / n
    for k in range(1, min(h - 1, n - 1) + 1):
        s += 2.0 * (1.0 - k / h) * float(dev[k:] @ dev[:-k]) / n
    se_classic = np.sqrt(s / n)
    assert se_new == pytest.approx(se_classic, rel=1e-12)
    assert t_new == pytest.approx(rets.mean() / se_classic, rel=1e-12)


def test_newey_west_sparse_independent_events_keep_iid_se():
    # THE P0 regression: on a sparse pool whose events sit further apart than the horizon there
    # is NO overlap — every cross term must drop and the SE must equal the iid SE exactly. The
    # ordinal-lag estimator collapsed this SE to ~0.23x (Bartlett with lag ≈ n → Σdev ≈ 0),
    # fabricating significance on independent returns.
    rng = np.random.RandomState(11)
    n, h = 12, 60
    rets = rng.standard_normal(n)
    bars = np.arange(n) * 500  # events years apart in bar time
    _t_ev, se_ev, _ = newey_west_mean(rets, bars, h=h)
    iid_se = rets.std(ddof=1) * np.sqrt((n - 1) / n) / np.sqrt(n)  # gamma_0/n convention
    assert se_ev == pytest.approx(iid_se, rel=1e-12)
    # And in distribution: the median SE ratio over many draws sits at ~1, not ~0.23.
    ratios = []
    for seed in range(300):
        r = np.random.RandomState(seed).standard_normal(n)
        _, se, _ = newey_west_mean(r, bars, h=h)
        ratios.append(se / (r.std(ddof=1) / np.sqrt(n)))
    assert 0.9 < float(np.median(ratios)) < 1.1


def test_newey_west_partial_overlap_weights_actual_bar_gap():
    # Two events d bars apart under horizon h get weight 1 - d/h — not the ordinal weight
    # 1 - 1/h a contiguous pool would give its first lag.
    rets = np.array([0.01, -0.02, 0.015, 0.005])
    h = 10
    bars = np.array([0, 7, 40, 80])  # only the first pair overlaps (d=7 < h)
    _, se, _ = newey_west_mean(rets, bars, h=h)
    dev = rets - rets.mean()
    n = rets.size
    s = float(dev @ dev) / n + 2.0 * (1.0 - 7.0 / h) * float(dev[0] * dev[1]) / n
    assert se == pytest.approx(np.sqrt(s / n), rel=1e-12)


def test_newey_west_unsorted_bars_are_sorted_internally():
    rng = np.random.RandomState(5)
    rets = rng.standard_normal(30)
    bars = np.arange(30) * 3
    perm = rng.permutation(30)
    t_a, se_a, p_a = newey_west_mean(rets, bars, h=10)
    t_b, se_b, p_b = newey_west_mean(rets[perm], bars[perm], h=10)
    assert (t_a, se_a, p_a) == pytest.approx((t_b, se_b, p_b), rel=1e-12)


def test_newey_west_small_df_only_widens_the_p():
    # df changes the p-value's reference distribution ONLY — t and se are untouched — and a small
    # df (= n_eff-1 on a heavily overlapping pool) makes the p strictly more conservative.
    rets = np.random.RandomState(3).randn(200) * 0.01 + 0.002
    bars = np.arange(200)
    t_full, se_full, p_full = newey_west_mean(rets, bars, h=5)
    t_small, se_small, p_small = newey_west_mean(rets, bars, h=5, df=9)
    assert t_small == t_full and se_small == se_full
    assert p_small > p_full


def test_independent_count_packs_greedily():
    assert independent_count(np.array([0, 1, 2, 10, 11, 20]), horizon=5) == 3  # 0, 10, 20
    assert independent_count(np.array([]), horizon=5) == 0
    assert independent_count(np.array([0, 5, 10]), horizon=5) == 3  # exactly non-overlapping


# ---- the circular-shift rotation null (per-cell, no cross-cell statistic) ---


def test_tail_p_is_the_corrected_right_tail_fraction():
    # (1 + #{null >= observed}) / (1 + #null) — the small-sample correction that makes the
    # smallest attainable p 1/(1+n_shifts) rather than 0.
    null = np.array([0.0, 1.0, 2.0, 3.0])
    assert _tail_p(2.0, null) == pytest.approx(3.0 / 5.0)
    assert _tail_p(10.0, null) == pytest.approx(1.0 / 5.0)  # nothing beat it — the floor, not 0
    assert np.isnan(_tail_p(float("nan"), null))
    assert np.isnan(_tail_p(1.0, np.array([np.nan, np.nan])))


def test_rotation_means_observed_is_identity_shift():
    rng = np.random.RandomState(2)
    fwd = rng.normal(0, 0.01, 100)
    mask = (rng.rand(100) < 0.3).astype(float)
    observed, means = _rotation_means(mask, fwd)
    assert observed == pytest.approx(fwd[mask > 0].mean())
    assert means.shape == (100,) and means[0] == pytest.approx(observed)


def test_reliability_summary_returns_only_per_cell_nominal_reads():
    # The shape: a dict of independent per-cell reads plus the shift count, and NOTHING
    # describing the grid as a whole. No fw_p, no best_combo, no deflation, no stepdown, no FDR —
    # a search correction computed inside one run only ever sees that run's grid, so multiplicity
    # is the caller's to price (against n_hypotheses_attempted).
    rng = np.random.RandomState(0)
    T = 300
    fwd = rng.normal(0.0, 0.01, T)
    cells = []
    for k in range(3):
        m = np.zeros(T)
        m[rng.choice(T, 30, replace=False)] = 1.0
        cells.append({"key": (k, "t"), "mask_col": m, "fwd_col": fwd, "h": 1})
    rel = reliability_summary(cells, T, ["t"])
    assert set(rel) == {"per_cell", "n_shifts"}
    assert set(rel["per_cell"]) == {(0, "t"), (1, "t"), (2, "t")}
    for read in rel["per_cell"].values():
        assert set(read) == {"rot_p", "t_hac", "hac_se", "n_eff"}
        assert 0.0 <= read["rot_p"] <= 1.0
        assert isinstance(read["n_eff"], int)


def test_reliability_summary_empty_grid_is_the_zero_shape():
    assert reliability_summary([], 400, ["t"]) == {"per_cell": {}, "n_shifts": 0}
    # too short to rotate against: same total, no exception
    m = np.array([1.0, 0.0])
    fwd = np.array([0.01, 0.02])
    assert reliability_summary(
        [{"key": ("c", "t"), "mask_col": m, "fwd_col": fwd, "h": 1}], 2, ["t"]
    ) == {"per_cell": {}, "n_shifts": 0}


def test_rotation_null_detects_edge_and_clears_noise():
    # A signal aligned with high forward returns is significant against its OWN rotation null; a
    # random signal of the same count is not. (The forward-return series is fixed; only the firing
    # mask rotates.) Each cell is its own combo with a single target "t".
    rng = np.random.RandomState(0)
    T = 400
    fwd = rng.normal(0.0, 0.01, T)
    edge = (fwd > np.quantile(fwd, 0.8)).astype(float)
    noise = np.zeros(T)
    noise[rng.choice(T, int(edge.sum()), replace=False)] = 1.0
    cells = [
        {"key": ("edge", "t"), "mask_col": edge, "fwd_col": fwd, "h": 1},
        {"key": ("noise", "t"), "mask_col": noise, "fwd_col": fwd, "h": 1},
    ]
    rel = reliability_summary(cells, T, ["t"])
    assert rel["per_cell"][("edge", "t")]["rot_p"] < 0.05
    assert rel["per_cell"][("edge", "t")]["rot_p"] < rel["per_cell"][("noise", "t")]["rot_p"]
    # Resolution transparency: the shift count actually used is reported (min achievable
    # p = 1/(1+n_shifts)); the null always uses every non-identity shift — T-1 = 399.
    assert rel["n_shifts"] == 399


def test_rotation_grid_uses_every_shift_no_periodic_aliasing():
    # THE aliasing trap the every-shift null avoids: with a period-5 signal at T=5000, an
    # evenly-spaced 1000-shift grid has residues mod 5 of [0,333,333,333,1] — the aligned phase
    # is nearly absent from the null, so a purely periodic artifact certifies at ~1/1000. All
    # 4999 shifts are the full randomization set: ~1/5 of them realign the mask with the "good"
    # bars, so rot_p sits near 0.2.
    T = 5000
    mask = (np.arange(T) % 5 == 0).astype(float)
    fwd = np.where(np.arange(T) % 5 == 0, 1.0, -0.25)  # circular-stationary, period 5
    rel = reliability_summary(
        [{"key": ("periodic", "t"), "mask_col": mask, "fwd_col": fwd, "h": 1}], T, ["t"]
    )
    assert rel["n_shifts"] == T - 1
    rot_p = rel["per_cell"][("periodic", "t")]["rot_p"]
    assert rot_p > 0.15  # the periodic null is NOT significant once every phase is priced


def test_per_cell_reads_do_not_depend_on_the_rest_of_the_grid():
    # THE independence invariant: every cell is measured on its OWN mask against its OWN null,
    # so adding hypotheses to the grid cannot move a cell's numbers. A max-over-combos search null
    # would move every one of them, which is exactly why such a grid cannot be read cell by cell.
    rng = np.random.RandomState(4)
    T = 400
    fwd = rng.normal(0.0, 0.01, T)
    lone = np.zeros(T)
    lone[rng.choice(T, 40, replace=False)] = 1.0
    cells = [{"key": ("a", "t"), "mask_col": lone, "fwd_col": fwd, "h": 5}]
    alone = reliability_summary(cells, T, ["t"])["per_cell"][("a", "t")]
    for k in range(10):
        m = np.zeros(T)
        m[rng.choice(T, 40, replace=False)] = 1.0
        cells.append({"key": (f"n{k}", "t"), "mask_col": m, "fwd_col": fwd, "h": 5})
    crowded = reliability_summary(cells, T, ["t"])["per_cell"][("a", "t")]
    assert crowded == alone


def test_per_cell_n_eff_and_hac_match_direct_recomputation():
    # The per-cell reads ARE the documented kernels applied to that cell's closed rows: no
    # studentization, no pooling, no adjustment sits between them and the report.
    rng = np.random.RandomState(6)
    T, h = 500, 10
    fwd = rng.normal(0.001, 0.01, T)
    fwd[-h:] = np.nan  # trailing windows run past the data end
    mask = np.zeros(T)
    mask[rng.choice(T, 60, replace=False)] = 1.0
    rel = reliability_summary(
        [{"key": ("c", "t"), "mask_col": mask, "fwd_col": fwd, "h": h}], T, ["t"]
    )
    read = rel["per_cell"][("c", "t")]
    closed = np.flatnonzero((mask > 0) & np.isfinite(fwd))
    assert read["n_eff"] == independent_count(closed, h)
    t_ref, se_ref, _ = newey_west_mean(fwd[closed], closed, h, df=max(read["n_eff"] - 1, 1))
    assert read["t_hac"] == pytest.approx(t_ref)
    assert read["hac_se"] == pytest.approx(se_ref)


# ---- pooled_reliability_summary: the basket-mode pooled read --------------------


def _member_cells(rng, T=400, h=5, n_fire=40, combo="c", targets=("A", "B")):
    """Basket members of ONE combo: per-target fwd columns (NaN tails) and firing masks."""
    cells = []
    for tgt in targets:
        fwd = rng.normal(0.001, 0.01, T)
        fwd[-h:] = np.nan  # trailing windows past the data end stay censored
        mask = np.zeros(T)
        mask[rng.choice(T - h, n_fire, replace=False)] = 1.0
        cells.append({"key": (combo, tgt), "mask_col": mask, "fwd_col": fwd, "h": h})
    return cells


def test_pooled_reliability_matches_direct_kernels_on_concatenated_rows():
    # The pooled reads ARE the documented kernels applied to the concatenated member rows —
    # no reweighting, no averaging of per-member statistics, nothing in between.
    rng = np.random.RandomState(21)
    T, h = 400, 5
    cells = _member_cells(rng, T=T, h=h)
    out = pooled_reliability_summary(cells, T)
    assert set(out) == {"per_cell", "n_shifts"} and out["n_shifts"] == T - 1
    read = out["per_cell"][("c",)]
    assert set(read) == {"rot_p", "t_hac", "hac_se", "n_eff"}
    bars_parts, rets_parts = [], []
    for c in cells:  # cells-list order — the tie order the runner fixes as declaration order
        fwd = np.asarray(c["fwd_col"], dtype=float)
        t = np.flatnonzero((np.asarray(c["mask_col"]) > 0) & np.isfinite(fwd))
        bars_parts.append(t)
        rets_parts.append(fwd[t])
    bars = np.concatenate(bars_parts)
    rets = np.concatenate(rets_parts)
    n_eff = independent_count(bars, h)
    t_ref, se_ref, _ = newey_west_mean(rets, bars, h, df=max(n_eff - 1, 1))
    assert read["n_eff"] == n_eff
    assert read["t_hac"] == pytest.approx(t_ref, rel=1e-12)
    assert read["hac_se"] == pytest.approx(se_ref, rel=1e-12)
    assert 0.0 <= read["rot_p"] <= 1.0


def test_pooled_same_bar_cross_member_firings_collapse_to_one_n_eff():
    # Two members, one market event: ONE independent window, never two — the greedy kernel
    # collapses duplicate bars automatically, which is why n_eff keeps one meaning engine-wide.
    T, h = 60, 5
    fwd_a = np.full(T, 0.01)
    fwd_b = np.full(T, 0.02)
    m = np.zeros(T)
    m[10] = 1.0
    cells = [
        {"key": ("c", "A"), "mask_col": m, "fwd_col": fwd_a, "h": h},
        {"key": ("c", "B"), "mask_col": m.copy(), "fwd_col": fwd_b, "h": h},
    ]
    assert pooled_reliability_summary(cells, T)["per_cell"][("c",)]["n_eff"] == 1
    m2 = np.zeros(T)
    m2[10] = 1.0
    m2[30] = 1.0
    cells2 = [
        {"key": ("c", "A"), "mask_col": m2, "fwd_col": fwd_a, "h": h},
        {"key": ("c", "B"), "mask_col": m, "fwd_col": fwd_b, "h": h},
    ]
    # bars {10, 30, 10} → the duplicate bar-10 firing adds nothing
    assert pooled_reliability_summary(cells2, T)["per_cell"][("c",)]["n_eff"] == 2


def test_pooled_same_bar_hac_pair_enters_at_bartlett_weight_one():
    # Three pooled rows: members A and B both fire at bar 0 (d=0 → weight exactly 1), A fires
    # again at bar 100 (d=100 ≥ h → weight 0). Long-run variance = gamma_0 + 2·1·dev_i·dev_j/n
    # — the same-bar cross term at FULL weight: one market move seen through two members is one
    # cluster, priced at full covariance.
    T, h = 200, 5
    a0, a1, b0 = 0.02, -0.01, 0.03
    fwd_a = np.zeros(T)
    fwd_a[0], fwd_a[100] = a0, a1
    fwd_b = np.zeros(T)
    fwd_b[0] = b0
    ma = np.zeros(T)
    ma[0], ma[100] = 1.0, 1.0
    mb = np.zeros(T)
    mb[0] = 1.0
    cells = [
        {"key": ("c", "A"), "mask_col": ma, "fwd_col": fwd_a, "h": h},
        {"key": ("c", "B"), "mask_col": mb, "fwd_col": fwd_b, "h": h},
    ]
    read = pooled_reliability_summary(cells, T)["per_cell"][("c",)]
    rets = np.array([a0, b0, a1])  # sorted-bar order; same-bar tie keeps input (A-then-B) order
    mean = rets.mean()
    dev = rets - mean
    n = 3
    s = float(dev @ dev) / n + 2.0 * 1.0 * dev[0] * dev[1] / n
    se = np.sqrt(s / n)
    assert read["n_eff"] == 2  # bars {0, 100}: the same-bar duplicate collapses
    assert read["hac_se"] == pytest.approx(se, rel=1e-12)
    assert read["t_hac"] == pytest.approx(mean / se, rel=1e-12)


def test_pooled_common_shift_rotation_matches_brute_force_roll_of_every_member():
    """THE common-shift definition: one tau rotates EVERY member's mask as a block, and the
    pooled conditional mean is the ratio of pooled sums — never a mean of per-member means.

    The doctrine the common shift encodes: rotating every mask by the SAME tau rolls the
    cross-sectional per-bar firing count as a block, so a rank signal's "exactly k members fire
    together" pattern survives every shift — independent per-member shifts would scramble it
    into masks the signal could never emit. The np.roll brute force below IS that block
    rotation, so matching it at every tau is what pins the property in engine code (asserting it
    over bare np.roll calls on both sides would exercise no engine code at all — a pure-numpy
    tautology)."""
    rng = np.random.RandomState(31)
    T, h = 97, 4
    cells = _member_cells(rng, T=T, h=h, n_fire=20)
    masks = [np.asarray(c["mask_col"]) > 0 for c in cells]
    fwds = [np.asarray(c["fwd_col"], dtype=float) for c in cells]
    brute = np.empty(T)
    for tau in range(T):
        num = 0.0
        den = 0.0
        for m, f in zip(masks, fwds, strict=True):
            rolled = np.roll(m, tau)
            fin = np.isfinite(f)
            num += float(np.sum(np.where(rolled & fin, f, 0.0)))
            den += float(np.sum(rolled & fin))
        brute[tau] = num / den if den > 0.5 else float("nan")
    # helper level: the pooled num/den arrays are exactly the summed member cross-correlations
    num_sum = np.zeros(T)
    den_sum = np.zeros(T)
    for m, f in zip(masks, fwds, strict=True):
        num_c, den_c = _rotation_num_den(m, *_fwd_ffts(f), T)
        num_sum += num_c
        den_sum += den_c
    means = np.where(den_sum > 0.5, num_sum / den_sum, np.nan)
    np.testing.assert_allclose(means, brute, rtol=1e-9, atol=1e-12)
    # end to end: rot_p is the tail p of the brute-force common-shift null
    read = pooled_reliability_summary(cells, T)["per_cell"][("c",)]
    assert read["rot_p"] == pytest.approx(_tail_p(brute[0], brute[1:]))


def test_pooled_g1_reduces_exactly_to_the_per_target_read():
    # A one-member basket group IS its member: same spectra, same division, same kernels on the
    # same rows — EXACT equality, not approximation.
    rng = np.random.RandomState(41)
    T, h = 300, 5
    fwd = rng.normal(0.0, 0.01, T)
    fwd[-h:] = np.nan
    mask = np.zeros(T)
    mask[rng.choice(T - h, 35, replace=False)] = 1.0
    cells = [{"key": ("k", "t"), "mask_col": mask, "fwd_col": fwd, "h": h}]
    per_target = reliability_summary(cells, T, ["t"])["per_cell"][("k", "t")]
    pooled = pooled_reliability_summary(cells, T)["per_cell"][("k",)]
    assert pooled == per_target


def test_pooled_groups_are_independent_of_the_rest_of_the_grid():
    # The same independence invariant as the per-target pass: grouping is structural, so adding
    # a combo to the grid changes no other combo's pooled numbers.
    rng = np.random.RandomState(43)
    T = 250
    cells_a = _member_cells(rng, T=T, h=5, combo="a")
    alone = pooled_reliability_summary(cells_a, T)["per_cell"][("a",)]
    cells_b = _member_cells(rng, T=T, h=8, n_fire=25, combo="b")
    both = pooled_reliability_summary(cells_a + cells_b, T)
    assert both["per_cell"][("a",)] == alone
    assert set(both["per_cell"]) == {("a",), ("b",)}


def test_pooled_reliability_empty_and_short_guards_mirror_reliability_summary():
    assert pooled_reliability_summary([], 400) == {"per_cell": {}, "n_shifts": 0}
    m = np.array([1.0, 0.0])
    fwd = np.array([0.01, 0.02])
    assert pooled_reliability_summary(
        [{"key": ("c", "t"), "mask_col": m, "fwd_col": fwd, "h": 1}], 2
    ) == {"per_cell": {}, "n_shifts": 0}


# ---- CSCV → PBO (grid-level evidence, attached to no hypothesis) ------------


def _pbo_cells(rng, T, n_combos, edge_combo=None, n_fire=60, h=1):
    """Synthetic single-target cells sharing one fwd series (like the real engine)."""
    fwd = rng.normal(0.0, 0.01, T)
    signal_bars = rng.choice(T - h - 1, n_fire, replace=False)
    if edge_combo is not None:
        fwd[signal_bars] += 0.02  # bars the edge combo fires on are genuinely shifted
    cells = []
    for k in range(n_combos):
        m = np.zeros(T)
        if edge_combo is not None and k == edge_combo:
            m[signal_bars] = 1.0
        else:
            m[rng.choice(T - h - 1, n_fire, replace=False)] = 1.0
        cells.append({"key": (k, "t"), "mask_col": m, "fwd_col": fwd, "h": h})
    return cells


def test_cscv_pbo_noise_grid_is_a_coin_flip():
    rng = np.random.RandomState(5)
    cells = _pbo_cells(rng, 800, 12)
    out = cscv_pbo(cells, 800, ["t"])
    assert out["reason"] is None and out["n_splits"] == 70
    # pure noise: the train-winner's OOS rank is uniform → PBO near one half
    assert 0.25 <= out["pbo"] <= 0.75


def test_cscv_pbo_planted_edge_travels():
    rng = np.random.RandomState(6)
    cells = _pbo_cells(rng, 800, 12, edge_combo=0)
    out = cscv_pbo(cells, 800, ["t"])
    assert out["pbo"] <= 0.1  # the winner keeps winning out of sample
    assert out["prob_oos_loss"] <= 0.1
    assert out["lambda_mean"] > 0


def test_cscv_pbo_single_combo_and_empty_guards():
    rng = np.random.RandomState(7)
    cells = _pbo_cells(rng, 400, 1)
    out = cscv_pbo(cells, 400, ["t"])
    assert out["pbo"] is None and out["reason"] == "single_combo"
    out = cscv_pbo([], 400, ["t"])
    assert out["pbo"] is None and out["reason"] == "insufficient_data"


def test_cscv_pbo_purges_boundary_crossing_windows():
    # 80 bars; the adaptive S=8→6→4 fallback tries block widths 10, ~13.3, 20 in turn. A window of
    # off+h=26 bars exceeds even the widest candidate block (20), so EVERY firing purges away at
    # every adaptive S — insufficient data, never a leaked score, regardless of which S is tried.
    T, h = 80, 25
    fwd = np.random.RandomState(8).normal(0, 0.01, T)
    cells = []
    for k in range(2):
        m = np.zeros(T)
        m[5 + 10 * np.arange(7)] = 1.0
        cells.append({"key": (k, "t"), "mask_col": m, "fwd_col": fwd, "h": h})
    out = cscv_pbo(cells, T, ["t"])
    assert out["pbo"] is None and out["reason"] == "insufficient_data"


def test_cscv_pbo_falls_back_to_fewer_blocks():
    # T=96 → S=8 blocks of width 12, S=6 of width 16. With off+h=12, every firing purges at S=8
    # (window span equals block width ⇒ no t satisfies t+off+h < block_end). At S=6 the wider
    # blocks keep early-in-block firings, so the adaptive fallback scores and reports blocks=6.
    T, h, off = 96, 11, 1
    assert off + h == T // 8
    rng = np.random.RandomState(11)
    fwd = rng.normal(0.002, 0.01, T)
    # All combos fire in the first 3 bars of every 16-bar region (survive S=6 width-16;
    # purge entirely at S=8 width-12). Distinct early slots so each combo has its own pool.
    cells = []
    for k, offsets in enumerate(((0, 1), (1, 2), (0, 2))):
        m = np.zeros(T)
        for b in range(0, T, 16):
            for o in offsets:
                m[b + o] = 1.0
        cells.append({"key": (k, "t"), "mask_col": m, "fwd_col": fwd, "h": h})
    # Plant a mild edge on combo 0's fire bars only.
    edge = cells[0]["mask_col"] > 0
    fwd = fwd.copy()
    fwd[edge] += 0.02
    cells[0]["fwd_col"] = fwd
    for c in cells[1:]:
        c["fwd_col"] = fwd
    out = cscv_pbo(cells, T, ["t"])
    assert out["reason"] is None
    assert out["blocks"] == 6
    assert out["n_combos"] >= 2
    assert isinstance(out["pbo"], float) and 0.0 <= out["pbo"] <= 1.0
    assert out["n_splits"] >= 2


# ---- CSCV target modes: the score mirrors the caller's selection --------------------


def test_cscv_pbo_default_mode_is_conjunction():
    # The default path IS the conjunction path — the conjunction tests above pin its numbers;
    # this pins that omitting the mode selects it.
    rng = np.random.RandomState(5)
    cells = _pbo_cells(rng, 800, 12)
    assert cscv_pbo(cells, 800, ["t"]) == cscv_pbo(cells, 800, ["t"], mode="conjunction")


def test_cscv_pbo_unknown_mode_refuses():
    with pytest.raises(ValueError):
        cscv_pbo([], 400, ["t"], mode="both")


def test_cscv_pbo_basket_score_is_the_pooled_per_observation_sharpe():
    # HAND-CHECK by construction: members fire on DISJOINT bars, so a basket combo's pooled
    # (bar × member) pool IS the union pool of one synthetic target. Basket scoring of the
    # two-member grid must therefore reproduce single-target conjunction scoring of the union
    # grid (min over ONE target = identity = that pool's per-observation Sharpe) — which is the
    # statement "the basket score is the pooled Sharpe, no weakest-member min".
    rng = np.random.RandomState(9)
    T, h = 800, 1
    fwd_a = rng.normal(0.0, 0.01, T)
    fwd_b = rng.normal(0.0, 0.01, T)
    basket_cells, union_cells = [], []
    for k in range(6):
        bars = rng.choice(T - 2, 80, replace=False)
        ma = np.zeros(T)
        ma[bars[:40]] = 1.0
        mb = np.zeros(T)
        mb[bars[40:]] = 1.0
        basket_cells += [
            {"key": (k, "A"), "mask_col": ma, "fwd_col": fwd_a, "h": h},
            {"key": (k, "B"), "mask_col": mb, "fwd_col": fwd_b, "h": h},
        ]
        mu = np.zeros(T)
        mu[bars] = 1.0
        fwd_u = np.where(ma > 0, fwd_a, fwd_b)  # each member's own fwd at its own firing bars
        union_cells.append({"key": (k, "P"), "mask_col": mu, "fwd_col": fwd_u, "h": h})
    basket = cscv_pbo(basket_cells, T, ["A", "B"], mode="basket")
    union = cscv_pbo(union_cells, T, ["P"])
    assert basket["reason"] is None
    for key in ("reason", "n_splits", "n_combos", "blocks"):
        assert basket[key] == union[key]
    for key in ("pbo", "lambda_mean", "oos_degradation_slope", "prob_oos_loss"):
        assert basket[key] == pytest.approx(union[key])


def test_cscv_pbo_basket_admits_partial_combos_and_zero_fills_absent_members():
    rng = np.random.RandomState(10)
    T, h = 800, 1
    fwd_a = rng.normal(0.0, 0.01, T)
    fwd_b = rng.normal(0.0, 0.01, T)

    def _cell(k, tgt, fwd):
        m = np.zeros(T)
        m[rng.choice(T - 2, 60, replace=False)] = 1.0
        return {"key": (k, tgt), "mask_col": m, "fwd_col": fwd, "h": h}

    cells = [_cell(0, "A", fwd_a), _cell(0, "B", fwd_b), _cell(1, "A", fwd_a)]
    # conjunction: combo 1 has no B pool → inadmissible → one full combo → no selection to score
    conj = cscv_pbo(cells, T, ["A", "B"])
    assert conj["pbo"] is None and conj["reason"] == "single_combo" and conj["n_combos"] == 1
    # basket: ≥1 member present admits combo 1; the absent member zero-fills
    bask = cscv_pbo(cells, T, ["A", "B"], mode="basket")
    assert bask["reason"] is None and bask["n_combos"] == 2
    # zero-filled absence == a member that never fired: EXACTLY the same numbers
    never = {"key": (1, "B"), "mask_col": np.zeros(T), "fwd_col": fwd_b, "h": h}
    assert bask == cscv_pbo([*cells, never], T, ["A", "B"], mode="basket")


def _one_member_edge_cells(T=800, h=1, seed=12):
    """An 8-combo two-member grid whose edge lives in ONE member's pool (combo 0's A mask fires
    on the genuinely shifted bars; every other mask is noise) — the fixture the two mode-contrast
    pins below share EXACTLY, so they read one grid through the two scores."""
    rng = np.random.RandomState(seed)
    fwd_a = rng.normal(0.0, 0.01, T)
    fwd_b = rng.normal(0.0, 0.01, T)
    edge_bars = rng.choice(T - 2, 60, replace=False)
    fwd_a[edge_bars] += 0.02
    cells = []
    for k in range(8):
        ma = np.zeros(T)
        if k == 0:
            ma[edge_bars] = 1.0
        else:
            ma[rng.choice(T - 2, 60, replace=False)] = 1.0
        mb = np.zeros(T)
        mb[rng.choice(T - 2, 60, replace=False)] = 1.0
        cells += [
            {"key": (k, "A"), "mask_col": ma, "fwd_col": fwd_a, "h": h},
            {"key": (k, "B"), "mask_col": mb, "fwd_col": fwd_b, "h": h},
        ]
    return cells, T


def test_cscv_pbo_basket_pools_across_members_instead_of_taking_the_weakest():
    # The edge lives in ONE member's pool. The conjunction score (weakest member) never sees it;
    # the basket's pooled per-observation Sharpe does, and the pooled winner travels.
    cells, T = _one_member_edge_cells()
    bask = cscv_pbo(cells, T, ["A", "B"], mode="basket")
    assert bask["reason"] is None
    assert bask["pbo"] <= 0.1  # the one-member edge dominates the POOL and keeps winning OOS


def test_cscv_pbo_conjunction_stays_blind_to_a_one_member_edge():
    # The MIRROR pin over the SAME grid: the conjunction (default) score is the WEAKEST member's
    # Sharpe, and the edge member's noise sibling B drags combo 0 back into the pack — so the
    # conjunction read must NOT see the edge the basket read travels on. Kills the mutant where
    # basket scoring leaks into the conjunction path (a leak would reproduce the sibling test's
    # pbo <= 0.1 here); every combo carries both members, so admissibility is identical and the
    # contrast is PURELY the score.
    cells, T = _one_member_edge_cells()
    conj = cscv_pbo(cells, T, ["A", "B"])  # default mode == conjunction
    assert conj["reason"] is None
    assert conj["pbo"] >= 0.25  # coin-flip territory: the one-member edge does not travel


# ---- episode clustering + return-mass concentration ------------------------


def test_concentration_hand_computed():
    rets = np.array([0.5] + [0.01] * 19)  # one whale among 20 → top 5% = 1 obs
    out = concentration(rets)
    assert out["n_top"] == 1
    assert out["top_share_abs"] == pytest.approx(0.5 / (0.5 + 0.19))
    assert np.isnan(concentration(np.array([]))["top_share_abs"])


def test_episode_stats_overlapping_vs_disjoint():
    day = pd.Timedelta(days=1)
    base = pd.Timestamp("2021-01-01")
    # Two overlapping [entry, exit) windows merge; a later disjoint window is its own cluster.
    # |ret| mass of the 2-obs cluster: (0.10+0.30)/(0.10+0.30+0.05) = 0.8
    overlap = pd.DataFrame(
        {
            "entry_time": [base + d * day for d in (0, 3, 20)],
            "exit_time": [base + d * day for d in (10, 12, 25)],
            "ret": [0.10, 0.30, 0.05],
        }
    )
    out = episode_stats(overlap)
    assert out["n"] == 3 and out["n_clusters"] == 2
    assert out["largest_cluster_n"] == 2
    assert out["largest_cluster_share_abs"] == pytest.approx(0.40 / 0.45)
    assert out["largest_cluster_start"].startswith("2021-01-01T00:00:00")
    assert out["max_cluster_share_abs"] == pytest.approx(0.40 / 0.45)

    disjoint = pd.DataFrame(
        {
            "entry_time": [base + d * day for d in (0, 10)],
            "exit_time": [base + d * day for d in (5, 15)],
            "ret": [0.02, -0.03],
        }
    )
    d = episode_stats(disjoint)
    assert d["n_clusters"] == 2 and d["largest_cluster_n"] == 1
    # max_cluster_share_abs is largest-by-MASS, not largest-by-count: the first (tie-broken)
    # largest-by-count cluster holds 0.4 of the mass, but the -0.03 cluster holds 0.6.
    assert d["largest_cluster_share_abs"] == pytest.approx(0.4)
    assert d["max_cluster_share_abs"] == pytest.approx(0.6)


def test_episode_stats_empty_guards():
    empty = episode_stats(pd.DataFrame())
    assert empty["n"] == 0 and empty["n_clusters"] == 0
    assert np.isnan(empty["max_cluster_share_abs"])
    missing = episode_stats(
        pd.DataFrame({"ret": [0.01], "exit_time": [pd.Timestamp("2021-01-06")]})
    )
    assert missing["n"] == 0


def test_overlap_clusters_chain_merge_vs_greedy_count():
    # Chain A∩B, B∩C with A∦C: ONE merged cluster, but TWO greedy non-overlapping windows —
    # clusters are the more conservative independent-unit count (n_clusters <= n_eff always).
    entry = np.array([0, 9, 19])
    exit_ = np.array([10, 20, 30])
    assert overlap_clusters(entry, exit_) == [[0, 1, 2]]
    assert independent_count(entry, horizon=10) == 2
    # Half-open tie rule: a window starting exactly at the running end is a NEW cluster.
    assert overlap_clusters(np.array([0, 10]), np.array([10, 20])) == [[0], [1]]
    assert overlap_clusters(np.array([]), np.array([])) == []


def test_episode_clusters_never_outnumber_independent_windows():
    # Transitive merging is coarser than greedy non-overlap, so a cell's episode count is weakly
    # stricter than its n_eff — the property the per-cell concentration read leans on.
    rng = np.random.RandomState(11)
    h = 12
    for _ in range(20):
        n = int(rng.randint(1, 40))
        entry = np.sort(rng.randint(0, 500, size=n))
        exit_ = entry + h
        assert len(overlap_clusters(entry, exit_)) <= independent_count(entry, horizon=h)


# ---- episode_ledger: the time-ordered per-cell episode list --------------------


def test_episode_ledger_matches_episode_stats_and_hand_computed_shares():
    day = pd.Timedelta(days=1)
    base = pd.Timestamp("2021-01-01")
    # Cluster 1: [0,10) and [3,12) chain-merge (episode end = the LATER exit, day 12);
    # cluster 2: [20,25). |ret| shares: 0.40/0.45 and 0.05/0.45.
    trades = pd.DataFrame(
        {
            "entry_time": [base + d * day for d in (0, 3, 20)],
            "exit_time": [base + d * day for d in (10, 12, 25)],
            "ret": [0.10, 0.30, -0.05],
        }
    )
    led = episode_ledger(trades)
    assert led["n_total"] == episode_stats(trades)["n_clusters"] == 2  # the reconciliation pin
    assert led["n_omitted"] == 0 and led["omitted_share_abs"] == 0.0
    assert led["cap"] == EPISODE_LIST_MAX == 32
    first, second = led["entries"]
    assert first["start"].startswith("2021-01-01") and first["end"].startswith("2021-01-13")
    assert first["n"] == 2 and first["mean_ret"] == pytest.approx(0.20)
    assert first["share_abs"] == pytest.approx(0.40 / 0.45)
    assert second["start"].startswith("2021-01-21") and second["end"].startswith("2021-01-26")
    assert second["n"] == 1 and second["mean_ret"] == pytest.approx(-0.05)
    assert second["share_abs"] == pytest.approx(0.05 / 0.45)
    # mass conservation: listed + omitted shares cover the pool exactly
    assert sum(e["share_abs"] for e in led["entries"]) + led["omitted_share_abs"] == (
        pytest.approx(1.0)
    )


def test_episode_ledger_truncation_is_time_ordered_and_mass_conserving():
    day = pd.Timedelta(days=1)
    base = pd.Timestamp("2020-01-01")
    # 8 disjoint episodes; the LAST carries most of the mass — a share-ranked ledger would list
    # it first, a time-ordered one must OMIT it under cap=4 and account for it in the remainder.
    rets = [0.01, 0.02, 0.01, 0.02, 0.01, 0.02, 0.01, 0.90]
    trades = pd.DataFrame(
        {
            "entry_time": [base + 10 * i * day for i in range(8)],
            "exit_time": [base + (10 * i + 3) * day for i in range(8)],
            "ret": rets,
        }
    )
    led = episode_ledger(trades, cap=4)
    assert led["cap"] == 4 and led["n_total"] == 8
    assert len(led["entries"]) == 4 and led["n_omitted"] == 4
    starts = [e["start"] for e in led["entries"]]
    assert starts == sorted(starts)  # earliest first, never ranked by share
    total = sum(abs(r) for r in rets)
    assert [e["share_abs"] for e in led["entries"]] == [
        pytest.approx(abs(r) / total) for r in rets[:4]
    ]
    assert led["omitted_share_abs"] == pytest.approx(sum(abs(r) for r in rets[4:]) / total)
    assert sum(e["share_abs"] for e in led["entries"]) + led["omitted_share_abs"] == (
        pytest.approx(1.0)
    )
    # the whale stayed in the omitted mass — truncation promoted nothing
    assert all(e["share_abs"] < 0.5 for e in led["entries"])


def test_episode_ledger_dead_cell_is_the_explicit_empty_block():
    assert episode_ledger(pd.DataFrame()) == {
        "entries": [], "n_total": 0, "n_omitted": 0, "omitted_share_abs": 0.0, "cap": 32,
    }
    # NaN rows drop exactly as in episode_stats — a fully-censored frame is a dead cell too
    censored = pd.DataFrame(
        {
            "entry_time": [pd.Timestamp("2021-01-01")],
            "exit_time": [pd.Timestamp("2021-01-05")],
            "ret": [float("nan")],
        }
    )
    assert episode_ledger(censored)["n_total"] == 0


def test_episode_ledger_reconciles_with_episode_stats_on_random_pools():
    # n_total == episode_stats.n_clusters is BY CONSTRUCTION (same dropna, same sort, same
    # frozen half-open merge) — pinned over random pools so the pipelines cannot drift apart.
    rng = np.random.RandomState(23)
    day = pd.Timedelta(days=1)
    base = pd.Timestamp("2019-06-01")
    for _ in range(10):
        n = int(rng.randint(1, 60))
        entry_d = np.sort(rng.randint(0, 300, size=n))
        width = rng.randint(1, 15, size=n)
        trades = pd.DataFrame(
            {
                "entry_time": [base + int(d) * day for d in entry_d],
                "exit_time": [base + int(d + w) * day for d, w in zip(entry_d, width, strict=True)],
                "ret": rng.randn(n) * 0.02,
            }
        )
        led = episode_ledger(trades)
        assert led["n_total"] == episode_stats(trades)["n_clusters"]
        assert len(led["entries"]) + led["n_omitted"] == led["n_total"]
        assert len(led["entries"]) <= EPISODE_LIST_MAX
        if led["n_omitted"] == 0:
            assert led["omitted_share_abs"] == 0.0


# ---- episode-bootstrap CI (evidence-only) ------------------------------------


def test_episode_bootstrap_deterministic_and_row_order_invariant():
    rng = np.random.RandomState(7)
    bars = np.sort(rng.choice(np.arange(0, 400, 7), size=40, replace=False))
    rets = rng.randn(40) * 0.02 + 0.005
    a = episode_bootstrap_ci(rets, bars, 5)
    b = episode_bootstrap_ci(rets, bars, 5)
    assert a == b  # same pool → identical block; the wall clock has no say
    perm = rng.permutation(40)
    c = episode_bootstrap_ci(rets[perm], bars[perm], 5)
    assert a == c  # content-seeded on the SORTED pool: row order is irrelevant
    assert a["reason"] is None and a["n_boot"] == 2000 and a["ci_level"] == 0.95
    assert a["ci_lo"] < a["ci_hi"] and a["boot_se"] > 0


def test_episode_bootstrap_constant_pool_is_degenerate():
    bars = np.arange(0, 60, 10)  # 6 disjoint episodes at h=5
    out = episode_bootstrap_ci(np.full(6, 0.01), bars, 5)
    assert out["n_episodes"] == 6
    assert out["ci_lo"] == pytest.approx(0.01) and out["ci_hi"] == pytest.approx(0.01)
    assert out["boot_se"] == pytest.approx(0.0)


def test_episode_bootstrap_refuses_thin_pools_with_a_reason():
    empty = episode_bootstrap_ci(np.array([]), np.array([], dtype=np.int64), 5)
    assert empty["reason"] == "no_observations" and empty["n_episodes"] == 0
    assert empty["ci_lo"] is None and empty["boot_se"] is None and empty["n_boot"] == 0
    four = episode_bootstrap_ci(np.full(4, 0.01), np.arange(0, 40, 10), 5)
    assert four["reason"] == "insufficient_episodes" and four["n_episodes"] == 4
    assert four["ci_lo"] is None and four["n_boot"] == 0


def test_episode_bootstrap_dense_chain_is_one_episode():
    # An every-bar firing with h > 1 transitively chains into ONE episode: there is no resampling
    # distribution over one exchangeable unit, and the block says so instead of minting one.
    out = episode_bootstrap_ci(np.random.RandomState(0).randn(100), np.arange(100), 5)
    assert out["n_episodes"] == 1 and out["reason"] == "insufficient_episodes"


def test_episode_bootstrap_half_open_tie_rule():
    # [0,5) and [5,10) do NOT merge (half-open windows, same rule as episode_stats); [0,5) and
    # [4,9) do.
    touching = episode_bootstrap_ci(np.full(6, 0.01), np.arange(0, 30, 5), 5)
    assert touching["n_episodes"] == 6
    chained = episode_bootstrap_ci(np.full(6, 0.01), np.arange(0, 24, 4), 5)
    assert chained["n_episodes"] == 1


def test_episode_bootstrap_ci_brackets_the_mean_on_a_disjoint_pool():
    # All-disjoint episodes reduce the episode bootstrap to an iid bootstrap of the mean: the
    # percentile CI brackets the sample mean and boot_se ≈ sd/√n (loose — Monte Carlo noise).
    rng = np.random.RandomState(3)
    n = 200
    rets = rng.randn(n) * 0.03 + 0.004
    out = episode_bootstrap_ci(rets, np.arange(n) * 10, 5)
    m = float(np.mean(rets))
    assert out["n_episodes"] == n
    assert out["ci_lo"] < m < out["ci_hi"]
    assert out["boot_se"] == pytest.approx(float(np.std(rets, ddof=1)) / np.sqrt(n), rel=0.25)


def test_subperiod_edges_and_means_hand_computed():
    assert list(subperiod_edges(9)) == [0, 3, 6, 9]
    assert list(subperiod_edges(10)) == [0, 3, 6, 10]  # linspace int-cast — cscv's edge rule
    edges = subperiod_edges(9)
    rets = np.array([0.01, 0.02, 0.03, 0.04])
    bars = np.array([0, 2, 3, 8])  # boundary bar 3 belongs to the SECOND era ([3, 6))
    segs = subperiod_means(rets, bars, edges)
    assert [s["n"] for s in segs] == [2, 1, 1]
    assert segs[0]["mean_ret"] == pytest.approx(0.015)
    assert segs[1]["mean_ret"] == pytest.approx(0.03)
    assert sum(s["n"] for s in segs) == len(rets)  # no purging: every closed row has ONE era
    empty = subperiod_means(np.array([]), np.array([], dtype=np.int64), edges)
    assert all(s["n"] == 0 and s["mean_ret"] is None for s in empty)
