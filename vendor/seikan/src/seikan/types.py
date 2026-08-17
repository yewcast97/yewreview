"""The shapes the engine's dicts actually have — the pipeline contract, stated once.

Every number this package computes travels between its modules as a plain dict: the runner
assembles the per-cell panel, ``analysis.stats`` builds the blocks that hang off it, the gate
READS those blocks by key, and ``serialize``/``cli`` emit the result as one JSON document. That
contract is real and load-bearing — a renamed key silently deletes a check — so it is written
down here as ``TypedDict`` declarations rather than left implicit in a hundred dict literals.

A LEAF module by design, exactly like :mod:`seikan.constants`: it imports nothing from the rest
of the package (and nothing at runtime at all), so any module — ``analysis.stats``,
``compiler.runner``, ``gate``, ``serialize``, ``cli`` — can import it without a cycle.

Three reading rules, so an annotation here is never mistaken for a claim the engine does not make:

- **NaN is a float, not a None.** Most statistical fields are NaN on an empty or degenerate pool
  ("no evidence") and are typed ``float`` for it; they serialize to JSON ``null`` through
  ``serialize.json_safe``. A field typed ``float | None`` is one whose PRODUCER writes a real
  ``None`` (the bootstrap's interval bounds, a subperiod's empty-segment mean, a refusal block's
  value), and the distinction is worth keeping: ``float | None`` marks a value the engine
  declined to compute, ``float`` a value it computed as undefined.
- **These describe the IN-MEMORY dicts** the runner produces and the gate reads. The emitted
  document is the same shape after ``json_safe``, with two mechanical differences: non-finite
  floats become ``null``, and non-string mapping keys (a ``by_param`` rollup is keyed by the
  swept axis VALUE) become strings.
- **Optional means optional.** ``NotRequired`` marks a key that is genuinely absent in some legal
  runs — ``pooled`` on a conjunction cell, ``rows_written`` on the report's own output entry, a
  document section another subcommand does not emit — never a key that merely might be missing
  from drifted input. The gate treats a missing REQUIRED key as drifted input and refuses; that
  refusal is its job, not this module's.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal, NotRequired, TypedDict

if TYPE_CHECKING:  # annotations only — this module imports nothing at runtime
    import numpy as np
    import pandas as pd

# ---- scalar vocabularies ------------------------------------------------------------------
#
# The small alias set the dict shapes below are built out of. The Literal ones mirror the DSL's
# own Literal fields (``dsl.schema``) so a stamp written from a validated thesis type-checks
# against the summary it is written into, and the gate's vocabulary tuples can be typed by them.

#: One swept axis's assigned value — a transform window/period, a swept ``Constant`` cutoff, or
#: the measurement horizon. Ints and floats only: the sweep axes are numeric by construction
#: (``vectorize.collect_sweeps``), and a target NAME is never a parameter.
type ParamValue = int | float

#: A cell's parameter assignment as a tuple, in ``summary["params"]`` order (the horizon last
#: when it was swept) — the runner's ``combo_key``, and the lookup key of every per-combo map.
type ComboKey = tuple[ParamValue, ...]

#: A ``ComboKey`` with the TARGET name appended — the per-(cell × target) key of the reliability
#: pass, ``sharpe``/``firing_rate``, and the runner's row-group partitions.
type CellKey = tuple[ParamValue | str, ...]

#: Any value that survives ``serialize.json_safe`` — the type of a payload this package carries
#: without interpreting: a gate check's ``observed``/``threshold``, a static contract document,
#: the parsed thesis DSL. Recursive on purpose: it says "JSON", not "anything".
type JsonValue = str | int | float | bool | list[JsonValue] | dict[str, JsonValue] | None

#: A thesis DSL document as PARSED FROM JSON, before ``dsl.schema.Thesis`` validates it — what
#: ``gate.canonical_dsl_hash`` normalizes and hashes.
type DslDocument = dict[str, JsonValue]

#: The measurement algebra (``params.outcome.kind``) every reported number is denominated in.
type OutcomeKind = Literal["pct", "log", "diff"]

#: The human-readable denomination each algebra measures in (``runner._OUTCOME_UNITS``).
type OutcomeUnits = Literal["fraction", "log", "level_diff"]

#: The declared target semantics — the stamp the checklist dispatches its rubric on.
type TargetMode = Literal["conjunction", "basket"]

#: The sign convention of every measured return (``params.direction``).
type Direction = Literal["longonly", "shortonly"]

#: The excess-return adjustment, when one was declared (``params.benchmark``).
type BenchmarkMode = Literal["market", "cross_mean"]

#: The complete exit-reason vocabulary of the censoring ledger. ``horizon`` is a closed
#: observation; the other three are censorings (``open`` = structural right-censoring at the data
#: end, the other two = data holes the checklist refuses).
type ExitReason = Literal["horizon", "open", "no_outcome", "no_benchmark"]

#: The baseline panel's exclusion vocabulary — the exit reasons MINUS ``horizon``, since a
#: baseline row has nothing to close.
type ExclusionReason = Literal["open", "no_outcome", "no_benchmark"]

#: One row of ``summary["stats_table"]``: the swept axis names (caller-chosen, so the key set is
#: not fixed) → that level's value, plus ``target``, the descriptive metrics ``summarize``
#: computes, the optional ``sharpe``/``firing_rate`` (None when the runner supplied no map), and
#: the reliability reads the runner merges in (``rot_p``/``t_hac``/``hac_se``/``n_eff``).
#: Produced by ``analysis.stats.summarize_table``; read by ``_rollup`` and by the runner's
#: per-cell panel (which looks up each cell's row instead of re-summarizing its pool).
type StatsTableRow = dict[str, float | int | str | None]

#: The key of a rollup group: a target NAME in ``by_target``, a swept axis VALUE in ``by_param``.
#: Serialization renders the numeric ones as strings; in memory they are the values themselves.
type RollupKey = str | int | float

#: One rollup entry: the mean of each rollup metric present in the breakdown table
#: (``mean_ret``/``hit_rate``/``sharpe``/``win_loss_ratio``/``firing_rate``) plus the SUMMED
#: ``n``. Unweighted means of per-pool means — descriptive orientation, never a pooled statistic.
type RollupEntry = dict[str, float | int]

#: One row of ``EntryListReport.entries``: the swept signal-axis levels (caller-chosen keys),
#: ``target``, and ``timestamps`` — every bar the entry fired on, ascending, empty when it never
#: fired. Produced by ``api.list_entries``; library-only (no CLI output carries it).
type EntryRow = dict[str, ParamValue | str | list[pd.Timestamp]]


# ---- pool-level statistical blocks --------------------------------------------------------
#
# The blocks ``analysis.stats`` computes over ONE observation pool. The runner mounts them under
# each cell's per-target panel and (in basket mode) under its pooled panel, so every one of them
# appears twice in a report and has exactly one shape.


class PoolQuantiles(TypedDict):
    """Order statistics of one pool — ``analysis.stats.pool_quantiles``.

    Mounted as ``ret_quantiles`` (and inside the excursion blocks and the baseline rows) by
    ``compiler.runner``; read by no check — evidence only. NaN at every point on an empty pool.
    """

    p10: float
    p25: float
    p50: float
    p75: float
    p90: float


class MaeQuantiles(PoolQuantiles):
    """The adverse-excursion block: ``pool_quantiles`` over the pool's ``mae`` column plus its own
    ``n`` and the single worst excursion. Produced by ``compiler.runner``; evidence only.

    ``n`` may sit BELOW the panel's ``n``: a hole in the excursion window censors ``mae`` on a row
    whose ``ret`` closed cleanly, and those rows are dropped rather than zero-filled.
    """

    n: int
    worst: float


class MfeQuantiles(PoolQuantiles):
    """The favorable mirror of :class:`MaeQuantiles` over the pool's ``mfe`` column — same
    subset-``n`` rule, ``best`` instead of ``worst``. Produced by ``compiler.runner``; evidence
    only."""

    n: int
    best: float


class ConcentrationBlock(TypedDict):
    """|return|-mass share of a pool's largest observations — ``analysis.stats.concentration``.

    Mounted per (cell × target) and, in basket mode, on the pooled panel; ``top_share_abs`` is the
    one number the per-cell ``concentration`` check reads (an empty pool yields NaN, which that
    check refuses rather than waves through).
    """

    top_share_abs: float
    n_top: int
    top_frac: float


class EpisodeBootstrapCI(TypedDict):
    """Episode-bootstrap percentile CI for a pool's mean — ``analysis.stats.episode_bootstrap_ci``.

    Mounted as ``boot`` on every per-target panel (and the pooled panel) by ``compiler.runner``;
    read by no check. The three interval fields are genuinely ``None`` — not NaN — when the pool
    carries no resampling distribution, and ``reason`` says which refusal applied
    (``no_observations`` / ``insufficient_episodes``).
    """

    method: str
    ci_level: float
    n_boot: int
    n_episodes: int
    ci_lo: float | None
    ci_hi: float | None
    boot_se: float | None
    reason: str | None


class SubperiodCounts(TypedDict):
    """One era's counts alone — ``analysis.stats.subperiod_means``, which is handed a pool's
    returns and entry bars and knows nothing about the calendar those bars sit on.

    THE SEAM: the statistical layer counts, and ``compiler.runner`` stamps the window it counted
    over, mounting these two fields under the timestamps as a :class:`SubperiodEntry`.
    """

    n: int
    mean_ret: float | None


class SubperiodEntry(SubperiodCounts):
    """One era of the run's fixed three-segment split — ``analysis.stats.subperiod_means`` for the
    counts, ``compiler.runner`` for the window timestamps it mounts them under.

    Era visibility, not a train/test split: no purging, and nothing reads it. ``start``/``end`` are
    None only for a degenerate (empty) segment; ``mean_ret`` is None for a segment with no
    observations — no evidence, never zero.
    """

    start: str | None
    end: str | None


class EpisodeStatsBlock(TypedDict):
    """One cell's cross-target episode clustering — ``analysis.stats.episode_stats``.

    Produced over the cell's CLOSED rows and mounted as ``episode_stats``. The checklist reads
    exactly two fields: ``n`` (``cell_evidence`` reconciles it against the per-target total) and
    ``max_cluster_share_abs`` (the one-episode ceiling in ``concentration``); the rest is evidence.
    An empty pool reports zero counts with NaN shares and a null start.
    """

    n: int
    n_clusters: int
    largest_cluster_n: int
    largest_cluster_share_abs: float
    largest_cluster_start: str | None
    max_cluster_share_abs: float


class EpisodeLedgerEntry(TypedDict):
    """One listed episode of :class:`EpisodeLedgerBlock` — earliest first, never ranked.

    ``start``/``end`` are the cluster's earliest entry and latest exit (a chain merge can end on
    an interior row's window); ``share_abs`` is its |return| mass over the pool total, NaN on a
    zero-mass pool.
    """

    start: str
    end: str
    n: int
    mean_ret: float
    share_abs: float


class EpisodeLedgerBlock(TypedDict):
    """One cell's time-ordered episode ledger — ``analysis.stats.episode_ledger``, mounted as
    ``episodes``. Evidence only; no check reads it.

    Truncation at ``cap`` is explicit and mass-conserving: ``n_omitted`` counts the clusters past
    the cap and ``omitted_share_abs`` carries their combined share (0.0 when nothing was omitted,
    NaN when omitted clusters sit over a zero-mass pool). ``n_total`` equals
    ``episode_stats.n_clusters`` on the same rows by construction.
    """

    entries: list[EpisodeLedgerEntry]
    n_total: int
    n_omitted: int
    omitted_share_abs: float
    cap: int


class BucketRecord(TypedDict):
    """One quantile bucket of a per-cell conditional panel — ``analysis.stats._bucket_records``,
    over the ascending-feature qcut. ``bucket`` is the rendered interval label."""

    bucket: str
    n: int
    mean_ret: float
    hit_rate: float


class FeatureBucketPanel(TypedDict):
    """One feature's conditional-bucket view within a cell —
    ``analysis.stats.cell_conditional_buckets``, mounted under ``conditional_buckets``.

    Every requested feature gets an entry: a refusal is an empty ``buckets`` list plus an explicit
    ``reason`` (``no_closed_observations`` / ``insufficient_observations`` /
    ``insufficient_distinct_values``), never an absent key. ``reason`` is None when the buckets
    are real. Evidence only.
    """

    buckets: list[BucketRecord]
    reason: str | None


class BucketMonotonicity(TypedDict):
    """Spearman rank correlation between bucket ORDER and bucket ``mean_ret`` —
    ``analysis.stats._bucket_monotonicity``, mounted under ``bucket_monotonicity``.

    Carried only for features that bucketed AND showed a rank signal (fewer than 3 populated
    buckets, or constant means, yields no entry at all). Evidence only.
    """

    rho: float
    sign: int


class CellBucketPanels(TypedDict):
    """The TWO panels ``analysis.stats.cell_conditional_buckets`` returns together — the runner
    mounts them onto the cell in one ``cell.update(...)``, which is why they travel as one dict
    keyed by the two names they mount under rather than as two returns.

    ``conditional_buckets`` carries EVERY requested feature (a refusal is an empty bucket list
    plus its reason, never an absent key); ``bucket_monotonicity`` carries only the features that
    bucketed AND showed a rank signal. Both are per-cell and evidence-only.
    """

    conditional_buckets: dict[str, FeatureBucketPanel]
    bucket_monotonicity: dict[str, BucketMonotonicity]


class FeatureAssociation(TypedDict):
    """One (cell × feature × target) Spearman between the entry-time snapshot and the realized
    closed return — ``analysis.stats.feature_outcome_association``, mounted under
    ``feature_association``.

    ``rho`` is genuinely None on a refusal, with ``reason`` naming it
    (``insufficient_observations`` / ``no_rank_variation``) — reporting ``rho = 0`` would claim a
    MEASURED absence of association. No p-value, deliberately. Evidence only.
    """

    rho: float | None
    n: int
    reason: str | None


class MemberShareBlock(TypedDict):
    """The basket's |return|-mass decomposition over its members — built by ``compiler.runner``
    and mounted on the pooled panel.

    ``by_target`` covers EVERY declared member (NaN shares on a zero-mass pool) and is
    attribution, never a ranking; the checklist reads only ``max_member_share_abs``, the
    one-name-basket detector in ``concentration``.
    """

    by_target: dict[str, float]
    max_member_share_abs: float


class PoolSummary(TypedDict):
    """The descriptive statistics of ONE observation pool — ``analysis.stats.summarize``.

    Read by ``summarize_table`` (which spreads it across a breakdown row) and by the runner's
    empty-pool fallback. Every field but ``n``/``n_valid``/``exit_reasons`` is NaN on an empty or
    degenerate pool. ``t_iid``/``p_iid`` are the overlap-inflated CLASSICAL pair, kept for
    reference and read by no check. ``max_bars_held`` is an int on a populated pool and NaN on an
    empty one, which is the only reason it is not simply ``int``.
    """

    n: int
    n_valid: int
    exit_reasons: dict[str, int]
    mean_ret: float
    median_ret: float
    std_ret: float
    hit_rate: float
    t_iid: float
    p_iid: float
    win_loss_ratio: float
    skewness: float
    kurtosis: float
    tail_ratio: float
    cvar_5: float
    mean_bars_held: float
    median_bars_held: float
    max_bars_held: int | float


# ---- the reliability / CSCV pass ----------------------------------------------------------
#
# The one place a raw ARRAY rides a pipeline dict: the runner hands the statistical layer a
# roster of (mask, forward-return) columns and gets per-cell reads back.


class ReliabilityCell(TypedDict):
    """One entry of the reliability roster — built by ``compiler.runner``, consumed by
    ``analysis.stats.reliability_summary``, ``pooled_reliability_summary`` and ``cscv_pbo``.

    ``key`` is the cell's ``ComboKey`` with the target appended (the pooled pass groups on
    ``key[:-1]``); ``mask_col`` is the (T,) firing mask and ``fwd_col`` the (T,) signed forward
    return anchored at the FIRING bar, so the two line up for the rotation null; ``h`` is the
    measurement horizon in bars.
    """

    key: CellKey
    mask_col: np.ndarray
    fwd_col: np.ndarray
    h: int


class ReliabilityRead(TypedDict):
    """One cell's overlap-aware inference — the per-cell value of
    ``reliability_summary``/``pooled_reliability_summary``.

    Merged into ``stats_table`` rows and into each cell's per-target (or pooled) panel by
    ``compiler.runner``. All three estimators are known anti-conservative and read by NO check:
    evidence a reader weighs, never a certificate.
    """

    rot_p: float
    t_hac: float
    hac_se: float
    n_eff: int


class ReliabilitySummary(TypedDict):
    """The reliability pass's return — ``analysis.stats.reliability_summary`` (keyed by
    ``CellKey``) and ``pooled_reliability_summary`` (keyed by the combo prefix).

    A ``ComboKey`` IS a ``CellKey`` with nothing appended, so the one key type serves both passes.
    A cell that never fired has NO entry: the runner tracks the DECLARED grid separately, so a
    missing key reads as "no firings", never as "dropped". ``n_shifts`` is the rotation null's
    shift count, which the runner stamps as ``summary["rotation"]`` — the smallest attainable
    ``rot_p`` is ``1/(1 + n_shifts)``.
    """

    per_cell: dict[CellKey, ReliabilityRead]
    n_shifts: int


class PboBlock(TypedDict):
    """The grid-level CSCV block — ``analysis.stats.cscv_pbo``, mounted as ``summary["pbo"]``.

    A property of the SEARCH SPACE the caller is about to select from, attached to no hypothesis
    and read by no cell's grade. ``pbo`` is None exactly when ``reason`` is set (``single_combo``
    — a one-combo grid has no selection to overfit; ``insufficient_data`` — too little
    block-local data even at S=4), and the diagnostics are NaN there.
    """

    pbo: float | None
    reason: str | None
    n_splits: int
    n_combos: int
    blocks: int
    lambda_mean: float
    oos_degradation_slope: float
    prob_oos_loss: float


# ---- the per-cell panel -------------------------------------------------------------------
#
# ``summary["cells"]`` — one entry per DECLARED (param combo × horizon), non-firing ones
# included. Assembled by ``compiler.runner``; graded entry by entry by ``gate``'s five per-cell
# checks; emitted verbatim by ``serialize``/``cli``.


class CellTargetPanel(TypedDict):
    """ONE (cell × target) evidence panel — ``cells[i].by_target[target]``, built by
    ``compiler.runner``.

    A target with no closed rows still gets a full entry (``n = 0``, NaN statistics, null evidence
    blocks carrying their ``reason``): an OMITTED target would read as "not applicable here" when
    what happened is "this cell produced no evidence for a target it claims to hold across".
    ``gate._check_cell_evidence`` reconciles ``n``/``n_eff`` against the coverage ledger, and
    ``support``/``concentration`` read ``n``/``n_eff``/``mean_ret`` and ``concentration`` under
    the CONJUNCTION rubric; everything else here is evidence.
    """

    n: int
    n_eff: int
    mean_ret: float
    hit_rate: float
    t_hac: float
    hac_se: float
    rot_p: float
    concentration: ConcentrationBlock
    boot: EpisodeBootstrapCI
    subperiods: list[SubperiodEntry]
    ret_quantiles: PoolQuantiles
    worst_ret: float
    mae_quantiles: MaeQuantiles
    mfe_quantiles: MfeQuantiles


class CellPooledPanel(CellTargetPanel):
    """A BASKET cell's one cross-target evidence pool — ``cells[i].pooled``, built by
    ``compiler.runner`` over the concatenated (bar × member) closed rows.

    Mirrors :class:`CellTargetPanel` field for field so there is one mental model, and adds the
    member-mass decomposition. This is the panel the basket rubric GRADES: ``support`` reads
    ``n``/``n_eff``/``mean_ret`` here instead of per member, ``concentration`` reads
    ``concentration.top_share_abs`` and ``member_share.max_member_share_abs``, and
    ``cell_evidence`` reconciles ``n``/``n_eff`` against the member panels and the bar clock.
    Absent — not null — on conjunction cells, where the gate REFUSES it as a restamped basket.
    """

    member_share: MemberShareBlock


class CellOutcomeCoverage(TypedDict):
    """One target's censoring ledger over a cell's FULL rows — ``cells[i].outcome_coverage[t]``,
    built by ``compiler.runner``.

    All four exit reasons are reported, zeros included, so ``sum(exit_reasons) == n_attempted``
    and ``n_closed == exit_reasons["horizon"]`` are re-checkable from the report alone — which is
    exactly what ``gate._check_cell_evidence`` re-checks. ``gate._check_cell_outcome_coverage``
    then refuses any ``no_outcome``/``no_benchmark`` firing while allowing ``open`` at any count.
    """

    n_attempted: int
    n_closed: int
    exit_reasons: dict[ExitReason, int]


class CellSignalCoverage(TypedDict):
    """One target's decision ledger — ``cells[i].signal_coverage[t]``, built by
    ``compiler.runner`` from the three-valued ``init & ~defined`` mask.

    ``n_bars`` is the joined index length (pure geometry), so ``n_undefined <= n_bars`` is
    arithmetic a reader re-checks; ``gate._check_cell_signal_coverage`` refuses any undecidable
    decision bar, and ``cell_evidence`` verifies ``n_bars`` against the summary's.
    """

    n_bars: int
    n_undefined: int


class SummaryCell(TypedDict):
    """ONE declared (param combo × horizon) cell — an entry of ``summary["cells"]``.

    Built by ``compiler.runner`` (in declaration order, non-firing cells included, so
    ``len(cells) == n_hypotheses_attempted`` holds by construction), graded by ``gate``'s five
    per-cell checks, and emitted verbatim. ``cell_id`` is a rendered LABEL — identity is
    ``params`` plus the position in the panel — and ``params`` always names the horizon, even
    when it was never swept.

    ``pooled`` is the one mode-gated block: present on basket cells, ABSENT (not null) on
    conjunction cells, where the gate refuses its presence as the signature of a restamped basket.
    """

    cell_id: str
    params: dict[str, ParamValue]
    by_target: dict[str, CellTargetPanel]
    pooled: NotRequired[CellPooledPanel]
    episode_stats: EpisodeStatsBlock
    episodes: EpisodeLedgerBlock
    outcome_coverage: dict[str, CellOutcomeCoverage]
    signal_coverage: dict[str, CellSignalCoverage]
    conditional_buckets: dict[str, FeatureBucketPanel]
    bucket_monotonicity: dict[str, BucketMonotonicity]
    feature_association: dict[str, dict[str, FeatureAssociation]]


class DeclaredCell(TypedDict):
    """The runner's INTERNAL record of one declared cell, appended in the measurement loop before
    anything about firing is known — ``compiler.runner``'s ``declared_cells``, read only by the
    per-cell panel loop in the same module.

    ``combo_key`` carries the swept axes in ``param_levels`` order (the horizon included when it
    was swept) and indexes the trades partition; ``combo_tuple`` carries the ENTRY-TREE axes only
    and indexes the undefined-decision masks, which are keyed by combo because the horizon has no
    say in decidability.
    """

    params: dict[str, ParamValue]
    combo_key: ComboKey
    combo_tuple: ComboKey
    h: int


# ---- run-level stamps ---------------------------------------------------------------------
#
# Combo-independent properties of the run: geometry, provenance, self-description, and the
# panels the three run-level checks read.


class BarSpacing(TypedDict):
    """The joined index's clock geometry — ``compiler.runner._bar_spacing``, stamped as
    ``summary["bar_spacing"]`` and into every ``describe`` profile.

    Ints where the spacing is a whole second, floats otherwise, None below two bars. Pure
    self-description: the engine never interprets cadence.
    """

    min_seconds: int | float | None
    median_seconds: int | float | None
    max_seconds: int | float | None


class OutcomeStamp(TypedDict):
    """What was measured and in which algebra — ``summary["outcome"]``, stamped by
    ``compiler.runner``.

    ALWAYS the explicit dict (the default run stamps ``{target, pct, fraction}``, never a null):
    ``gate._check_evidence_complete`` and ``gate._incommensurable_pool`` both refuse a missing,
    null or partial stamp, because reading an absent stamp as "commensurable" would let stripping
    it bypass the guard outright.
    """

    series: str
    kind: OutcomeKind
    units: OutcomeUnits


class RotationStamp(TypedDict):
    """The rotation null's resolution — ``summary["rotation"]``, stamped by ``compiler.runner``.

    ``p_resolution`` is ``1/(1 + n_shifts)`` (NaN when no shift ran): a ``rot_p`` sitting at that
    floor means "no shift beat the observation", not "p ≈ 0". Evidence only.
    """

    n_shifts: int
    p_resolution: float


class SourceAvailability(TypedDict):
    """ONE raw decision leaf's availability within one target —
    ``summary["sources"][target]["by_source"][label]``, built by
    ``compiler.runner._source_coverage`` and read by ``gate._check_source_coverage``.

    ``n_missing`` counts holes STRICTLY AFTER the leaf's first available bar; a leaf that merely
    starts late is warmup, and ``first_available`` (None when it was never available at all)
    reports that as evidence, never as a refusal.
    """

    n_missing: int
    first_available: str | None


class SourceCoverage(TypedDict):
    """ONE target's per-source availability ledger — ``summary["sources"][target]``, built
    UNCONDITIONALLY by ``compiler.runner`` (the leaf set is combo-independent) and read by
    ``gate._check_source_coverage``, which refuses any missing bar and re-checks the arithmetic:
    ``n_bars`` equals the summary's, every per-source count sits in ``0..n_bars``, and the union
    ``n_missing`` cannot outnumber the sum of its parts."""

    n_bars: int
    n_missing: int
    by_source: dict[str, SourceAvailability]


class BaselineStats(TypedDict):
    """The statistical fields of ONE unconditional baseline pool —
    ``analysis.stats.baseline_summary``, computed from the eligible forward returns alone.

    An empty pool is all-NaN, never zeros — a zero base rate is a measured outcome, and a pool
    with no observations measured nothing. There is deliberately no ``median_ret`` key:
    ``ret_quantiles.p50`` is it.
    """

    n_eligible: int
    mean_ret: float
    std_ret: float
    hit_rate: float
    ret_quantiles: PoolQuantiles
    worst_ret: float
    best_ret: float


class BaselinePool(BaselineStats):
    """One baseline ROW — the statistics :class:`BaselineStats` computes plus the anchor geometry
    only ``compiler.runner`` can supply, mounted per (horizon × target) and, in basket mode, once
    pooled per horizon.

    The arithmetic pin ``n_eligible + Σexclusions == n_anchor_bars`` is the runner's to satisfy
    and a reader's to re-check: it is the honesty channel that keeps a data hole from silently
    shrinking the base rate's denominator. Evidence only — no check reads it, and there is
    deliberately NO uplift field anywhere: the conditional-vs-base-rate comparison is the
    caller's.
    """

    n_anchor_bars: int
    exclusions: dict[ExclusionReason, int]


class BaselineEntry(TypedDict):
    """One horizon's unconditional baseline — an entry of ``summary["baseline"]``, in horizon
    declaration order, built by ``compiler.runner``.

    ``pooled`` rides ONLY in basket mode (the honest base rate for a pooled conditional claim,
    whose counts are the per-target sums), exactly as ``pooled`` rides only basket cells.
    """

    horizon: int
    by_target: dict[str, BaselinePool]
    pooled: NotRequired[BaselinePool]


class GridBreakdown(TypedDict):
    """The descriptive GRID breakdown — ``analysis.stats.summarize_table``'s complete return, and
    the first six keys of every run summary.

    Deliberately carries NO pooled headline: the grid has no single result, only cells.
    ``stats_table`` covers only pools with at least one CLOSED observation (a groupby cannot
    invent a row for a combo with none) and ``n_stats_rows`` is exactly its row count — a
    consumer that must account for every DECLARED cell drives off ``cells``, not off this table.
    ``params`` names the swept axes (with ``horizon`` only when it was swept); ``targets`` names
    the regime, and ``gate`` reads it as the panel-coverage reference for every per-target check.

    Mind the two ``by_target``s: THIS one is the descriptive ROLLUP over the breakdown table
    (unweighted means of per-pool means, keyed by target name), while ``cells[i].by_target`` is a
    cell's per-target evidence PANEL (:class:`CellTargetPanel`). Nothing reads this one but a
    human orienting themselves.
    """

    stats_table: list[StatsTableRow]
    by_target: dict[RollupKey, RollupEntry]
    by_param: dict[str, dict[RollupKey, RollupEntry]]
    params: list[str]
    targets: list[str]
    n_stats_rows: int


class RunSummary(GridBreakdown):
    """THE summary — the engine's whole report, produced by ``compiler.runner.run_backtest``,
    carried on ``EventStudyResult.summary``, graded by ``gate.evaluate_gate`` and emitted verbatim
    by ``serialize.serialize_result``.

    The grid breakdown it inherits, plus the run-level stamps: which mechanics produced it
    (``statistics_version``) and over what sample (``gate_evidence_basis``), the geometry and
    extent of the evaluated index, the DECLARED search burden (``n_hypotheses_attempted`` — the
    ONLY multiplicity input in the report, and nothing here is corrected for it), the
    self-description every consumer needs to know which scale it is reading
    (``direction``/``benchmark``/``benchmark_source``/``outcome``/``target_shape``/``target_mode``),
    the rotation resolution, the grid-level CSCV block, the per-source availability panel, the
    unconditional baseline, and finally ``cells`` — one entry per DECLARED combo × horizon, in
    declaration order, non-firing combos included.

    ``index_start``/``index_end`` are None only on an empty index. ``benchmark`` is None on an
    unbenchmarked run and ``benchmark_source`` is None unless a benchmark FILE was loaded.
    """

    statistics_version: int
    gate_evidence_basis: str
    n_bars: int
    index_start: str | None
    index_end: str | None
    bar_spacing: BarSpacing
    n_hypotheses_attempted: int
    direction: Direction
    benchmark: BenchmarkMode | None
    benchmark_source: str | None
    outcome: OutcomeStamp
    target_shape: str
    target_mode: TargetMode
    rotation: RotationStamp
    pbo: PboBlock
    sources: dict[str, SourceCoverage]
    baseline: list[BaselineEntry]
    cells: list[SummaryCell]


# ---- the strict-CSV data report -----------------------------------------------------------
#
# ``dataio``'s front-door verdict on everything a command read: per-file results, the cross-file
# join, and any top-level error. Carried on ``MarketData.report`` and on both result types,
# emitted by ``run`` / ``check-data`` / ``describe`` alike — and by the exit-2 error envelope,
# which is the whole point of accumulating violations instead of failing fast.


class IssueExample(TypedDict):
    """One offending row named by a ``dataio`` error — the CSV line (row index + 2, for the
    header) and, where the check has one, the raw cell value as read."""

    csv_line: int
    value: NotRequired[str]


class DataIssue(TypedDict):
    """One error or warning record — produced by ``dataio.FileReport.error``/``warn``,
    ``dataio.sufficiency_check``, ``compiler.data``'s join checks and ``api``'s pre-flight
    guards; read by the CLI (which emits them) and by ``describe``'s refusal stubs (which name
    the codes).

    ``code`` is the machine-readable class, ``message`` the human sentence. The three optional
    fields are the per-check extras: the offending rows, the column a column-scoped check names,
    and the measured value a threshold-flavored warning reports.
    """

    code: str
    message: str
    examples: NotRequired[list[IssueExample]]
    column: NotRequired[str]
    value: NotRequired[float]


class DataIssueExtras(TypedDict):
    """The keyword tail of :class:`DataIssue` on its own — the ``**extra`` that
    ``dataio.FileReport.error``/``warn`` collect beside the ``code``/``message`` every record
    carries. Same three keys with the same meanings; declared separately so those two methods can
    state which extras a check may attach (``Unpack``) instead of accepting anything at all."""

    examples: NotRequired[list[IssueExample]]
    column: NotRequired[str]
    value: NotRequired[float]


class FileReportEntry(TypedDict):
    """One file's strict-read result — ``dataio.FileReport.to_dict``.

    ``ok`` is exactly "no errors"; ``sha256`` is the raw-byte digest computed BEFORE validation
    (so even a refused file carries its identity) and is None only when the file could not be
    read at all. The descriptive fields stay None for a file that never reached them.
    """

    path: str
    role: str
    ok: bool
    shape: str | None
    n_rows: int | None
    start: str | None
    end: str | None
    sha256: str | None
    errors: list[DataIssue]
    warnings: list[DataIssue]


class JoinInfo(TypedDict):
    """The cross-file join — built by ``compiler.data.load_market_data``, read by the CLI report
    and appended to by ``api._ensure_sufficient`` (a barely-sufficient index lands here as a
    warning rather than refusing the run).

    ``n_common`` is the joined index length every geometry stamp derives from; the warnings are
    coverage facts (a sparse external feed, an incompletely covering benchmark), never refusals.
    """

    n_common: int
    start: str
    end: str
    warnings: list[DataIssue]


class DataReport(TypedDict):
    """Everything a command read and checked — ``dataio.build_data_report``.

    Carried on ``MarketData.report`` and on both result types, and emitted by every command that
    touches a file (``run``, ``check-data``, ``describe``) INCLUDING on refusal, where it is the
    exit-2 envelope's payload. ``ok`` is the conjunction of "no top-level error" and every file's
    own ``ok``; ``join`` is None for a read that joined nothing (``check-data``, ``describe``).
    """

    ok: bool
    files: list[FileReportEntry]
    join: JoinInfo | None
    errors: list[DataIssue]


# ---- the describe profiles ----------------------------------------------------------------
#
# ``describe.py``'s pure data profiling — the one non-measuring path. Every block states what the
# bytes contain and refuses explicitly rather than repairing: ``reason`` names a structural
# refusal (``insufficient_bars`` / ``endpoint_missing``) and ``ratio_reason`` the domain refusal
# of the RATIO algebras (``non_positive_endpoint``), both present-never-omitted.


class ChangeBlock(TypedDict):
    """One window's change (``describe._change_block``) or one window's per-bar dispersion
    (``describe._dispersion_block``) — the two share this shape exactly, one value per algebra.

    All three algebras are emitted, because choosing ONE would be the engine deciding what a
    series IS. ``diff`` carries whenever both endpoints are finite; ``pct``/``log`` are None with
    ``ratio_reason`` set off a positive scale. A refused block is all-None with ``reason`` set.
    """

    diff: float | None
    pct: float | None
    log: float | None
    reason: str | None
    ratio_reason: str | None


class ExtremumPoint(TypedDict):
    """A trailing or full-sample extremum: its value and the bar it was attained at (ties resolve
    to the MOST RECENT bar — the ``bars_since_extremum`` convention, one tie rule engine-wide)."""

    value: float
    timestamp: str


class RangeDistance(TypedDict):
    """The last level's distance from a window extremum — ``diff`` always, ``pct`` only on a
    positive scale (None with the block's ``ratio_reason`` set otherwise)."""

    diff: float
    pct: float | None


class RangePositionBlock(TypedDict):
    """One window's range position — ``describe._range_position_block``.

    Requires the FULL window: a shorter file refuses as ``insufficient_bars`` and a hole inside
    the window as ``endpoint_missing`` (the extremum, or the rank, could be hiding in it), and a
    refusal nulls every value. ``percentile_rank`` is position within the window's OWN range, not
    valuation.
    """

    high: ExtremumPoint | None
    low: ExtremumPoint | None
    from_high: RangeDistance | None
    from_low: RangeDistance | None
    percentile_rank: float | None
    reason: str | None
    ratio_reason: str | None


class FullSampleBlock(TypedDict):
    """The whole file's extremes and the drawdown/runup off them — ``describe._full_sample_block``.

    A property of the file's EXTENT: extend or trim the file and these move. A NaN last level
    refuses the distance reads (``endpoint_missing``) while the extremes themselves — observed
    facts — stay, with the missingness block beside them stating the holes.
    """

    high: ExtremumPoint | None
    low: ExtremumPoint | None
    drawdown_diff: float | None
    drawdown_pct: float | None
    runup_diff: float | None
    runup_pct: float | None
    reason: str | None
    ratio_reason: str | None


class MissingnessBlock(TypedDict):
    """Pure hole counts for one series — ``describe._missingness_block``. Interior missingness is
    counted between the first and last valid bar; threshold-flavored warnings stay in the
    loader's ``data_report``."""

    n_missing: int
    n_interior_missing: int
    first_valid: str | None
    last_valid: str | None


class SeriesProfile(TypedDict):
    """One value column's complete profile — ``describe._series_blocks``. The window-keyed maps
    are keyed by the window's BAR COUNT rendered as a string, in the requested window order."""

    changes: dict[str, ChangeBlock]
    dispersion: dict[str, ChangeBlock]
    range_position: dict[str, RangePositionBlock]
    full_sample: FullSampleBlock
    missingness: MissingnessBlock


class VolumeWindow(TypedDict):
    """One window's volume read — ``describe._volume_block``. ``last_to_mean`` carries NO
    "unusual" flag: what counts as elevated is the caller's judgment, not a property of the file.
    A non-positive trailing mean refuses the ratio rather than dividing through zero."""

    mean: float | None
    last_to_mean: float | None
    reason: str | None
    ratio_reason: str | None


class VolumeBlock(TypedDict):
    """The volume panel of an OHLCV file that carries a volume column — ``describe._volume_block``;
    None on every other file."""

    last: float | None
    windows: dict[str, VolumeWindow]


class LastBarBlock(TypedDict):
    """The file's final row verbatim — ``describe._last_bar_block``. Every column, NaN as null,
    never back-filled."""

    timestamp: str
    values: dict[str, float | None]


class FileProfile(TypedDict):
    """One ADMITTED file's profile — ``describe.profile_file``, emitted in argument order under
    the describe document's ``profiles``.

    An OHLCV file profiles ``close`` (the full bar rides ``last_bar``); a series-shaped file
    profiles every value column in file order. ``volume`` is None unless the file is OHLCV with a
    volume column. Bounded output by construction: no per-bar array ever rides it.
    """

    path: str
    sha256: str | None
    ok: bool
    shape: str | None
    n_bars: int
    index_start: str
    index_end: str
    bar_spacing: BarSpacing
    last_bar: LastBarBlock
    series: dict[str, SeriesProfile]
    volume: VolumeBlock | None


class RefusalStub(TypedDict):
    """A REFUSED file's profile — ``describe._refusal_stub``: identity plus the reason codes,
    nothing invented. The full diagnosis lives in the ``data_report`` entry those codes point
    into. ``ok`` is always False, which is what distinguishes it from a :class:`FileProfile`."""

    path: str
    sha256: str | None
    ok: bool
    reason: str


class DescribeResult(TypedDict):
    """``describe.describe_files``'s return — the strict-read verdict plus one profile per file in
    ARGUMENT order (a refused file gets its stub, so the document is complete either way). The
    CLI splits it into the describe document's two sections and reads ``data_report["ok"]`` for
    the exit code."""

    data_report: DataReport
    profiles: list[FileProfile | RefusalStub]


# ---- the gate section ---------------------------------------------------------------------
#
# ``gate``'s dataclasses are the in-memory result; these are the dicts their ``to_dict`` methods
# render for the report's ``gate`` layer.


class GateCheckDict(TypedDict):
    """One check's result — ``gate.GateCheck.to_dict``, reported for every run-level check and for
    every cell's five, always evaluated and never short-circuited.

    ``observed`` is what the check actually read (a scalar, or a per-target payload) and
    ``threshold`` what it required (a number for the sealed ceilings, a sentence for the
    structural contracts); both are JSON payloads this layer carries without interpreting.
    ``detail`` states the pass, or every failure joined — a refusal always says why.

    The two payloads are typed from opposite sides of the trust boundary the gate sits on:
    ``threshold`` is written BY the checklist (a knob's value or its own sentence), so it is JSON
    by construction, while ``observed`` ECHOES what the check found in an untrusted summary — a
    drifted report may carry anything under the key a check looked at, and reporting it as found
    is how a refusal says what it saw. ``json_safe`` renders it at emit.
    """

    name: str
    passed: bool
    observed: object
    threshold: JsonValue
    detail: str


class GateCellDict(TypedDict):
    """One declared cell's complete checklist result — ``gate.CellReport.to_dict``, index-aligned
    with ``summary["cells"]``.

    ``passed`` is the conjunction of this cell's own checks AND every run-level check, so a caller
    reading one cell never has to AND the sections itself. ``cell_id``/``params`` mirror the
    summary cell being graded — echoed as read, since a drifted entry may carry neither (it still
    gets a positional label so the alignment holds).
    """

    cell_id: str
    params: dict[str, JsonValue]
    passed: bool
    checks: list[GateCheckDict]


class GateSection(TypedDict):
    """The report's whole ``gate`` layer — ``gate.GateReport.to_dict``.

    There is no verdict key and no short-circuit, and the summary this grades is never filtered:
    ``n_passed`` counts cells whose ``passed`` is True, a number the caller reads alongside
    ``n_cells`` and ``n_hypotheses_attempted`` when it prices its own selection.
    """

    policy_version: int
    n_cells: int
    n_passed: int
    run_checks: list[GateCheckDict]
    cells: list[GateCellDict]


# ---- the emitted documents ----------------------------------------------------------------


class SerializedResult(TypedDict):
    """``serialize.serialize_result``'s return — the thesis name and the summary, JSON-safe.

    The summary rides VERBATIM (every declared cell, whatever the checklist says); the
    per-observation trades frame is never embedded — its only channel is ``write_trades_csv``.
    After ``json_safe`` the shape is unchanged except that non-finite floats are null and the
    ``by_param`` rollups' numeric keys are strings.
    """

    name: str
    summary: RunSummary


class ThresholdsSnapshot(TypedDict):
    """The four checklist knobs actually used — ``settings.GateThresholds.snapshot``.

    Stamped into every run report's identity layer and reconstructible:
    ``GateThresholds(**snapshot())`` round-trips, which is how ``gate.evaluate_gate`` re-seals the
    exam it was handed at the trust boundary.
    """

    thesis_min_trades: int
    thesis_min_n_eff: int
    thesis_max_concentration: float
    thesis_max_hypotheses: int


class DataDigest(TypedDict):
    """One bound data key's provenance — an entry of the report's ``identity.data_digests``,
    built by the CLI.

    Keyed by the LOGICAL key the thesis declares (never the path), so two runs are comparable.
    ``column`` is ALWAYS present and null when the key bound none ("the file named its own" is a
    fact worth stating); ``sha256`` is looked up by PATH, so two keys answered by one file
    correctly share one digest.
    """

    path: str
    column: str | None
    sha256: str | None


class ReportIdentity(TypedDict):
    """WHICH exam ran on WHICH inputs — the run report's ``identity`` layer, built by the CLI.

    A changed rule set (``dsl_hash``), data byte (``data_digests``), exam knob (``thresholds``) or
    knob PROVENANCE is a visibly distinct exam. ``thresholds_canonical`` lives here because it is
    an identity fact, not a checklist result; ``thresholds_provenance`` maps each knob to where
    its value came from, which the snapshot alone cannot say.
    """

    name: str
    dsl_hash: str
    data_digests: dict[str, DataDigest]
    thresholds: ThresholdsSnapshot
    thresholds_canonical: bool
    thresholds_provenance: dict[str, str]


class OutputEntry(TypedDict):
    """One file a run wrote — an entry of the report's ``outputs``, keyed in NOMINATION order.

    ``rows_written`` rides every CSV output; the report's own entry carries the path alone, since
    the report is what enumerates the others and is written last.
    """

    path: str
    rows_written: NotRequired[int]


class ThresholdDoc(TypedDict):
    """One knob's documentation row — ``seikan schema``'s ``thresholds`` list, rendered by the CLI
    straight off ``GateThresholds.model_fields`` so a dropped field disappears from the flags, the
    env-var listing and the docs at once."""

    field: str
    default: JsonValue
    env_var: str
    cli_flag: str


class ValidationRecord(TypedDict):
    """One pydantic validation failure, JSON-safe — ``cli._validation_records``. The context is
    deliberately dropped (it can carry a non-serializable original exception); the human text
    already lives in ``msg``."""

    loc: list[str | int]
    msg: str
    type: str


class ErrorEnvelope(TypedDict):
    """The machine-readable error a failing command emits on stdout — the ``error`` section of
    :class:`EmittedDocument`.

    ``type`` names the class the exit code reflects (``usage`` / ``dsl_invalid`` /
    ``thresholds_invalid`` / ``data_invalid`` / ``internal``); ``errors`` rides only the two
    pydantic-backed classes, which have structured records to carry.
    """

    type: str
    message: str
    errors: NotRequired[list[ValidationRecord]]


class EmittedDocument(TypedDict):
    """Every JSON document the CLI emits — one shape, a fixed header, and the sections the
    invoked command adds to it.

    The header is universal: ``seikan_version``/``report_schema_version``/``command`` open the run
    report, the ``check-data`` and ``describe`` documents, the ``schema`` dump and every error
    envelope alike (``command`` is None for a usage error raised before a subcommand resolved).
    Every other key is ``NotRequired`` because it belongs to ONE command's document, not because
    a command may omit its own sections:

    - ``run`` (``--report-out``) writes ``identity`` → ``data_report`` → ``outputs`` →
      ``summary`` → ``gate`` → ``metric_roles``, in that fixed order;
    - ``check-data`` writes ``data_report``;
    - ``describe`` writes ``data_report`` → ``profiles`` → ``describe_roles``;
    - ``schema`` writes the static contract payloads (``dsl_json_schema`` through
      ``describe_roles``);
    - any failure writes ``error`` (and ``data_report`` too, on the exit-2 class).
    """

    seikan_version: str
    report_schema_version: int
    command: str | None
    identity: NotRequired[ReportIdentity]
    data_report: NotRequired[DataReport]
    outputs: NotRequired[dict[str, OutputEntry]]
    summary: NotRequired[RunSummary]
    gate: NotRequired[GateSection]
    profiles: NotRequired[list[FileProfile | RefusalStub]]
    dsl_json_schema: NotRequired[dict[str, JsonValue]]
    thresholds: NotRequired[list[ThresholdDoc]]
    gate_contract: NotRequired[dict[str, JsonValue]]
    report_fields: NotRequired[dict[str, JsonValue]]
    describe_report: NotRequired[dict[str, JsonValue]]
    csv_format: NotRequired[dict[str, JsonValue]]
    trades_csv: NotRequired[dict[str, JsonValue]]
    root_series_csv: NotRequired[dict[str, JsonValue]]
    entry_flags_csv: NotRequired[dict[str, JsonValue]]
    exit_codes: NotRequired[dict[str, JsonValue]]
    metric_roles: NotRequired[dict[str, JsonValue]]
    describe_roles: NotRequired[dict[str, JsonValue]]
    error: NotRequired[ErrorEnvelope]
