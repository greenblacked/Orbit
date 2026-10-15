"""check_site and bundle_preview must agree about every page, because they share site_refs.

Each case is a tiny built site. The size check (links, CSS, policy) and the preview bundle
must both accept it or both refuse it, and for what they accept, the files the size check
weighs are exactly the files the bundle inlines (icons are inlined but are never weight).
The corpus is the set of constructs on which the two once disagreed, plus ordinary pages.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser

import pytest
from helpers import REPO, load_script

check = load_script("check_site")
bundle = load_script("bundle_preview")
refs = load_script("site_refs")

PNG = b"\x89PNG\r\n\x1a\n" + b"p" * 40
PAGE = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title>{head}</head>'
    "<body>{body}</body></html>"
)
FILES = {
    "img/p.png": PNG,
    "img/q.png": PNG + b"q",
    "assets/a.js": b"var a = 1;",
    "a/index.html": b"<!doctype html><html><head></head><body>a</body></html>",
    "extra.txt": b"a{color:red}",
    "sprite.svg": b"<svg xmlns='http://www.w3.org/2000/svg'/>",
}
SHEET = '<link rel="stylesheet" href="/assets/s.css">'


def css(text: str) -> dict[str, object]:
    return {"assets/s.css": text}


# (id, head, body, extra files, expected verdict)
OK, REFUSED = "ok", "refused"
CASES = [
    ("plain stylesheet with url()", SHEET, "", css("a{background:url(../img/p.png)}"), OK),
    ("nothing but text", "", "<p>hi</p>", {}, OK),
    (
        "url data and fragment and empty",
        SHEET,
        "",
        css("a{background:url(data:image/png;base64,AAAA)}b{fill:url(#c)}c{background:url()}"),
        OK,
    ),
    (
        "comment hides a missing url",
        SHEET,
        "",
        css("/* url(missing.png) @import 'x.css'; */ a{color:red}"),
        OK,
    ),
    (
        "comment markers inside a string are not comments",
        SHEET,
        "",
        css('a::after{content:"/* @import */"}b{background:url(../img/p.png)}'),
        OK,
    ),
    ("an @import word inside a string", SHEET, "", css('a::after{content:"@import url(x)"}'), OK),
    (
        "rel with two tokens",
        '<link rel="preload stylesheet" href="/assets/s.css">',
        "",
        css("a{background:url(../img/p.png)}"),
        OK,
    ),
    (
        "rel in capitals with a trailing space",
        '<link rel="Stylesheet " href="/assets/s.css">',
        "",
        css("a{background:url(../img/p.png)}"),
        OK,
    ),
    (
        "single-quoted rel and href",
        "<link rel='stylesheet' href='/assets/s.css'>",
        "",
        css("a{background:url(../img/p.png)}"),
        OK,
    ),
    (
        "unquoted rel and href",
        "<link rel=stylesheet href=/assets/s.css>",
        "",
        css("a{background:url(../img/p.png)}"),
        OK,
    ),
    (
        "stylesheet suffix in capitals",
        '<link rel="stylesheet" href="/assets/S.CSS">',
        "",
        {"assets/S.CSS": "a{background:url(../img/p.png)}"},
        OK,
    ),
    (
        "preload without stylesheet is not a sheet",
        '<link rel="preload" href="/assets/s.css" as="style">',
        "",
        css("a{background:url(missing.png)}"),
        OK,
    ),
    ("head style block", "<style>a{background:url(/img/p.png)}</style>", "", {}, OK),
    ("body style block", "", "<style>a{background:url(/img/p.png)}</style><p>x</p>", {}, OK),
    ("style attribute", "", '<p style="background:url(/img/p.png)">x</p>', {}, OK),
    ("escaped url function", SHEET, "", css("a{background:\\75rl(../img/p.png)}"), OK),
    (
        "escaped characters in a url string",
        SHEET,
        "",
        css('a{background:url("..\\2f img/p.png")}'),
        OK,
    ),
    (
        "image-set with url and strings",
        SHEET,
        "",
        css('a{background:image-set(url(../img/p.png) 1x, "../img/q.png" 2x)}'),
        OK,
    ),
    (
        "webkit image-set string",
        SHEET,
        "",
        css('a{background:-webkit-image-set("../img/p.png" 1x)}'),
        OK,
    ),
    (
        "image-set type() string is not a url",
        SHEET,
        "",
        css('a{background:image-set("../img/p.png" 1x type("image/png"))}'),
        OK,
    ),
    (
        "format() string is not a url",
        SHEET,
        "",
        css('@font-face{font-family:x;src:local("nope"),url(../img/p.png) format("woff2")}'),
        OK,
    ),
    ("srcset with descriptors", "", '<img alt="" srcset="/img/p.png 1x, /img/q.png 2x">', {}, OK),
    ("unquoted img src", "", "<img alt='' src=/img/p.png>", {}, OK),
    ("a tag inside an HTML comment", "", '<!-- <img src="/gone.png"> --><p>x</p>', {}, OK),
    ("script in capitals", '<SCRIPT SRC="/assets/a.js"></SCRIPT>', "", {}, OK),
    ("script in the body", "", '<script src="/assets/a.js"></script>', {}, OK),
    ("icon is inlined and not weighed", '<link rel="shortcut icon" href="/img/q.png">', "", {}, OK),
    (
        "remote stylesheet in the head is dropped",
        '<link rel="stylesheet" href="https://f.example/x.css">',
        "",
        {},
        OK,
    ),
    ("link to a directory", "", '<a href="/a/">a</a>', {}, OK),
    (
        "url with a query and fragment",
        SHEET,
        "",
        css("a{background:url('../img/p.png?v=1#x')}"),
        OK,
    ),
    # refused
    ("import", SHEET, "", css('@import "x.css";'), REFUSED),
    ("import in capitals with url()", SHEET, "", css('@IMPORT url("x.css");'), REFUSED),
    ("escaped import", SHEET, "", css("@\\69mport 'x.css';"), REFUSED),
    ("escaped import in capitals", SHEET, "", css("@\\49MPORT 'x.css';"), REFUSED),
    ("import in a head style block", "<style>@import 'x.css';</style>", "", {}, REFUSED),
    ("import in a body style block", "", "<style>@import 'x.css';</style>", {}, REFUSED),
    ("import in a style attribute", "", '<p style="@import url(x.css)">x</p>', {}, REFUSED),
    (
        "import in a preload stylesheet",
        '<link rel="preload stylesheet" href="/assets/s.css">',
        "",
        css("@import 'x.css';"),
        REFUSED,
    ),
    (
        "import in a capitalised stylesheet suffix",
        '<link rel="stylesheet" href="/assets/S.CSS">',
        "",
        {"assets/S.CSS": "@import 'x.css';"},
        REFUSED,
    ),
    ("missing url", SHEET, "", css("a{background:url(missing.png)}"), REFUSED),
    (
        "missing quoted url with spaces",
        SHEET,
        "",
        css("a{background:url( 'missing.png' )}"),
        REFUSED,
    ),
    ("missing escaped url function", SHEET, "", css("a{background:\\75rl(missing.png)}"), REFUSED),
    (
        "missing escaped name in capitals",
        SHEET,
        "",
        css("a{background:U\\52L(missing.png)}"),
        REFUSED,
    ),
    (
        "missing image-set string",
        SHEET,
        "",
        css('a{background:image-set("missing.png" 1x)}'),
        REFUSED,
    ),
    (
        "missing webkit image-set string",
        SHEET,
        "",
        css("a{background:-webkit-image-set('missing.png' 1x)}"),
        REFUSED,
    ),
    (
        "missing url after a comment",
        SHEET,
        "",
        css("/* x */a{background:url(missing.png)}"),
        REFUSED,
    ),
    ("directory url", SHEET, "", css("a{background:url(/a/)}"), REFUSED),
    ("directory url without a slash", SHEET, "", css("a{background:url(/a)}"), REFUSED),
    ("url that climbs out", SHEET, "", css("a{background:url(../../x.png)}"), REFUSED),
    ("separator in a url", SHEET, "", css("a{background:url(..%2fimg%2fp.png)}"), REFUSED),
    (
        "missing url in a head style",
        "<style>a{background:url(missing.png)}</style>",
        "",
        {},
        REFUSED,
    ),
    (
        "missing url in a body style",
        "",
        "<style>a{background:url(missing.png)}</style>",
        {},
        REFUSED,
    ),
    (
        "missing url in a style attribute",
        "",
        '<p style="background:url(missing.png)">x</p>',
        {},
        REFUSED,
    ),
    (
        "missing single-quoted stylesheet",
        "<link rel='stylesheet' href='/nope.css'>",
        "",
        {},
        REFUSED,
    ),
    ("stylesheet that is not css", '<link rel="stylesheet" href="/extra.txt">', "", {}, REFUSED),
    ("stylesheet that is a directory", '<link rel="stylesheet" href="/a/">', "", {}, REFUSED),
    (
        "stylesheet in the body",
        "",
        '<link rel="stylesheet" href="/assets/s.css"><p>x</p>',
        css("a{}"),
        REFUSED,
    ),
    ("missing image", "", '<img alt="" src="/gone.png">', {}, REFUSED),
    ("missing unquoted image", "", "<img alt='' src=/gone.png>", {}, REFUSED),
    (
        "missing srcset candidate",
        "",
        '<img alt="" srcset="/img/p.png 1x, /gone.png 2x">',
        {},
        REFUSED,
    ),
    ("image that is a directory", "", '<img alt="" src="/a/">', {}, REFUSED),
    ("image that climbs out", "", '<img alt="" src="../x.png">', {}, REFUSED),
    ("missing script", '<script src="/gone.js"></script>', "", {}, REFUSED),
    ("inline script in the head", "<script>var a = 1;</script>", "", {}, REFUSED),
    ("inline script in the body", "", "<script>var a = 1;</script>", {}, REFUSED),
    ("style on the body element", "", "", {}, REFUSED),
    ("event handler", "", '<button onclick="x()">x</button>', {}, REFUSED),
    ("javascript url", "", '<a href="javascript:void(0)">x</a>', {}, REFUSED),
    ("use of an external sprite", "", '<svg><use href="/sprite.svg#a"></use></svg>', {}, REFUSED),
    (
        "external presentation url",
        "",
        '<svg><rect clip-path="url(/sprite.svg#a)"/></svg>',
        {},
        REFUSED,
    ),
    ("a frame onto a page", "", '<iframe src="/a/index.html"></iframe>', {}, REFUSED),
    ("a refresh", '<meta http-equiv="refresh" content="0;url=/">', "", {}, REFUSED),
]
# ``<body style=…>`` is the one case that needs its own page skeleton.
BODY_ATTR = "style on the body element"


def build(tmp_path, head: str, body: str, extra: dict[str, object], name: str):
    root = tmp_path / "site"
    for path, data in {**FILES, **extra}.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))
    page = PAGE.format(head=head, body=body)
    if name == BODY_ATTR:
        page = page.replace("<body>", '<body style="background:url(/img/p.png)">')
    (root / "index.html").write_text(page, encoding="utf-8")
    (root / "version.txt").write_text("v0\n")
    return root


def verdicts(root, monkeypatch):
    """(check_site problems, bundle failure or None, files the bundle inlined)."""
    problems = (
        check.check_links(root)
        + check.check_css(root)
        + check.check_policy(root)
        + check.check_budget(root, 10**9, 10**9)
    )
    inlined: set = set()
    real = bundle.resolve

    def recording(root_, base, ref):
        result = real(root_, base, ref)
        inlined.add(result[1])
        return result

    monkeypatch.setattr(bundle, "resolve", recording)
    failure = None
    try:
        bundle.bundle(root, "v0", "abc1234", "now")
    except SystemExit as error:
        failure = str(error)
    return problems, failure, inlined


@pytest.mark.parametrize(
    ("head", "body", "extra", "expected"),
    [case[1:] for case in CASES],
    ids=[case[0] for case in CASES],
)
def test_both_tools_accept_or_both_refuse(
    tmp_path, monkeypatch, request, head, body, extra, expected
):
    name = request.node.callspec.id
    root = build(tmp_path, head, body, extra, name)
    problems, failure, inlined = verdicts(root, monkeypatch)
    if expected == OK:
        assert problems == [], problems
        assert failure is None, failure
    else:
        assert problems, "check_site accepted what it must refuse"
        assert failure is not None, "the bundle accepted what check_site refuses"


@pytest.mark.parametrize(
    ("head", "body", "extra"),
    [case[1:4] for case in CASES if case[4] == OK],
    ids=[case[0] for case in CASES if case[4] == OK],
)
def test_the_weight_is_the_set_of_files_the_bundle_inlines(
    tmp_path, monkeypatch, request, head, body, extra
):
    root = build(tmp_path, head, body, extra, request.node.callspec.id)
    problems, failure, inlined = verdicts(root, monkeypatch)
    assert problems == [] and failure is None
    infos = check.inspect_all(root)
    weighed = {path for info in infos.values() for path in info.weighed}
    icons = {target for info in infos.values() for ref, target in info.targets if ref.icon}
    # A preload is weighed (the served page fetches it) but the one-file bundle drops the
    # hint, since the file is inlined where it is used, if it is used at all.
    hints = {
        target
        for info in infos.values()
        for ref, target in info.targets
        if ref.tag == "link" and not (ref.stylesheet or ref.icon)
    }
    assert inlined - icons == weighed - (hints - inlined)
    for info in infos.values():
        assert check.page_weight(root, info) == (root / info.name).stat().st_size + sum(
            path.stat().st_size for path in info.weighed
        )


def test_the_real_site_is_accepted_by_both_and_weighs_what_is_inlined(tmp_path, monkeypatch):
    out = tmp_path / "site"
    load_script("build_site").build(REPO / "src", out, "v0")
    problems, failure, inlined = verdicts(out, monkeypatch)
    assert problems == [] and failure is None
    infos = check.inspect_all(out)
    weighed = {path for info in infos.values() for path in info.weighed}
    icons = {target for info in infos.values() for ref, target in info.targets if ref.icon}
    # The bundle also runs below.js, lookup.js and the generic sigil rule, which load after the
    # first paint and are not weighed.
    late = {
        out / "assets" / "below.js",
        out / "assets" / "lookup.js",
        out / "assets" / "sigil-generic.js",
    }
    assert inlined - icons - late == weighed


def test_a_remote_subresource_is_the_one_difference_on_purpose(tmp_path, monkeypatch):
    # The real site's response headers govern a remote image; the preview must hold
    # everything, so only the bundle refuses it.
    root = build(tmp_path, "", '<img alt="" src="https://example.org/a.png">', {}, "remote")
    problems, failure, _ = verdicts(root, monkeypatch)
    assert problems == [] and failure is not None


def test_a_dead_link_between_pages_is_for_the_size_check_alone(tmp_path, monkeypatch):
    root = build(tmp_path, "", '<a href="/gone/">x</a>', {}, "dead")
    problems, failure, _ = verdicts(root, monkeypatch)
    assert problems and failure is None


def test_neither_tool_discovers_references_itself():
    scripts = REPO / "scripts"
    for name in ("check_site.py", "bundle_preview.py", "site_refs.py"):
        source = (scripts / name).read_text(encoding="utf-8")
        # One tokenizer: no second attribute parser, whatever it is called.
        assert not re.search(r"\b_ATTR\b", source) and "tag_attributes" not in source
        assert "([^\\s\"'<>/=]+)" not in source
        if name == "site_refs.py":
            continue
        assert "site_refs" in source
        assert "HTMLParser" not in source
        assert "CSS_URL" not in source and "import css_refs" not in source
    assert not hasattr(refs, "tag_attributes")


@pytest.mark.parametrize(
    ("css_text", "expected"),
    [
        (
            "a{b:URL( 'x.png' )}c{d:url(\"y.png\")}e{f:url(z.png)}/* url(no.png) */",
            ["x.png", "y.png", "z.png"],
        ),
        ("a{b:\\75rl(x.png)}", ["x.png"]),
        ('a{b:image-set("x.png" 1x, url(y.png) 2x)}', ["x.png", "y.png"]),
        ('a{b:url("x\\2e png")}', ["x.png"]),
        ('a{content:"/* url(no.png) */"}b{c:url(z.png)}', ["z.png"]),
    ],
)
def test_the_css_scanner_reads_what_a_browser_reads(css_text, expected):
    assert refs.css_urls(css_text) == expected


def test_the_html_scanner_splits_rel_tokens_and_tracks_the_head():
    doc = refs.parse_html(
        "<html><head><link REL=' Preload  STYLESHEET ' href='a.css'></head>"
        "<body><link rel=stylesheet href=b.css></body></html>"
    )
    first, second = doc.refs
    assert first.rel == ("preload", "stylesheet") and first.stylesheet and first.in_head
    assert second.stylesheet and second.in_body and not second.in_head


ODD_NAMES = {"img/a=b.png": PNG, "img/a`b.png": PNG}


@pytest.mark.parametrize(
    ("tag", "expected"),
    [
        ("<img alt=x src=/img/a=b.png>", [("alt", "x"), ("src", "DATA")]),
        ("<img alt=x src=/img/a`b.png>", [("alt", "x"), ("src", "DATA")]),
        ("<img alt=x src=/img/p.png?v=2>", [("alt", "x"), ("src", "DATA")]),
        ("<a href=/about/?x=1>x</a>", [("href", "#/about/")]),
        ("<a href=/a/ title=a<b>x</a>", [("href", "#/a/"), ("title", "a<b")]),
        (
            "<img alt=x src=/img/p.png src=/img/q.png>",
            [("alt", "x"), ("src", "DATA"), ("src", "DATA")],
        ),
        (
            "<a title=\"a &amp; b\" href='/a/' data-x>x</a>",
            [("title", "a & b"), ("href", "#/a/"), ("data-x", None)],
        ),
    ],
)
def test_the_rewrite_reads_attributes_as_discovery_does(tmp_path, tag, expected):
    root = build(tmp_path, "", "", ODD_NAMES, "rewrite")
    for path in ("about/index.html",):
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text("<!doctype html><title>t</title>", encoding="utf-8")
    routes = {"/", "/a/", "/about/"}
    out = bundle.rewrite_body(root, tag, "/", routes)
    (element,) = refs.parse_html(out).elements[:1]
    got = [(n, "DATA" if v and v.startswith("data:") else v) for n, v in element.attrs]
    assert got == expected
    assert "`" not in out.split(">")[0].replace("a`b", "")


class _SelfClosing(HTMLParser):
    """Which start tags were written ``<x/>``, in order, as html.parser reports them."""

    def __init__(self) -> None:
        super().__init__()
        self.seen: list[tuple[str, bool]] = []

    def handle_starttag(self, tag, attrs):
        self.seen.append((tag, False))

    def handle_startendtag(self, tag, attrs):
        self.seen.append((tag, True))


@pytest.mark.parametrize(
    ("snippet", "expected"),
    [
        (
            '<svg><rect style="fill:url(/img/p.png)"/><circle r="3"/></svg>',
            [("svg", False), ("rect", True), ("circle", True)],
        ),
        ('<math><mi style="background:url(/img/p.png)"/><mn>1</mn></math>', None),
        ('<p><img alt="x" src="/img/p.png"/><img alt="y" src="/img/q.png"></p>', None),
    ],
)
def test_the_rewrite_keeps_a_self_closing_tag_self_closing(tmp_path, snippet, expected):
    root = build(tmp_path, "", "", {}, "rewrite")
    out = bundle.rewrite_body(root, snippet, "/", {"/"})
    before, after = _SelfClosing(), _SelfClosing()
    before.feed(snippet)
    after.feed(out)
    assert after.seen == before.seen
    if expected is not None:
        assert after.seen == expected
    assert "data:" in out  # the url() really was rewritten, so the tag was rebuilt
    assert [e.self_closing for e in refs.parse_html(out).elements] == [
        e.self_closing for e in refs.parse_html(snippet).elements
    ]
