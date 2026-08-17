"""Trade statistics for the observer-pure forward-return event study.

Operates on the trades DataFrame produced by the backtest (one row per forward-return
observation, with a ``ret`` column, ``bars_held``/``exit_reason`` and entry-time feature
columns). ``summarize`` describes ONE observation pool; ``summarize_table`` breaks the declared
grid down per (parameter combo × target) and rolls those rows up by target and by each swept
parameter (the multi-target × multi-param view). Also here: the run-level unconditional
baseline, per-cell conditional bucketing and feature↔outcome association, the overlap-aware
per-cell inference (event-time HAC t + a circular-shift rotation null — per target, and pooled
across members in basket mode), episode clustering, the per-cell episode ledger and return-mass
concentration, and the grid-level CSCV/PBO.

Every statistic in this module is NOMINAL and per-cell. Nothing here selects, ranks or crowns a
cell, and no cell's numbers are corrected for the size of the grid the caller declared — the
engine measures every declared hypothesis and reports it, and the calling agent prices its own
selection against the stamped ``n_hypotheses_attempted``. That placement is deliberate, not a
gap: a search correction computed inside one run only ever sees that run's grid, so it would
silently understate a caller who searched across runs, DSLs and data windows.

How the targets are read is the thesis's declared ``target_mode``, stamped into every summary.
Under ``conjunction`` (the default) they are the thesis's REGIME, a
condition a cell must hold across, not a search axis to cherry-pick: every target's numbers are
reported side by side and the weakest one speaks for itself, never folded into one adjusted
statistic. Under ``basket`` the targets form ONE cross-section per bar and each cell carries ONE
pooled read over the concatenated (bar × member) observations
(:func:`pooled_reliability_summary`), with the per-member numbers kept as ATTRIBUTION —
reported, never graded. In neither mode does anything here select among targets.

KNOWN CAVEAT — the rotation null assumes SHIFT EXCHANGEABILITY: rotating the firing mask is only
a valid null if the forward-return series looks the same wherever the mask lands. It does not
when volatility clusters in the same stretches the signal fires (crises, earnings seasons,
regime breaks) — rotated masks fall into calm periods, the null distribution is too narrow, and
``rot_p`` over-certifies. KNOWN CAVEAT — the overlap HAC is ANTI-CONSERVATIVE: the Bartlett
taper downweights exactly the lags that carry the overlap covariance, so ``hac_se`` understates
the long-run variance and ``t_hac`` runs hot on heavily overlapping pools. Both estimators
ride as per-cell EVIDENCE precisely because they are cheap, observer-pure and directionally
informative; neither is calibrated, so neither certifies anything on its own. Calibrating them
under dependent/heteroskedastic nulls is open statistical work, not a refactor.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Container
from itertools import pairwise
from typing import cast

import numpy as np
import pandas as pd
from scipy import stats as sps

from seikan.types import (
    BaselineStats,
    BucketMonotonicity,
    BucketRecord,
    CellBucketPanels,
    CellKey,
    ConcentrationBlock,
    EpisodeBootstrapCI,
    EpisodeLedgerBlock,
    EpisodeStatsBlock,
    FeatureAssociation,
    FeatureBucketPanel,
    GridBreakdown,
    ParamValue,
    PboBlock,
    PoolQuantiles,
    PoolSummary,
    ReliabilityCell,
    ReliabilityRead,
    ReliabilitySummary,
    RollupEntry,
    RollupKey,
    StatsTableRow,
    SubperiodCounts,
)

_NAN = float("nan")

#: The statistical-mechanics version stamped into every engine summary. Bumped whenever a
#: frozen-layer statistic changes MEANING, so two summaries compare only under the same version
#: (``seikan_version`` names the package, ``gate.POLICY_VERSION`` the checklist semantics — this
#: names the ESTIMATORS). The gate reads it as a drift detector: a summary stamped with anything
#: but this build's number refuses ungraded rather than being graded under assumptions that may
#: not hold of it.
STATISTICS_VERSION = 1


def _empty_summary() -> PoolSummary:
    return {
        "n": 0,
        "n_valid": 0,
        "exit_reasons": {},
        "mean_ret": _NAN,
        "median_ret": _NAN,
        "std_ret": _NAN,
        "hit_rate": _NAN,
        "t_iid": _NAN,
        "p_iid": _NAN,
        "win_loss_ratio": _NAN,
        "skewness": _NAN,
        "kurtosis": _NAN,
        "tail_ratio": _NAN,
        "cvar_5": _NAN,
        "mean_bars_held": _NAN,
        "median_bars_held": _NAN,
        "max_bars_held": _NAN,
    }


def summarize(trades: pd.DataFrame) -> PoolSummary:
    """Summary statistics over forward-return observations (n, mean, t-stat, hit rate, win/loss
    ratio, skew, …) — observer effect-size / distribution-shape stats, no equity-curve framing.

    ``t_iid``/``p_iid`` are the CLASSICAL iid pair: on overlapping forward-return pools they are
    mechanically over-stated and are kept for reference only. What inference this engine offers
    lives in the reliability layer (``rot_p``/``t_hac``), never in these."""
    n = len(trades)
    if n == 0:
        return _empty_summary()

    rets = trades["ret"].to_numpy(dtype=float)
    rets = rets[~np.isnan(rets)]
    n_valid = int(rets.shape[0])

    summary = _empty_summary()
    summary["n"] = n
    summary["n_valid"] = n_valid
    summary["exit_reasons"] = (
        trades["exit_reason"].value_counts().to_dict()
        if "exit_reason" in trades
        else {}
    )
    if n_valid == 0:
        return summary

    mean_ret = float(np.mean(rets))
    std_ret = float(np.std(rets, ddof=1)) if n_valid > 1 else _NAN
    if n_valid > 1 and std_ret > 0:
        t_iid, p_iid = sps.ttest_1samp(rets, 0.0)
        t_iid, p_iid = float(t_iid), float(p_iid)
    else:
        t_iid, p_iid = _NAN, _NAN
    bars_held = trades["bars_held"].to_numpy(dtype=float)
    mean_hold = float(np.mean(bars_held))

    # Observer effect-size / shape stats (no equity-curve framing). win_loss_ratio is the payoff
    # asymmetry partnering hit_rate (NaN when one side is empty — no ratio to form); skewness flags
    # whether the mean is representative for event-driven/fat-tail theses. Caveat: on overlapping
    # pools a single move is smeared across ~horizon observations, so pooled skew is directionally
    # informative, not exact.
    wins, losses = rets[rets > 0], rets[rets < 0]
    win_loss_ratio = (
        float(np.mean(wins) / abs(np.mean(losses))) if wins.size and losses.size else _NAN
    )
    skewness = float(sps.skew(rets)) if n_valid > 2 else _NAN
    # Pearson kurtosis (normal → 3.0) — with skew it flags when the mean is a poor description of
    # a fat-tailed event pool, which is exactly when a positive mean_ret means least.
    kurtosis = float(sps.kurtosis(rets, fisher=False)) if n_valid > 3 else _NAN
    # Tail asymmetry / tail risk (nautilus/vbt-standard evidence): |p95/p5| and the mean of the
    # worst 5% of observations (historical CVaR). Descriptive only — no checklist reads them.
    p5, p95 = (np.percentile(rets, [5.0, 95.0]) if n_valid > 1 else (_NAN, _NAN))
    tail_ratio = float(abs(p95 / p5)) if n_valid > 1 and p5 != 0 and not math.isnan(p5) else _NAN
    tail = rets[rets <= p5] if n_valid > 1 else np.empty(0)
    cvar_5 = float(np.mean(tail)) if tail.size else _NAN

    summary.update(
        {
            "mean_ret": mean_ret,
            "median_ret": float(np.median(rets)),
            "std_ret": std_ret,
            "hit_rate": float(np.mean(rets > 0)),
            "t_iid": t_iid,
            "p_iid": p_iid,
            "win_loss_ratio": win_loss_ratio,
            "skewness": skewness,
            "kurtosis": kurtosis,
            "tail_ratio": tail_ratio,
            "cvar_5": cvar_5,
            "mean_bars_held": mean_hold,
            "median_bars_held": float(np.median(bars_held)),
            "max_bars_held": int(np.max(bars_held)),
        }
    )
    return summary


# The breakdown-table columns per fired cell — the full descriptive set `summarize` computes
# (`exit_reasons` stays out: it is dict-valued, not a table metric). The per-cell panels call
# `summarize` directly.
_TABLE_METRICS = [
    "n",
    "n_valid",
    "mean_ret",
    "median_ret",
    "std_ret",
    "hit_rate",
    "t_iid",
    "p_iid",
    "win_loss_ratio",
    "skewness",
    "kurtosis",
    "tail_ratio",
    "cvar_5",
    "mean_bars_held",
    "median_bars_held",
    "max_bars_held",
]
_ROLLUP_METRICS = ("mean_ret", "hit_rate", "sharpe", "win_loss_ratio", "firing_rate")


def _py(value: object) -> str | int | float:
    """numpy scalar → plain python (int/float/str) for JSON-safe summaries."""
    item = getattr(value, "item", None)
    # The cast states what the line above already does: a groupby key is a numpy scalar, whose
    # `.item()` IS its python int/float/str, or a python scalar with no `.item` to call — which a
    # checker cannot read off an untyped frame's key type.
    return cast("str | int | float", item() if callable(item) else value)


def _rollup(table: pd.DataFrame, col: str) -> dict[RollupKey, RollupEntry]:
    """Mean of rollup metrics (and summed ``n``) grouped by one column → {value: {metric: …}}."""
    metrics = [m for m in _ROLLUP_METRICS if m in table.columns]
    grouped = table.groupby(col, sort=False, dropna=False)
    means = grouped[metrics].mean(numeric_only=True)
    sizes = grouped["n"].sum() if "n" in table.columns else None
    out: dict[RollupKey, RollupEntry] = {}
    for value, row in means.iterrows():
        entry: RollupEntry = {m: float(row[m]) for m in metrics}
        if sizes is not None:
            entry["n"] = int(sizes.loc[value])
        out[_py(value)] = entry
    return out


def _bucket_records(table: pd.DataFrame) -> list[BucketRecord]:
    """JSON-friendly records from a ``conditional_buckets`` table (index = the qcut interval)."""
    return [
        {
            "bucket": str(idx),
            "n": int(row["n"]),
            "mean_ret": float(row["mean_ret"]),
            "hit_rate": float(row["hit_rate"]),
        }
        for idx, row in table.iterrows()
    ]


def _bucket_monotonicity(records: list[BucketRecord]) -> BucketMonotonicity | None:
    """Spearman rank correlation between bucket ORDER and bucket ``mean_ret`` — is the edge
    monotone in the feature? (alphalens' mean-return-by-quantile, reduced to one number.) The
    records arrive in ascending feature order, so ``rho`` > 0 means "higher feature → higher return"
    and ``sign`` is its sign (for a feature keyed on depth or heat, a strong monotone response is
    the signature).
    ``None`` when fewer than 3 populated buckets or the means carry no rank signal (constant).
    Evidence-only — like the buckets themselves, no checklist reads it."""
    means = [
        r["mean_ret"] for r in records
        if r.get("n", 0) > 0 and not math.isnan(r.get("mean_ret", _NAN))
    ]
    # constant means → no rank signal (undefined rho)
    if len(means) < 3 or min(means) == max(means):
        return None
    order = np.arange(len(means), dtype=float)
    rho, _p = sps.spearmanr(order, means)
    if math.isnan(rho):
        return None
    return {"rho": float(rho), "sign": int(np.sign(rho))}


def summarize_table(
    trades: pd.DataFrame,
    param_levels: list[str],
    targets: list[str],
    sharpe: dict[CellKey, float] | None = None,
    firing_rate: dict[CellKey, float] | None = None,
) -> GridBreakdown:
    """The GRID breakdown: one row per (parameter combo × target), plus by-target / by-param
    rollups.

    Deliberately emits NO pooled headline. Spreading a whole-run mean/hit-rate/t-stat over the
    top level of a summary that describes a parameter × horizon GRID invites reading one number
    as "the result" — but the grid has no single result, only cells, each of which is graded on
    its own. Callers that want a pool's descriptives call :func:`summarize` on that pool.

    Deliberately emits NO pooled conditional buckets either: a pooled qcut is
    grid-composition-DEPENDENT — the same bar enters the pool once per combo × horizon, so
    adding a cell to the grid moves every other cell's "conditioning" numbers — dishonest
    conditioning, not redundancy. Conditioning is per-cell, in
    :func:`cell_conditional_buckets`; pooled views stay rebuildable from ``--trades-out``.

    ``param_levels`` are the swept-parameter column names present in ``trades`` (empty if none).
    ``sharpe`` / ``firing_rate`` optionally map a group key ``(param values…, target)`` to that
    cell's per-observation (un-annualized) Sharpe and its signal firing rate (firings / n_bars).

    Returns ``{stats_table, by_target, by_param, params, targets, n_stats_rows}``.
    ``stats_table`` covers only pools with at least one CLOSED observation — a groupby cannot
    invent a row for a combo with none — and ``n_stats_rows`` is exactly its row count; a
    consumer that must account for every DECLARED cell drives off the declared grid, not off
    this table.
    """
    group_cols = [*param_levels, "target"]
    rows: list[StatsTableRow] = []
    if not trades.empty and "target" in trades.columns:
        for key, grp in trades.groupby(group_cols, sort=False, dropna=False):
            keys = key if isinstance(key, tuple) else (key,)
            row: StatsTableRow = {c: _py(k) for c, k in zip(group_cols, keys, strict=True)}
            s = summarize(grp)
            # Every `_TABLE_METRICS` name is a key of the pool summary `s`, but the loop reads
            # them through a variable, which types each read as `object`; the cast states the
            # metric set's own contract — `exit_reasons`, the one dict-valued field, is not in it.
            row.update(cast("StatsTableRow", {m: s.get(m) for m in _TABLE_METRICS}))
            if sharpe is not None:
                row["sharpe"] = sharpe.get(tuple(keys))
            if firing_rate is not None:
                row["firing_rate"] = firing_rate.get(tuple(keys))
            rows.append(row)
    table = pd.DataFrame(rows)
    return {
        "stats_table": rows,
        "by_target": _rollup(table, "target") if not table.empty else {},
        "by_param": (
            {lvl: _rollup(table, lvl) for lvl in param_levels} if not table.empty else {}
        ),
        "params": list(param_levels),
        "targets": list(targets),
        "n_stats_rows": len(rows),
    }


def conditional_buckets(
    trades: pd.DataFrame, feature: str, q: int = 4
) -> pd.DataFrame:
    """Group trade returns into quantile buckets of an entry-time feature.

    Tests whether the signal's edge is conditional on the feature (monotonicity across buckets).
    """
    if feature not in trades.columns:
        raise KeyError(f"feature {feature!r} not in trades columns")
    valid = trades[trades[feature].notna() & trades["ret"].notna()]
    if valid.empty:
        return pd.DataFrame(columns=["n", "mean_ret", "hit_rate"])
    buckets = pd.qcut(valid[feature], q=q, duplicates="drop")
    grouped = valid.groupby(buckets, observed=True)["ret"]
    return pd.DataFrame(
        {
            "n": grouped.size(),
            "mean_ret": grouped.mean(),
            "hit_rate": grouped.apply(lambda s: float((s > 0).mean())),
        }
    )


# ---- per-cell conditioning + association (evidence-only) ---------------------------------------
#
# Both blocks are PER CELL — pooled across the cell's targets, never across cells. There is no
# run-level pooled version: a pooled qcut re-enters the same bar once per combo × horizon, so its
# "conditioning" numbers would move whenever the grid composition did. Per-cell pools are
# grid-composition-independent by construction (a cell's rows are its own), which is the property
# that makes the conditioning honest. Descriptive, overlap-inflated, read by no check.

#: Minimum valid (feature, ret) rows for a cell's bucket panel to attempt a qcut at all. Below it
#: a q=4 split averages under five rows per bucket — bucket means that are noise wearing a
#: pattern — so the panel refuses with a reason instead.
BUCKET_MIN_N = 20


def cell_conditional_buckets(
    trades: pd.DataFrame,
    feature_names: list[str],
    q: int = 4,
    min_n: int = BUCKET_MIN_N,
) -> CellBucketPanels:
    """ONE cell's conditional-bucket view over its CLOSED rows, pooled across the cell's targets.

    Returns ``{"conditional_buckets": {feature: {"buckets": [...], "reason": ...}},
    "bucket_monotonicity": {feature: {"rho", "sign"}}}`` — keyed by the two panel names it
    mounts, so the runner writes ``cell.update(cell_conditional_buckets(rows_closed, names))``.
    Every requested feature gets an entry under ``conditional_buckets`` (refusals are explicit,
    never absent); ``bucket_monotonicity`` carries only features that bucketed AND showed a rank
    signal (:func:`_bucket_monotonicity`'s ≥ 3-populated-buckets rule).

    Buckets are ascending-feature qcut quantiles (``duplicates="drop"``, the frozen
    :func:`conditional_buckets` kernel) with the record shape of :func:`_bucket_records`.
    Refusal reasons, mutually exclusive and checked in order: ``no_closed_observations`` — no
    row carries both the feature snapshot and a closed ``ret`` (a dead cell, or a feature column
    entirely NaN/absent over these rows); ``insufficient_observations`` — fewer than ``min_n``
    valid rows; ``insufficient_distinct_values`` — enough rows but too few distinct feature
    values to form ≥ 2 quantile buckets (one bucket conditions on nothing).

    Pooled across the cell's TARGETS deliberately — in basket mode this already IS the pooled
    conditioning read; in conjunction it is the cell's own rows either way — but never across
    cells. Evidence-only; overlap-inflated like every trades-pool statistic, and "associated in
    this sample" is the entire claim a bucket pattern supports.
    """
    buckets_out: dict[str, FeatureBucketPanel] = {}
    mono_out: dict[str, BucketMonotonicity] = {}
    for name in feature_names:
        if trades.empty or name not in trades.columns or "ret" not in trades.columns:
            n_valid = 0
        else:
            valid = trades[trades[name].notna() & trades["ret"].notna()]
            n_valid = len(valid)
        if n_valid == 0:
            buckets_out[name] = {"buckets": [], "reason": "no_closed_observations"}
            continue
        if n_valid < min_n:
            buckets_out[name] = {"buckets": [], "reason": "insufficient_observations"}
            continue
        try:
            records = _bucket_records(conditional_buckets(valid, name, q=q))
        except ValueError:
            records = []  # qcut could not form real bins — same refusal as the < 2-bucket case
        if len(records) < 2:
            buckets_out[name] = {"buckets": [], "reason": "insufficient_distinct_values"}
            continue
        buckets_out[name] = {"buckets": records, "reason": None}
        mono = _bucket_monotonicity(records)
        if mono is not None:
            mono_out[name] = mono
    return {"conditional_buckets": buckets_out, "bucket_monotonicity": mono_out}


#: Minimum paired (snapshot, return) observations for a per-(cell × feature × target) Spearman
#: to be reported — rank correlations on single-digit pools are sign noise.
ASSOC_MIN_N = 10


def feature_outcome_association(
    vals: np.ndarray, rets: np.ndarray, min_n: int = ASSOC_MIN_N
) -> FeatureAssociation:
    """Spearman rank correlation between ONE (cell × feature × target) pool's entry-time feature
    snapshots and its realized CLOSED returns — ``{"rho", "n", "reason"}``.

    Per target on purpose, in BOTH target modes: the time axis within one target is the only
    axis on which "higher snapshot → higher outcome" is a rank statement about the SIGNAL — a
    pooled cross-member Spearman would conflate level differences BETWEEN members with variation
    over time, an attribution artifact wearing an association's clothes.

    Pairs drop where either side is non-finite (``n`` counts the pairs actually ranked).
    Refusals are explicit: ``insufficient_observations`` below ``min_n``; ``no_rank_variation``
    when either side is constant — Spearman is undefined without ranks to correlate, and the
    reason is reported rather than ``rho = 0``, which would claim a MEASURED absence of
    association.

    Deliberately NO p-value: on overlapping forward-return pools a Spearman p is
    overlap-inflated — exactly the over-trustable number the doctrine forbids — and unlike
    ``t_hac`` there is no honest event-time correction to offer in its place. ``rho`` + ``n``
    are the whole claim: "associated in this sample", never "predicts". Evidence-only; no check
    reads it.
    """
    v = np.asarray(vals, dtype=float)
    r = np.asarray(rets, dtype=float)
    keep = np.isfinite(v) & np.isfinite(r)
    v, r = v[keep], r[keep]
    n = int(v.size)
    if n < min_n or n == 0:
        return {"rho": None, "n": n, "reason": "insufficient_observations"}
    if float(np.min(v)) == float(np.max(v)) or float(np.min(r)) == float(np.max(r)):
        return {"rho": None, "n": n, "reason": "no_rank_variation"}
    rho, _p = sps.spearmanr(v, r)
    if math.isnan(rho):  # degenerate rank structure scipy flags after the fact — same refusal
        return {"rho": None, "n": n, "reason": "no_rank_variation"}
    return {"rho": float(rho), "n": n, "reason": None}


# ---- observational reliability (overlap-aware, per-cell) ---------------------------------------
#
# Overlapping forward-return observations (the observer-native event study) are mechanically
# autocorrelated, so iid inference massively over-states significance. Three observer-pure tools,
# each computed for ONE cell against ONE null — no cross-cell maximum, no family-wise adjustment,
# because this engine reports the whole declared grid and the caller prices the multiplicity:
#
#   • an EVENT-TIME Newey-West / HAC t-stat — Bartlett weights on the actual entry-bar distance
#     between observations (two h-bar windows are correlated iff they overlap, i.e. their entry
#     bars sit < h bars apart). An honest parametric t on the cell's forward returns that never
#     mistakes event order for bar time: on a sparse pool whose neighboring firings sit years
#     apart the estimator correctly degrades to the iid SE instead of collapsing toward zero.
#   • a circular-shift (rotation) null — the forward-return series is fixed; only the firing mask is
#     time-rotated, preserving the count, temporal clustering AND overlap structure exactly. The
#     resulting ``rot_p`` answers "was THIS mask's timing informative against its own null?" and
#     nothing else; it is not a survival probability over a search.
#   • ``n_eff`` — a greedy non-overlapping observation count, so the inflation stays visible
#     (n=400, n_eff=18) and every df in the layer is set from independent information.
#
# All three are anti-conservative in known ways (see the module docstring) and none of them is a
# checklist input: they are per-cell evidence a reader weighs, never a certificate.


def newey_west_mean(
    rets: np.ndarray, entry_bars: np.ndarray, h: int, df: int | None = None
) -> tuple[float, float, float]:
    """Event-time HAC (Newey-West, Bartlett-on-bar-distance) ``(t_stat, se, p_two_sided)`` for the
    mean of forward-return observations.

    ``entry_bars`` are the observations' entry BAR indices (same basis as ``independent_count``)
    and ``h`` the measurement horizon in bars. A pair of observations whose entry bars sit ``d``
    bars apart shares ``h − d`` bars of measurement window, so its covariance enters with the
    Bartlett weight ``max(0, 1 − d/h)`` (Conley-style distance kernel — PSD in one dimension, so
    the variance stays nonnegative). For a contiguous every-bar pool (``d = k`` at event lag
    ``k``) this reproduces the classic overlap HAC with truncation lag ``h − 1`` exactly; for a
    sparse pool whose neighboring events are ≥ ``h`` bars apart every cross term drops and the
    estimator reduces to the iid SE — event ORDER is never mistaken for bar TIME (an ordinal-lag
    Bartlett with lag ≈ n drives the long-run variance toward 0 and fabricates significance).

    ``df`` sets the degrees of freedom of the p-value's reference t-distribution; the default
    ``n − 1`` is honest only for near-independent pools — on overlapping pools pass
    ``df = n_eff − 1`` so the tail reflects the independent information, not the row count
    (the pragmatic stand-in for Kiefer-Vogelsang fixed-b critical values).

    KNOWN ANTI-CONSERVATIVE on heavily overlapping pools: the Bartlett taper downweights exactly
    the lags that carry the overlap covariance, understating the long-run variance (SE ratio
    → √(2/3) ≈ 0.82 and worse as ``h`` grows; Monte Carlo under an iid-innovation null rejects
    ~10-12% at nominal 5%). The ``df = n_eff − 1`` reference fixes the tail's shape, not the SE's
    scale. No checklist reads any HAC statistic — evidence only. The derived p is not emitted per
    cell either; a consumer re-derives it from ``t_hac`` at df = n_eff − 1 when it needs one.
    """
    rets = np.asarray(rets, dtype=float)
    bars = np.asarray(entry_bars, dtype=np.int64)
    keep = ~np.isnan(rets)
    rets, bars = rets[keep], bars[keep]
    order = np.argsort(bars, kind="stable")
    rets, bars = rets[order], bars[order]
    n = rets.shape[0]
    if n < 2 or h < 1:
        return (_NAN, _NAN, _NAN)
    mean = float(rets.mean())
    dev = rets - mean
    s = float(dev @ dev) / n  # gamma_0 (long-run variance accumulator)
    for k in range(1, n):
        d = (bars[k:] - bars[:-k]).astype(float)
        w = 1.0 - d / h
        m = w > 0.0
        if not m.any():
            # gaps at event lag k are nondecreasing in k (sorted bars) — no later pair overlaps
            break
        s += 2.0 * float((w[m] * dev[k:][m] * dev[:-k][m]).sum()) / n
    if not (s > 0.0):
        return (_NAN, _NAN, _NAN)
    se = math.sqrt(s / n)
    t = mean / se
    dof = max(int(df) if df is not None else n - 1, 1)
    p = float(2.0 * sps.t.sf(abs(t), df=dof))
    return (float(t), float(se), p)


def independent_count(entry_idx: np.ndarray, horizon: int) -> int:
    """Greedy count of non-overlapping ``horizon``-bar windows among (sorted) entry bars —
    ``n_eff``."""
    idx = np.sort(np.asarray(entry_idx, dtype=int))
    if idx.shape[0] == 0:
        return 0
    count = 0
    last_end = -(10**18)
    for t in idx:
        if t >= last_end:
            count += 1
            last_end = t + horizon
    return count


# ---- CSCV → PBO (probability of backtest overfitting) ------------------------------------------
#
# Bailey, Borwein, López de Prado & Zhu (2017), "The Probability of Backtest Overfitting":
# partition the bars into S contiguous blocks; for EVERY symmetric train/test split (all
# C(S, S/2) block combinations) select the best combo on train — scored by the declared mode's
# selection statistic: the WEAKEST target's per-observation Sharpe under conjunction (the regime
# rule), the POOLED per-observation Sharpe under basket (the one-pool rule) — and locate that
# combo's rank among all combos on test. PBO = the fraction of splits where the train-winner
# lands in the test's bottom half (logit λ < 0).
#
# The engine crowns nobody, so this is not a statement about any cell: it is a GRID-LEVEL property
# of the search space the caller is about to select from — "if you pick the best cell off this
# grid, how often would that pick fail to travel to data it never saw?" — reported once per run
# and attached to no hypothesis. Purging: an observation whose measurement window crosses its
# block's right boundary is dropped up front (block-local windows), so every train/test assembly
# is leakage-free. Deterministic, no RNG. (Design reference for purged combinatorial splits:
# vectorbt.pro generic/splitting/purged.py; vbt ships no PBO — this implementation is native.)

#: Minimum scored symmetric splits for a PBO to be reported at all — S=4's full complement
#: C(4,2)=6. A "PBO" over 2-3 dependent splits has support too coarse to describe a search space
#: (it can flip on one split); below the floor the result is ``insufficient_data``.
_PBO_MIN_SPLITS = 6

#: One (combo × member) pool's per-block moment accumulators: the block counts, the block sums of
#: returns and the block sums of squares, each a ``(S,)`` array over the S blocks. Summing them
#: over a split's blocks is what makes the split score a pure arithmetic reduction.
type _MomentTriple = tuple[np.ndarray, np.ndarray, np.ndarray]


def cscv_pbo(
    cells: list[ReliabilityCell], length: int, targets: list[str], *, n_blocks: int = 8,
    off: int = 1, mode: str = "conjunction",
) -> PboBlock:
    """CSCV over the runner's per-cell (mask, fwd) arrays → ``pbo`` + degradation diagnostics.

    Tries ``n_blocks`` then falls back through 6 → 4 when too few splits score (sparse
    block-local pools typical of rare episodic firings); a partition scoring fewer than
    ``_PBO_MIN_SPLITS`` valid splits is never reported as a PBO. Reports the S that worked in
    ``blocks``. Returns ONE dict — the runner mounts it nested at ``summary["pbo"]`` — carrying
    ``pbo`` (float, or None with ``reason`` set: "single_combo" — a one-combo grid has no
    selection to overfit; "insufficient_data" — too little block-local data even at S=4),
    ``n_splits``/``n_combos``/``blocks``, ``lambda_mean`` (mean rank logit),
    ``oos_degradation_slope`` (test-score on train-score of each split's winner; < 0 flags
    inverse transfer), and ``prob_oos_loss`` (fraction of splits whose winner scored below zero
    on test). Grid-level evidence — no cell's grade reads it.

    ``mode`` is the thesis's declared ``target_mode`` and sets the SPLIT SCORE — the score
    mirrors the statistic the caller of that mode selects on, because PBO describes the
    CALLER'S selection (the engine has none). ``"conjunction"`` (default): a combo is
    admissible only when EVERY regime target has a pool, and its score is its WEAKEST target's
    per-observation Sharpe — the weakest-target rule the conjunction implies.
    ``"basket"``: the members form ONE pool, so a combo is
    admissible with ≥ 1 member present — an absent member contributes zero moments, exactly a
    member that never fired — and its score is the POOLED per-observation Sharpe over the
    concatenated member observations. No min: a basket caller selects on the pooled read.
    """
    from itertools import combinations

    if mode not in ("conjunction", "basket"):
        raise ValueError(f"unknown target_mode {mode!r}")

    empty: PboBlock = {
        "pbo": None, "reason": "insufficient_data", "n_splits": 0,
        "n_combos": 0, "blocks": int(n_blocks), "lambda_mean": _NAN,
        "oos_degradation_slope": _NAN, "prob_oos_loss": _NAN,
    }
    if not cells or length < 4:
        return empty
    targets = list(targets)

    # Combo admissibility mirrors the mode's evidence rule: conjunction demands every regime
    # target's pool (a combo missing one has no weakest member to score), basket demands ≥ 1
    # member (the pooled pool exists; absent members are zero contribution, not missing evidence).
    def _admits(present: Container[ParamValue | str]) -> bool:
        quantifier = any if mode == "basket" else all
        return quantifier(tg in present for tg in targets)

    # Early single-combo check (independent of block count): group by combo prefix.
    combo_presence: dict[CellKey, set[ParamValue | str]] = {}
    for cell in cells:
        key = tuple(cell["key"])
        combo_presence.setdefault(key[:-1], set()).add(key[-1])
    n_combos_full = sum(1 for present in combo_presence.values() if _admits(present))
    if n_combos_full < 2:
        return {**empty, "reason": "single_combo", "n_combos": n_combos_full}

    # Adaptive block counts: prefer the caller's S, then coarser partitions for sparse pools.
    block_candidates = []
    for s in (n_blocks, 6, 4):
        if s >= 2 and s % 2 == 0 and s not in block_candidates and length >= 2 * s:
            block_candidates.append(s)

    last_empty = empty
    for s in block_candidates:
        edges = np.linspace(0, length, s + 1).astype(int)
        stats_by_key: dict[CellKey, _MomentTriple] = {}
        for cell in cells:
            key = tuple(cell["key"])
            mask = np.asarray(cell["mask_col"]) > 0
            fwd = np.asarray(cell["fwd_col"], dtype=float)
            h = int(cell["h"])
            t = np.flatnonzero(mask & np.isfinite(fwd))
            b = np.clip(np.searchsorted(edges, t, side="right") - 1, 0, s - 1)
            keep = (t + off + h) < edges[b + 1]
            t, b = t[keep], b[keep]
            r = fwd[t]
            stats_by_key[key] = (
                np.bincount(b, minlength=s).astype(float),
                np.bincount(b, weights=r, minlength=s),
                np.bincount(b, weights=r * r, minlength=s),
            )

        combos: dict[CellKey, dict[ParamValue | str, _MomentTriple]] = {}
        for key in stats_by_key:
            combos.setdefault(key[:-1], {})[key[-1]] = stats_by_key[key]
        combo_keys = [c for c, present in combos.items() if _admits(present)]
        n_combos = len(combo_keys)
        if n_combos < 2:
            last_empty = {**empty, "reason": "single_combo", "n_combos": n_combos, "blocks": s}
            continue

        # Absent members (basket admissibility only — conjunction admits full combos alone)
        # zero-fill: zero count / zero sum / zero sum-of-squares is EXACTLY the moment triple of
        # a member that never fired, so the pooled arithmetic never special-cases absence.
        zero_fill = np.zeros((3, s))
        moments = np.array(
            [
                [np.stack(combos[c][tg]) if tg in combos[c] else zero_fill for tg in targets]
                for c in combo_keys
            ]
        )  # (Q, T, 3, S)

        def _score(block_idx: np.ndarray, _moments: np.ndarray = moments) -> np.ndarray:
            if mode == "basket":
                # ONE pooled pool per combo: moments summed over members AND blocks — the
                # pooled per-observation Sharpe, the statistic a basket caller selects on.
                m = _moments[:, :, :, block_idx].sum(axis=(1, 3))  # (Q, 3)
                n, s1, s2 = m[:, 0], m[:, 1], m[:, 2]
                with np.errstate(invalid="ignore", divide="ignore"):
                    mean = s1 / n
                    var = (s2 - n * mean * mean) / (n - 1.0)
                    sd = np.sqrt(np.maximum(var, 0.0))
                    return np.where((n >= 2) & (sd > 0.0), mean / sd, np.nan)
            m = _moments[:, :, :, block_idx].sum(axis=3)  # (Q, T, 3)
            n, s1, s2 = m[:, :, 0], m[:, :, 1], m[:, :, 2]
            with np.errstate(invalid="ignore", divide="ignore"):
                mean = s1 / n
                var = (s2 - n * mean * mean) / (n - 1.0)
                sd = np.sqrt(np.maximum(var, 0.0))
                sr = np.where((n >= 2) & (sd > 0.0), mean / sd, np.nan)
            # The weakest target's Sharpe, one value per combo — an axis-wise reduction, which
            # numpy's own signature can only type as `Any` (its element-wise overload returns a
            # scalar); the cast states the (Q,) array it is here.
            return cast("np.ndarray", np.min(sr, axis=1))

        lambdas: list[float] = []
        pairs: list[tuple[float, float]] = []
        for train in combinations(range(s), s // 2):
            train_idx = np.asarray(train)
            test_idx = np.asarray(sorted(set(range(s)) - set(train)))
            tr = _score(train_idx)
            if np.all(np.isnan(tr)):
                continue
            bi = int(np.nanargmax(tr))
            te = _score(test_idx)
            te_best = te[bi]
            finite_te = te[~np.isnan(te)]
            if math.isnan(te_best) or finite_te.shape[0] < 2:
                continue
            rank = float(np.sum(finite_te < te_best)) + 1.0
            omega = rank / (finite_te.shape[0] + 1.0)
            lambdas.append(math.log(omega / (1.0 - omega)))
            pairs.append((float(tr[bi]), float(te_best)))

        if len(lambdas) < _PBO_MIN_SPLITS:
            last_empty = {**empty, "n_combos": n_combos, "blocks": s}
            continue
        lam = np.asarray(lambdas)
        tr_a = np.array([p[0] for p in pairs])
        te_a = np.array([p[1] for p in pairs])
        slope = float(np.polyfit(tr_a, te_a, 1)[0]) if float(np.std(tr_a)) > 0.0 else _NAN
        return {
            "pbo": float(np.mean(lam < 0.0)),
            "reason": None,
            "n_splits": int(lam.shape[0]),
            "n_combos": n_combos,
            "blocks": int(s),
            "lambda_mean": float(np.mean(lam)),
            "oos_degradation_slope": slope,
            "prob_oos_loss": float(np.mean(te_a < 0.0)),
        }

    return last_empty


# ---- episode clustering / return-mass concentration --------------------------------------------
#
# A firing pool is not n independent bets. Overlapping measurement windows chain into market
# EPISODES, and a handful of episodes — often one crisis — can carry the pool's whole return
# mass. Both panels expose that, so a cell whose edge is one event cannot read as a broad edge.


def overlap_clusters(entry: np.ndarray, exit_: np.ndarray) -> list[list[int]]:
    """Greedy merge of overlapping ``[entry, exit)`` windows (rows MUST be sorted by entry) into
    clusters of row indices — one cluster is one contiguous market episode. Half-open tie rule: a
    window starting exactly at the running cluster end starts a NEW cluster. Chain merges
    transitively (A∩B, B∩C ⇒ one cluster even when A∦C), so ``len(clusters)`` is never larger
    than a greedy non-overlapping count over the same windows."""
    clusters: list[list[int]] = []
    cur: list[int] = []
    cur_end = None
    for i in range(np.asarray(entry).shape[0]):
        if cur_end is None or entry[i] >= cur_end:
            if cur:
                clusters.append(cur)
            cur = [i]
            cur_end = exit_[i]
        else:
            cur.append(i)
            if exit_[i] > cur_end:
                cur_end = exit_[i]
    if cur:
        clusters.append(cur)
    return clusters


def episode_stats(trades: pd.DataFrame) -> EpisodeStatsBlock:
    """Cluster one cell's CLOSED observations by overlapping ``[entry, exit)`` windows.

    Diagnostic for sparse episodic pools: firings often cluster in shared regimes (crises,
    manias, event windows), so raw ``n`` / per-target ``n_eff`` can look thin while a handful of
    calendar clusters carry the mass. Clusters by greedy merge of overlapping intervals (sorted
    by entry — :func:`overlap_clusters`); reports ``n_clusters``, the largest-by-count cluster's
    |return|-mass share and earliest entry date, and ``max_cluster_share_abs`` — the largest
    |return|-mass share held by ANY single cluster, the one-episode detector the per-cell
    concentration checklist reads. The remaining keys are evidence.

    The rows are merged ACROSS targets, so a cluster is a market episode rather than a per-target
    one: an edge that is one crisis seen through three targets must not read as three episodes.
    An empty or all-NaN pool — a declared cell that never fired, which is reported and never
    dropped — returns the zero panel with NaN shares.
    """
    empty: EpisodeStatsBlock = {
        "n": 0, "n_clusters": 0, "largest_cluster_n": 0,
        "largest_cluster_share_abs": _NAN, "largest_cluster_start": None,
        "max_cluster_share_abs": _NAN,
    }
    if trades is None or trades.empty or "entry_time" not in trades.columns:
        return empty
    df = trades.dropna(subset=["entry_time", "exit_time", "ret"]).sort_values("entry_time")
    if df.empty:
        return empty
    entry = df["entry_time"].to_numpy()
    exit_ = df["exit_time"].to_numpy()
    rets = df["ret"].to_numpy(dtype=float)

    clusters = overlap_clusters(entry, exit_)

    mag = np.abs(rets)
    total = float(mag.sum())
    largest = max(clusters, key=len)
    share = float(mag[largest].sum() / total) if total > 0 else _NAN
    max_share = (
        max(float(mag[c].sum() / total) for c in clusters) if total > 0 else _NAN
    )
    start: str | None = None
    if largest:
        t0 = entry[largest[0]]
        start = t0.isoformat() if hasattr(t0, "isoformat") else str(t0)
    return {
        "n": len(df),
        "n_clusters": len(clusters),
        "largest_cluster_n": len(largest),
        "largest_cluster_share_abs": share,
        "largest_cluster_start": start,
        "max_cluster_share_abs": max_share,
    }


#: Ledger cap for the per-cell episode list. 32 entries is enough for a
#: narrative ("the entire edge is three episodes in 2020") while keeping the report bounded;
#: truncation is EXPLICIT and mass-conserving (``n_omitted`` + ``omitted_share_abs``), so a
#: count read off a truncated ledger is a floor, never the total.
EPISODE_LIST_MAX = 32


def episode_ledger(trades: pd.DataFrame, cap: int = EPISODE_LIST_MAX) -> EpisodeLedgerBlock:
    """TIME-ORDERED per-episode ledger of one cell's CLOSED rows — the narrative companion to
    :func:`episode_stats`, which reports only the extremes.

    Same frozen pipeline as :func:`episode_stats`, step for step: rows drop NaN
    ``entry_time`` / ``exit_time`` / ``ret``, sort by ``entry_time``, and merge through
    :func:`overlap_clusters` — the half-open ``[entry, exit)`` greedy transitive merge, rows
    merged ACROSS targets so one cluster is one market episode (which is why in basket mode
    this already IS the pooled ledger). ``n_total`` therefore equals
    ``episode_stats["n_clusters"]`` on the same rows BY CONSTRUCTION — a reconciliation a
    reader re-checks from the report alone.

    Entries are EARLIEST FIRST and truncated at ``cap`` in that order — never ranked by share
    (ranking would crown episodes exactly the way the engine refuses to crown cells). Each
    entry: ``start`` / ``end`` (the cluster's earliest entry and latest exit — a chain merge
    can end on an interior row's window), ``n``, ``mean_ret``, and ``share_abs`` (the cluster's
    |return| mass over the pool total; NaN on a zero-mass pool, which serializes to null).
    Truncation is mass-conserving: ``n_omitted`` counts the clusters past the cap and
    ``omitted_share_abs`` carries their combined share, so listed + omitted shares sum to ≈ 1
    and no episode silently vanishes. A dead cell returns the explicit empty ledger, never
    null. Evidence-only; no check reads it — the gated one-episode detector is
    ``episode_stats.max_cluster_share_abs``.
    """
    empty: EpisodeLedgerBlock = {
        "entries": [], "n_total": 0, "n_omitted": 0,
        "omitted_share_abs": 0.0, "cap": int(cap),
    }
    if trades is None or trades.empty or "entry_time" not in trades.columns:
        return empty
    df = trades.dropna(subset=["entry_time", "exit_time", "ret"]).sort_values("entry_time")
    if df.empty:
        return empty
    entry = df["entry_time"].to_numpy()
    exit_ = df["exit_time"].to_numpy()
    rets = df["ret"].to_numpy(dtype=float)
    clusters = overlap_clusters(entry, exit_)
    mag = np.abs(rets)
    total = float(mag.sum())

    def _share(rows: list[int]) -> float:
        return float(mag[rows].sum() / total) if total > 0 else _NAN

    # the same stamp rule episode_stats applies to largest_cluster_start
    def _ts(t: object) -> str:
        return t.isoformat() if hasattr(t, "isoformat") else str(t)

    kept = clusters[: max(int(cap), 0)]
    omitted = clusters[len(kept):]
    return {
        "entries": [
            {
                "start": _ts(entry[c[0]]),  # rows sorted by entry: c[0] opens the episode
                "end": _ts(exit_[c].max()),
                "n": len(c),
                "mean_ret": float(np.mean(rets[c])),
                "share_abs": _share(c),
            }
            for c in kept
        ],
        "n_total": len(clusters),
        "n_omitted": len(omitted),
        # 0.0 when nothing was omitted (exact conservation over an empty remainder), NaN when
        # omitted clusters exist over a zero-mass pool — same domain rule as the entry shares.
        "omitted_share_abs": 0.0 if not omitted else float(sum(_share(c) for c in omitted)),
        "cap": int(cap),
    }


def concentration(rets: np.ndarray, top_frac: float = 0.05) -> ConcentrationBlock:
    """How much of the pool's return mass sits in its largest few observations — the
    "one-episode thesis" detector. ``top_share_abs`` is the |return| mass of the top ``top_frac``
    observations over the total |return| mass; near 1 means the whole edge is a handful of events
    (``n_eff`` shows overlap inflation, this shows MASS concentration). The per-cell
    concentration checklist reads ``top_share_abs`` against a ceiling; an empty pool yields NaN,
    which that checklist refuses rather than waves through."""
    rets = np.asarray(rets, dtype=float)
    rets = rets[~np.isnan(rets)]
    n = rets.shape[0]
    if n == 0:
        return {"top_share_abs": _NAN, "n_top": 0, "top_frac": float(top_frac)}
    k = max(1, math.ceil(top_frac * n))
    mag = np.sort(np.abs(rets))[::-1]
    total = float(mag.sum())
    share = float(mag[:k].sum() / total) if total > 0 else _NAN
    return {"top_share_abs": share, "n_top": int(k), "top_frac": float(top_frac)}


#: The percentiles every per-cell distribution block reports. Five points, not a histogram: enough
#: to state a typical outcome and both shoulders without inviting a reader to treat the tails as
#: estimated quantities.
_QUANTILE_PS: tuple[float, ...] = (10.0, 25.0, 50.0, 75.0, 90.0)


def pool_quantiles(vals: np.ndarray) -> PoolQuantiles:
    """Order statistics of a pool — ``{p10, p25, p50, p75, p90}``.

    The SHAPE read the mean cannot give: a pool whose mean sits well above its ``p50`` is carried
    by a few observations, and a reader holding only ``mean_ret`` has no way to see that. Purely
    descriptive and per pool — nothing here compares pools, and no check reads it.

    Non-finite values are dropped (so a censored path column contributes nothing rather than
    poisoning the whole block); an EMPTY pool yields NaN at every point, which serializes to null
    — "no evidence", never zero. Percentiles use ``np.percentile``'s default linear interpolation,
    the same method ``summarize`` uses for p5/p95 and the episode bootstrap uses for its CI, so
    ``p50`` agrees with ``median_ret`` on the same pool.
    """
    v = np.asarray(vals, dtype=float)
    v = v[np.isfinite(v)]
    # Both blocks render their keys FROM `_QUANTILE_PS`, which is what keeps the five points
    # declared in exactly one place; the casts state the key set that constant spells, since a
    # checker cannot read `p10`…`p90` out of a formatted string.
    if v.size == 0:
        return cast("PoolQuantiles", {f"p{int(p)}": _NAN for p in _QUANTILE_PS})
    qs = np.percentile(v, _QUANTILE_PS)
    return cast(
        "PoolQuantiles", {f"p{int(p)}": float(q) for p, q in zip(_QUANTILE_PS, qs, strict=True)}
    )


# ---- run-level unconditional baseline (evidence-only) ------------------------------------------
#
# The base rate every conditional mean must be read against: "+0.9% on firing bars" is a finding
# only next to "+0.4% on ALL bars". One pool per (horizon × target) over every fillable anchor
# bar — same next-open anchor, same algebra, same benchmark leg, same direction sign as the
# cells — plus, in basket mode, one POOLED row over the concatenated (bar × member) eligible
# observations. In-sample and unconditional; no check reads it, and there is deliberately NO
# cell-vs-baseline uplift field anywhere in the report — the comparison is the caller's.


def baseline_summary(rets: np.ndarray) -> BaselineStats:
    """Statistical fields of ONE baseline pool, from its eligible forward returns alone.

    THE SEAM (runner integration): a baseline row splits into fields the return ARRAY can carry
    and fields only the anchor GEOMETRY can. This function computes the former —
    ``{n_eligible, mean_ret, std_ret, hit_rate, ret_quantiles, worst_ret, best_ret}`` — from
    the eligible (finite) returns it is handed; the runner supplies ``n_anchor_bars`` and the
    ``exclusions`` breakdown (the exit-reason vocabulary minus ``horizon``) and mounts the row
    as ``{"n_anchor_bars": …, "exclusions": …, **baseline_summary(rets)}``. The arithmetic pin
    ``n_eligible + Σexclusions == n_anchor_bars`` is the RUNNER'S to satisfy — the exclusion
    counts are a property of the panel it reindexed, and this function cannot re-derive what
    was excluded WHY from the survivors it is handed.

    Pool-agnostic on purpose: the same function produces the per-(horizon × target) rows AND a
    basket's pooled row over the concatenated (bar × member) eligible observations — nothing in
    it knows which pool it is describing. Non-finite entries are dropped defensively
    (``n_eligible`` counts what was actually described). An EMPTY pool is all-null, NEVER zeros
    — a zero base rate is a measured outcome, and a pool with no observations measured nothing.
    ``std_ret`` is ddof=1 (NaN below two observations, the same rule as :func:`summarize`);
    ``ret_quantiles`` rides :func:`pool_quantiles`, so its ``p50`` agrees with any median a
    caller derives — there is deliberately no ``median_ret`` key, ``ret_quantiles.p50`` IS it.
    """
    v = np.asarray(rets, dtype=float)
    v = v[np.isfinite(v)]
    n = int(v.size)
    out: BaselineStats = {
        "n_eligible": n,
        "mean_ret": _NAN,
        "std_ret": _NAN,
        "hit_rate": _NAN,
        "ret_quantiles": pool_quantiles(v),
        "worst_ret": _NAN,
        "best_ret": _NAN,
    }
    if n == 0:
        return out
    out["mean_ret"] = float(np.mean(v))
    out["std_ret"] = float(np.std(v, ddof=1)) if n > 1 else _NAN
    out["hit_rate"] = float(np.mean(v > 0))
    out["worst_ret"] = float(np.min(v))
    out["best_ret"] = float(np.max(v))
    return out


# ---- episode-bootstrap CI (per-cell × per-target, evidence-only) -------------------------------
#
# The two inference-flavored per-cell numbers are BOTH anti-conservative in known directions: the
# Bartlett taper of the event-time HAC downweights exactly the lags carrying the overlap
# covariance (``t_hac`` runs hot), and the rotation null narrows under signal-aligned volatility
# clustering (``rot_p`` over-certifies). The episode bootstrap is the dependence-robust
# counterweight: it resamples EPISODES — overlap-connected ``[t, t+h)`` clusters, the same
# half-open greedy transitive merge as ``episode_stats`` but PER TARGET, never cross-target-merged
# — so within-episode dependence is preserved exactly and the interval is as wide as the episode
# count warrants, not as narrow as the row count suggests.
#
# KNOWN CAVEAT — the bootstrap assumes EPISODE INDEPENDENCE: episodes are resampled as
# exchangeable units, but adjacent episodes can still correlate through slow-moving volatility
# regimes (one crisis year's episodes co-move), so the CI is LESS anti-conservative than
# ``t_hac``, not calibrated. Per-cell EVIDENCE a reader weighs — no checklist reads any of its
# fields — and calibrating it under regime-dependent nulls is open statistical work, not a
# refactor.

#: Fixed base entropy word for the bootstrap seed — never the clock, never a cell label. Combined
#: with a sha256 of the POOL CONTENT (horizon, sorted entry bars, returns), so two identical runs
#: draw identically, row order is irrelevant, and adding a cell to the grid changes no other
#: cell's draws (positional seeding would couple sibling cells' Monte Carlo jitter to grid
#: composition — the one doctrine content-keying preserves and index-keying breaks).
_BOOT_SEED = 0x5E1CA10
BOOT_N = 2000
BOOT_CI = 0.95
BOOT_MIN_EPISODES = 5
#: Max (draws × episodes) index elements per RNG call. Purely a memory bound (~32 MB of int64):
#: the chunk row count is a pure function of the episode count, so the RNG call sequence — and
#: hence every drawn value — is deterministic for a given pool.
_BOOT_CHUNK = 1 << 22


def episode_bootstrap_ci(
    rets: np.ndarray,
    entry_bars: np.ndarray,
    h: int,
    *,
    n_boot: int = BOOT_N,
    ci: float = BOOT_CI,
    min_episodes: int = BOOT_MIN_EPISODES,
) -> EpisodeBootstrapCI:
    """Percentile CI for the pool mean under an episode (cluster) bootstrap.

    The pool's closed observations are clustered into overlap-connected episodes over their
    ``[entry_bar, entry_bar + h)`` windows (:func:`overlap_clusters` — the frozen half-open
    greedy merge, applied per target here). Each draw resamples ``n_episodes`` episodes with
    replacement; the draw's statistic is the pooled mean over the resampled observations
    (Σ episode return-sums / Σ episode counts). Same keys always: ``{method, ci_level, n_boot,
    n_episodes, ci_lo, ci_hi, boot_se, reason}`` — an empty pool reports
    ``reason="no_observations"``, fewer than ``min_episodes`` episodes reports the honest
    ``n_episodes`` with ``reason="insufficient_episodes"`` (a dense every-bar pool transitively
    chains into ONE episode: there is no resampling distribution over one exchangeable unit,
    and the null fields say so rather than minting a degenerate interval).
    """
    rets = np.asarray(rets, dtype=float)
    bars = np.asarray(entry_bars, dtype=np.int64)
    keep = np.isfinite(rets)
    rets, bars = rets[keep], bars[keep]
    out: EpisodeBootstrapCI = {
        "method": "episode_percentile",
        "ci_level": float(ci),
        "n_boot": 0,
        "n_episodes": 0,
        "ci_lo": None,
        "ci_hi": None,
        "boot_se": None,
        "reason": None,
    }
    if rets.size == 0:
        out["reason"] = "no_observations"
        return out
    order = np.argsort(bars, kind="stable")
    bars, rets = bars[order], rets[order]
    clusters = overlap_clusters(bars, bars + int(h))
    n_ep = len(clusters)
    out["n_episodes"] = int(n_ep)
    if n_ep < min_episodes:
        out["reason"] = "insufficient_episodes"
        return out
    # Clusters partition the sorted rows into CONTIGUOUS runs (the greedy merge walks the rows in
    # order), so each episode is a reduceat segment.
    starts = np.fromiter((c[0] for c in clusters), dtype=np.int64, count=n_ep)
    ep_sums = np.add.reduceat(rets, starts)
    ep_counts = np.diff(np.append(starts, rets.size))

    digest = hashlib.sha256(
        np.int64(h).tobytes() + bars.tobytes() + rets.tobytes()
    ).digest()
    rng = np.random.default_rng([_BOOT_SEED, *np.frombuffer(digest, dtype="<u4").tolist()])

    stats_arr = np.empty(n_boot, dtype=float)
    rows_per_chunk = max(1, _BOOT_CHUNK // n_ep)
    done = 0
    while done < n_boot:
        rows = min(rows_per_chunk, n_boot - done)
        idx = rng.integers(0, n_ep, size=(rows, n_ep))
        stats_arr[done : done + rows] = ep_sums[idx].sum(axis=1) / ep_counts[idx].sum(axis=1)
        done += rows

    alpha = (1.0 - ci) / 2.0
    lo, hi = np.percentile(stats_arr, [100.0 * alpha, 100.0 * (1.0 - alpha)])
    out["n_boot"] = int(n_boot)
    out["ci_lo"] = float(lo)
    out["ci_hi"] = float(hi)
    out["boot_se"] = float(np.std(stats_arr, ddof=1))
    return out


def subperiod_edges(length: int, k: int = 3) -> np.ndarray:
    """Contiguous equal-bar-count segment bounds over a ``length``-bar index — the same
    ``np.linspace`` edge rule as :func:`cscv_pbo`'s blocks. Computed ONCE per run from the shared
    joined index, so every cell reads the same eras."""
    return np.linspace(0, int(length), int(k) + 1).astype(int)


def subperiod_means(
    rets: np.ndarray, entry_bars: np.ndarray, edges: np.ndarray
) -> list[SubperiodCounts]:
    """Per segment ``{n, mean_ret}`` over a pool's closed observations, assigned by ENTRY bar.

    Era VISIBILITY, not a train/test split: there is NO purging — an observation belongs to its
    entry bar's segment even when its forward window crosses the boundary — and nothing reads the
    result. ``mean_ret`` is None for an empty segment (no evidence, not zero)."""
    rets = np.asarray(rets, dtype=float)
    bars = np.asarray(entry_bars, dtype=np.int64)
    keep = np.isfinite(rets)
    rets, bars = rets[keep], bars[keep]
    out: list[SubperiodCounts] = []
    for a, b in pairwise(edges):
        seg = rets[(bars >= a) & (bars < b)]
        out.append(
            {"n": int(seg.size), "mean_ret": float(np.mean(seg)) if seg.size else None}
        )
    return out


def _fwd_ffts(fwd: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """``(rfft(zero-filled fwd), rfft(finite indicator))`` — the two forward-side spectra of the
    circular cross-correlations in :func:`_rotation_means_fft`.

    A function of the forward column ALONE, so cells sharing a (horizon, target) share it —
    :func:`reliability_summary` memoizes it per distinct ``fwd`` content instead of recomputing
    both FFTs for every combo sibling.
    """
    fwd = np.asarray(fwd, dtype=float)
    finite = np.isfinite(fwd)
    f = np.where(finite, fwd, 0.0)
    valid = finite.astype(float)
    return np.fft.rfft(f), np.fft.rfft(valid)


def _rotation_num_den(
    mask: np.ndarray, f_fft: np.ndarray, valid_fft: np.ndarray, n: int
) -> tuple[np.ndarray, np.ndarray]:
    """The two circular cross-correlation channels of one firing mask against precomputed
    forward-side spectra — ``num[tau] = Σ_t roll(mask, tau)[t] · zerofilled(fwd)[t]`` and
    ``den[tau] = Σ_t roll(mask, tau)[t] · finite(fwd)[t]``, every shift at once via
    ``irfft(x_fft · conj(rfft(mask)))``. Split out of :func:`_rotation_means_fft` so the POOLED
    null (:func:`pooled_reliability_summary`) can sum ``num``/``den`` ACROSS members before the
    one division — the same FFT code either way, never duplicated."""
    s = (np.asarray(mask) > 0).astype(float)
    s_conj = np.conj(np.fft.rfft(s))
    num = np.fft.irfft(f_fft * s_conj, n=n)
    den = np.fft.irfft(valid_fft * s_conj, n=n)
    return num, den


def _rotation_means_fft(
    mask: np.ndarray, f_fft: np.ndarray, valid_fft: np.ndarray, n: int
) -> tuple[float, np.ndarray]:
    """:func:`_rotation_means` with the forward-side spectra precomputed; ``n`` is the series
    length. The circular cross-correlation ``r[tau] = sum_t s[(t-tau) mod T] * x[t]``
    (== ``sum(roll(s, tau) * x)``) is ``irfft(rfft(x) * conj(rfft(s)))``; the mask spectrum is
    computed once (:func:`_rotation_num_den`) and applied to both the return and the validity
    channel."""
    num, den = _rotation_num_den(mask, f_fft, valid_fft, n)
    with np.errstate(divide="ignore", invalid="ignore"):
        means = np.where(den > 0.5, num / den, _NAN)
    return float(means[0]), means


def _rotation_means(mask: np.ndarray, fwd: np.ndarray) -> tuple[float, np.ndarray]:
    """Observed conditional mean and the full circular-shift null distribution of conditional means.

    ``mask`` is the (T,) binary firing series; ``fwd`` the (T,) signed forward return (NaN where the
    horizon runs past the data). ``means[tau]`` is the conditional mean under shifting the mask by
    ``tau`` (``means[0]`` is the observed, no-shift value); the denominator is recomputed per shift
    so NaN forward bars are handled correctly.
    """
    fwd = np.asarray(fwd, dtype=float)
    f_fft, valid_fft = _fwd_ffts(fwd)
    return _rotation_means_fft(mask, f_fft, valid_fft, fwd.shape[0])


def _tail_p(observed: float, null: np.ndarray) -> float:
    """One-sided right-tail p with the (1+·)/(1+·) small-sample correction. NaN-safe."""
    null = np.asarray(null, dtype=float)
    null = null[~np.isnan(null)]
    if null.shape[0] == 0 or math.isnan(observed):
        return _NAN
    return float((1.0 + np.sum(null >= observed)) / (1.0 + null.shape[0]))


def reliability_summary(
    cells: list[ReliabilityCell], length: int, targets: list[str]
) -> ReliabilitySummary:
    """Per-cell overlap-aware inference over the declared grid — one independent descriptive read
    per (param combo × horizon × target). Not a selector: nothing here compares cells.

    Each ``cell`` is ``{"key": (param values…, target), "mask_col": (T,), "fwd_col": (T,) signed,
    "h": horizon}`` — the LAST key element is the target. Every cell is measured on its OWN firing
    mask against its OWN circular-shift null, so two cells' numbers are directly comparable
    precisely because neither has been conditioned on the other, and adding a cell to the grid
    changes no other cell's numbers. ``targets`` names the regime the cells span; no cross-target
    statistic is formed from it here — the conjunction is reported target by target and the reader
    (or the per-cell checklist) applies the weakest-target rule.

    Per cell: ``rot_p`` — the one-sided right-tail p of the observed conditional mean against the
    circular-shift null, where the forward-return series is FIXED and only the firing mask rotates,
    preserving the firing count, the temporal clustering AND the overlap structure exactly;
    ``t_hac``/``hac_se`` — the event-time Newey-West mean (Bartlett weights on actual entry-bar
    distances, df = n_eff − 1); and ``n_eff`` — the greedy non-overlapping window count that makes
    the overlap inflation visible (n = 400, n_eff = 18).

    The null uses ALL ``length − 1`` non-identity circular shifts: the FFT in
    :func:`_rotation_means` computes every shift anyway, and a deterministic evenly-spaced
    subsample suffers residue aliasing (on periodic signals whole shift phases go missing from the
    null). ``n_shifts`` is returned so a consumer can read the p's resolution — the smallest
    attainable ``rot_p`` is ``1/(1 + n_shifts)``, and a p at that floor means "no shift beat the
    observation", not "p ≈ 0".

    KNOWN CAVEATS, both anti-conservative, and the reason these numbers certify nothing on their
    own: the rotation null assumes the forward returns are exchangeable under time rotation, which
    fails when volatility clusters where the signal fires (rotated masks land in calm stretches and
    the null is too narrow); and the Bartlett taper downweights exactly the lags carrying the
    overlap covariance, so ``hac_se`` understates the long-run variance.

    Returns ``{"per_cell": {full_key: {rot_p, t_hac, hac_se, n_eff}}, "n_shifts": int}``. A cell
    that never fired has no entry — the runner tracks the DECLARED grid separately, so a missing
    key here reads as "no firings", never as "dropped". Memory: one ``(length,)`` float64 null
    array is live at a time (each cell's shifts collapse to a tail probability immediately), so
    the pass is O(length) in space regardless of grid size.
    """
    empty: ReliabilitySummary = {"per_cell": {}, "n_shifts": 0}
    if not cells or length < 3:
        return empty
    shifts = np.arange(1, length, dtype=int)
    n_shifts = shifts.shape[0]

    per_cell: dict[CellKey, ReliabilityRead] = {}
    # The forward-side FFTs are a function of `fwd_col` alone, which combo siblings sharing a
    # (horizon, target) pass in with identical content — memoized by content (bytes) so the O(T
    # log T) transforms run once per distinct forward series, not once per cell. Content-keyed
    # rather than (h, target)-keyed on purpose: it is immune to synthetic inputs whose key fields
    # do not determine the column, and the O(T) hash is cheap beside the FFT it saves.
    fft_memo: dict[bytes, tuple[np.ndarray, np.ndarray]] = {}
    for cell in cells:
        key = tuple(cell["key"])
        mask = np.asarray(cell["mask_col"])
        fwd = np.asarray(cell["fwd_col"], dtype=float)
        h = int(cell["h"])
        fkey = fwd.tobytes()
        ffts = fft_memo.get(fkey)
        if ffts is None:
            ffts = fft_memo[fkey] = _fwd_ffts(fwd)
        observed, means = _rotation_means_fft(mask, *ffts, fwd.shape[0])
        rot_p = _tail_p(observed, means[shifts])

        closed = (np.asarray(mask) > 0) & np.isfinite(fwd)
        t_closed = np.flatnonzero(closed)
        rets = fwd[t_closed]
        n_eff = independent_count(t_closed, h)
        # df = n_eff-1: on an overlapping pool the row count n wildly overstates the information,
        # and a df of n-1 makes the tail anti-conservative. (The p itself is not emitted —
        # derivable from t_hac at this df.)
        t_hac, hac_se, _p = newey_west_mean(rets, t_closed, h, df=max(n_eff - 1, 1))
        per_cell[key] = {
            "rot_p": rot_p, "t_hac": t_hac, "hac_se": hac_se,
            "n_eff": int(n_eff),
        }

    return {
        "per_cell": per_cell,
        "n_shifts": int(n_shifts),  # shifts actually used — min achievable p = 1/(1+n_shifts)
    }


def pooled_reliability_summary(cells: list[ReliabilityCell], length: int) -> ReliabilitySummary:
    """Basket-mode sibling of :func:`reliability_summary`: ONE pooled overlap-aware read per
    (param combo × horizon), over the union of that combo's member (target) pools.

    Consumes the SAME cell entries (``{"key": (param values…, target), "mask_col", "fwd_col",
    "h"}``), grouped by ``key[:-1]`` — the combo prefix — in first-seen order; a group's members
    share one ``h`` by construction (a swept horizon rides the prefix). ``G = 1`` reduces
    EXACTLY to the per-target read: same spectra, same division, same kernels on the same rows.

    ``rot_p`` — the COMMON-SHIFT rotation null: one shift ``tau`` rotates EVERY member's mask
    as a block. That is the null a cross-sectional signal warrants: it preserves each member's
    firing count, clustering and overlap structure (as the per-target null does) AND the
    per-bar cross-sectional firing pattern — a rank entry fires exactly k members per firing
    bar, and independent per-member shifts would scramble that pattern into masks the signal
    could never emit. Computed as ``pooled_means[tau] = Σ_g num_g[tau] / Σ_g den_g[tau]`` from
    the same per-member FFT spectra as the per-target null (:func:`_rotation_num_den`; the
    ``fwd``-content memo is reused, so members sharing a forward column share its transforms),
    defined where the POOLED denominator clears the same ``> 0.5`` guard; same shift set
    ``1..length−1``, same :func:`_tail_p`.

    ``t_hac`` / ``hac_se`` — :func:`newey_west_mean` over the CONCATENATED member rows (closed
    bars/returns appended in cells-list order, which the runner fixes as target-declaration
    order). Two same-bar observations sit ``d = 0`` apart, so their cross term enters at
    Bartlett weight ``max(0, 1 − 0/h) = 1``: one market move seen through several members is
    ONE cluster, priced at full covariance, never counted as independent evidence — the
    cluster-robust treatment for free, the kernel stays PSD under ties, and its stable sort
    keeps same-bar rows in input order. Performance note: pooled sorted bars repeat, so the
    kernel's event-lag loop runs ~(members × h) lags before its no-overlap break — still
    trivial beside the FFTs.

    ``n_eff`` — :func:`independent_count` over the concatenated entry bars: the SAME greedy
    non-overlapping kernel as everywhere else in the engine, deliberately NOT the episode
    count, so ``n_eff`` keeps exactly one meaning engine-wide; same-bar cross-member firings
    collapse to one independent window automatically (a duplicate bar adds nothing to a greedy
    non-overlap count). ``df = max(n_eff − 1, 1)``, as in the per-target read.

    Returns ``{"per_cell": {combo_key: {rot_p, t_hac, hac_se, n_eff}}, "n_shifts": length − 1}``
    — the empty/too-short guard mirrors :func:`reliability_summary`. Grouping is structural,
    so adding a combo to the grid changes no other combo's pooled numbers: the same
    independence invariant as the per-target pass. Evidence-only, like its sibling — no check
    reads any of it directly; the runner mounts it under each basket cell's ``pooled`` block.
    """
    empty: ReliabilitySummary = {"per_cell": {}, "n_shifts": 0}
    if not cells or length < 3:
        return empty
    shifts = np.arange(1, length, dtype=int)

    groups: dict[CellKey, list[ReliabilityCell]] = {}
    for cell in cells:
        groups.setdefault(tuple(cell["key"])[:-1], []).append(cell)

    per_cell: dict[CellKey, ReliabilityRead] = {}
    fft_memo: dict[bytes, tuple[np.ndarray, np.ndarray]] = {}
    for combo_key, members in groups.items():
        h = int(members[0]["h"])  # shared across the group: a swept horizon rides the prefix
        num_sum = np.zeros(length)
        den_sum = np.zeros(length)
        bars_parts: list[np.ndarray] = []
        rets_parts: list[np.ndarray] = []
        for cell in members:
            mask = np.asarray(cell["mask_col"])
            fwd = np.asarray(cell["fwd_col"], dtype=float)
            fkey = fwd.tobytes()
            ffts = fft_memo.get(fkey)
            if ffts is None:
                ffts = fft_memo[fkey] = _fwd_ffts(fwd)
            num, den = _rotation_num_den(mask, *ffts, length)
            num_sum += num
            den_sum += den
            t_closed = np.flatnonzero((mask > 0) & np.isfinite(fwd))
            bars_parts.append(t_closed)
            rets_parts.append(fwd[t_closed])
        with np.errstate(divide="ignore", invalid="ignore"):
            means = np.where(den_sum > 0.5, num_sum / den_sum, _NAN)
        rot_p = _tail_p(float(means[0]), means[shifts])

        bars = np.concatenate(bars_parts)
        rets = np.concatenate(rets_parts)
        n_eff = independent_count(bars, h)
        t_hac, hac_se, _p = newey_west_mean(rets, bars, h, df=max(n_eff - 1, 1))
        per_cell[combo_key] = {
            "rot_p": rot_p, "t_hac": t_hac, "hac_se": hac_se,
            "n_eff": int(n_eff),
        }

    return {
        "per_cell": per_cell,
        "n_shifts": int(shifts.shape[0]),  # same resolution read as the per-target pass
    }
