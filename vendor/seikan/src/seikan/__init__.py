"""seikan — a stateless CLI statistical reporter for observer-pure thesis measurement.

Thesis DSL JSON + strict CSV time series in, a complete JSON report FILE out: every declared
parameter × horizon cell measured on full-sample evidence and reported independently, plus a
separate per-cell checklist section. Nothing is selected, ranked, or crowned — choosing among the
cells, and pricing the multiplicity of having declared them, belongs to the calling agent. No
persistence, no network, no hidden state.
"""

from importlib.metadata import PackageNotFoundError, version

from seikan.analysis.result import EntryListReport, EventStudyResult
from seikan.api import (
    DataFiles,
    MarketData,
    compile_thesis,
    list_entries,
    load_market_data,
    resolve_data_files,
)
from seikan.dsl.schema import Thesis
from seikan.serialize import serialize_result

try:
    __version__ = version("seikan")
except PackageNotFoundError:  # running from a source tree without installation
    __version__ = "1.0.0"

__all__ = [
    "DataFiles",
    "EntryListReport",
    "EventStudyResult",
    "MarketData",
    "Thesis",
    "__version__",
    "compile_thesis",
    "list_entries",
    "load_market_data",
    "resolve_data_files",
    "serialize_result",
]
