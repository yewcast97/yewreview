"""The seikan CLI — a stateless statistical reporter for other agents.

Subcommands:

- ``seikan run <thesis.json> --data KEY=PATH [--column KEY=COL] ...`` — measure a thesis and write
  the outputs the caller NOMINATES, one
  flag each; at least one is required (a run that asks for nothing is a usage error, refused before
  the thesis file is even read). The thesis names its series and the invocation locates them:
  ``--data`` binds a file to each declared key, and ``--column`` binds a CSV column to any key
  whose file holds several numeric columns (never to ``benchmark``, which always reads its file's
  ``open``). **Silent on success**: exit 0 prints NOTHING on stdout — the
  outputs are the files, and stdout carries a JSON error envelope or nothing at all.

  - ``--report-out <path>`` — the full statistical JSON document (always overwritten), in a
    FIXED layer order: the top-level ``seikan_version`` /
    ``report_schema_version`` / ``command`` header EVERY document carries → ``identity`` (dsl_hash,
    per-KEY data digests — ``{path, column, sha256}`` for every declared data key — the threshold
    snapshot actually used + whether it is canonical + its
    per-knob provenance) → ``data_report`` → ``outputs`` (every nominated file; each CSV also
    carries a row count) →
    the engine ``summary`` **verbatim** (every declared parameter × horizon cell, non-firing combos
    included — never filtered by a checklist result). The summary always stamps ``target_mode``
    ('conjunction' | 'basket' — which cross-target semantics produced every number), and in basket
    mode each cell additionally carries the ``pooled`` cross-target panel its checklist rubric
    grades instead of per-member floors → the ``gate`` section
    (``{policy_version, n_cells, n_passed, run_checks, cells}`` — every check reported for every
    cell) → compact ``metric_roles`` (which fields the checklist consumes, the exact claim, what is
    evidence-only; the prose rationale lives in ``seikan schema``). The exit code is NOT a verdict:
    a completed run exits 0 whatever the per-cell results say, which live in ``gate.cells``. No
    time series ever ride the report — the per-observation rows have their own flags below.
  - ``--trades-out <path>`` — the per-observation trades CSV (one row per firing × target ×
    horizon, with the post-entry path columns).
  - ``--root-series-out <path>`` — the per-bar values of every deduplicated root series node (each
    threshold operand in the entry tree except bare constants), labelled by ``render_series``, with
    ``@<target>`` column families when several targets. Value columns ONLY — the per-bar DECISION
    INPUT view: a fired bar becomes a row of the trades CSV instead, in observation shape, and the
    0/1 flags ride their own file below.
  - ``--entry-flags-out <path>`` — the per-bar 0/1 entry-flag matrix, one integer column per (param
    combo × target), bit-identical to the firing mask the backtest measures at. It is the ONE CLI
    output that carries a firing on the FINAL bar: such a firing has no next open to anchor at, so
    it opens no observation, has no trades row and is counted in no ``outcome_coverage`` ledger —
    this file is where it shows up, and what answers "is my thesis firing NOW?".

  Compute is LAZY — only what the nominated outputs need. ``--report-out`` or ``--trades-out``
  runs the full-grid event study (which requires an index long enough to close one observation at
  the longest horizon); a run nominating ONLY ``--root-series-out`` and/or ``--entry-flags-out``
  takes the cheaper listing path instead — ONE ``list_entries`` call serving both frames: no
  full-grid backtest, and no horizon-runway requirement, since a signal series is well-defined on
  an index too short to measure anything. The market data itself is loaded exactly ONCE per run,
  after request validation, and the one materialized ``MarketData`` is shared by both compute
  paths.
- ``seikan check-data <files...>`` — pre-flight the strict-CSV contract on data files alone.
- ``seikan describe <files...>`` — profile data files (levels, changes, dispersion, range
  position, missingness): pure DESCRIPTION that measures nothing and supports no thesis. One JSON
  document on stdout; its ``data_report`` is byte-equal to ``check-data``'s over the same files,
  and a refused file gets a stub profile while the document is still emitted.
- ``seikan schema`` — the DSL JSON Schema + threshold/checklist-contract/CSV/exit-code reference
  (agents self-serve); ``--markdown`` streams the human-readable DSL guide.

Exit codes: 0 run completed — every nominated output was written · 2 input data failed strict
validation · 3 invalid request — an argparse usage error (including a run
that nominates no output), an invalid thesis DSL or gate-threshold set, or an unusable nominated
output path (``usage`` / ``dsl_invalid`` / ``thresholds_invalid`` envelopes; the thresholds one
also covers unknown ``SEIKAN_*`` env vars, a hard error) · 4 internal error. Every seikan-DETECTED
error emits a machine-readable JSON envelope on stdout — ``{seikan_version,
report_schema_version, command, error}`` with ``error = {type, message, errors?}``. For ``run``
that envelope is the ONLY thing that ever reaches stdout, since its outputs are files;
``check-data``, ``describe`` and ``schema`` still emit their own document there on success — the
silence is a property of ``run``, not of the CLI. ``--help`` / ``--version`` (conventional
non-JSON, exit 0) and a SIGINT (KeyboardInterrupt — Python's default, no envelope) carry no
envelope either.

Seikan does not select, rank, or crown a winning cell. It measures every hypothesis the thesis
declares and reports each one honestly; choosing among them — and pricing the multiplicity of
having looked at ``n_hypotheses_attempted`` of them — belongs to the calling agent.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from collections.abc import Callable
from pathlib import Path
from typing import NoReturn

from pydantic import ValidationError

import seikan
from seikan.api import compile_thesis, list_entries, load_market_data, resolve_data_files
from seikan.contract import (
    CSV_FORMAT,
    DESCRIBE_REPORT,
    DESCRIBE_ROLES,
    ENTRY_FLAGS_CSV,
    EXIT_CODES,
    GATE_CONTRACT_DOC,
    METRIC_ROLES,
    REPORT_FIELDS,
    ROOT_SERIES_CSV,
    TRADES_CSV,
)
from seikan.dataio import DataError, build_data_report, read_strict_csv
from seikan.describe import DEFAULT_WINDOWS, describe_files
from seikan.dsl.schema import Thesis
from seikan.gate import canonical_dsl_hash, evaluate_gate
from seikan.serialize import (
    json_safe,
    serialize_result,
    write_entry_flags_csv,
    write_root_series_csv,
    write_trades_csv,
)
from seikan.settings import GateThresholds
from seikan.types import (
    DslDocument,
    EmittedDocument,
    ErrorEnvelope,
    OutputEntry,
    ValidationRecord,
)

#: The codes describe how far the RUN got, never how the evidence looked: a completed run is exit
#: 0 whatever its cells report, and 2/3/4 mean the run could not produce a report at all.
#: ``EXIT_REQUEST`` (3) is "invalid request": an argparse usage error, an invalid thesis DSL or
#: gate-threshold set, or an unusable nominated output path.
EXIT_OK, EXIT_DATA, EXIT_REQUEST, EXIT_INTERNAL = 0, 2, 3, 4

#: The report-envelope shape version, orthogonal to ``statistics_version`` (estimators) and
#: ``gate.policy_version`` (checklist semantics). It stamps the SHAPE every emitted document
#: holds: the top-level ``{seikan_version, report_schema_version, command}`` header EVERY document
#: opens with, the run report's fixed layer order (identity -> data_report -> outputs -> summary ->
#: gate -> metric_roles), the ``outputs`` block naming the files a run wrote, and the error
#: envelope ``{type, message, errors?}``. It is the one number that tells an agent whether the
#: binary in front of it is the contract it is holding, so a reader-visible shape change bumps it
#: rather than arriving silently.
REPORT_SCHEMA_VERSION = 1


#: CLI flag → GateThresholds field (flags override SEIKAN_* env vars, which override defaults).
#: One entry per knob the checklist has; ``seikan schema`` renders this map directly, so a field
#: the settings model drops disappears from the flags, the env-var listing and the docs at once.
_THRESHOLD_FLAGS: dict[str, tuple[str, type]] = {
    "min_trades": ("thesis_min_trades", int),
    "min_n_eff": ("thesis_min_n_eff", int),
    "max_concentration": ("thesis_max_concentration", float),
    "max_hypotheses": ("thesis_max_hypotheses", int),
}


def _dumps(doc: EmittedDocument, pretty: bool = False) -> str:
    # The ONE serializer for every JSON document seikan produces — the report FILE and the stdout
    # error envelopes alike. allow_nan=False is a hard backstop: json_safe already maps every
    # non-finite float to null, so this never fires in practice — but if it ever regressed, raising
    # here (even from inside an error handler, even mid-write of a report file) beats writing
    # `NaN`/`Infinity` tokens no strict JSON parser can read back. A report nobody can parse is
    # worse than no report. Do not "fix" this by dropping the flag.
    kwargs = {"indent": 2} if pretty else {"separators": (",", ":")}
    return json.dumps(json_safe(doc), sort_keys=False, allow_nan=False, **kwargs) + "\n"


def _emit(doc: EmittedDocument, pretty: bool = False) -> None:
    sys.stdout.write(_dumps(doc, pretty))


def _base_doc(command: str | None) -> EmittedDocument:
    # The uniform header every JSON document opens with, stamped with the CURRENT
    # ``REPORT_SCHEMA_VERSION`` (see its definition above): the
    # run report, check-data, describe, schema and every error envelope alike, so a caller reads
    # the version and command the same way whatever the outcome. ``command`` is None for a usage
    # error raised before a subcommand was resolved (bare ``seikan``, an unknown subcommand).
    return {
        "seikan_version": seikan.__version__,
        "report_schema_version": REPORT_SCHEMA_VERSION,
        "command": command,
    }


class _UsageError(Exception):
    """An argparse usage error (an unusable nominated output path, or a ``run`` that nominates no
    output at all), captured for the exit-3 ``usage`` envelope. ``command`` is the failing
    subcommand (``"run"``), or None for a pre-subcommand error (bare ``seikan``, an unknown
    subcommand choice)."""

    def __init__(self, message: str, command: str | None = None) -> None:
        super().__init__(message)
        self.command = command


def _validation_records(exc: ValidationError) -> list[ValidationRecord]:
    """JSON-safe error records from a pydantic ``ValidationError``. ``include_context=False`` drops
    the ``ctx``, which can carry the ORIGINAL (non-serializable) exception a custom validator
    raised — emitting it would crash the envelope handler with ``TypeError``; the human text
    already lives in each error's ``msg``."""
    return [
        {"loc": list(e.get("loc", ())), "msg": e.get("msg"), "type": e.get("type")}
        for e in exc.errors(include_url=False, include_context=False)
    ]


class _ThresholdsInvalidError(ValueError):
    """Invalid gate-threshold configuration — an out-of-domain CLI flag or ``SEIKAN_*`` env var,
    or (under ``extra="forbid"``) an unknown ``SEIKAN_*``-prefixed var. Kept distinct so it maps
    to its own exit-3 envelope (``type: "thresholds_invalid"``): ``Thesis`` validation raises the
    same pydantic ``ValidationError`` type, so the DSL branch cannot discriminate by class. The
    structured pydantic records ride ``.records``."""

    def __init__(self, message: str, records: list[ValidationRecord]) -> None:
        super().__init__(message)
        self.records = records


def _thresholds_invalid(exc: ValidationError) -> _ThresholdsInvalidError:
    """Shape a thresholds ``ValidationError`` into the exit-3 ``thresholds_invalid`` envelope: a
    short summary message plus the structured ``errors`` records (an unknown ``SEIKAN_*`` var's
    name lands in a record's ``msg``)."""
    records = _validation_records(exc)
    n = len(records)
    return _ThresholdsInvalidError(
        f"{n} invalid gate-threshold setting{'' if n == 1 else 's'}", records
    )


def _thresholds(args: argparse.Namespace) -> GateThresholds:
    overrides = {}
    for flag, (field, _typ) in _THRESHOLD_FLAGS.items():
        value = getattr(args, flag, None)
        if value is not None:
            overrides[field] = value
    try:
        return GateThresholds(**overrides)
    except ValidationError as exc:
        raise _thresholds_invalid(exc) from exc


def _thresholds_provenance(args: argparse.Namespace) -> dict[str, str]:
    """Per knob: ``"cli"`` (a flag was passed), ``"env"`` (a ``SEIKAN_*`` var is set), else
    ``"default"`` — the SOURCE, not the value (a var set to the canonical default still reads
    ``"env"``). Stamped into ``identity`` so an auditor can tell a stricter-via-flag run from a
    stricter-via-env one — which ``identity.thresholds`` alone cannot — and knows the report is a
    function of the ambient ``SEIKAN_*`` environment too."""
    prov: dict[str, str] = {}
    for flag, (field, _typ) in _THRESHOLD_FLAGS.items():
        env_var = f"SEIKAN_{field.upper()}"
        if getattr(args, flag, None) is not None:
            prov[field] = "cli"
        # settings reads SEIKAN_* case-insensitively
        elif any(k.upper() == env_var for k in os.environ):
            prov[field] = "env"
        else:
            prov[field] = "default"
    return prov


def _preflight_output(path: str, command: str) -> None:
    """Refuse an unwritable nominated output path BEFORE the expensive run (exit 3, an
    invalid-request usage refusal). Non-destructive: an existing file is opened for APPEND and left
    untouched; a probe that had to create the file removes it again. A MID-run write failure still
    surfaces as exit 4 — this only preflights the obvious cases (missing directory, unwritable path,
    a path that is itself a directory)."""
    p = Path(path)
    existed = p.exists()
    try:
        with open(p, "a"):
            pass
    except OSError as exc:
        raise _UsageError(f"output path {path!r} is not writable: {exc}", command) from exc
    if not existed:
        p.unlink(missing_ok=True)


def _parse_data_pairs(raw: list[str] | None) -> dict[str, str]:
    """``--data KEY=PATH`` pairs → ``{key: path}``, or a usage refusal.

    Split on the FIRST ``=`` only: a path may legitimately contain one, a key may not (the DSL
    refuses ``=`` in a target or feed name for exactly this reason), so the separator is never
    ambiguous. A duplicate key is refused rather than last-wins — two pairs naming one series is a
    caller who does not know which file the run read, and silently picking one answers a question
    they did not ask.
    """
    pairs: dict[str, str] = {}
    for item in raw or []:
        key, sep, path = item.partition("=")
        if not sep:
            raise _UsageError(
                f"--data {item!r} is not a KEY=PATH pair (the key names a series the thesis "
                "declares; the path is the CSV behind it)",
                "run",
            )
        key, path = key.strip(), path.strip()
        if not key or not path:
            raise _UsageError(
                f"--data {item!r} needs both a key and a path, got "
                f"{'an empty key' if not key else 'an empty path'}",
                "run",
            )
        if key in pairs:
            raise _UsageError(
                f"--data names {key!r} twice ({pairs[key]!r} and {path!r}) — one key answers one "
                "series, and a run must not have to choose which file it read",
                "run",
            )
        pairs[key] = path
    return pairs


def _parse_column_pairs(raw: list[str] | None) -> dict[str, str]:
    """``--column KEY=COL`` pairs → ``{key: column}``, or a usage refusal.

    The mirror of ``_parse_data_pairs``, and deliberately so: the two flags address the SAME flat
    key namespace and a caller who has learned one has learned the other. Split on the FIRST ``=``
    (a key may not contain one — the DSL refuses it — and a column header conceivably can); refuse
    a non-pair, an empty key, an empty column, and a duplicate key, all before a byte of data is
    read. Two pairs naming one key is the same defect two ``--data`` pairs are: the run would have
    to choose which column it measured, and choosing silently answers a question the caller did
    not ask.

    The column value is stripped and LOWERCASED here, once. ``dataio.read_strict_csv`` lowercases
    every header it admits, so lowercasing at the door is what makes matching case-insensitive —
    and it means the ONE spelling that reaches the loader is also the one that reaches the report's
    ``data_digests``, rather than a report echoing "Close" for a run that matched ``close``.
    """
    pairs: dict[str, str] = {}
    for item in raw or []:
        key, sep, column = item.partition("=")
        if not sep:
            raise _UsageError(
                f"--column {item!r} is not a KEY=COL pair (the key names a series the thesis "
                "declares; COL is the column of that key's CSV to read)",
                "run",
            )
        key, column = key.strip(), column.strip().lower()
        if not key or not column:
            raise _UsageError(
                f"--column {item!r} needs both a key and a column, got "
                f"{'an empty key' if not key else 'an empty column'}",
                "run",
            )
        if key in pairs:
            raise _UsageError(
                f"--column names {key!r} twice ({pairs[key]!r} and {column!r}) — one key reads "
                "one column, and a run must not have to choose which one it measured",
                "run",
            )
        pairs[key] = column
    return pairs


def _declared_input_paths(
    thesis_path: str, resolution: dict[str, str]
) -> dict[Path, str]:
    """Every file this run READS, resolved, mapped to the name a refusal should quote it by.

    Read off the RESOLVED data mapping rather than off the loader's ``data_report`` because the
    refusal it feeds has to land before a single byte is read — and because the state it prevents
    is precisely a report whose ``identity`` vouches for bytes the same run overwrote.

    The thesis file itself is in here, not just the data it names: it is the run's primary input
    and the one ``identity.dsl_hash`` is computed over, so an output that lands on it destroys the
    very definition of the exam being reported. It is also the easiest collision to type by
    accident — ``--report-out`` one character away from the thesis argument on the same command
    line.
    """
    found: dict[Path, str] = {}

    def note(raw: str | None, field: str) -> None:
        # setdefault: one file may answer two keys (a target that is also the benchmark); the
        # FIRST key is the one a refusal message quotes, and either is equally true.
        if raw:
            found.setdefault(Path(raw).expanduser().resolve(), field)

    note(thesis_path, "the thesis file")
    for key, path in resolution.items():
        note(path, f"--data {key}")
    return found


def _check_nominated_outputs(
    nominated: list[tuple[str, str]], thesis_path: str, resolution: dict[str, str]
) -> None:
    """Refuse a set of output nominations that cannot ALL be honored — before any compute.

    Three ways a nomination is unusable:

    - an EMPTY path. argparse did receive the flag, so treating it as "not nominated" would exit 0
      having silently skipped an output the caller asked for — the one thing exit 0 promises it
      never does.
    - TWO flags naming one file. The writes are sequential overwrites, so the later output
      destroys the earlier one and the report would still enumerate both, ``rows_written`` and
      all — a document vouching for content that is not on disk.
    - an output naming one of the run's own INPUTS: the thesis file, or any CSV the invocation
      pointed a data key at. The run would delete the evidence it is measuring and stamp an
      identity for it. This
      engine refuses rather than mutates everywhere else — the loader will not even clamp an OHLC
      violation — so it does not get to be the one writer that overwrites its own input.

    All three are ``usage`` refusals, up front, for the same reason the no-output case is: nothing
    about the data can make such a request answerable.
    """
    seen: dict[Path, str] = {}
    inputs = _declared_input_paths(thesis_path, resolution)
    for flag, raw in nominated:
        if not raw.strip():
            raise _UsageError(f"{flag} needs a file path, got an empty string", "run")
        resolved = Path(raw).expanduser().resolve()
        if resolved in seen:
            raise _UsageError(
                f"{flag} and {seen[resolved]} both name {raw!r} — each output needs its own path, "
                "or the later write silently destroys the earlier one",
                "run",
            )
        seen[resolved] = flag
        if resolved in inputs:
            raise _UsageError(
                f"{flag} would overwrite {inputs[resolved]} ({raw!r}) — a run never writes over "
                "its own input",
                "run",
            )


class _ThesisFileNotFoundError(FileNotFoundError):
    """A missing thesis file → exit 3 (invalid request). A missing *output* directory is caught
    separately by ``_preflight_output`` (also exit 3), so an ordinary ``FileNotFoundError`` never
    reaches the exit-4 internal handler."""


class _NonFiniteJsonError(ValueError):
    """A ``NaN``/``Infinity`` literal in the thesis file. JSON proper has no such literals;
    Python's decoder accepts them as an extension, which would admit a threshold that makes every
    comparison undecidable and a ``dsl_hash`` computed over a token no strict parser can read
    back. A thesis with no recoverable identity is not a thesis."""


def _reject_non_finite(literal: str) -> NoReturn:
    raise _NonFiniteJsonError(
        f"thesis contains the non-standard JSON literal {literal!r} — numeric values must be "
        "finite (JSON has no NaN/Infinity; a non-finite threshold decides nothing)"
    )


def _load_thesis(path: str) -> tuple[DslDocument, Thesis]:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise _ThesisFileNotFoundError(str(exc)) from exc
    raw = json.loads(text, parse_constant=_reject_non_finite)
    return raw, Thesis.model_validate(raw)


def _add_threshold_flags(p: argparse.ArgumentParser) -> None:
    group = p.add_argument_group("gate thresholds (override SEIKAN_* env vars)")
    for flag, (field, typ) in _THRESHOLD_FLAGS.items():
        group.add_argument(
            f"--{flag.replace('_', '-')}", type=typ, default=None, dest=flag,
            help=f"override {field} (env SEIKAN_{field.upper()})",
        )


def _cmd_run(args: argparse.Namespace) -> int:
    # Nomination is tested on PRESENCE, not truthiness: argparse hands back None for a flag that
    # was never passed and "" for one passed empty, and those are different requests — the second
    # asked for an output and named it unusably (refused in _check_nominated_outputs below), while
    # collapsing them would let `--report-out ""` exit 0 having written no report at all.
    nominated = [
        (flag, path)
        for flag, path in (
            ("--report-out", args.report_out),
            ("--trades-out", args.trades_out),
            ("--root-series-out", args.root_series_out),
            ("--entry-flags-out", args.entry_flags_out),
        )
        if path is not None
    ]
    # A request that nominates no output is malformed whatever its thesis says, so refuse it before
    # reading a single file — the cheap refusal this CLI owes. (Consequence worth keeping: a
    # zero-flag run against a nonexistent thesis path is `usage`, never `dsl_invalid`.)
    if not nominated:
        raise _UsageError(
            "at least one of --report-out, --trades-out, --root-series-out, --entry-flags-out "
            "is required",
            "run",
        )
    raw, thesis = _load_thesis(args.thesis)  # ValidationError/JSONDecodeError → exit 3 in main()
    # The DSL names its series; this invocation locates them — which file answers each key, and
    # which column of that file. Resolution refuses a mapping that does not answer the thesis's
    # declared keys EXACTLY, and a column bound to a key the thesis never declares (or to
    # 'benchmark', which reads its file's open price and chooses nothing) — before any file is
    # touched, because a run that loaded nothing for a declared series would measure a thesis it
    # does not have, and a binding nothing will ever read is a caller holding a different thesis.
    mapping = _parse_data_pairs(args.data)
    columns = _parse_column_pairs(args.column)
    try:
        files = resolve_data_files(thesis, mapping, columns)
    except ValueError as exc:
        raise _UsageError(str(exc), "run") from exc
    # Thresholds are built ALWAYS, even when no report will be written. The SEIKAN_* namespace is
    # owned, and whether a flag or env var is legal cannot depend on which outputs were nominated:
    # a trades-only run with a typo'd SEIKAN_* var is still exit 3 thresholds_invalid. Lazy compute
    # governs COMPUTE, never request validation.
    thresholds = _thresholds(args)
    # Refuse an unusable path BEFORE the O(grid × length) run, not after it — every nominated path,
    # in flag order, so a caller learns about all-but-the-first without paying for a run twice.
    # The set is checked as a SET first (empty, colliding, or aiming at the run's own input), then
    # each path individually for writability.
    _check_nominated_outputs(nominated, args.thesis, mapping)
    for _flag, path in nominated:
        _preflight_output(path, "run")

    # The market data is loaded exactly ONCE, here, and the one materialized MarketData is shared
    # by both compute paths — compile_thesis and list_entries take it as a required parameter and
    # never load. The evaluation memo rides it (md.cache), so every series/condition of the run is
    # built at most once, whichever path asks first. Every run that survived the exit-3 request
    # validation above needs the data (a
    # zero-output run was refused before the thesis was read), so nothing is loaded speculatively;
    # and loading sits after every exit-3 refusal and before any O(grid × length) compute, so a
    # strict-CSV violation is still exit 2 ahead of all measurement work.
    md = load_market_data(thesis.data, files)  # DataError → exit 2 in main()

    # `outputs` is keyed in NOMINATION order — report, trades, root_series, entry_flags — so the
    # report's own entry is inserted first even though its file is written last (see the
    # write-order note below).
    outputs: dict[str, OutputEntry] = {}
    if args.report_out:
        outputs["report"] = {"path": args.report_out}

    result = None
    if args.report_out or args.trades_out:
        result = compile_thesis(thesis, md)  # sufficiency/volume guards: DataError → exit 2
        if args.trades_out:
            outputs["trades"] = {
                "path": args.trades_out,
                "rows_written": write_trades_csv(result, args.trades_out),
            }
    if args.root_series_out or args.entry_flags_out:
        # ONE listing call serves BOTH per-bar outputs: root_series (the decision INPUTS) and
        # entry_flags (the decisions themselves) are two frames of the same EntryListReport, built
        # off the one evaluation memo riding md — shared with the backtest above, so nominating
        # both listing outputs costs exactly what nominating one costs, and a listing after a
        # backtest rebuilds no series or condition at all. When both
        # kinds of output are nominated the backtest runs FIRST, so every DataError surfaces from
        # the strict path (its guards are a superset of the listing's — horizon sufficiency,
        # features included in the volume check) and a refused run writes no listing CSV.
        listing = list_entries(thesis, md)
        # root_series first, so `outputs` keeps its declared key order whichever flags were passed.
        if args.root_series_out:
            outputs["root_series"] = {
                "path": args.root_series_out,
                "rows_written": write_root_series_csv(listing.root_series, args.root_series_out),
            }
        if args.entry_flags_out:
            outputs["entry_flags"] = {
                "path": args.entry_flags_out,
                "rows_written": write_entry_flags_csv(listing.entry_flags, args.entry_flags_out),
            }

    if args.report_out:
        # Nominating --report-out ran the study above, and compile_thesis always attaches the
        # strict-read data_report to what it returns — so both are present here BY CONSTRUCTION.
        # Stated rather than assumed: if the lazy-compute branches above are ever rearranged, this
        # fails loudly instead of writing a report with a hole where its identity should be.
        assert result is not None and result.data_report is not None
        dsl_hash = canonical_dsl_hash(raw)
        payload = serialize_result(result)
        doc = _base_doc("run")
        # The identity layer: everything needed to know WHICH exam ran on WHICH inputs — a changed
        # rule set (dsl_hash), data byte (data_digests), exam knob (thresholds) or knob PROVENANCE
        # is a visibly distinct exam. thresholds_canonical lives here (an identity fact), not in the
        # gate. The version/command triple lives at the top level (every document carries it).
        # Digests are keyed by the LOGICAL key, not by path: the key is what the thesis declares
        # and what two runs can be compared on, while the path is where this invocation happened to
        # find the bytes. Path, column and hash all ride the entry — "the series the thesis calls
        # NVDA was this file, read out of this column, and it hashed to this" — so a re-run over
        # re-pulled data is a legible diff rather than a renamed row. `column` is ALWAYS present
        # and null when the key bound none: a stamp that appears only sometimes reads as a
        # different document rather than as a different answer, and "no column was bound, so the
        # file named its own" is a fact about the run worth stating out loud. The sha256 is looked
        # up BY PATH on purpose — it is a property of the file's bytes, so two keys answered by one
        # file correctly share one digest while keeping their own column.
        digest_by_path = {f["path"]: f["sha256"] for f in result.data_report.get("files", [])}
        doc["identity"] = {
            "name": payload["name"],
            "dsl_hash": dsl_hash,
            "data_digests": {
                key: {
                    "path": path,
                    "column": columns.get(key),
                    "sha256": digest_by_path.get(path),
                }
                for key, path in mapping.items()
            },
            "thresholds": thresholds.snapshot(),
            "thresholds_canonical": thresholds.is_canonical(),
            "thresholds_provenance": _thresholds_provenance(args),
        }
        doc["data_report"] = result.data_report
        doc["outputs"] = outputs
        # HONESTY INVARIANT: the engine summary is embedded VERBATIM before the checklist runs — the
        # checklist renders a per-cell result ABOUT it and can never filter a parameter × horizon
        # cell out of it, non-firing and failing cells included. It cannot change the exit code
        # either: the code below returns EXIT_OK unconditionally, so the only thing a checklist
        # result moves is the content of `gate`. Reporting and grading stay strictly separable.
        doc["summary"] = payload["summary"]
        try:
            # The checklist revalidates the thresholds it is handed. Unreachable from
            # here — `_thresholds` built them through the same constructor — but a loosened exam is
            # a thresholds problem, not a DSL one, so keep it off main()'s generic dsl_invalid
            # branch.
            doc["gate"] = evaluate_gate(result.summary, thresholds).to_dict()
        except ValidationError as exc:
            raise _thresholds_invalid(exc) from exc
        doc["metric_roles"] = METRIC_ROLES
        # The report is written LAST, after every other nominated output landed: it ENUMERATES
        # those outputs, and a mid-run write failure on an earlier one must not leave behind a
        # report claiming files that do not exist. A failed report write is the honest failure mode
        # — the CSVs are on disk and no document vouches for anything.
        Path(args.report_out).write_text(_dumps(doc, args.pretty), encoding="utf-8")

    # Every nominated output was written, which is the whole of what this command promises — and
    # nothing went to stdout. Per-cell results live in `gate.cells` and NEVER reach the exit code:
    # an agent that branches on the status of `seikan run` is asking "did the measurement happen
    # and were the outputs written?", never "is this thesis good?" — and the second question has no
    # scalar answer to give it.
    return EXIT_OK


def _cmd_check_data(args: argparse.Namespace) -> int:
    doc = _base_doc("check-data")
    reports = []
    for path in args.files:
        _df, rep = read_strict_csv(path, expected_shape=args.shape)
        reports.append(rep)
    data_report = build_data_report(reports)
    doc["data_report"] = data_report
    _emit(doc, args.pretty)
    return EXIT_OK if data_report["ok"] else EXIT_DATA


#: Ceiling on the ``--windows`` list. A cap, not a knob: past it the request is a usage error,
#: because an unbounded window list is the one way a caller could push the describe document's
#: size toward a per-bar payload — and the bounded-output invariant is not negotiable.
MAX_DESCRIBE_WINDOWS = 16


def _windows_arg(value: str) -> list[int]:
    """Parse ``--windows`` ("21,63,126") into an ordered list of BAR counts, or refuse.

    argparse funnels the ``ArgumentTypeError`` through ``error()`` → the exit-3 ``usage``
    envelope, the same tier as every other malformed request. The rules: integers only, each
    >= 1, no duplicates (a duplicate would mint a duplicate JSON key), at most
    ``MAX_DESCRIBE_WINDOWS``. Order is PRESERVED — the document emits the windows as given.
    """
    windows: list[int] = []
    for part in value.split(","):
        text = part.strip()
        if not text:
            raise argparse.ArgumentTypeError(
                f"empty window in {value!r} — one comma-separated list of bar counts"
            )
        try:
            w = int(text)
        except ValueError:
            raise argparse.ArgumentTypeError(
                f"window {text!r} is not an integer bar count"
            ) from None
        if w < 1:
            raise argparse.ArgumentTypeError(f"window {w} must be >= 1 (windows are BAR counts)")
        if w in windows:
            raise argparse.ArgumentTypeError(
                f"window {w} appears more than once — each window is profiled once, in the "
                "given order"
            )
        windows.append(w)
    if len(windows) > MAX_DESCRIBE_WINDOWS:
        raise argparse.ArgumentTypeError(
            f"{len(windows)} windows exceeds the cap of {MAX_DESCRIBE_WINDOWS}"
        )
    return windows


def _cmd_describe(args: argparse.Namespace) -> int:
    # The profiling twin of check-data: the SAME strict read admits or refuses each file (so
    # data_report is byte-equal to check-data's over the same argv), and the exit code carries
    # the same meaning — 0 all admitted, 2 any refused, document emitted EITHER WAY. Files are
    # profiled in argument order, never sorted: the argv is the caller's declaration.
    windows = list(DEFAULT_WINDOWS) if args.windows is None else args.windows
    body = describe_files(args.files, shape=args.shape, windows=windows)
    doc = _base_doc("describe")
    doc["data_report"] = body["data_report"]
    doc["profiles"] = body["profiles"]
    # The compact role map rides WITH the document — the honest one-liners travel with the
    # numbers they qualify, exactly as metric_roles rides the run report. The field dictionary
    # (DESCRIBE_REPORT) stays schema-side, like REPORT_FIELDS.
    doc["describe_roles"] = DESCRIBE_ROLES
    _emit(doc, args.pretty)
    return EXIT_OK if body["data_report"]["ok"] else EXIT_DATA


def _cmd_schema(args: argparse.Namespace) -> int:
    if args.markdown:
        ref = Path(__file__).parent / "reference" / "dsl-schema.md"
        sys.stdout.write(ref.read_text(encoding="utf-8"))
        return EXIT_OK
    doc = _base_doc("schema")
    doc["dsl_json_schema"] = Thesis.model_json_schema()
    # Class defaults straight from model_fields — never a live instance, which would read (and
    # crash on, or silently reflect) the ambient SEIKAN_* environment as if it were the default.
    fields = GateThresholds.model_fields
    doc["thresholds"] = [
        {
            "field": field,
            "default": fields[field].default,
            "env_var": f"SEIKAN_{field.upper()}",
            "cli_flag": f"--{flag.replace('_', '-')}",
        }
        for flag, (field, _typ) in _THRESHOLD_FLAGS.items()
    ]
    doc["gate_contract"] = GATE_CONTRACT_DOC
    # The OUTPUT-side field dictionary, right after the contract that grades those fields: the
    # input side has dsl_json_schema, and an agent explaining a report deserves the same
    # machine-readable answer to "what IS this number" without opening the markdown guide.
    doc["report_fields"] = REPORT_FIELDS
    # The describe document's field dictionary, right after the run report's — the two
    # output-side references sit together, and neither rides its own document.
    doc["describe_report"] = DESCRIBE_REPORT
    doc["csv_format"] = CSV_FORMAT
    # The output CSVs in nomination order: trades → root_series → entry_flags.
    doc["trades_csv"] = TRADES_CSV
    doc["root_series_csv"] = ROOT_SERIES_CSV
    doc["entry_flags_csv"] = ENTRY_FLAGS_CSV
    doc["exit_codes"] = EXIT_CODES
    # The IDENTICAL compact map the run report stamps — one shape everywhere. The prose
    # rationale rides gate_contract.metric_roles_rationale (a distinctly-named key), so no field is
    # a dict in one command and a list in another.
    doc["metric_roles"] = METRIC_ROLES
    # And the describe twin, stamped IDENTICALLY into every describe document — same shape in
    # both commands, the same one-shape-everywhere rule metric_roles follows.
    doc["describe_roles"] = DESCRIBE_ROLES
    _emit(doc, args.pretty)
    return EXIT_OK


class _Parser(argparse.ArgumentParser):
    """An ``ArgumentParser`` that raises ``_UsageError`` instead of printing usage and calling
    ``sys.exit(2)``. argparse funnels EVERY usage error (unknown flag, missing/invalid positional,
    invalid subcommand choice, missing required subcommand) through ``error()`` and nothing else
    through it; ``--help``/``--version`` call ``exit()`` directly, so overriding only ``error()``
    leaves them conventional (``SystemExit(0)``). ``add_subparsers`` defaults ``parser_class`` to
    ``type(self)``, so the subparsers are ``_Parser`` too — subcommand usage errors are caught for
    free."""

    # ``error`` is argparse's own hook name, so the override cannot be spelled anything else.
    def error(self, message: str) -> NoReturn:
        prog = self.prog.split()
        raise _UsageError(message, command=prog[1] if len(prog) > 1 else None)


def _build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="seikan",
        description=(
            "Stateless statistical reporter: observer-pure forward-return event studies over "
            "every declared parameter x horizon cell, over strict CSV data. Outputs are FILES the "
            "caller nominates by flag and success is SILENT — only errors print JSON on stdout. "
            "Every cell is measured and reported independently (seikan never selects a winner). "
            "Exit codes describe the RUN, not the evidence: 0 run completed / 2 data invalid / "
            "3 invalid request / 4 internal."
        ),
    )
    parser.add_argument("--version", action="version", version=f"seikan {seikan.__version__}")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser(
        "run",
        help="measure a thesis and write the nominated outputs (silent on success)",
    )
    p.add_argument("thesis", help="path to the thesis DSL JSON")
    p.add_argument("--data", action="append", default=None, metavar="KEY=PATH",
                   help="locate one series the thesis declares: KEY is a target name, an external "
                        "feed name (or FEED@TARGET for a per-target feed), or 'benchmark'; repeat "
                        "once per key. The set must answer the thesis exactly")
    p.add_argument("--column", action="append", default=None, metavar="KEY=COL",
                   help="read one series out of a named CSV column: KEY is a target or external "
                        "feed key (FEED@TARGET for one member of a per-target feed), never "
                        "'benchmark'; COL is matched case-insensitively. Needed only when that "
                        "key's file holds several numeric columns — a file with one value column "
                        "names itself; repeat once per key")
    p.add_argument("--report-out", default=None,
                   help="write the full JSON report to this file (always overwritten)")
    p.add_argument("--trades-out", default=None,
                   help="write the per-observation trades to this CSV")
    p.add_argument("--root-series-out", default=None,
                   help="write the per-bar root-series values to this CSV (no entry flags)")
    p.add_argument("--entry-flags-out", default=None,
                   help="write the per-bar 0/1 entry-flag matrix to this CSV (the output that "
                        "carries a final-bar firing)")
    p.add_argument("--pretty", action="store_true",
                   help="indent the report file and any JSON error envelope")
    _add_threshold_flags(p)
    p.set_defaults(func=_cmd_run)

    p = sub.add_parser("check-data", help="pre-flight CSV files against the strict data contract")
    p.add_argument("files", nargs="+", help="CSV files to check")
    p.add_argument("--shape", choices=["ohlcv", "series"], default=None,
                   help="require a specific shape (default: accept either)")
    p.add_argument("--pretty", action="store_true", help="indent the JSON output")
    p.set_defaults(func=_cmd_check_data)

    p = sub.add_parser(
        "describe",
        help="profile data files — pure description (changes, dispersion, range position, "
             "missingness); measures nothing, supports no thesis",
    )
    p.add_argument("files", nargs="+", help="CSV files to profile, in argument order")
    p.add_argument("--shape", choices=["ohlcv", "series"], default=None,
                   help="require a specific shape (default: accept either)")
    p.add_argument("--windows", type=_windows_arg, default=None,
                   help="comma-separated trailing windows in BARS, emitted in the given order "
                        f"(default {','.join(str(w) for w in DEFAULT_WINDOWS)}; "
                        f"at most {MAX_DESCRIBE_WINDOWS})")
    p.add_argument("--pretty", action="store_true", help="indent the JSON output")
    p.set_defaults(func=_cmd_describe)

    p = sub.add_parser(
        "schema",
        help="emit the DSL JSON Schema + thresholds + checklist contract + CSV contract",
    )
    p.add_argument("--markdown", action="store_true", help="emit the DSL guide as markdown instead")
    p.add_argument("--pretty", action="store_true", help="indent the JSON output")
    p.set_defaults(func=_cmd_schema)
    return parser


def main(argv: list[str] | None = None) -> int:
    # Parse OUTSIDE the internal-error try: --help/--version raise SystemExit(0), which must
    # propagate untouched (conventional non-JSON output), never be swallowed into an exit-4 report.
    # A usage error (bad flag, missing/unknown subcommand, …) arrives as _UsageError from _Parser.
    try:
        args = _build_parser().parse_args(argv)
    except _UsageError as exc:
        doc = _base_doc(exc.command)
        doc["error"] = {"type": "usage", "message": str(exc)}
        _emit(doc)
        sys.stderr.write(f"seikan: {exc}\n")
        return EXIT_REQUEST
    command: str = args.cmd
    try:
        # `set_defaults(func=...)` hangs each subcommand's handler off the namespace, where argparse
        # types it as Any; naming the one shape they all have keeps the exit code an int all the way
        # out of main().
        handler: Callable[[argparse.Namespace], int] = args.func
        return handler(args)
    except DataError as exc:  # before ValidationError/ValueError — DataError subclasses ValueError
        doc = _base_doc(command)
        doc["error"] = {"type": "data_invalid", "message": str(exc)}
        doc["data_report"] = exc.report
        _emit(doc, getattr(args, "pretty", False))
        sys.stderr.write(f"seikan: input data failed strict validation ({exc})\n")
        return EXIT_DATA
    except _UsageError as exc:  # an output-path preflight refusal from inside a command
        doc = _base_doc(command)
        doc["error"] = {"type": "usage", "message": str(exc)}
        _emit(doc, getattr(args, "pretty", False))
        sys.stderr.write(f"seikan: {exc}\n")
        return EXIT_REQUEST
    except _ThresholdsInvalidError as exc:
        doc = _base_doc(command)
        doc["error"] = {"type": "thresholds_invalid", "message": str(exc), "errors": exc.records}
        _emit(doc, getattr(args, "pretty", False))
        sys.stderr.write(f"seikan: invalid gate thresholds ({exc})\n")
        return EXIT_REQUEST
    except (
        ValidationError,
        json.JSONDecodeError,
        _NonFiniteJsonError,
        _ThesisFileNotFoundError,
    ) as exc:
        doc = _base_doc(command)
        error: ErrorEnvelope
        if isinstance(exc, ValidationError):
            # A multi-line pydantic message is noisy as the envelope `message`; take the first line
            # (the "N validation errors for Thesis" header) and put the specifics in `errors`.
            error = {
                "type": "dsl_invalid",
                "message": str(exc).splitlines()[0] or str(exc),
                "errors": _validation_records(exc),
            }
        else:
            error = {"type": "dsl_invalid", "message": str(exc)}
        doc["error"] = error
        _emit(doc, getattr(args, "pretty", False))
        sys.stderr.write(f"seikan: invalid thesis DSL ({str(exc).splitlines()[0]})\n")
        return EXIT_REQUEST
    except Exception as exc:  # pragma: no cover - the catch-all for genuine bugs
        doc = _base_doc(command)
        doc["error"] = {"type": "internal", "message": str(exc)}
        _emit(doc, getattr(args, "pretty", False))
        traceback.print_exc(file=sys.stderr)
        return EXIT_INTERNAL


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
