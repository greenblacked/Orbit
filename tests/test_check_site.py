"""check_site: broken local links, missing fragments and the size budget."""

from __future__ import annotations

import pytest
from helpers import REPO, load_script

check = load_script("check_site")
build = load_script("build_site")
site_refs = load_script("site_refs")


def make_site(tmp_path, pages: dict[str, str], extra: dict[str, bytes] | None = None):
    root = tmp_path / "site"
    for name, body in pages.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    for name, data in (extra or {}).items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return root


def test_the_real_site_has_no_broken_links_and_is_within_budget(tmp_path):
    out = tmp_path / "site"
    build.build(REPO / "src", out, "v1")
    assert check.check_links(out) == []
    assert check.check_budget(out, check.PAGE_BUDGET, check.IMAGE_BUDGET) == []
    assert check.main([str(out)]) == 0


def test_a_broken_link_a_broken_asset_and_a_bad_fragment_are_each_reported(tmp_path):
    root = make_site(
        tmp_path,
        {
            "index.html": (
                '<a href="/gone/">x</a><img src="/missing.png" alt=""><a href="/about/#nope">y</a>'
                '<a href="#nowhere">z</a><a href="about/">fine</a><a id="here"></a>'
                '<a href="#here">ok</a><a href="https://example.com/">ext</a>'
                '<a href="mailto:a@b.c">m</a>'
            ),
            "about/index.html": '<h1 id="top">About</h1><a href="../">up</a>',
        },
    )
    problems = check.check_links(root)
    assert len(problems) == 4, problems
    joined = "\n".join(problems)
    assert "/gone/" in joined
    assert "/missing.png" in joined
    assert "#nope" in joined
    assert "#nowhere" in joined


def test_a_link_cannot_escape_the_site(tmp_path):
    root = make_site(tmp_path, {"index.html": '<a href="/../../etc/passwd">x</a>'})
    assert check.check_links(root)


@pytest.mark.parametrize(
    ("page", "ref", "message"),
    [
        ("index.html", "../x.png", "climbs out"),
        ("about/index.html", "../../x.png", "climbs out"),
        ("about/index.html", "/../x.png", "climbs out"),
        ("about/index.html", "%2e%2e/%2e%2e/x.png", "climbs out"),
        ("about/index.html", "..%2f..%2fx.png", "separator"),
    ],
)
def test_a_reference_that_climbs_above_the_root_is_refused_though_a_browser_clamps_it(
    tmp_path, page, ref, message
):
    # The decoy sits where a clamping resolver would land, so only the rule stops it.
    root = make_site(
        tmp_path,
        {"index.html": "<h1>Home</h1>", "about/index.html": "<h1>About</h1>"},
        {"x.png": b"x"},
    )
    path = root / page
    path.write_text(path.read_text() + f'<img src="{ref}" alt="">')
    problems = check.check_links(root)
    assert len(problems) == 1, problems
    assert message in problems[0] and ref in problems[0]


def test_a_reference_that_stays_inside_the_root_is_still_accepted(tmp_path):
    root = make_site(
        tmp_path,
        {
            "index.html": "<h1>Home</h1>",
            "about/index.html": '<a href="../">up</a><img src="../x.png" alt="">',
        },
        {"x.png": b"x"},
    )
    assert check.check_links(root) == []


def test_a_directory_link_needs_an_index(tmp_path):
    root = make_site(
        tmp_path,
        {"index.html": '<a href="/docs/">x</a><a href="/docs">y</a>'},
        {"docs/readme.txt": b"hi"},
    )
    assert len(check.check_links(root)) == 2


def test_an_image_over_the_budget_is_reported(tmp_path):
    root = make_site(tmp_path, {"index.html": "<p>x</p>"}, {"big.png": b"0" * 300})
    assert check.check_budget(root, 10_000, 200) != []
    assert check.check_budget(root, 10_000, 400) == []


def test_a_page_counts_what_it_loads_once_and_not_its_icons(tmp_path):
    page = (
        '<link rel="stylesheet" href="/a.css"><link rel="icon" href="/i.png">'
        '<script src="/a.js"></script><img src="/p.png" alt=""><img src="/p.png" alt="">'
    )
    root = make_site(
        tmp_path,
        {"index.html": page},
        {"a.css": b"c" * 100, "a.js": b"j" * 100, "p.png": b"p" * 100, "i.png": b"i" * 5000},
    )
    weight = len(page) + 300
    assert check.check_budget(root, weight, 10_000) == []
    assert check.check_budget(root, weight - 1, 10_000) != []


def test_preloaded_images_count_toward_the_page_budget(tmp_path):
    page = "".join(f'<link rel="preload" as="image" href="/{n}.png">' for n in ("a", "b", "c"))
    extra = {f"{n}.png": b"x" * 190_000 for n in ("a", "b", "c")}
    root = make_site(tmp_path, {"index.html": page}, extra)
    assert check.check_budget(root, check.PAGE_BUDGET, check.IMAGE_BUDGET) != []
    assert check.check_budget(root, len(page) + 570_000, check.IMAGE_BUDGET) == []


@pytest.mark.parametrize("rel", ["modulepreload", "PreLoad", "manifest", "stylesheet preload"])
def test_every_fetching_link_relation_is_weighed(tmp_path, rel):
    page = f'<link rel="{rel}" href="/f.bin">'
    root = make_site(tmp_path, {"index.html": page}, {"f.bin": b"x" * 1000})
    assert check.check_budget(root, len(page) + 999, 10_000) != []


@pytest.mark.parametrize(
    "rel", ["canonical", "alternate", "author", "prefetch", "prerender", "preconnect", "next"]
)
def test_metadata_and_hint_link_relations_are_not_weighed(tmp_path, rel):
    page = f'<link rel="{rel}" href="/f.txt">'
    root = make_site(tmp_path, {"index.html": page}, {"f.txt": b"x" * 1000})
    assert check.check_budget(root, len(page), 10_000) == []


@pytest.mark.parametrize("flag", ["--page-budget", "--image-budget"])
def test_the_cli_fails_when_a_budget_is_exceeded(tmp_path, flag, capsys):
    out = tmp_path / "site"
    build.build(REPO / "src", out, "v1")
    assert check.main([str(out), flag, "10"]) == 1
    assert "budget" in capsys.readouterr().err


def test_the_cli_reports_a_missing_build(tmp_path):
    assert check.main([str(tmp_path / "nope")]) == 2


def test_a_relative_root_works_the_way_the_cli_is_run(tmp_path, monkeypatch):
    out = tmp_path / "dist" / "site"
    build.build(REPO / "src", out, "v1")
    monkeypatch.chdir(tmp_path)
    assert check.main(["dist/site"]) == 0
    assert check.main([]) == 0  # the default is dist/site


def test_css_background_images_count_toward_the_page_budget(tmp_path):
    page = '<link rel="stylesheet" href="/s.css">'
    css = "".join(f".b{i}{{background:url(/img{i}.png)}}" for i in range(3))
    images = {f"img{i}.png": b"p" * 190_000 for i in range(3)}
    root = make_site(tmp_path, {"index.html": page}, {"s.css": css.encode(), **images})
    problems = check.check_budget(root, check.PAGE_BUDGET, 200_000)
    assert len(problems) == 1 and "index.html weighs" in problems[0], problems
    assert check.main([str(root)]) == 1


def test_a_css_dependency_is_counted_once_per_page_whatever_the_spelling(tmp_path):
    page = '<link rel="stylesheet" href="/s.css"><style>a{background:URL( "/p.png" )}</style>'
    css = "a{background:url(p.png)}b{background:url('/p.png?v=2#x')}c{background:url(data:x)}"
    root = make_site(tmp_path, {"index.html": page}, {"s.css": css.encode(), "p.png": b"p" * 100})
    weight = len(page) + len(css) + 100
    assert check.check_budget(root, weight, 10_000) == []
    assert check.check_budget(root, weight - 1, 10_000) != []


def test_a_stylesheet_in_a_directory_reads_its_urls_against_itself(tmp_path):
    root = make_site(
        tmp_path,
        {"index.html": '<link rel="stylesheet" href="/assets/s.css">'},
        {"assets/s.css": b"a{background:url(../img/p.png)}", "img/p.png": b"p" * 500},
    )
    assert check.check_budget(root, 570, 10_000) != []
    assert check.check_css(root) == []


@pytest.mark.parametrize("ref", ["../../x.png", "/../x.png", "missing.png"])
def test_a_css_url_that_climbs_or_misses_is_refused(tmp_path, ref):
    root = make_site(
        tmp_path,
        {"index.html": '<link rel="stylesheet" href="/s.css">'},
        {"s.css": f"a{{background:url({ref})}}".encode(), "x.png": b"x"},
    )
    problems = check.check_css(root)
    assert len(problems) == 1 and "s.css" in problems[0] and ref in problems[0], problems
    assert check.main([str(root)]) == 1


@pytest.mark.parametrize(
    "rule",
    [
        '@import "extra.css";',
        "@import 'extra.css';",
        '@IMPORT url("extra.css");',
        "@import url(extra.css) screen and (min-width: 40em);",
        '@import "extra.css" layer(base) supports(display: grid);',
        "@import\n  'extra.css';",
    ],
)
def test_an_import_fails_the_check_naming_the_file_and_line(tmp_path, rule, capsys):
    root = make_site(
        tmp_path,
        {"index.html": '<link rel="stylesheet" href="/assets/s.css">'},
        {"assets/s.css": f"/* c */\n{rule}\na{{color:red}}".encode(), "assets/extra.css": b""},
    )
    problems = check.check_css(root)
    assert len(problems) == 1 and problems[0].startswith("assets/s.css:2:"), problems
    assert check.main([str(root)]) == 1
    assert "assets/s.css:2" in capsys.readouterr().err


def test_an_import_in_a_style_block_or_attribute_fails_and_a_comment_does_not(tmp_path):
    root = make_site(
        tmp_path,
        {
            "index.html": '<style>@import "x.css";</style>',
            "b.html": '<p style="@import url(x.css)">x</p>',
            "c.html": "<style>/* @import 'x.css'; */ a{color:red}</style>",
        },
    )
    joined = "\n".join(check.check_css(root))
    assert "index.html" in joined and "b.html" in joined and "c.html" not in joined


def test_the_generated_site_passes_the_css_check(tmp_path):
    out = tmp_path / "site"
    build.build(REPO / "src", out, "v1")
    assert check.check_css(out) == []


FORM_PAGE = "<main>{}</main>"


@pytest.mark.parametrize(
    "form",
    [
        '<form method="post" action="/about/"><button>Go</button></form>',
        '<form method="POST"><button>Go</button></form>',
        '<form action="/about/"><button formmethod="post">Go</button></form>',
    ],
)
def test_a_post_form_is_refused_because_the_site_has_no_handler(tmp_path, form):
    root = make_site(
        tmp_path,
        {"index.html": FORM_PAGE.format(form), "about/index.html": "<h1>About</h1>"},
    )
    problems = check.check_policy(root)
    assert len(problems) == 1, problems
    assert "index.html:1" in problems[0]
    assert "POST" in problems[0]


@pytest.mark.parametrize(
    "form",
    [
        '<form action="/about/"><button>Go</button></form>',
        '<form method="get" action="/about/"><button>Go</button></form>',
        '<form method="dialog"><button>Close</button></form>',
        '<form method="nonsense"><button>Go</button></form>',
    ],
)
def test_a_get_or_dialog_form_is_accepted(tmp_path, form):
    root = make_site(
        tmp_path,
        {"index.html": FORM_PAGE.format(form), "about/index.html": "<h1>About</h1>"},
    )
    assert check.check_policy(root) == []
    assert check.check_links(root) == []


def test_a_feed_link_under_the_workers_prefix_is_not_looked_up_in_the_build(tmp_path):
    page = (
        '<link rel="alternate" type="application/atom+xml" href="/api/feed.atom">'
        '<a href="/api/feed.json?family=iOS">json</a><a href="/api/feed.atom#x">atom</a>'
    )
    root = make_site(tmp_path, {"index.html": page})
    assert check.check_links(root) == []
    assert check.main([str(root)]) == 0


def test_a_url_that_stays_under_the_workers_prefix_after_normalising_is_exempt(tmp_path):
    page = '<a href="/api/feed.atom">a</a><a href="/api/x/../feed.atom">b</a>'
    root = make_site(tmp_path, {"index.html": page})
    assert check.check_links(root) == []


@pytest.mark.parametrize("href", ["/api/../gone/", "/api/%2e%2e/gone/", "/api/%2E%2E/gone/"])
def test_a_dot_segment_that_leaves_the_workers_prefix_is_looked_up_in_the_build(tmp_path, href):
    root = make_site(tmp_path, {"index.html": f'<a href="{href}">x</a>'})
    assert check.check_links(root)


@pytest.mark.parametrize(
    "page",
    [
        '<link rel="stylesheet" href="/api/x.css">',
        '<img src="/api/x.png" alt="">',
        '<a href="/apix/feed.atom">x</a>',
        '<a href="api/feed.atom">x</a>',
    ],
)
def test_only_navigation_is_exempt_under_the_workers_prefix(tmp_path, page):
    root = make_site(tmp_path, {"index.html": page})
    assert check.check_links(root)


@pytest.mark.parametrize("url", ["//evil/api/x", "https://e/api/x", "http://e/api/x"])
def test_a_url_naming_another_origin_is_not_a_worker_path(url):
    assert not site_refs.is_worker_path(url)
    assert site_refs.is_worker_path("/api/feed.atom")
