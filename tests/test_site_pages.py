"""The Release Orbit pages in a real browser: data, filters, compare, the toast, motion.

Release data is mocked where a test needs a particular answer (the Worker's route is
intercepted); otherwise the page reads the snapshot through the local server, which answers
/api/releases.json the way the Worker does. Reduced motion is on unless a test is about
motion, so what is read is the settled state.
"""

from __future__ import annotations

import copy
import json
import os
import re

import pytest
from helpers import REPO

pytestmark = pytest.mark.browser

try:
    import playwright.sync_api  # noqa: F401
except ImportError:
    if os.environ.get("REQUIRE_BROWSER") == "1":
        raise
    pytest.skip("playwright is not installed", allow_module_level=True)

SNAPSHOT = json.loads((REPO / "src" / "data" / "releases.json").read_text(encoding="utf-8"))
FAMILIES = ["iOS", "iPadOS", "macOS", "watchOS", "tvOS", "visionOS"]
RECORD = """
window.__csp = [];
document.addEventListener("securitypolicyviolation", (e) => {
  window.__csp.push(e.violatedDirective + " " + e.blockedURI);
});
"""


def releases(family: str, data=SNAPSHOT):
    return [r for r in data["releases"] if r["family"] == family]


def make_context(browser, base_url, width=1280, motion="reduce", theme=None):
    context = browser.new_context(viewport={"width": width, "height": 900}, reduced_motion=motion)
    context.add_init_script(RECORD)
    if theme:
        context.add_init_script(
            f"try {{ localStorage.setItem('theme', '{theme}') }} catch (e) {{}}"
        )
    context.route(
        re.compile("^(?!" + re.escape(base_url) + "/)"), lambda route: route.fulfill(body="")
    )
    return context


@pytest.fixture
def context(browser, base_url):
    made = make_context(browser, base_url)
    yield made
    made.close()


@pytest.fixture
def page(context):
    return context.new_page()


def serve_json(page, pattern, body, status=200, kind="application/json"):
    page.route(pattern, lambda route: route.fulfill(status=status, content_type=kind, body=body))


def cards_ready(page):
    page.wait_for_function(
        "() => document.querySelector('#latest-grid [data-family=iOS] [data-f=ver]')"
        ".textContent !== 'Loading…'"
    )


# --- the front page ---------------------------------------------------------------------


def test_the_cards_show_the_newest_release_of_each_family(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    for name in FAMILIES:
        newest = releases(name)[0]
        card = page.locator(f'#latest-grid [data-family="{name}"]')
        assert card.locator("[data-f=ver]").inner_text() == f"{name} {newest['version']}"
        assert newest["build"] in card.locator("[data-f=build]").inner_text()
        assert card.locator("[data-f=link]").get_attribute("href") == newest["url"]
    assert (
        page.locator("h1").inner_text().replace("\n", " ") == "Every OS release, as it lands."
    )


@pytest.mark.parametrize(
    ("status", "kind", "body"),
    [
        (404, "text/html", "<h1>Not found</h1>"),
        (500, "application/json", "{}"),
        (200, "text/html", "<html></html>"),
        (200, "application/json", "not json"),
    ],
    ids=["missing", "server error", "html answer", "broken json"],
)
def test_without_the_worker_the_page_falls_back_to_the_snapshot(page, base_url, status, kind, body):
    serve_json(page, "**/api/releases.json", body, status, kind)
    page.goto(base_url + "/")
    cards_ready(page)
    ver = page.locator("#latest-grid [data-family=iOS] [data-f=ver]")
    assert ver.inner_text().startswith("iOS ")
    assert page.get_attribute("#live", "data-state") == "snapshot"
    assert "not live" in page.inner_text("#live-text")


def test_the_live_indicator_says_live_or_stale(page, base_url):
    live = copy.deepcopy(SNAPSHOT) | {
        "snapshot": False,
        "stale": False,
        "fetchedAt": "2026-10-11T12:00:00Z",
    }
    serve_json(page, "**/api/releases.json", json.dumps(live))
    page.goto(base_url + "/")
    page.wait_for_function("() => document.getElementById('live').dataset.state === 'live'")
    assert "Oct 11, 2026" in page.inner_text("#live-text")
    live["stale"] = True
    page.unroute("**/api/releases.json")
    serve_json(page, "**/api/releases.json", json.dumps(live))
    page.goto(base_url + "/")
    page.wait_for_function("() => document.getElementById('live').dataset.state === 'stale'")
    assert "the source was unreachable" in page.inner_text("#live-text")


def test_the_page_drops_entries_it_cannot_show_safely(page, base_url):
    bad = copy.deepcopy(SNAPSHOT)
    first = bad["releases"][0]
    for name, change in {
        "x": {"url": "https://evil.example/x"},
        "y": {"family": "Xcode"},
        "z": {"vendor": "nobody"},
        "v": {"url": "http://developer.apple.com/x"},
        "u": {"url": "not a url"},
    }.items():
        bad["releases"].insert(0, {**first, "id": name, **change})
    serve_json(page, "**/api/releases.json", json.dumps(bad))
    page.goto(base_url + "/")
    cards_ready(page)
    assert page.locator("a[href*='evil.example']").count() == 0
    assert page.locator("#latest-grid [data-family=iOS] [data-f=ver]").inner_text() == "iOS 27.2"


def test_each_family_has_a_section_with_a_device_and_recent_releases(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    for name in FAMILIES:
        section = page.locator(f'section.fam[data-family="{name}"]')
        assert section.locator(".dev .screen").count() == 1
        assert 1 <= section.locator(".recent li").count() <= 5
        assert name in section.locator("[data-f=latest]").inner_text()
        assert section.locator("[data-f=name]").first.inner_text().startswith(name)
        link = f'#latest-grid [data-family="{name}"] a[href="#{name.lower()}"]'
        assert page.locator(link).count() == 1


def test_the_software_update_mock_reports_the_real_latest_release(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    page.click("[data-act=check]")
    page.wait_for_function(
        "() => document.querySelector('[data-f=result]').textContent.length > 20"
    )
    public = next(r for r in releases("iOS") if r["stage"] == "release")
    text = page.inner_text("[data-f=result]")
    assert public["version"] in text and public["build"] in text
    assert "newest beta is iOS 27.2 beta 3" in text
    assert page.get_attribute("[data-f=result]", "aria-live") == "polite"
    assert page.inner_text("[data-act=check]") == "Check Again"


def test_the_iphone_screen_fills_its_lower_half_from_the_data(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    rows = page.locator(".m-ios .m-rows")
    assert rows.get_attribute("aria-hidden") == "true"
    ios = releases("iOS")
    public = next(r for r in ios if r["stage"] == "release")
    assert rows.locator("[data-f=pubrow]").inner_text() == public["version"]
    beta = next((r for r in ios if r["stage"] != "release"), None)
    newer_beta = beta and beta["date"] > public["date"]
    assert (rows.locator("[data-f=betarow]").inner_text() != "Off") == bool(newer_beta)
    screen = page.locator(".m-ios").bounding_box()
    below = rows.bounding_box()
    assert below["y"] + below["height"] > screen["y"] + screen["height"] * 0.8
    assert below["y"] > screen["y"] + screen["height"] * 0.4


def test_the_about_this_mac_mock_switches_between_release_and_beta(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    public = next(r for r in releases("macOS") if r["stage"] == "release")
    beta = next(r for r in releases("macOS") if r["stage"] != "release")
    info = page.locator(".m-mac .m-info")
    assert public["build"] in info.inner_text()
    page.click("[data-ch=beta]")
    assert beta["build"] in info.inner_text()
    assert page.get_attribute("[data-ch=beta]", "aria-pressed") == "true"
    assert page.get_attribute("[data-ch=release]", "aria-pressed") == "false"


def test_the_watch_complication_cycles_version_build_and_date(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    newest = releases("watchOS")[0]
    seen = [page.text_content(".m-comp .k")]
    assert page.text_content(".m-comp .v") == newest["version"]
    for _ in range(2):
        page.click(".m-comp")
        seen.append(page.text_content(".m-comp .k"))
    assert seen == ["Version", "Build", "Released"]
    assert page.inner_text("[data-f=said]").startswith("Showing released")
    page.click(".m-comp")
    assert page.text_content(".m-comp .k") == "Version"


def test_mock_controls_are_real_buttons_and_big_enough(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    for selector in ("[data-act=check]", "[data-ch=release]", "[data-ch=beta]", ".m-comp"):
        size = page.locator(selector).bounding_box()
        assert size["width"] >= 44 and size["height"] >= 44, (selector, size)
        assert page.locator(selector).evaluate("e => e.tagName") == "BUTTON"


# --- the toast --------------------------------------------------------------------------


def test_a_toast_announces_releases_that_appear_while_the_page_is_open(browser, base_url):
    context = make_context(browser, base_url)
    try:
        page = context.new_page()
        page.clock.install()
        answers = {"count": 0}
        fresh = copy.deepcopy(SNAPSHOT)
        fresh["releases"].insert(
            0,
            {
                **fresh["releases"][0],
                "id": "https://developer.apple.com/news/releases/?id=new1",
                "title": "iOS 27.2 beta 4 (24B5105a)",
                "version": "27.2",
                "beta": 4,
                "build": "24B5105a",
                "date": "2026-10-12T17:00:00Z",
                "url": "https://developer.apple.com/news/releases/?id=new1",
            },
        )

        def answer(route):
            answers["count"] += 1
            body = SNAPSHOT if answers["count"] == 1 else fresh
            route.fulfill(content_type="application/json", body=json.dumps(body))

        page.route("**/api/releases.json", answer)
        page.goto(base_url + "/")
        cards_ready(page)
        assert page.get_attribute("#toast", "role") == "status"
        assert page.get_attribute("#toast", "aria-live") == "polite"
        assert "on" not in (page.get_attribute("#toast", "class") or "").split()
        page.clock.run_for(5 * 60 * 1000 + 1000)
        page.wait_for_function("() => document.getElementById('toast').classList.contains('on')")
        assert "iOS 27.2 beta 4" in page.inner_text("#toast")
        assert page.inner_text("#latest-grid [data-family=iOS] [data-f=stage]") == "Beta 4"
        page.click("#toast button")
        assert "on" not in page.get_attribute("#toast", "class").split()
        # The same data again is not news.
        page.clock.run_for(5 * 60 * 1000 + 1000)
        page.wait_for_timeout(200)
        assert "on" not in page.get_attribute("#toast", "class").split()
    finally:
        context.close()


# --- motion -----------------------------------------------------------------------------


def test_content_is_visible_and_still_without_motion(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
    state = page.evaluate(
        """() => [...document.querySelectorAll('.reveal, .aurora i')].map((el) => {
          const s = getComputedStyle(el);
          return { animation: s.animationName, pre: el.classList.contains('pre') };
        })"""
    )
    assert state and all(s["animation"] == "none" and not s["pre"] for s in state)
    assert page.evaluate("() => getComputedStyle(document.querySelector('.rel')).opacity") == "1"


def test_with_motion_allowed_everything_still_ends_up_visible(browser, base_url):
    context = make_context(browser, base_url, motion="no-preference")
    try:
        page = context.new_page()
        page.goto(base_url + "/")
        cards_ready(page)
        assert (
            page.evaluate(
                "() => getComputedStyle(document.querySelector('.aurora i')).animationName"
            )
            == "drift"
        )
        step = page.evaluate("() => innerHeight")
        for y in range(0, page.evaluate("() => document.body.scrollHeight"), step // 2):
            page.evaluate("y => window.scrollTo(0, y)", y)
            page.wait_for_timeout(30)
        page.wait_for_timeout(700)
        hidden = page.evaluate(
            "() => [...document.querySelectorAll('.reveal')]"
            ".filter(e => getComputedStyle(e).opacity !== '1').length"
        )
        assert hidden == 0
    finally:
        context.close()


def test_without_scroll_driven_animation_a_script_only_adds_classes(browser, base_url):
    context = make_context(browser, base_url, motion="no-preference")
    context.add_init_script(
        "const s = CSS.supports.bind(CSS); CSS.supports = (...a) => "
        "String(a[0]).includes('animation-timeline') ? false : s(...a);"
    )
    try:
        page = context.new_page()
        page.goto(base_url + "/")
        cards_ready(page)
        assert page.locator(".reveal.pre").count() > 0
        assert page.evaluate(
            "() => [...document.querySelectorAll('.reveal.pre')]"
            ".every(e => getComputedStyle(e).opacity === '0')"
        )
        page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_function("() => document.querySelectorAll('.reveal.pre:not(.in)').length < 3")
        for _ in range(12):
            page.mouse.wheel(0, -600)
            page.wait_for_timeout(50)
        page.wait_for_function(
            "() => document.querySelectorAll('.reveal.pre:not(.in)').length === 0"
        )
        page.wait_for_timeout(700)
        opacity = "() => getComputedStyle(document.querySelector('#ios .fam-copy')).opacity"
        assert page.evaluate(opacity) == "1"
    finally:
        context.close()


# --- developer highlights ---------------------------------------------------------------


def test_the_highlights_section_shows_with_sources_and_hides_when_empty(page, base_url):
    page.goto(base_url + "/")
    page.wait_for_selector("#features:not([hidden])")
    links = page.locator("#features a").evaluate_all("els => els.map(a => a.href)")
    assert links and all(href.startswith("https://developer.apple.com/") for href in links)
    empty = page.context.new_page()
    serve_json(empty, "**/data/features.json", "[]")
    empty.goto(base_url + "/")
    cards_ready(empty)
    empty.wait_for_timeout(300)
    assert empty.locator("#features").is_hidden()
