"""The data files, markup and scripts of the Release Orbit pages, checked as source."""

from __future__ import annotations

import json
import re

import pytest
from helpers import REPO

SRC = REPO / "src"
ASSETS = SRC / "assets"
CONFIG = json.loads((SRC / "data" / "families.json").read_text(encoding="utf-8"))
APPLE = [family["id"] for family in CONFIG["families"] if family["vendor"] == "apple"]
CSS = (ASSETS / "site.css").read_text(encoding="utf-8")
LEGAL = (
    "Independent site. Not affiliated with, endorsed by or sponsored by Apple Inc. Apple, "
    "iPhone, iPad, Mac, Apple Watch, Apple TV, Apple Vision Pro, iOS, iPadOS, macOS, watchOS, "
    "tvOS and visionOS are trademarks of Apple Inc."
)
SOURCE_URL = "https://developer.apple.com/news/releases/"


def page(path: str) -> str:
    return (SRC / path).read_text(encoding="utf-8")


def pages() -> list[str]:
    return sorted(p.relative_to(SRC).as_posix() for p in SRC.rglob("*.html"))


def test_the_snapshot_follows_the_data_contract():
    data = json.loads((SRC / "data" / "releases.json").read_text(encoding="utf-8"))
    assert data["source"] == "apple-developer-releases"
    ids = [r["id"] for r in data["releases"]]
    assert len(ids) == len(set(ids))
    dates = [r["date"] for r in data["releases"]]
    assert dates == sorted(dates, reverse=True)
    owner = {family["id"]: family["vendor"] for family in CONFIG["families"]}
    for r in data["releases"]:
        assert owner.get(r["family"]) == r["vendor"], r["id"]
        assert r["stage"] in {"release", "beta", "rc"}
        assert r["url"].startswith("https://developer.apple.com/")
        # A verdict is for a released build only: the dial would show it to everyone.
        assert "status" not in r or r["stage"] == "release", r["id"]


@pytest.mark.parametrize("path", pages())
def test_every_page_carries_the_notice_and_the_link_to_its_source(path):
    html = page(path)
    assert f'<p class="tag">{LEGAL}</p>' in html
    assert f'Source: <a href="{SOURCE_URL}"' in html
    assert "Apple Developer Releases" in html


@pytest.mark.parametrize("path", pages())
def test_every_page_is_titled_release_orbit_in_the_tags_that_name_it(path):
    html = page(path)
    title = re.search(r"<title>([^<]+)</title>", html).group(1)
    assert title == "Release Orbit" or title.endswith(" · Release Orbit")
    assert '<a id="home" href="/">Release Orbit</a>' in html
    assert '<p class="mark">Release Orbit</p>' in html
    for tag in ("og:title", "twitter:title"):
        found = re.search(rf'(?:property|name)="{tag}" content="([^"]*)"', html)
        assert found is None or found.group(1) == title, path
    site = re.search(r'property="og:site_name" content="([^"]*)"', html)
    assert site is None or site.group(1) == "Release Orbit", path


def test_the_front_page_has_one_card_per_family_in_the_order_of_the_config():
    html = page("index.html")
    cards = re.findall(r'<li class="rel fam-[a-z]+ reveal" data-family="([A-Za-z]+)"', html)
    assert cards == APPLE


# The effects are separate modules that load after the first paint; no page names them.
LAZY = ("fx.js", "aurora.js")
# Also off the first paint: below.js (the mock screens and the developer highlights) and the
# cadence row, which home.js loads once the page has painted, and the generic sigil rule
# (sigil.js loads it when a build that is not an Apple build appears). The script that loads
# each one is the only file that names it.
AFTER_PAINT = {"below.js": "home.js", "cadence.js": "home.js", "sigil-generic.js": "sigil.js"}
FIRST_PAINT_BUDGET = 60_000
LAZY_BUDGET = 16_000
AFTER_PAINT_BUDGET = 16_000


@pytest.mark.parametrize("name", [p for p in pages() if p != "404.html"])
def test_the_scripts_a_page_loads_stay_under_the_first_paint_budget(name):
    loaded = re.findall(r'<script src="/assets/([a-z.-]+\.js)"', page(name))
    assert loaded, name
    assert not set(LAZY) & set(loaded), "the effects load after first paint, not from the page"
    assert not set(AFTER_PAINT) & set(loaded), "these load after first paint, not from the page"
    total = sum((ASSETS / script).stat().st_size for script in loaded)
    assert total < FIRST_PAINT_BUDGET, (name, total)


def test_the_lazily_loaded_effects_stay_small_and_are_only_loaded_by_the_scripts():
    total = sum((ASSETS / name).stat().st_size for name in LAZY)
    assert total < LAZY_BUDGET, total
    named = [
        script.name
        for script in ASSETS.glob("*.js")
        if any(f"/assets/{name}" in script.read_text(encoding="utf-8") for name in LAZY)
    ]
    assert named == ["home.js"]


def test_the_scripts_loaded_after_the_first_paint_are_named_only_by_their_loader():
    assert sum((ASSETS / name).stat().st_size for name in AFTER_PAINT) < AFTER_PAINT_BUDGET
    for name, loader in AFTER_PAINT.items():
        named = [
            script.name
            for script in ASSETS.glob("*.js")
            if f"/assets/{name}" in script.read_text(encoding="utf-8")
        ]
        assert named == [loader], name


@pytest.mark.parametrize("script", sorted(ASSETS.glob("*.js")), ids=lambda p: p.name)
def test_scripts_never_write_markup_or_style_attributes(script):
    text = script.read_text(encoding="utf-8")
    for banned in (
        "innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "document.write",
        "eval(",
        "cssText",
        'setAttribute("style"',
        "setAttribute('style'",
    ):
        assert banned not in text, banned


def test_the_view_transition_and_scroll_driven_rules_sit_inside_no_preference_motion():
    stripped = re.sub(r"/\*.*?\*/", "", CSS, flags=re.DOTALL)
    for needle in ("@view-transition", "animation-timeline"):
        assert needle in stripped
        for match in re.finditer(re.escape(needle), stripped):
            before = stripped[: match.start()]
            opens = [m.start() for m in re.finditer(r"@media[^{]*\{", before)]
            assert opens, needle
            last = opens[-1]
            depth = before[last:].count("{") - before[last:].count("}")
            assert depth >= 1, f"{needle} is outside its @media block"
            assert "prefers-reduced-motion: no-preference" in before[last:].split("{", 1)[0]


def motion_block() -> str:
    """The ``@media (prefers-reduced-motion: no-preference)`` block under the Motion comment."""
    start = CSS.index("/* Motion: only transform and opacity move")
    open_at = CSS.index("{", start)
    depth = 0
    for at in range(open_at, len(CSS)):
        depth += {"{": 1, "}": -1}.get(CSS[at], 0)
        if depth == 0:
            return CSS[open_at : at + 1]
    raise AssertionError("the motion block is not closed")


def test_the_motion_block_only_transitions_transform_and_opacity():
    for rule in re.findall(r"transition:\s*([^;]+);", motion_block()):
        properties = {part.split()[0] for part in re.split(r",\s*", rule.strip())}
        assert properties <= {"transform", "translate", "opacity", "visibility"}, rule


@pytest.mark.parametrize("name", ["cmp-card", "stat", "feat", "chip", "chip-link"])
def test_the_console_theme_squares_the_cards_of_the_later_pages(name):
    selector = f'html[data-theme="reactor"] .{name}'
    bare = re.sub(r"/\*.*?\*/", "", CSS, flags=re.S)
    squared = [
        match.group(1)
        for match in re.finditer(r"([^{}]+)\{\s*border-radius: 0;\s*\}", bare)
        if selector in [part.strip() for part in match.group(1).split(",")]
    ]
    assert squared, f"{selector} is not squared"


def test_the_front_page_has_one_section_per_family_in_the_order_of_the_config():
    html = page("index.html")
    found = re.findall(
        r'<section id="([a-z]+)" class="fam fam-[a-z]+(?: fam-flip)?" data-family="([A-Za-z]+)"',
        html,
    )
    assert [family for _, family in found] == APPLE
    for anchor, family in found:
        assert anchor == family.lower()
        assert f'<a href="#{anchor}">{family}</a>' in html


def test_the_mock_buttons_do_not_animate_their_colour():
    rule = re.search(r"\.m-btn, \.m-segb, \.m-comp \{ transition: ([^;]+);", CSS)
    assert rule and "color" not in rule.group(1)


def test_every_feature_is_a_short_summary_that_names_a_developer_apple_com_page():
    items = json.loads((SRC / "data" / "features.json").read_text(encoding="utf-8"))
    assert isinstance(items, list) and items
    for item in items:
        assert set(item) == {"vendor", "family", "major", "title", "summary", "source"}
        assert item["vendor"] == "apple" and item["family"] in APPLE
        assert isinstance(item["major"], int)
        assert 0 < len(item["title"]) <= 60, item
        assert 0 < len(item["summary"]) <= 100, item
        assert re.fullmatch(r"https://developer\.apple\.com/[a-z0-9/._-]*", item["source"]), item


def test_the_timeline_offers_all_and_each_family_in_the_order_of_the_config():
    html = page("timeline/index.html")
    block = re.search(r'id="chips-family">(.*?)</div>', html, re.DOTALL).group(1)
    assert re.findall(r'data-v="([A-Za-z]+)"', block) == ["all", *APPLE]
    stages = re.search(r'id="chips-stage">(.*?)</div>', html, re.DOTALL).group(1)
    assert re.findall(r'data-v="([a-z]+)"', stages) == ["all", "release", "beta", "rc"]


def test_the_compare_page_offers_each_family_in_the_order_of_the_config():
    html = page("compare/index.html")
    block = re.search(r'<select id="c-family">(.*?)</select>', html, re.DOTALL).group(1)
    assert re.findall(r'<option value="([A-Za-z]+)">\1</option>', block) == APPLE
