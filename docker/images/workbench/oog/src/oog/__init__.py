"""Oog workbench helpers: DuckDB + DuckLake and an IPython extension."""

from oog.config import Settings
from oog.duck import connect
from oog.ipython_ext import load_ipython_extension, unload_ipython_extension

__version__ = "0.1.0"

__all__ = [
    "Settings",
    "__version__",
    "connect",
    "load_ipython_extension",
    "unload_ipython_extension",
]
