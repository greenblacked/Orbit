"""Fixtures shared by the build, bundle and browser tests.

``scripts/`` is put on the path so the tests can import the helpers the scripts import
from each other (``site_pages``), exactly as ``python scripts/<name>.py`` does.
"""

from __future__ import annotations

import os
import shutil
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpers import REPO, SITE_DATA, load_script  # noqa: E402  (after the path is set)


@pytest.fixture(scope="session")
def built(tmp_path_factory) -> Path:
    """The site built once for the session, at version ``v0``, with the frozen data.

    The build copies ``src/data`` as it is and derives nothing from the releases (the sitemap
    lists pages only), so swapping the two files after the build pins every reader: the pages,
    the local server's ``/api/*`` answers and the preview bundle. That keeps the content tests
    independent of the production snapshot (see ``tests/fixtures/site-data/README.md``).
    """
    output = tmp_path_factory.mktemp("browser") / "site"
    load_script("build_site").build(REPO / "src", output, "v0")
    for name in ("releases.json", "security.json"):
        shutil.copyfile(SITE_DATA / name, output / "data" / name)
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
def playwright_instance():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        if os.environ.get("REQUIRE_BROWSER") == "1":
            raise
        pytest.skip("playwright is not installed; CI's site-browser job runs these")
    with sync_playwright() as playwright:
        yield playwright


@pytest.fixture(scope="session")
def devices(playwright_instance):
    """Playwright's device descriptors, e.g. ``devices["iPhone 13"]``."""
    return playwright_instance.devices


@pytest.fixture(scope="session")
def browser(playwright_instance):
    options = {}
    if os.environ.get("BROWSER_CHANNEL"):
        options["channel"] = os.environ["BROWSER_CHANNEL"]
    if os.environ.get("BROWSER_EXECUTABLE"):
        options["executable_path"] = os.environ["BROWSER_EXECUTABLE"]
    launched = playwright_instance.chromium.launch(**options)
    yield launched
    launched.close()
