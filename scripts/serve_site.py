#!/usr/bin/env python3
"""Serve a built site on loopback the way the Worker serves it.

``python -m http.server`` is close but not the same: it has no 404 page, no trailing-slash
redirect and no response headers. This one answers a missing path with ``404.html`` and
status 404 (the Worker's ``not_found_handling``), redirects ``/about`` to ``/about/``,
hides the files Cloudflare does not publish, and applies the ``_headers`` file, so the
Content-Security-Policy a browser enforces here is the one it will enforce in production.
It does not run the Worker, but it answers the API paths the pages call from the files the
Worker falls back on: ``/api/releases.json`` is ``data/releases.json`` (with ``?vendor=``
applied), ``/api/security.json`` is ``data/security.json``, ``/api/feed.atom`` and
``/api/feed.json`` are the same releases as feeds (``deploy/feeds.js`` in Python, with the
same filters) and ``/api/health`` is ``{"ok": true}``, so a local page loads its data the way
a live one does.

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
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

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


SITE = "https://orbit.szolotov.com"
MAX_ENTRIES = 100
STAGES = ["release", "beta", "rc"]
ATOM_TYPE = "application/atom+xml; charset=utf-8"
JSON_FEED_TYPE = "application/feed+json; charset=utf-8"
FEED_TITLE = "Release Orbit releases"
FEED_SUBTITLE = "Recent OS releases, betas and release candidates, newest first."
TAG_PREFIX = "tag:orbit.szolotov.com,2026:release:"
FEED_FILTERS = ("vendor", "family", "stage")
FILTER_PLURALS = {"vendor": "vendors", "family": "families", "stage": "stages"}
XML_FORBIDDEN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")
XML_ESCAPES = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"}


def xml_escape(value: object) -> str:
    """Text for an XML text node or attribute; mirrors ``xmlEscape`` in deploy/feeds.js."""
    text = XML_FORBIDDEN.sub("", "" if value is None else str(value))
    return re.sub(r"[&<>\"']", lambda m: XML_ESCAPES[m.group(0)], text)


def _component(value: str) -> str:
    return quote(value, safe="-_.!~*'()")  # JavaScript's encodeURIComponent


def _when(text: object) -> datetime | None:
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _stamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _allowed_link(hosts: dict[str, list[str]], vendor: object, link: object) -> bool:
    try:
        parts = urlsplit(str(link))
        return parts.scheme == "https" and parts.hostname in hosts.get(str(vendor), [])
    except ValueError:
        return False


def _summary(release: dict) -> str:
    if release.get("stage") == "release":
        stage = "Release"
    else:
        stage = "RC" if release.get("stage") == "rc" else "Beta"
        stage += f" {release['beta']}" if release.get("beta") else ""
    build = release.get("build")
    extra = f", build {build}" if build and build != release.get("version") else ""
    text = f"{release.get('family') or release.get('vendor')} {release.get('version') or ''}: "
    return re.sub(r"\s+", " ", f"{text}{stage}{extra}").strip()


def feed_answer(
    kind: str, snapshot: bytes, config: bytes | None, query: str
) -> tuple[int, bytes, str]:
    """The status, body and content type of ``/api/feed.<kind>?<query>`` from the snapshot.

    The Python twin of ``deploy/feeds.js``: the same filters (an unknown ``vendor``, ``family``
    or ``stage`` is a 400 JSON), the newest ``MAX_ENTRIES`` releases, an entry linking to its
    vendor only on an allowed host and otherwise to its timeline row. ``config`` is
    ``data/families.json`` (the families and the vendors' hosts).
    """
    json_type = "application/json; charset=utf-8"
    try:
        releases = json.loads(snapshot)["releases"]
        known = json.loads(config) if config else {}
        families = [f["id"] for f in known.get("families", [])] or sorted(
            {r["family"] for r in releases}
        )
        hosts = {v["id"]: v["source"]["hosts"] for v in known.get("vendors", [])}
        vendors = sorted({r["vendor"] for r in releases})
    except (ValueError, KeyError, TypeError):
        return 503, b'{"error":"no releases available"}', json_type
    options = {"vendor": vendors, "family": families, "stage": STAGES}
    asked = parse_qs(query, keep_blank_values=True)
    filters: dict[str, str] = {}
    for name in FEED_FILTERS:
        if name in asked:
            if asked[name][0] not in options[name]:
                error = {"error": f"unknown {name}", FILTER_PLURALS[name]: options[name]}
                return 400, json.dumps(error, separators=(",", ":")).encode("utf-8"), json_type
            filters[name] = asked[name][0]
    chosen = []
    for release in releases:
        moment = _when(release.get("date")) if isinstance(release, dict) else None
        if moment is None or not isinstance(release.get("id"), str) or not release["id"]:
            continue
        if all(release.get(name) == value for name, value in filters.items()):
            chosen.append((moment, release))
    chosen.sort(key=lambda item: item[0], reverse=True)
    chosen = chosen[:MAX_ENTRIES]

    def link(release: dict) -> str:
        if _allowed_link(hosts, release.get("vendor"), release.get("url")):
            return urlsplit(release["url"]).geturl()
        return f"{SITE}/timeline/?id={_component(release['id'])}"

    suffix = "&".join(f"{n}={_component(filters[n])}" for n in FEED_FILTERS if n in filters)
    suffix = f"?{suffix}" if suffix else ""
    parts = [filters[n] for n in FEED_FILTERS if n in filters]
    title = f"{FEED_TITLE} ({', '.join(parts)})" if parts else FEED_TITLE
    if kind == "json":
        feed = {
            "version": "https://jsonfeed.org/version/1.1",
            "title": title,
            "description": FEED_SUBTITLE,
            "home_page_url": f"{SITE}/timeline/",
            "feed_url": f"{SITE}/api/feed.json{suffix}",
            "language": "en",
            "authors": [{"name": "Release Orbit"}],
            "items": [
                {
                    "id": TAG_PREFIX + _component(r["id"]),
                    "url": link(r),
                    "title": r.get("title") or _summary(r),
                    "content_text": _summary(r),
                    "date_published": _stamp(m),
                    "tags": [t for t in (r.get("family"), r.get("stage")) if t],
                }
                for m, r in chosen
            ],
        }
        return 200, json.dumps(feed, separators=(",", ":")).encode("utf-8"), JSON_FEED_TYPE
    own = f"{SITE}/api/feed.atom{suffix}"
    updated = _stamp(chosen[0][0]) if chosen else _stamp(datetime.now(timezone.utc))
    lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">',
        f"<id>{xml_escape(own)}</id>",
        f"<title>{xml_escape(title)}</title>",
        f"<subtitle>{xml_escape(FEED_SUBTITLE)}</subtitle>",
        f"<updated>{updated}</updated>",
        f'<link rel="self" type="application/atom+xml" href="{xml_escape(own)}"/>',
        f'<link rel="alternate" type="text/html" href="{xml_escape(SITE + "/timeline/")}"/>',
        "<author><name>Release Orbit</name></author>",
    ]
    for moment, release in chosen:
        when = _stamp(moment)
        lines += [
            "<entry>",
            f"<id>{xml_escape(TAG_PREFIX + _component(release['id']))}</id>",
            f"<title>{xml_escape(release.get('title') or _summary(release))}</title>",
            f'<link rel="alternate" type="text/html" href="{xml_escape(link(release))}"/>',
            f"<published>{when}</published>",
            f"<updated>{when}</updated>",
            *(
                f'<category term="{xml_escape(t)}"/>'
                for t in (release.get("family"), release.get("stage"))
                if isinstance(t, str) and t
            ),
            f'<summary type="text">{xml_escape(_summary(release))}</summary>',
            "</entry>",
        ]
    lines += ["</feed>", ""]
    return 200, "\n".join(lines).encode("utf-8"), ATOM_TYPE


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
            matched = [pairs for pattern, pairs in rules if pattern.match(path)]
            if not any(name.lower() == "cache-control" for pairs in matched for name, _ in pairs):
                self.send_header("Cache-Control", "no-store")
            for pairs in matched:
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
            if path in ("/api/feed.atom", "/api/feed.json"):
                snapshot = self._locate("/data/releases.json")
                if snapshot is not None:
                    config = self._locate("/data/families.json")
                    status, body, kind = feed_answer(
                        path.rsplit(".", 1)[1],
                        snapshot.read_bytes(),
                        config.read_bytes() if config is not None else None,
                        parts.query,
                    )
                    self._send(status, body, kind, path, head)
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
