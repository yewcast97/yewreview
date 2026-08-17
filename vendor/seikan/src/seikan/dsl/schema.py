from __future__ import annotations

from collections.abc import Iterable, Iterator, Sequence
from typing import TYPE_CHECKING, Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, model_validator
from pydantic import Field as PField

from seikan.constants import (
    DEFAULT_FEATURE_NAMES,
    MAX_DECLARED_GRID,
    MAX_SERIES_NESTING,
    RESERVED_FEATURE_NAMES,
    RESERVED_SWEEP_LEVELS,
    TRADE_COLUMNS,
)

if TYPE_CHECKING:
    import pandas as pd

# ---- Swept numeric params --------------------------------------------------
#
# Transform window & period params accept either a scalar or a list of values. A list
# fans the thesis out over a parameter grid (the engine takes the Cartesian product of every
# swept param and runs each combination); the columns of the result are indexed by (params…,
# target). Each list element carries the same positivity constraint as the scalar form.
# ``max_length`` is a per-axis sanity bound only — the binding constraint is the CARTESIAN
# PRODUCT, checked once on the assembled thesis by ``Thesis._check_declared_grid``.


def _distinct_sweep[T](values: list[T]) -> list[T]:
    """Reject a repeated value inside one sweep axis.

    A sweep axis enumerates DISTINCT hypotheses. Repeating a value declares the same hypothesis
    twice, which adds no information but is not merely redundant — it corrupts the per-cell
    counting. The measurement loop runs the duplicate combo once per occurrence and appends its
    observations to the trades frame each time, while the per-cell panel groups that frame by
    parameter VALUE: all d copies of the axis point therefore read one d-fold-duplicated group
    and every count derived from it (``by_target.n``, the outcome ledger's
    ``n_attempted``/``n_closed``, ``episode_stats.n``) reports d times the real evidence. The
    overlap-honest ``n_eff`` is computed from the firing bars and stays truthful, so the
    inflation cannot even be caught by the gate's ``n_eff <= n`` reconciliation — it makes that
    bound strictly easier to satisfy. The result is fail-OPEN: ``[21, 21]`` doubles a cell's
    apparent support and can flip the ``support`` floor from refused to passed.

    Refusing here — at validation, before a byte of data is read — is the same discipline
    ``vectorize.collect_sweeps`` applies to duplicate axis NAMES, and for the same stated
    reason: a collision that miscounts silently must never reach the engine.
    """
    seen: list[T] = []
    dupes: list[T] = []
    for v in values:
        if v in seen:
            if v not in dupes:
                dupes.append(v)
        else:
            seen.append(v)
    if dupes:
        raise ValueError(
            f"sweep axis repeats the value(s) {dupes} — a swept list enumerates DISTINCT "
            "hypotheses, and a repeated value multiplies that cell's reported observation count "
            "without adding evidence; list each value once"
        )
    return values


#: A swept list: bounded length, and every value distinct.
_Sweep = (PField(min_length=1, max_length=MAX_DECLARED_GRID), AfterValidator(_distinct_sweep))

PosInt = Annotated[int, PField(gt=0)]
PosIntParam = PosInt | Annotated[list[PosInt], *_Sweep]
Ge2Int = Annotated[int, PField(ge=2)]
Ge2IntParam = Ge2Int | Annotated[list[Ge2Int], *_Sweep]
Ge3Int = Annotated[int, PField(ge=3)]
Ge3IntParam = Ge3Int | Annotated[list[Ge3Int], *_Sweep]
NonNegInt = Annotated[int, PField(ge=0)]
NonNegIntParam = NonNegInt | Annotated[list[NonNegInt], *_Sweep]
# A threshold constant accepts a scalar or a list; a list sweeps the threshold as its own named axis
# (see ``Constant.name``), taking part in the same Cartesian product as transform-window sweeps.
# NON-FINITE is rejected: JSON has no NaN/Infinity, but Python's ``json`` accepts the non-standard
# literals and pydantic floats admit them by default. A NaN threshold silently makes every
# comparison undecidable, and ``canonical_dsl_hash`` would hash a token no strict JSON parser can
# read back — so the identity of such a thesis is unrecoverable.
FiniteFloat = Annotated[float, PField(allow_inf_nan=False)]
FloatParam = FiniteFloat | Annotated[list[FiniteFloat], *_Sweep]

#: The plain shape the constrained param aliases above erase to: a numeric node param as the
#: traversal/rendering helpers below receive it — the scalar form, or the list form that sweeps it
#: (a ``window``/``periods``/``cooldown`` is int-valued, a ``constant.value`` float-valued). It
#: carries no constraint metadata and is never a field annotation; the models declare the
#: constrained aliases.
_NumericParam = int | float | list[int] | list[float]


# ---- Strict base -----------------------------------------------------------
#
# Unknown keys are rejected at validation (LLM typos, and keys this DSL does not have like
# ``exit`` / ``fill_timing`` / ``init_cash``). Canonical dumps fill defaults — there is no
# default-suppressing serializer; adding a default-valued field to an existing model changes
# every stored dsl hash and requires re-validation (prefer new node types, which are hash-safe).


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---- Data ------------------------------------------------------------------


class Field(_Strict):
    type: Literal["field"] = "field"
    column: Literal["open", "high", "low", "close", "volume"] = "close"


class Constant(_Strict):
    type: Literal["constant"] = "constant"
    value: FloatParam
    # A list ``value`` sweeps the threshold as its own result axis (like a transform-window sweep);
    # ``name`` labels that axis in the result columns / summary tables and is required
    # (non-empty) in that case. Ignored when ``value`` is a scalar.
    name: str | None = None

    @model_validator(mode="after")
    def _require_name_when_swept(self) -> Constant:
        if isinstance(self.value, list) and not (isinstance(self.name, str) and self.name.strip()):
            raise ValueError(
                "a swept constant (list 'value') requires a non-empty 'name' to label its "
                "sweep axis"
            )
        return self


class External(_Strict):
    type: Literal["external"] = "external"
    name: str


class Calendar(_Strict):
    # Calendar attribute of each bar's timestamp, broadcast to every target — the seasonality
    # primitive (turn-of-month, day-of-week, sell-in-May). CALENDAR-DAY arithmetic only: ``month``
    # (1-12), ``day_of_week`` (0=Monday .. 6=Sunday), ``day_of_month`` (1-31), ``days_to_month_end``
    # (calendar days remaining in the month, 0 = the month's last calendar day). All are knowable at
    # the bar itself; a "trading bars to month end" field would need the future session calendar and
    # is deliberately absent (look-ahead).
    type: Literal["calendar"] = "calendar"
    field: Literal["month", "day_of_week", "day_of_month", "days_to_month_end"]


class DaysSince(_Strict):
    # Calendar days since the named external feed's most recent NATIVE observation at or before the
    # bar (post-``lag`` availability stamps, NOT the forward-filled values) — the event-distance
    # primitive (PEAD windows: ``days_since(earnings) <= 3``; staleness guards). NaN before the
    # feed's first stamp (never fires — the standard NaN-gating contract). The feed must be declared
    # in ``data.external`` like an ``External`` reference. For SCHEDULED future events (FOMC,
    # earnings dates), feed a user-computed days-until-next-event series instead — the schedule is
    # public in advance, so the value is availability-honest; a ``days_until`` primitive over feed
    # stamps would read the future and is deliberately absent.
    type: Literal["days_since"] = "days_since"
    name: str


# ---- Transforms (the ONE operator family) ----------------------------------
#
# Transforms normalize / reshape a series — typically a ``Field`` or ``External`` feed, but
# ``input`` accepts any ``Series`` so a transform may wrap another transform/binary_op (e.g.
# zscore of an ema). Nesting is bounded: see the depth cap enforced by ``Thesis`` (at most
# ``MAX_SERIES_NESTING`` = 5 operator levels). There is no separate Indicator family — classic
# technical indicators (RSI/ADX/…) are deliberately absent; compose what you need from these
# primitives.


class EMA(_Strict):
    type: Literal["ema"] = "ema"
    input: Series
    window: PosIntParam


class ZScore(_Strict):
    type: Literal["zscore"] = "zscore"
    input: Series
    window: Ge2IntParam
    mean_type: Literal["sma", "ema"] = "sma"


class Percentile(_Strict):
    # Fraction of the trailing window strictly below the current value:
    # count(value < current) / window, in [0, (window-1)/window].
    type: Literal["percentile"] = "percentile"
    input: Series
    window: Ge2IntParam


class RollingAgg(_Strict):
    # A window aggregate of the input series — ``max`` / ``min`` / ``mean`` / ``std`` (population,
    # ddof=0). With ``window`` set: trailing-window (NaN until the window is full AND every bar in
    # it is finite — the same gate as ``percentile``). With ``window`` omitted/null:
    # EXPANDING max/min only (all-time high/low of the series so far; NaN until the first finite
    # bar) — the general-purpose peak/trough primitive; expanding ``mean``/``std`` are rejected
    # (silent regime-drift trap). Prefer the dedicated ``drawdown`` node for depth-below-peak;
    # ``binary_op(close / rolling_agg(close, N, "max"))`` remains valid. ``std`` needs ``window``
    # >= 2, so a set ``window`` is ``Ge2IntParam`` like sibling transforms. A simple moving average
    # is ``agg:"mean"``; realized vol is ``rolling_agg(change(close, kind="log"), N, "std")``.
    type: Literal["rolling_agg"] = "rolling_agg"
    input: Series
    window: Ge2IntParam | None = None
    agg: Literal["max", "min", "mean", "std"]

    @model_validator(mode="after")
    def _check_expanding(self) -> RollingAgg:
        if self.window is None and self.agg not in ("max", "min"):
            raise ValueError(
                "expanding rolling_agg (window omitted) only supports agg='max' or 'min'; "
                f"got agg={self.agg!r}"
            )
        return self


class Drawdown(_Strict):
    # Fractional depth below a peak: ``input / peak − 1`` (≤ 0). ``window`` set → trailing N-bar
    # peak; omitted → expanding (all-time) peak. ``input`` defaults to the target's close. Counts
    # as one operator level, recovering nesting budget vs composing
    # ``binary_op(close / rolling_agg(...))``. "In a ≥30% drawdown" is ``drawdown < -0.30``.
    type: Literal["drawdown"] = "drawdown"
    input: Series = PField(default_factory=Field)
    window: PosIntParam | None = None


class Runup(_Strict):
    # Fractional height above a trough: ``input / trough − 1`` (≥ 0) — the exact mirror of
    # ``drawdown``. ``window`` set → trailing N-bar trough; omitted → expanding (all-time) trough.
    # ``input`` defaults to the target's close. Reads both ways: ``runup >= 0.05`` as a recovery/
    # stabilization guard after a trough, or as an extension/overheat read near a peak. Counts as
    # one operator level.
    type: Literal["runup"] = "runup"
    input: Series = PField(default_factory=Field)
    window: PosIntParam | None = None


class BarsSinceExtremum(_Strict):
    # Bar count since the most recent bar attaining the trailing/expanding ``max``|``min`` of
    # ``input``. ``extremum="max"`` + expanding = bars since the all-time high (drawdown duration);
    # ``extremum="min"`` = bars since the trough ("no new low in K bars" = stabilization). Ties
    # reset to the MOST RECENT attaining bar (a retest of the peak restarts the duration).
    # ``window`` set → trailing N-bar extremum; omitted → expanding. ``input`` defaults to close.
    # Trailing form NaNs until the window is full AND every bar in it is finite (same gate as
    # ``percentile``/``rolling_agg``). Counts as one operator level.
    type: Literal["bars_since_extremum"] = "bars_since_extremum"
    extremum: Literal["max", "min"]
    input: Series = PField(default_factory=Field)
    window: PosIntParam | None = None


class Change(_Strict):
    # k-period change of ``input``, mirroring ``Outcome.kind``: ``pct`` = (cur/prev − 1),
    # ``log`` = ln(cur/prev), ``diff`` = cur − prev (level change — the honest form for
    # rates/spreads/multiples where a percent is dimensionally wrong). ``periods`` may be a list
    # (sweeps as ``change_periods``). ``pct`` NaNs when ``prev == 0``; ``log`` NaNs on a
    # non-positive ratio; ``diff`` only needs both bars finite (0 is a valid level base).
    type: Literal["change"] = "change"
    input: Series
    periods: PosIntParam = 1
    kind: Literal["pct", "log", "diff"] = "pct"


class Shift(_Strict):
    # The input series ``periods`` bars ago (out[t] = in[t - periods]); the leading ``periods`` bars
    # are NaN. Backward-only (periods >= 1), so it can never read the future. Prefer ``change`` for
    # k-period pct/log/diff; ``shift`` remains for level comparisons (``close > shift(high, 1)``).
    # Depth-transparent like ``binary_op`` (plumbing, not an operator level); a list ``periods``
    # sweeps as its own ``shift_periods`` axis.
    type: Literal["shift"] = "shift"
    input: Series
    periods: PosIntParam = 1


class RollingCorr(_Strict):
    # Trailing-window Pearson correlation of two Series — a per-target TIME-axis transform (each
    # target's own history only; ranking across the targets at a bar is ``cross_rank``, basket
    # mode). ``window`` >= 3 (corr of 2 points
    # is always ±1 — degenerate). NaN unless the whole window is finite in BOTH inputs AND both
    # window stds > 0 (zero-variance → NaN, never ±1) — the standard NaN-gating contract. Counts as
    # ONE operator level with TWO children. Recipe for "corr(stock daily return, Δ option EOD
    # IV30)": declare the IV feed in ``data.external``, then
    # ``rolling_corr(change(close), change(iv30, kind="diff"), window)`` —
    # ``change`` counts as one level, so the whole recipe costs two of the five levels.
    type: Literal["rolling_corr"] = "rolling_corr"
    left: Series
    right: Series
    window: Ge3IntParam


# ---- Cross-sectional transforms (ACROSS targets at each bar; basket mode only) ----
#
# Unlike the trailing-window transforms above (which operate along the TIME axis of each target
# independently), these operate ACROSS the targets at each bar — the primitives for relative-value
# statements ("the cheapest tier within the group outperforms"). They are legal only under
# ``target_mode="basket"`` (>= 2 targets; enforced by ``Thesis``): conjunction declares the
# targets an independent regime, and a node that couples them contradicts that declaration. A
# bar's cross-section is defined only where at least ``min_valid`` targets hold finite values
# (else NaN, which the NaN-gating contract maps to "never fires"). ``min_valid`` is deliberately
# NOT sweepable — a swept definedness floor sweeps the SAMPLE, not the hypothesis. Each node
# counts as ONE operator level.


class CrossRank(_Strict):
    # Ascending fraction-rank of the target's value among all targets' finite values at bar t:
    # (avg_rank - 1) / (k - 1), in [0, 1] (average ranks on ties; k = finite targets at t).
    # NaN where the target's own value is NaN or k < min_valid. ``cross_rank(x) >= 0.8`` IS
    # top-quintile membership — the quantile primitive; there is no separate quantile node.
    type: Literal["cross_rank"] = "cross_rank"
    input: Series
    min_valid: Ge2Int = 2


class CrossDemean(_Strict):
    # The target's value minus the cross-target mean of the finite values at bar t (self included).
    # NaN where the target's own value is NaN or fewer than min_valid targets are finite. The
    # zscore recipe: ``binary_op(cross_demean(x), "/", cross_agg(x, "std"))`` — the same 1 + d(x)
    # nesting cost as either node alone, and a zero-dispersion bar divides by 0 → NaN via the
    # ``BinaryOp`` ``/`` contract (never fires).
    type: Literal["cross_demean"] = "cross_demean"
    input: Series
    min_valid: Ge2Int = 2


class CrossAgg(_Strict):
    # A cross-target AGGREGATE at each bar, broadcast back to every target column — the breadth /
    # dispersion primitive ("70% of the group above its 200d SMA" via ``frac_positive`` of
    # ``binary_op(close - rolling_agg(close, 200, "mean"))``; a cross-sectional-vol regime via
    # ``std``). Unlike ``cross_rank``/``cross_demean`` the value is a property of the CROSS-SECTION,
    # not of the individual target, so a bar carries the VALUE (for every column) whenever at
    # least ``min_valid`` targets are finite — a target whose own value is still warming up sees
    # the group's breadth like any other; intentional, do not "fix". The FIRING latch is stricter
    # than the value: a member's warmup gates on its OWN input as well (``compiler.vectorize``),
    # so a member whose series has not yet produced a value cannot fire off the broadcast — a
    # pre-listing firing would censor as ``no_outcome`` and hard-refuse the cell it lands in.
    # ``std`` is the population std
    # (ddof=0, matching ``rolling_agg``); ``frac_positive`` is the fraction of finite values > 0,
    # in [0, 1].
    type: Literal["cross_agg"] = "cross_agg"
    input: Series
    agg: Literal["mean", "median", "std", "frac_positive"]
    min_valid: Ge2Int = 2


# ---- Combinators (arithmetic) ----------------------------------------------
#
# ``BinaryOp`` combines two series element-wise. It is *transparent* for the nesting-depth cap
# (it is arithmetic, not a transform level), so ``binary_op(ema(x), ema(y))`` is allowed.


class BinaryOp(_Strict):
    type: Literal["binary_op"] = "binary_op"
    left: Series
    right: Series
    op: Literal["+", "-", "*", "/"]


class UnaryOp(_Strict):
    # Element-wise unary arithmetic, *transparent* for the nesting-depth cap like ``BinaryOp``.
    # Out-of-domain inputs (``log`` of a non-positive, ``sqrt`` of a negative) map to NaN — the
    # NaN-gating contract (never fires). ``abs`` unlocks the magnitude classics (Amihud
    # illiquidity ``|ret|/dollar volume``, |surprise| conditioning, |z| as an input series —
    # two-sided *conditions* stay an ``or`` of thresholds).
    type: Literal["unary_op"] = "unary_op"
    input: Series
    op: Literal["abs", "log", "sign", "sqrt", "neg"]


# ---- Series union ----------------------------------------------------------


Series = Annotated[
    Field
    | Constant
    | External
    | Calendar
    | DaysSince
    | EMA
    | ZScore
    | Percentile
    | RollingAgg
    | Drawdown
    | Runup
    | BarsSinceExtremum
    | Change
    | Shift
    | RollingCorr
    | CrossRank
    | CrossDemean
    | CrossAgg
    | BinaryOp
    | UnaryOp,
    PField(discriminator="type"),
]


# ---- Conditions ------------------------------------------------------------


class ThresholdCondition(_Strict):
    type: Literal["threshold"] = "threshold"
    left: Series
    op: Literal["<", "<=", ">", ">=", "==", "!="]
    right: Series


class AndCondition(_Strict):
    type: Literal["and"] = "and"
    conditions: list[Condition] = PField(min_length=2)


class OrCondition(_Strict):
    type: Literal["or"] = "or"
    conditions: list[Condition] = PField(min_length=2)


class NotCondition(_Strict):
    type: Literal["not"] = "not"
    condition: Condition


class RollingCondition(_Strict):
    type: Literal["rolling"] = "rolling"
    # A list ``window`` sweeps the trailing-window length as its own ``rolling_window`` result axis
    # (like a transform-window sweep), taking part in the same Cartesian product. Auto-named, so —
    # unlike a swept ``Constant`` — no ``name`` field is needed.
    window: PosIntParam
    # ``all``/``any`` fire when the inner condition held on every / at least one bar of the window;
    # ``count`` fires when it held on at least ``min_count`` bars — an "at least K of N" trigger
    # (e.g. ">= 3 of the last 5 bars closed down", a sustained-regime signal ``all`` can't state).
    # ``min_count`` is required for — and only valid with — ``count``; keep it scalar (the window
    # already sweeps via ``rolling_window``).
    agg: Literal["all", "any", "count"]
    min_count: PosInt | None = None
    condition: Condition

    @model_validator(mode="after")
    def _check_min_count(self) -> RollingCondition:
        if self.agg == "count":
            if self.min_count is None:
                raise ValueError(
                    "rolling agg='count' requires 'min_count' (the K of 'at least K of N')"
                )
            floor = min(self.window) if isinstance(self.window, list) else self.window
            if self.min_count > floor:
                raise ValueError(
                    f"rolling 'min_count' ({self.min_count}) exceeds the window ({floor}); the "
                    f"count condition could never fire"
                )
        elif self.min_count is not None:
            raise ValueError("rolling 'min_count' is only valid with agg='count'")
        return self


class FirstTrueCondition(_Strict):
    # Episode entry: fires only on a false→true transition of the child's TRADABLE signal
    # (``value & init``). The first True bar after warmup does NOT count as a transition (must have
    # seen an initialized False first), so a regime that is already true when the child warms up
    # does not phantom-fire. Optional ``cooldown`` suppresses re-fires for K bars after a fire
    # (0 = every transition; a list sweeps as ``first_true_cooldown``). The episode-entry
    # primitive: measure forward return from the bar a regime is first entered (deep drawdown,
    # end-of-bull risk alarm, …), not every bar inside it. Also the crossover recipe:
    # ``first_true(threshold(fast > slow))`` — the DSL has no dedicated ``cross`` condition.
    type: Literal["first_true"] = "first_true"
    condition: Condition
    cooldown: NonNegIntParam = 0


Condition = Annotated[
    ThresholdCondition
    | AndCondition
    | OrCondition
    | NotCondition
    | RollingCondition
    | FirstTrueCondition,
    PField(discriminator="type"),
]


# ---- Top-level -------------------------------------------------------------


#: The data key naming the excess-return source ``params.benchmark = "market"`` measures against.
#: A DEDICATED slot, not an external feed: external feeds are asof-anchored/lagged *decision*
#: inputs, while the benchmark is *outcome measurement* — its open price is sampled at exactly the
#: observation's anchor bars (open[t+1] / open[t+1+h]) on the joined index, no ffill, no lag. A bar
#: where the benchmark is missing censors the observation (exit_reason "no_benchmark") rather than
#: shifting the timeline.
BENCHMARK_KEY = "benchmark"

#: Names no target or feed may take, because the run's key namespace is flat and these are spoken
#: for. Exactly one key is reserved; the tuple exists so adding a second stays one edit.
RESERVED_DATA_KEYS = (BENCHMARK_KEY,)


class ExternalFeed(_Strict):
    # Structured external-feed entry. A feed is a logical KEY, never a file: the CSV behind it is
    # named at invocation (``seikan run --data <feed>=<path>``), and so is the COLUMN read out of
    # that CSV (``seikan run --column <feed>=<col>``, or ``--column <feed>@<target>=<col>`` for one
    # member of a per-target feed). What an entry configures is the SEMANTIC read — what the series
    # MEANS to this thesis, which is the only thing the document is entitled to fix. ``per_target``
    # gives each target its own series (the invocation then answers one path per target under the
    # derived keys ``<feed>@<target>``) where the default broadcasts ONE series across every
    # target; ``lag`` shifts the feed's timestamps forward by a calendar duration before the asof
    # anchor, modelling publication delay (an int is days; a string is a pandas Timedelta like
    # "36h" — note "1m" is one minute). A column NAME is not semantic: it is a property of the file
    # that happens to answer this key — one vendor ships three series in one CSV under its own
    # spellings, another ships each in its own file — so a name here would let re-shaping the CSV
    # turn the same exam into a DIFFERENT document, which is exactly why paths do not live here
    # either. Feed timestamps are treated as AVAILABILITY times; if the source stamps values at
    # the period they describe (a daily aggregate stamped that day's midnight, a month-end figure),
    # set ``lag`` to the real publication delay or the value leaks into bars that predate its
    # release.

    per_target: bool = False
    lag: str | int = 0

    @model_validator(mode="after")
    def _check_lag(self) -> ExternalFeed:
        self.lag_timedelta  # noqa: B018 — parse now so a bad lag fails at model_validate time
        return self

    @property
    def lag_timedelta(self) -> pd.Timedelta:
        import pandas as pd  # local: keep the DSL module import-light

        td = pd.Timedelta(days=self.lag) if isinstance(self.lag, int) else pd.Timedelta(self.lag)
        if td < pd.Timedelta(0):
            raise ValueError(f"external feed lag must be >= 0, got {self.lag!r}")
        return td


class DataSpec(_Strict):
    # WHICH series this thesis measures, NAMED but not located. ``targets`` lists the logical keys
    # to backtest together (each becomes a column); the CSV behind every key — and WHICH column of
    # that CSV answers it — is supplied at invocation (``seikan run --data <key>=<path> --column
    # <key>=<col>``). A file path inside the document would make the same exam over re-pulled data
    # a DIFFERENT document — ``dsl_hash`` would move for a reason that has nothing to do with what
    # is being asked, and a thesis could not be re-measured next month without being rewritten —
    # so the DSL names a series and the invocation locates it. A column name is that same fact one
    # level in: it is a property of the FILE that happens to answer a key (this vendor ships three
    # yields in one CSV under its own spellings, that one ships each in a file of its own), never a
    # property of the thesis, so while it lived here the same exam over a RE-SHAPED CSV was
    # likewise a different document — a column rename or a split file moved a hash the question
    # never moved.
    # All time series are STRICT CSV files with an ISO-8601 timezone-naive datetime index (see
    # ``dataio.read_strict_csv`` — no format guessing, ever): a full-OHLCV file is a
    # price target; a file WITHOUT open/high/low/close is a SERIES target (a yield, a spread, a
    # valuation multiple, a strategy index) — its single value column is measured directly
    # (open=high=low=close=value is synthesized so the close-reading algebra applies; no volume).
    # A multi-column series file needs ``--column <target>=<col>`` to say which of its columns the
    # target IS; an OHLCV target takes no column binding at all, since a price target always
    # measures its open-anchored prices. All targets of one thesis must share
    # one shape — mixing a price target with a series target is rejected at load.
    targets: list[str]
    start: str | None = None
    end: str | None = None
    # Alternative-data feeds (strict CSV), keyed by feed name. Each entry configures the SEMANTIC
    # read — one series or one series per target, and what publication lag it carries; the file and
    # the column read out of it arrive with the invocation, like every other locating fact.
    external: dict[str, ExternalFeed] = PField(default_factory=dict)

    @model_validator(mode="after")
    def _check_key_namespace(self) -> DataSpec:
        # The run's data keys live in ONE flat namespace, because that is the namespace a caller
        # types on a command line: a target key, a feed key, a derived ``<feed>@<target>`` key and
        # the reserved ``benchmark`` key all compete for the same ``--data KEY=PATH`` slot. Two
        # declarations answering to one key would let a single ``--data`` pair silently stand in
        # for both, so the collision is refused here rather than resolved by precedence. It is
        # also the namespace ``--column KEY=COL`` addresses: one key names both the file that
        # answers it and the column read out of that file, so a collision left standing here would
        # misdirect two flags rather than one — and a column bound for the series a caller meant,
        # applied to the series they did not, is a silently different measurement.
        if not self.targets:
            raise ValueError("data.targets must name at least one target series")
        seen: dict[str, str] = {}
        # Typed ``Sequence[object]`` because that is how this check reads them — a name is a
        # candidate --data key until it has been shown to be a string, and the isinstance below is
        # the check that shows it. Naming the declared element type here instead would make that
        # first clause statically dead.
        groups: tuple[tuple[str, Sequence[object]], ...] = (
            ("target", self.targets),
            ("external feed", list(self.external)),
        )
        for kind, names in groups:
            for name in names:
                if not isinstance(name, str) or not name or name != name.strip():
                    raise ValueError(
                        f"{kind} name {name!r} must be a non-empty string with no surrounding "
                        "whitespace — it is typed as a --data key"
                    )
                if "=" in name or "@" in name:
                    raise ValueError(
                        f"{kind} name {name!r} may not contain '=' or '@': '=' separates a "
                        "--data KEY=PATH pair and '@' derives a per-target feed key"
                    )
                if name in RESERVED_DATA_KEYS:
                    raise ValueError(
                        f"{kind} name {name!r} is reserved: the '{name}' key names the "
                        "excess-return source params.benchmark='market' asks for"
                    )
                if name in seen:
                    raise ValueError(
                        f"{kind} name {name!r} is already declared as a {seen[name]} — one data "
                        "key answers one series"
                    )
                seen[name] = kind
        return self

    @model_validator(mode="after")
    def _check_start_end(self) -> DataSpec:
        # The evaluated interval is part of what a report certifies, so its bounds obey the same
        # strict ISO-8601 timezone-naive discipline as the CSV index itself (dataio) — no format
        # guessing, ever. Handing them to pandas label slicing verbatim would silently INTERPRET
        # an ambiguous "01/02/2024", and an unparseable bound would escape as an uncaught
        # exception (exit 4) instead of a DSL refusal (exit 3).
        import pandas as pd  # local: keep the DSL module import-light

        for field in ("start", "end"):
            raw = getattr(self, field)
            if raw is None:
                continue
            if not isinstance(raw, str) or not raw.strip():
                raise ValueError(f"data.{field} must be a non-empty ISO-8601 timestamp string")
            try:
                ts = pd.to_datetime(raw, format="ISO8601")
            except (ValueError, TypeError) as exc:
                raise ValueError(
                    f"data.{field}={raw!r} is not a strict ISO-8601 timestamp "
                    f"(e.g. '2024-01-31' or '2024-01-31T09:30:00'): {exc}"
                ) from exc
            if pd.isna(ts):
                raise ValueError(f"data.{field}={raw!r} parses to NaT")
            if ts.tzinfo is not None:
                raise ValueError(
                    f"data.{field}={raw!r} carries a timezone; the data contract is "
                    "timezone-naive timestamps only"
                )
        if (
            self.start is not None
            and self.end is not None
            and pd.to_datetime(self.start, format="ISO8601")
            >= pd.to_datetime(self.end, format="ISO8601")
        ):
            raise ValueError(
                f"data.start ({self.start!r}) must be strictly before data.end ({self.end!r})"
            )
        return self

    def feed_keys(self) -> dict[str, list[str]]:
        """{feed name → the data key(s) that answer it}. A per-target feed derives one key per
        target (``<feed>@<target>``, in target-declaration order); a shared feed answers to its own
        name. Per-target cover is by construction here — there is no mapping to check against the
        targets, because the keys ARE derived from them."""
        return {
            name: ([f"{name}@{t}" for t in self.targets] if feed.per_target else [name])
            for name, feed in self.external.items()
        }


class Outcome(_Strict):
    # WHAT a firing measures (the observation's outcome). The default (``params.outcome`` unset)
    # is the target's forward PERCENT return on the next-open anchor. ``series`` picks the measured
    # series: ``"target"`` = the target's own value column; a declared external feed name = that
    # feed's forward evolution (e.g. realized vol, a credit spread, an IV index — "when X fires,
    # Y moves"). ``kind`` picks the measurement algebra: ``pct`` = (b/a − 1), ``log`` = ln(b/a)
    # (both need a positive-scale series), ``diff`` = (b − a) — the honest form for
    # rates/spreads/multiples, where a percent of a near-zero or sign-crossing level is meaningless
    # (a 10y yield falling 4.0 → 3.5 is −0.5 in ``diff``, not −12.5%). The anchor stays next-bar
    # (off=+1) for every outcome — no same-bar look-ahead; ``direction`` still sets the sign, so
    # ``shortonly`` + ``diff`` profits when the level FALLS. A NaN window in a feed outcome
    # censors the observation as ``exit_reason="no_outcome"``.

    series: str = "target"
    kind: Literal["pct", "log", "diff"] = "pct"


class BacktestParams(_Strict):
    # Observer-native forward-return event study: every bar where ``entry`` fires opens an
    # independent, OVERLAPPING forward-return observation measured over ``horizon`` bars. There is
    # no exit condition and no one-position-at-a-time state machine. Returns are raw measurements
    # (exit/entry - 1): there is no fee/slippage model and no equity curve. `direction`
    # sets the sign of the measured return (longonly = the forward return, shortonly = its
    # negative).
    # `horizon` is the forward measurement window in bars (default 1 = the immediate next-period
    # forward return); a list sweeps it as its own result axis ("horizon"), yielding a return
    # response curve (e.g. [1, 5, 10, 20]) — set it explicitly, the default is only a neutral
    # fallback.
    # A firing bar t's observation is always anchored at the NEXT bar's open —
    # open[t+1]→open[t+1+h] — the only tradable convention (a same-bar close[t]→close[t+h]
    # measurement would read from a price the decision itself consumed). `features` names extra
    # entry-time series snapshots (any scalar-param Series, incl. externals) used for conditional
    # bucketing of returns — defaults to built-in momentum + volatility snapshots when unset.
    # There is no sampling knob of any kind here: every declared parameter × horizon cell is
    # measured over the WHOLE index and reported independently, so the DSL cannot express a
    # partition of the data that some cells see and others do not. The circular-shift rotation
    # null likewise always uses every non-identity shift (a capped subsample has residue
    # aliasing), so its resolution is a property of the series length, never a choice.
    # `benchmark` switches the measured forward return from raw to EXCESS: "market" subtracts the
    # same-window return of the ``benchmark`` key's series (open[t+1]→open[t+1+h], the same
    # next-open anchor). Without it, long-horizon (20-60 bar) raw returns are dominated by market
    # beta. Under `shortonly` the excess is sign·(tgt_ret − bench_ret) — profits when the target
    # UNDERPERFORMS the benchmark (the hedged-short reading). Every downstream statistic
    # (rotation null, HAC,
    # conditional buckets, PBO) then describes excess returns; the summary records the mode under
    # "benchmark". "cross_mean" (basket mode ONLY — ``Thesis`` validation enforces it) subtracts
    # the same-window mean forward return of ALL declared members, self included, measured in the
    # outcome's own algebra — the relative-value read "did this member beat the basket?". It
    # couples the targets in the OUTCOME exactly as cross nodes couple them in the signal, which
    # is why conjunction refuses it. Its missingness is fail-closed: any member's leg non-finite
    # at a bar censors the WHOLE bar's benchmark leg, so every member's firing there exits as
    # ``no_benchmark`` — a hole in one member never silently reshapes the others' benchmark.
    direction: Literal["longonly", "shortonly"] = "longonly"
    horizon: PosIntParam = PField(default=1)
    features: dict[str, Series] | None = PField(default=None)
    benchmark: Literal["market", "cross_mean"] | None = None
    outcome: Outcome | None = None

    @model_validator(mode="after")
    def _check_features_scalar(self) -> BacktestParams:
        for name, node in (self.features or {}).items():
            if _series_has_sweep(node):
                raise ValueError(
                    f"feature {name!r} must use scalar params (no list sweeps); features are "
                    f"grouping variables for conditional analysis, not swept result axes"
                )
        return self

    @model_validator(mode="after")
    def _check_feature_names(self) -> BacktestParams:
        # Feature snapshots are written into the trades frame BESIDE the engine's own columns,
        # so a colliding name either overwrites evidence (a feature named `ret` replaced the
        # measured forward return) or duplicates a column — after which `trades["ret"]` is a
        # DataFrame, the statistics read a 2-D array, and `trades["is_open"]` crashes the
        # boolean index. The runner cannot catch this: by the time it sees the name, the
        # collision has already happened.
        # ``Iterable[object]`` like ``DataSpec._check_key_namespace``: the isinstance below is what
        # establishes these keys are strings, so it stays a live check, not a dead clause.
        feature_names: Iterable[object] = self.features or {}
        for name in feature_names:
            if not isinstance(name, str) or not name.strip():
                raise ValueError("feature names must be non-empty strings")
            if name in RESERVED_FEATURE_NAMES:
                raise ValueError(
                    f"feature name {name!r} collides with a reserved result column "
                    f"(the trades frame's own fields plus 'target'/'horizon'); rename the "
                    f"feature. Reserved: {sorted(RESERVED_FEATURE_NAMES)}"
                )
        return self


# ---- Series tree traversal ---------------------------------------------------
#
# Series nodes nest (transforms take any ``Series`` ``input``; ``BinaryOp``/``UnaryOp``
# combine/wrap). ``_iter_child_series`` yields a node's direct Series children so external-feed
# discovery and the nesting-depth cap can both walk the tree recursively. Leaves
# (Field/Constant/External/Calendar/DaysSince) have no Series children; every non-leaf has them.


_SERIES_INPUT_NODES = (
    EMA, ZScore, Percentile, RollingAgg, Drawdown, Runup, BarsSinceExtremum,
    Change, Shift, CrossRank, CrossDemean, CrossAgg, UnaryOp,
)


def _iter_child_series(node: Series) -> Iterator[Series]:
    if isinstance(node, _SERIES_INPUT_NODES):
        yield node.input
    elif isinstance(node, (BinaryOp, RollingCorr)):
        yield node.left
        yield node.right


def _series_external_names(node: Series) -> Iterator[str]:
    if isinstance(node, (External, DaysSince)):
        yield node.name
    for child in _iter_child_series(node):
        yield from _series_external_names(child)


def _series_has_sweep(node: Series) -> bool:
    """True if any window/period param anywhere under a Series node is list-valued (a sweep)."""
    if isinstance(node, Constant) and isinstance(node.value, list):
        return True
    if any(isinstance(getattr(node, attr, None), list) for attr in ("window", "periods")):
        return True
    return any(_series_has_sweep(c) for c in _iter_child_series(node))


def _series_cross_nodes(node: Series) -> Iterator[CrossRank | CrossDemean | CrossAgg]:
    """Yield every cross-sectional node (CrossRank/CrossDemean/CrossAgg) anywhere under a Series
    tree."""
    if isinstance(node, (CrossRank, CrossDemean, CrossAgg)):
        yield node
    for child in _iter_child_series(node):
        yield from _series_cross_nodes(child)


def _iter_series_sweep_lengths(node: Series) -> Iterator[int]:
    """Yield the length of every list-valued (swept) param under a Series node."""
    if isinstance(node, Constant) and isinstance(node.value, list):
        yield len(node.value)
    for attr in ("window", "periods"):
        value = getattr(node, attr, None)
        if isinstance(value, list):
            yield len(value)
    for child in _iter_child_series(node):
        yield from _iter_series_sweep_lengths(child)


def _iter_condition_sweep_lengths(node: Condition) -> Iterator[int]:
    """Yield the length of every swept param anywhere under a condition tree — the Series
    operands plus the conditions' own list-valued params (``RollingCondition.window``,
    ``FirstTrueCondition.cooldown``)."""
    for attr in ("window", "cooldown"):
        value = getattr(node, attr, None)
        if isinstance(value, list):
            yield len(value)
    match node:
        case ThresholdCondition(left=left, right=right):
            yield from _iter_series_sweep_lengths(left)
            yield from _iter_series_sweep_lengths(right)
        case AndCondition(conditions=conditions) | OrCondition(conditions=conditions):
            for child in conditions:
                yield from _iter_condition_sweep_lengths(child)
        case (
            NotCondition(condition=child)
            | RollingCondition(condition=child)
            | FirstTrueCondition(condition=child)
        ):
            yield from _iter_condition_sweep_lengths(child)


def _sweep_axis_name(
    kind: str,
    param: str,
    value: _NumericParam | None,
    counts: dict[str, int],
    name: str | None = None,
) -> str | None:
    """The level name ``compiler.vectorize._make_resolver`` assigns a swept (list-valued) param,
    or ``None`` when the param is scalar. Kept bit-identical to that resolver (a parity test pins
    it) so this parse-time check and the engine name every sweep axis the same."""
    if not isinstance(value, list):
        return None
    if name is not None:
        return name
    base = f"{kind}_{param}"
    counts[base] = counts.get(base, 0) + 1
    return base if counts[base] == 1 else f"{base}_{counts[base]}"


def _series_axis_names(node: Series, counts: dict[str, int], out: list[str]) -> None:
    # Mirrors compiler.vectorize._transform_series EXACTLY: recurse operands (input, or left then
    # right) BEFORE the node's own param, so the shared occurrence counter advances in engine order.
    match node:
        case Field() | External() | Calendar() | DaysSince():
            return
        case Constant(value=val, name=nm):
            lvl = _sweep_axis_name("constant", "value", val, counts, name=nm)
        case EMA(input=inp, window=w):
            _series_axis_names(inp, counts, out)
            lvl = _sweep_axis_name("ema", "window", w, counts)
        case ZScore(input=inp, window=w):
            _series_axis_names(inp, counts, out)
            lvl = _sweep_axis_name("zscore", "window", w, counts)
        case Percentile(input=inp, window=w):
            _series_axis_names(inp, counts, out)
            lvl = _sweep_axis_name("percentile", "window", w, counts)
        case RollingAgg(input=inp, window=w):
            _series_axis_names(inp, counts, out)
            lvl = _sweep_axis_name("rolling_agg", "window", w, counts)
        case Drawdown(input=inp, window=w):
            _series_axis_names(inp, counts, out)
            lvl = _sweep_axis_name("drawdown", "window", w, counts)
        case Runup(input=inp, window=w):
            _series_axis_names(inp, counts, out)
            lvl = _sweep_axis_name("runup", "window", w, counts)
        case BarsSinceExtremum(input=inp, window=w):
            _series_axis_names(inp, counts, out)
            lvl = _sweep_axis_name("bars_since_extremum", "window", w, counts)
        case Change(input=inp, periods=p):
            _series_axis_names(inp, counts, out)
            lvl = _sweep_axis_name("change", "periods", p, counts)
        case Shift(input=inp, periods=p):
            _series_axis_names(inp, counts, out)
            lvl = _sweep_axis_name("shift", "periods", p, counts)
        case UnaryOp(input=inp):
            _series_axis_names(inp, counts, out)
            lvl = None
        case RollingCorr(left=lhs, right=rhs, window=w):
            _series_axis_names(lhs, counts, out)
            _series_axis_names(rhs, counts, out)
            lvl = _sweep_axis_name("rolling_corr", "window", w, counts)
        case CrossRank(input=inp) | CrossDemean(input=inp) | CrossAgg(input=inp):
            # No swept params of their own (``min_valid`` is a plain int); the input's sweeps
            # register through the recursion — dropping these cases would fall through to the
            # wildcard and silently skip every axis inside a cross input, breaking the
            # parse-time/engine parity the pin test enforces.
            _series_axis_names(inp, counts, out)
            lvl = None
        case BinaryOp(left=lhs, right=rhs):
            _series_axis_names(lhs, counts, out)
            _series_axis_names(rhs, counts, out)
            lvl = None
        case _:
            # The arms above happen to cover the whole ``Series`` union today, so a checker reads
            # this arm as dead — but the arm is what makes the traversal TOTAL, and staying total
            # is exactly the property a new node type would take away. Silenced narrowly, never
            # deleted: without it an unhandled node raises here instead of contributing no axis.
            lvl = None  # type: ignore[unreachable]
    if lvl is not None:
        out.append(lvl)


def _condition_axis_names(node: Condition, counts: dict[str, int], out: list[str]) -> None:
    # Mirrors compiler.vectorize._transform_condition: for Rolling/FirstTrue the INNER condition
    # resolves before the node's own window/cooldown axis.
    match node:
        case ThresholdCondition(left=lhs, right=rhs):
            _series_axis_names(lhs, counts, out)
            _series_axis_names(rhs, counts, out)
        case AndCondition(conditions=cs) | OrCondition(conditions=cs):
            for c in cs:
                _condition_axis_names(c, counts, out)
        case NotCondition(condition=c):
            _condition_axis_names(c, counts, out)
        case RollingCondition(window=w, condition=inner):
            _condition_axis_names(inner, counts, out)
            lvl = _sweep_axis_name("rolling", "window", w, counts)
            if lvl is not None:
                out.append(lvl)
        case FirstTrueCondition(condition=inner, cooldown=cd):
            _condition_axis_names(inner, counts, out)
            lvl = _sweep_axis_name("first_true", "cooldown", cd, counts)
            if lvl is not None:
                out.append(lvl)


def _iter_sweep_axis_names(entry: Condition) -> list[str]:
    """Ordered sweep-axis names for every list-valued param across the entry tree — the exact names
    ``compiler.vectorize.collect_sweeps`` produces (a parity test pins the equality). Lets the
    ``Thesis`` validator refuse a reserved/duplicate/column-colliding axis at PARSE time (exit 3)
    instead of the runner discovering it after a data load (exit 4)."""
    out: list[str] = []
    _condition_axis_names(entry, {}, out)
    return out


def declared_grid_size(entry: Condition, horizon: int | list[int]) -> int:
    """The DECLARED hypothesis count: the Cartesian product of every swept entry param times
    the number of horizons — the same quantity the runner records as
    ``n_hypotheses_attempted``, computed structurally so it is knowable BEFORE any data is read.
    Non-firing combos cannot shrink it."""
    size = len(horizon) if isinstance(horizon, list) else 1
    for length in _iter_condition_sweep_lengths(entry):
        size *= length
        if size > MAX_DECLARED_GRID:  # early exit — no need to multiply out a runaway grid
            return size
    return size


def _series_depth(node: Series) -> int:
    """Operator-nesting depth. Leaves are 0; ``BinaryOp``/``UnaryOp``/``Shift`` are transparent
    (arithmetic/plumbing — they pass through the max child depth); every other operator adds one
    level."""
    child_max = max((_series_depth(c) for c in _iter_child_series(node)), default=0)
    if isinstance(node, (Field, Constant, External, Calendar, DaysSince)):
        return 0
    if isinstance(node, (BinaryOp, UnaryOp, Shift)):
        return child_max
    return 1 + child_max


def iter_condition_series(node: Condition) -> Iterator[Series]:
    """Yield every operand Series referenced anywhere under a condition tree."""
    match node:
        case ThresholdCondition(left=left, right=right):
            yield left
            yield right
        case AndCondition(conditions=conditions) | OrCondition(conditions=conditions):
            for child in conditions:
                yield from iter_condition_series(child)
        case (
            NotCondition(condition=child)
            | RollingCondition(condition=child)
            | FirstTrueCondition(condition=child)
        ):
            yield from iter_condition_series(child)


def iter_external_names(node: Condition) -> Iterator[str]:
    """Yield every external feed name referenced anywhere under a condition tree."""
    for series in iter_condition_series(node):
        yield from _series_external_names(series)


def series_source_leaves(node: Series) -> Iterator[tuple[str, str]]:
    """Yield ``(kind, name)`` for every RAW DATA leaf under a Series node."""
    if isinstance(node, Field):
        yield ("field", node.column)
    elif isinstance(node, External):
        yield ("external", node.name)
    elif isinstance(node, DaysSince):
        yield ("days_since", node.name)
    for child in _iter_child_series(node):
        yield from series_source_leaves(child)


def iter_source_leaves(node: Condition) -> Iterator[tuple[str, str]]:
    """Deduplicated ``(kind, name)`` raw decision inputs a condition tree reads.

    These are the leaves whose AVAILABILITY the engine must account for: the
    three-valued ``defined`` channel reports whether the ROOT condition was decidable, which a
    decisive sibling can mask (Kleene ``F∧U = F``) and which a NaN-skipping recursive kernel
    (EMA, expanding aggregates) can launder into a finite value on a later bar. Availability is
    read at the SOURCE instead, where no operator can absorb it.

    ``Constant`` and ``Calendar`` are excluded — both are total by construction (a constant is
    finite by validation, a calendar attribute is a property of the index itself)."""
    seen: set[tuple[str, str]] = set()
    for series in iter_condition_series(node):
        for leaf in series_source_leaves(series):
            if leaf not in seen:
                seen.add(leaf)
                yield leaf


def fmt_num(value: _NumericParam) -> str:
    """Compact deterministic numeric literal: integral floats render as ints (100.0 → '100')."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def render_series(node: Series) -> str:
    """Deterministic compact expression label for a scalar-param Series node — the value-column
    name the root-series output CSV uses (e.g. ``percentile(iv30,80)``, ``(close/ema(close,20))``).

    Every semantic field is rendered (windows/periods positionally, non-default modes as a trailing
    token), so distinct scalarized nodes render distinctly; the one realistic collision source is a
    user-chosen feed name shadowing another label — the CSV assembler disambiguates with ``#N``
    suffixes. Presentation only: rendering never participates in the DSL hash.
    """
    match node:
        case Field(column=column):
            return column
        case Constant(value=value):
            return fmt_num(value)
        case External(name=name):
            return name
        case Calendar(field=cal_field):
            return f"calendar({cal_field})"
        case DaysSince(name=name):
            return f"days_since({name})"
        case EMA(input=inp, window=w):
            return f"ema({render_series(inp)},{w})"
        case ZScore(input=inp, window=w, mean_type=mt):
            return f"zscore({render_series(inp)},{w}{',ema' if mt == 'ema' else ''})"
        case Percentile(input=inp, window=w):
            return f"percentile({render_series(inp)},{w})"
        case RollingAgg(input=inp, window=w, agg=agg):
            return f"rolling_agg({render_series(inp)},{'' if w is None else f'{w},'}{agg})"
        case Drawdown(input=inp, window=w):
            return f"drawdown({render_series(inp)}{'' if w is None else f',{w}'})"
        case Runup(input=inp, window=w):
            return f"runup({render_series(inp)}{'' if w is None else f',{w}'})"
        case BarsSinceExtremum(input=inp, extremum=ext, window=w):
            return f"bars_since_extremum({render_series(inp)},{ext}{'' if w is None else f',{w}'})"
        case Change(input=inp, periods=p, kind=k):
            return f"change({render_series(inp)},{p}{'' if k == 'pct' else f',{k}'})"
        case Shift(input=inp, periods=p):
            return f"shift({render_series(inp)},{p})"
        case RollingCorr(left=left, right=right, window=w):
            return f"rolling_corr({render_series(left)},{render_series(right)},{w})"
        case CrossRank(input=inp, min_valid=mv):
            return f"cross_rank({render_series(inp)}{'' if mv == 2 else f',{mv}'})"
        case CrossDemean(input=inp, min_valid=mv):
            return f"cross_demean({render_series(inp)}{'' if mv == 2 else f',{mv}'})"
        case CrossAgg(input=inp, agg=agg, min_valid=mv):
            return f"cross_agg({render_series(inp)},{agg}{'' if mv == 2 else f',{mv}'})"
        case BinaryOp(left=left, right=right, op=op):
            return f"({render_series(left)}{op}{render_series(right)})"
        case UnaryOp(input=inp, op=op):
            return f"{op}({render_series(inp)})"
        case _:
            raise TypeError(f"unknown series node: {node!r}")


class Thesis(_Strict):
    # An observer-native event-study thesis: ``entry`` is the firing condition (the belief that a
    # signal precedes a forward return); there is no exit condition. Every firing bar opens an
    # overlapping forward-return observation over ``params.horizon`` bars (see BacktestParams).
    name: str
    description: str | None = None
    # How the targets relate. ``conjunction`` (the default): the targets are the thesis's REGIME,
    # measured side by side with the weakest deciding, and no cross-target statistic is formed at
    # all. ``basket`` declares the targets ONE
    # cross-section per bar: the cross nodes (cross_rank/cross_demean/cross_agg) and
    # ``benchmark: "cross_mean"`` become legal, and every cell gains a POOLED cross-target
    # statistics block the checklist grades instead of per-member floors. The default is the only
    # legal value below 2 targets (a basket of one is degenerate).
    target_mode: Literal["conjunction", "basket"] = "conjunction"
    data: DataSpec
    entry: Condition
    params: BacktestParams = PField(default_factory=BacktestParams)

    @model_validator(mode="after")
    def _check_external_feeds_declared(self) -> Thesis:
        used = set(iter_external_names(self.entry))
        for node in (self.params.features or {}).values():
            used |= set(_series_external_names(node))
        missing = sorted(used - self.data.external.keys())
        if missing:
            raise ValueError(
                f"conditions reference external feed(s) {missing} not declared in "
                f"data.external (declared: {sorted(self.data.external)})"
            )
        return self

    def data_keys(self) -> list[str]:
        """Every logical data key this thesis needs a CSV for, in resolution order: each target,
        then each external feed (its own name, or ``<feed>@<target>`` per target when the feed is
        per-target), then ``benchmark`` when ``params.benchmark`` asks for a market source.

        This list IS the run's request: ``seikan run --data KEY=PATH`` must answer it exactly, and
        a thesis that says which series it reads without saying where they live is what makes the
        same exam re-runnable over re-pulled data."""
        keys = list(self.data.targets)
        for derived in self.data.feed_keys().values():
            keys.extend(derived)
        if self.params.benchmark == "market":
            keys.append(BENCHMARK_KEY)
        return keys

    @model_validator(mode="after")
    def _check_target_mode(self) -> Thesis:
        # basket pools the targets into ONE cross-section per bar, so it needs a cross-section
        # to pool. Note the converse is NOT required: a basket thesis need not carry a cross
        # node — the mode alone changes the statistical read (pooled per-cell block, pooled
        # floors), so declaring it over plain per-target signals is meaningful.
        if self.target_mode == "basket" and len(self.data.targets) < 2:
            raise ValueError(
                f"target_mode='basket' requires >= 2 targets (data.targets); got "
                f"{len(self.data.targets)} — a basket of one is degenerate; use "
                f"target_mode='conjunction'"
            )
        return self

    @model_validator(mode="after")
    def _check_cross_nodes_mode(self) -> Thesis:
        # A cross-sectional transform ranks/demeans/aggregates ACROSS targets at each bar —
        # exactly the coupling conjunction declares the targets do NOT have — so cross nodes
        # require target_mode='basket' (which _check_target_mode already holds to >= 2 targets)
        # and a satisfiable min_valid. Features are scanned too: a cross-sectional feature
        # snapshot couples the targets the same way an entry operand does.
        series_iter = list(iter_condition_series(self.entry))
        series_iter.extend((self.params.features or {}).values())
        cross_nodes = [n for s in series_iter for n in _series_cross_nodes(s)]
        if not cross_nodes:
            return self
        if self.target_mode != "basket":
            kinds = sorted({n.type for n in cross_nodes})
            raise ValueError(
                f"cross-sectional node(s) {kinds} require target_mode='basket' — conjunction "
                "declares the targets an independent regime and forms no cross-target "
                "statistic; declare target_mode='basket' to rank within the group"
            )
        n_targets = len(self.data.targets)
        for node in cross_nodes:
            if node.min_valid > n_targets:
                raise ValueError(
                    f"cross-sectional node {node.type!r} has min_valid={node.min_valid} but only "
                    f"{n_targets} targets are declared; it could never be defined"
                )
        return self

    @model_validator(mode="after")
    def _check_outcome_consistency(self) -> Thesis:
        outcome = self.params.outcome
        if outcome is None:
            return self
        if outcome.series != "target" and outcome.series not in self.data.external:
            raise ValueError(
                f"params.outcome.series {outcome.series!r} is not a declared external feed "
                f"(declared: {sorted(self.data.external)}); use 'target' or declare the feed in "
                f"data.external"
            )
        if self.params.benchmark == "market" and outcome.kind == "diff":
            raise ValueError(
                "params.benchmark='market' cannot be combined with outcome kind 'diff': a diff "
                "outcome is in the target's own LEVEL units (bp, index points, ratio turns) and "
                "subtracting a benchmark RETURN from it is incommensurable by construction; "
                "drop the benchmark or use outcome kind 'pct'/'log'"
            )
        if self.target_mode == "basket" and outcome.kind == "diff":
            raise ValueError(
                "target_mode='basket' cannot be combined with outcome kind 'diff': the pooled "
                "cross-target statistics average returns across members, which needs a common "
                "unit the engine cannot certify for level changes (bp, index points, ratio "
                "turns); pct/log are scale-free — use one of those or target_mode='conjunction'"
            )
        return self

    @model_validator(mode="after")
    def _check_benchmark_consistency(self) -> Thesis:
        # ``params.benchmark='market'`` needs no matching source FIELD to agree with: it simply
        # adds the reserved ``benchmark`` key to ``data_keys()``, and an invocation that does not
        # answer that key is refused at resolution. There is no stale-source refusal ("declared
        # but unused") to make either — an unused declaration is not expressible.
        if self.params.benchmark == "cross_mean" and self.target_mode != "basket":
            raise ValueError(
                "params.benchmark='cross_mean' requires target_mode='basket': it demeans each "
                "member's forward return by the basket mean, coupling the targets in the "
                "OUTCOME exactly as cross nodes couple them in the signal — which conjunction "
                "forbids"
            )
        return self

    @model_validator(mode="after")
    def _check_declared_grid(self) -> Thesis:
        # The gate's search cap is structural: a declared grid above it fails the search cap in
        # EVERY cell under any legal thresholds (`settings` admits no looser ceiling), so no
        # per-cell result it could produce would be readable evidence. Enforcing it here — before
        # a single CSV is read — makes that refusal cost nothing, where otherwise the runner
        # prices the entire grid first (rotation nulls and per-cell panels over every combo ×
        # horizon × target) only to hand the gate a summary whose search cap fails every cell
        # in it. The engine owes an impossible exam no report.
        size = declared_grid_size(self.entry, self.params.horizon)
        if size > MAX_DECLARED_GRID:
            raise ValueError(
                f"declared hypothesis grid is {size} (swept entry params × horizons) but the "
                f"sealed search cap is {MAX_DECLARED_GRID} — a grid this wide fails the search "
                "cap in every cell under any legal thresholds; narrow the sweep"
            )
        return self

    @model_validator(mode="after")
    def _check_sweep_axis_names(self) -> Thesis:
        # The runner's vectorize.collect_sweeps rejects reserved (target/horizon) and duplicate
        # sweep-axis names, and the runner rejects trade/feature-column collisions — but both fire
        # only AFTER a data load, surfacing as exit 4 (internal). Reproduce the SAME refusals here,
        # at parse time (exit 3), off the exact axis names the engine will assign. The runtime
        # checks stay as library-boundary backstops for a model_construct-built thesis.
        names = _iter_sweep_axis_names(self.entry)
        seen: set[str] = set()
        for lvl in names:
            if lvl in RESERVED_SWEEP_LEVELS:
                raise ValueError(
                    f"sweep axis name {lvl!r} is reserved (the engine names the target and horizon "
                    f"axes itself); rename the swept constant's 'name'"
                )
            if lvl in seen:
                raise ValueError(
                    f"duplicate sweep axis name {lvl!r}; each swept constant 'name' must be unique "
                    f"and must not collide with a transform axis (e.g. 'ema_window')"
                )
            seen.add(lvl)
        features = set(self.params.features) if self.params.features else set(DEFAULT_FEATURE_NAMES)
        collisions = sorted(seen & (set(TRADE_COLUMNS) | features))
        if collisions:
            raise ValueError(
                f"sweep axis name(s) {collisions} collide with reserved trade/feature columns "
                f"(the trades frame's own fields plus the entry-time feature snapshots); rename "
                f"the swept constant's 'name'"
            )
        return self

    @model_validator(mode="after")
    def _check_series_nesting_depth(self) -> Thesis:
        # Operators may nest at most ``MAX_SERIES_NESTING`` (5) levels deep; deeper is rejected.
        # binary_op/unary_op/shift are transparent (do not count as a level) — see _series_depth.
        for series in iter_condition_series(self.entry):
            depth = _series_depth(series)
            if depth > MAX_SERIES_NESTING:
                raise ValueError(
                    f"series {series.type!r} nests {depth} operator levels deep; the maximum is "
                    f"{MAX_SERIES_NESTING} (each transform counts one level; "
                    f"binary_op/unary_op/shift are free). Flatten or split the expression."
                )
        for name, node in (self.params.features or {}).items():
            depth = _series_depth(node)
            if depth > MAX_SERIES_NESTING:
                raise ValueError(
                    f"feature {name!r} series {node.type!r} nests {depth} operator levels deep; "
                    f"the maximum is {MAX_SERIES_NESTING} (each transform counts one level; "
                    f"binary_op/unary_op/shift are free). Flatten or split the expression."
                )
        return self


# ---- model_rebuild for forward refs ----------------------------------------

# Series nodes that carry a forward ``Series`` ref (input / left / right).
EMA.model_rebuild()
ZScore.model_rebuild()
Percentile.model_rebuild()
RollingAgg.model_rebuild()
Drawdown.model_rebuild()
Runup.model_rebuild()
BarsSinceExtremum.model_rebuild()
Change.model_rebuild()
Shift.model_rebuild()
RollingCorr.model_rebuild()
CrossRank.model_rebuild()
CrossDemean.model_rebuild()
CrossAgg.model_rebuild()
BinaryOp.model_rebuild()
UnaryOp.model_rebuild()
ThresholdCondition.model_rebuild()
AndCondition.model_rebuild()
OrCondition.model_rebuild()
NotCondition.model_rebuild()
RollingCondition.model_rebuild()
FirstTrueCondition.model_rebuild()
BacktestParams.model_rebuild()  # carries the Series forward ref via `features`
Thesis.model_rebuild()
