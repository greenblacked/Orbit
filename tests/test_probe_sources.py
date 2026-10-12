"""The source probe: its list, its output sanitiser and its excerpts. No network."""

from __future__ import annotations

import io
import json
import re
import urllib.request
from urllib.parse import urlsplit

import pytest
from helpers import REPO, load_script

probe = load_script("probe_sources")
SOURCES = json.loads((REPO / "scripts" / "probe_sources.json").read_text(encoding="utf-8"))


def test_the_list_file_is_valid_and_small():
    assert probe.validate_sources(SOURCES) == []
    assert 0 < len(SOURCES) < 40


def test_a_list_over_the_cap_is_rejected():
    entries = [
        {"id": f"s{i}", "vendor": "V", "kind": "release",
         "url": f"https://a{i}.example/"}
        for i in range(probe.MAX_SOURCES + 1)
    ]  # fmt: skip
    assert probe.validate_sources(entries) == [
        f"the list must have at most {probe.MAX_SOURCES} entries"
    ]


def test_every_url_is_https_unique_and_free_of_credentials():
    pairs = [(s["url"], s.get("accept", "*/*")) for s in SOURCES]
    assert len(pairs) == len(set(pairs))
    for url, _ in pairs:
        parts = urlsplit(url)
        assert parts.scheme == "https", url
        assert parts.username is None and parts.password is None, url


def test_ids_are_unique_kebab_case():
    ids = [s["id"] for s in SOURCES]
    assert len(ids) == len(set(ids))
    assert all(re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", i) for i in ids)


def test_the_list_covers_every_vendor_and_kind():
    assert {s["kind"] for s in SOURCES} == {"release", "security", "enrichment"}
    vendors = {s["vendor"] for s in SOURCES}
    assert {"Apple", "MikroTik", "Android", "Microsoft", "Valve"} <= vendors


OK_ENTRY = {"id": "a", "vendor": "V", "kind": "release", "url": "https://a.example/"}


@pytest.mark.parametrize(
    "entry",
    [
        {"id": "Bad_Id", "vendor": "V", "kind": "release", "url": "https://a.example/"},
        {"id": "a", "vendor": "V", "kind": "other", "url": "https://a.example/"},
        {"id": "a", "vendor": "V", "kind": "release", "url": "http://a.example/"},
        {"id": "a", "vendor": "V", "kind": "release", "url": "https://u:p@a.example/"},
        {"id": "a", "vendor": "V", "kind": "release", "url": "https://a.example/?api_key=x"},
        {"id": "a", "vendor": "", "kind": "release", "url": "https://a.example/"},
        {"id": "a", "vendor": "V", "kind": "release"},
        {"id": "a", "vendor": "V", "kind": "release", "url": "https://127.0.0.1/"},
        {"id": "a", "vendor": "V", "kind": "release", "url": "https://[::1]/"},
        {"id": "a", "vendor": "V", "kind": "release", "url": "https://localhost/"},
        {"id": "a", "vendor": "V", "kind": "release", "url": "https://x.internal/"},
        dict(OK_ENTRY, x=1),
        dict(OK_ENTRY, accept="text/html"),
        dict(OK_ENTRY, accept=1),
        dict(OK_ENTRY, accept=["application/json"]),
        dict(OK_ENTRY, accept={}),
        dict(OK_ENTRY, max_bytes=0),
        dict(OK_ENTRY, max_bytes=16 * 1024 * 1024 + 1),
        dict(OK_ENTRY, max_bytes=True),
        dict(OK_ENTRY, max_bytes="9"),
        dict(OK_ENTRY, raw_tables=0),
        dict(OK_ENTRY, raw_tables=99),
        dict(OK_ENTRY, raw_tables=True),
        dict(OK_ENTRY, raw_tables="2"),
        dict(OK_ENTRY, raw_slice="<table"),
        dict(OK_ENTRY, raw_slice={}),
        dict(OK_ENTRY, raw_slice=[]),
        dict(OK_ENTRY, raw_slice={"start": "<table"}),
        dict(OK_ENTRY, raw_slice={"start": "<table", "chars": 5, "x": 1}),
        dict(OK_ENTRY, raw_slice={"start": "", "chars": 5}),
        dict(OK_ENTRY, raw_slice={"start": "a" * 81, "chars": 5}),
        dict(OK_ENTRY, raw_slice={"start": "a\nb", "chars": 5}),
        dict(OK_ENTRY, raw_slice={"start": "a\x1bb", "chars": 5}),
        dict(OK_ENTRY, raw_slice={"start": 7, "chars": 5}),
        dict(OK_ENTRY, raw_slice={"start": "a", "chars": 0}),
        dict(OK_ENTRY, raw_slice={"start": "a", "chars": True}),
        dict(OK_ENTRY, raw_slice={"start": "a", "chars": "5"}),
        dict(OK_ENTRY, raw_slice={"start": "a", "chars": 30001}),
        dict(OK_ENTRY, raw_slice=[{"start": "a", "chars": 20000}, {"start": "b", "chars": 10001}]),
        dict(OK_ENTRY, raw_slice=[{"start": "a", "chars": 1}] * 4),
    ],
)
def test_an_invalid_entry_is_rejected(entry):
    assert probe.validate_sources([entry])


def test_duplicate_ids_and_urls_are_rejected():
    one = {"id": "a", "vendor": "V", "kind": "release", "url": "https://a.example/"}
    assert probe.validate_sources([one, dict(one, url="https://b.example/")])
    assert probe.validate_sources([one, dict(one, id="b")])
    assert probe.validate_sources([])


def test_an_invalid_list_file_exits_one_and_a_valid_one_zero(tmp_path, capsys, monkeypatch):
    bad = tmp_path / "bad.json"
    bad.write_text("[]", encoding="utf-8")
    assert probe.main(["--list", str(bad)]) == 1
    missing = tmp_path / "missing.json"
    assert probe.main(["--list", str(missing)]) == 1
    monkeypatch.setattr(probe, "run", lambda sources: None)
    assert probe.main([]) == 0
    capsys.readouterr()


def test_optional_fields_are_accepted_and_the_same_url_may_differ_by_accept():
    base = {"id": "a", "vendor": "V", "kind": "release", "url": "https://a.example/"}
    assert probe.validate_sources([dict(base, raw_tables=3, accept="application/json")]) == []
    for accept in ("application/json", "application/xml", "*/*"):
        assert probe.validate_sources([dict(base, accept=accept)]) == []
    twin = dict(base, id="b", accept="application/json")
    assert probe.validate_sources([base, twin]) == []
    assert probe.validate_sources([twin, dict(twin, id="c")])


def test_max_bytes_is_accepted_up_to_the_ceiling():
    base = {"id": "a", "vendor": "V", "kind": "release", "url": "https://a.example/"}
    for size in (1, probe.MAX_BYTES_CEILING):
        assert probe.validate_sources([dict(base, max_bytes=size)]) == []


def test_the_list_sets_raw_tables_and_the_json_accept():
    by_id = {s["id"]: s for s in SOURCES}
    assert by_id["android-build-numbers"]["raw_tables"] == 3
    assert by_id["windows-release-health-11"]["raw_tables"] == 3
    assert by_id["windows-release-health-10"]["raw_tables"] == 2
    assert by_id["android-pixel-factory-images"]["raw_tables"] == 2
    assert by_id["msrc-cvrf-2026-sep-json"]["accept"] == "application/json"
    for ident in ("msrc-cvrf-2026-sep", "msrc-cvrf-2026-sep-json"):
        assert by_id[ident]["max_bytes"] > probe.MAX_BYTES
    assert by_id["msrc-cvrf-2026-sep-json"]["url"] == by_id["msrc-cvrf-2026-sep"]["url"]


def test_the_sanitiser_neutralises_workflow_commands():
    out = probe.sanitize(
        "::error::boom\n::set-output name=x::y\n::::add-mask::z\n##[error]x\n###[add-mask]y"
    )
    for line in out.split("\n"):
        assert line.startswith(probe.PREFIX)
        assert "::" not in line
        assert "##[" not in line
    assert ": :error: :boom" in out


def test_the_sanitiser_strips_control_characters_and_line_separators():
    out = probe.sanitize("a\x1b[31mb\x00c\x07d\u2028::error::e\x85::f\u200be\r::g")
    assert not re.search(r"[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029\u200b]", out)
    for line in out.split("\n"):
        assert line.startswith(probe.PREFIX)
        assert "::" not in line


def test_a_single_line_value_has_no_newline_and_no_command():
    value = probe.one_line("text/html\n::error::x")
    assert "\n" not in value and "::" not in value
    assert "##[" not in probe.one_line("##[error]f")


def test_a_redirect_to_http_is_refused():
    handler = probe.LimitedRedirects()
    request = urllib.request.Request("https://a.example/")
    with pytest.raises(probe.RedirectRefusedError):
        handler.redirect_request(request, None, 302, "Found", {}, "http://b.example/")


@pytest.mark.parametrize(
    "target", ["https://127.0.0.1/", "https://localhost/", "https://[::1]/", "https://10.0.0.1/"]
)
def test_a_redirect_to_a_local_or_ip_literal_host_is_refused(target):
    handler = probe.LimitedRedirects()
    request = urllib.request.Request("https://a.example/")
    with pytest.raises(probe.RedirectRefusedError):
        handler.redirect_request(request, None, 302, "Found", {}, target)


def test_read_body_honours_a_larger_or_smaller_limit():
    class Endless:
        def read(self, n):
            return b"x" * n

    body, note = probe.read_body(Endless(), limit=10)
    assert len(body) == 11 and note == ""
    body, _ = probe.read_body(Endless(), limit=probe.MAX_BYTES + 5)
    assert len(body) == probe.MAX_BYTES + 6


def test_a_table_fault_keeps_the_html_excerpt(monkeypatch):
    def boom(text, count):
        raise AssertionError("table bug")

    monkeypatch.setattr(probe, "raw_tables", boom)
    page = "<title>Hello</title><p>visible</p><table></table>"
    out = probe.excerpt("text/html", page, tables=1)
    assert out.startswith("html\n") and "Hello" in out and "visible" in out
    assert "raw tables (parse failed: AssertionError)" in out


def test_a_slow_body_stops_at_the_deadline():
    class Slow:
        def read(self, n):
            return b"x"

    ticks = iter([0.0, 1.0, 2.0, probe.READ_DEADLINE + 5])
    body, note = probe.read_body(Slow(), clock=lambda: next(ticks))
    assert body == b"xx" and note == "read deadline"


def test_a_redirect_to_https_is_followed_up_to_three_times():
    handler = probe.LimitedRedirects()
    request = urllib.request.Request("https://a.example/")
    for _ in range(3):
        assert handler.redirect_request(request, None, 302, "Found", {}, "/next")
    with pytest.raises(probe.RedirectRefusedError):
        handler.redirect_request(request, None, 302, "Found", {}, "/next")


def test_json_excerpt_shows_keys_and_the_first_two_items_of_the_first_list():
    text = json.dumps({"meta": {"n": 3}, "data": {"rows": [{"i": 1}, {"i": 2}, {"i": 3}]}})
    out = json.loads(probe.json_excerpt(text))
    assert out["top_level_keys"] == ["meta", "data"]
    assert out["first_list"]["path"] == "data.rows"
    assert out["first_list"]["length"] == 3
    assert out["first_list"]["first_2_items"] == [{"i": 1}, {"i": 2}]


def test_json_excerpt_handles_a_top_level_list_and_is_cut():
    assert json.loads(probe.json_excerpt("[1, 2, 3]"))["first_list"]["first_2_items"] == [1, 2]
    assert len(probe.json_excerpt(json.dumps({"k": ["x" * 9000]}))) < 4100


def test_xml_excerpt_shows_the_root_and_the_first_three_items():
    feed = "<rss><channel>" + "".join(f"<item><title>t{i}</title></item>" for i in range(5))
    out = probe.xml_excerpt(feed + "</channel></rss>")
    assert "root: rss" in out
    assert "item/entry elements: 5" in out
    assert "t0" in out and "t2" in out and "t3" not in out


def test_xml_excerpt_reads_atom_entries_and_refuses_a_dtd():
    atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>e</title></entry></feed>'
    out = probe.xml_excerpt(atom)
    assert "root: feed" in out and "entry" in out
    assert "not parsed" in probe.xml_excerpt('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>')


def test_html_excerpt_has_title_visible_text_and_matching_links():
    page = (
        "<html><head><title> Bulletin  </title><style>p{}</style></head><body>"
        "<script>var x = 1;</script><p>Hello <b>world</b></p>"
        '<a href="/docs/security/bulletin/2026">s</a><a href="/about">a</a>'
        '<a href="/changelog">c</a></body></html>'
    )
    out = probe.html_excerpt(page)
    assert "title: Bulletin" in out
    assert "Hello world" in out
    assert "var x" not in out and "p{}" not in out
    assert "/docs/security/bulletin/2026" in out and "/changelog" in out
    assert "/about" not in out


def test_html_excerpt_bounds_a_huge_title_and_href():
    page = (
        "<html><head><title>" + "t" * 9000 + "</title></head><body>"
        '<a href="/security/' + "h" * 9000 + '">x</a></body></html>'
    )
    out = probe.html_excerpt(page)
    assert max(len(line) for line in out.split("\n")) < 320


TABLES_PAGE = (
    "<html><body><p>x</p>"
    '<table class="a">\n<tr><td>one</td></tr>\n</table>'
    "<table><tr><td><table><tr><td>inner</td></tr></table></td></tr></table>"
    "<table><tr><td>third</td></tr></table></body></html>"
)


def test_raw_tables_returns_the_outer_html_of_the_first_n_tables():
    tables = probe.raw_tables(TABLES_PAGE, 2)
    assert tables[0] == '<table class="a">\n<tr><td>one</td></tr>\n</table>'
    assert tables[1] == "<table><tr><td><table><tr><td>inner</td></tr></table></td></tr></table>"
    assert len(probe.raw_tables(TABLES_PAGE, 1)) == 1
    assert len(probe.raw_tables(TABLES_PAGE, 10)) == 3
    assert "third" in probe.raw_tables(TABLES_PAGE, 3)[2]


def test_raw_tables_handles_an_unclosed_table_and_a_page_without_tables():
    assert probe.raw_tables("<p>a</p><table><tr><td>cut", 2) == ["<table><tr><td>cut"]
    assert probe.raw_tables("<p>none</p>", 2) == []


def test_a_raw_table_is_cut_at_6000_characters():
    page = "<table><tr><td>" + "x" * 9000 + "</td></tr></table>"
    (table,) = probe.raw_tables(page, 1)
    assert table.startswith("<table><tr><td>xxx")
    assert table.endswith("\n[cut at 6000 chars]")
    assert len(table) < 6100


def test_html_excerpt_gets_raw_tables_only_when_asked():
    plain = probe.excerpt("text/html", TABLES_PAGE)
    assert "raw tables" not in plain and "<table" not in plain
    with_tables = probe.excerpt("text/html", TABLES_PAGE, 2)
    assert plain in with_tables
    assert "--- table 1 ---" in with_tables and "--- table 2 ---" in with_tables
    assert "--- table 3 ---" not in with_tables
    assert '<table class="a">' in with_tables
    assert "<table" not in probe.excerpt("application/json", '{"a": 1}', 2)


def test_commands_inside_a_raw_table_are_neutralised_in_the_report():
    page = (
        "<html><body><table><tr><td>::error::boom</td>\n"
        "<td>##[add-mask]x\x1b[31m</td></tr></table></body></html>"
    )
    result = {
        "status": 200,
        "final_url": "https://a.example/x",
        "content_type": "text/html",
        "charset": "utf-8",
        "body": page.encode(),
        "truncated": False,
    }
    source = dict(SOURCES[0], raw_tables=1)
    out = probe.report(source, result, None)
    tail = out.split("excerpt:", 1)[1]
    assert "<table>" in tail and "boom" in tail
    for line in tail.split("\n")[1:]:
        assert line.startswith(probe.PREFIX)
        assert "::" not in line and "##[" not in line and "\x1b" not in line


def test_the_accept_header_is_sent_and_defaults_to_anything(monkeypatch):
    seen = []

    class Opener:
        def open(self, request, timeout):
            seen.append(request.get_header("Accept"))
            raise OSError("stop")

    monkeypatch.setattr(urllib.request, "build_opener", lambda *handlers: Opener())
    for args in (("https://a.example/",), ("https://a.example/", "application/json")):
        with pytest.raises(OSError):
            probe.fetch(*args)
    assert seen == ["*/*", "application/json"]


def test_a_parser_fault_falls_back_to_text(monkeypatch):
    def boom(text):
        raise AssertionError("parser bug")

    monkeypatch.setattr(probe, "html_excerpt", boom)
    out = probe.excerpt("text/html", "<html>hi</html>")
    assert "parse failed: AssertionError" in out


def test_excerpt_picks_the_parser_and_falls_back_to_text():
    assert probe.excerpt("application/json", '{"a": 1}').startswith("json")
    assert probe.excerpt("application/rss+xml", "<rss/>").startswith("xml")
    assert probe.excerpt("text/html; charset=utf-8", "<html></html>").startswith("html")
    assert probe.excerpt("text/plain", "7.24.4 1760000000").startswith("text")
    broken = probe.excerpt("application/json", '{"a": [1,')
    assert "parse failed" in broken and '{"a"' in broken


def test_a_failed_source_is_reported_with_its_error_class_only():
    source = SOURCES[0]
    out = probe.report(source, None, TimeoutError("secret detail"))
    assert "error: TimeoutError" in out
    assert "secret detail" not in out


def test_a_report_carries_status_type_size_digest_and_a_sanitised_excerpt():
    result = {
        "status": 200,
        "final_url": "https://a.example/x",
        "content_type": "application/json",
        "charset": "utf-8",
        "body": b'{"msg": "::error::x"}',
        "truncated": False,
    }
    out = probe.report(SOURCES[0], result, None)
    assert "status: 200" in out and "content-type: application/json" in out
    assert "bytes: 21" in out and "sha256: " in out
    assert "::" not in out.replace("\n", " ").split("excerpt:", 1)[1]


def test_requests_to_one_host_are_paced(monkeypatch):
    sleeps: list[float] = []
    now = [0.0]
    sources = [
        {"id": "a", "vendor": "V", "kind": "release", "url": "https://h.example/1"},
        {"id": "b", "vendor": "V", "kind": "release", "url": "https://h.example/2"},
        {"id": "c", "vendor": "V", "kind": "release", "url": "https://o.example/3"},
    ]

    def fake_fetch(url, accept="*/*", limit=0):
        raise OSError(url)

    monkeypatch.setattr(probe, "fetch", fake_fetch)
    probe.run(sources, sleep=sleeps.append, clock=lambda: now[0], out=io.StringIO())
    assert len(sleeps) == 1 and sleeps[0] == pytest.approx(1.0)


def test_the_workflow_is_read_only_and_pinned_like_ci():
    text = (REPO / ".github" / "workflows" / "source-probe.yml").read_text(encoding="utf-8")
    ci = (REPO / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert re.search(r"^permissions: \{\}$", text, flags=re.MULTILINE)
    assert "contents: read" in text and "timeout-minutes: 15" in text
    assert "cancel-in-progress: true" in text
    assert "github.event.pull_request.head.repo.full_name == github.repository" in text
    assert "secrets." not in text and "upload-artifact" not in text
    assert "run: python -I scripts/probe_sources.py" in text
    for action in re.findall(r"uses: (actions/[a-z-]+@[0-9a-f]{40}  # v[0-9.]+)", text):
        assert action in ci, action
    assert len(re.findall(r"^\s*- uses:", text, flags=re.MULTILINE)) == 2
    assert text.count("persist-credentials: false") == 1
    for path in ("scripts/probe_sources.py", "scripts/probe_sources.json"):
        assert f"- {path}" in text
    assert "- .github/workflows/source-probe.yml" in text


def test_the_security_snapshot_workflow_is_manual_read_only_and_pinned_like_ci():
    text = (REPO / ".github" / "workflows" / "security-snapshot.yml").read_text(encoding="utf-8")
    ci = (REPO / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    head = text.split("\njobs:\n", 1)[0]
    assert re.search(r"^on:\n  workflow_dispatch:\n\npermissions:", head, flags=re.MULTILINE)
    assert re.search(r"^permissions: \{\}$", text, flags=re.MULTILINE)
    assert "contents: read" in text and "timeout-minutes:" in text
    assert "secrets." not in text and "upload-artifact" not in text
    assert "github.token" not in text and "GH_TOKEN" not in text
    assert "node deploy/snapshot_security.mjs" in text
    assert text.count("persist-credentials: false") == 1
    for action in re.findall(r"uses: (actions/[a-z-]+@[0-9a-f]{40}  # v[0-9.]+)", text):
        assert action in ci, action
    assert len(re.findall(r"^\s*- uses:", text, flags=re.MULTILINE)) == 2


NEWS = json.dumps(
    {
        "appnews": {
            "newsitems": [
                {"title": "Steam Client Update", "date": 1, "tags": ["patchnotes"]},
                {"title": "SteamOS 3.7 released", "date": 2, "tags": ["steamos"]},
                {"title": "Beta for STEAMOS", "date": 3},
                {"note": "no title"},
                "text",
            ]
        }
    }
)


@pytest.mark.parametrize("value", ["SteamOS", "a", "Steam OS 3", "x" * 40])
def test_match_titles_accepts_short_plain_text(value):
    entry = {"id": "a", "vendor": "V", "kind": "release", "url": "https://a.example/"}
    assert probe.validate_sources([{**entry, "match_titles": value}]) == []


@pytest.mark.parametrize("value", ["", "x" * 41, "a-b", "a.b", "é", 5, None, ["a"]])
def test_match_titles_rejects_other_values(value):
    entry = {"id": "a", "vendor": "V", "kind": "release", "url": "https://a.example/"}
    problems = probe.validate_sources([{**entry, "match_titles": value}])
    assert len(problems) == 1 and "match_titles" in problems[0]


def test_match_titles_filters_case_insensitively_with_title_date_and_tags():
    out = probe.json_excerpt(NEWS, "steamos")
    block = json.loads(out[out.index('{\n  "title_matches"') :])["title_matches"]
    assert block["count"] == 2
    assert block["items"][0] == {"title": "SteamOS 3.7 released", "date": 2, "tags": ["steamos"]}
    assert block["items"][1]["title"] == "Beta for STEAMOS"
    assert "title_matches" not in probe.json_excerpt(NEWS)


def test_match_titles_is_capped_and_ignores_lists_without_titles():
    many = json.dumps([{"title": f"SteamOS {i}"} for i in range(50)])
    assert f'"count": {probe.MAX_TITLE_MATCHES}' in probe.json_excerpt(many, "steamos")
    assert "title_matches" not in probe.json_excerpt("[1, 2, 3]", "steamos")
    assert "title_matches" not in probe.json_excerpt('{"a": [{"name": "SteamOS"}]}', "steamos")


def test_match_titles_reaches_the_report_and_is_sanitised():
    news = json.dumps([{"title": "SteamOS ##[error] x", "date": 1}])
    source = {"id": "a", "vendor": "V", "kind": "release", "url": "https://a.example/",
              "match_titles": "SteamOS"}  # fmt: skip
    result = {"final_url": "https://a.example/", "status": 200, "truncated": False,
              "content_type": "application/json", "charset": "utf-8",
              "body": news.encode()}  # fmt: skip
    text = probe.report(source, result, None)
    assert "title_matches" in text and "# #[error]" in text and "##[" not in text


SLICE_PAGE = (
    "<html><body><p>top</p><table><tr><td>row one</td></tr></table><b>tail</b></body></html>"
)


def test_raw_slice_is_accepted_as_one_object_or_up_to_three():
    base = {"id": "a", "vendor": "V", "kind": "security", "url": "https://a.example/"}
    one = {"start": "<table", "chars": probe.MAX_RAW_SLICE_CHARS}
    assert probe.validate_sources([dict(base, raw_slice=one)]) == []
    three = [{"start": "a", "chars": 10000}] * 3
    assert probe.validate_sources([dict(base, raw_slice=three)]) == []


def test_raw_slice_errors_are_plain():
    assert probe.slice_problems({"start": "a", "chars": 30001}) == [
        "raw_slice chars must be at most 30000"
    ]
    assert probe.slice_problems([]) == ["raw_slice must have 1 to 3 slices"]
    assert probe.slice_problems("x") == ['raw_slice must be {"start": <text>, "chars": <integer>}']


def test_raw_slices_print_raw_characters_from_the_marker():
    out = probe.raw_slices(SLICE_PAGE, {"start": "<table", "chars": 31})
    assert out[0].startswith("--- slice 1: '<table' ---") and "31 chars" in out[0]
    assert out[1] == "<table><tr><td>row one</td></tr>"[:31]
    short = probe.raw_slices(SLICE_PAGE, {"start": "<b>", "chars": 5000})
    assert short[1] == "<b>tail</b></body></html>"
    specs = [{"start": "<p>", "chars": 8}, {"start": "<b>", "chars": 3}]
    two = probe.raw_slices(SLICE_PAGE, specs)
    assert two[1] == "<p>top</p>"[:8] and two[3] == "<b>"


def test_a_missing_marker_is_reported_not_raised():
    out = probe.raw_slices(SLICE_PAGE, {"start": 'id="sections"', "chars": 100})
    assert out[1] == "marker not found"
    page = probe.excerpt("text/html", SLICE_PAGE, slices={"start": "nope", "chars": 9})
    assert page.startswith("html\n") and "raw slices:" in page and "marker not found" in page


def test_html_excerpt_gets_raw_slices_only_when_asked():
    plain = probe.excerpt("text/html", SLICE_PAGE)
    assert "raw slices" not in plain
    with_slice = probe.excerpt("text/html", SLICE_PAGE, slices={"start": "<table", "chars": 20})
    assert plain in with_slice and "<table><tr><td>row" in with_slice
    assert "raw slices" not in probe.excerpt("application/json", '{"a": 1}', slices=[1])


def test_a_slice_fault_keeps_the_html_excerpt(monkeypatch):
    def boom(text, specs):
        raise AssertionError("slice bug")

    monkeypatch.setattr(probe, "raw_slices", boom)
    out = probe.excerpt("text/html", SLICE_PAGE, slices={"start": "<p>", "chars": 5})
    assert "top" in out and "raw slices (failed: AssertionError)" in out


def test_commands_inside_a_raw_slice_are_neutralised_in_the_report():
    page = '<html><body><div id="s">::error::boom\n##[add-mask]x\x1b[31m</div></body></html>'
    result = {
        "status": 200,
        "final_url": "https://a.example/x",
        "content_type": "text/html",
        "charset": "utf-8",
        "body": page.encode(),
        "truncated": False,
    }
    source = dict(SOURCES[0], raw_slice={"start": "<div", "chars": 200})
    out = probe.report(source, result, None)
    tail = out.split("raw slices:", 1)[1]
    assert "<div" in tail and "boom" in tail
    for line in tail.split("\n")[1:]:
        assert line.startswith(probe.PREFIX)
        assert "::" not in line and "##[" not in line and "\x1b" not in line


def _slices(source):
    raw = source["raw_slice"]
    return raw if isinstance(raw, list) else [raw]


def test_the_list_asks_for_raw_security_markup():
    by_id = {s["id"]: s for s in SOURCES}
    for ident in ("android-security-bulletin-2026-10", "android-pixel-bulletin-2026-10"):
        assert 1 <= by_id[ident]["raw_tables"] <= probe.MAX_RAW_TABLES
        assert "<h1" in [s["start"] for s in _slices(by_id[ident])]
    for ident in (
        "apple-security-releases-index",
        "apple-security-note-ios-26-7-1",
        "android-security-bulletin-index",
        "android-security-bulletin-2026-10",
        "android-pixel-bulletin-2026-10",
    ):
        slices = _slices(by_id[ident])
        assert 1 <= len(slices) <= probe.MAX_RAW_SLICES
        assert all(s["chars"] > 0 for s in slices)
        assert sum(s["chars"] for s in slices) <= probe.MAX_RAW_SLICE_CHARS
    for ident in ("apple-security-releases-index", "android-security-bulletin-index"):
        assert [s["start"] for s in _slices(by_id[ident])] == ["<table"]
    starts = [s["start"] for s in _slices(by_id["apple-security-note-ios-26-7-1"])]
    assert "<h1" in starts and "Published Date" in starts
