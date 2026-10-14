"""serve_site behaves like the Worker: 404 page, trailing slash, headers, hidden files."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

import pytest
from helpers import load_script

serve = load_script("serve_site")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def get(base: str, path: str, method: str = "GET"):
    opener = urllib.request.build_opener(NoRedirect)
    request = urllib.request.Request(base + path, method=method)  # noqa: S310 - loopback
    try:
        with opener.open(request, timeout=5) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


def test_a_page_is_served_with_the_headers_file_applied(base_url):
    status, headers, body = get(base_url, "/")
    assert status == 200
    assert b"<h1" in body
    assert "default-src 'self'" in headers["Content-Security-Policy"]
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["Content-Type"].startswith("text/html")


def test_a_missing_path_answers_404_with_the_404_page(base_url):
    status, headers, body = get(base_url, "/no/such/page/")
    assert status == 404
    assert b"Not found" in body
    assert "Content-Security-Policy" in headers


def test_a_directory_without_a_slash_redirects_to_the_slash(base_url):
    status, headers, _ = get(base_url, "/about?x=1")
    assert status == 308
    assert headers["Location"] == "/about/?x=1"


@pytest.mark.parametrize("path", ["/_headers", "/.site-build", "/.assetsignore"])
def test_build_bookkeeping_files_are_not_published(base_url, path):
    assert get(base_url, path)[0] == 404


@pytest.mark.parametrize("path", ["/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "//etc/passwd"])
def test_a_path_cannot_leave_the_site(base_url, path):
    status, _, body = get(base_url, path)
    assert status in {404, 400}
    assert b"root:" not in body


def test_head_has_no_body(base_url):
    status, headers, body = get(base_url, "/", method="HEAD")
    assert status == 200
    assert body == b""
    assert int(headers["Content-Length"]) > 0


def test_only_loopback_is_allowed(built):
    with pytest.raises(SystemExit):
        serve.make_server(built, 0, "0.0.0.0")  # noqa: S104 - the refusal is the test


def test_headers_parser_reads_blocks_and_splats():
    rules = serve.parse_headers("# c\n/*\n  A: 1\n  B: two: parts\n/assets/*\n  C: 3\n")
    assert [p.pattern for p, _ in rules] == ["^/.*$", "^/assets/.*$"]
    assert rules[0][1] == [("A", "1"), ("B", "two: parts")]


def test_the_releases_api_is_answered_from_the_snapshot(base_url):
    status, headers, body = get(base_url, "/api/releases.json")
    assert status == 200
    assert headers["Content-Type"].startswith("application/json")
    snapshot = get(base_url, "/data/releases.json")[2]
    notes = get(base_url, "/data/notes.json")[2]
    # The owner's notes are laid over the snapshot, so compare with them applied.
    assert body == serve.apply_notes(snapshot, notes)
    assert "default-src 'self'" in headers["Content-Security-Policy"]


def test_the_security_api_is_answered_from_the_snapshot(base_url):
    status, headers, body = get(base_url, "/api/security.json")
    assert status == 200
    assert headers["Content-Type"].startswith("application/json")
    assert body == get(base_url, "/data/security.json")[2]
    assert json.loads(body)["schema"] == 1
    assert "default-src 'self'" in headers["Content-Security-Policy"]
    head_status, _, head_body = get(base_url, "/api/security.json", method="HEAD")
    assert (head_status, head_body) == (200, b"")


def test_the_health_path_answers_ok_json(base_url):
    status, headers, body = get(base_url, "/api/health")
    assert status == 200
    assert headers["Content-Type"].startswith("application/json")
    assert body == b'{"ok":true}'


def test_other_api_paths_are_not_found(base_url):
    assert get(base_url, "/api/nothing")[0] == 404


def test_the_vendor_filter_keeps_only_that_vendor(base_url):
    status, headers, body = get(base_url, "/api/releases.json?vendor=apple")
    assert status == 200
    assert headers["Content-Type"].startswith("application/json")
    releases = json.loads(body)["releases"]
    assert releases
    assert {release["vendor"] for release in releases} == {"apple"}


def test_an_unknown_or_empty_vendor_is_a_400_that_lists_the_known_ones(base_url):
    for query in ("vendor=nope", "vendor=", "vendor=Apple"):
        status, headers, body = get(base_url, f"/api/releases.json?{query}")
        assert status == 400, query
        assert headers["Content-Type"].startswith("application/json")
        answer = json.loads(body)
        assert answer["error"] == "unknown vendor"
        assert {"apple", "mikrotik", "google"} <= set(answer["vendors"])


def test_releases_answer_passes_an_unreadable_snapshot_through():
    assert serve.releases_answer(b"not json", "vendor=apple") == (200, b"not json")
    assert serve.releases_answer(b"[]", "vendor=apple") == (200, b"[]")
    assert serve.releases_answer(b'{"releases":[]}', "") == (200, b'{"releases":[]}')


RELEASE_BODY = json.dumps(
    {
        "releases": [
            {"id": "a", "vendor": "apple"},
            {"id": "b", "vendor": "mikrotik", "summary": "x"},
        ]
    }
).encode()


def test_notes_are_laid_over_the_releases_like_the_worker_does():
    notes = json.dumps({"schema": 1, "notes": {"a": " Hello \n world ", "b": "Own", "zzz": "n"}})
    status, body = serve.releases_answer(RELEASE_BODY, "", notes.encode())
    assert status == 200
    summaries = {r["id"]: r.get("summary") for r in json.loads(body)["releases"]}
    assert summaries == {"a": "Hello world", "b": "Own"}
    status, body = serve.releases_answer(RELEASE_BODY, "vendor=apple", notes.encode())
    assert [r["id"] for r in json.loads(body)["releases"]] == ["a"]


def test_notes_that_change_nothing_leave_the_snapshot_bytes_alone():
    unchanged = (
        None,
        b"",
        b"not json",
        b"[]",
        b'{"notes":[]}',
        b'{"notes":{}}',
        b'{"notes":{"zzz":"n"}}',
        b'{"notes":{"a":"  "}}',
    )
    for notes in unchanged:
        assert serve.releases_answer(RELEASE_BODY, "", notes) == (200, RELEASE_BODY), notes


def test_clean_summary_follows_the_rules_of_the_contract():
    assert serve.clean_summary(None) == ""
    assert serve.clean_summary(" a\tb\n\nc\x00d ") == "a b cd"
    long = serve.clean_summary("word " * 80)
    assert len(long) <= serve.SUMMARY_MAX and long.endswith("\u2026")
    assert serve.clean_summary(long) == long
    assert len(serve.clean_summary("y" * 500)) == serve.SUMMARY_MAX


def test_a_cache_rule_in_headers_replaces_the_no_store_default(base_url):
    def cache_control(path: str) -> list[str]:
        opener = urllib.request.build_opener(NoRedirect)
        with opener.open(base_url + path, timeout=5) as response:  # noqa: S310 - loopback
            return response.headers.get_all("Cache-Control")

    assert cache_control("/assets/site.css") == [
        "public, max-age=1800, stale-while-revalidate=1800"
    ]
    assert cache_control("/data/releases.json") == ["public, max-age=300"]
    assert cache_control("/") == ["no-store"]
