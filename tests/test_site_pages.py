"""The Release Orbit pages in a real browser: data, filters, compare, the toast, motion.

Release data is mocked where a test needs a particular answer (the Worker's route is
intercepted); otherwise the page reads the snapshot through the local server, which answers
/api/releases.json the way the Worker does. Reduced motion is on unless a test is about
motion, so what is read is the settled state.
"""

from __future__ import annotations

import copy
import datetime
import json
import os
import re
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urlsplit

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
AUDIT = (Path(__file__).parent / "audit.js").read_text(encoding="utf-8")
FAMILIES = ["iOS", "iPadOS", "macOS", "watchOS", "tvOS", "visionOS"]
# A family with no release in the data says so. Every shipped family has snapshot rows now, so the
# test serves the data without the rows of these.
WAITING = ["SteamOS"]
# The newest Apple row: tests that forge an Apple release copy this one, not the newest row.
APPLE_FIRST = next(r for r in SNAPSHOT["releases"] if r["vendor"] == "apple")
LEGAL = (
    "Independent site. Not affiliated with, endorsed by or sponsored by Apple Inc., MikroTik, "
    "Google LLC, Microsoft Corporation or Valve Corporation. Apple, iPhone, iPad, Mac, Apple "
    "Watch, Apple TV, Apple Vision Pro, iOS, iPadOS, macOS, watchOS, tvOS and visionOS are "
    "trademarks of Apple Inc. MikroTik and RouterOS are trademarks of MikroTik. Android is a "
    "trademark of Google LLC. Windows is a trademark of the Microsoft group of companies. "
    "Steam, Steam Deck and SteamOS are trademarks and/or registered trademarks of Valve "
    "Corporation."
)
PAGES = ["/", "/timeline/", "/compare/", "/about/"]
RECORD = """
window.__csp = [];
document.addEventListener("securitypolicyviolation", (e) => {
  window.__csp.push(e.violatedDirective + " " + e.blockedURI);
});
"""


def releases(family: str, data=SNAPSHOT):
    return [r for r in data["releases"] if r["family"] == family]


def make_context(browser, base_url, width=1280, motion="reduce", theme=None, script=True):
    context = browser.new_context(
        viewport={"width": width, "height": 900},
        reduced_motion=motion,
        java_script_enabled=script,
    )
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


def mocks_ready(page):
    """The mock screens are painted by below.js, which loads once the page has painted."""
    page.wait_for_function("() => document.querySelector('[data-f=pubrow]').textContent !== ''")


# --- the front page ---------------------------------------------------------------------


def test_the_cards_show_the_newest_release_of_each_family(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    for name in FAMILIES:
        newest = next(r for r in releases(name) if r["stage"] == "release")
        card = page.locator(f'#latest-grid [data-family="{name}"]')
        assert card.locator("[data-f=ver]").inner_text() == f"{name} {newest['version']}"
        assert newest["build"] in card.locator("[data-f=build]").inner_text()
        assert card.locator("[data-f=link]").get_attribute("href") == newest["url"]
    assert page.locator("h1").inner_text().replace("\n", " ") == "Every OS release, as it lands."


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


def test_the_page_drops_entries_it_cannot_show_safely(page, base_url):
    bad = copy.deepcopy(SNAPSHOT)
    first = APPLE_FIRST
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
    assert page.locator("#latest-grid [data-family=iOS] [data-f=ver]").inner_text() == "iOS 27.0.1"


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


def test_windows_shows_the_newest_servicing_version_from_its_snapshot_rows(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    card = page.locator('#latest-grid [data-family="Windows"]')
    assert card.locator("[data-f=ver]").inner_text() == "Windows 26H2"
    link = card.locator("[data-f=link]")
    assert link.get_attribute("href") == "https://support.microsoft.com/help/5124010"


def test_a_family_without_a_release_says_so_instead_of_inventing_one(page, base_url):
    data = copy.deepcopy(SNAPSHOT)
    data["releases"] = [r for r in data["releases"] if r["family"] not in WAITING]
    serve_json(page, "**/api/releases.json", json.dumps(data))
    page.goto(base_url + "/")
    cards_ready(page)
    for name in WAITING:
        card = page.locator(f'#latest-grid [data-family="{name}"]')
        assert card.locator("[data-f=ver]").inner_text() == "No release yet"
        assert card.locator("[data-f=link]").is_hidden()
        section = page.locator(f'section.fam[data-family="{name}"]')
        assert section.locator(".dev .screen").count() == 1
        assert section.locator(".recent li").count() == 0
        assert section.locator("[data-f=name]").first.inner_text() == name
        assert f"No {name} release" in section.locator("[data-f=latest]").inner_text()


def test_the_routeros_card_and_section_show_the_snapshot_releases(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    card = page.locator('#latest-grid [data-family="RouterOS"]')
    assert card.locator("[data-f=ver]").inner_text() == "RouterOS 7.24.5"
    assert card.locator("[data-f=link]").is_visible()
    assert card.locator("[data-f=link]").get_attribute("href") == (
        "https://mikrotik.com/download?v=7.24.5"
    )
    section = page.locator('section.fam[data-family="RouterOS"]')
    recent = section.locator(".recent li")
    assert recent.count() == len(releases("RouterOS")) == 3
    assert "7.23.8" in recent.first.inner_text()
    listed = section.locator(".recent").inner_text()
    assert "7.25" in listed and "RC 1" in listed and "7.25rc1" in listed
    assert page.locator("#newest .fam-routeros .n-ver").text_content() == "7.24.5"
    assert "RouterOS 7.24.5" in section.locator("[data-f=latest]").inner_text()
    assert "Next: 7.25 rc 1" in section.locator("[data-f=latest]").inner_text()
    pre = card.locator("[data-f=pre] a")
    assert pre.inner_text().startswith("Next: 7.25 rc 1")
    assert pre.get_attribute("href") == "https://mikrotik.com/download?v=7.25rc1"
    assert pre.get_attribute("target") == "_blank"
    assert pre.get_attribute("rel") == "noopener noreferrer"
    assert pre.locator(".sr-only").text_content() == " (opens in a new tab)"


def test_the_newest_release_is_the_highest_version_not_the_latest_date(page, base_url):
    ios = [r for r in SNAPSHOT["releases"] if r["family"] == "iOS" and r["stage"] == "release"]
    old_branch = copy.deepcopy(ios[0]) | {
        "id": "ios-18.7.9-test",
        "version": "18.7.9",
        "major": 18,
        "title": "iOS 18.7.9",
        "build": "22H999",
        "date": "2099-01-01T00:00:00Z",
    }
    new_major = copy.deepcopy(ios[0]) | {
        "id": "ios-26.1-test",
        "version": "26.1",
        "major": 26,
        "title": "iOS 26.1",
        "build": "23B100",
        "date": "2098-12-01T00:00:00Z",
    }
    live = copy.deepcopy(SNAPSHOT) | {"snapshot": False, "stale": False}
    live["releases"] = (
        [r for r in live["releases"] if r["family"] not in ("iOS", "RouterOS")]
        + [old_branch, new_major]
        + releases("RouterOS")
    )
    page.route(
        "**/api/releases.json",
        lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps(live)
        ),
    )
    page.goto(base_url + "/")
    cards_ready(page)
    assert page.inner_text("#latest-grid [data-family=iOS] [data-f=ver]") == "iOS 26.1"
    # Every card headlines the newest stable by version: not the dated 7.23.8 or the 7.25 RC.
    assert page.inner_text("#latest-grid [data-family=RouterOS] [data-f=ver]") == "RouterOS 7.24.5"
    section = page.locator('section.fam[data-family="RouterOS"]')
    assert "RouterOS 7.24.5" in section.locator("[data-f=latest]").inner_text()


def test_android_shows_its_snapshot_releases_with_a_link_to_the_aosp_page(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    card = page.locator('#latest-grid [data-family="Android"]')
    assert "Android 17" in card.locator("[data-f=ver]").inner_text()
    link = card.locator("[data-f=link]")
    assert link.is_visible()
    assert link.get_attribute("href").startswith("https://source.android.com/")
    section = page.locator('section.fam[data-family="Android"]')
    # The snapshot holds the whole recorded history; the section lists the newest five.
    assert len(releases("Android")) > 5
    assert section.locator(".recent li").count() == 5
    assert "17.0.0" in section.locator(".recent").inner_text()


def test_steamos_shows_its_snapshot_releases_with_a_link_to_the_news_page(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    card = page.locator('#latest-grid [data-family="SteamOS"]')
    assert card.locator("[data-f=ver]").inner_text() == "SteamOS 3.8.28"
    link = card.locator("[data-f=link]")
    assert link.is_visible()
    assert link.get_attribute("href") == "https://store.steampowered.com/news/app/1675200"
    section = page.locator('section.fam[data-family="SteamOS"]')
    recent = section.locator(".recent li")
    assert len(releases("SteamOS")) > 5
    assert recent.count() == 5
    assert "3.8.28" in section.locator(".recent").inner_text()


def test_the_data_check_mock_reports_the_real_latest_release(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    mocks_ready(page)
    page.click("[data-act=check]")
    public = next(r for r in releases("iOS") if r["stage"] == "release")
    page.wait_for_function(
        "b => document.querySelector('[data-f=result]').textContent.includes(b)",
        arg=public["build"],
    )
    text = page.inner_text("[data-f=result]")
    assert public["version"] in text and public["build"] in text
    assert "newest beta is iOS 27.2 beta 3" in text
    assert page.get_attribute("[data-f=result]", "aria-live") == "polite"
    assert page.inner_text("[data-act=check]") == "Check again"


def test_the_mock_screens_and_highlights_wait_for_their_script_and_then_paint(page, base_url):
    held = []
    page.route("**/assets/below.js", lambda route: held.append(route))
    with page.expect_request("**/assets/below.js"):
        page.goto(base_url + "/")
    cards_ready(page)
    for _ in range(200):
        if held:
            break
        page.wait_for_timeout(50)
    assert held, "below.js was never requested"
    assert page.inner_text("[data-f=pubrow]") == ""
    assert page.inner_text("[data-f=betarow]") == ""
    assert page.locator("#features").is_hidden()
    # Nothing on the mock screens is the section's data, and nothing on them works yet.
    mac = page.locator(".m-mac")
    assert mac.locator("[data-f=name]").inner_text() == "macOS"
    for field in ("version", "build", "date"):
        assert mac.locator(f"[data-f={field}]").inner_text() == ""
    for button in ("[data-ch=release]", "[data-ch=beta]", "[data-act=check]", "[data-act=cycle]"):
        assert page.locator(button).is_disabled(), button
    assert page.inner_text(".m-ios [data-f=name]") == "iOS"
    held[0].continue_()
    mocks_ready(page)
    page.wait_for_selector("#features:not([hidden])")
    page.click("[data-ch=beta]")
    assert page.get_attribute("[data-ch=beta]", "aria-pressed") == "true"


def test_the_iphone_screen_fills_its_lower_half_from_the_data(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    mocks_ready(page)
    rows = page.locator(".m-ios .m-rows")
    assert rows.get_attribute("aria-hidden") == "true"
    ios = releases("iOS")
    public = next(r for r in ios if r["stage"] == "release")
    assert rows.locator("[data-f=pubrow]").inner_text() == public["version"]
    beta = next((r for r in ios if r["stage"] != "release"), None)
    newer_beta = beta and beta["date"] > public["date"]
    assert (rows.locator("[data-f=betarow]").inner_text() != "None") == bool(newer_beta)
    screen = page.locator(".m-ios").bounding_box()
    below = rows.bounding_box()
    assert below["y"] + below["height"] > screen["y"] + screen["height"] * 0.8
    assert below["y"] > screen["y"] + screen["height"] * 0.4


def version_key(row):
    return tuple(int(x) for x in row["version"].split("."))


def test_the_about_this_mac_mock_switches_between_release_and_beta(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    mocks_ready(page)
    mac = releases("macOS")
    public = next(r for r in mac if r["stage"] == "release")
    pre = [r for r in mac if r["stage"] != "release"]
    beta = max(pre, key=version_key)
    # The snapshot has a beta newer than the release; the "no beta" case has its own test.
    assert version_key(beta) > version_key(public) and beta["date"] > public["date"]
    info = page.locator(".m-mac .m-info")
    assert public["build"] in info.inner_text()
    assert page.inner_text("[data-f=betanote]") == ""
    assert page.get_attribute("[data-ch=beta]", "aria-disabled") == "false"
    page.click("[data-ch=beta]")
    assert beta["build"] in info.inner_text()
    assert page.get_attribute("[data-ch=beta]", "aria-pressed") == "true"
    assert page.get_attribute("[data-ch=release]", "aria-pressed") == "false"


@pytest.mark.parametrize("width", [1280, 360], ids=["desktop", "phone"])
def test_the_about_this_mac_mock_turns_the_beta_off_when_no_beta_is_newer(browser, base_url, width):
    data = copy.deepcopy(SNAPSHOT)
    old = next(r for r in data["releases"] if r["family"] == "macOS" and r["stage"] != "release")
    old_build = old["build"]
    old.update(
        id="https://developer.apple.com/news/releases/?id=09012026a",
        url="https://developer.apple.com/news/releases/?id=09012026a",
        version="27.0",
        beta=1,
        build="26A5000a",
        date="2026-09-01T17:00:00Z",
        title="macOS 27.0 beta 1 (26A5000a)",
    )
    context = make_context(browser, base_url, width=width)
    try:
        page = context.new_page()
        serve_json(page, "**/api/releases.json", json.dumps(data))
        page.goto(base_url + "/")
        cards_ready(page)
        mocks_ready(page)
        public = next(r for r in releases("macOS", data) if r["stage"] == "release")
        beta = page.locator("[data-ch=beta]")
        assert beta.is_disabled()
        assert beta.get_attribute("aria-disabled") == "true"
        assert beta.get_attribute("aria-describedby") == "mac-betanote"
        assert page.inner_text("[data-f=betanote]") == "No newer beta"
        assert page.get_attribute("[data-ch=release]", "aria-pressed") == "true"
        info = page.locator(".m-mac .m-info").inner_text()
        assert public["build"] in info
        assert old_build not in info and "26A5000a" not in info
        assert beta.bounding_box()["height"] >= 44
        mac = page.locator(".m-mac").bounding_box()
        note = page.locator("[data-f=betanote]").bounding_box()
        assert note["y"] >= mac["y"] and note["x"] >= mac["x"]
        assert note["y"] + note["height"] <= mac["y"] + mac["height"]
        assert note["x"] + note["width"] <= mac["x"] + mac["width"]
    finally:
        context.close()


def test_the_empty_mac_note_takes_no_space(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    mocks_ready(page)
    assert page.inner_text("[data-f=betanote]") == ""
    assert page.eval_on_selector("[data-f=betanote]", "e => getComputedStyle(e).display") == "none"


def test_the_watch_complication_cycles_version_build_and_date(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)
    mocks_ready(page)
    newest = next(r for r in releases("watchOS") if r["stage"] == "release")
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
    mocks_ready(page)
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
        fresh = fresh_snapshot()

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
        ios = "#latest-grid [data-family=iOS]"
        assert page.inner_text(f"{ios} [data-f=stage]") == "Release"
        assert page.inner_text(f"{ios} [data-f=pre] a").startswith("Next: 27.2 beta 4")
        page.click("#toast button")
        assert "on" not in page.get_attribute("#toast", "class").split()
        # The same data again is not news.
        # Wait for the third poll's answer itself; the short pause then lets the page read it.
        with page.expect_response("**/api/releases.json"):
            page.clock.run_for(5 * 60 * 1000 + 1000)
        page.wait_for_timeout(200)
        assert "on" not in page.get_attribute("#toast", "class").split()
    finally:
        context.close()


NEW_ID = "https://developer.apple.com/news/releases/?id=new1"


def fresh_snapshot(count=1):
    """The snapshot with `count` new Apple releases in front; the first has NEW_ID."""
    fresh = copy.deepcopy(SNAPSHOT)
    for n in range(count):
        release_id = NEW_ID if n == 0 else f"{NEW_ID}-{n}"
        fresh["releases"].insert(
            n,
            {
                **APPLE_FIRST,
                "id": release_id,
                "title": f"iOS 27.{2 + n} beta {4 - n} (24B5105a)",
                "version": f"27.{2 + n}",
                "beta": 4 - n,
                "build": "24B5105a",
                "date": "2026-10-12T17:00:00Z",
                "url": release_id,
            },
        )
    return fresh


def toast_page(browser, base_url, width=1280, count=1):
    """A page whose second poll brings `count` new releases; the clock is faked."""
    context = make_context(browser, base_url, width=width)
    page = context.new_page()
    page.clock.install()
    fresh = fresh_snapshot(count)
    answers = {"count": 0}

    def answer(route):
        answers["count"] += 1
        body = SNAPSHOT if answers["count"] == 1 else fresh
        route.fulfill(content_type="application/json", body=json.dumps(body))

    page.route("**/api/releases.json", answer)
    page.goto(base_url + "/")
    cards_ready(page)
    return context, page


def show_toast(page):
    page.clock.run_for(5 * 60 * 1000 + 1000)
    page.wait_for_function("() => document.getElementById('toast').classList.contains('on')")


def toast_on(page):
    return "on" in page.get_attribute("#toast", "class").split()


def test_the_toast_stays_while_it_has_focus_and_then_hides_after_12_seconds(browser, base_url):
    context, page = toast_page(browser, base_url)
    try:
        show_toast(page)
        page.focus("#toast .toast-close")
        page.clock.run_for(30 * 1000)
        assert toast_on(page)
        assert page.evaluate("document.activeElement.className") == "toast-close"
        page.evaluate("document.activeElement.blur()")
        page.clock.run_for(1)
        page.clock.run_for(11 * 1000)
        assert toast_on(page)
        page.clock.run_for(2 * 1000)
        assert not toast_on(page)
    finally:
        context.close()


def test_the_toast_stays_while_the_pointer_is_over_it(browser, base_url):
    context, page = toast_page(browser, base_url)
    try:
        show_toast(page)
        page.hover("#toast .toast-close")
        page.clock.run_for(30 * 1000)
        assert toast_on(page)
        page.mouse.move(2, 2)
        page.clock.run_for(11 * 1000)
        assert toast_on(page)
        page.clock.run_for(2 * 1000)
        assert not toast_on(page)
    finally:
        context.close()


def test_hiding_the_toast_returns_focus_to_where_it_was(browser, base_url):
    context, page = toast_page(browser, base_url)
    pill = ".actions a.pill[href='/timeline/']"
    try:
        page.focus(pill)
        assert page.evaluate("document.activeElement !== document.body")
        show_toast(page)
        page.focus("#toast .toast-close")
        page.keyboard.press("Enter")
        assert not toast_on(page)
        assert page.evaluate("(sel) => document.activeElement.matches(sel)", pill)
    finally:
        context.close()


def test_hiding_the_toast_returns_focus_to_the_element_focus_came_from(browser, base_url):
    context, page = toast_page(browser, base_url)
    try:
        show_toast(page)
        page.focus("footer a")
        page.focus("#toast .toast-close")
        page.keyboard.press("Enter")
        assert not toast_on(page)
        assert page.evaluate("document.activeElement.matches('footer a')")
    finally:
        context.close()


def test_a_second_announcement_keeps_focus_in_the_toast(browser, base_url):
    context = make_context(browser, base_url)
    try:
        page = context.new_page()
        page.clock.install()
        first = fresh_snapshot()
        second = fresh_snapshot()
        newer = {**second["releases"][0], "id": NEW_ID + "2", "url": NEW_ID + "2", "beta": 5}
        second["releases"].insert(0, newer)
        answers = {"count": 0}

        def answer(route):
            answers["count"] += 1
            body = [SNAPSHOT, first][answers["count"] - 1] if answers["count"] < 3 else second
            route.fulfill(content_type="application/json", body=json.dumps(body))

        page.route("**/api/releases.json", answer)
        page.goto(base_url + "/")
        cards_ready(page)
        show_toast(page)
        page.focus("#toast .toast-close")
        with page.expect_response("**/api/releases.json"):
            page.clock.run_for(5 * 60 * 1000 + 1000)
        page.wait_for_timeout(200)
        assert toast_on(page)
        assert page.evaluate("document.activeElement.className") == "toast-close"
    finally:
        context.close()


def test_hiding_the_toast_without_a_previous_focus_lands_on_the_content(browser, base_url):
    context, page = toast_page(browser, base_url)
    try:
        show_toast(page)
        page.focus("#toast .toast-close")
        page.keyboard.press("Enter")
        assert not toast_on(page)
        assert page.evaluate("document.activeElement.id") == "content"
    finally:
        context.close()


def test_each_release_in_the_toast_links_to_its_timeline_row(browser, base_url):
    context, page = toast_page(browser, base_url)
    try:
        show_toast(page)
        link = page.locator("#toast a.toast-link").first
        assert link.inner_text() == "iOS 27.2 beta 4"
        assert link.get_attribute("href") == "/timeline/?id=" + quote(NEW_ID, safe="-_.!~*'()")
    finally:
        context.close()


def test_every_toast_link_is_a_44px_target(browser, base_url):
    context, page = toast_page(browser, base_url, width=360, count=3)
    try:
        show_toast(page)
        heights = page.eval_on_selector_all(
            "#toast .toast-link", "els => els.map(e => e.getBoundingClientRect().height)"
        )
        assert len(heights) == 3 and all(h >= 43.5 for h in heights)
        inside = page.evaluate(
            """() => {
                const toast = document.querySelector('#toast');
                const box = toast.getBoundingClientRect();
                const links = [...toast.querySelectorAll('.toast-link')];
                return {
                    left: box.left,
                    right: box.right,
                    width: window.innerWidth,
                    scroll: toast.scrollWidth,
                    client: toast.clientWidth,
                    links: links.map(a => a.getBoundingClientRect().right),
                };
            }"""
        )
        assert inside["left"] >= 0 and inside["right"] <= inside["width"]
        assert inside["scroll"] <= inside["client"]
        assert all(r <= inside["right"] + 0.5 for r in inside["links"])
    finally:
        context.close()


def test_the_timeline_lands_on_the_row_named_by_id(page, base_url):
    serve_json(page, "**/api/releases.json", json.dumps(fresh_snapshot()))
    page.goto(base_url + "/timeline/?stage=release&id=" + quote(NEW_ID, safe=""))
    page.wait_for_function("() => document.activeElement.closest('.tl-item') !== null")
    assert page.evaluate("document.activeElement.closest('.tl-item').dataset.id") == NEW_ID


def test_the_used_id_leaves_the_address_when_the_filters_are_already_all(page, base_url):
    serve_json(page, "**/api/releases.json", json.dumps(fresh_snapshot()))
    page.goto(base_url + "/timeline/?id=" + quote(NEW_ID, safe=""))
    page.wait_for_function("() => document.activeElement.closest('.tl-item') !== null")
    assert page.evaluate("document.activeElement.closest('.tl-item').dataset.id") == NEW_ID
    assert "id=" not in page.evaluate("() => window.location.search")


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
            page.evaluate("y => window.scrollTo({ top: y, behavior: 'instant' })", y)
            page.wait_for_timeout(30)
        page.wait_for_function(
            "() => [...document.querySelectorAll('.reveal')]"
            ".every(e => getComputedStyle(e).opacity === '1')"
        )
        hidden = page.evaluate(
            "() => [...document.querySelectorAll('.reveal')]"
            ".filter(e => getComputedStyle(e).opacity !== '1').length"
        )
        assert hidden == 0
    finally:
        context.close()


# True once every .reveal.pre in the observer's view (the viewport less 8% at the bottom) is .in.
REVEALED_IN_VIEW = """() => [...document.querySelectorAll('.reveal.pre:not(.in)')].every((e) => {
  const r = e.getBoundingClientRect();
  return r.bottom <= 1 || r.top >= innerHeight * 0.92 - 1;
})"""


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
        # Walk down the page in steps that overlap, jumping (the page scrolls smoothly otherwise,
        # and a smooth scroll under load can skip an element between two frames, which an
        # observer then never reports) and waiting at each stop until the observer has
        # revealed what is in view. Every wait ends when its condition is true.
        height = page.evaluate("() => document.documentElement.scrollHeight")
        for y in range(0, height, 400):
            page.evaluate("y => window.scrollTo({ top: y, behavior: 'instant' })", y)
            page.wait_for_function(REVEALED_IN_VIEW)
        page.wait_for_function(
            "() => document.querySelectorAll('.reveal.pre:not(.in)').length === 0"
        )
        # The reveal fades for 500 ms; wait for the end of the transitions, not for a guess.
        page.wait_for_function(
            "() => [...document.querySelectorAll('.reveal.pre')]"
            ".every(e => getComputedStyle(e).opacity === '1')"
        )
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
    with empty.expect_response("**/data/features.json"):
        empty.goto(base_url + "/")
    cards_ready(empty)
    empty.wait_for_load_state("networkidle")
    assert empty.locator("#features").is_hidden()


# --- the timeline -----------------------------------------------------------------------


def test_the_timeline_lists_everything_newest_first_grouped_by_month(page, base_url):
    page.goto(base_url + "/timeline/")
    page.wait_for_selector(".tl-item")
    assert page.locator(".tl-item").count() == len(SNAPSHOT["releases"])
    months = page.locator(".month-h").all_inner_texts()
    assert months[0] == "October 2026" and months[-1] == "September 2024"
    assert len(months) == len(set(months))
    assert page.inner_text("#count") == f"{len(SNAPSHOT['releases'])} releases"
    hrefs = page.locator(".tl-link").evaluate_all("els => els.map(a => a.href)")
    assert sorted(hrefs) == sorted(r["url"] for r in SNAPSHOT["releases"])
    # Releases of one source can share a link, so take the dates of a link newest first.
    by_url = {}
    for r in sorted(SNAPSHOT["releases"], key=lambda r: r["date"], reverse=True):
        by_url.setdefault(r["url"], []).append(r["date"])
    dates = [by_url[href].pop(0) for href in hrefs]
    assert dates == sorted(dates, reverse=True)


def test_the_filter_chips_narrow_by_os_and_by_stage(page, base_url):
    page.goto(base_url + "/timeline/")
    page.wait_for_selector(".tl-item")
    page.click("#chips-family [data-v=iOS]")
    assert page.get_attribute("#chips-family [data-v=iOS]", "aria-pressed") == "true"
    assert page.get_attribute("#chips-family [data-v=all]", "aria-pressed") == "false"
    assert set(page.locator(".tl-fam").all_inner_texts()) == {"iOS"}
    assert page.locator(".tl-item").count() == len(releases("iOS"))
    page.click("#chips-stage [data-v=beta]")
    betas = [r for r in releases("iOS") if r["stage"] == "beta"]
    assert page.locator(".tl-item").count() == len(betas)
    noun = "beta" if len(betas) == 1 else "betas"
    assert page.inner_text("#count") == f"{len(betas)} iOS {noun}"
    assert page.url.endswith("?family=iOS&stage=beta")
    page.click("#chips-stage [data-v=release]")
    finals = [r for r in releases("iOS") if r["stage"] == "release"]
    assert page.inner_text("#count") == f"{len(finals)} iOS public " + (
        "release" if len(finals) == 1 else "releases"
    )
    page.click("#chips-stage [data-v=rc]")
    assert page.locator(".tl-item").count() == 0
    assert page.inner_text("#count") == "No iOS release candidates in the data."
    page.click("#chips-family [data-v=all]")
    page.click("#chips-stage [data-v=all]")
    assert page.locator(".tl-item").count() == len(SNAPSHOT["releases"])


def test_a_filtered_address_opens_filtered(page, base_url):
    page.goto(base_url + "/timeline/?family=macOS&stage=release")
    page.wait_for_selector(".tl-item")
    expected = [r for r in releases("macOS") if r["stage"] == "release"]
    assert page.locator(".tl-item").count() == len(expected)
    assert page.get_attribute("#chips-family [data-v=macOS]", "aria-pressed") == "true"


def test_a_poll_with_nothing_new_leaves_the_timeline_and_its_focus_alone(page, base_url):
    page.goto(base_url + "/timeline/")
    page.wait_for_selector(".tl-item")
    page.focus(".tl-item a")
    page.evaluate("document.querySelector('.tl-item a').dataset.mark = 'kept'")
    page.evaluate("RO.refresh()")
    assert page.evaluate("document.activeElement.dataset.mark") == "kept"
    assert page.evaluate("document.querySelector('.tl-item a').dataset.mark") == "kept"


# --- compare ----------------------------------------------------------------------------


def default_from(entries):
    """The compare page's first From: the newest public release of the newest entry's line,
    else the newest earlier public release, else the oldest entry."""
    public = [r for r in entries[1:] if r["stage"] == "release"]
    same = [r for r in public if r["major"] == entries[0]["major"]]
    return (same or public or entries[-1:])[0]


def stat_values(page):
    return [
        (s.locator(".stat-v").text_content(), s.locator(".stat-k").text_content())
        for s in page.locator(".stat").all()
    ]


def test_compare_counts_the_days_and_what_lies_between(page, base_url):
    page.goto(base_url + "/compare/")
    page.wait_for_selector(".cmp-cards")
    ios = releases("iOS")
    older = next(r for r in ios if r["version"] == "15.8.8")
    newer = next(r for r in ios if r["version"] == "27.0.1")
    page.select_option("#c-from", older["id"])
    page.select_option("#c-to", newer["id"])
    between = ios[ios.index(newer) + 1 : ios.index(older)]
    days = (
        datetime.date.fromisoformat(newer["date"][:10])
        - datetime.date.fromisoformat(older["date"][:10])
    ).days
    stats = stat_values(page)
    assert stats[0] == (str(days), "days between")
    assert stats[1][0] == str(sum(r["stage"] != "release" for r in between))
    assert stats[2] == (
        str(sum(r["stage"] == "release" for r in between)),
        "public releases in between",
    )
    assert page.locator(".cmp-result ol.tl li").count() == len(between)
    cards = page.locator(".cmp-card").all_inner_texts()
    assert older["build"] in cards[0] and newer["build"] in cards[1]
    # Picked the other way round, the older one is still the older one.
    page.select_option("#c-from", newer["id"])
    page.select_option("#c-to", older["id"])
    assert page.locator(".cmp-card").all_inner_texts() == cards


def test_compare_cards_draw_a_sigil_and_name_the_channel_without_a_build(page, base_url):
    page.goto(base_url + "/compare/")
    page.wait_for_selector(".cmp-cards")
    page.select_option("#c-family", "SteamOS")
    steam = releases("SteamOS")
    page.select_option("#c-to", steam[0]["id"])
    page.select_option("#c-from", steam[-1]["id"])
    page.wait_for_selector(".cmp-card .sigil svg")
    cards = page.locator(".cmp-card")
    assert cards.count() == 2
    assert page.locator(".cmp-card .sigil svg").count() == 2
    words = " ".join(cards.all_inner_texts())
    assert "No build number" not in words and "Stable" in words and "Beta" in words


def test_compare_counts_betas_in_between_and_changes_family(page, base_url):
    page.goto(base_url + "/compare/")
    page.wait_for_selector(".cmp-cards")
    page.select_option("#c-family", "macOS")
    mac = releases("macOS")
    assert page.locator("#c-to option").count() == len(mac)
    assert page.input_value("#c-to") == mac[0]["id"]
    assert page.input_value("#c-from") == default_from(mac)["id"]
    page.select_option("#c-from", mac[-1]["id"])
    between = mac[1:-1]
    assert stat_values(page)[2][0] == str(sum(r["stage"] == "release" for r in between))
    assert stat_values(page)[1][0] == str(sum(r["stage"] != "release" for r in between))
    page.select_option("#c-from", mac[0]["id"])
    assert "different releases" in page.inner_text("#cmp-result")


def test_compare_counts_betas_and_rcs_between_two_releases(page, base_url):
    data = copy.deepcopy(SNAPSHOT)
    base = {
        "vendor": "apple",
        "family": "iOS",
        "major": 27,
        "build": "b",
        "url": "https://developer.apple.com/x",
    }
    data["releases"] = [
        {
            **base,
            "id": "d",
            "version": "27.1",
            "stage": "release",
            "beta": None,
            "title": "iOS 27.1",
            "date": "2026-10-10T00:00:00Z",
        },
        {
            **base,
            "id": "c",
            "version": "27.1",
            "stage": "rc",
            "beta": 2,
            "title": "iOS 27.1 RC 2",
            "date": "2026-10-05T00:00:00Z",
        },
        {
            **base,
            "id": "b",
            "version": "27.1",
            "stage": "beta",
            "beta": 1,
            "title": "iOS 27.1 beta 1",
            "date": "2026-10-01T00:00:00Z",
        },
        {
            **base,
            "id": "a",
            "version": "27.0",
            "stage": "release",
            "beta": None,
            "title": "iOS 27.0",
            "date": "2026-09-20T00:00:00Z",
        },
    ]
    serve_json(page, "**/api/releases.json", json.dumps(data))
    page.goto(base_url + "/compare/")
    page.wait_for_selector(".cmp-cards")
    assert stat_values(page) == [
        ("20", "days between"),
        ("2", "betas and RCs in between"),
        ("0", "public releases in between"),
    ]
    assert page.locator(".pin").count() == 4
    # By default the newest entry is compared with the public release of its own line.
    assert page.input_value("#c-to") == "d"
    assert page.input_value("#c-from") == "a"


def test_compare_says_so_when_the_chosen_platform_has_no_releases(page, base_url):
    data = copy.deepcopy(SNAPSHOT)
    data["releases"] = [r for r in data["releases"] if r["family"] != "visionOS"]
    serve_json(page, "**/api/releases.json", json.dumps(data))
    page.goto(base_url + "/compare/?family=visionOS")
    page.wait_for_function(
        "() => document.getElementById('cmp-result').textContent"
        ".includes('No releases for this platform')"
    )
    assert "Loading" not in page.inner_text("#cmp-result")


def test_compare_does_not_start_with_two_unrelated_lines(page, base_url):
    page.goto(base_url + "/compare/")
    page.wait_for_selector(".cmp-cards")
    ios = releases("iOS")
    chosen = next(r for r in ios if r["id"] == page.input_value("#c-from"))
    assert chosen["stage"] == "release"
    assert chosen["major"] == ios[0]["major"] or ios[0]["major"] not in {
        r["major"] for r in ios[1:] if r["stage"] == "release"
    }
    assert page.input_value("#c-to") == ios[0]["id"]


FIELD_BOXES = (
    "[...document.querySelectorAll('.cmp-form .field')]"
    ".map(f => { const b = f.getBoundingClientRect(); return [b.left, b.top, b.width]; })"
)
LONGEST_LABEL = """() => [...document.querySelectorAll('.cmp-form select')].map(select => {
  const style = getComputedStyle(select);
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = style.font;
  const widest = Math.max(...[...select.options].map(o => ctx.measureText(o.text).width));
  const room = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return [widest, room];
})"""


@pytest.mark.parametrize(("width", "height"), [(390, 844), (820, 1180), (899, 900)])
def test_compare_selects_stack_and_show_their_longest_label_below_900px(
    page, base_url, width, height
):
    page.set_viewport_size({"width": width, "height": height})
    page.goto(base_url + "/compare/")
    page.wait_for_selector(".cmp-cards")
    boxes = page.evaluate(FIELD_BOXES)
    assert len(boxes) == 3
    assert len({round(left) for left, _, _ in boxes}) == 1, "the fields share one left edge"
    tops = [round(top) for _, top, _ in boxes]
    assert tops == sorted(set(tops)), "the fields sit one below the other"
    assert len({round(w) for _, _, w in boxes}) == 1
    for widest, room in page.evaluate(LONGEST_LABEL):
        assert widest <= room, "the longest option label is cut off"


def test_compare_selects_sit_in_three_columns_from_900px(page, base_url):
    page.set_viewport_size({"width": 1024, "height": 800})
    page.goto(base_url + "/compare/")
    page.wait_for_selector(".cmp-cards")
    boxes = page.evaluate(FIELD_BOXES)
    assert len({round(top) for _, top, _ in boxes}) == 1, "the fields share one row"
    lefts = [round(left) for left, _, _ in boxes]
    assert lefts == sorted(set(lefts))


def test_compare_states_where_the_history_starts_only_for_the_oldest_pick(page, base_url):
    page.goto(base_url + "/compare/")
    page.wait_for_selector(".cmp-cards")
    ios = releases("iOS")
    page.select_option("#c-to", ios[0]["id"])
    page.select_option("#c-from", ios[-1]["id"])
    oldest_day = page.locator("#c-from option:checked").inner_text().split(" · ")[-1]
    assert page.locator("p.data-range").count() == 1
    assert page.inner_text("p.data-range") == f"History in this data starts {oldest_day}."
    # Picked the other way round, the oldest entry is still the oldest end of the pair.
    page.select_option("#c-from", ios[0]["id"])
    page.select_option("#c-to", ios[-1]["id"])
    assert page.inner_text("p.data-range") == f"History in this data starts {oldest_day}."
    # A pair that stops short of the oldest entry says nothing about where the data starts.
    page.select_option("#c-to", ios[0]["id"])
    page.select_option("#c-from", ios[-2]["id"])
    assert page.locator(".stat").count() == 3
    assert page.locator("p.data-range").count() == 0


def query_of(page):
    return page.evaluate(
        "Object.fromEntries(new URLSearchParams(window.location.search).entries())"
    )


def test_compare_writes_the_picks_to_the_address(page, base_url):
    page.goto(base_url + "/compare/")
    page.wait_for_selector(".cmp-cards")
    ios = releases("iOS")
    older = next(r for r in ios if r["version"] == "15.8.8")
    newer = next(r for r in ios if r["version"] == "27.0.1")
    page.select_option("#c-from", older["id"])
    assert query_of(page)["from"] == older["id"]
    page.select_option("#c-to", newer["id"])
    assert query_of(page) == {"family": "iOS", "from": older["id"], "to": newer["id"]}
    page.select_option("#c-family", "macOS")
    query = query_of(page)
    assert query["family"] == "macOS"
    macos_ids = [r["id"] for r in releases("macOS")]
    assert query["from"] in macos_ids and query["to"] in macos_ids


def test_compare_restores_the_picks_from_the_address(page, base_url):
    ios = releases("iOS")
    older = next(r for r in ios if r["version"] == "15.8.8")
    newer = next(r for r in ios if r["version"] == "27.0.1")
    query = urlencode({"family": "iOS", "from": older["id"], "to": newer["id"]})
    page.goto(base_url + "/compare/?" + query)
    page.wait_for_selector(".cmp-cards")
    assert page.input_value("#c-from") == older["id"]
    assert page.input_value("#c-to") == newer["id"]
    cards = page.locator(".cmp-card").all_inner_texts()
    assert older["build"] in cards[0] and newer["build"] in cards[1]


def test_compare_ignores_ids_that_are_not_in_the_list(page, base_url):
    macos = releases("macOS")[0]
    query = urlencode({"family": "iOS", "from": "no-such-id", "to": macos["id"]})
    page.goto(base_url + "/compare/?" + query)
    page.wait_for_selector(".cmp-cards")
    ios = releases("iOS")
    # Neither id belongs to iOS: both selects keep the defaults.
    assert page.input_value("#c-to") == ios[0]["id"]
    assert page.input_value("#c-from") == default_from(ios)["id"]


def test_compare_rewrites_a_bad_shared_address_to_what_is_shown(page, base_url):
    page.goto(base_url + "/compare/?family=iOS&from=no-such-id&to=also-bad")
    page.wait_for_selector(".cmp-cards")
    ios = releases("iOS")
    query = parse_qs(urlsplit(page.url).query)
    assert query["from"] == [default_from(ios)["id"]]
    assert query["to"] == [ios[0]["id"]]


def test_compare_keeps_the_address_in_step_when_a_poll_drops_a_pick(page, base_url):
    ios = releases("iOS")
    older = next(r for r in ios if r["version"] == "15.8.8")
    query = urlencode({"family": "iOS", "from": older["id"], "to": ios[0]["id"]})
    fresh = copy.deepcopy(SNAPSHOT)
    fresh["releases"] = [r for r in fresh["releases"] if r["id"] != older["id"]]
    answers = {"body": json.dumps(SNAPSHOT)}
    page.route(
        "**/api/releases.json",
        lambda route: route.fulfill(content_type="application/json", body=answers["body"]),
    )
    page.goto(base_url + "/compare/?" + query)
    page.wait_for_selector(".cmp-cards")
    assert page.input_value("#c-from") == older["id"]
    answers["body"] = json.dumps(fresh)
    page.evaluate("() => RO.refresh()")
    page.wait_for_function(
        "(id) => document.getElementById('c-from').value !== id && "
        "!document.querySelector('#c-from option[value=\"' + id + '\"]')",
        arg=older["id"],
    )
    shown = {"family": "iOS", "from": page.input_value("#c-from"), "to": page.input_value("#c-to")}
    assert shown["from"] != older["id"]
    assert query_of(page) == shown


def test_home_compare_link_does_not_indent_when_it_wraps(page, base_url):
    page.set_viewport_size({"width": 360, "height": 800})
    page.goto(base_url + "/")
    first = page.locator("#visionos .more-row a").nth(0).bounding_box()
    second = page.locator("#visionos .more-row a").nth(1).bounding_box()
    # Wrapped under the first link, the second starts at the same left edge.
    assert second["y"] > first["y"]
    assert abs(second["x"] - first["x"]) < 1


def test_home_compare_link_goes_to_the_family(page, base_url):
    page.goto(base_url + "/")
    link = page.locator("#macos a.more-cmp")
    assert link.get_attribute("href") == "/compare/?family=macOS"
    assert link.bounding_box()["height"] >= 43.5
    link.click()
    page.wait_for_selector(".cmp-cards")
    assert page.input_value("#c-family") == "macOS"


def test_a_poll_with_nothing_new_leaves_the_compare_page_alone(page, base_url):
    page.goto(base_url + "/compare/")
    page.wait_for_selector(".cmp-cards")
    page.evaluate(
        "document.getElementById('cmp-result').firstChild.dataset.mark = 'kept';"
        "document.getElementById('c-from').dataset.mark = 'kept';"
        "document.querySelector('#c-from option').dataset.mark = 'kept'"
    )
    page.focus(".rel-apple")
    page.evaluate("RO.refresh()")
    assert page.evaluate("document.getElementById('cmp-result').firstChild.dataset.mark") == "kept"
    assert page.evaluate("document.querySelector('#c-from option').dataset.mark") == "kept"
    assert page.evaluate("document.activeElement.className") == "rel-apple"


def test_a_failed_poll_keeps_the_live_data_instead_of_the_older_snapshot(page, base_url):
    newest = copy.deepcopy(APPLE_FIRST)
    newest.update(
        id="https://developer.apple.com/news/releases/?id=live-only",
        version="99.1",
        major=99,
        title="iOS 99.1",
        family="iOS",
        stage="release",
        beta=None,
        date="2099-01-01T00:00:00Z",
    )
    live = copy.deepcopy(SNAPSHOT) | {"snapshot": False, "stale": False}
    live["releases"] = [newest, *SNAPSHOT["releases"]]
    answers = {"body": json.dumps(live), "status": 200}
    page.route(
        "**/api/releases.json",
        lambda route: route.fulfill(
            status=answers["status"], content_type="application/json", body=answers["body"]
        ),
    )
    page.goto(base_url + "/")
    cards_ready(page)
    assert page.inner_text("#latest-grid [data-family=iOS] [data-f=ver]") == "iOS 99.1"
    answers.update(status=502, body="{}")
    page.evaluate("() => RO.refresh()")
    assert page.inner_text("#latest-grid [data-family=iOS] [data-f=ver]") == "iOS 99.1"
    newer = copy.deepcopy(newest)
    newer.update(
        id="https://developer.apple.com/news/releases/?id=live-only-2",
        version="99.2",
        title="iOS 99.2",
        date="2099-01-02T00:00:00Z",
    )
    recovered = copy.deepcopy(live)
    recovered["releases"] = [newer, *live["releases"]]
    answers.update(status=200, body=json.dumps(recovered))
    page.evaluate("() => RO.refresh()")
    page.wait_for_function(
        "() => document.querySelector('#latest-grid [data-family=iOS] [data-f=ver]')"
        ".textContent === 'iOS 99.2'"
    )


# --- every page, every theme ------------------------------------------------------------


def wait_for_data(page, path):
    selector = {
        "/": "#latest-grid [data-family=iOS] [data-f=link]:not([hidden])",
        "/timeline/": ".tl-item",
        "/compare/": ".cmp-cards",
    }.get(path)
    if selector:
        page.wait_for_selector(selector)
    # below.js paints the mock screens, cadence.js its row and fx.js its effects after the page
    # has painted (home.js, from an idle callback that may wait 1500 ms). Network idle alone can
    # come before those scripts are even requested, so wait for what they leave behind: the
    # Cadence global and its row (cadence.js loads under reduced motion too, fx.js does not),
    # then one more idle callback for the module, then the network.
    if path == "/":
        mocks_ready(page)
        page.wait_for_function(
            "() => { const row = document.getElementById('cadence');"
            " return !row || (!!window.Cadence && row.children.length > 0); }",
            timeout=10000,
        )
        page.evaluate("() => new Promise(r => requestIdleCallback(() => r(), { timeout: 2000 }))")
    page.wait_for_load_state("networkidle")


@pytest.mark.parametrize("theme", ["day", "night", "reactor"])
def test_no_page_scrolls_sideways_at_320_and_nothing_logs_an_error(browser, base_url, theme):
    context = make_context(browser, base_url, width=320, theme=theme)
    try:
        page = context.new_page()
        errors: list[str] = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        for path in PAGES:
            page.goto(base_url + path)
            wait_for_data(page, path)
            assert page.evaluate("() => document.documentElement.scrollWidth") <= 320, path
            assert page.evaluate("() => window.__csp") == [], path
        assert errors == []
    finally:
        context.close()


def test_the_pages_pass_the_audit_once_their_data_is_in(page, base_url):
    for path in PAGES:
        page.goto(base_url + path)
        wait_for_data(page, path)
        assert page.evaluate(AUDIT) == [], path


def test_every_new_control_is_big_enough(browser, base_url):
    context = make_context(browser, base_url, width=360)
    try:
        page = context.new_page()
        for path, selector in (
            ("/timeline/", ".chip, .tl-link"),
            ("/compare/", "select"),
            ("/", ".rel-apple, .rel-fam a, .recent a, .more"),
        ):
            page.goto(base_url + path)
            wait_for_data(page, path)
            small = page.evaluate(
                """sel => [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null)
                  .map(e => [e.className, e.getBoundingClientRect().height])
                  .filter(([, h]) => h < 43.5)""",
                selector,
            )
            assert small == [], (path, small)
    finally:
        context.close()


def test_pages_say_what_they_are_before_any_script_runs(browser, base_url):
    context = make_context(browser, base_url, script=False)
    try:
        page = context.new_page()
        for path, heading in (
            ("/", "Every OS release"),
            ("/timeline/", "Release timeline"),
            ("/compare/", "Compare versions"),
        ):
            page.goto(base_url + path)
            assert heading in page.inner_text("h1")
        page.goto(base_url + "/")
        noscript = "noscript a[href='https://developer.apple.com/news/releases/']"
        assert page.locator(noscript).count() == 1
        footer = page.inner_text("footer")
        assert footer.startswith("Release Orbit")
        assert LEGAL in footer
        for name in (
            "Apple Developer Releases",
            "MikroTik changelogs",
            "AOSP build numbers",
            "Windows release health",
            "Steam Deck news",
        ):
            assert name in footer
        assert "Sources: Apple Developer Releases" in footer
    finally:
        context.close()


def test_the_links_to_other_pages_are_in_the_header_and_footer(page, base_url):
    page.goto(base_url + "/")
    for label, href in (("Timeline", "/timeline/"), ("Compare", "/compare/"), ("About", "/about/")):
        assert page.locator(f'header nav a[href="{href}"]').inner_text() == label
        assert page.locator(f'footer nav a[href="{href}"]').inner_text() == label


def test_cards_headline_the_stable_release_with_a_line_for_a_newer_pre_release(page, base_url):
    page.goto(base_url + "/")
    cards_ready(page)

    def card(name):
        return page.locator(f'#latest-grid [data-family="{name}"]')

    assert card("iOS").locator("[data-f=ver]").inner_text() == "iOS 27.0.1"
    assert card("iOS").locator("[data-f=stage]").inner_text() == "Release"
    assert card("iOS").locator("[data-f=pre] a").inner_text().startswith("Next: 27.2 beta 3")
    assert card("RouterOS").locator("[data-f=ver]").inner_text() == "RouterOS 7.24.5"
    assert card("SteamOS").locator("[data-f=ver]").inner_text() == "SteamOS 3.8.28"
    assert card("SteamOS").locator("[data-f=pre] a").inner_text().startswith("Next: 3.9.2 beta")
    assert card("tvOS").locator("[data-f=pre] a").inner_text().startswith("Next: 27.2 beta 3")
    # No newer pre-release: no second line, and the space is not reserved.
    for name in ("Windows", "Android"):
        assert card(name).locator("[data-f=pre]").is_hidden()
        assert card(name).locator("[data-f=pre] a").count() == 0
    assert page.locator("#newest .fam-ios .n-ver").text_content() == "27.0.1"
    assert page.locator("#newest .fam-steamos .n-ver").text_content() == "3.8.28"
    assert page.locator("#newest li a").count() == 10


def test_a_family_with_only_pre_releases_headlines_the_newest_of_them(page, base_url):
    data = copy.deepcopy(SNAPSHOT)
    data["releases"] = [
        r for r in data["releases"] if r["family"] != "SteamOS" or r["stage"] != "release"
    ]
    serve_json(page, "**/api/releases.json", json.dumps(data))
    page.goto(base_url + "/")
    cards_ready(page)
    card = page.locator('#latest-grid [data-family="SteamOS"]')
    assert card.locator("[data-f=ver]").inner_text() == "SteamOS 3.9.2"
    assert card.locator("[data-f=pre]").is_hidden()
