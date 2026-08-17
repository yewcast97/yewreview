"""Run a thesis through the observer-native forward-return event study → ``EventStudyResult``.

For each point of the entry parameter grid (``vectorize.iter_param_assignments``) we build the
firing mask, then for each measurement ``horizon`` h record an OVERLAPPING forward-return
observation at
every firing bar: there is no exit condition and no one-position-at-a-time state machine. An
observation's return is the forward return from the fill bar to h bars later (sign set by
``direction``) — raw by default, or an EXCESS return when ``params.benchmark`` subtracts a
benchmark series' ("market") or the basket's own mean ("cross_mean", basket mode) same-window
return; observations whose horizon runs past the data end are right-censored (flagged
``is_open``/``exit_reason="open"`` for charting, excluded from the statistics; a
benchmark-missing window censors as ``"no_benchmark"``).

The runner is a PER-HYPOTHESIS REPORTER. Every DECLARED (param combo × horizon) cell is measured
once over the whole index and emitted in ``summary["cells"]`` — one entry per declared cell, in
declaration order, INCLUDING combos and horizons that never fired (an explicit zero/NaN record).
Nothing here selects, ranks or crowns a cell: no best combo, no binding target, no headline
scalar, and no statistic corrected for the size of the grid. ``thesis.target_mode`` declares what
the targets ARE: under "conjunction" they are the thesis's REGIME (a conjunction a cell must hold
across, never a search axis), reported target by target so the weakest one speaks for itself;
under "basket" they form ONE cross-section, each cell additionally carries a POOLED cross-target
block, and the per-target panel becomes attribution evidence.

Each cell carries its own nominal evidence — per-target descriptives plus the overlap-aware
``rot_p``/``t_hac``/``hac_se``/``n_eff``, its cross-target episode-cluster panel, its
|return|-mass concentration, its censoring ledger (``outcome_coverage``, over the cell's FULL rows
so an unmeasured firing stays visible) and its decision ledger (``signal_coverage``, the
undecidable-bar count that makes a firing suppressed by a missing input visible). Run-level and
combo-independent: the geometry stamps (``n_bars``, ``index_start``/``index_end``), the DECLARED
grid size ``n_hypotheses_attempted`` — the multiplicity the CALLING agent prices its own selection
against — the per-source availability panel, and the grid-level CSCV ``pbo``. Every statistic is
computed over the CLOSED subset only; the full frame (censored rows included) rides on the result
for charting and for the coverage ledgers.
"""

from __future__ import annotations

from collections.abc import Callable
from itertools import pairwise
from typing import SupportsFloat, cast

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

from seikan.analysis.result import EventStudyResult
from seikan.analysis.stats import (
    STATISTICS_VERSION,
    baseline_summary,
    cell_conditional_buckets,
    concentration,
    cscv_pbo,
    episode_bootstrap_ci,
    episode_ledger,
    episode_stats,
    feature_outcome_association,
    pool_quantiles,
    pooled_reliability_summary,
    reliability_summary,
    subperiod_edges,
    subperiod_means,
    summarize,
    summarize_table,
)
from seikan.compiler import vectorize
from seikan.compiler.data import MarketData
from seikan.constants import DEFAULT_FEATURE_NAMES, TRADE_COLUMNS
from seikan.dsl.schema import (
    Change,
    Field,
    RollingAgg,
    Series,
    Thesis,
    _series_cross_nodes,
    fmt_num,
    iter_condition_series,
    iter_source_leaves,
)
from seikan.types import (
    BarSpacing,
    BaselineEntry,
    BaselinePool,
    CellKey,
    CellOutcomeCoverage,
    CellSignalCoverage,
    CellTargetPanel,
    ComboKey,
    DeclaredCell,
    ExclusionReason,
    ExitReason,
    FeatureAssociation,
    OutcomeKind,
    OutcomeUnits,
    PoolSummary,
    ReliabilityCell,
    ReliabilityRead,
    RunSummary,
    SourceAvailability,
    SourceCoverage,
    StatsTableRow,
    SummaryCell,
)

#: The outcome algebra as a callable: ``(numerator, denominator) → signed return``, elementwise
#: over (rows × targets). ``run_backtest`` closes one of these over ``params.outcome.kind`` and
#: hands it to the path kernels, which measure through the SAME algebra every recorded return
#: does — a kernel that re-derived its own would drift from the outcome the summary stamps.
type MeasureFn = Callable[[np.ndarray, np.ndarray], np.ndarray]

_NAN = float("nan")
#: The complete exit-reason vocabulary the classification below can emit. The per-cell censoring
#: ledger reports ALL FOUR for every target, zeros included, so a reader never has to guess
#: whether an absent key means "none" or "not counted" — and so the ledger's arithmetic
#: (the reasons sum to the pool's attempted count) is re-checkable from the report alone.
_EXIT_REASONS: tuple[ExitReason, ...] = ("horizon", "open", "no_outcome", "no_benchmark")

#: The human-readable denomination each outcome algebra measures in, stamped beside the algebra
#: itself so no consumer re-derives what a ``mean_ret`` of 0.03 IS (3% vs 0.03 log units vs 0.03
#: index points) from out-of-band knowledge.
_OUTCOME_UNITS: dict[OutcomeKind, OutcomeUnits] = {
    "pct": "fraction",
    "log": "log",
    "diff": "level_diff",
}


def _bar_spacing(index: pd.DatetimeIndex) -> BarSpacing:
    """{min,median,max}_seconds between consecutive bars of the joined index — the clock geometry
    every horizon-in-bars is denominated in. Pure self-description: integers
    where the spacing is a whole second, floats otherwise, None below two bars. The engine still
    never interprets cadence — translation into "trading days" stays the caller's."""
    if len(index) < 2:
        return {"min_seconds": None, "median_seconds": None, "max_seconds": None}
    d = np.diff(index.values.astype("datetime64[ns]").astype("int64"))

    def _sec(v: SupportsFloat) -> int | float:
        ns = float(v)
        if ns.is_integer():
            q, r = divmod(int(ns), 1_000_000_000)
            return q if r == 0 else ns / 1e9
        return ns / 1e9

    return {
        "min_seconds": _sec(d.min()),
        "median_seconds": _sec(np.median(d)),
        "max_seconds": _sec(d.max()),
    }

# Default entry-time feature snapshots (grouping variables for conditional analysis), price-only:
# short/medium momentum plus realized log-return vol — the most common "edge is actually a regime
# beta" confound. Overridden by `thesis.params.features`.
_FEATURE_NODES: dict[str, Series] = {
    "ret_5": Change(input=Field(column="close"), periods=5),
    "ret_20": Change(input=Field(column="close"), periods=20),
    "vol_14": RollingAgg(
        input=Change(input=Field(column="close"), kind="log"),
        window=14,
        agg="std",
    ),
}
# dsl.schema validates that no sweep axis shadows a default feature name against this same tuple.
assert tuple(_FEATURE_NODES) == DEFAULT_FEATURE_NAMES
#: The columns this module writes into the trades frame. Declared in :mod:`seikan.constants` so
#: ``dsl.schema`` can reject a colliding ``params.features`` key at VALIDATION time — long
#: before a runner exists to be corrupted by it.
_TRADE_COLUMNS = list(TRADE_COLUMNS)


def _source_availability(thesis: Thesis, md: MarketData) -> dict[str, np.ndarray]:
    """``{source label → (rows × targets) finite mask}`` for every raw decision input the entry
    tree reads.

    The decision-side completeness contract is enforced HERE, at the sources, rather than at the
    root condition: the root's Kleene ``defined`` channel is masked by a decisive sibling
    (``F∧U = F``), and a NaN-skipping recursive kernel (EMA, expanding max/min,
    ``bars_since_extremum``) silently carries state across a hole and emits a FINITE value
    afterwards, so a hole can alter later decisions while leaving the root fully decided.

    "Available" is the finiteness of the JOINED per-bar value, which is what the decision
    actually reads. For an external feed that is the post-asof-ffill value, so ordinary sparse
    stamping (a weekly feed on daily bars) is available everywhere after its first stamp — the
    legitimate design — while a DELETED interior stamp is invisible by construction (ffill
    carries the prior value) and an explicitly stamped NaN row is not.
    """
    out: dict[str, np.ndarray] = {}
    for kind, name in iter_source_leaves(thesis.entry):
        if kind == "field":
            arr = md.field(name).to_numpy(dtype=float)
        elif kind == "external":
            arr = md.external_values(name)
        else:
            arr = md.days_since_values(name)
        out[f"{kind}:{name}"] = np.isfinite(arr)
    return out


def _source_coverage(
    src_avail: dict[str, np.ndarray], index: pd.DatetimeIndex, g: int
) -> SourceCoverage:
    """One target's per-source availability ledger over the WHOLE evaluated interval.

    Counts only holes STRICTLY AFTER a source's first available bar: a series that merely
    starts late is warmup — the observer had nothing to read yet, exactly as a transform's
    warmup window is not a hole — and ``first_available`` is reported so a late start stays
    auditable in the evidence. The interval is the full joined index: every bar a decision could
    have been taken on is covered, including the stretches no cell happened to fire in."""
    n_bars = len(index)
    union = np.zeros(n_bars, dtype=bool)
    by_source: dict[str, SourceAvailability] = {}
    for label in sorted(src_avail):
        avail = src_avail[label][:, g]
        first = int(np.argmax(avail)) if bool(avail.any()) else None
        hole = ~avail
        if first is None:
            hole[:] = False  # never available at all: no bar was ever post-warmup
        else:
            hole[:first] = False
        union |= hole
        by_source[label] = {
            "n_missing": int(hole.sum()),
            "first_available": index[first].isoformat() if first is not None else None,
        }
    return {
        "n_bars": int(n_bars),
        "n_missing": int(union.sum()),
        "by_source": by_source,
    }


def _shift_rows(arr: np.ndarray, k: int) -> np.ndarray:
    """Pull each row up by ``k`` (``out[t] = arr[t+k]``), filling the trailing ``k`` rows with
    NaN."""
    out = np.full_like(arr, np.nan)
    if 0 <= k < arr.shape[0]:
        out[: arr.shape[0] - k] = arr[k:]
    return out


def _shift_down(arr: np.ndarray, k: int) -> np.ndarray:
    """Push each row down by ``k`` (``out[t] = arr[t-k]``), filling the leading ``k`` rows with
    NaN — the mirror of :func:`_shift_rows` for a BACKWARD look (the pre-entry drift window)."""
    out = np.full_like(arr, np.nan)
    if 0 <= k < arr.shape[0]:
        out[k:] = arr[: arr.shape[0] - k]
    return out


def _forward_window_extremum(arr: np.ndarray, h: int, which: str) -> np.ndarray:
    """Forward-looking min/max over ``[t, t+h]`` (inclusive, size ``h+1``) along axis 0.

    Uses ``scipy.ndimage`` so cost is O(n) per column — no ``sliding_window_view`` stacks.
    Bars whose window runs past the data end are NaN (mirrors forward-return censoring). A NaN
    anywhere inside a bar's window also yields NaN (incomplete path).
    """
    from scipy.ndimage import maximum_filter1d, minimum_filter1d

    a = np.asarray(arr, dtype=float)
    n = a.shape[0]
    s = h + 1
    origin = -(s // 2)  # left=0, right=s-1 — forward-only window starting at t
    if which == "min":
        # +inf pad: out-of-bounds cells never win a min. (NaN inputs are handled by the explicit
        # indicator filter below — comparison-based moving filters do not reliably propagate NaN.)
        ext = minimum_filter1d(a, size=s, axis=0, origin=origin, mode="constant", cval=np.inf)
    else:
        ext = maximum_filter1d(a, size=s, axis=0, origin=origin, mode="constant", cval=-np.inf)
    # Invalidate bars whose window is incomplete (past end) or contains a NaN input. ANY NaN in
    # the window must invalidate, so the 0/1 NaN indicator takes a MAXIMUM filter (a minimum
    # would flag only all-NaN windows and certify an incomplete adverse path as finite).
    # A finite check on the filtered result also catches ±inf pads that leaked in.
    incomplete = np.arange(n) + h >= n
    if a.ndim == 1:
        nan_in_win = maximum_filter1d(
            np.isnan(a).astype(float), size=s, origin=origin, mode="constant", cval=0.0
        ) > 0
        out = np.where(incomplete | nan_in_win | ~np.isfinite(ext), np.nan, ext)
    else:
        nan_in_win = maximum_filter1d(
            np.isnan(a).astype(float), size=s, axis=0, origin=origin, mode="constant", cval=0.0
        ) > 0
        out = np.where(incomplete[:, None] | nan_in_win | ~np.isfinite(ext), np.nan, ext)
    return out


def _bars_to_positive_full(
    base_np: np.ndarray, h: int, sign: float, measure_fn: MeasureFn
) -> np.ndarray:
    """Full-anchor recovery timing, (rows × targets): ``out[f, g]`` = first j ∈ {1..h} where
    ``sign·measure(base[f+j, g], base[f, g]) >= 0``; NaN if never.

    j=0 is the fill itself (measure ≡ 0) and is skipped — recovery means returning to/above entry
    after at least one forward bar. A non-finite step before recovery, a non-finite entry, and a
    right-censored anchor (window past end) all yield NaN. A pure function of the anchor index
    given (horizon, target) — the same shape as ``mae`` — so it is computed ONCE per horizon over
    every anchor and indexed per cell, instead of per (combo × fill × j) with 1-element arrays.
    The equivalent per-anchor scan is a state machine over j = 1..h (non-finite → stop as NaN;
    first ``sign·v >= 0`` → j; exhaustion → NaN); the ``undecided`` latch below reproduces each
    transition on the same per-element floats, so the recorded counts are bit-identical.
    """
    n = base_np.shape[0]
    out = np.full(base_np.shape, np.nan)
    undecided = np.ones(base_np.shape, dtype=bool)
    for j in range(1, h + 1):
        v = sign * measure_fn(_shift_rows(base_np, j), base_np)
        finite = np.isfinite(v)
        recover = finite & (v >= 0.0)
        out[undecided & recover] = float(j)
        undecided &= finite & ~recover
    # The per-fill scan skipped (→ NaN) anchors with a non-finite entry and anchors whose window
    # runs past the data end; ``measure_fn`` alone does not imply either (a ±inf entry can still
    # measure finite under pct), so both skips are restored explicitly.
    out[~np.isfinite(base_np)] = np.nan
    out[max(n - h, 0):] = np.nan
    return out


def _bars_to_trough_full(adverse_np: np.ndarray, h: int, sign: float) -> np.ndarray:
    """Full-anchor trough timing, (rows × targets): ``out[f, g]`` = first j ∈ {0..h} at which the
    adverse mark attains its window extremum (the MAE trough).

    Long → argmin of the low path; short → argmax of the high path (first attainment on ties,
    argmin/argmax's rule). Right-censored anchors and windows containing any non-finite value are
    NaN. Computed once per horizon over every anchor (see ``_bars_to_positive_full``); NOT derived
    from ``mae_ext_by_h`` + equality matching, which would mis-rank a window containing ±inf.
    Evidence for adverse-path trough duration: how many bars until the worst interim mark.
    """
    n = adverse_np.shape[0]
    out = np.full(adverse_np.shape, np.nan)
    if h + 1 > n:
        return out
    sw = sliding_window_view(adverse_np, h + 1, axis=0)  # (n-h, targets, h+1) view, no copy
    idx = sw.argmin(axis=-1) if sign > 0 else sw.argmax(axis=-1)
    all_finite = np.isfinite(sw).all(axis=-1)
    out[: n - h] = np.where(all_finite, idx.astype(float), np.nan)
    return out


def _finite_column(df: pd.DataFrame, name: str) -> np.ndarray:
    """The FINITE values of one column of a trades sub-frame, as a float array.

    The path columns (``mae`` / ``mfe``) are NaN on rows whose excursion window held a hole even
    though the row's ``ret`` closed, so their pools are a subset of the cell's ``n`` and the
    non-finite entries must be dropped before any order statistic is taken — not counted, not
    zero-filled.
    """
    if df.empty:
        return np.empty(0)
    col: np.ndarray = df[name].to_numpy(dtype=float)
    finite: np.ndarray = col[np.isfinite(col)]
    return finite


def _norm_key(key: object) -> CellKey:
    """A pandas groupby key → a plain-python tuple, so it compares and hashes identically to the
    parameter values the declared grid carries.

    ``groupby`` hands back numpy scalars (and a bare scalar rather than a 1-tuple for a single
    grouping column); the declared cells hold the DSL's own python values. Normalizing both sides
    through one function is what lets a cell find its rows by exact dictionary lookup instead of a
    per-cell rescan of the frame."""
    values = key if isinstance(key, tuple) else (key,)
    return tuple(v.item() if hasattr(v, "item") else v for v in values)


def run_backtest(thesis: Thesis, md: MarketData) -> EventStudyResult:
    sign = -1.0 if thesis.params.direction == "shortonly" else 1.0
    # The declared target semantics (dsl.schema.Thesis.target_mode). Basket ADDS the pooled
    # cross-target reads without changing any per-target number; conjunction emits none of them.
    basket = thesis.target_mode == "basket"
    # A firing bar t fills at the NEXT bar's open — the only tradable anchor (a same-bar
    # close[t]→close[t+h] measurement would read from a price the decision itself consumed).
    off = 1
    # The measured frame (params.outcome). Default = the target's open frame (for a series target
    # the synthesized open IS the value column), measured as a pct return. An outcome feed measures
    # that feed's asof values at the same next-bar anchor; `kind` picks the measurement algebra
    # (pct / log / diff — diff for rates/spreads where a percent of a near-zero level is
    # meaningless).
    outcome = thesis.params.outcome
    outcome_series = outcome.series if outcome else "target"
    outcome_kind = outcome.kind if outcome else "pct"
    custom_outcome = outcome_series != "target"
    if thesis.target_mode == "basket" and outcome_kind == "diff":
        # Unreachable through `Thesis.model_validate` (the DSL refuses this pairing); this closes
        # the library boundary, where a hand-built `model_construct` thesis would otherwise pool
        # level-unit returns across members the engine cannot certify commensurable.
        raise ValueError(
            "target_mode='basket' is incommensurable with outcome kind 'diff' (pooled "
            "cross-member returns need a common unit); use outcome kind 'pct'/'log'"
        )
    cross_kinds = sorted(
        {
            n.type
            for series in (
                *iter_condition_series(thesis.entry),
                *(thesis.params.features or {}).values(),
            )
            for n in _series_cross_nodes(series)
        }
    )
    if cross_kinds and not basket:
        # Unreachable through `Thesis.model_validate`; closes the library boundary like the
        # guards above — the transforms-layer >= 2-columns check cannot see the MODE, so a
        # model_construct thesis could otherwise rank across a conjunction's targets.
        raise ValueError(
            f"cross-sectional node(s) {cross_kinds} require target_mode='basket'"
        )
    if custom_outcome:
        base_np = md.external_values(outcome_series)  # (rows × targets) asof feed values
    else:
        base_np = md.open.to_numpy(dtype=float)  # fill-price frame
    n_bars = base_np.shape[0]
    targets = md.targets
    index = md.index

    # The evaluation memo rides ``md.cache`` (see ``vectorize.build_series``): identical sub-series
    # across sweep combos (e.g. transforms a constant-threshold sweep leaves untouched) are built
    # once, and ``api.list_entries`` over the same ``md`` rebuilds nothing this backtest built.

    # Entry-time feature snapshots — any scalar-param Series, taken at the firing (decision) bar.
    feature_nodes = thesis.params.features or _FEATURE_NODES
    features: dict[str, np.ndarray] = {
        name: vectorize.build_series(node, md)[0].to_numpy(dtype=float)
        for name, node in feature_nodes.items()
    }
    feature_names = list(feature_nodes)

    # Horizon is the forward measurement window. A scalar runs one window; a list sweeps it as its
    # own "horizon" result axis (like the transform-window sweeps) — a return response curve.
    hz = thesis.params.horizon
    swept_horizon = isinstance(hz, list)
    horizon_values: list[int] = list(hz) if isinstance(hz, list) else [hz]

    param_levels = [lvl for lvl, _ in vectorize.collect_sweeps(thesis.entry)]
    # The entry-tree sweep axes alone — a combo dict's exact key set, BEFORE the horizon axis is
    # appended below. The canonical per-combo lookup key everywhere a combo indexes a dict.
    sweep_levels = list(param_levels)
    if swept_horizon:
        param_levels.append("horizon")
    # A swept-constant 'name' colliding with the columns this module writes (target / trade fields /
    # feature snapshots) would silently overwrite one of them. collect_sweeps already rejects
    # constant↔constant and reserved-level (target/horizon) collisions; this covers the column
    # namespace it can't see (features live in params).
    reserved_cols = {"target", *_TRADE_COLUMNS, *feature_names}
    collisions = reserved_cols.intersection(param_levels)
    if collisions:
        raise ValueError(
            f"sweep axis name(s) {sorted(collisions)} collide with reserved trade/feature columns; "
            f"rename the swept constant's 'name'"
        )

    # Benchmark adjustment (params.benchmark). "market" subtracts the `benchmark` key's series same-
    # window return; "cross_mean" (basket mode) subtracts the basket's own same-window mean.
    # Applied INSIDE _forward, before anything is recorded, so every downstream statistic
    # (rotation null, HAC, buckets, PBO) automatically describes EXCESS returns. None keeps the
    # raw path.
    bench_mode = thesis.params.benchmark
    bench_col: np.ndarray | None = None
    if bench_mode == "market":
        if outcome_kind == "diff":
            # Unreachable through `Thesis.model_validate` (the DSL refuses this pairing); this
            # closes the library boundary, where a hand-built `model_construct` thesis would
            # otherwise reach the excess arithmetic and subtract a return from a level.
            raise ValueError(
                "params.benchmark='market' is incommensurable with outcome kind 'diff' "
                "(level units minus a benchmark return); use outcome kind 'pct'/'log'"
            )
        if md.benchmark_open is None:
            raise ValueError(
                "params.benchmark='market' but MarketData has no benchmark_open "
                "(load via DataSpec.benchmark)"
            )
        bench_col = md.benchmark_open.to_numpy(dtype=float).reshape(-1, 1)
    elif bench_mode == "cross_mean":
        if thesis.target_mode != "basket" or len(targets) < 2:
            # Unreachable through `Thesis.model_validate` (cross_mean requires
            # target_mode='basket', which requires >= 2 targets); closes the library boundary
            # exactly like the market+diff guard above.
            raise ValueError(
                "params.benchmark='cross_mean' requires target_mode='basket' with >= 2 targets"
            )

    # The measurement algebra (params.outcome.kind): pct = (b/a − 1), log = ln(b/a),
    # diff = (b − a). Non-finite (0-division, log of a non-positive ratio) → NaN, censoring the
    # observation like any other unmeasurable window.
    #
    # pct and log additionally require both endpoints STRICTLY POSITIVE. Both
    # are ratio algebras and are meaningless off a positive scale, but neither fails loudly:
    # a percent change through zero or between negative levels returns a FINITE number with an
    # inverted sign (−4 → −2 reads as +50% "gain" while the level fell), and ln of a
    # negative/negative ratio is finite too. The engine would have recorded those as real
    # returns. Censoring makes them `no_outcome`, which the gate's missingness contract then
    # refuses inside a gate pool — the fail-closed direction. `diff` is untouched: signed
    # levels are exactly what it exists to measure (a 10y yield crossing zero is a −0.5 move,
    # not a domain error). OHLCV targets cannot reach this (the strict loader already refuses
    # non-positive prices); series-shaped targets and feed outcomes can.
    def _measure(num: np.ndarray, den: np.ndarray) -> np.ndarray:
        with np.errstate(divide="ignore", invalid="ignore"):
            if outcome_kind == "pct":
                r = np.where((num > 0.0) & (den > 0.0), num / den - 1.0, np.nan)
            elif outcome_kind == "log":
                r = np.where((num > 0.0) & (den > 0.0), np.log(num / den), np.nan)
            else:  # diff
                r = num - den
        return r

    # Forward-return frame per horizon, anchored at the FIRING bar t (so it lines up with the firing
    # mask for the rotation null): fwd[t] = sign·measure(base[t+off+h], base[t+off]), NaN past the
    # edge. Returns (fwd, tgt_finite): tgt_finite marks where the OUTCOME leg alone is measurable,
    # so a benchmark-caused NaN can be labelled "no_benchmark" instead of "open" in the trades
    # frame.
    def _forward(h: int) -> tuple[np.ndarray, np.ndarray]:
        den = _shift_rows(base_np, off)
        num = _shift_rows(base_np, off + h)
        fwd = sign * _measure(num, den)
        fwd = np.where(np.isfinite(fwd), fwd, np.nan)
        tgt_finite = np.isfinite(fwd)
        # A benchmark column is loaded for `params.benchmark == "market"` and for nothing else,
        # so its presence IS that mode.
        if bench_col is not None:
            bden = _shift_rows(bench_col, off)
            bnum = _shift_rows(bench_col, off + h)
            # The benchmark leg is measured in the SAME algebra as the outcome: subtracting a
            # PERCENT benchmark return from a LOG outcome would mix units silently.
            # With matching algebra a log outcome yields the true log-excess
            # ln(tgt ratio) − ln(bench ratio). `diff` + benchmark is refused at DSL validation
            # (level units minus a return is incommensurable by construction), so only the two
            # ratio algebras arrive here.
            bret = _measure(bnum, bden)  # (rows × 1), broadcast across targets
            fwd = fwd - sign * bret  # sign·(tgt_ret − bench_ret)
            fwd = np.where(np.isfinite(fwd), fwd, np.nan)
        elif bench_mode == "cross_mean":
            # Excess over the BASKET's own same-window mean (self included), in the outcome's own
            # algebra (`diff` never reaches here — basket refuses it at validation). The plain row
            # mean IS the fail-closed contract: any member's leg NaN at a bar propagates NaN into
            # the whole bar's benchmark leg, censoring every member's firing there as
            # `no_benchmark` — never a partial-basket mean, which would quietly demean the
            # surviving members by a DIFFERENT basket while their rows escape the censoring
            # ledger. `fwd` is already signed, and sign·(tgt − mean(tgt)) ≡ signed − mean(signed),
            # so demeaning after the sign is exact for shortonly too.
            mu = fwd.mean(axis=1, keepdims=True)
            fwd = fwd - mu
            fwd = np.where(np.isfinite(fwd), fwd, np.nan)
        return fwd, tgt_finite

    # Pre-entry drift frame per horizon, anchored at the FIRING bar t like ``fwd`` so it aligns with
    # the firing mask: bwd[t] = sign·measure(base[t+off], base[t+off-h]) — the RAW move INTO the
    # entry over the same h-bar window as the forward measurement (never benchmark-adjusted: it is a
    # descriptive read of the measured path, not an outcome). Sign-aligned with ``fwd`` so NEGATIVE
    # means the series moved AGAINST the eventual position before entry (moved-against-position)
    # and POSITIVE means momentum continuation. Firing bars whose pre-window precedes the
    # data start are NaN (excluded), mirroring the forward-window censoring.
    def _backward(h: int) -> np.ndarray:
        num = _shift_rows(base_np, off)  # base[t+off]
        den = _shift_down(base_np, h - off)  # base[t+off-h]
        bwd = sign * _measure(num, den)
        return np.where(np.isfinite(bwd), bwd, np.nan)

    # Adverse frame for post-entry MAE (RAW path, never benchmark-adjusted — same doctrine as
    # ``pre_ret``). Long → the low frame (worst mark-to-market); short → the high frame. Feed
    # outcomes / series-shaped targets use the measured series itself (synthesized low=high=value).
    if custom_outcome:
        adverse_np = base_np
    elif sign > 0:
        adverse_np = md.low.to_numpy(dtype=float)
    else:
        adverse_np = md.high.to_numpy(dtype=float)
    # Forward-window extremum of the adverse frame per horizon: long → min low, short → max high.
    # MAE at fill bar fe is then sign·measure(ext[fe], base[fe]) — ≤ 0 when defined.
    mae_ext_by_h: dict[int, np.ndarray] = {
        h: _forward_window_extremum(adverse_np, h, "min" if sign > 0 else "max")
        for h in horizon_values
    }
    # The FAVORABLE mirror — same frame selection reflected: long → the high frame
    # (best interim mark), short → the low frame, custom outcomes → the measured series itself.
    # RAW path like the adverse side, never benchmark-adjusted. MFE is what a "gave back the paper
    # gain" statement is read off; it is an interim MARK, never an attainable exit, because the
    # observer has no exit rule to attain it with.
    if custom_outcome:
        favorable_np = base_np
    elif sign > 0:
        favorable_np = md.high.to_numpy(dtype=float)
    else:
        favorable_np = md.low.to_numpy(dtype=float)
    mfe_ext_by_h: dict[int, np.ndarray] = {
        h: _forward_window_extremum(favorable_np, h, "max" if sign > 0 else "min")
        for h in horizon_values
    }

    fwd_by_h: dict[int, np.ndarray] = {}
    tgtfin_by_h: dict[int, np.ndarray] = {}
    bwd_by_h: dict[int, np.ndarray] = {}
    for h in horizon_values:
        fwd_by_h[h], tgtfin_by_h[h] = _forward(h)
        bwd_by_h[h] = _backward(h)
    # Path-evidence companions, hoisted to per-horizon full-anchor frames exactly like the MAE
    # extremum above: both are combo-independent, so computing them per cell repeated identical
    # work up to grid-size times over.
    btp_by_h: dict[int, np.ndarray] = {
        h: _bars_to_positive_full(base_np, h, sign, _measure) for h in horizon_values
    }
    btt_by_h: dict[int, np.ndarray] = {
        h: _bars_to_trough_full(adverse_np, h, sign) for h in horizon_values
    }

    frames: list[pd.DataFrame] = []
    sharpe: dict[CellKey, float] = {}
    firing_rate: dict[CellKey, float] = {}
    rel_cells: list[ReliabilityCell] = []
    # The basket's OWN reliability roster, kept SEPARATE from `rel_cells` on purpose: the pooled
    # rotation null must rotate every FIRED member's mask — including a member whose every
    # observation is right-censored, which `rel_cells` (closed-rows-only by construction) never
    # holds — while `rel_cells` feeds the per-target reliability pass AND `cscv_pbo`, whose
    # combo-admissibility reads would move if fired-but-uncloseable members appeared in it.
    # Appending here instead keeps every conjunction number and both modes' CSCV byte-stable.
    pooled_cells: list[ReliabilityCell] = []
    # THE DECLARED GRID — one entry per (param combo × horizon), recorded as the loop declares it
    # and BEFORE anything about firing is known. `rel_cells` above only ever holds cells that fired
    # with closed rows, and a groupby over the trades frame cannot invent a row for a combo with no
    # observations, so driving the per-cell panel off either of those would silently DELETE every
    # non-firing hypothesis from the report — precisely the hypothesis a reader most needs to see,
    # because its absence is what makes a surviving cell look inevitable. The panel is built off
    # this list instead, which is why `len(summary["cells"]) == n_hypotheses_attempted` holds by
    # construction rather than by luck.
    declared_cells: list[DeclaredCell] = []

    n_combos_attempted = 0
    # Post-warmup undefined decision bars per attempted combo — the raw material of
    # the per-cell `signal_coverage` ledger below. Keyed by COMBO, not by (combo, horizon): the
    # entry condition is what a missing input renders undecidable, and the measurement horizon has
    # no say in it. Horizon siblings therefore legitimately report the same counts — each cell is
    # graded alone, so nothing is ever summed across them.
    undef_by_combo: dict[ComboKey, np.ndarray] = {}
    for combo, entry in vectorize.iter_param_assignments(thesis.entry):
        n_combos_attempted += 1
        mask = vectorize.signal(entry, md).to_numpy()  # (bars × targets) bool, warmup-gated
        combo_tuple = tuple(combo[lvl] for lvl in sweep_levels)
        undef_by_combo[combo_tuple] = vectorize.undefined_mask(entry, md)
        for h in horizon_values:
            fwd = fwd_by_h[h]
            bwd = bwd_by_h[h]
            # The cell's identity carries the horizon ALWAYS, even when it is a fixed scalar the
            # sweep never varied: a cell that does not name its measurement window is not
            # reproducible from the report. `param_levels` holds "horizon" only when it was SWEPT,
            # so it stays the frame/lookup axis list while `params` stays the full identity.
            params = {**combo, "horizon": h}
            combo_key = tuple(params[lvl] for lvl in param_levels)
            declared_cells.append(
                {"params": params, "combo_key": combo_key, "combo_tuple": combo_tuple, "h": h}
            )
            for g, target in enumerate(targets):
                fire = np.flatnonzero(mask[:, g])
                fire = fire[fire + off <= n_bars - 1]  # must be able to fill the entry
                if fire.size == 0:
                    continue
                if basket:
                    # Every FIRED member's mask reaches the pooled rotation null, closed rows
                    # or not — a member whose firings are all right-censored still shaped the
                    # basket's cross-sectional firing pattern, and the common shift must
                    # preserve what it rotates.
                    pooled_cells.append(
                        {"key": (*combo_key, target), "mask_col": mask[:, g],
                         "fwd_col": fwd[:, g], "h": h}
                    )
                ret = fwd[fire, g]
                closed = np.isfinite(ret)
                fe = fire + off
                exit_full = fe + h
                exit_idx = np.where(closed, np.minimum(exit_full, n_bars - 1), n_bars - 1)
                entry_px = base_np[fe, g]
                exit_px = np.where(closed, base_np[np.minimum(exit_full, n_bars - 1), g], np.nan)

                df = pd.DataFrame(
                    {lvl: params[lvl] for lvl in param_levels}, index=range(fire.size)
                )
                df["target"] = target
                df["entry_time"] = index[fe]
                df["exit_time"] = index[exit_idx]
                # The firing BAR index (the basis of `independent_count` and the rotation cells) —
                # carried so every trades sub-frame can run the event-time HAC on actual bar
                # distances instead of event ordinals.
                df["entry_bar"] = fire
                df["entry_px"] = entry_px
                df["exit_px"] = exit_px
                df["bars_held"] = h
                df["ret"] = ret
                df["pre_ret"] = bwd[fire, g]  # raw price drift into the entry (evidence-only)
                # Post-entry MAE (signed ≤ 0): worst interim adverse mark over [fill, fill+h].
                # RAW path (never benchmark-adjusted). Right-censored → NaN.
                ext_at = mae_ext_by_h[h][fe, g]
                mae_raw = sign * _measure(ext_at, entry_px)
                df["mae"] = np.where(closed & np.isfinite(mae_raw), mae_raw, np.nan)
                # Post-entry MFE (signed ≥ 0): best interim favorable mark over the same window,
                # under the same RAW-path rule. The give-back companion to `mae`.
                fext_at = mfe_ext_by_h[h][fe, g]
                mfe_raw = sign * _measure(fext_at, entry_px)
                df["mfe"] = np.where(closed & np.isfinite(mfe_raw), mfe_raw, np.nan)
                # Time-to-recovery companion: first forward bar the measured path is back ≥ entry.
                df["bars_to_positive"] = np.where(closed, btp_by_h[h][fe, g], np.nan)
                # Adverse-path trough duration: bars from fill until the MAE extremum.
                df["bars_to_trough"] = np.where(closed, btt_by_h[h][fe, g], np.nan)
                # Terminal right-censoring ("open") vs an in-data hole in the MEASURED leg
                # ("no_outcome") — the SAME discrimination on every path. The two are not
                # interchangeable: `open` is structural geometry every cell near the index end
                # exhibits and the per-cell coverage checklist allows it, while an in-bounds NaN
                # is a data hole that DELETED an outcome and refuses. Under a market benchmark an
                # in-bounds NaN target leg is the latter, so labelling it "open" would hide the
                # adverse results the hole removed.
                past_end = (fire + off + h) > (n_bars - 1)
                leg = np.where(past_end, "open", "no_outcome")
                if bench_mode or custom_outcome:
                    # Outcome leg measurable but the adjusted return NaN ⇒ the benchmark (or the
                    # cross-section) was missing over the window — censored, but distinguishably
                    # so. `past_end` implies the leg itself is NaN, so a terminal row still
                    # reads "open".
                    tf = tgtfin_by_h[h][fire, g]
                    df["exit_reason"] = np.where(
                        closed, "horizon", np.where(tf, "no_benchmark", leg)
                    )
                else:
                    df["exit_reason"] = np.where(closed, "horizon", leg)
                df["is_open"] = ~closed
                for fname, farr in features.items():
                    df[fname] = farr[fire, g]
                frames.append(df)

                if closed.any():
                    rr = ret[closed]
                    # Per-observation (un-annualized) Sharpe — a standardized effect size, not a
                    # tradeable annualized ratio: the observer fires irregularly and overlapping, so
                    # sqrt-time annualization would map to no real strategy.
                    if rr.size > 1 and np.std(rr, ddof=1) > 0:
                        sharpe[(*combo_key, target)] = float(np.mean(rr) / np.std(rr, ddof=1))
                    else:
                        sharpe[(*combo_key, target)] = float("nan")
                    # Signal sparsity: ALL firing bars (incl. right-censored) / n_bars — a property
                    # of the trigger, independent of horizon censoring, so it differs from the
                    # cell's closed-only `n`.
                    firing_rate[(*combo_key, target)] = (
                        fire.size / n_bars if n_bars else float("nan")
                    )
                    rel_cells.append(
                        {"key": (*combo_key, target), "mask_col": mask[:, g],
                         "fwd_col": fwd[:, g], "h": h}
                    )

    columns = [*param_levels, "target", *_TRADE_COLUMNS, *feature_names]
    trades = (
        pd.concat(frames, ignore_index=True)[columns] if frames else pd.DataFrame(columns=columns)
    )

    # Statistics over CLOSED observations only — censored (open) ones are unrealized (their `ret` is
    # NaN); the full frame is kept on the result for charting.
    closed = trades[~trades["is_open"]] if not trades.empty else trades
    # The grid breakdown IS the first six keys of the summary; the run-level stamps below complete
    # it into the report `run_backtest` returns, which is what the cast states.
    summary = cast(
        "RunSummary", summarize_table(closed, param_levels, targets, sharpe, firing_rate)
    )
    group_cols = [*param_levels, "target"]

    # Overlap-aware inference, ONE pass over the whole index. Every declared cell that fired is
    # measured on its OWN firing mask against its OWN circular-shift null, so no cell's numbers
    # depend on any other cell's — adding a hypothesis to the grid changes nothing already
    # measured. The per-cell reads (`rot_p`, `t_hac`/`hac_se`, `n_eff`) are merged into the
    # breakdown table here and into each cell's per-target panel below; they are EVIDENCE (both
    # estimators are known anti-conservative — see analysis.stats), never a certificate.
    rel = reliability_summary(rel_cells, n_bars, targets)
    per_cell = rel["per_cell"]
    for row in summary.get("stats_table", []):
        # A row's group values are its own axis levels and target name — never the None a
        # breakdown row's open value type must admit for an unsupplied sharpe / firing_rate.
        extra = per_cell.get(cast("CellKey", tuple(row[c] for c in group_cols)))
        if extra:
            # A TypedDict cannot be spread into a mapping whose values are narrower than
            # ``object`` (its own ``__getitem__`` is typed that way), though every value here —
            # two floats and an int — is one of the row's own value types.
            row.update(cast("StatsTableRow", extra))
    # The basket's pooled reliability reads, derived from the SAME rel_cells
    # entries — one pooled entry per combo × horizon: the common-shift rotation null (one shift
    # rotates every member's mask as a block, preserving the per-bar cross-sectional firing
    # pattern a rank signal fixes) and the pooled event-time HAC / greedy n_eff over the
    # concatenated member rows. Conjunction runs form no pooled read at all.
    pooled_per_cell = (
        pooled_reliability_summary(pooled_cells, n_bars)["per_cell"] if basket else {}
    )

    # ---- run-level stamps: what was measured, over what geometry, in which algebra -------------
    #
    # Everything below is combo-independent — a property of the run, not of any hypothesis. The
    # per-cell panel carries everything that IS a property of a hypothesis.

    # Which statistical mechanics produced this summary (two summaries compare only under the same
    # version) — see analysis.stats.STATISTICS_VERSION.
    summary["statistics_version"] = STATISTICS_VERSION
    # Which sample every panel in this summary describes. There is no holdout and no embargo: each
    # declared cell is measured once over the whole index. Stamped anyway so a consumer verifies
    # the basis it is reading instead of assuming it — a summary that does not say what it
    # describes is not evidence.
    summary["gate_evidence_basis"] = "full_sample"
    # Geometry + extent of the evaluated interval. `n_bars` is the joined index length, pure
    # geometry no property of the data can shrink, which is what makes the per-cell decision
    # ledger's `n_undefined <= n_bars` re-checkable arithmetic. The endpoints let a caller tell two
    # runs over different data windows apart — the bookkeeping any cross-run search discipline
    # needs and a stateless verifier cannot itself perform.
    summary["n_bars"] = int(n_bars)
    summary["index_start"] = index[0].isoformat() if n_bars else None
    summary["index_end"] = index[-1].isoformat() if n_bars else None
    summary["bar_spacing"] = _bar_spacing(index)
    # The DECLARED search burden: every param combo × horizon the sweep declared, whether or not it
    # fired. Non-firing combos cannot shrink it, and it is the ONLY multiplicity input this engine
    # emits — nothing in the report is corrected for it. Selection across cells (and across runs,
    # DSLs and data windows, which a single run cannot see at all) belongs to the calling agent,
    # and this is the number it prices that selection against.
    summary["n_hypotheses_attempted"] = n_combos_attempted * len(horizon_values)
    summary["direction"] = thesis.params.direction  # evidence stays self-describing
    # Benchmark self-description: when set, EVERY return in this summary is an excess return —
    # consumers must know which scale they are reading.
    summary["benchmark"] = bench_mode
    summary["benchmark_source"] = md.benchmark_path
    # Outcome self-description: what was measured (series + algebra + units) and the target shape
    # — a ``diff`` outcome's mean_ret is in the series' own units (bp, index points), not a
    # percent. ALWAYS the explicit dict: the default run stamps {target, pct, fraction} rather
    # than a null, so no consumer — and no checklist — ever has to decode a missing stamp into
    # a meaning.
    summary["outcome"] = {
        "series": outcome_series,
        "kind": outcome_kind,
        "units": _OUTCOME_UNITS[outcome_kind],
    }
    summary["target_shape"] = md.target_shape
    # Target-mode self-description: which target semantics produced every
    # cross-target read in this summary. ALWAYS stamped — the checklist dispatches its rubric on
    # it, so a summary that does not say which exam applies is drifted input, not gradable.
    summary["target_mode"] = thesis.target_mode
    # Rotation-resolution transparency (evidence-only): the shift count the rotation null used —
    # every non-identity shift of the series — and the implied smallest achievable
    # p = 1/(1+n_shifts). A `rot_p` sitting at that floor means "no shift beat the observation",
    # not "p ≈ 0".
    n_shifts = int(rel.get("n_shifts", 0))
    summary["rotation"] = {
        "n_shifts": n_shifts,
        "p_resolution": (1.0 / (1.0 + n_shifts)) if n_shifts else float("nan"),
    }
    # CSCV → PBO over the grid's cells: the symmetric block splits are their own train/test
    # discipline (block-local windows are pre-purged). A GRID-LEVEL property of the search space
    # the caller is about to select from — "if you pick the best cell off this grid, how often
    # would that pick fail to travel?" — attached to no hypothesis and read by no cell's grade.
    # Mounted as ONE nested block: summary["pbo"] = {pbo, reason, n_splits, ...}.
    summary["pbo"] = cscv_pbo(rel_cells, n_bars, targets, off=off, mode=thesis.target_mode)

    # Per-SOURCE availability, computed UNCONDITIONALLY. Every raw decision leaf
    # the entry tree reads (`Field`/`External`/`DaysSince`), counted over the WHOLE evaluated
    # interval after its own first available bar. This is the layer beneath each cell's
    # `signal_coverage`: the root condition's `defined` channel answers "was the condition
    # DECIDED?", which a decisive sibling can settle (Kleene F∧U = F) and a NaN-skipping recursive
    # kernel can launder (state carried across a hole, finite output afterwards) — reading the raw
    # inputs directly puts no operator between the hole and the count. It is combo-independent
    # (the leaf SET is a property of the entry tree, not of any parameter assignment), so it is a
    # run-level panel rather than a per-cell one, and it is built whether or not anything fired —
    # a run whose sources are holed must say so even when the holes suppressed every firing.
    src_avail = _source_availability(thesis, md)
    summary["sources"] = {
        tgt: _source_coverage(src_avail, index, g) for g, tgt in enumerate(targets)
    }

    # Unconditional baseline: the same measurement with the entry condition
    # removed — every fillable anchor bar opens an observation under the SAME algebra, benchmark
    # and direction as the cells, so "conditional mean 3.1% on firing bars vs 0.4% on all bars"
    # is readable from the report alone. Pure reindexing of `fwd_by_h`/`tgtfin_by_h` — no new
    # measurement. Exclusions reuse the exit-reason vocabulary minus "horizon" (a baseline row
    # has nothing to close), and `n_eligible + Σexclusions == n_anchor_bars` is re-checkable
    # arithmetic — the honesty channel that keeps a data hole from silently shrinking the base
    # rate's denominator. NO cell-vs-baseline difference or uplift field is ever derived: the
    # comparison is the caller's. In basket mode each horizon entry ALSO carries the pooled
    # (bar × member) row — the honest base rate for a pooled conditional claim, whose counts are
    # the per-target sums (hand-averaging per-target baselines mis-weights under holes).
    anchors = np.arange(max(n_bars - 1, 0))
    baseline_panel: list[BaselineEntry] = []
    for h in horizon_values:
        fwd_h = fwd_by_h[h]
        tf_h = tgtfin_by_h[h]
        past_end = anchors + off + h > n_bars - 1
        by_target_base: dict[str, BaselinePool] = {}
        pooled_rets: list[np.ndarray] = []
        pooled_excl: dict[ExclusionReason, int] = {"open": 0, "no_outcome": 0, "no_benchmark": 0}
        for g, tgt in enumerate(targets):
            col = fwd_h[anchors, g]
            eligible = np.isfinite(col)
            miss = ~eligible
            # The SAME discrimination the trades classifier applies: an adjusted-leg hole is
            # "no_benchmark" only where the outcome leg alone was measurable; past-end geometry
            # is "open"; an in-bounds hole in the measured leg is "no_outcome".
            bench_missing = (
                (miss & tf_h[anchors, g])
                if (bench_mode or custom_outcome)
                else np.zeros_like(miss)
            )
            excl: dict[ExclusionReason, int] = {
                "open": int((miss & ~bench_missing & past_end).sum()),
                "no_outcome": int((miss & ~bench_missing & ~past_end).sum()),
                "no_benchmark": int(bench_missing.sum()),
            }
            rets_b = col[eligible]
            bs = baseline_summary(rets_b)
            # The anchor geometry first, then the statistical fields the return array carries —
            # `n_eligible` named ahead of the spread that re-sets it to the same value, so the row
            # reads counts-then-statistics in the order the arithmetic pin is checked in.
            by_target_base[tgt] = {
                "n_anchor_bars": int(anchors.size),
                "n_eligible": bs["n_eligible"],
                "exclusions": excl,
                **bs,
            }
            if basket:
                pooled_rets.append(rets_b)
                for k in pooled_excl:
                    pooled_excl[k] += excl[k]
        entry_h: BaselineEntry = {"horizon": h, "by_target": by_target_base}
        if basket:
            bs_p = baseline_summary(
                np.concatenate(pooled_rets) if pooled_rets else np.empty(0)
            )
            entry_h["pooled"] = {
                "n_anchor_bars": int(anchors.size) * len(targets),
                "n_eligible": bs_p["n_eligible"],
                "exclusions": pooled_excl,
                **bs_p,
            }
        baseline_panel.append(entry_h)
    summary["baseline"] = baseline_panel

    # ---- the per-cell panel: one entry per DECLARED hypothesis ---------------------------------
    #
    # Partition the trades frame ONCE by the declared parameter assignment. A per-cell rescan of
    # the frame would be O(cells × rows); the grid is capped at 64 cells but the row count is not,
    # and the partition is exact — every row carries the assignment that produced it.
    row_groups: dict[CellKey, np.ndarray] = {}
    target_groups: dict[CellKey, np.ndarray] = {}
    if not trades.empty:
        if param_levels:
            grouped = trades.groupby(param_levels, sort=False, dropna=False).indices
            row_groups = {_norm_key(k): idx for k, idx in grouped.items()}
        else:
            # Nothing swept: the single declared cell owns every row. `groupby([])` has no
            # meaning, so the one group is written directly rather than derived.
            row_groups = {(): np.arange(len(trades))}
        # The finer partition the per-target loop reads: one index array per (combo × target),
        # in the frame's own ascending row order (`.indices` preserves it), so the per-cell
        # per-target sub-frames are exact — no per-target boolean rescan of the combo rows.
        grouped_t = trades.groupby([*param_levels, "target"], sort=False, dropna=False).indices
        target_groups = {_norm_key(k): idx for k, idx in grouped_t.items()}
    empty_rows = trades.iloc[0:0]
    # The per-(combo × target) descriptive pools were already computed once by `summarize_table`
    # (grouping the same closed frame by the same columns in the same order); the panel below
    # reads its n / mean_ret / hit_rate from those rows instead of re-running `summarize` per
    # cell. A pool with no closed rows has no stats_table row (a groupby cannot invent one) and
    # falls back to the one shared empty-pool summary — exactly what `summarize` returned for it.
    # Each breakdown row carries `summarize`'s own metrics beside the caller-named axis levels,
    # and the empty-pool fallback IS a `summarize` return — so the three descriptive reads the
    # panel takes below (`n`, `mean_ret`, `hit_rate`) are answered by either, which is what the
    # cast states over a row type whose key set is the caller's to name.
    stats_rows: dict[CellKey, PoolSummary] = {
        _norm_key(tuple(row[c] for c in group_cols)): cast("PoolSummary", row)
        for row in summary.get("stats_table", [])
    }
    empty_pool_stats = summarize(empty_rows)

    # Subperiod geometry, computed ONCE from the shared index so every cell reads
    # the SAME three eras. The window timestamps are run geometry — a cell that never fired still
    # reports the real eras with n=0, exactly as it reports the real targets with NaN statistics.
    sub_edges = subperiod_edges(n_bars)
    sub_windows = [
        (index[a].isoformat(), index[b - 1].isoformat()) if b > a else (None, None)
        for a, b in pairwise(sub_edges)
    ]

    # Rendered cell labels: the swept axes in `param_levels` order with the horizon LAST and
    # ALWAYS present. The label is a CONVENIENCE — a cell's identity is its `params` dict plus its
    # position in this list, which is why nothing downstream may assume labels are unique.
    cell_axes = [lvl for lvl in param_levels if lvl != "horizon"] + ["horizon"]

    undef_union: np.ndarray | None = None
    cells_panel: list[SummaryCell] = []
    for dc in declared_cells:
        combo_key = dc["combo_key"]
        idx = row_groups.get(_norm_key(combo_key))
        rows = trades.iloc[idx] if idx is not None else empty_rows
        # The cell needs BOTH pools: the FULL rows (censored firings included) are the only place
        # an unmeasured firing is visible, and the CLOSED rows are the only ones any statistic may
        # describe.
        rows_closed = rows[~rows["is_open"]] if not rows.empty else rows

        # The combo's undefined-decision mask. The lookup is by construction a hit (the declared
        # cell recorded the very combo tuple the mask was stored under); if it ever missed,
        # reporting zero would fail OPEN — a silent all-clear on a decision-side hole. The
        # fallback is the union over every attempted combo, which is strictly conservative: it
        # can only ever RAISE the count, never hide a hole.
        undef = undef_by_combo.get(dc["combo_tuple"])
        if undef is None:
            if undef_union is None:
                undef_union = (
                    np.logical_or.reduce(list(undef_by_combo.values()))
                    if undef_by_combo
                    else np.zeros((n_bars, len(targets)), dtype=bool)
                )
            undef = undef_union

        by_tgt: dict[str, CellTargetPanel] = {}
        cov: dict[str, CellOutcomeCoverage] = {}
        sig: dict[str, CellSignalCoverage] = {}
        # Feature ↔ outcome association (evidence-only): Spearman between the
        # entry-time snapshot and the realized closed return, per (feature × target) — time-axis
        # within one target only in BOTH modes (a pooled cross-member rank would conflate
        # cross-member level differences with time variation, which is exactly what the entry
        # signal itself already embodies in basket mode).
        fa: dict[str, dict[str, FeatureAssociation]] = {}
        # Per-member |return|-mass, the raw material of the basket's `member_share` decomposition.
        mass_by_target: dict[str, float] = {}
        for g, tgt in enumerate(targets):
            idx_t = target_groups.get(_norm_key((*combo_key, tgt)))
            rows_t = trades.iloc[idx_t] if idx_t is not None else empty_rows
            closed_t = rows_t[~rows_t["is_open"]] if not rows_t.empty else rows_t
            s_t = stats_rows.get(_norm_key((*combo_key, tgt)), empty_pool_stats)
            # The reliability pass holds only cells that fired with closed rows; a cell it never
            # measured reads its fields off the empty mapping, one per field default below.
            rc: ReliabilityRead | dict[str, float] = per_cell.get((*combo_key, tgt)) or {}
            rets_t = closed_t["ret"].to_numpy(dtype=float) if not closed_t.empty else np.empty(0)
            bars_t = (
                closed_t["entry_bar"].to_numpy(dtype=np.int64)
                if not closed_t.empty
                else np.empty(0, dtype=np.int64)
            )
            # The excursion pools — the per-trade path columns this panel aggregates so a reader
            # needs no `--trades-out`. Non-finite values are dropped rather than carried:
            # a window hole censors `mae`/`mfe` on a row whose `ret` closed cleanly, so these
            # pools are a SUBSET of the cell's `n` and each block reports its own count.
            mae_t = _finite_column(closed_t, "mae")
            mfe_t = _finite_column(closed_t, "mfe")
            # A target with no closed rows still gets a full entry — n=0 and NaN statistics. An
            # OMITTED target would read as "not applicable here" when what actually happened is
            # "this cell produced no evidence for a target it claims to hold across", and the
            # regime conjunction is exactly what must not be quietly narrowed.
            n_eff = rc.get("n_eff")
            by_tgt[tgt] = {
                "n": s_t.get("n"),
                "n_eff": int(n_eff) if n_eff is not None else 0,
                "mean_ret": s_t.get("mean_ret"),
                "hit_rate": s_t.get("hit_rate"),
                "t_hac": rc.get("t_hac", _NAN),
                "hac_se": rc.get("hac_se", _NAN),
                "rot_p": rc.get("rot_p", _NAN),
                # |return|-mass concentration of THIS target's pool: a target riding one whale
                # event cannot pass through the regime claim on another target's breadth.
                "concentration": concentration(rets_t),
                # Episode-bootstrap CI over THIS target's pool (evidence-only):
                # the dependence-robust counterweight to the anti-conservative t_hac / rot_p.
                "boot": episode_bootstrap_ci(rets_t, bars_t, dc["h"]),
                # Era visibility (evidence-only): the same three eras for every
                # cell, this pool's n / mean per era.
                "subperiods": [
                    {"start": w[0], "end": w[1], **seg}
                    for w, seg in zip(
                        sub_windows,
                        subperiod_means(rets_t, bars_t, sub_edges),
                        strict=True,
                    )
                ],
                # Distribution shape (evidence-only): what a TYPICAL observation
                # in this pool looked like, which `mean_ret` cannot say. A positive mean sitting
                # above a negative `p50` is a pool carried by a few observations — a failure mode
                # the concentration check does not cover, since mild right skew concentrates no
                # |return| mass in one episode. No `n` here: the pool IS `n`.
                "ret_quantiles": pool_quantiles(rets_t),
                "worst_ret": float(np.min(rets_t)) if rets_t.size else _NAN,
                # Holding-period path (evidence-only): how deep the interim
                # drawdown ran and how far the interim gain reached, before the horizon closed.
                # RAW path on both sides — under a benchmark `ret` is EXCESS while these are not,
                # so the two are not commensurable and no ratio between them is meaningful here.
                "mae_quantiles": {
                    "n": int(mae_t.size),
                    **pool_quantiles(mae_t),
                    "worst": float(np.min(mae_t)) if mae_t.size else _NAN,
                },
                "mfe_quantiles": {
                    "n": int(mfe_t.size),
                    **pool_quantiles(mfe_t),
                    "best": float(np.max(mfe_t)) if mfe_t.size else _NAN,
                },
            }
            # Censoring ledger over the cell's FULL rows — ONE pool, because there is no holdout
            # and no embargo to split it into. Every firing lands under exactly one of the four
            # exit reasons, so the counts sum to `n_attempted` and no firing can vanish. This is
            # the panel that makes a DELETED outcome visible: the statistics above silently skip a
            # NaN-outcome row, which is how a vendor outage or an adversarial file could remove
            # adverse results and leave a clean-looking cell.
            counts = (
                rows_t["exit_reason"].value_counts().to_dict() if not rows_t.empty else {}
            )
            cov[tgt] = {
                "n_attempted": len(rows_t),
                "n_closed": int(counts.get("horizon", 0)),
                "exit_reasons": {k: int(counts.get(k, 0)) for k in _EXIT_REASONS},
            }
            # Decision ledger — the twin of the censoring ledger on the other side of the firing.
            # The censoring ledger can only account for bars that FIRED; a missing decision input
            # suppresses the firing itself (three-valued evaluation: `init & ~defined`), leaving
            # no trace there at all. `n_bars` is the index length — pure geometry — so
            # `n_undefined <= n_bars` is arithmetic a reader re-checks, not a claim.
            sig[tgt] = {
                "n_bars": int(n_bars),
                "n_undefined": int(undef[:, g].sum()),
            }
            mass_by_target[tgt] = float(np.abs(rets_t).sum())
            for fname in feature_names:
                vals = (
                    closed_t[fname].to_numpy(dtype=float)
                    if not closed_t.empty
                    else np.empty(0)
                )
                fa.setdefault(fname, {})[tgt] = feature_outcome_association(vals, rets_t)

        # Opened with the identity and the per-target panel, then completed in insertion order:
        # the mode-gated `pooled` block, then the blocks every cell carries. The cast states that
        # completion; the `update` below is what performs it.
        cell = cast(
            "SummaryCell",
            {
                "cell_id": ",".join(
                    f"{lvl}={fmt_num(dc['params'][lvl])}" for lvl in cell_axes
                ),
                "params": dict(dc["params"]),
                "by_target": by_tgt,
            },
        )
        if basket:
            # The basket's POOLED cross-target block — the panel the checklist
            # grades in basket mode, mirroring `by_target[t]`'s shape so there is one mental
            # model. The pooled rows are the cell's closed rows in frame order (target
            # declaration order within a bar — the deterministic tie order the bootstrap's
            # content-keyed seed sees). `by_target` above rides along as attribution evidence read
            # by no check: which members carried the pool is exactly what an industry report
            # needs, and is never a per-member verdict.
            rets_p = (
                rows_closed["ret"].to_numpy(dtype=float)
                if not rows_closed.empty
                else np.empty(0)
            )
            bars_p = (
                rows_closed["entry_bar"].to_numpy(dtype=np.int64)
                if not rows_closed.empty
                else np.empty(0, dtype=np.int64)
            )
            mae_p = _finite_column(rows_closed, "mae")
            mfe_p = _finite_column(rows_closed, "mfe")
            prc: ReliabilityRead | dict[str, float] = pooled_per_cell.get(combo_key) or {}
            n_eff_p = prc.get("n_eff")
            total_mass = sum(mass_by_target.values())
            # A full decomposition over every declared member, NEVER ranked — the raw material
            # of the "not one name" ceiling. Zero total mass → NaN shares, which the checklist
            # refuses rather than waves through (the empty-pool concentration precedent).
            member_share = {
                tgt: (mass_by_target[tgt] / total_mass if total_mass > 0 else _NAN)
                for tgt in targets
            }
            cell["pooled"] = {
                "n": len(rows_closed),
                "n_eff": int(n_eff_p) if n_eff_p is not None else 0,
                "mean_ret": float(np.mean(rets_p)) if rets_p.size else _NAN,
                "hit_rate": float(np.mean(rets_p > 0)) if rets_p.size else _NAN,
                "t_hac": prc.get("t_hac", _NAN),
                "hac_se": prc.get("hac_se", _NAN),
                "rot_p": prc.get("rot_p", _NAN),
                "concentration": concentration(rets_p),
                "member_share": {
                    "by_target": member_share,
                    "max_member_share_abs": (
                        max(member_share.values()) if total_mass > 0 else _NAN
                    ),
                },
                "boot": episode_bootstrap_ci(rets_p, bars_p, dc["h"]),
                "subperiods": [
                    {"start": w[0], "end": w[1], **seg}
                    for w, seg in zip(
                        sub_windows,
                        subperiod_means(rets_p, bars_p, sub_edges),
                        strict=True,
                    )
                ],
                "ret_quantiles": pool_quantiles(rets_p),
                "worst_ret": float(np.min(rets_p)) if rets_p.size else _NAN,
                "mae_quantiles": {
                    "n": int(mae_p.size),
                    **pool_quantiles(mae_p),
                    "worst": float(np.min(mae_p)) if mae_p.size else _NAN,
                },
                "mfe_quantiles": {
                    "n": int(mfe_p.size),
                    **pool_quantiles(mfe_p),
                    "best": float(np.max(mfe_p)) if mfe_p.size else _NAN,
                },
            }
        # The two panels `cell_conditional_buckets` computes together, mounted below under the
        # names it keys them by.
        buckets = cell_conditional_buckets(rows_closed, feature_names)
        cell.update(
            {
                # Episode clustering over the cell's CLOSED rows, merged ACROSS targets: one
                # cluster is one market episode, so an edge that is a single crisis seen through
                # three targets cannot read as three episodes.
                "episode_stats": episode_stats(rows_closed),
                # The time-ordered episode LEDGER (evidence-only): the narrative
                # companion to the shares above — earliest first, never ranked, truncation
                # explicit and mass-conserving. In basket mode the same cross-target merge makes
                # it the pooled ledger for free.
                "episodes": episode_ledger(rows_closed),
                "outcome_coverage": cov,
                "signal_coverage": sig,
                # Per-cell conditional buckets: there is no run-level pooled version — a pooled
                # qcut would re-cut every time a cell joined the grid, so the same bar's
                # "conditioning" would move with grid composition. Per cell the pool is the
                # cell's own closed rows and nothing else can move it.
                "conditional_buckets": buckets["conditional_buckets"],
                "bucket_monotonicity": buckets["bucket_monotonicity"],
                "feature_association": fa,
            }
        )
        cells_panel.append(cell)

    # One entry per declared (combo × horizon), emitted in declaration order — the loop above walks
    # `declared_cells`, which the measurement loop appended to exactly once per iteration of the
    # same product, so this identity holds BY CONSTRUCTION and no cell can be dropped for having
    # produced nothing.
    summary["cells"] = cells_panel

    return EventStudyResult(
        trades=trades,
        summary=summary,
        thesis=thesis,
    )
