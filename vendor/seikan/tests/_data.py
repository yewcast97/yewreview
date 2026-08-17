"""Shared data-binding helpers for the suite.

A thesis NAMES its series and never locates them, so materializing market data is two steps: bind
the declared keys to files (``resolve_data_files``), then load. Every test that needs data does the
same two steps, so they live here rather than being re-spelled per module — and going through the
real resolver means a test whose mapping drifts from its DSL fails the way the CLI would, instead
of loading something the thesis never asked for.

Locating a series takes TWO facts, so both helpers take two mappings: which file answers a key
(``mapping``, always required) and — for the keys whose file holds several numeric columns — which
column of it the key reads (``columns``, the ``--column KEY=COL`` half, optional because most files
name their own single value column). Passing them separately here rather than folding a column into
the path is the point: the suite types what a caller types, so a binding this suite accepts is one
the CLI accepts.
"""

from __future__ import annotations

from seikan.api import DataFiles, MarketData, load_market_data, resolve_data_files
from seikan.dsl.schema import Thesis

__all__ = ["DataFiles", "files_for", "load"]


def files_for(
    thesis: Thesis, mapping: dict[str, str], columns: dict[str, str] | None = None
) -> DataFiles:
    """Bind ``{key: path}`` (and any ``{key: column}``) to the thesis's declared data keys,
    refusing a mismatch."""
    return resolve_data_files(
        thesis,
        {k: str(v) for k, v in mapping.items()},
        {k: str(v) for k, v in (columns or {}).items()},
    )


def load(
    thesis: Thesis, mapping: dict[str, str], columns: dict[str, str] | None = None
) -> MarketData:
    """``resolve_data_files`` + ``load_market_data`` — exactly what ``seikan run`` does."""
    return load_market_data(thesis.data, files_for(thesis, mapping, columns))
