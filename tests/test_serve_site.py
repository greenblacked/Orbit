"""serve_site behaves like the Worker: 404 page, trailing slash, headers, hidden files."""

from __future__ import annotations

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
