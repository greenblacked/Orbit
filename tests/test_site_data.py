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


def test_the_scripts_stay_small():
    total = sum(path.stat().st_size for path in ASSETS.glob("*.js"))
    assert total < 48_000, total


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
