# seikan

A **stateless CLI forward-return event-study engine and per-hypothesis reporter** for
trading/investment theses, built to be driven by other agents (or humans). You bring a thesis DSL
(JSON) and time series (strict CSV); seikan runs an **observer-pure forward-return event study** —
entry condition + measurement horizon, no exit rule, no portfolio simulation — over **every
parameter × horizon cell your sweep declares**, under one of two declared target modes —
`conjunction` (the targets are the thesis's regime, the weakest decides) or `basket` (the targets
form one cross-section per bar, graded as one pooled panel) — and applies one uniform checklist
to **each cell independently**:

- every declared cell measured on the full sample and reported, **including combos that never
  fired** — `len(summary.cells) == n_hypotheses_attempted`, always
- overlap-honest per-cell inference (event-time Newey-West HAC t with df = n_eff−1, greedy
  non-overlapping `n_eff`, a circular-shift rotation null preserving count/clustering/overlap)
- **CSCV PBO** over the grid — how often picking the best cell would fail to travel — plus episode
  clustering, |return|-mass concentration and conditional buckets
- fail-closed data-integrity ledgers on **both** sides of every firing: outcomes (`no_outcome` /
  `no_benchmark` refuse) and decisions (undecidable bars, and raw source availability), so deleting
  data can only ever make a cell fail

**seikan does not select, rank, or crown a winner.** There is no best cell, no headline scalar, no
verdict, and no search-adjusted statistic (no `fw_p`, no deflation, no Romano-Wolf, no cross-cell
FDR — a correction computed inside one run only sees that run's grid). Selection and
cross-cell multiplicity are the caller's, priced against the stamped `n_hypotheses_attempted`.

A per-cell `passed` is a **completeness / support / concentration checklist with no significance
claim and no positive-expected-return certification** — nothing in it is a statistical test. The
report is honest by construction: the complete grid is emitted verbatim whatever the results say,
and per-cell results live in a separate `gate` section listing every check for every cell.
Identical inputs produce byte-identical reports.

## Install

```bash
uv sync            # or: uv tool install .   (Python >= 3.13)
```

## Use

```bash
seikan schema                      # machine-readable self-description: DSL JSON Schema, thresholds,
seikan schema --markdown           #   checklist contract, CSV contracts, exit codes, field dictionaries
seikan check-data px.csv --shape ohlcv     # pre-flight your CSVs (exit 0/2)
seikan run thesis.json --data PX=px.csv --report-out report.json   # full-grid event study + checklist
seikan run thesis.json --data PX=px.csv --report-out report.json --trades-out trades.csv --min-trades 40
seikan run thesis.json --data PX=rates.csv --column PX=us10y --report-out report.json  # which column IS PX
seikan run thesis.json --data PX=px.csv --root-series-out root_series.csv  # per-bar signal values only
seikan run thesis.json --data PX=px.csv --entry-flags-out entry_flags.csv  # per-bar 0/1 firing mask
```

A thesis NAMES its series and never locates them; the invocation says WHERE each one is and WHICH
COLUMN answers it. `--data KEY=PATH` binds each declared key to a CSV, once per key, and the set
must answer the thesis exactly (a missing key would measure a thesis you do not have; an unknown one
means you believe it reads something it never mentions). Keys are the target names, the
external-feed names — `<feed>@<target>` for a per-target feed — and `benchmark` when
`params.benchmark` is `"market"`.

`--column KEY=COL` says which column of that key's file answers it, over the same flat key
namespace, and is OPTIONAL per key: a file holding one value column names its own series, and only
a file holding several numeric ones needs a binding. Left unbound, such a file refuses (exit 2)
listing the columns it actually holds rather than choosing a series on your behalf, and a bound
name no header answers refuses the same way — whether a name fits these bytes is a question only
the bytes can answer. COL is matched case-insensitively. `benchmark` takes no column and is refused
one before a byte is read: it is outcome MEASUREMENT, sampled at the observation's own anchor bars,
and always reads its file's `open`. An OHLCV price target takes none either — it always measures
its open-anchored prices, so a binding on one refuses as soon as the file is read. The members of a
per-target feed may bind DIFFERENT columns, each under its own `<feed>@<target>` key: one vendor
ships three yields in one CSV under its own spellings while another ships each in a file of its
own, and the thesis is entitled to say neither. `check-data` has no `--column` flag at all — it
profiles FILES, and which column a run READS is a property of the binding, not of the file.

Keeping paths AND column names out of the document is what lets the same exam run against re-pulled
data next month without becoming a different document: a renamed header, or one CSV split into
three, re-shapes the evidence and not the question — the `dsl_hash` moves when the QUESTION
changes, and only then. What the invocation bound is stamped into the report instead:
`identity.data_digests` carries `{path, column, sha256}` per key, `column` always present and null
where nothing was bound, so which file and which column answered a key stays recoverable from the
report without ever having lived in the thesis. A thesis that names a path or a column of its own
is refused (exit 3, `dsl_invalid`) rather than quietly reinterpreted — every DSL model is
`extra="forbid"`.

`run` writes the outputs you **nominate** by flag — the JSON report (`--report-out`), the
per-observation trades (`--trades-out`), the per-bar root-series values (`--root-series-out`), the
per-bar 0/1 entry flags (`--entry-flags-out`) — and at least one is required: a run that asks for
nothing is exit 3, refused before the thesis file is even read. It is **silent on success**: the
outputs are the files, and stdout carries a JSON error envelope or nothing at all. Compute follows
the nomination — a run asking only for the decision-side listings (`--root-series-out` and/or
`--entry-flags-out`) takes the cheap listing path, skipping the full-grid backtest and with it the
requirement that the index be long enough to close one observation at the longest horizon (a signal
series is well-defined on an index too short to measure anything).

The two decision-side CSVs split the question: the root-series CSV carries **values** — why a bar
did or did not fire — and the entry-flags CSV carries **whether it fired**, one integer 0/1 column
per parameter combo × target, bit-identical to the backtest's firing mask. A fired bar also becomes
a row of the trades CSV, in observation shape — with one exception: a firing on the **final bar**
has no next open to anchor at, so it opens no observation and gets no trades row.
`--entry-flags-out` is the one CLI output that carries it, so "is my thesis firing right now?" is
answered by the last row of that file (or by the library `api.list_entries` → `entries` /
`entry_flags`), never by reading an empty trades tail.

Exit codes describe how far the **run** got, never how the evidence looked: **0** run completed —
every nominated output was written (per-cell results live in the report's `gate.cells`) ·
**2** input data failed strict validation (a bound column no header answers
lands here, since only the bytes can say) · **3** invalid request (a usage error — including a run
that nominates no output, or a `--data`/`--column` set that does not answer the thesis — an invalid
thesis DSL or gate-threshold set, or an unusable nominated output path) · **4** internal error.
Thresholds are canonical-as-floor — `--min-trades 40` is a *stricter* checklist and is accepted; a
loosened value is exit 3.

### The data contract (strict, on purpose)

CSV only. Timestamps: a `datetime` column (or the first column), strict **ISO-8601**,
timezone-naive, unique, sorted — ambiguous formats are rejected, never guessed. Values: plain
numbers (empty cell or `nan` for missing). OHLCV files must satisfy `high ≥ max(open, close)`,
`low ≤ min(open, close)`, prices > 0 — violations refuse with a machine-readable `data_report`
naming file/column/line; seikan never silently repairs evidence. Crash-sized moves, NaN holes and
calendar gaps are warned about but admitted — they are the research subject, not dirt.

### A minimal thesis

```json
{
  "name": "deep-drawdown-rebound",
  "data": { "targets": ["PX"] },
  "entry": {
    "type": "first_true",
    "condition": {
      "type": "and",
      "conditions": [
        { "type": "threshold", "left": { "type": "drawdown" }, "op": "<",
          "right": { "type": "constant", "value": -0.4 } },
        { "type": "threshold", "left": { "type": "bars_since_extremum", "extremum": "min" },
          "op": ">=", "right": { "type": "constant", "value": 20 } }
      ]
    }
  },
  "params": { "horizon": [21, 63], "benchmark": "market" }
}
```

It declares two data keys — the target `PX`, and `benchmark`, which `params.benchmark: "market"`
brings in — so it runs as `seikan run thesis.json --data PX=data/px.csv --data
benchmark=data/spy.csv --report-out report.json`. Neither key binds a column, and neither may: `PX`
is a price file measured on its open-anchored prices, and `benchmark` never takes one. Had `PX` been
a series-shaped file carrying several columns — three tenors of a yield curve, say — the document
above would read exactly as it does and only the invocation would grow, to `--data
PX=data/rates.csv --column PX=us10y`. That the thesis does not change is the point of keeping the
column out of it.

This declares a two-cell grid (one entry combo × two horizons), so the report carries two entries
in `summary.cells` and two in `gate.cells`, index-aligned, each graded on its own.

`seikan schema --markdown` documents every node. Checklist thresholds come from `SEIKAN_*`
environment variables, overridden per run by CLI flags; the snapshot actually used is stamped into
the report, along with whether it was the canonical set.

Note: the first run on a machine pays numba's JIT compilation (a few seconds); kernels are cached
on disk afterwards.

## Development

```bash
uv run pytest      # the whole suite, zero skips
```

`CONTRACT.md` (repo root) carries the working contract — the frozen statistical mechanics, the
honesty invariant, the per-cell checklist and the strict-CSV doctrine; `src/seikan/CLAUDE.md` the
statistical deep dive.
