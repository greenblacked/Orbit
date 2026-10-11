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
LEGAL = (
    "Independent site. Not affiliated with, endorsed by or sponsored by Apple Inc. Apple, "
    "iPhone, iPad, Mac, Apple Watch, Apple TV, Apple Vision Pro, iOS, iPadOS, macOS, watchOS, "
    "tvOS and visionOS are trademarks of Apple Inc."
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


def test_the_data_check_mock_reports_the_real_latest_release(page, base_url):
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
    assert page.inner_text("[data-act=check]") == "Check again"


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
    assert (rows.locator("[data-f=betarow]").inner_text() != "None") == bool(newer_beta)
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


# --- the timeline -----------------------------------------------------------------------


def test_the_timeline_lists_everything_newest_first_grouped_by_month(page, base_url):
    page.goto(base_url + "/timeline/")
    page.wait_for_selector(".tl-item")
    assert page.locator(".tl-item").count() == len(SNAPSHOT["releases"])
    months = page.locator(".month-h").all_inner_texts()
    assert months[0] == "October 2026" and months[-1] == "May 2026"
    assert len(months) == len(set(months))
    assert page.inner_text("#count") == f"{len(SNAPSHOT['releases'])} releases"
    hrefs = page.locator(".tl-link").evaluate_all("els => els.map(a => a.href)")
    assert sorted(hrefs) == sorted(r["url"] for r in SNAPSHOT["releases"])
    by_url = {r["url"]: r["date"] for r in SNAPSHOT["releases"]}
    dates = [by_url[href] for href in hrefs]
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
        "() => document.getElementById('cmp-result').textContent.includes('No releases for this platform')"
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
    newest = copy.deepcopy(SNAPSHOT["releases"][0])
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
    page.evaluate("RO.refresh()")
    page.wait_for_function("() => document.getElementById('live').dataset.state === 'stale'")
    assert page.inner_text("#latest-grid [data-family=iOS] [data-f=ver]") == "iOS 99.1"
    assert "Could not reach the tracker" in page.inner_text("#live-text")
    answers.update(status=200, body=json.dumps(live))
    page.evaluate("RO.refresh()")
    page.wait_for_function("() => document.getElementById('live').dataset.state === 'live'")


# --- every page, every theme ------------------------------------------------------------


def wait_for_data(page, path):
    selector = {
        "/": "#latest-grid [data-family=iOS] [data-f=link]:not([hidden])",
        "/timeline/": ".tl-item",
        "/compare/": ".cmp-cards",
    }.get(path)
    if selector:
        page.wait_for_selector(selector)


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
    context = browser.new_context(java_script_enabled=False)
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
        assert "Source: Apple Developer Releases" in footer
    finally:
        context.close()


def test_the_links_to_other_pages_are_in_the_header_and_footer(page, base_url):
    page.goto(base_url + "/")
    for label, href in (("Timeline", "/timeline/"), ("Compare", "/compare/"), ("About", "/about/")):
        assert page.locator(f'header nav a[href="{href}"]').inner_text() == label
        assert page.locator(f'footer nav a[href="{href}"]').inner_text() == label
