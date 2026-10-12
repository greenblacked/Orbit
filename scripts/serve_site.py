#!/usr/bin/env python3
"""Serve a built site on loopback the way the Worker serves it.

``python -m http.server`` is close but not the same: it has no 404 page, no trailing-slash
redirect and no response headers. This one answers a missing path with ``404.html`` and
status 404 (the Worker's ``not_found_handling``), redirects ``/about`` to ``/about/``,
hides the files Cloudflare does not publish, and applies the ``_headers`` file, so the
Content-Security-Policy a browser enforces here is the one it will enforce in production.
It does not run the Worker, but it answers the API paths the pages call from the files the
Worker falls back on: ``/api/releases.json`` is ``data/releases.json`` (with ``?vendor=``
applied), ``/api/security.json`` is ``data/security.json`` and ``/api/health`` is
``{"ok": true}``, so a local page loads its data the way a live one does.

    python scripts/serve_site.py --dir dist/site --port 8000
    python scripts/serve_site.py --port 0        # pick a free port; the first line says which

Loopback only. Standard library only.
"""

from __future__ import annotations

import argparse
import http.server
import json
import mimetypes
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
# Present in the build output but never served: the sentinel and Wrangler's ignore list,
# and the _headers rules themselves, which Cloudflare reads and does not publish.
HIDDEN = frozenset({".site-build", ".assetsignore", "_headers"})
LOOPBACK = {"127.0.0.1", "localhost"}


def releases_answer(body: bytes, query: str) -> tuple[int, bytes]:
    """The status and body of ``/api/releases.json?<query>`` from the snapshot's bytes.

    Like the Worker: ``vendor=X`` keeps only that vendor's releases, and a vendor the
    snapshot does not hold (or an empty one) is a 400 that lists the known ones.
    """
    asked = parse_qs(query, keep_blank_values=True).get("vendor")
    if asked is None:
        return 200, body
    try:
        payload = json.loads(body)
        releases = payload["releases"]
        known = sorted({release["vendor"] for release in releases})
    except (ValueError, KeyError, TypeError):
        return 200, body
    if asked[0] not in known:
        error = {"error": "unknown vendor", "vendors": known}
        return 400, json.dumps(error, separators=(",", ":")).encode("utf-8")
    payload["releases"] = [release for release in releases if release["vendor"] == asked[0]]
    return 200, json.dumps(payload, separators=(",", ":")).encode("utf-8")


def parse_headers(text: str) -> list[tuple[re.Pattern[str], list[tuple[str, str]]]]:
    """Rules from a Cloudflare ``_headers`` file: a path pattern, then indented ``Name: value``.

    ``*`` matches anything, including slashes, which is the file format's splat.
    """
    rules: list[tuple[re.Pattern[str], list[tuple[str, str]]]] = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            pattern = re.compile(
                "^" + ".*".join(re.escape(p) for p in line.strip().split("*")) + "$"
            )
            rules.append((pattern, []))
        elif rules and ":" in line:
            name, _, value = line.strip().partition(":")
            rules[-1][1].append((name.strip(), value.strip()))
    return rules


def make_handler(root: Path):
    root = root.resolve()
    headers_file = root / "_headers"
    rules = (
        parse_headers(headers_file.read_text(encoding="utf-8")) if headers_file.is_file() else []
    )
    not_found = root / "404.html"

    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "serve_site"

        def log_message(self, *args):  # the caller's output is theirs, not a request log
            pass

        def _locate(self, path: str) -> Path | None:
            relative = unquote(path).lstrip("/")
            target = (root / relative).resolve()
            if target != root and root not in target.parents:
                return None
            if target.is_dir():
                target = target / "index.html"
            if target.is_file() and target.name not in HIDDEN:
                return target
            return None

        def _send(self, status: int, body: bytes, kind: str, path: str, head: bool) -> None:
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for pattern, pairs in rules:
                if pattern.match(path):
                    for name, value in pairs:
                        self.send_header(name, value)
            self.end_headers()
            if not head:
                self.wfile.write(body)

        def _serve(self, head: bool) -> None:
            parts = urlsplit(self.path)
            path = parts.path or "/"
            candidate = (root / unquote(path).lstrip("/")).resolve()
            if (
                candidate.is_dir()
                and not path.endswith("/")
                and root in {candidate, *candidate.parents}
            ):
                self.send_response(308)
                self.send_header(
                    "Location", path + "/" + (f"?{parts.query}" if parts.query else "")
                )
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if path == "/api/health":
                self._send(200, b'{"ok":true}', "application/json; charset=utf-8", path, head)
                return
            if path == "/api/releases.json":
                snapshot = self._locate("/data/releases.json")
                if snapshot is not None:
                    status, body = releases_answer(snapshot.read_bytes(), parts.query)
                    self._send(status, body, "application/json; charset=utf-8", path, head)
                    return
            if path == "/api/security.json":
                notes = self._locate("/data/security.json")
                if notes is not None:
                    self._send(
                        200, notes.read_bytes(), "application/json; charset=utf-8", path, head
                    )
                    return
            target = self._locate(path)
            if target is not None:
                kind = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                if kind.startswith("text/") or kind in {
                    "application/javascript",
                    "application/json",
                }:
                    kind += "; charset=utf-8"
                self._send(200, target.read_bytes(), kind, path, head)
                return
            body = not_found.read_bytes() if not_found.is_file() else b"Not found\n"
            self._send(404, body, "text/html; charset=utf-8", path, head)

        def do_GET(self) -> None:
            self._serve(head=False)

        def do_HEAD(self) -> None:
            self._serve(head=True)

    return Handler


def make_server(
    root: Path, port: int = 0, bind: str = "127.0.0.1"
) -> http.server.ThreadingHTTPServer:
    """A server for ``root`` that is bound but not yet serving; ``port`` 0 picks a free one."""
    if bind not in LOOPBACK:
        raise SystemExit(f"refusing to bind {bind}: this server is for loopback only")
    if not root.is_dir():
        raise SystemExit(f"no built site at {root}; run scripts/build_site.py first")
    return http.server.ThreadingHTTPServer((bind, port), make_handler(root))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="serve_site", description=__doc__.split("\n", 1)[0])
    parser.add_argument("--dir", type=Path, default=ROOT / "dist" / "site", help="built site")
    parser.add_argument("--port", type=int, default=8000, help="port; 0 picks a free one")
    parser.add_argument("--bind", default="127.0.0.1", help="loopback address only")
    args = parser.parse_args(argv)
    server = make_server(args.dir, args.port, args.bind)
    print(f"serving http://{server.server_address[0]}:{server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
