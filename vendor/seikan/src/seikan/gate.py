"""The per-cell checklist — a completeness/support/concentration result about one engine summary.

``evaluate_gate`` grades EVERY declared parameter × horizon cell INDEPENDENTLY and reports each
check (``{name, passed, observed, threshold, detail}``). There is no short-circuit and
no scalar verdict: a caller sees the complete checklist for every cell, exactly as it sees the
complete grid — the gate renders a per-cell result about the summary, it NEVER filters it.

The checks read the engine summary directly (the dict ``compile_thesis`` produces). The
``POLICY_VERSION`` contract:

- **The checklist is NON-INFERENTIAL.** A cell's ``passed`` makes NO significance claim and
  certifies NO positive expected return. It says exactly this much: the cell's evidence is
  completely measured (every firing accounted for, every decision bar decidable, every raw
  decision input available), it clears the raw support floors on full-sample evidence, and its
  return mass is not one episode. Nothing here is a test — the nominal per-cell statistics
  (``rot_p``, ``t_hac``, ``hac_se``, ``pbo``, ``sharpe``, ``t_iid``/``p_iid``, the episode and
  bucket panels) ride along as EVIDENCE and no check reads them.
- **One stamp selects between two rubrics.** The summary's ``target_mode`` stamp names the
  target semantics every cross-target read is graded under: ``conjunction`` (targets are the
  thesis's regime — per-target floors and ceilings, the weakest target decides) or
  ``basket`` (the members form ONE evidence pool — ``support`` reads the
  pooled floors, ``concentration`` reads the pooled top share plus the episode-cluster and
  member-mass ceilings, ``cell_evidence`` reconciles the pooled panel against the member
  panels). A missing or unreadable stamp refuses fail-closed everywhere it would have
  dispatched — grading under an assumed mode is the stamp-stripping bypass one field over. The
  coverage contracts stay per-target in BOTH modes: a hole in one member corrupts every
  member's cross-sectional reads, so per-member fail-closed is structurally required even in a
  basket.
- **Selection and multiplicity belong to the CALLER.** The engine measures and reports; it does
  not select, rank, or crown a winner. Cross-cell multiplicity is the caller's to price against
  the stamped ``n_hypotheses_attempted`` (which ``search_cap`` bounds), and cross-RUN search
  discipline is beyond a stateless verifier entirely — the identity layer (``dsl_hash``,
  ``data_digests``) makes each distinct exam visible so the caller can price it.
- **The missingness contract fails closed, on BOTH sides.** ``outcome_coverage`` reads each
  cell's per-target censoring ledger and refuses any ``no_outcome``/``no_benchmark`` firing — a
  data hole that deletes outcomes (a vendor outage, a stale feed, an adversarial file) can hide
  adverse results, so a graded cell must be completely measured. ``signal_coverage`` closes the
  same hole on the DECISION side: the outcome ledger can only account for bars that FIRED, so a
  missing input that suppresses a firing leaves no trace there — the runner's three-valued ledger
  counts post-warmup UNDECIDABLE decision bars and any of them refuses. The run-level
  ``source_coverage`` closes what the root three-valued channel structurally cannot see (Kleene
  absorption, a NaN-skipping recursive kernel laundering contaminated state into a finite value)
  by counting availability of the RAW decision leaves. Together: deleting data can only ever
  REFUSE.
- **Right-censoring at the data end is structural and ALLOWED.** With no holdout there is no
  embargo and no tail, so a trailing window running past the last bar is geometry, not a hole:
  ``open`` firings are legitimate everywhere. In-bounds NaN legs remain
  ``no_outcome``/``no_benchmark`` and still refuse.
- **Structural discipline is universal**: one concentration ceiling over every regime target's
  |return|-mass top share AND the cell's largest merged cross-target episode cluster (a
  one-episode "edge" refuses), and one cap on the DECLARED grid (``n_hypotheses_attempted`` —
  non-firing combos cannot shrink it).
- **The evidence contract is stamped and verified.** ``evidence_complete`` requires the summary's
  ``statistics_version`` to equal this build's, ``gate_evidence_basis == "full_sample"``, an
  EXPLICIT ``outcome`` stamp — the ``{series, kind}`` dict the runner always
  writes; a null stamp refuses — string-typed
  targets and panel keys, and a ``cells`` panel holding EXACTLY the declared grid — a report
  missing declared cells is drifted input, not evidence. Per cell, ``cell_evidence`` additionally
  requires the panels to AGREE: the graded ``n`` equals the ledger's closed count, ``n_eff <= n``,
  the episode panel's ``n`` is the per-target total, and the signal ledger spans the whole index.
  An internally impossible summary is drifted input, not something to grade.
- **Strict numeric hygiene**: every read collapses NaN, ±inf, and non-integral counts to a
  refusal — drifted input can never sail past a comparison or crash the gate.
- **Commensurability guard**: a ``diff``-outcome, multi-target run refuses the cross-target
  cluster-mass read — level-unit returns from different series cannot be mass-compared.
- **Fail closed, never crash.** An unreadable ``cells`` panel fails ``evidence_complete`` and
  yields zero graded cells; a malformed individual cell entry gets a failing ``cell_evidence``
  while its siblings grade normally. Drifted input refuses with a detail; it never raises.

``canonical_dsl_hash`` is the identity discipline: sha256 over the defaults-filled, key-sorted
DSL, so omitted defaults and explicit-default forms hash identically and a report is bound to
exactly the rules it validated.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import SupportsFloat, cast

from seikan.analysis.stats import STATISTICS_VERSION
from seikan.dsl.schema import Thesis as DslThesis

# Re-exported EXPLICITLY (the redundant-looking `as` is PEP 484's export form). ``evaluate_gate``'s
# own signature takes a ``GateThresholds``, so ``from seikan.gate import evaluate_gate,
# GateThresholds`` is the natural call site — and this package ships ``py.typed``, so under a
# downstream ``--strict`` an implicit re-export is invisible and that import fails to type-check
# while working perfectly at runtime. Naming the export is what makes the two agree.
from seikan.settings import GateThresholds as GateThresholds
from seikan.types import (
    DslDocument,
    GateCellDict,
    GateCheckDict,
    GateSection,
    JsonValue,
    TargetMode,
)

#: The gate-policy version stamped into every report. Bumped whenever a check's SEMANTICS change
#: (new check, changed branch logic, changed default meaning), so two results are comparable only
#: when their policy versions match. It names the CHECKLIST semantics — ``seikan_version`` names
#: the package and ``analysis.STATISTICS_VERSION`` the estimators the checklist reads.
POLICY_VERSION = 1


def canonical_dsl_hash(dsl: DslDocument) -> str:
    """sha256 over the *normalized* thesis DSL (defaults filled, keys sorted).

    Normalizing through the ``Thesis`` model makes the hash insensitive to key order / omitted
    defaults, so two spellings of the same rules share one identity. Raises (pydantic
    ``ValidationError``) on an invalid DSL.
    """
    normalized = DslThesis.model_validate(dsl).model_dump(mode="json")
    # allow_nan=False is a backstop: the schema already rejects non-finite numbers, and a hash
    # over the invalid-JSON tokens `NaN`/`Infinity` would name an identity no strict parser
    # could reconstruct.
    payload = json.dumps(normalized, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class GateCheck:
    name: str
    passed: bool
    #: What the check READ, echoed as it was found — an ``object``, because a drifted summary may
    #: carry anything under the key a check looked at, and reporting it verbatim is how a refusal
    #: says what it saw.
    observed: object
    #: What the check REQUIRED — a sealed knob's value or the checklist's own sentence. This side
    #: is written BY the gate and never echoed, so it is JSON by construction.
    threshold: JsonValue
    detail: str

    def to_dict(self) -> GateCheckDict:
        return {
            "name": self.name,
            "passed": self.passed,
            "observed": self.observed,
            "threshold": self.threshold,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class CellReport:
    """One declared parameter × horizon cell's complete checklist result.

    ``passed`` is the conjunction of this cell's own checks AND every run-level check, so a
    caller reading ``cells[i].passed`` gets the complete answer without ANDing sections itself.
    ``cell_id`` and ``params`` mirror the summary cell they grade; identity is the params plus
    the position in the panel, never the rendered label.
    """

    cell_id: str
    params: dict[str, JsonValue]
    passed: bool
    checks: list[GateCheck]

    def to_dict(self) -> GateCellDict:
        return {
            "cell_id": self.cell_id,
            "params": self.params,
            "passed": self.passed,
            "checks": [c.to_dict() for c in self.checks],
        }


@dataclass
class GateReport:
    """The whole gate section: the run-level checks once, then every graded cell in panel order.

    There is no scalar verdict. ``n_passed`` counts cells whose ``passed`` is True — a number the
    caller reads alongside ``n_cells`` and ``n_hypotheses_attempted`` when it prices its own
    selection.
    """

    run_checks: list[GateCheck]
    cells: list[CellReport]

    def to_dict(self) -> GateSection:
        return {
            "policy_version": POLICY_VERSION,
            "n_cells": len(self.cells),
            "n_passed": sum(1 for c in self.cells if c.passed),
            "run_checks": [c.to_dict() for c in self.run_checks],
            "cells": [c.to_dict() for c in self.cells],
        }


def _num(value: object) -> float | None:
    """float(value), with None/NaN/±inf/garbage collapsed to None (a NaN would sail past
    comparisons and an inf would sail THROUGH them; drifted non-finite input must produce a
    refusal, never a crash or a certified impossibility)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        # The conversion is duck-typed BY DESIGN — the ``except`` below IS the contract for
        # everything that does not convert (a dict, a list, a non-numeric string), which is why
        # the parameter is an untrusted ``object``. The cast states that intent to the checker;
        # nothing about it changes what a non-convertible value does here.
        v = float(cast("SupportsFloat", value))
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _int(value: object) -> int | None:
    """The integer twin of :func:`_num` — None on missing/non-finite/garbage/NON-INTEGRAL input.
    A count of 1.9 is drifted input, not "1": truncation would certify a search size the summary
    never actually recorded."""
    v = _num(value)
    if v is None:
        return None
    try:
        if v != int(v):
            return None
        return int(v)
    except (OverflowError, ValueError):  # _num already blocks inf; belt-and-braces
        return None


def _prob(value: object) -> float | None:
    """The probability twin of :func:`_num` — additionally None outside [0, 1]. A p-value or
    mass share of 1.5 is drifted input, not a number to compare."""
    v = _num(value)
    if v is None or not (0.0 <= v <= 1.0):
        return None
    return v


def _targets(s: Mapping[str, object]) -> list[str] | None:
    """The summary's target list, or None when it is missing/empty/not all strings.

    Target names index every panel and are ``sorted()`` in half a dozen places to build stable
    ``observed`` payloads and set differences. A drifted summary carrying a non-string name
    (``["AAA", 3]``) would raise ``TypeError`` inside the comparison — a CRASH, when the
    contract is that drifted input refuses with a detail. Type-checking once, here, keeps every
    downstream sort total."""
    t = s.get("targets")
    if not isinstance(t, (list, tuple)) or not t:
        return None
    if not all(isinstance(x, str) for x in t):
        return None
    return list(t)


#: The two target semantics a summary may stamp (the runner writes ``target_mode`` on every
#: run) — the ONLY values that select a rubric.
_TARGET_MODES: tuple[TargetMode, ...] = ("conjunction", "basket")


def _mode(s: Mapping[str, object]) -> TargetMode | None:
    """The summary's ``target_mode`` stamp, or None unless it is EXACTLY one of the two rubric
    names.

    The stamp SELECTS how cross-target evidence is graded (conjunction: the weakest target
    decides; basket: the pooled panel is graded), so a missing or garbage stamp is never a
    default — it is an unanswerable question, and every check that dispatches on it refuses
    fail-closed (the outcome-stamp precedent: an assumed mode is the stamp-stripping bypass one
    field over)."""
    m = s.get("target_mode")
    return m if m in _TARGET_MODES else None


def _str_keyed(value: object) -> dict[str, object] | None:
    """A per-target/per-source panel dict, or None unless every key is a string (same total-order
    discipline as :func:`_targets` — panel keys are sorted just as often)."""
    if not isinstance(value, dict):
        return None
    if not all(isinstance(k, str) for k in value):
        return None
    return value


#: The complete exit-reason vocabulary of the runner's censoring ledger — the fixed shape both
#: ledger readers (cell_evidence's arithmetic, outcome_coverage's semantics) verify against.
_EXIT_REASONS = ("horizon", "open", "no_outcome", "no_benchmark")

#: The measurement algebras a summary may declare (``analysis`` stamps ``outcome.kind``).
_OUTCOME_KINDS = ("pct", "log", "diff")


def _incommensurable_pool(s: Mapping[str, object]) -> tuple[bool, str]:
    """``(incommensurable, reason)`` for the summary's pooled CROSS-TARGET mass reads.

    A ``diff`` outcome measures each target in its OWN level units (bp, index points, ratio
    turns), so cluster means and |return|-mass shares across several targets compare
    incomparables — a high-scale target dominates every pooled read. pct/log are commensurable.

    Fails CLOSED on an unreadable stamp. The runner ALWAYS writes the explicit ``outcome`` dict,
    so a multi-target summary that arrives without it, with ``None``, or with a kind outside the
    vocabulary is drifted input. Reading an absent stamp as "commensurable" would let STRIPPING
    it bypass this guard entirely, and accepting a null is the same bypass one spelling over."""
    targets = s.get("targets")
    multi = isinstance(targets, (list, tuple)) and len(targets) > 1
    if not multi:
        return False, ""
    if "outcome" not in s:
        return True, (
            "summary carries no outcome stamp — the measurement algebra is unrecorded, so "
            "cross-target |return|-mass shares cannot be certified commensurable; drifted input"
        )
    outcome = s.get("outcome")
    kind = outcome.get("kind") if isinstance(outcome, dict) else None
    if kind not in _OUTCOME_KINDS:
        return True, (
            f"outcome stamp is unreadable ({outcome!r} — kind not in {list(_OUTCOME_KINDS)}); "
            "a null stamp is stripped input, and the measurement algebra "
            "is unverifiable either way; drifted input"
        )
    if kind == "diff":
        return True, (
            "outcome kind='diff' across multiple targets — cross-target |return|-mass shares "
            "mix incomparable level units; run per-target or use a pct/log outcome"
        )
    return False, ""


# --------------------------------------------------------------------------------------------
# Run-level checks — reported once, and a failure here fails EVERY cell (the run's evidence is
# the ground every per-cell read stands on).
# --------------------------------------------------------------------------------------------


def _check_evidence_complete(s: Mapping[str, object], t: GateThresholds) -> GateCheck:
    """The summary must carry the evidence the rest of the checklist grades, under the contract
    this gate was built against: the version stamps must match (``statistics_version`` == this
    build's, ``gate_evidence_basis == "full_sample"`` — a summary from a different estimator
    revision refuses rather than being graded by the wrong rubric), the target list must be a
    non-empty list of STRINGS (a non-string name indexes no panel), the ``outcome`` stamp — the
    algebra every reported number is denominated in — must be the explicit ``{series, kind}``
    dict the runner always writes (a null stamp is stripped input and refuses), the
    ``target_mode`` stamp must be one of the two rubric names —
    "conjunction" or "basket" — because it selects the rubric every cross-target read is graded
    under (a missing or garbage stamp refuses fail-closed, and a basket stamp over fewer than
    two targets or a ``diff`` outcome refuses as drifted input: validation refuses both
    upstream, and the gate re-refuses rather than trusts), the geometry
    (``n_bars``) and the declared grid (``n_hypotheses_attempted``) must be countable and at
    least one, the per-target ``sources`` panel must be string-keyed and cover the regime
    EXACTLY, and ``cells`` must be a list holding EXACTLY the declared grid. That last one is the
    honesty invariant of this identity: the panel carries one entry per declared combo × horizon
    INCLUDING those that never fired, so a report short of ``n_hypotheses_attempted`` cells has
    silently dropped hypotheses from the record and is drifted input, not evidence."""
    targets = _targets(s)
    mode = _mode(s)
    stats_v = s.get("statistics_version")
    basis = s.get("gate_evidence_basis")
    outcome = s.get("outcome")
    n_att = _int(s.get("n_hypotheses_attempted"))
    n_bars = _int(s.get("n_bars"))
    cells = s.get("cells")
    src = _str_keyed(s.get("sources"))
    threshold = (
        f"statistics_version=={STATISTICS_VERSION}; gate_evidence_basis==full_sample; "
        "targets a non-empty list of strings; outcome an explicit {series, kind} dict with a "
        "string series and kind in {pct,log,diff} (null refuses); "
        "target_mode in {conjunction,basket} — the stamp selects the rubric, a missing or "
        "garbage stamp refuses, and basket requires >=2 targets and a non-diff outcome "
        "(refused at validation upstream; the gate re-refuses, never trusts); "
        "n_hypotheses_attempted>=1; n_bars>=1; sources string-keyed and covering targets "
        "exactly; cells a list with len(cells)==n_hypotheses_attempted (every declared cell on "
        "the record, non-firing combos included)"
    )
    fails: list[str] = []
    if stats_v != STATISTICS_VERSION:
        fails.append(
            f"statistics_version={stats_v!r} does not match this gate's expected "
            f"{STATISTICS_VERSION} — the summary was produced by a different estimator revision "
            "and cannot be graded by this checklist; re-run the engine"
        )
    if basis != "full_sample":
        fails.append(
            f"gate_evidence_basis={basis!r} — every cell is graded on full-sample evidence; a "
            "summary describing any other basis was produced under a different contract"
        )
    if targets is None:
        fails.append(
            "summary lacks a usable target list — targets must be a non-empty list of strings "
            "(a non-string name indexes no panel and cannot be verified); drifted input"
        )
    if "outcome" not in s:
        fails.append(
            "summary carries no outcome stamp — the declared measurement algebra is what every "
            "reported claim is denominated in, so an unstamped summary cannot be graded"
        )
    elif (
        not isinstance(outcome, dict)
        or outcome.get("kind") not in _OUTCOME_KINDS
        or not isinstance(outcome.get("series"), str)
        or not outcome.get("series")
    ):
        fails.append(
            f"outcome stamp is unreadable ({s.get('outcome')!r}) — must be the explicit dict "
            "the runner always stamps ({series, kind} with a non-empty string series and kind "
            f"in {list(_OUTCOME_KINDS)}); a null or partial stamp is stripped input, and "
            "both refuse; drifted input"
        )
    if mode is None:
        fails.append(
            f"target_mode stamp missing or unreadable ({s.get('target_mode')!r} — not in "
            f"{list(_TARGET_MODES)}) — the stamp SELECTS the rubric (conjunction: the weakest "
            "target decides; basket: the pooled panel is graded), so an unstamped summary "
            "cannot be graded under an assumed mode; drifted input"
        )
    elif mode == "basket":
        if targets is not None and len(targets) < 2:
            fails.append(
                f"target_mode='basket' with {len(targets)} target(s) — a basket of one is "
                "degenerate and refused at validation; a summary carrying it is drifted input"
            )
        if isinstance(outcome, dict) and outcome.get("kind") == "diff":
            fails.append(
                "target_mode='basket' with outcome kind='diff' — pooled level-unit returns "
                "have no common unit the engine can certify, and the combination is refused "
                "at validation; a summary carrying it is drifted input"
            )
    # Deliberately NOT collapsed into `elif mode == "conjunction" and s.get(...)` (ruff SIM102):
    # `TargetMode` holds exactly two values, so after the two arms above a type checker proves the
    # mode test always true and reports the collapsed form as a redundant expression. The arm has
    # to keep NAMING its mode all the same — an `else` would hand this conjunction-specific
    # refusal to any third mode added later, which is the ambient coupling this file exists to
    # refuse.
    elif mode == "conjunction":  # noqa: SIM102
        # The mirror of the basket-side re-refusals: validation mode-gates cross_mean exactly
        # like basket+diff, so a conjunction-stamped summary claiming it can only be a
        # restamped basket — and restamping is precisely the one-field tamper that would
        # otherwise swap the pooled rubric for the per-target one it was refused under.
        if s.get("benchmark") == "cross_mean":
            fails.append(
                "target_mode='conjunction' with benchmark='cross_mean' — the cross-target "
                "mean couples targets in the outcome, which conjunction forbids and "
                "validation refuses; a summary carrying both is a restamped basket; "
                "drifted input"
            )
    if n_att is None:
        fails.append(
            "summary carries no countable n_hypotheses_attempted — the declared grid size is "
            "unrecorded, so cross-cell multiplicity cannot be priced"
        )
    elif n_att < 1:
        fails.append(
            f"n_hypotheses_attempted={n_att} — a run that declared no hypothesis measured "
            "nothing; drifted summary input"
        )
    if n_bars is None:
        fails.append(
            "summary carries no countable n_bars — the joined index length is the denominator "
            "every coverage read is verified against; drifted input"
        )
    elif n_bars < 1:
        fails.append(f"n_bars={n_bars} — an empty index measures nothing; drifted summary input")
    if isinstance(s.get("sources"), dict) and src is None:
        fails.append(
            "sources is keyed by a non-string target name — it indexes no regime target; "
            "drifted input"
        )
    if not isinstance(s.get("sources"), dict):
        fails.append(
            "summary lacks a sources panel — without per-source availability, decision inputs "
            "suppressed at the source cannot be ruled out"
        )
    elif src is not None and targets and set(src) != set(targets):
        missing = sorted(set(targets) - set(src))
        extra = sorted(set(src) - set(targets))
        fails.append(
            f"sources does not cover the regime exactly (missing={missing}, unexpected={extra})"
        )
    if not isinstance(cells, list):
        fails.append(
            f"summary carries no cells panel (cells={type(cells).__name__}) — the per-cell "
            "record IS the report under this policy; drifted input"
        )
    elif n_att is not None and len(cells) != n_att:
        fails.append(
            f"cells holds {len(cells)} entr(ies) but n_hypotheses_attempted={n_att} — every "
            "declared combo × horizon must be on the record, non-firing ones included; a report "
            "missing declared cells has dropped hypotheses from the search burden it declares"
        )
    observed = {
        "statistics_version": stats_v,
        "gate_evidence_basis": basis,
        "target_mode": s.get("target_mode"),
        "targets": sorted(targets) if targets else None,
        "sources_covered": sorted(src) if src else None,
        "n_hypotheses_attempted": n_att,
        "n_bars": n_bars,
        "n_cells": len(cells) if isinstance(cells, list) else None,
    }
    return GateCheck(
        name="evidence_complete",
        passed=not fails,
        observed=observed,
        threshold=threshold,
        detail=(
            "stamps match and the summary carries every declared cell with its geometry and "
            "source panels"
            if not fails
            else "; ".join(fails)
        ),
    )


def _check_source_coverage(s: Mapping[str, object], t: GateThresholds) -> GateCheck:
    """Fail-closed availability contract over the RAW decision inputs — run-level because it is
    combo-independent: the entry tree's leaves (``Field``/``External``/``DaysSince``) either had
    data on a bar or they did not, whichever parameters read them.

    This is the layer the per-cell three-valued ``signal_coverage`` ledger structurally cannot
    see. Two ways a hole reaches a decision while the root condition reads perfectly DEFINED:

    - **Kleene absorption.** ``and``/``or`` recover a verdict from a decisive child (``F∧U = F``,
      ``T∨U = T``), so a hole in one operand leaves the root fully decided. The bar is decided;
      what is missing is whether it would have decided the SAME WAY with the data present.
    - **Recursive kernels launder state.** ``ema``/``zscore_ema``/expanding aggregates/
      ``bars_since_extremum`` SKIP NaNs and carry their running state across a hole, then emit a
      finite value on the next bar. Definedness is minted at the threshold comparison from
      operand finiteness, so the contaminated value reads as perfectly decided.

    Counting availability at the source puts no operator between the hole and the count. A source
    that merely STARTS LATE is warmup, not a hole (its ``first_available`` is reported as
    evidence) — the observer had nothing to read yet, exactly as a transform's warmup window is
    not a hole. ``n_bars`` is pure geometry (the joined index length), so ``n_missing <= n_bars``
    and "the union cannot outnumber its parts" are verifiable arithmetic no property of the data
    can bend. Unconditional: there is no threshold knob for how much of the thesis may be
    unevaluable."""
    threshold = (
        "per target: sources.n_missing == 0 — every raw decision input the entry tree reads is "
        "available on every bar of the evaluated interval after its own first available bar (a "
        "series that merely starts late is warmup) — with sources.n_bars == summary.n_bars, "
        "every per-source count in 0..n_bars, and the union no larger than the sum of parts. "
        "Unconditional; no knob"
    )
    targets = _targets(s)
    tset = set(targets) if targets else None
    sources = _str_keyed(s.get("sources")) or {}
    run_bars = _int(s.get("n_bars"))
    fails: list[str] = []
    if tset is None:
        fails.append(
            "summary lacks a usable target list (non-empty, all strings) — source coverage "
            "cannot be verified"
        )
    elif not sources:
        fails.append(
            "summary lacks a sources panel — without per-source availability, firings "
            "suppressed by a hole under the decision inputs cannot be ruled out"
        )
    if run_bars is None:
        fails.append(
            "summary carries no countable n_bars — the geometry every availability count is "
            "verified against is unrecorded; drifted input"
        )
    by_target: dict[str, dict[str, object] | None] = {}
    observed: dict[str, object] = {"n_bars": run_bars, "by_target": by_target}
    for tgt in sorted(tset or set(sources)):
        entry = sources.get(tgt)
        entry = entry if isinstance(entry, dict) else None
        if entry is None:
            fails.append(
                f"{tgt}: no per-source availability entry — decision inputs suppressed at the "
                "source cannot be ruled out for this target"
            )
            by_target[tgt] = None
            continue
        s_bars = _int(entry.get("n_bars"))
        s_missing = _int(entry.get("n_missing"))
        by_source = _str_keyed(entry.get("by_source"))
        per_by_source: dict[str, dict[str, object]] = {}
        per: dict[str, object] = {
            "n_bars": s_bars,
            "n_missing": s_missing,
            "by_source": per_by_source,
        }
        by_target[tgt] = per
        if by_source is None:
            fails.append(
                f"{tgt}.sources: by_source is missing or keyed by a non-string source name — "
                "drifted input"
            )
        if s_bars is None or s_bars < 0 or s_missing is None or s_missing < 0:
            fails.append(
                f"{tgt}.sources: uncountable or negative availability counts — drifted input"
            )
            continue
        if run_bars is not None and s_bars != run_bars:
            fails.append(
                f"{tgt}.sources: n_bars={s_bars} != the summary's n_bars={run_bars} — the "
                "availability panel spans a different interval than the run; drifted input"
            )
        if s_missing > s_bars:
            fails.append(
                f"{tgt}.sources: n_missing={s_missing} exceeds the interval's n_bars={s_bars} — "
                "drifted input"
            )
        per_source_total = 0
        leaves = by_source or {}
        for label in sorted(leaves):
            leaf = leaves[label]
            leaf = leaf if isinstance(leaf, dict) else {}
            n_miss = _int(leaf.get("n_missing"))
            per_by_source[label] = {
                "n_missing": n_miss,
                "first_available": leaf.get("first_available"),
            }
            if n_miss is None or n_miss < 0 or n_miss > s_bars:
                fails.append(
                    f"{tgt}.sources[{label}]: n_missing is not a count within 0..{s_bars} — "
                    "drifted input"
                )
                continue
            per_source_total += n_miss
            if n_miss > 0:
                fails.append(
                    f"{tgt}: decision input {label} is missing on {n_miss} of {s_bars} bar(s) "
                    "of the evaluated interval — a hole under the decision inputs suppresses "
                    "firings (and can survive a decisive sibling or a NaN-skipping transform), "
                    "so adverse firings may have been deleted; repair the series or exclude "
                    "the region with data.start / data.end"
                )
        if by_source is not None and s_missing > per_source_total:
            fails.append(
                f"{tgt}.sources: n_missing={s_missing} exceeds the per-source total "
                f"{per_source_total} — the union cannot outnumber its parts; drifted input"
            )
    return GateCheck(
        "source_coverage", not fails, observed, threshold,
        "every raw decision input is available across the evaluated interval (warmup excluded), "
        "so no firing was suppressed by a missing input"
        if not fails
        else "; ".join(fails),
    )


def _check_search_cap(s: Mapping[str, object], t: GateThresholds) -> GateCheck:
    """Universal structural cap on the DECLARED grid (``n_hypotheses_attempted`` ≤ cap). The
    attempted count is the honest search burden — every declared combo × horizon, whether or not
    it fired — and it is the ONLY multiplicity input this policy carries: the gate grades cells
    independently and takes no cross-cell correction, so the caller prices its own selection
    against this number. The cap bounds how much single-run mining can be declared at all.
    Non-optional by construction."""
    cap = int(t.thesis_max_hypotheses)
    n_att = _int(s.get("n_hypotheses_attempted"))
    if n_att is None:
        return GateCheck(
            "search_cap", False, None, cap,
            "summary carries no countable n_hypotheses_attempted — the declared grid size "
            "cannot be certified",
        )
    ok = n_att <= cap
    return GateCheck(
        "search_cap", ok, n_att, cap,
        "declared search grid within the cap"
        if ok
        else f"n_hypotheses_attempted={n_att} exceeds the search cap {cap} — narrow the "
        "declared sweep (the cap is structural: non-firing combos cannot shrink it)",
    )


_RUN_CHECKS = (
    _check_evidence_complete,
    _check_source_coverage,
    _check_search_cap,
)


# --------------------------------------------------------------------------------------------
# Per-cell checks — each declared parameter × horizon cell is graded ALONE, on its own rows. No
# check reads another cell, and nothing is ever summed across cells.
# --------------------------------------------------------------------------------------------


def _cell_panels(
    cell: Mapping[str, object],
) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    """``(by_target, outcome_coverage, signal_coverage)`` as string-keyed dicts, empty when
    unreadable — the shared reader every per-cell check uses, so a malformed panel produces the
    same refusal in each of them instead of a different exception in one."""
    return (
        _str_keyed(cell.get("by_target")) or {},
        _str_keyed(cell.get("outcome_coverage")) or {},
        _str_keyed(cell.get("signal_coverage")) or {},
    )


def _check_cell_evidence(cell: object, s: Mapping[str, object], t: GateThresholds) -> GateCheck:
    """The cell must carry the evidence its own checks grade, and its panels must AGREE.

    Shape: the entry is a dict with a dict ``params`` (the cell's identity — axes plus the
    horizon, always present), and its three per-target panels (``by_target``,
    ``outcome_coverage``, ``signal_coverage``) are string-keyed and cover the regime EXACTLY (a
    silently dropped target must fail here, not pass by absence).

    Arithmetic: every count is countable and non-negative, the exit reasons sum to the pool's
    ``n_attempted``, and ``n_closed == exit_reasons["horizon"]`` — a ledger anyone can re-check.

    Reconciliation: the panels describe the SAME rows, so ``support`` reading ``by_target[t].n``
    and ``outcome_coverage`` counting the closed firings that produced it must agree; ``n_eff <=
    n`` (independent episodes cannot outnumber observations); the cell's ``episode_stats.n`` is
    the per-target total (the concentration panel and the support panel must describe one pool);
    and ``signal_coverage[t].n_bars`` is the run's ``n_bars`` (the decision ledger spans the whole
    index — pure geometry, not a property of the data). A summary claiming 42 observations over a
    ledger holding one is internally impossible, and an impossible summary is drifted input, not
    something to grade.

    Basket cells (``target_mode == "basket"``) additionally carry the ``pooled`` cross-target
    panel their own ``support``/``concentration`` reads grade, and it must reconcile with the
    member panels: ``pooled.n == sum of by_target.n`` (one pool, fully attributed),
    ``pooled.n_eff <= pooled.n``, ``pooled.n_eff <= n_bars`` (the greedy non-overlapping count
    collapses same-bar cross-member firings, so it is bounded by the bar clock), and
    ``pooled.n <= n_bars × len(targets)`` (each member fires at most once per bar). Conjunction
    cells are graded by the per-target rules — and a ``pooled`` key under a conjunction stamp
    REFUSES, because the runner writes pooled only in basket mode: the configuration is the
    signature of a restamped basket, and refusing it costs zero honest refusals. A missing or
    unreadable ``target_mode`` stamp refuses: whether a pooled panel is part of the cell's
    evidence contract is then undeterminable."""
    run_bars = _int(s.get("n_bars"))
    mode = _mode(s)
    threshold = (
        "cell is a dict with dict params; by_target, outcome_coverage and signal_coverage "
        "string-keyed and covering summary targets exactly; all counts countable and "
        "non-negative; per target sum(exit_reasons)==n_attempted and n_closed==exit_reasons"
        "[horizon]; panels reconcile (by_target.n==outcome_coverage.n_closed, n_eff<=n, "
        "episode_stats.n==sum of by_target.n, signal_coverage.n_bars==summary.n_bars); "
        "target_mode readable (the stamp says whether a pooled panel is part of the cell's "
        "contract); basket cells additionally carry a pooled dict that reconciles "
        "(pooled.n==sum of by_target.n, pooled.n_eff<=pooled.n, pooled.n_eff<=n_bars, "
        "pooled.n<=n_bars×len(targets)); a pooled key on a conjunction cell refuses (a "
        "restamped basket)"
    )
    fails: list[str] = []
    by_target_n: dict[str, int | None] = {}
    observed: dict[str, object] = {
        "params": None,
        "by_target_n": by_target_n,
        "episode_stats_n": None,
    }
    if not isinstance(cell, dict):
        return GateCheck(
            "cell_evidence", False, {"type": type(cell).__name__}, threshold,
            f"cell entry is not a dict ({type(cell).__name__}) — the per-cell record is "
            "unreadable; drifted input",
        )
    params = cell.get("params")
    if not isinstance(params, dict):
        fails.append(
            f"params is not a dict ({type(params).__name__}) — the cell does not name the "
            "parameter assignment it measured; drifted input"
        )
    else:
        observed["params"] = params
    targets = _targets(s)
    tset = set(targets) if targets else None
    by_tgt, cov, sig = _cell_panels(cell)
    if tset is None:
        fails.append(
            "summary lacks a usable target list (non-empty, all strings) — the cell's panels "
            "cannot be verified against a regime"
        )
    if mode is None:
        fails.append(
            "summary carries no readable target_mode stamp — whether this cell's evidence "
            "contract includes a pooled panel is undeterminable, so the cell cannot be "
            "verified against either rubric; drifted input"
        )
    for pname, raw, panel in (
        ("by_target", cell.get("by_target"), by_tgt),
        ("outcome_coverage", cell.get("outcome_coverage"), cov),
        ("signal_coverage", cell.get("signal_coverage"), sig),
    ):
        if not isinstance(raw, dict):
            fails.append(
                f"cell lacks a {pname} panel ({type(raw).__name__}) — the cell's evidence is "
                "incomplete; drifted input"
            )
            continue
        if _str_keyed(raw) is None:
            fails.append(
                f"{pname} is keyed by a non-string target name — it indexes no regime target; "
                "drifted input"
            )
            continue
        if tset is not None and set(panel) != tset:
            missing = sorted(tset - set(panel))
            extra = sorted(set(panel) - tset)
            fails.append(
                f"{pname} does not cover the regime exactly "
                f"(missing={missing}, unexpected={extra})"
            )
    # Ledger arithmetic, then cross-panel reconciliation, per target. Only the SHAPE is graded
    # here — which reasons may be nonzero is outcome_coverage's semantic read.
    by_target_n_total = 0
    n_total_readable = bool(cov) and bool(by_tgt)
    for tgt in sorted(cov):
        entry = cov.get(tgt)
        entry = entry if isinstance(entry, dict) else {}
        n_att = _int(entry.get("n_attempted"))
        n_closed = _int(entry.get("n_closed"))
        reasons = entry.get("exit_reasons")
        reasons = reasons if isinstance(reasons, dict) else {}
        counts = {k: _int(reasons.get(k)) for k in _EXIT_REASONS}
        unknown = sorted(k for k in reasons if k not in _EXIT_REASONS)
        if unknown:
            # A firing parked under an unrecognized reason is a firing the ledger's arithmetic
            # cannot account for — and its semantics are unknown to every reader downstream.
            fails.append(
                f"outcome_coverage[{tgt}]: unknown exit reason(s) {unknown} outside "
                f"{list(_EXIT_REASONS)} — drifted input"
            )
        if (
            n_att is None or n_att < 0 or n_closed is None or n_closed < 0
            or any(v is None or v < 0 for v in counts.values())
        ):
            fails.append(
                f"outcome_coverage[{tgt}]: uncountable or negative ledger counts — drifted input"
            )
            n_total_readable = False
            continue
        # Past that guard every reason count is a countable, non-negative int — a narrowing the
        # checker cannot carry through a dict's values, so it is stated once here rather than
        # re-tested at each read below.
        ledger = cast("dict[str, int]", counts)
        if sum(ledger.values()) != n_att:
            fails.append(
                f"outcome_coverage[{tgt}]: exit reasons sum to {sum(ledger.values())} but "
                f"n_attempted={n_att} — the ledger does not account for every firing"
            )
        if n_closed != ledger["horizon"]:
            fails.append(
                f"outcome_coverage[{tgt}]: n_closed={n_closed} != horizon count "
                f"{ledger['horizon']} — inconsistent ledger"
            )
        # Index geometry bounds the OUTCOME side exactly as it bounds the decision side
        # (`signal_coverage`'s n_undefined <= n_bars, `sources`' n_missing <= n_bars): a target
        # fires at most once per bar, so the runner writes at most one ledger row per bar per
        # target. Without this, a ledger could claim more firings than the index has bars and
        # still reconcile internally — the counts inflate together, and `n_eff <= n` only gets
        # easier — so the impossibility would sail past every relative check.
        if run_bars is not None and n_att > run_bars:
            fails.append(
                f"outcome_coverage[{tgt}]: n_attempted={n_att} exceeds the index's "
                f"n_bars={run_bars} — a target fires at most once per bar; drifted input"
            )
    for tgt in sorted(by_tgt):
        st = by_tgt.get(tgt)
        st = st if isinstance(st, dict) else {}
        n = _int(st.get("n"))
        n_eff = _int(st.get("n_eff"))
        by_target_n[tgt] = n
        if n is None or n < 0:
            fails.append(f"by_target[{tgt}]: n is not a count — drifted input")
            n_total_readable = False
            continue
        if run_bars is not None and n > run_bars:
            # The same geometric bound the ledger carries, applied where `support` reads. Graded
            # independently so a cell whose panels disagree still cannot claim impossible support.
            fails.append(
                f"by_target[{tgt}]: n={n} exceeds the index's n_bars={run_bars} — a target fires "
                "at most once per bar; drifted input"
            )
        by_target_n_total += n
        if n_eff is None or n_eff < 0:
            fails.append(f"by_target[{tgt}]: n_eff is not a count — drifted input")
        elif n_eff > n:
            fails.append(
                f"by_target[{tgt}]: n_eff={n_eff} exceeds n={n} — independent episodes cannot "
                "outnumber observations; drifted input"
            )
        pool = cov.get(tgt)
        pool = pool if isinstance(pool, dict) else {}
        n_closed = _int(pool.get("n_closed"))
        if n_closed is not None and n != n_closed:
            fails.append(
                f"{tgt}: by_target n={n} but its coverage ledger closed {n_closed} firing(s) — "
                "the panels describe different pools; drifted input"
            )
    for tgt in sorted(sig):
        entry = sig.get(tgt)
        entry = entry if isinstance(entry, dict) else {}
        n_bars = _int(entry.get("n_bars"))
        if n_bars is None or n_bars < 0:
            fails.append(f"signal_coverage[{tgt}]: n_bars is not a count — drifted input")
        elif run_bars is None:
            fails.append(
                f"signal_coverage[{tgt}]: the summary carries no countable n_bars to verify "
                f"n_bars={n_bars} against — drifted input"
            )
        elif n_bars != run_bars:
            fails.append(
                f"signal_coverage[{tgt}]: n_bars={n_bars} != the summary's n_bars={run_bars} — "
                "the decision ledger spans the whole index by construction; drifted input"
            )
    ep = cell.get("episode_stats")
    ep = ep if isinstance(ep, dict) else None
    if ep is None:
        fails.append(
            "cell lacks an episode_stats panel — the cross-target episode-cluster read cannot "
            "be verified; drifted input"
        )
    else:
        ep_n = _int(ep.get("n"))
        observed["episode_stats_n"] = ep_n
        if ep_n is None or ep_n < 0:
            fails.append("episode_stats.n is not a count — drifted input")
        elif n_total_readable and ep_n != by_target_n_total:
            fails.append(
                f"episode_stats.n={ep_n} != the per-target total {by_target_n_total} — the "
                "concentration panel and the support panel describe different pools; drifted "
                "input"
            )
    if mode == "conjunction" and "pooled" in cell:
        # The runner writes `pooled` ONLY in basket mode — absent, not null, on
        # conjunction cells — so a conjunction-stamped cell carrying one is not stray noise but
        # the signature of a RESTAMPED basket: flip the one stamp field on a refused basket run
        # and the pooled rubric (member-mass ceiling, pooled floors) silently swaps for the
        # per-target one it was refused under. Refusing here costs zero honest refusals, since
        # no legitimate summary can exhibit the configuration.
        fails.append(
            "cell carries a pooled panel under a conjunction stamp — the "
            "runner writes pooled only in basket mode (absent, not null, on conjunction "
            "cells), so a conjunction-stamped summary carrying one is a restamped basket; "
            "drifted input"
        )
    if mode == "basket":
        # The pooled panel is what basket `support`/`concentration` grade, so a basket cell
        # without one — or one whose pooled counts contradict the member panels or the bar
        # clock — is drifted input.
        pooled = cell.get("pooled")
        if not isinstance(pooled, dict):
            fails.append(
                f"cell lacks a pooled panel ({type(pooled).__name__}) — basket cells are "
                "graded on the pooled cross-target block, so a basket cell without one "
                "carries no gradable evidence; drifted input"
            )
        else:
            p_n = _int(pooled.get("n"))
            p_eff = _int(pooled.get("n_eff"))
            observed["pooled"] = {"n": p_n, "n_eff": p_eff}
            if p_n is None or p_n < 0:
                fails.append("pooled.n is not a count — drifted input")
            else:
                if n_total_readable and p_n != by_target_n_total:
                    fails.append(
                        f"pooled.n={p_n} != the per-target total {by_target_n_total} — the "
                        "pooled panel and the member panels describe different pools; drifted "
                        "input"
                    )
                if run_bars is not None and targets and p_n > run_bars * len(targets):
                    fails.append(
                        f"pooled.n={p_n} exceeds n_bars × len(targets) = "
                        f"{run_bars * len(targets)} — each member fires at most once per bar; "
                        "drifted input"
                    )
            if p_eff is None or p_eff < 0:
                fails.append("pooled.n_eff is not a count — drifted input")
            else:
                if p_n is not None and p_n >= 0 and p_eff > p_n:
                    fails.append(
                        f"pooled.n_eff={p_eff} exceeds pooled.n={p_n} — independent episodes "
                        "cannot outnumber observations; drifted input"
                    )
                if run_bars is not None and p_eff > run_bars:
                    fails.append(
                        f"pooled.n_eff={p_eff} exceeds the index's n_bars={run_bars} — the "
                        "greedy non-overlapping count collapses same-bar cross-member "
                        "firings, so it is bounded by the bar clock; drifted input"
                    )
    return GateCheck(
        name="cell_evidence",
        passed=not fails,
        observed=observed,
        threshold=threshold,
        detail=(
            "the cell carries every panel for every target and they reconcile"
            if not fails
            else "; ".join(fails)
        ),
    )


def _check_cell_outcome_coverage(
    cell: object, s: Mapping[str, object], t: GateThresholds
) -> GateCheck:
    """Fail-closed missingness contract: no unmeasured firing may sit in a graded cell.

    The engine censors a NaN outcome endpoint (``no_outcome``) or a benchmark hole
    (``no_benchmark``) and every statistic silently skips the row — which is exactly how a vendor
    outage, a stale outcome feed, or an adversarial file could delete adverse outcomes and leave a
    clean-looking cell. This reads the cell's per-target censoring ledger and refuses ANY
    ``no_outcome``/``no_benchmark`` firing (missing-at-random is never assumed).

    ``open`` is ALLOWED. With no holdout there is no embargo and no tail: a firing whose forward
    window runs past the last bar is right-censored by the data's end, which is structural
    geometry every cell near the index end must exhibit. Refusing it would refuse the calendar,
    not a data defect. What it is NOT allowed to hide is an in-bounds hole — those classify as
    ``no_outcome``/``no_benchmark`` upstream and refuse here.

    Reads are independent of every other check (no check relies on another having run); a missing
    or uncountable ledger refuses."""
    threshold = (
        "per target: exit_reasons.no_outcome == 0 and exit_reasons.no_benchmark == 0. "
        "exit_reasons.open is ALLOWED at any count — with no holdout and no embargo, a forward "
        "window running past the data end is structural right-censoring, not a data hole"
    )
    targets = _targets(s)
    tset = set(targets) if targets else None
    cov = _str_keyed(cell.get("outcome_coverage")) or {} if isinstance(cell, dict) else {}
    fails: list[str] = []
    if tset is None:
        fails.append(
            "summary lacks a usable target list (non-empty, all strings) — outcome coverage "
            "cannot be verified"
        )
    elif not cov:
        fails.append(
            "cell lacks outcome_coverage — without the censoring ledger, deleted or unmeasured "
            "outcomes cannot be ruled out"
        )
    elif set(cov) != tset:
        missing = sorted(tset - set(cov))
        extra = sorted(set(cov) - tset)
        fails.append(
            f"outcome_coverage does not cover the regime exactly "
            f"(missing={missing}, unexpected={extra})"
        )
    by_target: dict[str, dict[str, int | None]] = {}
    observed: dict[str, object] = {"by_target": by_target}
    for tgt in sorted(tset or set(cov)):
        entry = cov.get(tgt)
        entry = entry if isinstance(entry, dict) else {}
        reasons = entry.get("exit_reasons")
        reasons = reasons if isinstance(reasons, dict) else {}
        counts = {k: _int(reasons.get(k)) for k in _EXIT_REASONS}
        by_target[tgt] = counts
        bad = sorted(k for k, v in counts.items() if v is None or v < 0)
        if bad:
            fails.append(
                f"{tgt}: uncountable or negative exit-reason counts {bad} — drifted input"
            )
            continue
        # Past the `bad` guard every count is a countable, non-negative int — a narrowing the
        # checker cannot carry through a dict's values, stated once here.
        ledger = cast("dict[str, int]", counts)
        if ledger["no_outcome"] > 0:
            fails.append(
                f"{tgt}: {ledger['no_outcome']} no_outcome firing(s) — an unmeasured outcome "
                "inside a graded cell can hide adverse results (informative missingness); "
                "repair the outcome series"
            )
        if ledger["no_benchmark"] > 0:
            fails.append(
                f"{tgt}: {ledger['no_benchmark']} no_benchmark firing(s) — a benchmark hole "
                "censors observations inside a graded cell; repair the benchmark series"
            )
    return GateCheck(
        "outcome_coverage", not fails, observed, threshold,
        "every firing is either fully measured or right-censored at the data end"
        if not fails
        else "; ".join(fails),
    )


def _check_cell_signal_coverage(
    cell: object, s: Mapping[str, object], t: GateThresholds
) -> GateCheck:
    """Fail-closed UNDEFINED-DECISION contract — the decision-side twin of ``outcome_coverage``.

    ``outcome_coverage`` can only account for bars that FIRED. A missing decision input does not
    censor an outcome; it suppresses the firing itself (a NaN operand compares False), so an
    adverse firing could be deleted by holing its inputs and NO outcome ledger would record the
    suppression — deleting data would improve the result. The engine evaluates conditions
    three-valued and reports, per target, how many post-warmup bars were UNDECIDABLE
    (``init & ~defined``); this check refuses any of them.

    This is the POOLED layer — the root condition's decidability. The raw inputs underneath it are
    graded once, run-level, by ``source_coverage``, which catches the two hole classes this
    channel cannot see: Kleene absorption (a decisive sibling settles the root while an operand is
    holed) and a NaN-skipping recursive kernel laundering state carried across a hole into a
    finite value.

    ``n_bars`` is pure geometry (the joined index length), so ``n_undefined <= n_bars`` is
    verifiable arithmetic no property of the data can bend. Unconditional: there is no threshold
    knob for how much of the thesis may be unevaluable. The ledger is keyed by COMBO upstream, so
    horizon siblings legitimately repeat the same counts — each cell is graded alone and nothing
    is summed across cells."""
    threshold = (
        "per target: n_undefined == 0 (no post-warmup undecidable decision bar) and "
        "n_undefined <= n_bars. Unconditional; no knob"
    )
    targets = _targets(s)
    tset = set(targets) if targets else None
    sig = _str_keyed(cell.get("signal_coverage")) or {} if isinstance(cell, dict) else {}
    fails: list[str] = []
    if tset is None:
        fails.append(
            "summary lacks a usable target list (non-empty, all strings) — signal coverage "
            "cannot be verified"
        )
    elif not sig:
        fails.append(
            "cell lacks signal_coverage — without the undefined-decision ledger, firings "
            "suppressed by missing inputs cannot be ruled out"
        )
    elif set(sig) != tset:
        missing = sorted(tset - set(sig))
        extra = sorted(set(sig) - tset)
        fails.append(
            f"signal_coverage does not cover the regime exactly "
            f"(missing={missing}, unexpected={extra})"
        )
    by_target: dict[str, dict[str, int | None]] = {}
    observed: dict[str, object] = {"by_target": by_target}
    for tgt in sorted(tset or set(sig)):
        entry = sig.get(tgt)
        entry = entry if isinstance(entry, dict) else {}
        n_bars = _int(entry.get("n_bars"))
        n_undef = _int(entry.get("n_undefined"))
        by_target[tgt] = {"n_bars": n_bars, "n_undefined": n_undef}
        if n_bars is None or n_bars < 0 or n_undef is None or n_undef < 0:
            fails.append(f"{tgt}: uncountable or negative signal-coverage counts — drifted input")
            continue
        if n_undef > n_bars:
            fails.append(
                f"{tgt}: n_undefined={n_undef} exceeds n_bars={n_bars} — drifted input"
            )
        elif n_undef > 0:
            fails.append(
                f"{tgt}: {n_undef} undecidable decision bar(s) of {n_bars} — a missing input "
                "suppresses firings before any outcome ledger can see them, so adverse firings "
                "may have been deleted; repair the decision series"
            )
    return GateCheck(
        "signal_coverage", not fails, observed, threshold,
        "every decision bar is decidable, so no firing was suppressed by a missing input"
        if not fails
        else "; ".join(fails),
    )


def _check_cell_support(cell: object, s: Mapping[str, object], t: GateThresholds) -> GateCheck:
    """The cell must carry enough evidence to be worth reading, under the rubric the summary's
    ``target_mode`` stamp selects — the SAME three sealed floors either way (a raw observation
    floor, an independent-episode floor on ``n_eff`` — the greedy non-overlapping count, since
    overlapping forward returns inflate the raw one — and a positive mean), read from different
    panels:

    - **conjunction** — every target individually: targets are the thesis's regime, a
      conjunction, so one failing target sinks the cell (it doesn't hold everywhere it claims
      to).
    - **basket** — the members form ONE evidence pool, so the floors read the POOLED panel
      (``pooled.{n, n_eff, mean_ret}``) and never a member's own: a thin member does not sink a
      basket cell, because the basket claim is about the pool, not about any name in it.
    - a missing or unreadable stamp REFUSES — grading under an assumed rubric is the
      stamp-stripping bypass one field over.

    Deliberately NOT an inferential claim. No t-statistic and no p-value gates here: the nominal
    per-cell statistics are known-uncalibrated on overlapping pools (the rotation null
    over-certifies under signal-aligned volatility regimes; the overlap HAC understates its SE)
    — and the pooled panel's reliability reads inherit the same caveats — so they ride in the
    summary as EVIDENCE and this check reads none of them. ``mean_ret > 0`` is a sign read on
    the realized sample, not a test — passing it certifies no positive expected return.

    All reads are strict: a NaN, ±inf, or non-integral count is drifted input and refuses, never
    sails past a comparison."""
    mode = _mode(s)
    if mode is None:
        return GateCheck(
            "support", False, None,
            "target_mode selects the rubric: conjunction — per-target floors, the weakest "
            "target decides; basket — the same floors on the pooled panel",
            f"target_mode stamp missing or unreadable ({s.get('target_mode')!r}) — which "
            "support rubric applies is undeterminable, and grading under an assumed mode "
            "would be the stamp-stripping bypass; drifted input",
        )
    if mode == "basket":
        threshold = (
            f"pooled: n>={t.thesis_min_trades} & n_eff>={t.thesis_min_n_eff} & mean_ret>0 "
            "(basket: the members form ONE evidence pool — floors read the pooled panel, "
            "never per member; a descriptive floor, NOT a significance claim)"
        )
        pooled = cell.get("pooled") if isinstance(cell, dict) else None
        pooled = pooled if isinstance(pooled, dict) else None
        if pooled is None:
            return GateCheck(
                "support", False, None, threshold,
                "no usable pooled panel to check (pooled missing or not a dict) — basket "
                "support is a claim about the pool, and a cell without the pooled panel "
                "carries no gradable support",
            )
        n, n_eff = _int(pooled.get("n")), _int(pooled.get("n_eff"))
        mean_ret = _num(pooled.get("mean_ret"))
        p_observed: dict[str, dict[str, int | float | None]] = {
            "pooled": {"n": n, "n_eff": n_eff, "mean_ret": mean_ret}
        }
        p_fails: list[str] = []
        if n is None or n < t.thesis_min_trades:
            p_fails.append(f"pooled: n={n} (<{t.thesis_min_trades} observations)")
        elif n_eff is None or n_eff < t.thesis_min_n_eff:
            p_fails.append(f"pooled: n_eff={n_eff} (<{t.thesis_min_n_eff} independent episodes)")
        elif mean_ret is None or mean_ret <= 0:
            p_fails.append(f"pooled: mean_ret={mean_ret} (<=0 or missing)")
        return GateCheck(
            name="support",
            passed=not p_fails,
            observed=p_observed,
            threshold=threshold,
            detail=(
                "the pooled panel carries readable support"
                if not p_fails
                else "; ".join(p_fails)
            ),
        )
    # conjunction — the per-target rubric: the weakest target decides.
    threshold = (
        f"per target: n>={t.thesis_min_trades} & n_eff>={t.thesis_min_n_eff} & mean_ret>0 "
        "(the weakest target decides; a descriptive floor, NOT a significance claim)"
    )
    by_tgt = _str_keyed(cell.get("by_target")) or {} if isinstance(cell, dict) else {}
    if not by_tgt:
        return GateCheck(
            "support", False, None, threshold,
            "no usable per-target panel to check (by_target missing, empty, or keyed by a "
            "non-string target name)",
        )
    fails: list[str] = []
    observed: dict[str, dict[str, int | float | None]] = {}
    # Grade the REGIME, not the panel that happens to be present. Anchoring the loop to
    # ``by_target`` would let a target dropped from the panel go ungraded — this check would
    # report "every target carries readable support" over a regime it never saw all of. A
    # missing target reads as an absent entry below and fails on an uncountable ``n``, which is
    # the fail-closed direction: deleting evidence can only ever refuse.
    for tgt in sorted(_targets(s) or by_tgt):
        st = by_tgt.get(tgt)
        st = st if isinstance(st, dict) else {}
        n, n_eff = _int(st.get("n")), _int(st.get("n_eff"))
        mean_ret = _num(st.get("mean_ret"))
        observed[tgt] = {"n": n, "n_eff": n_eff, "mean_ret": mean_ret}
        if n is None or n < t.thesis_min_trades:
            fails.append(f"{tgt}: n={n} (<{t.thesis_min_trades} observations)")
        elif n_eff is None or n_eff < t.thesis_min_n_eff:
            fails.append(f"{tgt}: n_eff={n_eff} (<{t.thesis_min_n_eff} independent episodes)")
        elif mean_ret is None or mean_ret <= 0:
            fails.append(f"{tgt}: mean_ret={mean_ret} (<=0 or missing)")
    return GateCheck(
        name="support",
        passed=not fails,
        observed=observed,
        threshold=threshold,
        detail="every target carries readable support" if not fails else "; ".join(fails),
    )


def _check_cell_concentration(
    cell: object, s: Mapping[str, object], t: GateThresholds
) -> GateCheck:
    """One sealed ceiling, dispatched by the ``target_mode`` stamp — the one-episode and
    one-name detectors for EVERY cell. Any missing read refuses: a cell without its detectors
    has not been checked for the failure mode that matters most on overlapping pools.

    **conjunction**: two layers — the top-5% |return|-mass share
    of every regime target's pool (a non-binding target cannot ride one whale event through the
    regime claim), and ``episode_stats.max_cluster_share_abs`` — the mass share of the largest
    merged cross-target episode cluster over the cell's closed rows (a crisis smeared across
    rows AND targets is still one episode).

    **basket**: the pooled read REPLACES the per-target layer (the basket is graded as one
    pool, so ``pooled.concentration.top_share_abs`` is the top-share detector), the
    episode-cluster ceiling stays ("not one crisis"), and a THIRD read joins them:
    ``pooled.member_share.max_member_share_abs`` — the one-name-basket detector ("not one
    name"), same sealed ceiling, no new knob. A basket whose member-mass decomposition is
    absent has not been checked for the failure mode that renames a single-name bet a basket.

    A missing or unreadable ``target_mode`` stamp refuses — which layer applies is
    undeterminable. A ``diff``-outcome multi-target run refuses the cross-target mass read
    outright in BOTH modes: level units from different series are not commensurable, so a mass
    share across them certifies nothing — and a MISSING or unreadable outcome stamp refuses the
    same way, because stripping the stamp would otherwise bypass the guard (applied in basket
    as defense-in-depth even though ``evidence_complete`` already refuses basket+diff)."""
    max_conc = float(t.thesis_max_concentration)
    mode = _mode(s)
    if mode is None:
        return GateCheck(
            "concentration", False, None, max_conc,
            f"target_mode stamp missing or unreadable ({s.get('target_mode')!r}) — whether "
            "the mass read is per-target (conjunction) or pooled (basket) is undeterminable; "
            "drifted input",
        )
    if mode == "basket":
        p_fails: list[str] = []
        p_observed: dict[str, float | None] = {
            "pooled_top_share_abs": None,
            "max_member_share_abs": None,
            "max_cluster_share_abs": None,
        }
        pooled = cell.get("pooled") if isinstance(cell, dict) else None
        pooled = pooled if isinstance(pooled, dict) else {}
        conc = pooled.get("concentration")
        conc = conc if isinstance(conc, dict) else {}
        share_p = _prob(conc.get("top_share_abs"))
        p_observed["pooled_top_share_abs"] = share_p
        if share_p is None:
            p_fails.append(
                "pooled concentration missing or out of [0,1] — the basket's one-episode "
                "detector cannot be certified"
            )
        elif share_p > max_conc:
            p_fails.append(
                f"pooled top_share_abs={share_p:.2f} — the basket's edge is one episode"
            )
        ms = pooled.get("member_share")
        ms = ms if isinstance(ms, dict) else {}
        m_share = _prob(ms.get("max_member_share_abs"))
        p_observed["max_member_share_abs"] = m_share
        if m_share is None:
            p_fails.append(
                "member-mass decomposition missing — a one-name basket cannot be ruled out"
            )
        elif m_share > max_conc:
            p_fails.append(
                f"max_member_share_abs={m_share:.2f} — one member carries the basket's mass; "
                "the basket claim is mostly one name"
            )
        incommensurable, reason = _incommensurable_pool(s)
        if incommensurable:
            p_fails.append(reason)
        else:
            ep = cell.get("episode_stats") if isinstance(cell, dict) else None
            ep = ep if isinstance(ep, dict) else {}
            cluster_share = _prob(ep.get("max_cluster_share_abs"))
            p_observed["max_cluster_share_abs"] = cluster_share
            if cluster_share is None:
                p_fails.append(
                    "episode_stats.max_cluster_share_abs missing or out of [0,1] — "
                    "cross-target episode-cluster concentration cannot be certified"
                )
            elif cluster_share > max_conc:
                p_fails.append(
                    f"max_cluster_share_abs={cluster_share:.2f} — one merged episode cluster "
                    "carries the mass"
                )
        return GateCheck(
            "concentration", not p_fails, p_observed, max_conc,
            "return mass spread across episodes, members, and clusters"
            if not p_fails
            else "; ".join(p_fails) + "; widen universe/history",
        )
    # conjunction — the per-target layer plus the episode-cluster ceiling.
    fails: list[str] = []
    by_target: dict[str, float | None] = {}
    observed: dict[str, object] = {"by_target": by_target, "max_cluster_share_abs": None}
    by_tgt = _str_keyed(cell.get("by_target")) or {} if isinstance(cell, dict) else {}
    if not by_tgt:
        fails.append(
            "no usable per-target panel — per-target concentration cannot be certified "
            "(missing, empty, or keyed by a non-string target name)"
        )
    # The regime decides the loop, not the panel — a target missing from ``by_target`` must be
    # refused as unverified, never skipped into an affirmative "mass is spread" detail.
    for tgt in sorted(_targets(s) or by_tgt):
        st = by_tgt.get(tgt)
        st = st if isinstance(st, dict) else {}
        conc = st.get("concentration")
        conc = conc if isinstance(conc, dict) else {}
        share_t = _prob(conc.get("top_share_abs"))
        by_target[tgt] = share_t
        if share_t is None:
            fails.append(f"{tgt}: per-target concentration missing or out of [0,1]")
        elif share_t > max_conc:
            fails.append(f"{tgt}: top_share_abs={share_t:.2f} — this target's edge is one episode")
    incommensurable, reason = _incommensurable_pool(s)
    if incommensurable:
        fails.append(reason)
    else:
        ep = cell.get("episode_stats") if isinstance(cell, dict) else None
        ep = ep if isinstance(ep, dict) else {}
        cluster_share = _prob(ep.get("max_cluster_share_abs"))
        observed["max_cluster_share_abs"] = cluster_share
        if cluster_share is None:
            fails.append(
                "episode_stats.max_cluster_share_abs missing or out of [0,1] — cross-target "
                "episode-cluster concentration cannot be certified"
            )
        elif cluster_share > max_conc:
            fails.append(
                f"max_cluster_share_abs={cluster_share:.2f} — one merged episode cluster carries "
                "the mass"
            )
    return GateCheck(
        "concentration", not fails, observed, max_conc,
        "return mass spread across episodes, targets, and clusters"
        if not fails
        else "; ".join(fails) + "; widen universe/history",
    )


_CELL_CHECKS = (
    _check_cell_evidence,
    _check_cell_outcome_coverage,
    _check_cell_signal_coverage,  # the two fail-closed data-integrity ledgers sit together
    _check_cell_support,
    _check_cell_concentration,
)


def _cell_identity(entry: object, index: int) -> tuple[str, dict[str, JsonValue]]:
    """``(cell_id, params)`` for a summary cell entry, total over drifted input.

    Identity is the params plus the POSITION in the panel; the rendered ``cell_id`` is a label.
    A drifted entry that carries neither still gets a positional label so the caller can align
    ``gate["cells"][i]`` with ``summary["cells"][i]`` and see exactly which cell was unreadable.
    """
    raw_id = entry.get("cell_id") if isinstance(entry, dict) else None
    cell_id = raw_id if isinstance(raw_id, str) else f"<unreadable cell[{index}]>"
    raw_params = entry.get("params") if isinstance(entry, dict) else None
    params = raw_params if isinstance(raw_params, dict) else {}
    return cell_id, params


def evaluate_gate(
    summary: Mapping[str, object], thresholds: GateThresholds | None = None
) -> GateReport:
    """Run the full checklist over one engine summary → :class:`GateReport`.

    Three run-level checks are evaluated once; then every entry of ``summary["cells"]`` is graded
    independently by five per-cell checks, in panel order, so ``gate["cells"][i]`` aligns with
    ``summary["cells"][i]``. A cell's ``passed`` is the conjunction of its OWN checks and all
    run-level checks — a run-level failure fails every cell, so a caller reading one cell's
    ``passed`` never has to AND the sections itself.

    Nothing short-circuits and nothing is filtered: every check is evaluated and reported for
    every cell, and the summary itself is never modified. An unreadable ``cells`` panel yields no
    graded cells (``evidence_complete`` has already failed); a malformed individual entry gets a
    failing ``cell_evidence`` while its siblings grade normally. Drifted input refuses with a
    detail — this function does not raise on it.

    Raises ``pydantic.ValidationError`` when the supplied thresholds do not survive revalidation
    (below) — a loosened exam is an error, not a result.
    """
    t = thresholds if thresholds is not None else GateThresholds()
    # Revalidate at the trust boundary. The canonical floor is enforced at construction, so an
    # object mutated afterwards — or a subclass that un-freezes and loosens itself — could bend
    # the exam it is graded by at the library boundary (the CLI constructs its own, so this is
    # defence for direct API callers). Reconstructing through the sealed constructor re-runs
    # every domain bound and the SEIKAN_* namespace check; whatever `snapshot()` returns IS the
    # exam that then runs, and it has just passed base-class validation. Explicit kwargs beat the
    # environment in pydantic-settings, so passing every field cannot be perturbed by a polluted
    # environment.
    t = GateThresholds(**t.snapshot())
    s = summary or {}
    run_checks = [check(s, t) for check in _RUN_CHECKS]
    run_ok = all(c.passed for c in run_checks)

    raw_cells = s.get("cells")
    cells: list[CellReport] = []
    if isinstance(raw_cells, list):
        for i, entry in enumerate(raw_cells):
            cell_id, params = _cell_identity(entry, i)
            checks = [check(entry, s, t) for check in _CELL_CHECKS]
            cells.append(
                CellReport(
                    cell_id=cell_id,
                    params=params,
                    passed=run_ok and all(c.passed for c in checks),
                    checks=checks,
                )
            )
    return GateReport(run_checks=run_checks, cells=cells)
