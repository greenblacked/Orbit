"""serve_site behaves like the Worker: 404 page, trailing slash, headers, hidden files."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

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
    assert body == get(base_url, "/data/releases.json")[2]
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


ATOM = "{http://www.w3.org/2005/Atom}"
HOSTS = {"apple": ["developer.apple.com"]}
FEED_CONFIG = json.dumps(
    {
        "families": [{"id": "iOS"}, {"id": "macOS"}],
        "vendors": [{"id": "apple", "source": {"hosts": HOSTS["apple"]}}],
    }
).encode()


def parse_xml(body: bytes) -> ET.Element:
    return ET.fromstring(body)  # noqa: S314 - our own output, in a test


def snapshot_of(*releases: dict) -> bytes:
    return json.dumps({"releases": list(releases)}).encode()


def release(rid: str, date: str, **over) -> dict:
    return {
        "id": rid,
        "vendor": "apple",
        "family": "iOS",
        "version": "27.2",
        "stage": "beta",
        "beta": 2,
        "build": "24B1",
        "title": f"iOS {rid}",
        "date": date,
        "url": f"https://developer.apple.com/news/releases/?id={rid}",
        **over,
    }


def test_the_atom_feed_is_answered_from_the_snapshot(base_url):
    status, headers, body = get(base_url, "/api/feed.atom")
    assert status == 200
    assert headers["Content-Type"] == "application/atom+xml; charset=utf-8"
    assert "default-src 'self'" in headers["Content-Security-Policy"]
    assert headers["X-Content-Type-Options"] == "nosniff"
    feed = parse_xml(body)  # well formed
    assert feed.tag == ATOM + "feed"
    assert feed.findtext(ATOM + "id") == "https://orbit.szolotov.com/api/feed.atom"
    entries = feed.findall(ATOM + "entry")
    snapshot = json.loads(get(base_url, "/data/releases.json")[2])["releases"]
    assert len(entries) == min(len(snapshot), serve.MAX_ENTRIES)
    for entry in entries:
        assert entry.findtext(ATOM + "id").startswith("tag:orbit.szolotov.com,2026:release:")
        assert entry.find(ATOM + "link").get("href").startswith("https://")
    assert get(base_url, "/api/feed.atom", method="HEAD")[2] == b""


def test_the_json_feed_is_answered_from_the_snapshot(base_url):
    status, headers, body = get(base_url, "/api/feed.json")
    assert status == 200
    assert headers["Content-Type"] == "application/feed+json; charset=utf-8"
    feed = json.loads(body)
    assert feed["version"] == "https://jsonfeed.org/version/1.1"
    assert feed["items"]
    assert all(item["id"].startswith("tag:orbit.szolotov.com,2026:") for item in feed["items"])


def test_the_feeds_filter_and_refuse_unknown_values_like_the_worker(base_url):
    status, _, body = get(base_url, "/api/feed.json?family=iOS&stage=beta")
    assert status == 200
    items = json.loads(body)["items"]
    assert items
    assert all(item["tags"] == ["iOS", "beta"] for item in items)
    bad = (("vendor=nope", "vendors"), ("family=", "families"), ("stage=x", "stages"))
    for path in ("/api/feed.atom", "/api/feed.json"):
        for query, plural in bad:
            status, headers, body = get(base_url, f"{path}?{query}")
            assert status == 400, (path, query)
            assert headers["Content-Type"].startswith("application/json")
            answer = json.loads(body)
            assert answer["error"] == f"unknown {query.split('=')[0]}"
            assert answer[plural]


def test_the_feed_orders_caps_links_and_escapes():
    hostile = release(
        'x&<"1',
        "2026-10-06T00:00:00Z",
        title='<script>"a" & b</script>\x00',
        url="https://evil.example/p",
    )
    later = release("late", "2026-10-07T00:00:00Z", url="https://developer.apple.com/p?a=1&b=2")
    bad_date = release("bad", "nope")
    snapshot = snapshot_of(hostile, later, bad_date)
    status, body, kind = serve.feed_answer("atom", snapshot, FEED_CONFIG, "")
    assert (status, kind) == (200, serve.ATOM_TYPE)
    text = body.decode()
    assert "<script>" not in text and "\x00" not in text
    feed = parse_xml(body)
    entries = feed.findall(ATOM + "entry")
    assert [e.findtext(ATOM + "title") for e in entries] == [
        "iOS late",
        '<script>"a" & b</script>',
    ]
    assert entries[0].find(ATOM + "link").get("href") == "https://developer.apple.com/p?a=1&b=2"
    assert entries[1].find(ATOM + "link").get("href") == (
        "https://orbit.szolotov.com/timeline/?id=x%26%3C%221"
    )
    assert feed.findtext(ATOM + "updated") == "2026-10-07T00:00:00.000Z"
    days = (release(f"r{n}", f"2026-01-{n % 28 + 1:02d}T00:00:00Z") for n in range(130))
    many = snapshot_of(*days)
    capped = parse_xml(serve.feed_answer("atom", many, FEED_CONFIG, "")[1])
    assert len(capped.findall(ATOM + "entry")) == serve.MAX_ENTRIES


def test_the_feed_names_its_filters_in_fixed_order():
    snapshot = snapshot_of(release("a", "2026-10-06T00:00:00Z"))
    feed = parse_xml(
        serve.feed_answer("atom", snapshot, FEED_CONFIG, "stage=beta&family=iOS&vendor=apple")[1]
    )
    assert feed.findtext(ATOM + "id") == (
        "https://orbit.szolotov.com/api/feed.atom?vendor=apple&family=iOS&stage=beta"
    )
    assert feed.findtext(ATOM + "title") == "Release Orbit releases (apple, iOS, beta)"


def test_an_unreadable_snapshot_is_a_503_for_the_feeds():
    assert serve.feed_answer("atom", b"not json", None, "")[0] == 503
    assert serve.feed_answer("json", b"[]", None, "")[0] == 503


def test_xml_escape_matches_the_worker():
    assert serve.xml_escape('<a b="c">&\'\x01') == "&lt;a b=&quot;c&quot;&gt;&amp;&apos;"
    assert serve.xml_escape(None) == ""
