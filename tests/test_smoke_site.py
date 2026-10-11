"""smoke_site.sh checks /api/health: JSON with "ok": true, and nothing less."""

from __future__ import annotations

import http.server
import os
import shutil
import subprocess
import threading

import pytest
from helpers import REPO

SCRIPT = REPO / "scripts" / "smoke_site.sh"
VERSION = "9.9.9"
BASH = shutil.which("bash")


def handler_for(
    health_status: int,
    health_body: bytes,
    flaky_path: str = "",
    flaky_404s: int = 0,
    missing_200s: int = 0,
):
    """flaky_path answers 404 for its first flaky_404s requests, then as normal.

    A path that does not exist answers 200 (as a front page would) for its first
    missing_200s requests.
    """
    seen = {"count": 0, "missing": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            status, body = 200, b""
            if self.path == flaky_path and seen["count"] < flaky_404s:
                seen["count"] += 1
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if self.path.startswith("/no-such-page-") and seen["missing"] < missing_200s:
                seen["missing"] += 1
                body = b"front page"
            elif self.path == "/version.txt":
                body = f"{VERSION}\n".encode()
            elif self.path == "/":
                body = f'<meta name="site-version" content="{VERSION}">'.encode()
            elif self.path == "/favicon.png":
                body = b"png"
            elif self.path == "/api/health":
                status, body = health_status, health_body
            else:
                status = 404
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    return Handler


def run_smoke(
    health_status: int,
    health_body: bytes,
    check_api: bool = True,
    flaky_path: str = "",
    flaky_404s: int = 0,
    missing_200s: int = 0,
):
    handler = handler_for(health_status, health_body, flaky_path, flaky_404s, missing_200s)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    assert BASH, "bash is required to run smoke_site.sh"
    env = {**os.environ, "SMOKE_SITE_TEST_MODE": "1"}
    env.pop("SMOKE_SITE_CHECK_API", None)
    if check_api:
        env["SMOKE_SITE_CHECK_API"] = "1"
    try:
        return subprocess.run(  # noqa: S603 - our own script, loopback server
            [BASH, str(SCRIPT), f"http://127.0.0.1:{server.server_port}", VERSION],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    finally:
        server.shutdown()
        server.server_close()


def test_health_ok_true_passes():
    result = run_smoke(200, b'{"ok": true, "stale": false, "count": 3}')
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    ("status", "body"),
    [
        (200, b'{"ok": false}'),
        (200, b'{"ok": "true"}'),
        (200, b'{"ok": 1}'),
        (200, b"{}"),
        (200, b"<html>not json</html>"),
        (200, b""),
        (503, b'{"ok": false, "count": 0}'),
        (503, b'{"ok": true}'),
    ],
)
def test_health_that_is_not_ok_true_fails(status, body):
    result = run_smoke(status, body)
    assert result.returncode != 0
    assert result.stderr


def test_the_health_failure_is_the_reason_for_the_failure():
    result = run_smoke(200, b'{"ok": false}')
    assert result.returncode == 1
    assert "/api/health did not answer JSON with ok true" in result.stderr


def test_without_the_override_loopback_skips_the_health_check():
    result = run_smoke(503, b"broken", check_api=False)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("path", ["/", "/favicon.png", "/api/health"])
def test_a_path_that_404s_at_first_is_retried_until_it_serves(path):
    result = run_smoke(200, b'{"ok": true}', flaky_path=path, flaky_404s=4)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    ("path", "check"),
    [
        ("/", "the front page does not carry"),
        ("/favicon.png", "the icon was not served"),
        ("/api/health", "/api/health did not answer JSON"),
    ],
)
def test_a_path_that_never_recovers_fails_and_names_the_check(path, check):
    result = run_smoke(200, b'{"ok": true}', flaky_path=path, flaky_404s=10**6)
    assert result.returncode == 1
    assert check in result.stderr
    assert "last HTTP status 404" in result.stderr


def test_a_missing_path_that_answers_200_at_first_is_retried_until_it_404s():
    result = run_smoke(200, b'{"ok": true}', missing_200s=4)
    assert result.returncode == 0, result.stderr


def test_a_missing_path_that_never_404s_fails_and_names_the_check():
    result = run_smoke(200, b'{"ok": true}', missing_200s=10**6)
    assert result.returncode == 1
    assert "did not answer 404" in result.stderr
    assert "last HTTP status 200" in result.stderr
