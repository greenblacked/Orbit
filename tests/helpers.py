"""Helpers the test modules share. Importable because conftest.py puts this directory
and ``scripts/`` on the path (pytest's importlib mode does not)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
# A frozen copy of the data the content tests assert on; see its README. Never the live snapshot.
SITE_DATA = REPO / "tests" / "fixtures" / "site-data"
# The scripts import each other by bare name, as they do when run as files.
if str(REPO / "scripts") not in sys.path:
    sys.path.insert(0, str(REPO / "scripts"))


def load_script(name: str):
    """Import ``scripts/<name>.py`` as a module, without running its ``main``."""
    spec = importlib.util.spec_from_file_location(name, REPO / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, module)
    spec.loader.exec_module(module)
    return module
