## seikan

A **stateless CLI forward-return event-study engine and per-hypothesis reporter**, consumed by
other agents (e.g. Claude Code): thesis DSL JSON + strict CSV time series in → the outputs the
caller NOMINATES, one flag each, written as FILES. It backtests a thesis as an **observer-pure
forward-return event study** (entry condition + horizon; no exit, no portfolio simulation),
measures EVERY declared parameter × horizon cell over the full sample, applies ONE uniform
checklist to EACH CELL INDEPENDENTLY, and reports each cell's result beside its complete
statistics in ONE complete JSON report; the per-bar series the entry tree thresholds on ride their
own CSV, so a caller can see why a bar did or did not fire, and the per-bar firing mask itself rides
another. A thesis declares one of two **target modes** — `conjunction` (the default: the targets
are the thesis's regime, measured side by side with the weakest deciding) or `basket` (the targets
form ONE cross-section per bar: cross-sectional signal nodes and the `cross_mean` benchmark become
legal, and each cell is graded on a pooled cross-target panel instead of per-member floors). No
database, no home directory, no network, no persistence — a run is fully described by
its inputs, and two identical runs emit byte-identical reports.

**Seikan does not select, rank, or crown a winner.** There is no best cell, no headline scalar, no
verdict, and no search-adjusted statistic. Every declared hypothesis — including combos that never
fired — is measured and reported with its own nominal numbers. Choosing among the cells, and
pricing the multiplicity of having looked at `n_hypotheses_attempted` of them (across runs, DSLs
and data windows, which a single stateless run cannot see at all), is the CALLING AGENT's work.
The exit code is NOT a verdict: it reports how far the RUN got.

### the CLI contract

```
seikan run <thesis.json>         full-grid event study + the per-cell checklist, written to
    --data KEY=PATH ...          the files the caller NOMINATES. The thesis NAMES its series;
    [--column KEY=COL ...]       this invocation LOCATES and SHAPES them. At least ONE output
                                 flag is required (none → exit 3 `usage`, refused before the
                                 thesis file is read); each path is ALWAYS overwritten. SILENT
                                 on success: exit 0 prints NOTHING on stdout — the outputs are
                                 the files, and only an error ever puts JSON there.
  --data KEY=PATH                LOCATES one declared series: KEY is a target name, an external
                                 feed name (`FEED@TARGET` for one member of a per-target feed),
                                 or the reserved `benchmark`; repeat once per key. The set must
                                 answer the thesis's declared keys EXACTLY — a missing, unknown
                                 or duplicated key is exit 3 `usage`, decided before a byte of
                                 data is read.
  --column KEY=COL               SHAPES it: WHICH column of that key's CSV the key reads, over
                                 the SAME flat key namespace, matched case-insensitively.
                                 OPTIONAL per key — only a file holding several numeric columns
                                 needs one — and REFUSED for `benchmark`, which always reads
                                 its file's `open`. The members of one per-target feed may bind
                                 DIFFERENT columns.
  --report-out <path>            the complete statistical report; no time series ride it.
  --trades-out <path>            one row per observation — firing × target × horizon —
                                 with the post-entry path columns (mae/mfe, the RAW-path
                                 adverse and favorable excursions, plus the timing pair).
  --root-series-out <path>       per-bar VALUES of the root series nodes the entry tree
                                 thresholds on — WHY a bar did or did not fire. NO 0/1
                                 flags ride it: whether a bar fired is --trades-out's
                                 business (in observation shape) and --entry-flags-out's.
  --entry-flags-out <path>       the per-bar 0/1 firing matrix, ONE integer column per
                                 param combo × target, bit-identical to the backtest's
                                 mask. The ONLY output that can carry a FINAL-BAR firing,
                                 which anchors no observation and so has no trades row.
seikan check-data <files...>     pre-flight CSVs against the strict data contract. Exit 0/2.
seikan describe <files...>       pure data profiling for market-context prose: per-file levels,
                                 changes (all three algebras, domain-nulled), dispersion, range
                                 position, whole-file extremes, missingness, volume — bounded
                                 output, no per-bar arrays, and it MEASURES NOTHING (no entry
                                 condition, no forward observation, no checklist; describing is
                                 not evidence). Files profiled in argument order; `--windows`
                                 is trailing BAR counts (default 1,5,21,63,126,252, at most 16).
                                 One JSON document on stdout; exit 0 all admitted / 2 any
                                 refused (document still emitted, check-data parity) / 3 usage.
seikan schema [--markdown]       DSL JSON Schema + thresholds + the checklist contract + the
                                 report-field dictionary (`report_fields`) + the describe-side
                                 dictionaries (`describe_report` / `describe_roles`) + the input
                                 CSV contract and the three output-CSV contracts (`trades_csv` /
                                 `root_series_csv` / `entry_flags_csv`) + exit codes.
```

A thesis NAMES its series; the invocation LOCATES and SHAPES them. `data.targets` and
`data.external` declare logical keys and nothing else — no path, no column header — and the two
binding flags answer those keys over ONE flat namespace: a target name, a shared feed name,
`<feed>@<target>` for one member of a per-target feed, and the reserved `benchmark` when
`params.benchmark == "market"` asks for an excess-return source. `--data` says which CSV answers a
key; `--column` says which of that CSV's columns the key reads. Both are properties of whatever
file happens to answer the key — one vendor ships three yields in a single CSV under its own
spellings, another ships each in a file of its own — and neither is a property of the QUESTION: a
path or a header inside the document would let a re-pulled file or a renamed header move a
`dsl_hash` that nothing about the thesis had moved, and re-measuring the same thesis next month
would mean rewriting it. Neither lives in the DSL; what a feed entry fixes is the SEMANTIC read,
which is the only part a thesis is entitled to fix (`per_target`, `lag`).

The two flags are CHECKED differently, because they answer differently-shaped questions. The path
mapping must answer the declared keys EXACTLY: a missing key would load nothing where a series was
declared, so the run would measure a thesis it does not have; an unknown key is a caller holding a
different thesis in their head; a duplicated one would make the run choose which file it read, and
choosing silently answers a question nobody asked. All three are exit 3, decided before a byte of
data is touched. A column binding is OPTIONAL, because most keys are answered by a file that names
its own single value column and only a multi-column file needs one; what is refused ON SIGHT is a
binding that could not mean anything — a key this thesis never declares, and `benchmark`, which is
outcome MEASUREMENT sampled at the observation's own anchor bars and always reads its file's
`open`, leaving nothing there for a column to select. Whether the bound NAME answers these
particular bytes is a question only the bytes can answer, so it refuses one tier down instead
(exit 2, `spec_data_mismatch`): a binding aimed at an OHLCV target, which measures its
open-anchored prices and had no column to choose in the first place; a name no column carries, the
refusal listing the ones the file does hold; or a multi-column file with no binding at all, told to
bind one and which names are available. COL is lowercased at parse and matched case-insensitively
— the strict reader lowercases every header it admits — so the ONE spelling that reaches the loader
is also the one the report stamps. Binding per KEY is also WIDER than one document field could be:
the members of a single per-target feed may bind DIFFERENT columns, which a single DSL field could
not express. `check-data` and `describe` take no column flag and are not
missing one: they profile FILES, not bindings — a series file is profiled column by column —
because choosing the column a MEASUREMENT reads is the invocation's act, and it belongs to the
subcommand that measures.

Success is SILENT because the outputs ARE the files: a report on stdout would make every caller
buffer and re-parse a document it was going to write down anyway, and would force a result and an
error envelope to share one channel. A `run` puts an error envelope on stdout or nothing at all,
so a caller branches on the exit code and then reads the paths it itself
named — the silence belongs to `run`, whose outputs are files, and NOT to `check-data`,
`describe` or `schema`, which still emit their document there at exit 0. A
run that nominates NO output is refused BEFORE the thesis file is read — it can produce nothing
whatever the thesis says, so the refusal costs nothing and its `usage` type never depends on data
seikan has not looked at yet. The same refusal covers every nomination that cannot be honored AS
GIVEN: an empty path, two flags naming ONE file (the writes are sequential, so the later would
destroy the earlier while the report went on enumerating both), and an output aimed at one of the
RUN's own inputs — the thesis document itself, or any CSV a `--data` pair pointed a key at
(resolved, so a different spelling of the same file does not slip through).
That last one is the loader's refuse-never-mutate rule reaching the write side: an engine that will
not clamp an OHLC violation does not get to overwrite the evidence it is measuring and then stamp a
`data_digests` sha256 for bytes it deleted. Compute is likewise LAZY, matched to what was nominated:
`--report-out` or `--trades-out` runs the full-grid event study, while a run asking ONLY for the
listing outputs (`--root-series-out` and/or `--entry-flags-out`) takes the cheaper listing path — no
backtest, and no requirement that the index be long enough to close one observation at the longest
horizon. Both listings are DECISION-side artifacts no forward window ever touches, so demanding the
horizon runway for them would refuse a legitimate request on the strength of a measurement nobody
asked for. When both kinds are nominated the backtest runs FIRST, so every data refusal surfaces
from the strict path, whose checks are a superset of the listing's — and the market data is loaded
exactly ONCE per run, after request validation, with the one materialized `MarketData` shared by
both compute paths. That `MarketData` carries the run's one evaluation memo (`md.cache`), so every
series and condition is built at most once per run, whichever path asks first — a listing after a
backtest rebuilds nothing.

Tiered exit codes describe how far the RUN got, never how the evidence looked: **0** run
completed — every nominated output was written, and the report, when one was nominated, is
complete (per-cell results live in `gate.cells`) · **2** input data
failed strict validation (`data_report` says exactly what and where — including a column binding
these particular bytes cannot honor) · **3** invalid request — an argparse usage error (INCLUDING a
run that nominates no output at all, a `--data` mapping that does not answer the thesis's declared
keys exactly, and a `--column` bound to a key the thesis never declares or to `benchmark`), an
invalid thesis DSL or gate-threshold set, or an unusable nominated output path — empty, unwritable,
named by two flags at once, or naming one of the run's own inputs — the last group checked before
the O(grid × length) work rather than after it (`usage` / `dsl_invalid` / `thresholds_invalid`
envelopes) · **4** internal error. Every seikan-DETECTED error prints a machine-readable JSON
envelope on stdout (`--help`/`--version` are conventional non-JSON exit 0, and a SIGINT is Python's
default with no envelope); humans get one line on stderr. Nothing a checklist reports can move the
exit code.

The DSL holds neither locating fact — not a path, not a column name. `data.targets` is a list of
NAMES, a feed declares
`per_target` and `lag` rather than a file, and there is no benchmark path — the run's binding is
stamped into `identity.data_digests` as `key → {path, column, sha256}` instead, which is where a
locating fact belongs. A thesis that names a path or a column anyway is exit 3 `dsl_invalid` under
`extra="forbid"`. The refusal is the point rather than the cost: keeping those facts out of the
hashed document is the whole reason they are not in it.

Every JSON document — the `run` report, `check-data`, `describe`, `schema`, and every error
envelope — opens
with the same top-level header `{seikan_version, report_schema_version, command}`
(`report_schema_version` **1**); an error envelope then carries `error: {type, message, errors?}`
with `type` ∈ {usage, data_invalid, dsl_invalid, thresholds_invalid, internal}. The `run` report —
the file `--report-out` nominates, never stdout — has ONE FIXED layer order after the header, no
variants, so a reader never has to discover which keys this particular invocation happened to
produce: `identity` (`name`, `dsl_hash`, `data_digests` — one entry per data key the thesis
declares, `{path, column, sha256}` — the `thresholds` snapshot actually used,
`thresholds_canonical` (True iff every knob equals its class default) and
`thresholds_provenance` (per knob: `default`|`env`|`cli` — the SOURCE, so an auditor tells a
stricter-via-flag run from a stricter-via-env one)) → `data_report` → `outputs` → `summary`
(verbatim) → `gate: {policy_version, n_cells, n_passed, run_checks, cells}` → compact `metric_roles`
(the exact claim + which fields each check consumes + what is evidence-only + a per-metric
`caveats` map — one honest sentence per over-trustable number, 18 keys: rot_p, t_hac, t_iid, boot,
pbo, sharpe, mean_ret, concentration, ret_quantiles, mae_quantiles, mfe_quantiles, baseline,
episodes, conditional_buckets, feature_association, pooled,
member_share, pooled_rot_p — travelling WITH the
report so the caveat rides beside the number it qualifies; the prose rationale lives in
`seikan schema` under `gate_contract.metric_roles_rationale`, and `metric_roles` itself is the SAME
compact object in the report and in `seikan schema`). `data_digests` is keyed by the LOGICAL key
and never by path: the key is what the thesis DECLARES and what two runs can be compared on, while
the path is only where this particular invocation found the bytes — so "the series this thesis
calls NVDA was that file, read out of that column, and it hashed to this" survives a re-pull as a
legible diff instead of a renamed row. Its `column` is ALWAYS present, and null when the key bound
none: a stamp that appears only sometimes reads as a different DOCUMENT rather than as a different
answer, and "nothing was bound, so the file named its own column" is a fact about the run worth
saying out loud. The sha256, being a property of the FILE's bytes, is shared by two keys that one
CSV happens to answer — each keeping its own column, which is precisely what the digest could not
say while it was keyed by path. `outputs` is ONE block keyed in
nomination order — `report` → `trades` → `root_series` → `entry_flags` — holding only the outputs
this run actually nominated, each with its `path` plus, for each CSV, `rows_written`; a flat
`trades_rows_written`/`trades_path` pair could only ever describe one of four
files and say nothing about the three it did not name. It always contains `report`, since the
document carrying it exists only because `--report-out` asked for it — and the report is written
LAST, after every other nominated output has landed, so a document enumerating files that never
appeared is not a state this CLI can reach. There is no top-level `n`: a scalar observation count
would have to be some cell's, and naming one cell is the selection this engine does not perform.
`policy_version` (**1**) names the checklist semantics (two cell results compare only
under the same version); `summary.statistics_version` (**1**) names the engine's
estimator revision the same way.

The summary is a GRID, not a headline. Run-level keys are geometry and provenance only —
`n_bars`, `index_start`/`index_end`, `bar_spacing` ({min,median,max}_seconds between consecutive
bars — the clock geometry a horizon-in-bars is denominated in), `n_hypotheses_attempted`,
`direction`, `benchmark`/`benchmark_source`, `outcome` (ALWAYS the explicit
`{series, kind, units}` dict — never null; `units` derives from the algebra:
pct→`fraction`, log→`log`, diff→`level_diff`), `target_shape`, `target_mode` (ALWAYS
stamped — `conjunction` | `basket`, the target semantics every cross-target read was
produced under; the checklist dispatches its rubric on it), `statistics_version`,
`gate_evidence_basis`, `params`/`targets`/`n_stats_rows` (the row count of `stats_table` — pools
with ≥ 1 closed observation), `rotation`, the per-target `sources` availability panel, the
grid-level CSCV `pbo` block (ONE nested object: `{pbo, reason, n_splits, n_combos, blocks,
lambda_mean, oos_degradation_slope, prob_oos_loss}`; its split score is mode-aware — the
weakest-target per-observation Sharpe under conjunction, the pooled per-observation Sharpe under
basket), `baseline` (the run-level unconditional base rate per horizon × target
over every fillable anchor bar, same algebra/benchmark/direction as the cells, with an
`exclusions` ledger pinned by `n_eligible + Σexclusions == n_anchor_bars`, a `pooled` row per
horizon in basket, and deliberately NO uplift field — the conditional-vs-base-rate comparison is
the caller's), and the descriptive `stats_table`/`by_target`/
`by_param` rollups (each `stats_table` row carrying the full per-pool descriptive set).
Conditioning is PER-CELL and never run-level: a pooled qcut would re-enter the same bar once per
combo × horizon, so adding a cell would change every other cell's conditioning. The
report's spine is
`summary.cells`: ONE entry per declared combo × horizon, in declaration order, INCLUDING those
that never fired (an explicit zero/NaN record), each carrying `cell_id`, `params` (the axes plus
the horizon, always present), `by_target` (n / n_eff / mean_ret / hit_rate / t_hac / hac_se /
rot_p / concentration, plus the evidence blocks `boot` — the per-target
episode-bootstrap percentile CI — and `subperiods` — the pool's n / mean over three equal-bar
eras — and `ret_quantiles` {p10,p25,p50,p75,p90} + `worst_ret` over
the closed returns, and `mae_quantiles` / `mfe_quantiles` — the same five points plus worst/best
over the RAW post-entry excursions, each carrying its OWN n, which can sit below the cell's n
because an excursion-window hole censors the path column on a row whose `ret` closed),
`episode_stats`, the evidence blocks — `episodes` (the time-ordered,
mass-conserving episode ledger, capped at 32 with explicit truncation and `n_total ==
episode_stats.n_clusters`), `conditional_buckets`/`bucket_monotonicity` (per-cell, pooled across
the cell's own targets with explicit refusal reasons) and `feature_association` (per-target
Spearman, no p-value) — plus, on BASKET cells only (absent, not null, on conjunction cells),
`pooled`: the cell's one cross-target evidence pool over the concatenated (bar × member) closed
rows (n / n_eff / mean_ret / hit_rate / t_hac / hac_se / rot_p / concentration / `member_share`
— the full per-member mass decomposition plus `max_member_share_abs` — boot / subperiods /
ret_quantiles / worst_ret / mae_quantiles / mfe_quantiles), the panel the basket rubric grades
while `by_target` stays as attribution, and `outcome_coverage` and `signal_coverage`.
`len(summary.cells) == n_hypotheses_attempted` holds by construction — the panel is driven off the
DECLARED grid recorded before anything about firing is known, never off the trades frame, because
a non-firing hypothesis is precisely the one whose absence makes a surviving cell look inevitable.
`gate.cells[i]` is index-aligned with `summary.cells[i]`.

**The checklist contract (policy v1 — ONE checklist, applied to every cell independently)**:
three run-level checks reported once in `run_checks`, five per-cell checks in every
`cells[i].checks`, each `{name, passed, observed, threshold, detail}`. A cell's
`passed` is the conjunction of its own five checks AND all three run-level checks — a run-level
failure fails every cell, so a caller reading `cells[i].passed` never has to AND the sections
itself — and `n_passed` counts on that definition. ONE stamp selects between two rubrics: the
summary's `target_mode` names the target semantics every cross-target read is graded under —
conjunction (per-target floors and ceilings, the weakest target decides) or basket (the members
form one evidence pool: `support` reads the pooled floors,
`concentration` the pooled ceilings, `cell_evidence` reconciles the pooled panel against the
member panels). A missing or unreadable stamp refuses fail-closed everywhere it would have
dispatched — grading under an assumed mode is the stamp-stripping bypass one field over.

What a per-cell `passed` MEANS, exactly: the cell's evidence is completely measured (every firing
accounted for, every decision bar decidable, every raw decision input available), it clears the
raw support floors on FULL-SAMPLE evidence — per target under conjunction, on the pooled panel
under basket — and its return mass is not one episode (nor, in basket, one member). **It is NOT
an inferential claim.** There is no significance claim and no positive-expected-return
certification; `mean_ret > 0` inside `support` is a sign read on the realized sample, not a test.
Nothing in the checklist is a test at all — there is no holdout, no embargo, no tail and no sign
test, so there is nothing to shop and nothing to reserve, and equally no out-of-sample
confirmation anyone may claim. Exit 0 certifies only that the run finished and every nominated
output was written.

The three RUN-LEVEL checks: `evidence_complete` (the summary must carry the evidence this
checklist grades, under the contract it was built against — `statistics_version` == current,
`gate_evidence_basis == "full_sample"`, a target list that is a non-empty list of STRINGS (a
non-string name indexes no panel and would crash `sorted`), an EXPLICIT `outcome` stamp — the
`{series, kind}` dict the runner always writes, naming the algebra every reported
number is denominated in; a null stamp is stripped input and refuses — a
readable `target_mode` stamp in {conjunction, basket}, since the stamp SELECTS the rubric (a
missing or garbage stamp refuses fail-closed, and a basket stamp over fewer than two targets or
a `diff` outcome refuses as drifted input: DSL validation refuses both upstream, and the gate
re-refuses rather than trusts) —
countable `n_bars` and
`n_hypotheses_attempted` ≥ 1, a string-keyed `sources` panel covering the targets EXACTLY, and a
`cells` list holding EXACTLY `n_hypotheses_attempted` entries — a report short of the declared
grid has dropped hypotheses from the search burden it declares, which is drifted input, not
evidence); `source_coverage` (the fail-closed availability contract over the RAW decision inputs,
run-level because it is combo-independent: per target `sources.n_missing == 0` — every leaf the
entry tree reads (`Field`/`External`/`DaysSince`) available on every bar after its own first
available bar — with `sources.n_bars == summary.n_bars`, every per-source count in `0..n_bars`,
and the union no larger than the sum of parts; a source that merely STARTS LATE is warmup, not a
hole, and `first_available` is evidence, never a refusal; no knob); and `search_cap`
(`n_hypotheses_attempted` — the DECLARED grid, which non-firing combos cannot shrink — ≤ 64, the
ONLY multiplicity input this policy carries).

The five PER-CELL checks: `cell_evidence` (the entry is a dict with a dict `params`; `by_target`,
`outcome_coverage` and `signal_coverage` are string-keyed and cover the targets EXACTLY — a
silently dropped target fails here rather than passing by absence; every count is countable and
non-negative; the ledger arithmetic holds per target (`sum(exit_reasons) == n_attempted`,
`n_closed == exit_reasons["horizon"]`); and the panels RECONCILE — `by_target[t].n ==
outcome_coverage[t].n_closed`, `n_eff ≤ n`, `episode_stats.n` == the per-target total,
`signal_coverage[t].n_bars == summary.n_bars`: an internally impossible cell is drifted input, not
something to grade. Basket cells must ADDITIONALLY carry the `pooled` dict their own rubric
grades, reconciling with the member panels: `pooled.n ==` the per-target total (one pool, fully
attributed), `pooled.n_eff ≤ pooled.n`, `pooled.n_eff ≤ n_bars` (same-bar cross-member firings
collapse in the greedy count, so it is bounded by the bar clock), `pooled.n ≤ n_bars ×
len(targets)` (each member fires at most once per bar); a `pooled` key on a conjunction cell
REFUSES — the runner writes pooled only in basket mode (absent, not null, on conjunction
cells), so the configuration is the signature of a RESTAMPED basket and refusing it costs zero
honest refusals (`evidence_complete` re-refuses `benchmark='cross_mean'` under a conjunction
stamp by the same logic); a missing `target_mode` stamp refuses — whether a pooled panel is
part of the cell's contract is then undeterminable); `outcome_coverage` (fail-closed missingness on the
OUTCOME side: per target
`no_outcome == 0` and `no_benchmark == 0` — a data hole that deletes outcomes can hide adverse
results, and missing-at-random is never assumed. **`open` is ALLOWED at any count**: with no
holdout there is no embargo and no tail, so a forward window running past the last bar is
structural end-of-data right-censoring every cell near the index end must exhibit, and refusing it
would refuse the calendar rather than a data defect. An in-bounds NaN leg is never `open` — it
classifies as `no_outcome`/`no_benchmark` upstream and refuses here); `signal_coverage` (the
fail-closed DECISION-side twin, pooled layer: per target `n_undefined == 0` and `n_undefined ≤
n_bars`. The outcome ledger can only account for bars that FIRED, so a missing decision input
suppresses the firing itself and leaves no trace there — without this check, deleting the inputs
under adverse firings would improve a cell unseen. The raw inputs underneath are graded once,
run-level, by `source_coverage`, which catches the two hole classes this channel structurally
cannot see: Kleene absorption (`F∧U = F` leaves the root DEFINED while an operand is holed) and a
NaN-skipping recursive kernel (EMA, expanding aggregates) carrying contaminated state across a
hole and emitting a finite value. No knob. BOTH coverage checks — and `source_coverage` — stay
PER-TARGET in BOTH modes: a hole in one basket member corrupts every member's cross-sectional
reads, so per-member fail-closed is structurally required even in a basket); `support` (the same
three sealed floors — `n ≥ 30`, `n_eff ≥ 8`, `mean_ret > 0` — read from the panel the
`target_mode` stamp selects: under conjunction per target, over the cell's OWN full-sample rows,
the weakest target deciding, since the targets are then the thesis's regime; under basket on
`pooled.{n, n_eff, mean_ret}` — the members form ONE evidence pool, floors read the pooled
panel and never per member, so a thin member does not sink a basket cell, because the basket
claim is about the pool, not about any name in it — deliberately NOT an inferential claim
either way, no t-statistic and no
p-value gates); and `concentration` (one universal ceiling, dispatched by the same stamp: under
conjunction over every regime target's
`concentration.top_share_abs` AND the cell's `episode_stats.max_cluster_share_abs`, the largest
merged cross-target episode cluster — a one-episode edge refuses; under basket the pooled read
REPLACES the per-target layer (`pooled.concentration.top_share_abs`), the episode-cluster
ceiling stays ("not one crisis"), and `pooled.member_share.max_member_share_abs` joins them —
the one-name-basket detector ("not one name"), same sealed ceiling, no new knob. A
`diff`-outcome multi-target
run refuses the cross-target mass read as incommensurable, as does a MISSING, NULL, or unreadable
outcome stamp, since stripping it would otherwise bypass the guard and accepting a null is the
same bypass one spelling over — retained in basket as defense-in-depth even though
`evidence_complete` already refuses basket+diff).

Fail-closed, never crash: an unreadable `cells` panel fails `evidence_complete` and yields
`n_cells` 0 / `n_passed` 0 / `gate.cells == []` — and the CLI still exits 0; a malformed
INDIVIDUAL cell entry gets a failing `cell_evidence` with a detail while its siblings grade
normally; NaN / ±inf / non-integral reads refuse per read. Nothing short-circuits: every check is
always evaluated and always reported.

The uncalibrated statistics are EVIDENCE, never inputs: `rot_p` (the rotation null over-certifies
under signal-aligned volatility regimes), `t_hac`/`hac_se` (the overlap HAC understates its SE),
the per-cell `boot` episode-bootstrap CI (the dependence-robust counterweight to those two —
resamples overlap-connected episodes, so it is honest about clustered pools, but it assumes
episode independence and is itself uncalibrated), the `subperiods` era panel, `bar_spacing`,
the order-statistic blocks (`ret_quantiles`/`worst_ret` — the median-against-mean
read that exposes a pool a few spikes carried, which `concentration` structurally cannot, since
mild right skew concentrates no mass in one episode — and `mae_quantiles`/`mfe_quantiles`, RAW
path and so NOT commensurable with a benchmarked excess `ret`, tied together by overlapping
windows sharing one trough and one peak, and in the MFE's case a MARK rather than an attainable
exit, this engine having no exit rule), the CSCV `pbo` block, `t_iid`/`p_iid`, per-cell
`sharpe`/`firing_rate` and the distribution-shape descriptives, the episode panel beyond the two
fields the checklist reads, `baseline` (with its exclusions ledger
and cross_mean-identity caveat), the per-cell `episodes` ledger, the per-cell
`conditional_buckets`/`bucket_monotonicity` and `feature_association`, the pooled panel beyond
the fields the basket rubric reads (hit_rate, t_hac/hac_se, rot_p, boot, subperiods, the
quantile blocks), and `pooled.member_share.by_target` (the full member-mass decomposition —
attribution, never a ranking; only `max_member_share_abs` gates) — all ride in the summary and
no check reads them — `metric_roles` says so explicitly, and
its `caveats` map states each one's failure mode in the report itself. Cross-target STATISTICS
exist ONLY in basket mode, as the declared, graded `pooled` block — conjunction forms none — and
NEITHER mode selects among members: nothing anywhere in the report ranks the targets or crowns
one. There is no
search-adjusted statistic anywhere: no `fw_p`, no winner's-curse deflation,
no Romano-Wolf, no cross-cell BH-FDR. A correction computed inside one run only ever sees that
run's grid and silently understates a caller who searched across runs; the multiplicity belongs
to the caller, priced against the stamped `n_hypotheses_attempted`.

The policy is sealed as well as stamped: **the canonical checklist is the floor** — every knob
constructs only at its default or STRICTER, so a loosened exam is exit 3 (`thresholds_invalid`),
same as a nonsense value — and the `SEIKAN_*` env namespace is owned: an unknown/typo'd `SEIKAN_*`
var — any name that is not one of the four knobs, `SEIKAN_GATE_PROFILE` and
`SEIKAN_THESIS_OOS_ALPHA` included — is a hard error, never silently ignored. Scope boundary (stamped into
`metric_roles`): the checklist prices ONE cell of ONE run. It takes no cross-cell correction, and
cross-run/cross-DSL search discipline is invisible to a stateless reporter — but the identity
layer (`dsl_hash`, the per-key `data_digests`, `summary.index_start`/`index_end`) makes every
distinct exam visible so the caller can enforce its own budget. Deployment judgment is likewise the caller's.

### non-negotiable invariants

- **The engine's statistical mechanics are frozen** (`compiler/` + `analysis/` — the EVENT-TIME
  HAC t (Bartlett on actual entry-bar distances, df=n_eff−1), the circular-shift rotation null,
  `n_eff`, CSCV PBO, episode clustering and |return|-mass concentration, the descriptive panels).
  Any change here changes what a report MEANS — two reports compare only under the same
  `statistics_version`. Repackage, never rewrite; a
  correctness fix must bump `analysis.stats.STATISTICS_VERSION` (+ `gate.POLICY_VERSION` when the
  checklist's meaning moves) — never land silently. Those two constants are where the numbers are
  defined. The known rotation/HAC calibration caveats are
  documented in `stats.py` and `metric_roles`. Note what the checklist deliberately does NOT have:
  a false-activation rate. It makes no inferential claim, so there is nothing to calibrate — a
  null run's cells can and sometimes will pass, and a pass is not significance. Calibrating the
  evidence-only ESTIMATORS (`rot_p`, `t_hac`) under dependent/heteroskedastic nulls remains open
  statistical work.
- **The checklist never filters the summary.** The engine summary is embedded in the report
  VERBATIM — the complete parameter × horizon grid (`cells` with every declared hypothesis
  including non-firing ones, plus `stats_table`/`by_target`/`by_param`/per-cell reliability) —
  whatever any cell's result is. The per-cell results are a separate `gate` section in which EVERY
  check is reported for EVERY cell (no short-circuit), and they cannot move the exit code. See
  `gate.py` and the honesty invariant comment in `cli.py`.
- **Strict CSV is never relaxed.** ISO-8601 naive timestamps only (no format guessing — ambiguous
  dates are rejected, not interpreted; `data.start`/`data.end` obey the same strict parse, so a
  malformed bound is exit 3 rather than a silently reinterpreted window), forced-float values,
  OHLC invariants refuse rather than clamp (the loader never mutates evidence). **Multi-target
  runs require ONE bar clock**: unequal target indices refuse (exit 2, naming what is missing
  where) instead of being intersected — an intersection deletes a bar from EVERY target before any
  coverage ledger exists, so trimming rows under adverse firings would shrink the graded pool
  invisibly.
  Basket mode leans on that clock DOUBLY: a bar's cross-section — the thing `cross_rank` ranks
  and `cross_mean` averages — only exists because every member stamps the same bars, so the
  union-and-refuse rule is the basket's precondition, not merely its hygiene.
  Market-shaped anomalies (NaN holes, crash bars, gaps) warn but admit — crashes are the research
  subject. See `dataio.py`.
- **Refuse invalid input early and cheaply.** Non-finite numeric literals (`NaN`/`Infinity` —
  Python's JSON decoder accepts them, JSON proper has none) refuse at parse; a `params.features`
  key colliding with a trade column (`ret`, `is_open`, `target`, …) refuses at validation instead
  of silently overwriting the engine's own evidence or crashing a boolean index; and a DECLARED
  grid above the sealed search cap refuses at validation, BEFORE any data is read — such a grid can
  never pass `search_cap` under any legal thresholds, so the engine owes it neither a report nor
  the O(grid × length) work of producing one.
- **Hash discipline**: `canonical_dsl_hash` fills defaults and sorts keys, so omitted-default and
  explicit-default DSLs share one identity; adding a default-valued DSL field moves every stored
  hash, and callers keeping reports must re-validate rather than assume a stored hash still names the
  same thesis. Prefer new node types, which are hash-safe. `target_mode` is the discipline's one
  DELIBERATE exception: a mode is a property of the whole thesis, not of any node, so it has to be
  a default-valued field, and that cost is paid openly instead of being smuggled in.
  REMOVING a field moves every stored hash the same way (the
  normalization fills defaults over whatever the model still declares). File paths and column names
  sit OUTSIDE the hashed document for exactly this reason: the same exam over re-pulled or
  re-shaped data is ONE document rather than a new one every time the data layer moves, with the
  locating facts stamped in `identity.data_digests` where they
  belong.
- **Statelessness**: no SQLite, no `$SEIKAN_HOME`, no config file. Thresholds come from `SEIKAN_*`
  env vars overridden by CLI flags, and the snapshot used is stamped into every report.

### module map (`src/seikan/`)

- `cli.py` / `__main__.py` — argparse CLI, the four subcommands (`run`, `check-data`, `describe`,
  `schema`),
  tiered exit codes, the caller-nominated outputs (`_preflight_output` refuses an unusable path
  before the run, not after it) and the JSON report assembly (the honesty invariant lives here: the
  summary is embedded before the checklist runs, and `_cmd_run` returns `EXIT_OK` unconditionally,
  so the only thing a checklist result moves is the content of `gate`).
- `describe.py` — pure data profiling behind `seikan describe`: plain numpy/pandas, no numba, no
  RNG, and nothing imported from `compiler/`, `analysis/` or `gate.py` (one sanctioned read-only
  exception: the run summary's `_bar_spacing`, so the clock geometry is stamped in one vocabulary
  engine-wide). Admission is the SAME strict read `check-data` performs; refusals get stub
  profiles, never guesses; bounded output — no per-bar array ever rides the document.
- `contract.py` — the static contract payloads, data only (imports nothing from the package):
  `METRIC_ROLES` (compact, with its `caveats` map, stamped into every report) and
  `METRIC_ROLES_DOC` / `GATE_CONTRACT_DOC` / `REPORT_FIELDS` (the report/summary field dictionary
  — the output-side twin of the DSL JSON schema) / `DESCRIBE_ROLES` / `DESCRIBE_REPORT` (the
  describe-side claim/caveats and field dictionary) / `CSV_FORMAT` / `TRADES_CSV` /
  `ROOT_SERIES_CSV` / `ENTRY_FLAGS_CSV` / `EXIT_CODES` — the prose `seikan schema` emits.
- `constants.py` — structural names and bounds shared across the layers without a cycle:
  `TRADE_COLUMNS`, the reserved sweep/feature namespaces, `DEFAULT_FEATURE_NAMES`,
  `MAX_DECLARED_GRID` (the sealed search cap's validation-side twin).
- `gate.py` — `canonical_dsl_hash` + `evaluate_gate`: the per-cell checklist (3 run-level + 5
  per-cell checks, each `{name, passed, observed, threshold, detail}`;
  `POLICY_VERSION` 1 stamped into every report; the thresholds handed in are REVALIDATED by
  reconstruction at entry, so a mutated or loosened object cannot bend the checklist at the library
  boundary). The policy contract: stamped evidence verification (`statistics_version` +
  `gate_evidence_basis == "full_sample"` + a readable `target_mode` stamp — the rubric selector,
  refusing fail-closed when missing — + an exactly-sized `cells` panel + a string-keyed
  `sources` panel), fail-closed missingness on BOTH sides (outcomes via `outcome_coverage` —
  end-of-data `open` allowed, in-bounds holes refused — and decisions via the pooled
  `signal_coverage` plus the run-level `source_coverage`; per-target in BOTH modes), support
  floors and the
  universal concentration ceiling read from the mode's panel (per-target under conjunction,
  pooled — including the member-mass ceiling — under basket, with the pooled panel reconciled in
  `cell_evidence`), and the declared-grid `search_cap`. No inferential check exists
  at any level. `GateReport.to_dict()` emits `{policy_version, n_cells, n_passed, run_checks,
  cells}` — no verdict key. Drifted summary input refuses with a detail, never crashes.
- `settings.py` — `GateThresholds` (pydantic-settings, FROZEN, `SEIKAN_` env prefix; FOUR knobs:
  `thesis_min_trades`, `thesis_min_n_eff`, `thesis_max_concentration`, `thesis_max_hypotheses` —
  no optional knobs, no profile field, no alpha). Sealed canonical-as-floor: every knob's domain
  admits only its default or stricter (a loosened exam is exit 3), unknown `SEIKAN_*` env vars
  refuse (the known set is derived from `model_fields`, so a deleted knob's env var is enforced for
  free), `is_canonical()` feeds the report's `identity.thresholds_canonical` stamp.
- `dataio.py` — the strict-CSV front door: `read_strict_csv` (all violations accumulated,
  machine-readable `FileReport`s — each carrying the file's raw-byte `sha256`, the report's data
  identity), `check_frame` integrity invariants, `sufficiency_check` (an index too short to close
  one observation refuses up front), `DataError` → exit 2.
- `api.py` — the caller binds the thesis's declared keys to the files it has
  (`resolve_data_files(thesis, {key: path}, {key: column})` → a `DataFiles`), loads ONCE via
  `load_market_data(thesis.data, files)` (both re-exported here — this module is the public API's
  one home and the loader its front door) and hands the materialized `MarketData` to
  `compile_thesis(thesis, md)`
  (sufficiency → `run_backtest`, attaches `data_report`; never loads) and/or
  `list_entries(thesis, md)` (every firing timestamp of the full entry mask, bit-identical to the backtest's,
  plus TWO per-bar frames instead of one wide one, because they answer two different questions and
  the CLI nominates them one flag each: `root_series` — the deduplicated root-series value columns,
  each threshold operand except bare constants, labelled by `render_series` — is what
  `--root-series-out` writes, since it answers WHY a bar did or did not fire; `entry_flags` — the
  0/1 column per combo × target, canonically named and unique by construction — is what
  `--entry-flags-out` writes, and it answers WHETHER it fired. Keeping the two apart is what lets
  the value frame reserve nothing but `datetime`, so an external feed named `entry` keeps its name.
  `entry_flags` is also the ONE output that can express a final-bar firing: it anchors no
  observation, so the runner correctly drops it from the OBSERVATIONS and no trades row exists to
  carry it — a caller asking "is this firing NOW?" reads the last row of the entry-flags CSV, or
  `entries` through the library. No freshness claim — `series_end` just reports where the provided
  index stops).
- `serialize.py` — JSON-safe views (`serialize_result` returns the summary verbatim, never trades)
  + the caller-nominated CSV writers (`write_trades_csv` for `--trades-out`,
  `write_root_series_csv` for `--root-series-out`, `write_entry_flags_csv` for
  `--entry-flags-out`); nothing it produces rides stdout.
- `dsl/` — the thesis DSL (pydantic, `extra="forbid"`; a `DataSpec` NAMES series and locates none
  of them, and `BacktestParams` carries no sampling knob of any kind, so the DSL can express
  neither where its data lives nor a partition of it that some cells see and others do not).
  `compiler/` — data loading (`resolve_data_files` is where the invocation's `--data` / `--column`
  pairs meet the thesis's declared keys, and the only thing that checks the two agree) + numpy/numba
  transform kernels + the runner, which measures every
  declared cell once over the whole index and builds the per-cell panel off the DECLARED grid.
  `analysis/` — the statistical layer (`stats.py`, every statistic NOMINAL and per-cell) and result
  types. **Read `src/seikan/CLAUDE.md` before touching any of these three** — it carries the
  statistical doctrine (what the checklist reads vs what is evidence-only, observer purity, sweep
  semantics).
- `reference/dsl-schema.md` — the agent-facing DSL guide (`seikan schema --markdown`).

### dev commands

```bash
uv sync                   # install (numpy/numba/scipy/pandas/pydantic only — no services)
uv run pytest             # the WHOLE suite always runs; zero skips
                          # (numba cold-compiles on the first backtest test)
uv run seikan schema      # the machine-readable self-description
uv run --with pyinstaller pyinstaller --noconfirm --clean packaging/seikan.spec
                          # → dist/seikan/seikan. ONEDIR, not onefile (a host service invokes
                          # the CLI repeatedly and onefile would re-extract numpy/scipy/numba
                          # every call); the spec ships the seikan package as plain .py source
                          # (`module_collection_mode`) because numba's cache=True kernels need a
                          # real source file to locate and validate their on-disk cache entries
```

Note: the first `seikan run` on a machine pays numba's JIT compile (seconds); kernels are
`cache=True`, so later runs reuse the on-disk cache — inside a bundle it warms next to the shipped
sources, in `_internal/seikan/compiler/__pycache__/`.

### deferred (later phases)

Richer report visualization. Thesis lifecycle (draft/active/dormant), data acquisition, source
credibility, and scheduling are deliberately OUT — they belong to the calling agent, as does
selection among the reported cells and the multiplicity that selection carries.
