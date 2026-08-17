"""Strict CSV ingestion — the verifier's front door for untrusted external data.

Calling agents bring their own time series; seikan trusts nothing about them. Every file passes
through :func:`read_strict_csv` (strict ISO-8601 timestamps, no format guessing, forced-float value
columns, duplicate/order checks) and the :func:`check_frame` integrity gate (OHLC invariants,
positive prices, no inf) before the engine sees a single number. All violations for a file are
accumulated — never fail-fast — and every check lands in a structured ``data_report`` the CLI emits
even on refusal (exit 2), so a calling agent can fix its data without guesswork.

Refusals vs warnings: structural defects (bad timestamps, non-numeric garbage, inverted OHLC)
refuse; market-shaped anomalies (interior NaN holes, crash-sized moves, calendar gaps) only warn —
crashes and halts are the research subject, not dirt.
"""

from __future__ import annotations

import csv
import hashlib
import io
from dataclasses import dataclass
from dataclasses import field as dc_field
from typing import Unpack

import numpy as np
import pandas as pd

from seikan.types import (
    DataIssue,
    DataIssueExtras,
    DataReport,
    FileReportEntry,
    IssueExample,
    JoinInfo,
)

_OHLC = ("open", "high", "low", "close")

#: |1-bar close return| beyond this warns of a possible unadjusted split (never refuses).
_LARGE_MOVE = 0.5
#: An index gap larger than this multiple of the median spacing warns (never refuses).
_GAP_FACTOR = 10.0
#: How many offending rows an error message names before truncating.
MAX_EXAMPLES = 5
#: Fewer than this many possible anchor bars beyond the longest horizon → barely_sufficient warning.
_MIN_COMFORT_ANCHORS = 8


class IntegrityError(ValueError):
    """Raised by :func:`check_frame` with the full list of integrity violations."""

    def __init__(self, violations: list[str]) -> None:
        self.violations = violations
        super().__init__("; ".join(violations))


class DataError(ValueError):
    """Input data failed strict validation — maps to CLI exit 2. Carries the structured report."""

    def __init__(
        self, report: DataReport, message: str = "input data failed strict validation"
    ) -> None:
        self.report = report
        super().__init__(message)


@dataclass
class FileReport:
    """Per-file result of the strict read: every error and warning, machine-readable."""

    path: str
    role: str = "file"
    shape: str | None = None
    n_rows: int | None = None
    start: str | None = None
    end: str | None = None
    #: sha256 of the file's raw bytes — the report's data identity (a changed byte is a
    #: different exam). Computed before content validation, so even a refused file carries
    #: its digest; None only when the file itself could not be read.
    sha256: str | None = None
    errors: list[DataIssue] = dc_field(default_factory=list)
    warnings: list[DataIssue] = dc_field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def error(self, code: str, message: str, **extra: Unpack[DataIssueExtras]) -> None:
        self.errors.append({"code": code, "message": message, **extra})

    def warn(self, code: str, message: str, **extra: Unpack[DataIssueExtras]) -> None:
        self.warnings.append({"code": code, "message": message, **extra})

    def to_dict(self) -> FileReportEntry:
        return {
            "path": self.path,
            "role": self.role,
            "ok": self.ok,
            "shape": self.shape,
            "n_rows": self.n_rows,
            "start": self.start,
            "end": self.end,
            "sha256": self.sha256,
            "errors": self.errors,
            "warnings": self.warnings,
        }


def build_data_report(
    files: list[FileReport],
    join: JoinInfo | None = None,
    errors: list[DataIssue] | None = None,
) -> DataReport:
    """Aggregate per-file reports (+ optional cross-file join info and top-level errors)."""
    errors = list(errors or [])
    return {
        "ok": not errors and all(f.ok for f in files),
        "files": [f.to_dict() for f in files],
        "join": join,
        "errors": errors,
    }


def check_frame(df: pd.DataFrame, *, shape: str) -> None:
    """Validate a canonical frame. Raises :class:`IntegrityError` listing every violation.

    ``shape`` is ``"ohlcv"`` or ``"series"``. Interior NaN holes are tolerated (the engine censors
    them as ``no_outcome``); all-NaN columns and non-finite (inf) values are not.
    """
    v: list[str] = []

    # --- general well-formedness ----------------------------------------------------------
    if not isinstance(df.index, pd.DatetimeIndex):
        v.append("index is not a DatetimeIndex")
    else:
        if df.index.isna().any():
            v.append("index has unparsed timestamps (NaT)")
        if not df.index.is_monotonic_increasing:
            v.append("index is not sorted ascending")
        if df.index.has_duplicates:
            v.append("index has duplicate timestamps")
    if len(df) == 0:
        v.append("frame has no rows")
    if df.shape[1] == 0:
        v.append("frame has no columns")

    for c in df.columns:
        if not pd.api.types.is_numeric_dtype(df[c]):
            v.append(f"column {c!r} is not numeric")
            continue
        col = df[c].to_numpy(dtype="float64", na_value=np.nan)
        if np.isnan(col).all():
            v.append(f"column {c!r} is entirely NaN")
        elif np.isinf(col).any():
            v.append(f"column {c!r} has non-finite (inf) values")

    # --- OHLCV invariants -----------------------------------------------------------------
    if shape == "ohlcv":
        missing = [c for c in _OHLC if c not in df.columns]
        if missing:
            v.append(f"ohlcv frame missing columns {missing}")
        else:
            o, h, lo, c = df["open"], df["high"], df["low"], df["close"]
            if (h < lo).any():
                v.append("ohlcv has bars where high < low")
            if (h < o).any() or (h < c).any():
                v.append("ohlcv has bars where high < open/close")
            if (lo > o).any() or (lo > c).any():
                v.append("ohlcv has bars where low > open/close")
            if (df[list(_OHLC)] <= 0).to_numpy().any():
                v.append("ohlcv has non-positive prices")
            if "volume" in df.columns and (df["volume"] < 0).any():
                v.append("ohlcv has negative volume")

    if v:
        raise IntegrityError(v)


def _examples(mask: pd.Series, raw: pd.Series | None = None) -> list[IssueExample]:
    """First offending rows as ``{csv_line, value?}`` records (csv line = row index + 2: header)."""
    out: list[IssueExample] = []
    for pos in np.flatnonzero(mask.to_numpy())[:MAX_EXAMPLES]:
        rec: IssueExample = {"csv_line": int(pos) + 2}
        if raw is not None:
            rec["value"] = str(raw.iloc[int(pos)])
        out.append(rec)
    return out


def read_strict_csv(
    path: str, *, role: str = "file", expected_shape: str | None = None
) -> tuple[pd.DataFrame | None, FileReport]:
    """Read one CSV under the strict contract → ``(canonical frame | None, FileReport)``.

    The canonical frame: a tz-naive, sorted, unique ``DatetimeIndex`` named ``datetime`` (from a
    column named ``datetime``, case-insensitive, or else the first column), every value column
    float64, column names lowercased. The contract, each violation a machine-readable error:

    - strict **ISO-8601** timestamps (``YYYY-MM-DD`` or full ISO timestamps), timezone-**naive**;
      no ``dayfirst``/format inference, ever
    - unique, ascending timestamps
    - value columns parse as numbers; the only missing-value markers are an empty cell or ``nan``
    - no duplicate column names, no empty/header-only file
    - :func:`check_frame` invariants for the detected (or ``expected_shape``) shape

    Warnings (returned, never refusing): per-column NaN fraction, |1-bar close return| >
    ``_LARGE_MOVE`` (possible unadjusted split), calendar gaps > ``_GAP_FACTOR`` × median spacing.

    The report also carries the file's raw-byte ``sha256`` — the run's data identity, computed
    before any validation so even a refused file keeps its digest.

    The file is read ONCE and every stage (digest, header sniff, parse) consumes that one
    buffer, so the digest describes exactly the bytes the engine measured: a rewrite between
    stages cannot split the reported identity from the evidence actually parsed. The
    whole file is held in memory — pandas materialized it anyway.
    """
    rep = FileReport(path=str(path), role=role)

    # --- the single read: one buffer feeds the digest, the header sniff, and the parse -----
    try:
        with open(path, "rb") as fh:
            blob = fh.read()
    except FileNotFoundError:
        rep.error("file_missing", f"{path}: file not found")
        return None, rep
    except (IsADirectoryError, PermissionError) as exc:
        rep.error("unreadable", f"{path}: {exc}")
        return None, rep
    rep.sha256 = hashlib.sha256(blob).hexdigest()

    # --- header inspection (before pandas mangles duplicate names to `col.1`) -------------
    try:
        header = next(
            csv.reader(io.TextIOWrapper(io.BytesIO(blob), encoding="utf-8-sig", newline="")), None
        )
    except UnicodeDecodeError as exc:  # decoding is lazy — it surfaces at the first read
        rep.error("unreadable", f"{path}: {exc}")
        return None, rep
    if header is None:
        rep.error("empty_file", f"{path}: file is empty")
        return None, rep
    cols = [str(c).strip().lower() for c in header]
    dups = sorted({c for c in cols if cols.count(c) > 1})
    if dups:
        rep.error(
            "duplicate_column",
            f"{path}: duplicate column name(s) {dups} — every column must be uniquely named",
        )
        return None, rep

    # --- full read, everything as strings (no type guessing) ------------------------------
    try:
        raw = pd.read_csv(io.BytesIO(blob), dtype=str, keep_default_na=False, encoding="utf-8-sig")
    except Exception as exc:
        rep.error("unreadable", f"{path}: could not be parsed as CSV ({exc})")
        return None, rep
    raw.columns = [str(c).strip().lower() for c in raw.columns]
    if len(raw) == 0:
        rep.error("header_only", f"{path}: has a header but no data rows")
        return None, rep

    # --- timestamps: strict ISO-8601, naive, unique, ascending -----------------------------
    ts_col = "datetime" if "datetime" in raw.columns else raw.columns[0]
    ts_raw = raw[ts_col].str.strip()
    ts: pd.Series | None
    try:
        ts = pd.to_datetime(ts_raw, format="ISO8601", errors="coerce")
    except (ValueError, TypeError) as exc:  # e.g. mixed timezone offsets
        ts = None
        rep.error(
            "bad_timestamp",
            f"{path}: timestamp column {ts_col!r} failed strict ISO-8601 parsing ({exc})",
        )
    if ts is not None:
        bad = ts.isna()
        if bad.any():
            rep.error(
                "bad_timestamp",
                f"{path}: {int(bad.sum())} timestamp(s) in column {ts_col!r} are not "
                "ISO-8601 (expected YYYY-MM-DD or an ISO timestamp; no other format is accepted)",
                examples=_examples(bad, ts_raw),
            )
            ts = None
        elif getattr(ts.dt, "tz", None) is not None:
            rep.error(
                "tz_aware_timestamp",
                f"{path}: timestamps carry a timezone offset — provide timezone-naive "
                "ISO-8601 timestamps (drop the offset at export time)",
            )
            ts = None
    if ts is not None:
        dup = ts.duplicated()
        if dup.any():
            rep.error(
                "duplicate_timestamp",
                f"{path}: {int(dup.sum())} duplicate timestamp(s)",
                examples=_examples(dup, ts_raw),
            )
        unsorted = ts < ts.shift(1)
        if unsorted.any():
            rep.error(
                "unsorted_timestamp",
                f"{path}: timestamps are not sorted ascending",
                examples=_examples(unsorted, ts_raw),
            )

    # --- value columns: forced float, empty/'nan' the only missing markers -----------------
    value_cols = [c for c in raw.columns if c != ts_col]
    if not value_cols:
        rep.error("no_value_columns", f"{path}: no value columns besides the timestamp")
    data: dict[str, pd.Series] = {}
    for c in value_cols:
        s = raw[c].str.strip()
        num = pd.to_numeric(s, errors="coerce")
        is_missing = (s == "") | (s.str.lower() == "nan")
        bad = num.isna() & ~is_missing
        if bad.any():
            rep.error(
                "non_numeric_value",
                f"{path}: column {c!r} has {int(bad.sum())} non-numeric value(s)",
                column=c,
                examples=_examples(bad, s),
            )
        data[c] = num.astype(float).to_numpy()  # positional values; the frame gets the ts index

    if not rep.ok or ts is None:
        return None, rep

    df = pd.DataFrame(data, index=pd.DatetimeIndex(ts, name="datetime"))

    # --- shape + integrity invariants -------------------------------------------------------
    detected = "ohlcv" if all(c in df.columns for c in _OHLC) else "series"
    if expected_shape is not None and detected != expected_shape:
        rep.error(
            "shape_mismatch",
            f"{path}: expected a {expected_shape}-shaped file but found {detected} "
            f"(columns: {list(df.columns)})",
        )
    shape = expected_shape or detected
    rep.shape = detected
    try:
        check_frame(df, shape=shape)
    except IntegrityError as exc:
        for violation in exc.violations:
            rep.error("integrity", f"{path}: {violation}")
    if rep.errors:  # the same read as `not rep.ok` — the violations above land in this list
        return None, rep

    # --- descriptive info + warnings --------------------------------------------------------
    rep.n_rows = len(df)
    rep.start = df.index[0].isoformat()
    rep.end = df.index[-1].isoformat()
    for c in df.columns:
        frac = float(df[c].isna().mean())
        if frac > 0:
            rep.warn(
                "nan_fraction",
                f"{path}: column {c!r} is {frac:.1%} NaN (holes censor observations)",
                column=c,
                value=round(frac, 4),
            )
    if detected == "ohlcv" and len(df) > 1:
        # ffill + fill_method=None == pct_change's deprecated pad default: a bar after a hole is
        # still measured against the last pre-hole close (the hole itself stays NaN → no flag).
        move = df["close"].ffill().pct_change(fill_method=None).abs()
        big = move > _LARGE_MOVE
        if big.any():
            rep.warn(
                "large_move",
                f"{path}: {int(big.sum())} bar(s) move more than {_LARGE_MOVE:.0%} close-to-close "
                "— verify the series is split/dividend-adjusted",
                examples=_examples(big, df["close"].astype(str)),
            )
    if len(df) > 2:
        deltas = df.index.to_series().diff().dropna()
        median = deltas.median()
        if median > pd.Timedelta(0):
            gaps = deltas > _GAP_FACTOR * median
            if gaps.any():
                rep.warn(
                    "calendar_gap",
                    f"{path}: {int(gaps.sum())} gap(s) larger than {_GAP_FACTOR:.0f}× the median "
                    f"bar spacing ({median})",
                )
    return df, rep


def sufficiency_check(
    n_common: int, horizons: int | list[int], *, off: int = 1
) -> tuple[list[DataIssue], list[DataIssue]]:
    """Structural sufficiency of the joined index vs the thesis horizon → ``(errors, warnings)``.

    A closed observation at the longest horizon ``h`` needs ``h + off + 1`` bars; below that no
    observation can ever close and the run is refused up front rather than producing an empty,
    trivially-uninformative summary. A barely-sufficient index only warns.
    """
    hs = horizons if isinstance(horizons, (list, tuple)) else [horizons]
    h_max = max(int(h) for h in hs)
    need = h_max + off + 1
    errors: list[DataIssue] = []
    warnings: list[DataIssue] = []
    if n_common < need:
        errors.append(
            {
                "code": "insufficient_common_index",
                "message": (
                    f"joined common index has {n_common} bars; the longest horizon ({h_max}) "
                    f"needs at least {need} (horizon + {off} + 1) for a single closed observation"
                ),
            }
        )
    elif n_common - (h_max + off) < _MIN_COMFORT_ANCHORS:
        warnings.append(
            {
                "code": "barely_sufficient",
                "message": (
                    f"only {n_common - (h_max + off)} bars can anchor a closed observation at the "
                    f"longest horizon ({h_max}) — statistics will be extremely thin"
                ),
            }
        )
    return errors, warnings
