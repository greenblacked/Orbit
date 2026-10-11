"""Fixtures shared by the build, bundle and browser tests.

``scripts/`` is put on the path so the tests can import the helpers the scripts import
from each other (``site_pages``), exactly as ``python scripts/<name>.py`` does.
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpers import REPO, load_script  # noqa: E402  (after the path is set)


@pytest.fixture(scope="session")
def built(tmp_path_factory) -> Path:
    """The site built once for the session, at version ``v0``."""
    output = tmp_path_factory.mktemp("browser") / "site"
    load_script("build_site").build(REPO / "src", output, "v0")
    return output


@pytest.fixture(scope="session")
def base_url(built):
    """The build served on loopback the way the Worker serves it: 404 page, headers."""
    server = load_script("serve_site").make_server(built)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


@pytest.fixture(scope="session")
def browser():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        if os.environ.get("REQUIRE_BROWSER") == "1":
            raise
        pytest.skip("playwright is not installed; CI's site-browser job runs these")
    options = {}
    if os.environ.get("BROWSER_CHANNEL"):
        options["channel"] = os.environ["BROWSER_CHANNEL"]
    if os.environ.get("BROWSER_EXECUTABLE"):
        options["executable_path"] = os.environ["BROWSER_EXECUTABLE"]
    with sync_playwright() as playwright:
        launched = playwright.chromium.launch(**options)
        yield launched
        launched.close()
