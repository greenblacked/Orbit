"""scripts/bundle_preview.py: one self-contained file with every page, that really navigates."""

from __future__ import annotations

import base64
import hashlib
import json
import re
import shutil
import subprocess
import sys
import threading
from html.parser import HTMLParser

import pytest
from helpers import REPO, load_script

bundle = load_script("bundle_preview")
serve = load_script("serve_site")
EPOCH = {"SOURCE_DATE_EPOCH": "1790000000"}


@pytest.fixture(scope="session")
def preview(built, tmp_path_factory):
    out = tmp_path_factory.mktemp("preview") / "index.html"
    assert bundle.main(["--dist", str(built), "--out", str(out), "--commit", "abc1234"]) == 0
    return out


@pytest.fixture(scope="session")
def text(preview):
    return preview.read_text(encoding="utf-8")


def test_the_output_is_one_file_under_five_megabytes(preview):
    assert preview.is_file()
    assert sorted(p.name for p in preview.parent.iterdir()) == ["index.html"]
    assert preview.stat().st_size < 5_000_000


def test_every_page_of_the_build_is_in_the_file(text, built):
    routes = re.findall(r'<template data-route="([^"]+)"', text)
    assert routes == ["/", "/about/", "/compare/", "/timeline/", "/404.html"], (
        "front page, the rest, then the 404"
    )
    assert len(list(built.rglob("*.html"))) == len(routes)
    for needle in (
        "Every OS release",
        "About Release Orbit",
        "There is nothing at this address",
    ):
        assert needle in text


def test_the_front_page_runs_below_js_after_home_js_as_the_bundle_cannot_load_it(text):
    tag = re.search(r'<template data-route="/"[^>]*data-scripts="([^"]*)"', text)
    assert tag
    names = tag.group(1).split()
    assert names.index("/assets/below.js") == names.index("/assets/home.js") + 1
    assert names.index("/assets/lookup.js") == names.index("/assets/below.js") + 1
    assert 'data-page-script="/assets/below.js"' in text


def test_the_timeline_runs_lanes_js_right_after_timeline_js_as_the_bundle_cannot_fetch_it(text):
    tag = re.search(r'<template data-route="/timeline/"[^>]*data-scripts="([^"]*)"', text)
    assert tag
    names = tag.group(1).split()
    assert names.index("/assets/lanes.js") == names.index("/assets/timeline.js") + 1
    assert names.count("/assets/lanes.js") == 1
    assert 'data-page-script="/assets/lanes.js"' in text
    # No other page runs it.
    pages = re.findall(r'<template data-route="([^"]+)"[^>]*data-scripts="([^"]*)"', text)
    for route, scripts in pages:
        if route != "/timeline/":
            assert "/assets/lanes.js" not in scripts.split(), route


def test_the_generic_sigil_rule_runs_right_after_sigil_js_on_every_page_that_draws(text):
    assert 'data-page-script="/assets/sigil-generic.js"' in text
    tags = re.findall(r'<template data-route="([^"]+)"[^>]*data-scripts="([^"]*)"', text)
    drawing = [(r, n.split()) for r, n in tags if "/assets/sigil.js" in n.split()]
    assert drawing, "some page loads sigil.js"
    for route, names in drawing:
        at = names.index("/assets/sigil.js")
        assert names[at + 1] == "/assets/sigil-generic.js", route
        assert names.count("/assets/sigil-generic.js") == 1, route
        for drawer in ("/assets/orbit.js", "/assets/compare.js"):
            if drawer in names:
                assert names.index(drawer) > at + 1, (route, drawer)


def test_a_dist_without_the_generic_sigil_rule_bundles_without_it(tmp_path):
    def mutate(dist):
        (dist / "assets" / "sigil-generic.js").unlink()

    result = build_with(tmp_path, mutate).read_text()
    # sigil.js names the rule in its own text, so look at what the bundle runs, not the text.
    assert 'data-page-script="/assets/sigil-generic.js"' not in result
    tags = re.findall(r'<template data-route="([^"]+)"[^>]*data-scripts="([^"]*)"', result)
    drawing = [n.split() for _, n in tags if "/assets/sigil.js" in n.split()]
    assert drawing, "some page loads sigil.js"
    assert all("/assets/sigil-generic.js" not in names for names in drawing)


def test_nothing_is_fetched_from_outside_the_file(text):
    assert bundle.external_requests(text) == []
    assert "fonts.googleapis.com" not in text
    assert "fonts.gstatic.com" not in text
    assert not re.search(r'(?:src|srcset|poster)="/', text)
    assert not re.search(r'<link[^>]*href="/', text)
    assert 'href="/assets' not in text


def test_assets_are_inlined(text):
    assert text.count('rel="icon" href="data:image/png;base64,') == 1
    assert 'rel="apple-touch-icon" href="data:image/png;base64,' in text
    assert "--bg:" in text  # the stylesheet
    assert 'data-page-script="/assets/site.js"' in text
    assert 'data-page-script="/assets/theme.js"' in text  # theme.js, run with each route
    assert 'data-head-scripts="/assets/theme.js"' in text


def test_links_between_pages_are_hash_routes_and_external_links_are_left_alone(text):
    assert 'href="#/about/"' in text
    assert 'href="#/"' in text
    assert 'href="/about/"' not in text
    assert 'href="/"' not in text
    assert 'href="#what"' in text  # an in-page anchor stays an anchor
    assert re.search(r'href="https://github\.com/[^"]+"', text)


def test_it_says_what_it_is_a_preview_of(text):
    note = re.search(r'<div id="preview-note".*?</div>', text, flags=re.DOTALL).group(0)
    assert "Preview" in note
    assert "<code>v0</code>" in note
    assert "<code>abc1234</code>" in note
    assert '<meta name="robots" content="noindex">' in text
    assert "<title>Preview" in text


def test_the_same_inputs_give_the_same_file(built, tmp_path, monkeypatch):
    monkeypatch.setenv("SOURCE_DATE_EPOCH", EPOCH["SOURCE_DATE_EPOCH"])
    first, second = tmp_path / "a.html", tmp_path / "b.html"
    for target in (first, second):
        assert bundle.main(["--dist", str(built), "--out", str(target), "--commit", "abc1234"]) == 0
    assert first.read_bytes() == second.read_bytes()


def test_a_bundle_over_the_limit_fails_and_writes_nothing(built, tmp_path):
    out = tmp_path / "index.html"
    assert bundle.main(["--dist", str(built), "--out", str(out), "--max-bytes", "1000"]) == 1
    assert not out.exists()


def test_a_missing_build_is_reported(tmp_path):
    assert bundle.main(["--dist", str(tmp_path / "nope"), "--out", str(tmp_path / "x.html")]) == 2


def test_a_bad_commit_label_is_refused(built, tmp_path):
    with pytest.raises(SystemExit):
        bundle.main(["--dist", str(built), "--out", str(tmp_path / "x.html"), "--commit", "a b<"])


@pytest.mark.parametrize(
    "snippet",
    [
        '<img src="https://example.org/x.png">',
        '<link rel="stylesheet" href="//example.org/a.css">',
        '<script src="http://example.org/a.js"></script>',
        '<iframe src="https://example.org/"></iframe>',
        '<div style="background: url(https://example.org/a.png)"></div>',
        "<style>@import url(https://example.org/a.css);</style>",
        "<style>@import 'a.css';</style>",
        "<style>body { background: url('//example.org/a.png') }</style>",
        '<img srcset="/a.png 1x, https://example.org/b.png 2x">',
        '<form action="https://example.org/post"></form>',
    ],
)
def test_the_guard_finds_every_kind_of_outside_request(snippet):
    assert bundle.external_requests(f"<body>{snippet}</body>") != []


def test_the_guard_allows_navigation_and_data_uris():
    ok = (
        '<a href="https://example.org/">x</a><img src="data:image/png;base64,AAAA">'
        '<a href="#/x">y</a>'
    )
    assert bundle.external_requests(ok) == []


def make_dist(tmp_path, mutate):
    dist = tmp_path / "site"
    shutil.copytree(REPO / "src", dist)
    (dist / "version.txt").write_text("v1\n")
    for page in dist.rglob("*.html"):
        page.write_text(page.read_text().replace("{{version}}", "v1"))
    mutate(dist)
    return dist


def test_a_page_that_names_a_missing_asset_fails_the_build(tmp_path):
    def mutate(dist):
        index = dist / "index.html"
        index.write_text(
            index.read_text().replace("</main>", '<img src="/nope.png" alt=""></main>')
        )

    with pytest.raises(SystemExit):
        bundle.main(["--dist", str(make_dist(tmp_path, mutate)), "--out", str(tmp_path / "o.html")])


def test_a_script_that_cannot_be_inlined_is_refused(tmp_path):
    def mutate(dist):
        (dist / "assets" / "site.js").write_text("var x = '<!--'; var y = '<script';")

    with pytest.raises(SystemExit):
        bundle.main(["--dist", str(make_dist(tmp_path, mutate)), "--out", str(tmp_path / "o.html")])


def bundled(tmp_path, snippet, extra=None):
    def mutate(dist):
        (dist / "clip.mp3").write_bytes(b"ID3audio")
        (dist / "poster.png").write_bytes((dist / "favicon.png").read_bytes())
        (dist / "frame").mkdir()
        (dist / "frame" / "index.html").write_text(
            "<html><head></head><body><p>frame</p></body></html>"
        )
        index = dist / "index.html"
        index.write_text(index.read_text().replace("</main>", snippet + "</main>"))
        if extra:
            extra(dist)

    dist = make_dist(tmp_path, mutate)
    out = tmp_path / "o.html"
    code = bundle.main(["--dist", str(dist), "--out", str(out), "--commit", "abc1234"])
    return code, out


@pytest.mark.parametrize(
    "snippet",
    [
        '<audio src="/clip.mp3"></audio>',
        '<video poster="/poster.png"></video>',
        '<audio controls><source src="/clip.mp3"><track src="/clip.mp3"></audio>',
        '<img alt="" src="/poster.png" srcset="/poster.png 1x, /poster.png 2x">',
        '<div style="background: url(/poster.png)"></div>',
        "<style>.x { background: url('/poster.png') }</style>",
        '<object data="/clip.mp3"></object>',
        '<input type="image" src="/poster.png" alt="go">',
        "<audio src=/clip.mp3></audio>",
    ],
)
def test_other_fetching_elements_are_inlined(tmp_path, snippet):
    code, out = bundled(tmp_path, snippet)
    assert code == 0
    result = out.read_text()
    assert bundle.external_requests(result) == []
    assert 'src="/' not in result.split("</template>", 1)[0].split('data-route="/"', 1)[-1]
    assert "/clip.mp3" not in result


@pytest.mark.parametrize(
    "snippet",
    [
        '<iframe src="/frame/"></iframe>',
        '<iframe src="/frame/index.html"></iframe>',
        '<iframe src="https://example.org/"></iframe>',
        '<link rel="stylesheet" href="/assets/site.css">',
        '<link rel="preload" href="/poster.png" as="image">',
        '<embed src="/missing.pdf">',
        '<img alt="" src="/missing.png" srcset="/missing.png 1x">',
        '<div style="background: url(/missing.png)"></div>',
        "<style>.x { background: url(https://example.org/a.png) }</style>",
        '<svg><use href="/sprite.svg#a"></use></svg>',
    ],
)
def test_what_cannot_be_inlined_fails_the_build(tmp_path, snippet):
    with pytest.raises(SystemExit):
        bundled(tmp_path, snippet)


def test_the_guard_flags_a_local_fetch_but_not_navigation_or_fragments():
    assert bundle.external_requests('<audio src="/a.mp3"></audio>') != []
    assert bundle.external_requests('<video poster="a.png"></video>') != []
    assert bundle.external_requests('<img srcset="/a.png 1x">') != []
    assert bundle.external_requests('<p style="background:url(/a.png)"></p>') != []
    assert bundle.external_requests('<link rel="icon" href="/a.png">') != []
    assert (
        bundle.external_requests(
            '<a href="/x/">x</a><form action="/go"></form><svg><use href="#a"></use></svg>'
            '<img srcset="data:image/png;base64,AAAA 1x, data:image/png;base64,BBBB 2x">'
            '<p style="clip-path:url(#c)"></p>'
        )
        == []
    )


def test_a_new_page_and_a_local_image_are_bundled_without_editing_the_script(tmp_path):
    def mutate(dist):
        (dist / "blog").mkdir()
        page = (dist / "about" / "index.html").read_text()
        page = page.replace(
            '<h1 class="title">About Release Orbit</h1>', '<h1 class="title">Blog</h1>'
        )
        page = page.replace("</main>", '<img src="/favicon.png" alt="logo"></main>')
        (dist / "blog" / "index.html").write_text(page)

    dist = make_dist(tmp_path, mutate)
    out = tmp_path / "o.html"
    assert bundle.main(["--dist", str(dist), "--out", str(out), "--commit", "abc1234"]) == 0
    result = out.read_text()
    assert 'data-route="/blog/"' in result
    assert 'alt="logo"' in result
    assert bundle.external_requests(result) == []


# --- a stylesheet linked by one page applies on that route only --------------------------

SITE_LINK = '<link rel="stylesheet" href="/assets/site.css">'
ABOUT_ONLY = "body { background: rgb(1, 2, 3) !important; }\n"


def route_css(result: str, route: str) -> list[str]:
    """The stylesheet texts a route applies, in order, as the router will insert them."""
    sheets = dict(
        re.findall(r'<template data-sheet="(\d+)"><style>(.*?)</style></template>', result, re.S)
    )
    tag = re.search(
        r'<template data-route="' + re.escape(route) + r'"[^>]*data-sheets="([^"]*)"', result
    )
    assert tag, route
    return [sheets[i] for i in tag.group(1).split()]


def about_only_bundle(tmp_path):
    def mutate(dist):
        (dist / "assets" / "about-only.css").write_text(ABOUT_ONLY)
        about = dist / "about" / "index.html"
        page = about.read_text()
        assert SITE_LINK in page
        about.write_text(
            page.replace(
                SITE_LINK, SITE_LINK + '\n<link rel="stylesheet" href="/assets/about-only.css">'
            )
        )

    dist = make_dist(tmp_path, mutate)
    out = tmp_path / "about-only.html"
    assert bundle.main(["--dist", str(dist), "--out", str(out), "--commit", "abc1234"]) == 0
    return out


def test_a_page_only_stylesheet_is_listed_for_that_route_only(tmp_path):
    result = about_only_bundle(tmp_path).read_text()
    head, _, rest = result.partition("<body>")
    assert "rgb(1, 2, 3)" not in head
    about = "".join(route_css(result, "/about/"))
    assert "rgb(1, 2, 3)" in about
    assert ":root" in about, "the shared stylesheet is listed for the page too"
    assert "rgb(1, 2, 3)" not in "".join(route_css(result, "/"))
    assert "rgb(1, 2, 3)" not in "".join(route_css(result, "/404.html"))


def test_every_style_of_a_per_page_bundle_is_listed_by_hash(tmp_path):
    text = about_only_bundle(tmp_path).read_text()
    policy = dict(item.split(" ", 1) for item in policy_of(text).split("; "))
    found = Executable()
    found.feed(text)
    assert set(policy["style-src"].split()) == {digest(t) for t in found.styles}


def cascade_dist(tmp_path):
    """Every page links shared.css (blue); /about/ also links page.css (red) before it."""

    def mutate(dist):
        (dist / "assets" / "page.css").write_text("body { background: rgb(255, 0, 0); }\n")
        (dist / "assets" / "shared.css").write_text("body { background: rgb(0, 0, 255); }\n")
        for file in dist.rglob("*.html"):
            links = ["page.css", "shared.css"] if file.parent.name == "about" else ["shared.css"]
            tags = "".join(f'<link rel="stylesheet" href="/assets/{n}">' for n in links)
            file.write_text(file.read_text().replace(SITE_LINK, SITE_LINK + tags))

    return make_dist(tmp_path, mutate)


def test_stylesheets_keep_the_pages_link_order_in_its_route_list(tmp_path):
    dist = cascade_dist(tmp_path)
    out = tmp_path / "o.html"
    assert bundle.main(["--dist", str(dist), "--out", str(out), "--commit", "abc1234"]) == 0
    result = out.read_text()
    about = route_css(result, "/about/")
    joined = "".join(about)
    assert joined.index("rgb(255, 0, 0)") < joined.index("rgb(0, 0, 255)")
    assert "rgb(255, 0, 0)" not in "".join(route_css(result, "/"))
    head = result.partition("<body>")[0]
    assert "rgb(0, 0, 255)" not in head and "rgb(255, 0, 0)" not in head


def test_identical_css_in_several_templates_is_listed_once_in_the_policy(tmp_path):
    dist = cascade_dist(tmp_path)
    out = tmp_path / "o.html"
    assert bundle.main(["--dist", str(dist), "--out", str(out), "--commit", "abc1234"]) == 0
    sources = policy_of(out.read_text()).split("style-src ")[1].split()
    assert len(sources) == len(set(sources))


@pytest.mark.browser
def test_a_sheet_linked_before_a_shared_one_loses_to_it_in_the_bundle_as_in_production(
    browser, tmp_path
):
    dist = cascade_dist(tmp_path)
    out = tmp_path / "o.html"
    assert bundle.main(["--dist", str(dist), "--out", str(out), "--commit", "abc1234"]) == 0
    page = browser.new_page()
    page.goto(out.resolve().as_uri() + "#/about/")
    page.wait_for_selector("main")
    colour = "() => getComputedStyle(document.body).backgroundColor"
    assert page.evaluate(colour) == "rgb(0, 0, 255)"
    page.close()


def many_pages_dist(tmp_path, count=40):
    blob = base64.b64encode(bytes(range(256)) * 480).decode()  # ~160 KB of base64
    sheet = f'.hero {{ background: url("data:image/png;base64,{blob}"); }}\n'

    def mutate(dist):
        (dist / "assets" / "big.css").write_text(sheet)
        tags = '<link rel="stylesheet" href="/assets/big.css">'
        for n in range(count):
            page = dist / f"extra-{n}" / "index.html"
            page.parent.mkdir()
            text = (dist / "about" / "index.html").read_text()
            page.write_text(text.replace(SITE_LINK, SITE_LINK + tags, 1))

    return make_dist(tmp_path, mutate), blob


def test_many_pages_sharing_a_large_sheet_stay_under_the_limit(tmp_path):
    dist, blob = many_pages_dist(tmp_path)
    out = tmp_path / "many.html"
    assert bundle.main(["--dist", str(dist), "--out", str(out), "--commit", "abc1234"]) == 0
    result = out.read_text()
    assert out.stat().st_size < bundle.MAX_BYTES
    assert result.count(blob) == 1, "the shared sheet is stored once"
    assert result.count('data-sheets="') >= 40
    for n in range(40):
        assert blob in "".join(route_css(result, f"/extra-{n}/"))


def test_a_repeated_sheet_is_listed_each_time_the_page_links_it(tmp_path):
    def mutate(dist):
        (dist / "assets" / "a.css").write_text("body { color: red; }\n")
        about = dist / "about" / "index.html"
        links = "".join(
            f'<link rel="stylesheet" href="/assets/{n}.css">' for n in ("a", "site", "a")
        )
        about.write_text(about.read_text().replace(SITE_LINK, links, 1))

    dist = make_dist(tmp_path, mutate)
    out = tmp_path / "o.html"
    assert bundle.main(["--dist", str(dist), "--out", str(out), "--commit", "abc1234"]) == 0
    css = route_css(out.read_text(), "/about/")
    assert [c.startswith("body { color: red") for c in css] == [True, False, True]


@pytest.mark.browser
def test_switching_routes_keeps_the_cascade_right(browser, tmp_path):
    dist = cascade_dist(tmp_path)
    out = tmp_path / "o.html"
    assert bundle.main(["--dist", str(dist), "--out", str(out), "--commit", "abc1234"]) == 0
    page = browser.new_page()
    colour = "() => getComputedStyle(document.body).backgroundColor"
    page.goto(out.resolve().as_uri() + "#/about/")
    page.wait_for_selector("main")
    assert page.evaluate(colour) == "rgb(0, 0, 255)"
    sheets = "() => document.querySelectorAll('#app > style').length"
    for route, count in (("/", 2), ("/about/", 3), ("/", 2), ("/about/", 3)):
        page.evaluate("(r) => { location.hash = r }", route)
        page.wait_for_function(
            f"() => document.querySelectorAll('#app > style').length === {count}"
        )
        assert page.evaluate(sheets) == count, "the left route's sheets are gone"
        assert page.evaluate(colour) == "rgb(0, 0, 255)"
    page.close()


@pytest.mark.parametrize("script", ["bundle_preview", "check_site", "build_site", "serve_site"])
def test_a_relative_path_works_from_another_directory(script, tmp_path):
    """Each script is run as a file with relative path arguments from a different cwd."""
    scripts = REPO / "scripts"
    site = tmp_path / "work" / "dist" / "site"
    shutil.copytree(REPO / "src", tmp_path / "work" / "src")
    cwd = tmp_path / "work"

    def run(*argv, **kw):
        return subprocess.run(  # noqa: S603 - fixed argv
            [sys.executable, str(scripts / argv[0]), *argv[1:]],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=60,
            **kw,
        )

    built = run("build_site.py", "--version", "v1", "--src", "src", "--out", "dist/site")
    assert built.returncode == 0, built.stderr
    assert site.is_dir()
    if script == "build_site":
        return
    if script == "bundle_preview":
        done = run(
            "bundle_preview.py", "--dist", "dist/site", "--out", "out/index.html", "--commit", "abc"
        )
        assert done.returncode == 0, done.stderr
        assert (cwd / "out" / "index.html").is_file()
    elif script == "check_site":
        done = run("check_site.py", "dist/site")
        assert done.returncode == 0, done.stdout + done.stderr
    else:
        serving = subprocess.Popen(  # noqa: S603 - fixed argv
            [sys.executable, str(scripts / "serve_site.py"), "--dir", "dist/site", "--port", "0"],
            cwd=cwd,
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            assert serving.stdout.readline().startswith("serving http://")
        finally:
            serving.terminate()
            serving.wait(timeout=10)


# --- the policy is the boundary, the guard the early warning -----------------------------

# Every construct an adversarial review found that still fetched in Chromium once the
# regex guard had been written. Only tests hold them: the shipped skeleton has none.
EVIL = "https://evil.example"
BOX = "width:9px;height:9px;"


def styled(rule: str) -> str:
    """A 9px box that takes ``rule`` from a ``<style>`` block."""
    return f'<style>.h{{{BOX}{rule}}}</style><div class="h"></div>'


HOSTILE = {
    "uppercase URL()": f'<div style="{BOX}background:URL({EVIL}/upper.png)"></div>',
    "quote inside url()": f"<div style='{BOX}background:url(\"{EVIL}/it&#39;s.png\")'></div>",
    "escaped url(": styled(f"background:\\75rl({EVIL}/esc.png)"),
    "image-set string": styled(f'background-image:image-set("{EVIL}/set.png" 1x)'),
    "webkit image-set string": styled(f'background-image:-webkit-image-set("{EVIL}/wk.png" 1x)'),
    "meta refresh": f'<meta http-equiv="refresh" content="1;url={EVIL}/refresh">',
    "iframe srcdoc": f'<iframe srcdoc="&lt;img src={EVIL}/srcdoc.png&gt;"></iframe>',
    "svg script href": f'<svg><script href="{EVIL}/svg.js"/></svg>',
    "svg presentation url()": (
        f'<svg width="9" height="9"><rect width="9" height="9" fill="url({EVIL}/f.svg#a)" '
        f'filter="url({EVIL}/fl.svg#a)" mask="url({EVIL}/m.svg#a)" '
        f'clip-path="url({EVIL}/c.svg#a)" marker-end="url({EVIL}/e.svg#a)"/></svg>'
    ),
    "a ping": f'<a id="hostile-ping" href="#x" ping="{EVIL}/ping">x</a>',
}
# Inline script that navigates off the file. The image is a data: URI that is not an image,
# so its error handler runs on load without the guard's fetch rules having anything to say.
BROKEN_IMG = "data:image/png;base64,AAAA"
SCRIPTED = {
    "img onerror sets location": (
        f'<img alt="" src="{BROKEN_IMG}" onerror="location=\'{EVIL}/nav\'">'
    ),
    "img onerror opens a window": (
        f'<img alt="" src="{BROKEN_IMG}" onerror="window.open(\'{EVIL}/open\')">'
    ),
    "svg onload sets location": (
        f'<svg width="9" height="9" onload="location=\'{EVIL}/svg\'"></svg>'
    ),
    "onerror clicks an external link": (
        f'<a id="hostile-link" href="{EVIL}/click">x</a>'
        f'<img alt="" src="{BROKEN_IMG}" '
        "onerror=\"document.getElementById('hostile-link').click()\">"
    ),
    "javascript: link": (f'<a id="hostile-js" href="javascript:location=\'{EVIL}/js\'">x</a>'),
}
HOSTILE.update(SCRIPTED)
# Navigation is not governed by a Content-Security-Policy: the guard has to refuse these.
NAVIGATION_ONLY = {"meta refresh"}


@pytest.mark.parametrize("name", sorted(HOSTILE))
def test_the_guard_refuses_each_hostile_construct(tmp_path, name):
    with pytest.raises(SystemExit):
        bundled(tmp_path, HOSTILE[name])


@pytest.mark.parametrize("name", sorted(SCRIPTED))
def test_the_guard_names_the_inline_handler_or_script_url(tmp_path, name):
    with pytest.raises(SystemExit, match=r"on(error|load)=|javascript:"):
        bundled(tmp_path, SCRIPTED[name])


@pytest.mark.parametrize(
    "snippet",
    [
        '<p onclick="x()">x</p>',
        '<p ONMOUSEOVER="x()">x</p>',
        "<p onfocus=x()>x</p>",
        '<a href="  JaVa&#x0A;script:alert(1)">x</a>',
        '<a href="javascript:void(0)">x</a>',
        '<form action="javascript:x()"></form>',
        '<button formaction="javascript:x()">x</button>',
    ],
)
def test_the_guard_finds_handlers_and_script_urls_in_any_spelling(snippet):
    assert bundle.external_requests(f"<body>{snippet}</body>") != []


def test_the_guard_leaves_words_that_only_look_like_handlers_alone():
    ok = '<a href="#/x" title="javascript: a language" data-one="1" aria-label="on">y</a>'
    assert bundle.external_requests(f"<body>{ok}</body>") == []


@pytest.mark.parametrize(
    "snippet",
    [
        '<div style="background:URL(https://example.org/a.png)"></div>',
        "<style>.x{background:\\75rl(a.png)}</style>",
        "<style>.x{background:u\\72l(a.png)}</style>",
        "<style>.x{background-image:image-set('a.png' 1x)}</style>",
        '<style>.x{background-image:-WEBKIT-IMAGE-SET("a.png" 1x)}</style>',
        '<meta http-equiv="Refresh" content="0;url=/about/">',
        '<a href="/" ping="/p">x</a>',
        '<iframe srcdoc="x"></iframe>',
        '<svg><script href="/a.js"/></svg>',
        '<svg><rect clip-path="url(/c.svg#a)"/></svg>',
    ],
)
def test_the_guard_finds_the_second_round_of_constructs(snippet):
    assert bundle.external_requests(f"<body>{snippet}</body>") != []


@pytest.mark.parametrize(
    "snippet", ["<script>var a = 1;</script>", '<script type="module">x</script>']
)
def test_a_body_script_other_than_src_is_refused(tmp_path, snippet):
    with pytest.raises(SystemExit):
        bundled(tmp_path, snippet)


def policy_of(text: str) -> str:
    head = text.split("<head>", 1)[1]
    metas = re.findall(r"<meta [^>]*>", head)
    assert metas[0] == '<meta charset="utf-8">'
    found = re.fullmatch(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">', metas[1])
    assert found, "the policy is the second element of the head, right after the charset"
    return found.group(1)


def test_the_policy_is_the_first_thing_after_the_charset_and_allows_nothing_else(text):
    policy = dict(item.split(" ", 1) for item in policy_of(text).split("; "))
    assert policy["default-src"] == "'none'"
    for directive in (
        "connect-src",
        "frame-src",
        "object-src",
        "worker-src",
        "base-uri",
        "form-action",
    ):
        assert policy[directive] == "'none'"
    for directive in ("img-src", "media-src", "font-src"):
        assert policy[directive] == "data:"
    assert not re.search(r"https?:|\*|unsafe-inline|unsafe-eval", policy_of(text))
    for directive in ("script-src", "style-src"):
        assert re.fullmatch(r"('sha256-[A-Za-z0-9+/=]+' ?)+", policy[directive]), directive


class Executable(HTMLParser):
    """Every inline script that runs (or is run by the router) and every inline style."""

    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.scripts: list[str] = []
        self.styles: list[str] = []
        self.attrs: list[str] = []
        self._into = None

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        self.attrs += [v for k, v in attrs if k == "style"]
        if tag == "script" and "src" not in d:
            self._into = self.scripts
            self._into.append("")
        elif tag == "style":
            self._into = self.styles
            self._into.append("")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self._into = None

    def handle_data(self, data):
        if self._into is not None:
            self._into[-1] += data


def digest(source: str) -> str:
    return "'sha256-" + base64.b64encode(hashlib.sha256(source.encode()).digest()).decode() + "'"


def test_every_inline_script_and_style_is_listed_by_hash_and_nothing_else_is(text):
    policy = dict(item.split(" ", 1) for item in policy_of(text).split("; "))
    found = Executable()
    found.feed(text)
    # text/plain page scripts are listed too: the router runs each as a new <script>
    assert len(found.scripts) >= 3, "theme script, the page script and the router"
    assert set(policy["script-src"].split()) == {digest(t) for t in found.scripts}
    assert set(policy["style-src"].split()) == {digest(t) for t in found.styles}
    assert found.attrs == []


def test_a_changed_script_changes_its_hash(built, tmp_path):
    def mutate(dist):
        with (dist / "assets" / "site.js").open("a") as f:
            f.write("\n// changed\n")

    first = tmp_path / "a.html"
    second = tmp_path / "b.html"
    dist = make_dist(tmp_path, mutate)
    assert bundle.main(["--dist", str(dist), "--out", str(second), "--commit", "abc1234"]) == 0
    assert bundle.main(["--dist", str(built), "--out", str(first), "--commit", "abc1234"]) == 0
    assert policy_of(first.read_text()) != policy_of(second.read_text())


# --- in a browser -----------------------------------------------------------------------


@pytest.fixture
def served(preview):
    """The bundle served at the site root, the worst case for a page script that tests
    ``location.pathname``."""
    server = serve.make_server(preview.parent)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


@pytest.fixture
def tab(browser, served):
    context = browser.new_context(viewport={"width": 1280, "height": 800}, reduced_motion="reduce")
    requested: list[str] = []

    def guard(route):
        url = route.request.url
        if url.startswith(served + "/") or url.startswith("data:"):
            route.continue_()
        else:
            requested.append(url)
            route.abort()

    context.route("**/*", guard)
    page = context.new_page()
    page.requested = requested
    page.errors = []
    page.on("console", lambda m: page.errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    yield page
    context.close()


def heading(tab, expected: str) -> None:
    """The page's h1 becomes ``expected``; waits, because a hash change is asynchronous."""
    from playwright.sync_api import expect

    expect(tab.locator("main h1")).to_have_text(expected)


@pytest.mark.browser
def test_the_pages_switch_by_hash_and_the_title_follows(tab, served):
    tab.goto(served + "/")
    heading(tab, re.compile("^Every OS release"))
    tab.get_by_role("navigation", name="Primary").get_by_role("link", name="About").click()
    assert tab.evaluate("() => location.hash") == "#/about/"
    heading(tab, "About Release Orbit")
    assert "About" in tab.title()
    tab.goto(served + "/#/nope/")
    heading(tab, "Not found")
    tab.goto(served + "/#/404.html")
    heading(tab, "Not found")
    tab.wait_for_load_state("networkidle")
    assert tab.requested == []
    assert tab.errors == []


@pytest.mark.browser
def test_an_in_page_anchor_scrolls_without_leaving_the_page(tab, served):
    tab.goto(served + "/#/about/")
    tab.locator('a[href="#disclaimer"]').click()
    assert tab.evaluate("() => location.hash") == "#/about/"
    assert tab.evaluate("() => window.scrollY") > 200
    tab.evaluate("() => window.scrollTo(0, 0)")  # so the next wait cannot pass on the old scroll
    tab.goto(served + "/#/about/#privacy")  # only the fragment changes: a hashchange, not a load
    tab.wait_for_function("() => window.scrollY > 200")
    tab.wait_for_function(  # the heading rests at the top, below the sticky header's scroll margin
        "() => { const el = document.getElementById('privacy');"
        " const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;"
        " return Math.abs(el.getBoundingClientRect().top - margin) < 5; }"
    )
    assert tab.evaluate("() => window.scrollY") > 200


def test_the_router_mends_links_a_script_builds_at_run_time(text):
    router = text.rsplit("<script>", 1)[1]
    assert "function routeOf(href)" in router
    assert 'document.addEventListener("click", mend)' in router
    assert 'document.addEventListener("auxclick", mend)' in router
    assert 'document.addEventListener("contextmenu", mend)' in router
    assert "template[data-route=" in router  # the routes are the bundle's own templates
    # the router that runs is the one the policy hashes
    assert bundle.sha256_source(f"\n{bundle.ROUTER}\n") in policy_of(text)


@pytest.mark.browser
@pytest.mark.parametrize(
    ("href", "hash", "title"),
    [
        ("/compare/?family=ios&from=17.0&to=18.0&platform=iphone&build=1", "#/compare/", "Compare"),
        ("/timeline/?id=ios-18-0", "#/timeline/", "Timeline"),
        ("/about", "#/about/", "About"),
        ("/about/index.html?x=1#privacy", "#/about/#privacy", "About"),
    ],
)
def test_a_link_built_at_run_time_stays_inside_the_bundle(tab, served, href, hash, title):
    tab.goto(served + "/#/")
    tab.wait_for_selector("main")
    tab.evaluate(
        "(href) => { const a = document.createElement('a'); a.id = 'rt'; a.href = href;"
        " a.textContent = 'runtime'; document.querySelector('main').appendChild(a); }",
        href,
    )
    tab.locator("#rt").click()
    tab.wait_for_function(f"() => location.hash === {hash!r}")
    tab.wait_for_function(f"() => document.title.includes({title!r})")
    assert tab.url.startswith(served + "/#/")  # still the one file
    assert tab.requested == []
    assert tab.errors == []


@pytest.mark.browser
def test_the_cadence_view_draws_in_the_bundle_without_fetching_lanes_js(tab, served):
    tab.goto(served + "/#/timeline/")
    tab.wait_for_selector(".tl-item")
    tab.click("#chips-view [data-v=cadence]")
    tab.wait_for_selector(".lanes-lane .lanes-dot")
    assert tab.locator(".lanes-lane").count() >= 1
    assert tab.get_attribute("#chips-view [data-v=cadence]", "aria-pressed") == "true"
    # A chosen dot's "Show in list" works in the bundle too: it switches views in place.
    dot = tab.locator(".lanes-dot[tabindex='0']").first
    release_id = dot.get_attribute("data-id")
    dot.focus()
    tab.keyboard.press("Enter")
    # A same-day dot lists several releases, newest first, and its data-id is the newest.
    tab.locator("#lanes-read a", has_text="Show in list").first.focus()
    tab.keyboard.press("Enter")
    tab.wait_for_function("() => document.activeElement.closest('.tl-item') !== null")
    assert tab.evaluate("document.activeElement.closest('.tl-item').dataset.id") == release_id
    assert tab.get_attribute("#chips-view [data-v=list]", "aria-pressed") == "true"
    assert tab.requested == []
    assert tab.errors == []


@pytest.mark.browser
def test_external_and_unknown_links_are_left_as_they_are(tab, served):
    tab.goto(served + "/#/about/")
    heading(tab, "About Release Orbit")
    hrefs = ["https://example.com/compare/", "//example.com/compare/", "/nowhere/", "mailto:a@b.c"]
    kept = tab.evaluate(
        """(hrefs) => hrefs.map((href) => {
            const a = document.createElement('a');
            a.setAttribute('href', href);
            document.querySelector('main').appendChild(a);
            const stop = (e) => e.preventDefault();
            window.addEventListener('click', stop);
            // bubbles to the router's listener on document, then window cancels the navigation
            a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            window.removeEventListener('click', stop);
            return a.getAttribute('href');
        })""",
        hrefs,
    )
    assert kept == hrefs
    assert tab.evaluate("() => location.hash") == "#/about/"


@pytest.mark.browser
def test_the_page_script_works_and_is_not_doubled_by_navigating(tab, served):
    tab.goto(served + "/")
    tab.evaluate("() => localStorage.setItem('theme', 'day')")
    tab.reload()
    assert tab.evaluate("() => document.documentElement.dataset.theme") == "day"
    for _ in range(3):  # round trips would stack listeners if they were not removed
        tab.get_by_role("navigation", name="Primary").get_by_role("link", name="About").click()
        tab.locator("#home").click()  # at the site root: must navigate, not scroll in place
        assert tab.evaluate("() => location.hash") == "#/"
    tab.locator("#dark-switch").click()
    assert tab.evaluate("() => document.documentElement.dataset.theme") == "night"
    tab.locator("#console-theme").click()
    assert tab.evaluate("() => document.documentElement.dataset.theme") == "reactor"


@pytest.mark.browser
def test_the_preview_strip_and_back_work(tab, served):
    tab.goto(served + "/#/about/")
    assert "abc1234" in tab.locator("#preview-note").inner_text()
    assert "v0" in tab.locator("#preview-note").inner_text()
    tab.locator("#preview-note").get_by_role("link", name="/404.html").click()
    heading(tab, "Not found")
    tab.locator("main .back").click()
    tab.wait_for_function("() => location.hash === '#/'")  # history.back() settles later
    assert tab.evaluate("() => location.hash") == "#/"
    assert tab.errors == []


# --- from disk, with the policy as the only thing standing between it and the network ----


def watch(context):
    """The page, and two lists: every request it attempted, and those that reached the
    network stack. The router sees only the second; a request the policy (``csp``) or the
    same-origin rule for SVG filters (``origin``) stops in the renderer is attempted but
    never leaves the browser."""
    attempted: list[str] = []
    network: list[str] = []
    page = context.new_page()
    page.on("request", lambda r: attempted.append(r.url))
    for pattern in ("http://**/*", "https://**/*", "ftp://**/*", "ws://**/*", "wss://**/*"):
        context.route(pattern, lambda route: (network.append(route.request.url), route.abort()))
    return page, (attempted, network)


def outside(watched, bundle_file) -> list[str]:
    """Attempts that were neither the file itself nor a ``data:`` URI."""
    own = bundle_file.resolve().as_uri()
    return [u for u in watched[0] if not u.startswith("data:") and u.split("#")[0] != own]


def with_hostile_page(text: str, snippets: str) -> str:
    """The real bundle with ``snippets`` slipped into the front page's template, past the
    guard that ran when it was built: what the policy alone has to hold."""
    marker = '<template data-route="/" '
    start = text.index(marker)
    close = text.index("</template>", start)
    return text[:close] + snippets + text[close:]


@pytest.mark.browser
@pytest.mark.parametrize("name", sorted(set(HOSTILE) - NAVIGATION_ONLY - set(SCRIPTED)))
def test_the_policy_alone_stops_each_hostile_construct(browser, preview, tmp_path, name):
    hostile = tmp_path / "hostile.html"
    hostile.write_text(with_hostile_page(preview.read_text(encoding="utf-8"), HOSTILE[name]))
    context = browser.new_context(viewport={"width": 1280, "height": 800})
    page, watched = watch(context)
    page.goto(hostile.resolve().as_uri())
    assert page.locator("main").count() == 1
    if name == "a ping":
        page.locator("#hostile-ping").click()
    page.wait_for_timeout(600)
    context.close()
    assert watched[1] == [], name  # nothing reached the network


@pytest.mark.browser
def test_every_hostile_construct_at_once_fails_the_build_or_requests_nothing(browser, tmp_path):
    snippet = "".join(HOSTILE.values())
    try:
        code, out = bundled(tmp_path, snippet)
    except SystemExit:
        return  # the guard caught it, which is the early warning working
    assert code == 0
    context = browser.new_context()
    page, watched = watch(context)
    page.goto(out.resolve().as_uri())
    page.wait_for_timeout(600)
    context.close()
    assert watched[1] == []


# --- inline handlers: the hashes, not the guard, are what refuse them -------------------


def violations_script() -> str:
    return (
        "window.__csp = [];"
        "document.addEventListener('securitypolicyviolation',"
        " e => window.__csp.push(e.effectiveDirective), true);"
    )


@pytest.mark.browser
@pytest.mark.parametrize("name", sorted(SCRIPTED))
def test_the_policy_alone_refuses_inline_handlers_and_script_urls(browser, preview, tmp_path, name):
    hostile = tmp_path / "hostile.html"
    hostile.write_text(with_hostile_page(preview.read_text(encoding="utf-8"), SCRIPTED[name]))
    context = browser.new_context(viewport={"width": 1280, "height": 800})
    context.add_init_script(violations_script())
    page, watched = watch(context)
    page.goto(hostile.resolve().as_uri())
    assert page.locator("main").count() == 1
    if name == "javascript: link":
        page.locator("#hostile-js").click()
    # The violation is reported in a later task; wait for it, then give the rest time to show.
    page.wait_for_function("() => window.__csp.length > 0", timeout=10000)
    page.wait_for_timeout(600)
    here = page.url
    reported = page.evaluate("() => window.__csp")
    pages = len(context.pages)
    context.close()
    assert here.startswith(hostile.resolve().as_uri()), (name, here)
    assert pages == 1, f"{name} opened a window"
    assert outside(watched, hostile) == [], name
    assert watched[1] == [], name
    assert reported, f"{name}: the policy reported no violation"
    assert set(reported) <= {"script-src-attr", "script-src-elem", "script-src"}


@pytest.mark.browser
@pytest.mark.parametrize("name", sorted(SCRIPTED))
def test_without_the_policy_the_same_page_does_leave_the_file(browser, preview, tmp_path, name):
    """The check above has teeth: strip the policy and each construct acts."""
    source = preview.read_text(encoding="utf-8")
    source = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>', "", source)
    hostile = tmp_path / "bare.html"
    hostile.write_text(with_hostile_page(source, SCRIPTED[name]))
    context = browser.new_context(viewport={"width": 1280, "height": 800})
    popups: list[str] = []
    context.on("page", lambda p: popups.append(p.url))
    page, watched = watch(context)
    page.goto(hostile.resolve().as_uri())
    if name == "javascript: link":
        page.locator("#hostile-js").click()
    for _ in range(100):  # up to 10 s for the request or the window to appear
        if outside(watched, hostile) or popups:
            break
        page.wait_for_timeout(100)
    context.close()
    assert outside(watched, hostile) != [] or popups, name


# --- every route, every theme, from disk -------------------------------------------------

THEMES = ("day", "night", "reactor")


def tour(browser, bundle_file, until=None) -> dict[str, dict[str, list[str]]]:
    """Open the bundle from disk once per theme and per route, and report for each theme
    the requests that were neither the file nor a ``data:`` URI, the console errors, and
    the policy violations. ``until`` is a page function to wait for on each route before the
    reads, for an event the caller knows will come."""
    routes = re.findall(r'<template data-route="([^"]+)"', bundle_file.read_text(encoding="utf-8"))
    assert routes == ["/", "/about/", "/compare/", "/timeline/", "/404.html"]
    report = {}
    for theme in THEMES:
        context = browser.new_context(viewport={"width": 1280, "height": 800})
        context.add_init_script(
            f"try {{ localStorage.setItem('theme', {theme!r}) }} catch (e) {{}}"
            + violations_script()
        )
        page, watched = watch(context)
        errors: list[str] = []
        violated: list[str] = []
        page.on("console", lambda m, e=errors: e.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda x, e=errors: e.append(str(x)))
        for route in routes:
            page.goto("about:blank")  # a full load each time, so every script starts fresh
            page.goto(bundle_file.resolve().as_uri() + "#" + route)
            page.locator("main h1").wait_for()
            assert page.evaluate("() => document.documentElement.dataset.theme") == theme
            if until:
                page.wait_for_function(until, timeout=10000)
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(300)
            violated += page.evaluate("() => window.__csp")
        context.close()
        report[theme] = {
            "outside": outside(watched, bundle_file) + watched[1],
            "errors": errors,
            "violations": violated,
        }
    return report


@pytest.mark.browser
def test_every_route_in_every_theme_from_disk_makes_no_outside_request(browser, preview):
    report = tour(browser, preview)
    assert report == {theme: {"outside": [], "errors": [], "violations": []} for theme in THEMES}


@pytest.mark.browser
def test_the_tour_catches_a_fetch_planted_only_in_the_reactor_branch(browser, tmp_path):
    def mutate(dist):
        script = dist / "assets" / "site.js"
        source = script.read_text()
        marker = 'root.setAttribute("data-theme", theme);'
        assert marker in source
        script.write_text(
            source.replace(
                marker,
                marker + ' if (theme === "reactor") { fetch("https://planted.example/r"); }',
            )
        )

    dist = make_dist(tmp_path, mutate)
    planted = tmp_path / "planted.html"
    assert bundle.main(["--dist", str(dist), "--out", str(planted), "--commit", "abc1234"]) == 0
    try:
        report = tour(
            browser,
            planted,
            until=(
                "() => document.documentElement.dataset.theme !== 'reactor'"
                " || window.__csp.length > 0"
            ),
        )
    finally:
        planted.unlink()
    for theme in ("day", "night"):
        assert report[theme] == {"outside": [], "errors": [], "violations": []}, theme
    caught = report["reactor"]
    assert "connect-src" in caught["violations"], "the policy reports the blocked fetch"
    assert any("planted.example" in e for e in caught["errors"])


@pytest.mark.browser
def test_to_top_works_under_the_hash_policy(browser, preview):
    context = browser.new_context(viewport={"width": 1280, "height": 500}, reduced_motion="reduce")
    context.add_init_script(violations_script())
    page = context.new_page()
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(preview.resolve().as_uri() + "#/about/")
    page.locator("main h1").wait_for()
    page.evaluate("() => window.scrollTo(0, document.documentElement.scrollHeight)")
    page.wait_for_function("() => document.getElementById('to-top').classList.contains('on')")
    page.locator("#to-top").click()
    page.wait_for_function("() => window.scrollY === 0")
    assert page.evaluate("() => window.__csp") == []
    assert errors == []
    context.close()


def test_out_inside_the_source_tree_or_the_build_is_refused(built, tmp_path, capsys):
    src_page = bundle.ROOT / "src" / "index.html"
    before = src_page.read_bytes() if src_page.exists() else None
    for out in (src_page, bundle.ROOT / "README.md", built / "index.html"):
        assert bundle.main(["--dist", str(built), "--out", str(out), "--commit", "abc1234"]) == 2
    assert "refusing --out" in capsys.readouterr().err
    assert (src_page.read_bytes() if src_page.exists() else None) == before


def test_out_inside_dist_preview_is_allowed_in_the_repository():
    assert (
        bundle.refuse_out(
            bundle.ROOT / "dist" / "preview" / "index.html", bundle.ROOT / "dist" / "site"
        )
        is None
    )


def test_an_existing_file_is_replaced_only_when_it_is_a_previous_bundle(built, tmp_path):
    other = tmp_path / "notes.html"
    other.write_text("<p>mine</p>", encoding="utf-8")
    assert bundle.main(["--dist", str(built), "--out", str(other), "--commit", "abc1234"]) == 2
    assert other.read_text(encoding="utf-8") == "<p>mine</p>"
    assert bundle.main(["--dist", str(built), "--out", str(tmp_path), "--commit", "abc1234"]) == 2
    out = tmp_path / "again.html"
    for _ in range(2):
        assert bundle.main(["--dist", str(built), "--out", str(out), "--commit", "abc1234"]) == 0


# --- one resolver for every URL a page or a stylesheet names ------------------------------


def relative_assets(dist):
    """The /about/ page names its assets relative to itself, as a browser and the link
    checker accept: a stylesheet and a script beside it, one a level up, an image that
    only a stylesheet names, and a query and a fragment on each."""
    (dist / "about" / "img").mkdir()
    (dist / "about" / "img" / "dot.png").write_bytes((dist / "favicon.png").read_bytes())
    (dist / "about" / "extra.css").write_text(
        '.rel-probe { color: rgb(1, 2, 3); background-image: url("img/dot.png?v=2#x"); }\n'
    )
    (dist / "assets" / "up.css").write_text(".up-probe { color: rgb(4, 5, 6); }\n")
    (dist / "about" / "extra.js").write_text("window.__extra = (window.__extra || 0) + 1;\n")
    (dist / "about" / "body.js").write_text("window.__body = (window.__body || 0) + 1;\n")
    page = dist / "about" / "index.html"
    text = page.read_text()
    text = text.replace(
        "</head>",
        '<link rel="stylesheet" href="extra.css?v=1#top">'
        '<link href="../assets/up.css?v=3" rel="stylesheet">'
        '<script src="./extra.js?v=1"></script></head>',
    )
    text = text.replace(
        "</main>",
        '<p class="rel-probe">r</p><p class="up-probe">u</p>'
        '<img id="up-img" alt="" src="../favicon.png?v=1#frag"></main>',
    )
    text = text.replace("</body>", '<script src="body.js?v=1"></script></body>')
    page.write_text(text)


def build_with(tmp_path, mutate):
    dist = make_dist(tmp_path, mutate)
    out = tmp_path / "o.html"
    code = bundle.main(["--dist", str(dist), "--out", str(out), "--commit", "abc1234"])
    assert code == 0
    return out


def test_relative_head_and_body_assets_are_inlined_on_a_nested_page(tmp_path):
    result = build_with(tmp_path, relative_assets).read_text()
    assert ".rel-probe" in result and ".up-probe" in result
    assert "window.__extra" in result
    assert 'data-page-script="/about/body.js"' in result
    assert 'data-scripts="/assets/site.js /about/body.js"' in result
    assert bundle.external_requests(result) == []
    assert "extra.css" not in result and "../favicon.png" not in result


@pytest.mark.browser
def test_relative_assets_apply_and_run_in_the_browser(browser, tmp_path):
    out = build_with(tmp_path, relative_assets)
    context = browser.new_context()
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(out.resolve().as_uri() + "#/about/")
    page.wait_for_selector(".rel-probe")
    assert (
        page.evaluate("() => getComputedStyle(document.querySelector('.rel-probe')).color")
        == "rgb(1, 2, 3)"
    )
    assert page.evaluate(
        "() => getComputedStyle(document.querySelector('.rel-probe')).backgroundImage"
    ).startswith('url("data:image/png;base64,')
    assert (
        page.evaluate("() => getComputedStyle(document.querySelector('.up-probe')).color")
        == "rgb(4, 5, 6)"
    )
    assert page.evaluate("() => window.__extra") == 1
    assert page.evaluate("() => window.__body") == 1
    page.wait_for_function(
        "() => { const i = document.getElementById('up-img');"
        " return i.complete && i.naturalWidth > 0 }"
    )
    assert page.evaluate("() => document.getElementById('up-img').naturalWidth") > 0
    context.close()
    assert errors == []


def plant_decoys(tmp_path, dist=None):
    """Files where a resolver that clamps ``..`` at the root (as ``urljoin`` and a browser
    do) would land: beside the site, and (with ``dist``) inside it at the root. A refusal
    that merely happens because the file is absent would pass without proving the rule."""
    for base in (tmp_path, dist):
        if base is not None:
            for name in ("outside.css", "outside.js", "outside.png"):
                (base / name).write_bytes(b"x")


@pytest.mark.parametrize(
    ("mutate_page", "message"),
    [
        (
            lambda t: t.replace(
                "</head>", '<link rel="stylesheet" href="../../outside.css"></head>'
            ),
            "climbs out",
        ),
        (
            lambda t: t.replace("</head>", '<script src="../../outside.js"></script></head>'),
            "climbs out",
        ),
        (
            lambda t: t.replace("</main>", '<img alt="" src="../../outside.png"></main>'),
            "climbs out",
        ),
        (
            lambda t: t.replace(
                "</main>", '<p style="background:url(../../outside.png)">x</p></main>'
            ),
            "climbs out",
        ),
        (
            lambda t: t.replace("</main>", '<img alt="" src="%2e%2e/%2e%2e/outside.png"></main>'),
            "climbs out",
        ),
        (
            lambda t: t.replace("</main>", '<img alt="" src="..%2f..%2foutside.png"></main>'),
            "separator",
        ),
    ],
)
def test_a_reference_that_climbs_out_of_the_site_is_refused(tmp_path, mutate_page, message):
    plant_decoys(tmp_path)

    def mutate(dist):
        plant_decoys(tmp_path, dist)
        page = dist / "about" / "index.html"
        page.write_text(mutate_page(page.read_text()))

    with pytest.raises(SystemExit) as refused:
        build_with(tmp_path, mutate)
    assert message in str(refused.value)


def test_a_stylesheet_that_climbs_out_of_the_site_is_refused(tmp_path):
    plant_decoys(tmp_path)

    def mutate(dist):
        plant_decoys(tmp_path, dist)
        (dist / "assets" / "site.css").write_text(".x { background: url(../../outside.png); }")

    with pytest.raises(SystemExit) as refused:
        build_with(tmp_path, mutate)
    assert "climbs out" in str(refused.value)


def test_a_script_with_a_space_in_its_name_runs_in_the_bundle_text(tmp_path):
    def mutate(dist):
        spaced(dist)

    result = build_with(tmp_path, mutate).read_text()
    assert 'data-page-script="/assets/my%20app.js"' in result
    assert 'data-scripts="/assets/site.js /assets/my%20app.js"' in result
    assert "/assets/my app.js" not in result


def spaced(dist):
    (dist / "assets" / "my app.js").write_text("window.__spaced = (window.__spaced || 0) + 1;\n")
    page = dist / "about" / "index.html"
    page.write_text(
        page.read_text().replace("</body>", '<script src="/assets/my%20app.js"></script></body>')
    )


@pytest.mark.browser
def test_a_script_named_with_a_space_runs_in_the_browser(browser, tmp_path):
    out = build_with(tmp_path, spaced)
    context = browser.new_context()
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(out.resolve().as_uri() + "#/about/")
    page.wait_for_function("() => window.__spaced === 1")
    context.close()
    assert errors == []


@pytest.mark.browser
def test_the_router_reports_a_listed_script_that_is_missing(browser, tmp_path):
    out = build_with(tmp_path, spaced)
    broken = out.read_text().replace(
        'data-scripts="/assets/site.js /assets/my%20app.js"',
        'data-scripts="/assets/site.js /assets/my%20app.js /assets/gone.js"',
    )
    assert broken != out.read_text()
    # The policy hashes cover the script text, not this attribute, so the edit is allowed.
    out.write_text(broken)
    context = browser.new_context()
    page = context.new_page()
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(out.resolve().as_uri() + "#/about/")
    page.wait_for_function("() => window.__spaced === 1")
    context.close()
    assert any("/assets/gone.js" in e and "not in the bundle" in e for e in errors), errors


def test_the_resolver_reads_a_url_against_the_page_that_holds_it(built, tmp_path):
    resolve = bundle.resolve
    base_cases = {
        ("/", "assets/site.css"): "/assets/site.css",
        ("/about/", "../assets/site.css?v=1#a"): "/assets/site.css",
        ("/about/", "/assets/site.css"): "/assets/site.css",
        ("/about/", "../assets/./site.css"): "/assets/site.css",
        ("/assets/site.css", "theme.js"): "/assets/theme.js",
        ("/about/index.html", "../favicon.png"): "/favicon.png",
    }
    for (base, ref), url in base_cases.items():
        assert resolve(built, base, ref)[0] == url, (base, ref)
        assert resolve(built, base, ref)[1].is_file()
    for base, ref in [("/", "../x"), ("/about/", "../../x"), ("/assets/site.css", "../../x")]:
        with pytest.raises(SystemExit, match="climbs out"):
            resolve(built, base, ref)
    with pytest.raises(SystemExit, match="climbs out"):
        resolve(built, "/about/", "/../x")
    # Decoys at the site root of a copy, where a clamping resolver would land.
    copy = tmp_path / "copy"
    shutil.copytree(built, copy)
    for name in ("x", "a.png"):
        (copy / name).write_bytes(b"x")
    for base, ref in [("/", "../x"), ("/about/", "../../a.png"), ("/about/", "/../x")]:
        with pytest.raises(SystemExit, match="climbs out"):
            resolve(copy, base, ref)
    for base, ref, message in [
        ("/about/", "https://example.org/a.png", "not a local URL"),
        ("/about/", "//example.org/a.png", "not a local URL"),
        ("/about/", "..\\..\\x", "separator"),
        ("/about/", "nope.png", "no such file"),
    ]:
        with pytest.raises(SystemExit, match=message):
            resolve(built, base, ref)


def test_a_symlink_out_of_the_build_is_refused(tmp_path):
    outside = tmp_path / "secret.txt"
    outside.write_text("s")
    (tmp_path / "site").mkdir()
    (tmp_path / "site" / "link.txt").symlink_to(outside)
    with pytest.raises(SystemExit, match="no such file"):
        bundle.resolve(tmp_path / "site", "/", "link.txt")


@pytest.mark.parametrize(
    "rule",
    [
        '@import "extra.css";',
        "@import 'extra.css';",
        '@IMPORT url("extra.css");',
        "@import url(extra.css) screen;",
        '@import "extra.css" layer(base);',
    ],
)
def test_an_import_fails_the_bundle_naming_the_file(tmp_path, rule):
    def mutate(dist):
        (dist / "assets" / "extra.css").write_text("a{color:red}")
        site = dist / "assets" / "site.css"
        site.write_text(f"\n{rule}\n" + site.read_text())

    dist = make_dist(tmp_path, mutate)
    with pytest.raises(SystemExit) as error:
        bundle.main(["--dist", str(dist), "--out", str(tmp_path / "o.html")])
    assert "assets/site.css:2" in str(error.value) and "@import" in str(error.value)
    assert not (tmp_path / "o.html").exists()


def test_the_shared_helper_reads_urls_in_any_case_and_quoting():
    site_refs = load_script("site_refs")
    text = "a{b:URL( 'x.png' )}c{d:url(\"y.png\")}e{f:url(z.png)}/* url(no.png) */"
    assert site_refs.css_urls(text) == ["x.png", "y.png", "z.png"]


@pytest.mark.browser
def test_a_self_closing_svg_tag_stays_a_sibling_in_the_browser(browser, tmp_path):
    snippet = (
        '<svg id="s" width="9" height="9"><rect style="fill:url(/favicon.png)"/>'
        '<circle r="3"/></svg><math id="m"><mi style="background:url(/favicon.png)"/>'
        "<mn>1</mn></math>"
    )
    code, out = bundled(tmp_path, snippet)
    assert code == 0
    context = browser.new_context()
    page = context.new_page()
    page.goto(out.resolve().as_uri())
    assert page.evaluate("() => document.querySelector('#s circle').parentElement.id") == "s"
    assert page.evaluate("() => document.querySelector('#m mn').parentElement.id") == "m"
    context.close()


@pytest.mark.browser
def test_a_page_only_stylesheet_applies_on_that_route_and_not_on_the_others(browser, tmp_path):
    bundle_file = about_only_bundle(tmp_path)
    context = browser.new_context(viewport={"width": 1280, "height": 800})
    page = context.new_page()
    violated: list[str] = []
    page.add_init_script(violations_script())
    background = "() => getComputedStyle(document.body).backgroundColor"
    base = bundle_file.resolve().as_uri()
    for route, expected in [
        ("/about/", True),
        ("/", False),
        ("/404.html", False),
        ("/about/", True),
    ]:
        page.goto("about:blank")
        page.goto(base + "#" + route)
        page.locator("main h1").wait_for()
        assert (page.evaluate(background) == "rgb(1, 2, 3)") is expected, route
        violated += page.evaluate("() => window.__csp")
    # and moving between routes in one load swaps it too
    page.goto(base + "#/about/")
    page.locator("main h1").wait_for()
    about = page.locator("main h1").inner_text()
    page.evaluate("() => { location.hash = '#/' }")
    # The route swaps on the hashchange event, a later task than the assignment.
    page.wait_for_function("(t) => document.querySelector('main h1').textContent !== t", arg=about)
    assert page.evaluate(background) != "rgb(1, 2, 3)"
    assert violated == []
    context.close()


# --- head scripts belong to the route that names them -------------------------------------

HEAD_TAG = '<script src="/assets/theme.js"></script>'


def head_script_dist(dist):
    """A script only the about page names, one every page names, both in ``<head>``."""
    (dist / "assets" / "about-head.js").write_text(
        "(window.__aboutRuns = window.__aboutRuns || []).push(location.hash);\n"
    )
    (dist / "assets" / "shared-head.js").write_text(
        "window.__sharedRuns = (window.__sharedRuns || 0) + 1;\n"
    )
    for page in dist.rglob("*.html"):
        text = page.read_text()
        assert HEAD_TAG in text
        extra = '<script src="/assets/shared-head.js"></script>'
        if page.parent.name == "about":
            extra += '<script src="/assets/about-head.js"></script>'
        page.write_text(text.replace(HEAD_TAG, HEAD_TAG + extra))


def route_attr(result: str, route: str, attr: str) -> list[str]:
    tag = re.search(r'<template data-route="' + re.escape(route) + r'"[^>]*>', result)
    assert tag, route
    found = re.search(r"\b" + attr + r'="([^"]*)"', tag.group(0))
    return found.group(1).split() if found else []


def test_each_route_lists_the_head_scripts_its_own_page_names(tmp_path):
    result = build_with(tmp_path, head_script_dist).read_text()
    assert route_attr(result, "/about/", "data-head-scripts") == [
        "/assets/theme.js",
        "/assets/shared-head.js",
        "/assets/about-head.js",
    ]
    for route in ("/", "/404.html"):
        assert route_attr(result, route, "data-head-scripts") == [
            "/assets/theme.js",
            "/assets/shared-head.js",
        ], route
    # each source is stored once, whichever routes name it
    assert result.count('data-page-script="/assets/shared-head.js"') == 1


@pytest.mark.browser
def test_a_head_script_runs_with_its_own_route_each_time_it_is_shown(browser, tmp_path):
    out = build_with(tmp_path, head_script_dist)
    context = browser.new_context()
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    base = out.resolve().as_uri()
    runs = "() => window.__aboutRuns || []"
    shared = "() => window.__sharedRuns"

    def go(route: str, h1: str) -> None:
        page.evaluate(f"() => {{ location.hash = '#{route}' }}")
        page.wait_for_function(
            f"() => (document.querySelector('main h1')?.textContent || '').startsWith({h1!r})"
        )

    page.goto(base + "#/")
    page.locator("main h1").wait_for()
    assert page.evaluate(runs) == []  # the about page's script is not run on another route
    assert page.evaluate(shared) == 1
    go("/about/", "About")
    assert page.evaluate(runs) == ["#/about/"]
    assert page.evaluate(shared) == 2
    go("/404.html", "Not found")
    assert page.evaluate(runs) == ["#/about/"]  # not run again for another route
    assert page.evaluate(shared) == 3
    go("/about/", "About")
    assert page.evaluate(runs) == ["#/about/", "#/about/"]  # again when navigated back to
    assert page.evaluate(shared) == 4
    # opened straight on the route that owns it
    page.goto("about:blank")
    page.goto(base + "#/about/")
    page.locator("main h1").wait_for()
    assert page.evaluate(runs) == ["#/about/"]
    context.close()
    assert errors == []


# --- explicit index links are routes too ---------------------------------------------------

PROBES = {
    "/": [
        ("about/index.html", "#/about/"),
        ("./about/index.html#team", "#/about/#team"),
        ("/about/index.html?x=1", "#/about/"),
        ("/about", "#/about/"),
        ("/index.html", "#/"),
        ("index.html#top", "#/#top"),
        ("/404.html", "#/404.html"),
        ("/about/", "#/about/"),
        ("/assets/site.css", "/assets/site.css"),  # not a page: left alone
        ("/nope/index.html", "/nope/index.html"),  # dead: the size check's business
    ],
    "/about/": [
        ("index.html", "#/about/"),
        ("../about/index.html", "#/about/"),
        ("../index.html#top", "#/#top"),
        ("../", "#/"),
        ("/about/index.html#a-b", "#/about/#a-b"),
    ],
}


def probe_links(dist):
    for page in dist.rglob("*.html"):
        route = {"index.html": "/", "about/index.html": "/about/"}.get(
            page.relative_to(dist).as_posix()
        )
        if route is None:
            continue
        links = "".join(f'<a class="probe" href="{raw}">p</a>' for raw, _ in PROBES[route])
        page.write_text(page.read_text().replace("</main>", links + "</main>", 1))


@pytest.mark.parametrize("route", sorted(PROBES))
def test_explicit_index_links_become_the_pages_hash_route(tmp_path, route):
    result = build_with(tmp_path, probe_links).read_text()
    template = re.search(
        r'<template data-route="' + re.escape(route) + r'".*?</template>', result, re.S
    )
    assert template
    found = re.findall(r'class="probe" href="([^"]*)"', template.group(0))
    assert found == [expected for _, expected in PROBES[route]]


# --- DOMContentLoaded runs once per route shown --------------------------------------------


def dom_ready_dist(dist):
    """A head script on every page and one on the about page only, both init on DOMContentLoaded."""
    (dist / "assets" / "ready.js").write_text(
        "document.addEventListener('DOMContentLoaded', function () {\n"
        "  var main = document.querySelector('main');\n"
        "  main.setAttribute('data-ready', String(Number(main.getAttribute('data-ready')) + 1));\n"
        "  (window.__ready = window.__ready || []).push(location.hash);\n"
        "});\n"
    )
    (dist / "assets" / "about-ready.js").write_text(
        "window.addEventListener('DOMContentLoaded', function () {\n"
        "  (window.__aboutReady = window.__aboutReady || []).push(location.hash);\n"
        "});\n"
    )
    for page in dist.rglob("*.html"):
        extra = '<script src="/assets/ready.js"></script>'
        if page.parent.name == "about":
            extra += '<script src="/assets/about-ready.js"></script>'
        page.write_text(page.read_text().replace(HEAD_TAG, HEAD_TAG + extra))


@pytest.mark.browser
def test_a_dom_content_loaded_handler_runs_once_on_every_route_shown(browser, tmp_path):
    out = build_with(tmp_path, dom_ready_dist)
    context = browser.new_context()
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    ready = "() => window.__ready || []"
    about = "() => window.__aboutReady || []"
    mark = "() => document.querySelector('main').getAttribute('data-ready')"

    def go(route: str, h1: str) -> None:
        page.evaluate(f"() => {{ location.hash = '#{route}' }}")
        page.wait_for_function(
            f"() => (document.querySelector('main h1')?.textContent || '').startsWith({h1!r})"
        )

    page.goto(out.resolve().as_uri() + "#/")
    page.locator("main h1").wait_for()
    page.wait_for_function("() => document.readyState !== 'loading'")
    assert page.evaluate(ready) == ["#/"]  # the real event, once
    assert page.evaluate(mark) == "1"
    go("/about/", "About")
    assert page.evaluate(ready) == ["#/", "#/about/"]
    assert page.evaluate(mark) == "1"  # the new content, marked once
    assert page.evaluate(about) == ["#/about/"]
    go("/404.html", "Not found")
    assert page.evaluate(ready) == ["#/", "#/about/", "#/404.html"]
    assert page.evaluate(mark) == "1"
    assert page.evaluate(about) == ["#/about/"]  # the previous route's handler is gone
    go("/about/", "About")
    assert page.evaluate(ready) == ["#/", "#/about/", "#/404.html", "#/about/"]
    assert page.evaluate(about) == ["#/about/", "#/about/"]
    context.close()
    assert errors == []


def test_scripts_with_identical_text_are_listed_once_in_the_policy(tmp_path):
    def mutate(dist):
        (dist / "assets" / "one.js").write_text("window.__same = 1;\n")
        (dist / "assets" / "two.js").write_text("window.__same = 1;\n")
        for page in dist.rglob("*.html"):
            page.write_text(
                page.read_text().replace(
                    HEAD_TAG,
                    HEAD_TAG + '<script src="/assets/one.js"></script>'
                    '<script src="/assets/two.js"></script>',
                )
            )

    result = build_with(tmp_path, mutate).read_text()
    assert 'data-page-script="/assets/one.js"' in result
    assert 'data-page-script="/assets/two.js"' in result
    sources = policy_of(result).split("script-src ")[1].split(";")[0].split()
    assert len(sources) == len(set(sources))
    assert sources.count(digest("window.__same = 1;\n")) == 1


# --- text that would close the element it is embedded in -----------------------------------

RAW_SHEET = (
    '.after::after { content: "</style>"; }\n'
    "/* </STYLE> in a comment */\n"
    "body { background: rgb(1, 2, 3) !important; }\n"
)


def raw_text_dist(tmp_path):
    def mutate(dist):
        (dist / "assets" / "raw.css").write_text(RAW_SHEET)
        (dist / "assets" / "raw.js").write_text(
            "window.__raw = '</script>' + '</SCRIPT x' + /<\\/script/.source;\n"
        )
        about = dist / "about" / "index.html"
        text = about.read_text()
        about.write_text(
            text.replace(
                SITE_LINK, SITE_LINK + '<link rel="stylesheet" href="/assets/raw.css">', 1
            ).replace("</body>", '<script src="/assets/raw.js"></script></body>', 1)
        )

    return make_dist(tmp_path, mutate)


def test_css_and_script_text_cannot_close_the_element_that_carries_it(tmp_path):
    out = tmp_path / "o.html"
    dist = raw_text_dist(tmp_path)
    assert bundle.main(["--dist", str(dist), "--out", str(out), "--commit", "abc1234"]) == 0
    result = out.read_text()
    assert result.count("</style>") == result.count("<style>")
    assert result.count("</script>") == result.count("<script")
    css = "".join(route_css(result, "/about/"))
    assert 'content: "<\\/style>"' in css and "<\\/STYLE>" in css
    shell = bundle.parse_html(result)
    assert any("rgb(1, 2, 3)" in s.text for s in shell.styles if s.block)


@pytest.mark.browser
def test_a_stylesheet_that_mentions_the_closing_tag_renders_and_passes_the_policy(
    browser, tmp_path
):
    out = tmp_path / "o.html"
    dist = raw_text_dist(tmp_path)
    assert bundle.main(["--dist", str(dist), "--out", str(out), "--commit", "abc1234"]) == 0
    context = browser.new_context()
    context.add_init_script(violations_script())
    page = context.new_page()
    page.goto(out.resolve().as_uri() + "#/about/")
    page.wait_for_selector("main")
    assert page.evaluate("() => getComputedStyle(document.body).backgroundColor") == "rgb(1, 2, 3)"
    assert page.evaluate("() => window.__raw") == "</script></SCRIPT x<\\/script"
    assert page.evaluate("() => window.__csp") == []
    context.close()


# --- forms: the preview policy has form-action 'none', production has form-action 'self' ---


def form_dist(tmp_path, form: str):
    """The site with ``form`` added to the front page."""

    def mutate(dist):
        index = dist / "index.html"
        index.write_text(index.read_text().replace("</main>", form + "</main>", 1))

    return make_dist(tmp_path, mutate)


def bundle_text(tmp_path, form: str) -> str:
    out = tmp_path / "o.html"
    assert bundle.main(["--dist", str(form_dist(tmp_path, form)), "--out", str(out)]) == 0
    return out.read_text(encoding="utf-8")


GET_FORM = (
    '<form id="go" action="/about/"><label>Q <input name="q" value="x"></label>'
    '<button type="submit">Go</button></form>'
)


@pytest.mark.parametrize(
    ("form", "route"),
    [
        (GET_FORM, "#/about/"),
        (
            GET_FORM.replace('action="/about/"', 'action="/about/index.html" method="GET"'),
            "#/about/",
        ),
        (GET_FORM.replace('action="/about/"', 'action="about/#design"'), "#/about/#design"),
        (GET_FORM.replace('action="/about/"', 'action="/"'), "#/"),
        (GET_FORM.replace('action="/about/"', ""), "#/"),  # no action: the page itself
        (GET_FORM.replace('action="/about/"', 'action=""'), "#/"),
        (GET_FORM.replace('action="/about/"', 'method="bogus" action="/about/"'), "#/about/"),
    ],
)
def test_a_local_get_form_targets_the_hash_route_of_its_page(tmp_path, form, route):
    result = bundle_text(tmp_path, form)
    assert re.search(rf"<form[^>]*\baction=\"{re.escape(route)}\"", result), result[-600:]


def test_a_dialog_form_is_left_alone(tmp_path):
    form = '<form method="dialog" action="/about/"><button>Close</button></form>'
    assert 'method="dialog" action="/about/"' in bundle_text(tmp_path, form)


@pytest.mark.parametrize(
    ("form", "needle"),
    [
        ('<form id="s" method="post" action="/about/"><button>Go</button></form>', "POST"),
        ('<form id="s" method="POST" action="/api/"><button>Go</button></form>', "POST"),
        ('<form id="s" action="/gone/"><button>Go</button></form>', "/gone/"),
        ('<form id="s" action="/assets/site.css"><button>Go</button></form>', "not a page"),
        (
            '<form id="s" action="/about/"><button formaction="/about/">Go</button></form>',
            "formaction",
        ),
    ],
)
def test_a_form_a_static_site_cannot_handle_fails_the_bundle_naming_page_and_form(
    tmp_path, form, needle, capsys
):
    with pytest.raises(SystemExit) as stop:
        bundle.main(["--dist", str(form_dist(tmp_path, form)), "--out", str(tmp_path / "o.html")])
    message = str(stop.value)
    assert needle in message
    assert "form" in message
    assert "index.html:" in message or "page /:" in message, "it names the page"


def test_a_remote_form_action_still_fails_the_bundle(tmp_path):
    form = '<form action="https://example.com/s"><button>Go</button></form>'
    with pytest.raises(SystemExit):
        bundle.main(["--dist", str(form_dist(tmp_path, form)), "--out", str(tmp_path / "o.html")])


def test_the_preview_policy_still_forbids_every_form_submission(tmp_path):
    result = bundle_text(tmp_path, GET_FORM)
    assert "form-action 'none'" in policy_of(result)


@pytest.mark.browser
def test_a_get_form_to_another_page_lands_on_its_route_without_a_policy_violation(
    browser, tmp_path
):
    out = tmp_path / "o.html"
    assert bundle.main(["--dist", str(form_dist(tmp_path, GET_FORM)), "--out", str(out)]) == 0
    page = browser.new_page()
    problems: list[str] = []
    page.on("console", lambda m: problems.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: problems.append(str(e)))
    page.goto(out.resolve().as_uri())
    page.wait_for_selector("#go")
    page.click("#go button")
    page.wait_for_function("() => location.hash === '#/about/'")
    page.wait_for_function(
        "() => document.querySelector('main h1').textContent === 'About Release Orbit'"
    )
    assert page.locator("main h1").inner_text().strip()
    assert "About Release Orbit" in page.content()
    page.close()
    assert problems == []


def test_every_data_file_is_embedded_as_a_seed_a_page_reads_instead_of_fetching(text, built):
    seeds = dict(
        re.findall(
            r'<script type="application/json" data-seed="([^"]+)">(.*?)</script>', text, re.S
        )
    )
    files = sorted((built / "data").glob("*.json"))
    assert files, "the build ships data files"
    assert sorted(seeds) == [f"/data/{path.name}" for path in files]
    for path in files:
        body = seeds[f"/data/{path.name}"]
        assert "<" not in body, "a '<' could close the block early"
        # The < escape is plain JSON, so the seed parses back to the file's own data.
        assert json.loads(body) == json.loads(path.read_text(encoding="utf-8"))


def test_the_head_alternate_is_not_carried_and_the_feed_link_is_not_left_relative(text):
    # The head is rebuilt from the front page's icons alone, so a <link rel=alternate> never
    # reaches the file; the timeline's Subscribe link is a body link, rewritten to the
    # production origin, so no root-relative copy of it remains.
    assert not re.search(r"<link[^>]*rel=\"alternate\"", text)
    assert 'class="chip-link" href="/api/feed.atom"' not in text
    assert bundle.external_requests(text) == []


def test_the_bundled_subscribe_link_is_absolute_and_the_live_build_keeps_it_relative(text, built):
    # A root-relative /api/ link would resolve against whatever host (or file://) opens the
    # bundle, so the bundle points at the production origin; the live page is unchanged.
    href = "https://orbit.szolotov.com/api/feed.atom"
    assert text.count(f'class="chip-link" href="{href}"') == 1
    live = (built / "timeline" / "index.html").read_text(encoding="utf-8")
    assert 'class="chip-link" href="/api/feed.atom"' in live
