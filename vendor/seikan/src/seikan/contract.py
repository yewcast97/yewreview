"""The CLI's static contract payloads — data only, no logic.

Everything ``seikan schema`` emits about the contract lives here: the compact ``METRIC_ROLES``
map (stamped identically into every run report), its prose rationale, the gate-contract and
CSV-contract references, and the exit-code meanings. A leaf module like ``constants.py``: it
imports nothing from the package, and only ``cli.py`` imports it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:  # annotations only — nothing here is imported at runtime, leaf module intact
    from seikan.types import JsonValue

#: The compact role map stamped into every run report: exactly what a passing cell claims
#: (and what the exit code does NOT claim), which summary fields each check consumes, and what is
#: evidence-only — so a calling agent never mistakes an uncalibrated evidence panel for an
#: inferential result, and never reads the exit code as a verdict. One line each; the full prose
#: rationale lives in ``seikan schema`` (``METRIC_ROLES_DOC``).
METRIC_ROLES: dict[str, JsonValue] = {
    "claim": (
        "exit 0 certifies ONLY that the run finished and every nominated output was written (this "
        "report, being one of them, is complete) — it is not a "
        "verdict and says nothing about any cell. Per-cell `passed` is a completeness / support / "
        "concentration checklist over full-sample evidence, with NO significance claim and NO "
        "positive-expected-return certification: it asserts that the cell's evidence is fully "
        "measured (every firing accounted for, every decision bar decidable, every raw decision "
        "input available), that it clears the raw support floors, and that its return mass is not "
        "one episode. Nothing here is a test. Selection among cells and cross-cell multiplicity "
        "are the CALLER's, priced against n_hypotheses_attempted"
    ),
    "run_checks": {
        "evidence_complete": [
            "statistics_version", "gate_evidence_basis", "targets",
            "outcome (an explicit {series, kind} dict — a null stamp refuses)",
            "target_mode ('conjunction' | 'basket' — the stamp selects the rubric; missing or "
            "garbage refuses, and basket with <2 targets or a diff outcome refuses as drifted "
            "input)",
            "n_hypotheses_attempted", "n_bars",
            "cells (a list with len(cells) == n_hypotheses_attempted)",
            "sources (string-keyed, covering targets exactly)",
        ],
        "source_coverage": [
            "sources[*].{n_bars,n_missing}",
            "sources[*].by_source[*].n_missing (first_available is evidence, never a refusal)",
            "n_bars (the geometry every availability count is verified against)",
        ],
        "search_cap": [
            "n_hypotheses_attempted",
        ],
    },
    "cell_checks": {
        "cell_evidence": [
            "cells[*].params",
            "cells[*].by_target[*].{n,n_eff}",
            "cells[*].outcome_coverage[*].{n_attempted,n_closed,exit_reasons}",
            "cells[*].signal_coverage[*].n_bars",
            "cells[*].episode_stats.n",
            "cells[*].pooled.{n,n_eff} (basket only — pooled.n == sum of by_target.n, "
            "pooled.n_eff <= pooled.n, pooled.n_eff <= n_bars, pooled.n <= n_bars × targets; "
            "a pooled key on a conjunction cell REFUSES as a restamped basket)",
            "targets + n_bars + target_mode (the cross-panel reconciliation references)",
        ],
        "outcome_coverage": [
            "cells[*].outcome_coverage[*].exit_reasons.{no_outcome,no_benchmark} "
            "('open' is ALLOWED at any count — end-of-data right-censoring is structural; "
            "per-target in BOTH modes)",
        ],
        "signal_coverage": [
            "cells[*].signal_coverage[*].{n_bars,n_undefined} (per-target in BOTH modes)",
        ],
        "support": [
            "conjunction: cells[*].by_target[*].{n,n_eff,mean_ret} (the weakest target "
            "decides)",
            "basket: cells[*].pooled.{n,n_eff,mean_ret} (one pool — no member is examined "
            "alone)",
        ],
        "concentration": [
            "conjunction: cells[*].by_target[*].concentration.top_share_abs",
            "basket: cells[*].pooled.concentration.top_share_abs + "
            "cells[*].pooled.member_share.max_member_share_abs (the one-name-basket detector)",
            "cells[*].episode_stats.max_cluster_share_abs (both modes)",
            "outcome.kind + targets (diff-outcome multi-target incommensurability guard)",
        ],
    },
    "evidence_only": [
        "per-cell rot_p / rotation (circular-shift null — anti-conservative under signal-aligned "
        "volatility regimes)",
        "t_hac / hac_se (event-time overlap HAC — understates the SE on overlapping pools)",
        "summary.pbo block (pbo, reason, n_splits, n_combos, blocks, lambda_mean, "
        "oos_degradation_slope, prob_oos_loss — CSCV, grid-level)",
        "t_iid / p_iid (overlap-inflated classical pair — reference only, never significance)",
        "per-cell sharpe / firing_rate / hit_rate / win_loss_ratio / skewness / mean_bars_held "
        "(descriptive shape)",
        "per-cell by_target boot (episode-bootstrap CI {method, ci_level, n_boot, n_episodes, "
        "ci_lo, ci_hi, boot_se, reason} — the dependence-robust counterweight to t_hac/rot_p; "
        "see caveats.boot)",
        "per-cell by_target subperiods (three equal-bar eras [{start, end, n, mean_ret}] — "
        "descriptive era visibility; nothing selects on it)",
        "per-cell by_target ret_quantiles {p10,p25,p50,p75,p90} + worst_ret (closed-return order "
        "statistics — the typical-observation read mean_ret cannot give; see "
        "caveats.ret_quantiles)",
        "per-cell by_target mae_quantiles / mfe_quantiles ({n, p10..p90, worst | best} — RAW "
        "post-entry excursion order statistics over [fill, fill+h]; see caveats)",
        "bar_spacing (run-level {min,median,max}_seconds — the index's clock geometry)",
        "episode_stats beyond the two fields the checklist reads (n, max_cluster_share_abs)",
        "summary.baseline (run-level unconditional base rate per horizon × target — plus a "
        "pooled row in basket; the conditional-vs-base-rate comparison is the caller's, and "
        "no uplift field ever exists)",
        "per-cell episodes (the time-ordered episode ledger under episode_stats — bounded at "
        "its stated cap, with mass-conserving truncation counts)",
        "per-cell conditional_buckets / bucket_monotonicity (descriptive conditioning over "
        "the cell's own rows, pooled across the cell's targets — never pooled across cells)",
        "per-cell feature_association (Spearman rho per cell × feature × target — per-target "
        "in BOTH modes, deliberately no p-value)",
        "per-cell pooled beyond the fields the checklist reads (hit_rate, t_hac, hac_se, "
        "rot_p, boot, subperiods, ret_quantiles, worst_ret, mae_quantiles, mfe_quantiles — "
        "basket evidence riders; none gate)",
        "per-cell pooled.member_share.by_target (the full member-mass decomposition — "
        "attribution, never a ranking; only max_member_share_abs gates)",
    ],
    # One honest sentence per number a reader is likely to over-trust, TRAVELLING WITH the
    # report: the compact roles say WHETHER a field gates (none of these do); the caveats say
    # WHY quoting it as certification would mislead. The long mechanics live in
    # ``METRIC_ROLES_DOC`` (schema-only).
    "caveats": {
        "rot_p": (
            "assumes shift-exchangeability — over-certifies when volatility clusters in the "
            "same stretches the signal fires (crises, regime breaks); never quote as "
            "significance"
        ),
        "t_hac": (
            "(and hac_se) the Bartlett taper understates the SE on overlapping pools — "
            "anti-conservative, ~10-12% rejection at nominal 5% under an iid-innovation null"
        ),
        "t_iid": (
            "(and p_iid) the iid assumption is violated BY CONSTRUCTION on overlapping pools — "
            "reference only"
        ),
        "boot": (
            "the episode bootstrap assumes episode INDEPENDENCE; adjacent episodes still "
            "correlate through volatility regimes — less anti-conservative than t_hac, not "
            "calibrated"
        ),
        "pbo": (
            "whole-grid CSCV attached to no cell: in-block Sharpes are overlap-inflated, and "
            "the adaptive S can rest on as few as 6 dependent splits"
        ),
        "sharpe": "per-observation, un-annualized, gross of costs",
        "mean_ret": (
            "in-sample full-sample descriptive, gross of costs — no holdout and no deflation; "
            "read it against ret_quantiles.p50, because a positive mean over a negative median "
            "is a pool a few spikes carried, not a typical outcome"
        ),
        "concentration": (
            "top-5% |return|-mass share; below n=20 the top set is a single observation, so "
            "thin pools read structurally elevated"
        ),
        "ret_quantiles": (
            "linear-interpolated order statistics of the closed pool — below n≈20 the outer "
            "percentiles rest on one or two observations, and overlap smears one market move "
            "across ~h rows, so these are not independent-draw estimates"
        ),
        "mae_quantiles": (
            "RAW-path excursions, never benchmark-adjusted (unlike ret when benchmarked); "
            "overlapping windows share one trough, so a single crash sets the mae of ~h "
            "neighbouring rows and the tail percentiles are not independent events"
        ),
        "mfe_quantiles": (
            "RAW-path interim marks, never benchmark-adjusted and never attainable exits (this "
            "engine has no exit rule); overlapping windows share one peak, so the tail "
            "percentiles are not independent events"
        ),
        "baseline": (
            "in-sample base rates over every anchor bar in the cells' own algebra/benchmark/"
            "direction — quote a conditional mean AGAINST it; exclusions are the honesty "
            "channel and uplift is never derived; under 'cross_mean' the pooled baseline "
            "mean is ~0 by construction (an identity, not a finding)"
        ),
        "episodes": (
            "time-ordered, never ranked by share, and BOUNDED: past the cap the ledger "
            "truncates visibly (n_omitted, omitted_share_abs), so any count read off it is a "
            "floor, not a total — reconcile against episode_stats.n_clusters"
        ),
        "conditional_buckets": (
            "per-cell and pooled across the cell's own targets; qcut buckets over "
            "overlap-inflated rows, so 'associated in this sample', never 'predicts' — and do "
            "not pool them back across cells yourself: a cross-cell pool makes its conditioning "
            "depend on grid composition"
        ),
        "feature_association": (
            "Spearman rho over overlapping rows, deliberately without a p-value (an "
            "overlap-inflated p is exactly the over-trustable number); per-target in BOTH "
            "modes — a pooled cross-member rho would conflate level differences between "
            "members with variation through time"
        ),
        "pooled": (
            "(bar × member) rows — one market move smears across members AS WELL AS across ~h "
            "overlapping horizons, so pooled n overstates the independent information TWICE; "
            "read pooled.n_eff and the cluster share before quoting any pooled count"
        ),
        "member_share": (
            "a full decomposition of the pooled |return| mass, never a ranking — by_target is "
            "attribution, not a verdict about any member; a 2-member basket reads "
            "structurally elevated (its larger member always carries >= 0.5)"
        ),
        "pooled_rot_p": (
            "a COMMON-SHIFT null: one shift rotates every member's mask as a block, preserving "
            "per-member counts and the per-bar cross-sectional pattern; inherits every rot_p "
            "caveat (shift-exchangeability, volatility-regime over-certification) — never "
            "quote as significance"
        ),
    },
    "scope_boundary": (
        "the checklist prices ONE cell of ONE run — it takes no cross-cell correction, and "
        "cross-RUN search (DSL variants, re-submissions over the same data) is invisible to a "
        "stateless reporter and belongs to the calling agent; the identity layer (dsl_hash, "
        "data_digests, summary.index_start/index_end) exists so the caller CAN enforce it"
    ),
}

#: The prose rationale behind ``METRIC_ROLES`` — emitted by ``seikan schema`` only (the
#: run report carries the compact map above; repeating ~3 KB of static prose in every
#: report buys nothing).
METRIC_ROLES_DOC: dict[str, JsonValue] = {
    "claim": (
        "The exit code reports how far the RUN got, never how the evidence looked: exit 0 means "
        "the run finished and every nominated output was written — the report, when one was "
        "nominated, is complete — whatever every cell's checklist says. A "
        "cell's `passed` is a NON-INFERENTIAL checklist — completeness, support, and "
        "non-concentration on full-sample evidence. It makes no significance claim and certifies "
        "no positive expected return; `mean_ret > 0` inside `support` is a sign read on the "
        "realized sample, not a test. Nothing in this report selects: the engine measures every "
        "declared cell and reports each independently, so choosing among them — and pricing the "
        "multiplicity of having looked at n_hypotheses_attempted of them — is the calling "
        "agent's work, not seikan's."
    ),
    "run_checks": [
        "statistics_version + gate_evidence_basis (evidence_complete — the summary must carry "
        "the stamps this checklist was built against, or it refuses ungraded: a summary from a "
        "different estimator revision would be graded by the wrong rubric)",
        "targets + outcome + target_mode + n_bars + n_hypotheses_attempted + sources + cells "
        "(evidence_complete — targets must be a non-empty list of STRINGS (a non-string name "
        "indexes no panel), the outcome stamp (the measurement algebra every reported number is "
        "denominated in) must be the explicit {series, kind} dict the runner always stamps — a "
        "null stamp is stripped input and refuses — the target_mode "
        "stamp must be 'conjunction' or 'basket', because it SELECTS the rubric every "
        "cross-target read is graded under: a missing or garbage stamp refuses fail-closed, "
        "and a basket stamp over fewer than two targets or a diff outcome refuses as drifted "
        "input (validation refuses both upstream; the gate re-refuses, never trusts) — the "
        "geometry and declared grid must be "
        "countable and at least one, the sources panel must be string-keyed and cover the regime "
        "EXACTLY, and cells must hold EXACTLY n_hypotheses_attempted entries. That last one is "
        "this report's honesty invariant: the panel carries one entry per declared combo × "
        "horizon INCLUDING those that never fired, so a report short of the declared grid has "
        "dropped hypotheses from the search burden it declares — drifted input, not evidence)",
        "sources[*].{n_bars,n_missing} + sources[*].by_source[*].n_missing (source_coverage — "
        "the fail-closed availability contract over the RAW decision inputs, run-level because "
        "it is combo-independent: the entry tree's leaves (Field/External/DaysSince) either had "
        "data on a bar or they did not, whichever parameters read them. This is the layer the "
        "per-cell three-valued signal_coverage ledger structurally cannot see, because two hole "
        "classes decide cleanly while data is missing: an operand hole absorbed by a decisive "
        "sibling (Kleene F and U = F leaves the root DEFINED), and a hole a NaN-skipping "
        "recursive kernel (ema, expanding aggregates, bars_since_extremum) carried its state "
        "across before emitting a finite value. Counting at the source puts no operator between "
        "the hole and the count. A source that merely STARTS LATE is warmup, not a hole — its "
        "first_available is reported as evidence. Unconditional; no knob)",
        "n_hypotheses_attempted (search_cap — the DECLARED grid, which non-firing combos cannot "
        "shrink, bounded by thesis_max_hypotheses. It is the ONLY multiplicity input this policy "
        "carries: cells are graded independently and no cross-cell correction is taken, so the "
        "cap bounds how wide a search a single run may declare and the caller prices its own "
        "selection against the number)",
    ],
    "cell_checks": [
        "cells[*].params + by_target + outcome_coverage + signal_coverage + episode_stats "
        "(+ pooled in basket) "
        "(cell_evidence — the cell must carry the evidence its own checks grade, and its panels "
        "must AGREE. Shape: the three per-target panels are string-keyed and cover the regime "
        "exactly (a silently dropped target fails here rather than passing by absence). "
        "Arithmetic: exit reasons sum to n_attempted and n_closed == exit_reasons.horizon — a "
        "ledger anyone can re-check. Reconciliation: by_target.n == outcome_coverage.n_closed, "
        "n_eff <= n (independent episodes cannot outnumber observations), episode_stats.n == the "
        "per-target total (the concentration and support panels must describe one pool), and "
        "signal_coverage.n_bars == summary.n_bars (the decision ledger spans the whole index by "
        "construction). Basket cells must additionally carry the pooled dict their own rubric "
        "grades, reconciling with the member panels: pooled.n == the per-target total, "
        "pooled.n_eff <= pooled.n, pooled.n_eff <= n_bars (same-bar cross-member firings "
        "collapse in the greedy count), pooled.n <= n_bars × len(targets) (each member fires "
        "at most once per bar); a pooled key on a conjunction cell REFUSES — the runner "
        "writes pooled only in basket mode, so the configuration is the signature of a "
        "restamped basket and refusing it costs zero honest refusals; a missing target_mode "
        "stamp refuses — whether a pooled panel is part of the contract is then "
        "undeterminable. An internally impossible summary is drifted input, not something "
        "to grade)",
        "cells[*].outcome_coverage[*].exit_reasons.{no_outcome,no_benchmark} (outcome_coverage — "
        "the fail-closed missingness contract: the engine censors a NaN outcome endpoint or a "
        "benchmark hole and every statistic silently skips the row, which is exactly how a "
        "vendor outage, a stale feed, or an adversarial file could delete adverse outcomes and "
        "leave a clean-looking cell. Any such firing refuses; missing-at-random is never "
        "assumed. 'open' is ALLOWED at any count: with no holdout there is no embargo and no "
        "tail, so a forward window running past the last bar is structural right-censoring every "
        "cell near the index end must exhibit — refusing it would refuse the calendar, not a "
        "data defect. An in-bounds hole is not 'open'; it classifies as no_outcome/no_benchmark "
        "upstream and refuses here)",
        "cells[*].signal_coverage[*].{n_bars,n_undefined} (signal_coverage — the DECISION-side "
        "twin of outcome_coverage, pooled layer. The outcome ledger can only account for bars "
        "that FIRED, so a missing decision input does not censor an outcome: it suppresses the "
        "firing itself and leaves no trace there, which would mean deleting data improves a "
        "result. The engine evaluates conditions three-valued and counts post-warmup UNDECIDABLE "
        "bars (init & ~defined); any of them refuses. n_bars is pure geometry, so n_undefined <= "
        "n_bars is verifiable arithmetic no property of the data can bend. The ledger is keyed "
        "by COMBO upstream, so horizon siblings legitimately repeat the same counts — each cell "
        "is graded alone and nothing is ever summed across cells. Unconditional; no knob)",
        "cells[*].by_target[*].{n,n_eff,mean_ret} (conjunction) | cells[*].pooled.{n,n_eff,"
        "mean_ret} (basket) (support — the SAME sealed floors under either rubric: a raw "
        "observation count, an independent-episode count (n_eff, the greedy non-overlapping "
        "count — overlapping forward returns inflate the raw one), and a positive mean. In "
        "conjunction the floors read every target individually — targets are the thesis's "
        "regime, so the weakest target decides. In basket the members form ONE evidence pool: "
        "the pooled block clears the floors and no member is examined alone — a thin member "
        "does not sink a basket cell, because the claim is about the pool, not any name in it. "
        "A missing target_mode stamp refuses. Deliberately NOT an inferential claim: no "
        "t-statistic and no p-value gates here, because the nominal statistics are "
        "known-uncalibrated on overlapping pools — they ride along as evidence and this check "
        "reads none of them)",
        "cells[*].by_target[*].concentration.top_share_abs (conjunction) | "
        "cells[*].pooled.concentration.top_share_abs + "
        "cells[*].pooled.member_share.max_member_share_abs (basket) + "
        "cells[*].episode_stats.max_cluster_share_abs (both modes) (concentration — one "
        "universal ceiling (thesis_max_concentration), dispatched by the target_mode stamp. "
        "Conjunction: every regime target's top-5% |return|-mass share (no target may ride one "
        "whale event through the regime claim) plus the mass share of the largest merged "
        "cross-target episode cluster (a crisis smeared across rows AND targets is still one "
        "episode). Basket: the pooled top share REPLACES the per-target layer — the basket is "
        "graded as one pool — the episode-cluster ceiling stays ('not one crisis'), and the "
        "member-mass ceiling joins them ('not one name': max_member_share_abs over the sealed "
        "same ceiling is the one-name-basket detector, and a missing decomposition refuses). "
        "A missing target_mode stamp refuses. A diff-outcome multi-target run refuses "
        "the cross-target mass read as incommensurable — level units from different series are "
        "not mass-comparable — and so does a MISSING or unreadable outcome stamp, since "
        "stripping it would otherwise bypass the guard)",
    ],
    "evidence_only": [
        "per-cell rot_p / rotation (the circular-shift null — KNOWN anti-conservative: it "
        "assumes shift-exchangeability and over-certifies under signal-aligned volatility "
        "regimes; no check reads it)",
        "t_hac / hac_se (event-time overlap HAC — KNOWN anti-conservative: the Bartlett taper "
        "understates the long-run variance on overlapping pools; no check reads it — re-derive a "
        "p from t_hac at df = n_eff-1 when you need one, knowing that caveat)",
        "the summary.pbo block (pbo, reason, n_splits, n_combos, blocks, lambda_mean, "
        "oos_degradation_slope, prob_oos_loss) — CSCV selection fragility over the grid's "
        "symmetric block splits; a grid-level descriptive read, never a per-cell result",
        "t_iid / p_iid (overlap-inflated classical pair — reference only, NEVER significance)",
        "per-cell sharpe (per-observation, un-annualized), firing_rate (firings/n_bars), "
        "hit_rate, win_loss_ratio, skewness, mean_bars_held — distribution shape and effect "
        "size, descriptive",
        "episode_stats beyond the two fields the checklist reads (n, max_cluster_share_abs): "
        "n_clusters, the earliest entry, and the cluster-mass profile are a regime-clustering "
        "diagnostic",
        "per-cell by_target boot (the episode-bootstrap percentile CI for the "
        "pool mean: overlap-connected [t, t+h) episodes resampled with replacement, so "
        "within-episode dependence is preserved exactly and the interval is as wide as the "
        "EPISODE count warrants; deterministic, content-seeded; below 5 episodes it reports "
        "null fields with a reason instead of a degenerate interval)",
        "per-cell by_target subperiods (n / mean_ret over three equal-bar eras "
        "of the shared index, entry-bar assignment, NO purging: era visibility, not a holdout, "
        "and nothing selects on it)",
        "bar_spacing ({min,median,max}_seconds between consecutive bars: the "
        "clock geometry every horizon-in-bars is denominated in; self-description, never "
        "interpreted by the engine)",
        "per-cell by_target ret_quantiles + worst_ret (the closed pool's "
        "{p10,p25,p50,p75,p90} and its single worst observation: the SHAPE read a mean cannot "
        "give, so a reader can state what a typical observation looked like instead of "
        "describing the pool by its average alone; no count of its own, because its pool is the "
        "cell's own n)",
        "per-cell by_target mae_quantiles / mfe_quantiles (the same five points "
        "plus the extreme over the RAW post-entry excursion columns, each with its own n: the "
        "holding-period path evidence, aggregated into the report so it reaches a reader "
        "without --trades-out)",
        "summary.baseline (the run-level unconditional base rate per horizon "
        "× target over every fillable anchor bar, same algebra/benchmark/direction as the "
        "cells, with an exclusions ledger and, in basket, a pooled row; NO uplift field ever — "
        "the conditional-vs-base-rate comparison is the caller's, and no check reads it)",
        "per-cell episodes (the time-ordered episode ledger under "
        "episode_stats: earliest first, never ranked by share, bounded at its cap with "
        "explicit mass-conserving truncation counts; n_total reconciles with "
        "episode_stats.n_clusters)",
        "per-cell conditional_buckets / bucket_monotonicity (per-feature "
        "mean-return-by-quantile over the CELL's own closed rows, pooled across the cell's "
        "targets, with explicit refusal reasons; there is no run-level pooled pair, because a "
        "pooled qcut's conditioning would depend on grid composition)",
        "per-cell feature_association (Spearman rho between the entry-time "
        "feature snapshot and the realized closed ret, per cell × feature × target — the time "
        "axis within ONE target, in BOTH modes; deliberately no p-value)",
        "per-cell pooled beyond the fields the checklist reads (basket only — "
        "hit_rate, t_hac/hac_se (same-bar cross-member pairs at full Bartlett weight), the "
        "common-shift rot_p, boot over cross-member-merged episodes, subperiods, "
        "ret_quantiles/worst_ret, mae_quantiles/mfe_quantiles: pooled twins of the by_target "
        "evidence riders, none gating)",
        "per-cell pooled.member_share.by_target (basket only — each member's share of the "
        "pooled |return| mass, a full decomposition and never a ranking; the checklist reads "
        "only max_member_share_abs)",
    ],
    # The long mechanics behind the compact ``metric_roles.caveats`` map every report carries.
    "caveats": {
        "rot_p": (
            "The rotation null fixes the forward-return series and rotates only the firing "
            "mask, so it is valid exactly when the series looks the same wherever the mask "
            "lands (shift-exchangeability). Volatility clusters in the same stretches most "
            "signals fire — crises, earnings seasons, regime breaks — so rotated masks land in "
            "calm periods, the null distribution is too narrow, and rot_p over-certifies. It is "
            "also one-sided (right tail) and floored at rotation.p_resolution."
        ),
        "t_hac": (
            "The event-time HAC's Bartlett taper downweights exactly the lags that carry the "
            "overlap covariance, so hac_se understates the long-run variance: the SE ratio "
            "approaches sqrt(2/3) ≈ 0.82 on heavily overlapping pools and Monte Carlo under an "
            "iid-innovation null rejects ~10-12% at nominal 5%. The df = n_eff − 1 reference "
            "fixes the tail's shape, not the SE's scale."
        ),
        "t_iid": (
            "The classical one-sample pair treats overlapping observations as independent; a "
            "single move smeared across ~h observations inflates it mechanically. It rides "
            "along only so a reader can see how much the overlap flatters the naive read."
        ),
        "boot": (
            "The episode bootstrap resamples overlap-connected episodes as exchangeable units, "
            "which is honest about within-episode dependence but assumes independence BETWEEN "
            "episodes — adjacent episodes still co-move through slow volatility regimes, so the "
            "CI is less anti-conservative than t_hac, not calibrated. Below 5 episodes there is "
            "no resampling distribution worth reporting and the block says so with a reason."
        ),
        "pbo": (
            "CSCV describes the WHOLE declared grid, never one cell, and cannot see DSL "
            "variants tried across runs. Its block scores are per-observation Sharpes computed "
            "on overlapping in-block pools (only block-boundary crossings are purged), so the "
            "ranking it is built on inherits overlap inflation; sparse grids fall back to S = 6 "
            "or 4 blocks, where the whole number can flip on one split (the reported `blocks` "
            "says which S was used)."
        ),
        "sharpe": (
            "Per-observation and un-annualized (the observer fires irregularly, so sqrt-time "
            "annualization maps to no real strategy), and GROSS of costs — no fee, slippage or "
            "impact model exists anywhere in this engine."
        ),
        "mean_ret": (
            "A full-sample in-sample descriptive: no holdout, no deflation, no cost model. The "
            "support check reads only its SIGN, and a positive sign on the realized sample is "
            "not an expected-return claim. It is also the number most easily mistaken for a "
            "typical outcome: a +3% mean can sit on a NEGATIVE p50 when two spikes carry the "
            "mass, and the concentration check does not catch it — that check reads |return| "
            "mass in one EPISODE, while a mild right skew spreads its mass thinly and still "
            "drags the mean off the median. Read mean_ret and ret_quantiles.p50 together; when "
            "they disagree in sign, the median is the honest headline and the mean is a "
            "statement about the tail."
        ),
        "concentration": (
            "top_share_abs is the |return|-mass share of the top 5% of observations with "
            "k = max(1, ceil(0.05·n)) — for n < 20 that is the single largest observation, so "
            "thin pools read structurally elevated (n_top says what k was)."
        ),
        "ret_quantiles": (
            "Order statistics of the cell's own closed returns under numpy's default linear "
            "interpolation (so p50 agrees with median_ret on the same pool). Two limits. Below "
            "n≈20 the outer points are interpolations between the extreme observations — p10 "
            "and p90 then describe one or two rows, not a tail — and even at the support floor "
            "of 30 an outer decile rests on ~3 observations. And the observations are "
            "OVERLAPPING: one market move is smeared across ~h rows, so these are "
            "observation-weighted descriptions of what the pool held, not independent-draw "
            "quantile estimates. Under a benchmark they are EXCESS returns, like ret itself."
        ),
        "mae_quantiles": (
            "The distribution of the per-trade maximum adverse excursion over [fill, fill+h] — "
            "how deep the position ran against itself before the horizon closed. RAW path "
            "always: under a benchmark, ret becomes excess while mae does NOT, so differences "
            "between the two are unit-mismatched and no give-back ratio computed across them is "
            "meaningful. Overlapping windows share the same trough, so one crash sets the mae of "
            "~h neighbouring rows and the lower tail has atoms rather than independent events. "
            "The block's own n can be BELOW the cell's n: a hole anywhere in the excursion "
            "window censors mae on a row whose ret still closed. Custom-outcome and "
            "series-shaped targets have no true intrabar range (open=high=low=close), so their "
            "excursions understate."
        ),
        "mfe_quantiles": (
            "The favorable mirror of mae_quantiles — the best interim mark over the same window "
            "— carrying every one of its caveats (RAW path, shared peaks across overlapping "
            "windows, its own n, synthesized ranges on series targets). One more, and it is the "
            "one that misleads: an MFE is a MARK, never an exit. This engine has no exit rule, "
            "so 'the trade was up 8% at one point' describes the path the horizon measurement "
            "sat through, and reading it as a foregone gain silently assumes an exit policy no "
            "part of this report measured."
        ),
        "baseline": (
            "The unconditional base rate is measured in EXACTLY the cells' own algebra — same "
            "outcome, same benchmark leg, same direction sign — so a conditional mean quoted "
            "without it is the market wearing a costume. It is in-sample, over every fillable "
            "anchor bar, and the exclusions ledger (open / no_outcome / no_benchmark) is its "
            "honesty channel: n_eligible + sum(exclusions) == n_anchor_bars is re-checkable "
            "arithmetic. There is deliberately NO uplift or difference field — computing the "
            "comparison is the caller's act. Under benchmark 'cross_mean' the basket's pooled "
            "baseline mean sits at ~0 BY CONSTRUCTION: each member's excess is taken against "
            "the members' own cross-sectional mean, so the pool's mean excess is an identity, "
            "not a market fact."
        ),
        "episodes": (
            "The ledger lists overlap-merged episodes EARLIEST FIRST — it is never ranked by "
            "share, so 'the biggest episode' requires reading all of it. It is bounded at its "
            "stated cap: past it, entries fall off the list but never off the ledger's "
            "arithmetic (n_omitted and omitted_share_abs conserve the mass), so a count read "
            "off a truncated list is a floor, not a total. n_total == episode_stats.n_clusters "
            "always — a mismatch is drifted input."
        ),
        "conditional_buckets": (
            "Per-cell, per-feature qcut buckets over the cell's own closed rows, pooled across "
            "the cell's targets. The rows are OVERLAPPING, so bucket means inherit the same "
            "smearing as every pooled read: 'associated in this sample', never 'predicts'. Do "
            "not rebuild a pooled cross-cell version yourself — the same bar enters once per "
            "combo × horizon, which makes every bucket boundary depend on grid composition "
            "(dishonest conditioning, not redundancy)."
        ),
        "feature_association": (
            "Spearman between the entry-time feature snapshot and the realized closed ret, per "
            "cell × feature × target. It carries NO p-value on purpose: overlap inflates any p "
            "into exactly the over-trustable number the doctrine forbids. It stays per-target "
            "in BOTH modes, because a pooled cross-member rank correlation would conflate "
            "LEVEL differences between members with variation through TIME — a basket's "
            "pooled evidence lives in the pooled panel, not here."
        ),
        "pooled": (
            "The pooled panel's rows are (bar × member) observations: one market move smears "
            "across the basket's members AS WELL AS across ~h overlapping horizons, so "
            "pooled.n overstates the independent information TWICE. pooled.n_eff is the same "
            "greedy non-overlapping kernel as everywhere else — same-bar firings across "
            "members collapse to ONE independent observation — and it, with the episode-"
            "cluster share, is the honest size of the pool. by_target attribution never "
            "grades: 'NVDA cleared, AMD failed' is not a statement a basket run can make."
        ),
        "member_share": (
            "A FULL decomposition of the pooled |return| mass across members, never a ranking "
            "and never a verdict about any member. Structure matters: a 2-member basket's "
            "larger member always carries >= 0.5, so small baskets read structurally elevated "
            "against the same sealed ceiling — exactly as thin pools do under concentration. "
            "Only max_member_share_abs gates; by_target is attribution."
        ),
        "pooled_rot_p": (
            "The pooled rotation null is a COMMON-SHIFT null: one shift rotates EVERY member's "
            "mask as a block, preserving per-member firing counts and the per-bar cross-"
            "sectional pattern a rank signal fixes — rotating members independently would "
            "destroy exactly the structure a basket thesis is about. With one member it "
            "reduces to the per-target null, and it inherits every rot_p caveat: shift-"
            "exchangeability, over-certification when volatility clusters where the signal "
            "fires, one-sided, floored at rotation.p_resolution. Never quote as significance."
        ),
    },
    "scope_boundary": (
        "The checklist prices one cell of one run. It takes NO cross-cell correction — the "
        "search cap bounds the declared grid and n_hypotheses_attempted stamps it, and pricing "
        "the multiplicity of choosing among those cells is the calling agent's work. A stateless "
        "reporter equally cannot police search ACROSS runs: many DSL variants or re-submissions "
        "over the same data are invisible to it, and repeated external search invalidates any "
        "error rate anyone might attach to a single report. The identity layer (dsl_hash, "
        "per-key data_digests, summary.index_start/index_end) makes every distinct exam visible "
        "so the calling agent CAN enforce a budget; research-process discipline (how many theses "
        "were tried, pre-registration, family-level correction across runs) belongs to that "
        "agent. Never read exit 0 as a certificate over anything — not the research process, and "
        "not even one cell."
    ),
}

#: The report/summary field dictionary — the OUTPUT-side twin of ``dsl_json_schema``. Emitted by
#: ``seikan schema`` only: an agent caches the schema once and holds every definition, while the
#: report stays lean (the same split as ``METRIC_ROLES_DOC``). Inner keys are summary-relative
#: field paths; values are one-line definitions.
REPORT_FIELDS: dict[str, JsonValue] = {
    "conventions": {
        "alignment": (
            "summary.cells[i] and gate.cells[i] are POSITIONALLY aligned; cell_id is a rendered "
            "label, never a key — identity is params + position"
        ),
        "nulls": (
            "every non-finite number serializes as null; a target with no closed rows carries "
            "n=0 and null statistics BY CONSTRUCTION — null means 'no evidence', never 'zero' "
            "(the evidence blocks additionally carry a `reason` string when null)"
        ),
        "units": (
            "every return-valued field (mean_ret, ret, mae, mfe, pre_ret, ci_lo/ci_hi, cvar_5, "
            "ret_quantiles, ...) is denominated per summary.outcome.units — 'fraction' (pct), "
            "'log', or 'level_diff' (the measured series' own level units); benchmarked runs are "
            "EXCESS returns in the same algebra, and direction signs every measurement. ONE "
            "exemption: the RAW-path fields (mae, mfe, pre_ret and the mae_quantiles / "
            "mfe_quantiles blocks) are never benchmark-adjusted, so under a benchmark they are "
            "not commensurable with ret and no difference between them means anything"
        ),
        "rollups": (
            "summary.by_target / by_param are UNWEIGHTED means of per-pool means (n summed) — "
            "descriptive orientation over the declared grid, never pooled statistics"
        ),
        "caveats": (
            "metric_roles.caveats (in this same report) carries one honest sentence per "
            "over-trustable number — read it before quoting rot_p, t_hac, boot, pbo, sharpe or "
            "mean_ret"
        ),
    },
    "run": {
        "statistics_version": "the estimator revision that produced every number",
        "gate_evidence_basis": "'full_sample' — no holdout exists; every cell is measured once",
        "target_mode": (
            "'conjunction' | 'basket' — which target semantics produced every cross-target "
            "read; always stamped. The checklist dispatches on it (a missing stamp refuses): "
            "conjunction grades targets as the thesis's regime, weakest target deciding; "
            "basket grades each cell's pooled cross-target panel"
        ),
        "baseline": (
            "run-level unconditional base rates, one entry per horizon in declaration order: "
            "by_target[t] = {n_anchor_bars, n_eligible, exclusions, mean_ret, std_ret, "
            "hit_rate, ret_quantiles, worst_ret, best_ret} over EVERY fillable anchor bar, "
            "same algebra/benchmark/direction as the cells; basket entries additionally carry "
            "a pooled row summing the per-target counts; n_eligible + sum(exclusions) == "
            "n_anchor_bars is re-checkable; empty pools are null, never zero; NO uplift field "
            "— the conditional-vs-base-rate comparison is the caller's (evidence-only)"
        ),
        "n_bars / index_start / index_end": "geometry and extent of the evaluated joined index",
        "bar_spacing": (
            "{min,median,max}_seconds between consecutive bars — the clock geometry a "
            "horizon-in-bars is denominated in"
        ),
        "n_hypotheses_attempted": (
            "the DECLARED combo × horizon grid, non-firing combos included — the ONLY "
            "multiplicity input in the report; nothing is corrected for it"
        ),
        "outcome": (
            "{series, kind, units} — ALWAYS explicit (never null): the "
            "measurement algebra every reported number is denominated in"
        ),
        "direction / benchmark / benchmark_source / target_shape": (
            "self-description: the sign convention, whether returns are excess, against what, "
            "and the target's data shape (ohlcv | series)"
        ),
        "rotation": (
            "{n_shifts, p_resolution}: a rot_p AT p_resolution means 'no shift beat the "
            "observation', not p ≈ 0"
        ),
        "pbo": (
            "the grid-level CSCV block {pbo, reason, n_splits, n_combos, blocks, lambda_mean, "
            "oos_degradation_slope, prob_oos_loss} — a property of the search space, attached "
            "to no cell"
        ),
        "sources": (
            "per-target per-decision-leaf availability (n_missing, first_available) — the raw "
            "inputs under source_coverage"
        ),
        "n_stats_rows": (
            "row count of stats_table — (combo × target) pools with >= 1 closed observation"
        ),
    },
    "cells": {
        "by_target.n": "closed observations in this target's pool",
        "by_target.n_eff": (
            "greedy NON-OVERLAPPING observation count — the independent-information count; "
            "every df in the layer derives from it"
        ),
        "by_target.mean_ret": (
            "mean closed return, units per summary.outcome, gross of costs, in-sample"
        ),
        "by_target.hit_rate": "share of closed returns > 0",
        "by_target.t_hac / hac_se": (
            "event-time overlap-HAC t and SE, df = n_eff - 1 (no p is emitted — re-derive it, "
            "knowing the caveat)"
        ),
        "by_target.rot_p": (
            "one-sided right-tail circular-rotation p; resolution floor = "
            "summary.rotation.p_resolution"
        ),
        "by_target.concentration": (
            "{top_share_abs, n_top, top_frac}: |return|-mass share of the top 5% observations"
        ),
        "by_target.boot": (
            "{method, ci_level, n_boot, n_episodes, ci_lo, ci_hi, boot_se, reason} — "
            "episode-bootstrap percentile CI for the pool mean (evidence-only)"
        ),
        "by_target.subperiods": (
            "three equal-bar eras [{start, end, n, mean_ret}] — era visibility (evidence-only)"
        ),
        "by_target.ret_quantiles": (
            "{p10, p25, p50, p75, p90} of this pool's closed returns, linear-interpolated order "
            "statistics in summary.outcome units (EXCESS when benchmarked) — the typical-"
            "observation read (evidence-only). No n of its own: the pool is "
            "by_target.n. Null at every point on an empty pool"
        ),
        "by_target.worst_ret": (
            "the single worst closed observation of this pool, same units as mean_ret "
            "(evidence-only); null on an empty pool"
        ),
        "by_target.mae_quantiles / mfe_quantiles": (
            "{n, p10, p25, p50, p75, p90, worst | best} over the per-trade post-entry excursions "
            "on [fill, fill+h] — mae <= 0, mfe >= 0, both RAW path and NEVER benchmark-adjusted "
            "(evidence-only). Their own n may be BELOW by_target.n: a hole in "
            "the excursion window censors mae/mfe on a row whose ret closed. Null at every point "
            "when n is 0"
        ),
        "episode_stats": (
            "cross-target merged episode clusters over the cell's closed rows; the checklist "
            "reads only n and max_cluster_share_abs"
        ),
        "episodes": (
            "the time-ordered episode LEDGER under episode_stats: {entries: [{start, end, n, "
            "mean_ret, share_abs}], n_total, n_omitted, omitted_share_abs, cap} — earliest "
            "first, never ranked; truncation past the cap is explicit and mass-conserving; "
            "n_total == episode_stats.n_clusters (evidence-only)"
        ),
        "conditional_buckets / bucket_monotonicity": (
            "PER-CELL feature conditioning over the cell's own closed rows, pooled across its "
            "targets: per feature {buckets: [{bucket, n, mean_ret, hit_rate}], reason} with "
            "explicit refusal reasons, plus a per-feature Spearman {rho, sign} — there is no "
            "run-level pooled pair (evidence-only)"
        ),
        "feature_association": (
            "per feature × target {rho, n, reason} — Spearman between the entry-time feature "
            "snapshot and the realized closed ret within one target's time axis; per-target "
            "in BOTH modes; no p-value, deliberately (evidence-only)"
        ),
        "pooled": (
            "BASKET CELLS ONLY (absent — not null — on conjunction cells): the cell's one "
            "cross-target evidence pool over the concatenated (bar × member) closed rows in "
            "target-declaration order — the panel the basket rubric grades instead of "
            "per-member floors"
        ),
        "pooled.n / n_eff": (
            "closed pooled observations, and the greedy NON-OVERLAPPING count over them — the "
            "same n_eff kernel as by_target (one meaning engine-wide), so same-bar firings "
            "across members collapse to ONE independent observation; the checklist "
            "reconciles both and grades them against the support floors"
        ),
        "pooled.mean_ret / hit_rate": (
            "pooled-panel twins of the by_target pair, same units; mean_ret > 0 is the basket "
            "support sign read"
        ),
        "pooled.t_hac / hac_se": (
            "event-time overlap HAC over the pooled rows, df = pooled.n_eff - 1 — same-bar "
            "cross-member pairs enter at full Bartlett weight (cluster-robust for free), same "
            "anti-conservative caveat (evidence-only)"
        ),
        "pooled.rot_p": (
            "COMMON-SHIFT rotation null — one shift rotates every member's mask as a block, "
            "preserving the per-bar cross-sectional pattern; see caveats.pooled_rot_p "
            "(evidence-only)"
        ),
        "pooled.concentration": (
            "{top_share_abs, n_top, top_frac} over the POOLED rows — the top-share read basket "
            "concentration grades INSTEAD of the per-target layer"
        ),
        "pooled.member_share": (
            "{by_target, max_member_share_abs} — each member's share of the pooled |return| "
            "mass; the checklist reads ONLY max_member_share_abs (the one-name-basket "
            "detector), by_target is attribution and never a ranking"
        ),
        "pooled.boot / subperiods / ret_quantiles / worst_ret / mae_quantiles / mfe_quantiles": (
            "pooled twins of the by_target evidence blocks (boot resamples cross-member-merged "
            "episodes; every by_target caveat carries over), evidence-only"
        ),
        "outcome_coverage": (
            "per target {n_attempted, n_closed, exit_reasons} — 'open' is ALLOWED at any count "
            "(end-of-data right-censoring is structural); no_outcome / no_benchmark are data "
            "holes and refuse"
        ),
        "signal_coverage": (
            "per target {n_bars, n_undefined} — post-warmup bars where the entry condition was "
            "UNDECIDABLE; any > 0 refuses. n_bars == summary.n_bars always (pure geometry)"
        ),
    },
    "stats_table": {
        "row": (
            "one row per (param combo × target) pool with >= 1 CLOSED observation — a pool "
            "whose every firing is censored has NO row (the cells panel still carries it)"
        ),
        "median_ret / std_ret": "per-pool descriptives over closed returns (std ddof=1)",
        "win_loss_ratio": "mean(wins) / |mean(losses)|; null when one side is empty",
        "skewness / kurtosis": "pool shape; kurtosis is PEARSON (normal = 3), not excess",
        "tail_ratio": "|p95 / p5| of the closed returns",
        "cvar_5": "mean of the returns at or below the 5th percentile (historical CVaR)",
        "mean_bars_held / median_bars_held / max_bars_held": (
            "trivially the horizon on closed pools"
        ),
        "sharpe": "per-observation mean/sd, UN-annualized, gross of costs",
        "firing_rate": "ALL firing bars (censored included) / n_bars — trigger sparsity",
        "t_hac / hac_se / rot_p / n_eff": (
            "the same per-pool reliability reads the cells panel carries"
        ),
    },
}

CSV_FORMAT: dict[str, JsonValue] = {
    "encoding": "UTF-8 (BOM tolerated)",
    "timestamp_column": "a column named 'datetime' (case-insensitive), else the first column",
    "timestamp_format": (
        "strict ISO-8601 (YYYY-MM-DD or full timestamp), timezone-NAIVE, unique, sorted "
        "ascending; no other date format is ever guessed"
    ),
    "value_columns": (
        "plain numbers; the only missing-value markers are an empty cell or 'nan'; "
        "no thousands separators, no currency symbols"
    ),
    "ohlcv_shape": (
        "columns open,high,low,close (+optional volume, others): high>=max(open,close), "
        "low<=min(open,close), prices>0, volume>=0 — violations refuse, never clamp"
    ),
    "series_shape": "one or more named numeric columns (a yield, a P/E, an index …)",
    "warnings_never_refuse": "NaN holes, crash-sized moves, calendar gaps (warned, admitted)",
}

#: The checklist contract (``seikan schema`` self-description). ONE checklist
#: — two rubrics, selected per run by the summary's stamped ``target_mode``, applied identically
#: to every declared cell — no profiles, no per-cell exemptions, nothing the caller can select
#: into. ``policy_version`` (stamped into ``gate``) names the checklist semantics; two cells'
#: results are comparable only under the same version.
GATE_CONTRACT_DOC: dict[str, JsonValue] = {
    "contract": (
        "one checklist, applied to EVERY declared parameter × horizon cell independently "
        "(the summary's target_mode stamp selects the rubric cross-target reads "
        "are graded under, and a missing stamp refuses): three run-level checks reported once "
        "in run_checks, five per-cell checks "
        "in every cells[i].checks, each {name, passed, observed, threshold, detail}. "
        "No short-circuit — every check is always evaluated and always reported — and no "
        "verdict: the gate section is {policy_version, n_cells, n_passed, run_checks, cells}, "
        "index-aligned with summary.cells. A cell's `passed` is the conjunction of its own five "
        "checks AND all three run-level checks, so a run-level failure fails every cell and a "
        "caller reading cells[i].passed gets the complete answer without ANDing sections itself"
    ),
    "claim": (
        "exit 0 certifies ONLY that the run completed and every nominated output was written — the "
        "report, when one was nominated, is complete — and it is not a "
        "verdict. A cell's `passed` is a completeness / support / concentration checklist with NO "
        "significance claim and NO positive-expected-return certification: nothing in it is a "
        "test, and mean_ret > 0 is a sign read on the realized sample. Selection among cells and "
        "cross-cell multiplicity are the CALLER's, priced against n_hypotheses_attempted"
    ),
    "evidence_basis": (
        "FULL SAMPLE, uniformly: every cell is graded on its own rows over the whole index "
        "(gate_evidence_basis == 'full_sample', verified as a drift detector). There is no "
        "holdout, no embargo, no tail and no split — so there is nothing to shop and nothing to "
        "reserve, and equally no out-of-sample confirmation to claim. The engine measures every "
        "declared cell and reports each one; it does not select, rank, or crown a winner"
    ),
    "thresholds": (
        "canonical-as-floor: every knob constructs only at its default or STRICTER (exit 3 "
        "thresholds_invalid otherwise), so a cell reported as passed always means "
        "at-least-canonical rigor and the party being graded cannot bend the checklist it is "
        "graded by. Four knobs, no optional ones: thesis_min_trades, thesis_min_n_eff, "
        "thesis_max_concentration, thesis_max_hypotheses"
    ),
    "run_checks": {
        "evidence_complete": (
            "statistics_version matches this build and gate_evidence_basis == full_sample (a "
            "summary from another estimator revision refuses ungraded rather than being graded "
            "by the wrong rubric); targets is a non-empty list of STRINGS; the outcome stamp "
            "(the measurement algebra every reported number is denominated in) is the explicit "
            "{series, kind} dict the runner always stamps — a null or partial stamp refuses as "
            "drifted input; the target_mode stamp is 'conjunction' or 'basket' — "
            "it SELECTS the rubric every cross-target read is graded under, so a missing or "
            "garbage stamp refuses fail-closed, and a basket stamp over fewer than two targets "
            "or a diff outcome refuses as drifted input (validation refuses both upstream; the "
            "gate re-refuses, never trusts); n_hypotheses_attempted and n_bars "
            "are countable and "
            ">= 1; the sources "
            "panel is string-keyed and covers the target set EXACTLY; and cells is a list "
            "holding EXACTLY n_hypotheses_attempted entries — every declared combo × horizon on "
            "the record, non-firing ones included, because a report missing declared cells has "
            "dropped hypotheses from the search burden it declares. NaN/±inf/non-integral reads "
            "refuse"
        ),
        "source_coverage": (
            "fail-closed availability contract over the RAW decision inputs, run-level because "
            "it is combo-independent: per target sources.n_missing == 0 — every leaf the entry "
            "tree reads (Field/External/DaysSince) available on every bar of the evaluated "
            "interval after its own first available bar — with sources.n_bars == summary.n_bars, "
            "every per-source count in 0..n_bars, and the union no larger than the sum of parts. "
            "This is the layer the per-cell three-valued signal_coverage ledger structurally "
            "cannot see: an operand hole absorbed by a decisive sibling (Kleene F and U = F "
            "leaves the root DEFINED) and a hole a NaN-skipping recursive kernel (ema, expanding "
            "aggregates, bars_since_extremum) carried its state across both decide cleanly while "
            "data is missing. A source that merely STARTS LATE is warmup, not a hole — its "
            "first_available is reported as evidence. Unconditional, with no threshold knob"
        ),
        "search_cap": (
            "n_hypotheses_attempted (the DECLARED grid — non-firing combos cannot shrink it) "
            "<= thesis_max_hypotheses. The only multiplicity input this policy carries: cells "
            "are graded independently and no cross-cell correction is taken, so the cap bounds "
            "how wide a search one run may declare and the caller prices its own selection "
            "against the stamped number"
        ),
    },
    "cell_checks": {
        "cell_evidence": (
            "the cell entry is a dict with a dict params (its identity — the axes plus the "
            "horizon, always present); by_target, outcome_coverage and signal_coverage are "
            "string-keyed and cover the target set EXACTLY (a silently dropped target fails here "
            "rather than passing by absence); every count is countable and non-negative; the "
            "ledger arithmetic holds per target (sum(exit_reasons) == n_attempted, n_closed == "
            "exit_reasons.horizon); and the panels RECONCILE — by_target.n == "
            "outcome_coverage.n_closed, n_eff <= n, episode_stats.n == the per-target total, "
            "signal_coverage.n_bars == summary.n_bars. Basket cells additionally carry the "
            "pooled dict their rubric grades, reconciling with the member panels (pooled.n == "
            "the per-target total, pooled.n_eff <= pooled.n, pooled.n_eff <= n_bars, pooled.n "
            "<= n_bars × len(targets)); a pooled key on a conjunction cell REFUSES as a "
            "restamped basket (the runner writes pooled only in basket mode), and a "
            "missing target_mode stamp refuses. An internally impossible summary is "
            "drifted input, not something to grade"
        ),
        "outcome_coverage": (
            "fail-closed missingness contract: per target, exit_reasons.no_outcome == 0 and "
            "exit_reasons.no_benchmark == 0 — a data hole that deletes outcomes can hide adverse "
            "results, and missing-at-random is never assumed. exit_reasons.open is ALLOWED at "
            "any count: with no holdout there is no embargo and no tail, so a forward window "
            "running past the last bar is structural end-of-data right-censoring, not a data "
            "hole. An in-bounds NaN leg is never 'open' — it classifies as "
            "no_outcome/no_benchmark upstream and refuses here"
        ),
        "signal_coverage": (
            "fail-closed DECISION-side contract, the twin of outcome_coverage: per target "
            "n_undefined == 0 (no post-warmup undecidable decision bar — init & ~defined under "
            "the engine's three-valued evaluation) and n_undefined <= n_bars. The outcome ledger "
            "only accounts for bars that FIRED, so a missing input that suppresses a firing "
            "leaves no trace there; without this check, deleting the inputs under adverse "
            "firings would improve a cell unseen. The raw inputs underneath are graded once, "
            "run-level, by source_coverage. Unconditional, with no threshold knob"
        ),
        "support": (
            "the SAME sealed floors under the rubric target_mode selects: n >= "
            "thesis_min_trades AND n_eff >= thesis_min_n_eff AND mean_ret > 0. Conjunction — "
            "per target over the cell's own full-sample rows, the weakest target decides "
            "(targets are the thesis's regime). Basket — the members form ONE evidence pool: "
            "the pooled block clears the floors and no member is examined alone, so a thin "
            "member does not sink a basket cell. A missing target_mode stamp refuses. Evidence "
            "floors, deliberately NOT an inferential "
            "claim — no t-statistic or p-value gates, because the rotation rot_p and the "
            "overlap-HAC t are known anti-conservative and stay evidence-only"
        ),
        "concentration": (
            "one universal ceiling (thesis_max_concentration), dispatched by target_mode. "
            "Conjunction: every regime target's concentration.top_share_abs AND the cell's "
            "episode_stats.max_cluster_share_abs (the largest merged cross-target episode "
            "cluster's mass) — a one-episode edge refuses. Basket: "
            "pooled.concentration.top_share_abs REPLACES the per-target layer, the "
            "episode-cluster ceiling stays ('not one crisis'), and "
            "pooled.member_share.max_member_share_abs joins them ('not one name' — the "
            "one-name-basket detector; a missing member-mass decomposition refuses). A missing "
            "target_mode stamp refuses; a diff-outcome multi-target run refuses the "
            "cross-target mass read as incommensurable, and so does a missing, null, or "
            "unreadable outcome stamp"
        ),
    },
    "evidence_only": (
        "rot_p, t_hac/hac_se, the summary.pbo block (CSCV), t_iid/p_iid, per-cell "
        "sharpe/firing_rate and the distribution-shape descriptives, the per-target boot "
        "episode-bootstrap CI and subperiods era panel, the run-level bar_spacing stamp and "
        "baseline panel, the "
        "episode_stats panel beyond the two fields the checklist reads, the per-cell episodes "
        "ledger, conditional_buckets/bucket_monotonicity and feature_association, and — in "
        "basket — every pooled field beyond {n, n_eff, mean_ret, concentration.top_share_abs, "
        "member_share.max_member_share_abs}, including member_share.by_target (attribution, "
        "never a ranking) all ride in the summary as EVIDENCE and no "
        "check reads them — see metric_roles (and its caveats map) for why"
    ),
    # The prose rationale behind the compact ``metric_roles`` map (which the run report and
    # ``seikan schema`` both stamp identically). It lives HERE, under its own key, so
    # ``metric_roles`` itself is never a dict in one command and a list-of-prose in another.
    "metric_roles_rationale": METRIC_ROLES_DOC,
}

#: What each exit code MEANS. They describe how far the RUN got — never how the evidence looked:
#: a completed run is exit 0 whatever its cells report, and 2/3/4 mean the run could not produce a
#: report at all.
EXIT_CODES: dict[str, JsonValue] = {
    "0": (
        "the command completed. For `run`: every nominated output was written and stdout stayed "
        "empty (the report, when one was nominated, is complete; per-cell results are inside "
        "gate.cells; the exit code is NOT a verdict and says nothing about any cell). The silence "
        "belongs to `run`, whose outputs are files — `check-data` and `schema` emit their own "
        "document on stdout at this same code"
    ),
    "2": "input data failed strict validation (see data_report)",
    "3": (
        "invalid request — an argparse usage error (including a run that nominates no output), an "
        "invalid thesis DSL or gate-threshold set, or an unusable nominated output path: one that "
        "is empty, unwritable, named by two flags at once, or names one of the thesis's own input "
        "CSVs (usage / dsl_invalid / thresholds_invalid envelope)"
    ),
    "4": "internal error",
}

#: The ``--trades-out`` CSV contract, column by column (nothing on stdout on success — the file
#: is the whole output; errors still emit the JSON envelope).
TRADES_CSV: dict[str, JsonValue] = {
    "command": (
        "seikan run <thesis.json> --trades-out <out.csv> (always overwrites; silent on success)"
    ),
    "rows": (
        "one per recorded OBSERVATION — firing bar × target × declared horizon, the WHOLE grid "
        "in one file (regroup on the leading param columns + target; there is no cell_id "
        "column). Censored firings ride along flagged by is_open/exit_reason and are excluded "
        "from every statistic. A firing on the FINAL bar anchors no observation and has NO row "
        "here — it rides --entry-flags-out"
    ),
    "columns": {
        "<swept axes>": (
            "one leading column per swept parameter axis, in summary.params order — the row's "
            "cell identity; absent when nothing is swept"
        ),
        "target": "the target the row belongs to (regime member or basket member)",
        "entry_time": (
            "ISO-8601 timestamp of the next-open ANCHOR bar t+1 — the firing bar is t; see "
            "entry_bar for the join rule"
        ),
        "exit_time": (
            "ISO-8601 timestamp of the exit bar (clamped to the final bar when censored)"
        ),
        "entry_bar": (
            "the FIRING bar's integer position on the joined index — the JOIN KEY to the "
            "entry-flags CSV's row position. Never join the two files on timestamps: entry_time "
            "is the anchor, one bar AFTER the firing the flags file marks"
        ),
        "entry_px": (
            "the measured value at the anchor (the target's open, or the outcome feed's value)"
        ),
        "exit_px": "the measured value at the exit bar; empty when censored",
        "bars_held": "the cell's declared horizon h (constant per cell)",
        "ret": (
            "the signed forward outcome over [t+1, t+1+h], denominated per summary.outcome "
            "(excess when benchmarked, direction-signed); empty on censored rows"
        ),
        "pre_ret": (
            "RAW drift INTO the entry over the same h-bar window, sign-aligned — negative means "
            "the series moved AGAINST the eventual position; the leakage canary"
        ),
        "mae": (
            "worst interim adverse mark over [fill, fill+h], RAW path (never "
            "benchmark-adjusted), <= 0; empty when censored"
        ),
        "mfe": (
            "best interim favorable mark over the same window, RAW path (never "
            "benchmark-adjusted), >= 0; empty when censored. A MARK, not an attainable exit — "
            "this engine has no exit rule"
        ),
        "bars_to_positive": (
            "first forward bar the measured path is back >= entry; empty if never, or censored"
        ),
        "bars_to_trough": "bars from fill to the MAE extremum; empty when censored",
        "exit_reason": (
            "horizon (closed) | open (end-of-data right-censoring — structural, the checklist "
            "allows it) | no_outcome / no_benchmark (in-bounds data holes — the checklist "
            "refuses them)"
        ),
        "is_open": (
            "True iff censored (any non-horizon exit_reason); censored rows carry no statistics"
        ),
        "<features>": (
            "one trailing column per entry-time feature snapshot, taken at the FIRING bar "
            "(defaults: ret_5, ret_20, vol_14)"
        ),
    },
    "join": (
        "join to --entry-flags-out ON entry_bar == that file's row position (the 0-based bar "
        "index of the joined index), NEVER on timestamps — a timestamp join is off by one bar "
        "(anchor vs firing). There are no epoch-ns entry_ts/exit_ts twins; the ISO times are "
        "the record"
    ),
    "derived_views": (
        "cells[*].episodes (and episode_stats) are DETERMINISTIC, DERIVABLE functions of this "
        "CSV — which is why there is no --episodes-out flag: take one cell's rows (regroup on "
        "the leading swept-axis columns; the horizon is a cell axis like any other), keep the "
        "CLOSED ones (is_open false), and greedily merge overlapping half-open "
        "[entry_time, exit_time) windows ACROSS targets — the SAME frozen overlap merge "
        "episode_stats runs. That reproduces the in-report ledger exactly, including past its "
        "cap: the report's episodes list truncates VISIBLY at `cap` entries (n_omitted / "
        "omitted_share_abs conserve the mass), while this CSV never truncates — rebuild the "
        "ledger from here when you need the entries past the cap"
    ),
}

#: The ``--root-series-out`` CSV contract (nothing on stdout on success — the file is the whole
#: output; errors still emit the JSON envelope).
ROOT_SERIES_CSV: dict[str, JsonValue] = {
    "command": (
        "seikan run <thesis.json> --root-series-out <out.csv> (always overwrites; silent on "
        "success)"
    ),
    "rows": "one per bar of the joined index; ISO-8601 'datetime' index column",
    "value_columns": (
        "one per deduplicated root series node — every Series operand of a threshold condition "
        "except bare constants, scalarized per param combo and rendered as an expression, e.g. "
        "percentile(iv30,80); '@<target>' suffix when several targets; '#N' suffix on a name "
        "collision (only the 'datetime' index name is reserved in this namespace)"
    ),
    "no_entry_flags": (
        "this CSV carries NO 0/1 entry-flag columns — it is the per-bar DECISION INPUT view, the "
        "evidence a caller reads to see why a bar did or did not fire. A bar that fired becomes a "
        "row of the --trades-out CSV instead, in observation shape; the 0/1 flags themselves ride "
        "the --entry-flags-out CSV, which is also the one output carrying a firing on the FINAL "
        "bar (it anchors no observation, so nothing in observation shape can represent it). "
        "Nominate all three flags and every view is on disk: decision inputs, observations, and "
        "the raw firing mask"
    ),
    "warmup": "transform warmup bars are empty cells (NaN)",
    "roundtrip": (
        "re-reads as a series-shaped strict CSV, unless a value column is entirely NaN (a window "
        "longer than the data) or the thesis has no root series at all (every threshold operand a "
        "bare constant, leaving a datetime-only CSV) — the strict reader refuses both"
    ),
}

#: The ``--entry-flags-out`` CSV contract (nothing on stdout on success — the file is the whole
#: output; errors still emit the JSON envelope). The DECISION-side twin of ``ROOT_SERIES_CSV``:
#: that file says what the entry tree SAW on each bar, this one says what it DECIDED.
ENTRY_FLAGS_CSV: dict[str, JsonValue] = {
    "command": (
        "seikan run <thesis.json> --entry-flags-out <out.csv> (always overwrites; silent on "
        "success)"
    ),
    "rows": "one per bar of the joined index; ISO-8601 'datetime' index column",
    "flag_columns": (
        "one 0/1 INTEGER column per (param combo × target), in combo-iteration × target order: "
        "'entry' for a thesis with no swept entry axis, else 'entry[axis=value,...]' naming the "
        "combo, with an '@<target>' suffix only when several targets run. These names are "
        "canonical and unique BY CONSTRUCTION — one column per declared combo × target and no two "
        "combos are equal — so unlike the root-series namespace, where two rendered expressions "
        "can collide, there is no '#N' disambiguation here"
    ),
    "relation_to_trades": (
        "bit-identical to the firing mask the backtest measures at (both read vectorize.signal), "
        "but the two files are ONE-TO-MANY, not row-for-row: one flagged bar × target opens one "
        "--trades-out row PER DECLARED HORIZON, so a horizon sweep multiplies the trades rows "
        "against a flags matrix that does not change shape. EXCEPTION: a firing on the FINAL bar "
        "has no next open to anchor at — it opens no observation, has no trades row at any "
        "horizon and is counted in no outcome_coverage ledger. This file is where that firing "
        "appears, and it is what answers 'is my thesis firing NOW?'. JOIN ON `entry_bar`, NEVER "
        "ON THE TIMESTAMP: this file is indexed by the FIRING bar t, while a trades row's "
        "`entry_time` is the next-open ANCHOR bar t+1, so a timestamp join is off by one bar; "
        "`entry_bar` is the trades column that equals this file's row POSITION. (The bar-for-bar "
        "twin is the --root-series-out CSV, which carries the identical index.) Note also that a "
        "root-series column may legally be named 'entry' (an external feed the caller named "
        "that), so a same-named column ACROSS the two files is a different thing — a value "
        "there, a 0/1 decision here"
    ),
    "roundtrip": (
        "always re-reads as a series-shaped strict CSV: integer 0/1 throughout, no NaN (the "
        "tradable signal is defined on every bar — warmup and undecidable bars are simply 0), and "
        "at least ONE value column whatever it is named, since a thesis declares at least one "
        "combo and at least one target (see flag_columns for the naming — a multi-target run has "
        "no column called plain 'entry' at all). The two degenerate shapes that can defeat the "
        "root-series CSV — an all-NaN value column, a datetime-only frame — cannot arise here"
    ),
}

#: The role map stamped into every ``seikan describe`` document (and emitted identically by
#: ``seikan schema``): exactly what the document claims — pure data profiling, nothing more —
#: with one honest sentence per number a reader is likely to over-trust, so a market-context
#: figure never quietly hardens into a thesis. The field-by-field dictionary is
#: ``DESCRIBE_REPORT`` (schema-side only, the ``REPORT_FIELDS`` split).
DESCRIBE_ROLES: dict[str, JsonValue] = {
    "claim": (
        "pure data profiling: `describe` states what the FILES contain — levels, changes, "
        "dispersion, range position, missingness — and MEASURES NOTHING. It runs no entry "
        "condition, opens no observation, grades no checklist and supports no thesis: nothing "
        "it emits says a series is attractive or stretched in any sense beyond its own "
        "trailing range, and no field is a recommendation of any kind. Exit 0 means every "
        "file was admitted; exit 2 means at least one was refused — the document is still "
        "emitted, with a stub profile per refused file and check-data's own data_report "
        "naming why"
    ),
    "caveats": {
        "percentile_rank": (
            "position within the trailing window's OWN range — NOT valuation: a trending "
            "series sits at its extreme by construction, so 1.0 or 0.0 reads 'at the window "
            "extreme', never 'over- or under-priced'"
        ),
        "dispersion": (
            "ddof=1 std of 1-bar changes, PER BAR and never annualized — any sqrt-time "
            "scaling is the caller's assumption about a cadence this engine does not "
            "interpret"
        ),
        "volume": (
            "last_to_mean is a plain ratio and carries NO 'unusual' flag — what counts as "
            "elevated is the caller's judgment, not a property of the file"
        ),
        "drawdown": (
            "measured from the highest bar THIS FILE contains (runup from its lowest) — "
            "extend or trim the file and the number moves; a property of the file's extent, "
            "not of the instrument"
        ),
        "windows": (
            "BARS, never days — bar_spacing states the clock ({min,median,max}_seconds "
            "between consecutive bars), and translating '21 bars' into calendar language is "
            "the caller's act"
        ),
    },
    "scope_boundary": (
        "`describe` is a pure observer of FILES the way `run` is of THESES: it profiles the "
        "bytes it was handed as of their last bar, refuses what fails the strict contract, "
        "and never repairs, ranks, selects or forecasts. Nothing it emits clears any "
        "checklist or supports any thesis; a figure quoted from it should name the file and "
        "be dated to index_end. The moment a question pairs today's description with what "
        "FOLLOWED — position paired with subsequent returns — it is a thesis, and a thesis "
        "is measured by `seikan run` or it is not measured at all"
    ),
}

#: The ``describe`` document's field dictionary — the output-side reference for the profiling
#: subcommand, exactly as ``REPORT_FIELDS`` is for ``run``. Emitted by ``seikan schema`` only;
#: the describe document itself stays lean and carries the compact ``DESCRIBE_ROLES`` above.
DESCRIBE_REPORT: dict[str, JsonValue] = {
    "document": {
        "command": (
            "seikan describe <files...> [--shape {ohlcv,series}] [--windows N,N,...] "
            "[--pretty] — one JSON document on stdout"
        ),
        "layers": (
            "seikan_version -> report_schema_version -> command -> data_report -> profiles "
            "-> describe_roles, in this FIXED order"
        ),
        "exit_codes": (
            "0 every file admitted / 2 any file refused (the document is STILL emitted — "
            "refused files carry stub profiles) / 3 usage (bad --windows, no files) / 4 "
            "internal. check-data parity: data_report is byte-equal to what `seikan "
            "check-data` would emit over the same files and --shape, because it comes from "
            "the same strict read"
        ),
        "order": (
            "profiles[i] describes the i-th file of the ARGUMENT LIST — argument order, "
            "never sorted; data_report.files aligns with it"
        ),
        "windows": (
            "one comma-separated list of BAR counts, default 1,5,21,63,126,252, at most 16, "
            "emitted in the GIVEN order under every windowed block; windows are bars, never "
            "days (bar_spacing states the clock)"
        ),
        "bounded_output": (
            "no per-bar array ever rides the document — its size is independent of n_bars; "
            "the per-bar views belong to the files themselves"
        ),
    },
    "profile": {
        "path / sha256 / ok": (
            "the file, its raw-byte digest (the same identity data_report carries), and "
            "whether it was admitted. A refused file's whole profile is the stub {path, "
            "sha256, ok: false, reason} with reason = the data_report error codes — nothing "
            "about a refused file is ever invented"
        ),
        "shape": "'ohlcv' | 'series', as detected — --shape only refuses, never converts",
        "n_bars / index_start / index_end": (
            "geometry and extent, in the run summary's vocabulary"
        ),
        "bar_spacing": (
            "{min,median,max}_seconds between consecutive bars — the run summary's own "
            "clock-geometry stamp, null below two bars"
        ),
        "last_bar": (
            "{timestamp, values: {column: value | null}} — the final row VERBATIM, every "
            "column, NaN as null and never back-filled"
        ),
        "series": (
            "the per-column profile blocks {changes, dispersion, range_position, "
            "full_sample, missingness}. An OHLCV file profiles `close` only (the full bar "
            "rides last_bar); a series-shaped file profiles EVERY value column, in file "
            "order — describe profiles the FILE, so it never asks which column you meant "
            "and has no column flag at all. Choosing the column a RUN reads is the "
            "invocation's act, and it has its own spelling there: `seikan run --column "
            "KEY=COL`"
        ),
        "volume": (
            "OHLCV files with a volume column only, else null: {last, windows: {N: {mean, "
            "last_to_mean, reason, ratio_reason}}} — the last volume, the trailing mean per "
            "window, and their plain ratio (refused with ratio_reason when the mean is not "
            "positive); no 'unusual' flag exists"
        ),
    },
    "blocks": {
        "changes[N]": (
            "{diff, pct, log, reason, ratio_reason} — the N-bar change of the last level "
            "against the level N bars earlier. diff whenever both endpoints are finite; "
            "pct/log ONLY when both are strictly positive (the positivity "
            "rule — ratio algebras through zero mint garbage, so they refuse with "
            "ratio_reason 'non_positive_endpoint' while diff lives). A NaN endpoint refuses "
            "as 'endpoint_missing' and is NEVER repaired by skipping to the previous finite "
            "value. All three algebras ride with domain-nulls because choosing one would be "
            "the engine deciding what a series IS"
        ),
        "dispersion[N]": (
            "{diff, pct, log, reason, ratio_reason} — ddof=1 std of the N trailing 1-bar "
            "changes (the same N+1 trailing levels changes[N] reads), one per algebra under "
            "the same domain gates, PER BAR and never annualized. N=1 holds a single change "
            "and cannot carry a ddof=1 std (insufficient_bars); a hole in the window is a "
            "change with a missing endpoint (endpoint_missing), never skipped"
        ),
        "range_position[N]": (
            "{high: {value, timestamp}, low: {value, timestamp}, from_high: {diff, pct}, "
            "from_low: {diff, pct}, percentile_rank, reason, ratio_reason} — trailing "
            "extremes over EXACTLY the last N bars: a shorter file refuses as "
            "insufficient_bars (the window is never silently shortened) and a hole inside "
            "the window refuses as endpoint_missing (the extremum could be hiding in it). "
            "Ties resolve to the MOST RECENT bar (the bars_since_extremum rule). "
            "percentile_rank is the right-continuous empirical CDF of the last level within "
            "the window — the share of window levels <= it, in (0, 1]"
        ),
        "full_sample": (
            "{high, low, drawdown_diff, drawdown_pct, runup_diff, runup_pct, reason, "
            "ratio_reason} — whole-file extremes over the OBSERVED (finite) levels, "
            "most-recent tie rule, with the missingness block beside them stating the "
            "holes; drawdown_pct = last/high - 1 and runup_pct = last/low - 1 (diff twins "
            "always ride), both against the ACTUAL last level — a NaN last level refuses "
            "them (endpoint_missing) rather than substituting the previous finite value"
        ),
        "missingness": (
            "{n_missing, n_interior_missing, first_valid, last_valid} — pure counts and the "
            "valid extent; threshold-flavored warnings stay in the loader's data_report"
        ),
        "reasons": (
            "refusals are EXPLICIT and PRESENT, never omitted: every windowed block carries "
            "its entry for every requested window, with reason in {insufficient_bars, "
            "endpoint_missing} when the block refuses whole, and ratio_reason in "
            "{non_positive_endpoint} when only the ratio algebras refuse while diff lives"
        ),
    },
}
