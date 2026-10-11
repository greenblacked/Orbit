"""smoke_site.sh checks /api/health: JSON with "ok": true, and nothing less."""

from __future__ import annotations

import http.server
import os
import subprocess
import threading

import pytest
from helpers import REPO

SCRIPT = REPO / "scripts" / "smoke_site.sh"
VERSION = "9.9.9"


def handler_for(health_status: int, health_body: bytes):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            status, body = 200, b""
            if self.path == "/version.txt":
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


def run_smoke(health_status: int, health_body: bytes, check_api: bool = True):
    handler = handler_for(health_status, health_body)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = {**os.environ, "SMOKE_SITE_TEST_MODE": "1"}
    env.pop("SMOKE_SITE_CHECK_API", None)
    if check_api:
        env["SMOKE_SITE_CHECK_API"] = "1"
    try:
        return subprocess.run(  # noqa: S603 - our own script, loopback server
            ["bash", str(SCRIPT), f"http://127.0.0.1:{server.server_port}", VERSION],
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
