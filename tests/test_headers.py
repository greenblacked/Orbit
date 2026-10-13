"""The response headers and the pages agree: a strict CSP that the markup never trips."""

from __future__ import annotations

import re

import pytest
from helpers import REPO, load_script

serve = load_script("serve_site")
HEADERS = (REPO / "src" / "_headers").read_text(encoding="utf-8")


def header(name: str) -> str:
    found = re.search(rf"^\s+{re.escape(name)}: (.+)$", HEADERS, flags=re.MULTILINE)
    assert found, f"_headers does not set {name}"
    return found.group(1)


def csp() -> dict[str, list[str]]:
    directives = {}
    for part in header("Content-Security-Policy").split(";"):
        name, *values = part.split()
        directives[name] = values
    return directives


def test_the_headers_apply_to_every_path():
    assert re.search(r"^/\*$", HEADERS, flags=re.MULTILINE)


def test_the_csp_is_strict():
    policy = csp()
    assert policy["default-src"] == ["'self'"]
    assert policy["script-src"] == ["'self'"]
    assert policy["object-src"] == ["'none'"]
    assert policy["base-uri"] == ["'none'"]
    assert policy["frame-ancestors"] == ["'none'"]
    assert policy["form-action"] == ["'self'"]
    flat = header("Content-Security-Policy")
    for weakening in ("'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "data: https:", " * "):
        assert weakening not in flat
    for name, values in policy.items():
        assert "*" not in values, name
        assert "http:" not in values, name


def test_the_only_outside_origins_are_the_font_hosts():
    allowed = {"https://fonts.googleapis.com", "https://fonts.gstatic.com"}
    origins = {v for values in csp().values() for v in values if v.startswith("https://")}
    assert origins <= allowed


def test_the_other_security_headers_are_set():
    assert header("X-Content-Type-Options") == "nosniff"
    assert header("Referrer-Policy") == "strict-origin-when-cross-origin"
    permissions = header("Permissions-Policy")
    for feature in ("camera", "microphone", "geolocation"):
        assert f"{feature}=()" in permissions


def test_hsts_is_left_to_the_zone():
    # Sent from _headers it would reach every host the Worker answers on, workers.dev and
    # the preview hosts included, and a long max-age with includeSubDomains or preload
    # cannot be taken back. It is a zone setting; SETUP.md says when to turn it on.
    assert "Strict-Transport-Security" not in HEADERS


@pytest.mark.parametrize("page", sorted((REPO / "src").rglob("*.html")), ids=lambda p: p.name)
def test_no_page_uses_what_the_csp_blocks(page):
    text = page.read_text(encoding="utf-8")
    assert not re.search(r"<script(?![^>]*\bsrc=)", text), "inline <script>"
    assert not re.search(r"<style\b", text), "inline <style>"
    assert not re.search(r"\sstyle=", text), "style attribute"
    assert not re.search(r"\son[a-z]+=", text), "inline event handler"
    assert "javascript:" not in text


def applied(path: str) -> dict[str, str]:
    """The headers Cloudflare would add to ``path``: every matching block, in file order."""
    found: dict[str, str] = {}
    for pattern, pairs in serve.parse_headers(HEADERS):
        if pattern.match(path):
            found.update(pairs)
    return found


def test_assets_are_cached_for_an_hour_with_an_hour_of_stale_revalidation():
    # The file names carry no content hash, so the lifetime stays modest.
    expected = "public, max-age=3600, stale-while-revalidate=3600"
    for path in ("/assets/site.css", "/assets/site.js"):
        assert applied(path)["Cache-Control"] == expected


def test_data_is_cached_for_five_minutes():
    assert applied("/data/releases.json")["Cache-Control"] == "public, max-age=300"


def test_pages_and_root_files_get_no_cache_rule():
    # Pages keep the platform default and revalidate, so a release shows at once.
    for path in ("/", "/about/", "/compare/", "/timeline/", "/404.html", "/og.png"):
        assert "Cache-Control" not in applied(path), path


def test_the_cache_rules_leave_the_security_headers_on_assets():
    assert "default-src 'self'" in applied("/assets/site.js")["Content-Security-Policy"]
