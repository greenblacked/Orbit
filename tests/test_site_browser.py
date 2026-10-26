"""The site, driven in a real browser the way a person uses it.

The deep page is /about/. Reading the HTML and the stylesheet
as text can say that a rule or a line of script exists but not that the page behaves: that
Back returns to the page you came from, that the bar and To top appear when they should
and get out of the way when they should not, that a jump to a heading is not hidden under
them, or that the theme you chose survives a reload. These load the real build in Chromium,
act on it and assert what a person would see: URLs, computed visibility, boxes on screen,
focus and storage.

They need the `playwright` package and a browser. CI's `site-browser` job installs the
package and uses the runner's own Chrome (`BROWSER_CHANNEL=chrome`), so nothing is
downloaded; locally, point `BROWSER_EXECUTABLE` at any Chromium. Without the package the
module is skipped, unless `REQUIRE_BROWSER=1`, which the CI job sets so these can never
pass by not running.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import pytest

REPO = Path(__file__).resolve().parent.parent

pytestmark = pytest.mark.browser

try:
    import playwright.sync_api  # noqa: F401
except ImportError:
    if os.environ.get("REQUIRE_BROWSER") == "1":
        raise
    pytest.skip(
        "playwright is not installed; CI's site-browser job runs these",
        allow_module_level=True,
    )

# A page below the front page, with enough text to scroll in both directions.
PARENT_PATH = "/"
DEEP_PATH = "/about/"
# The size the site promises for its own controls: Material's and Apple's 44px floor.
TARGET = 44


def new_context(browser, base_url: str, width: int = 1280, color_scheme: str = "light"):
    """A fresh profile: no history, no storage, nothing fetched from outside.

    Reduced motion turns the page's own transitions and smooth scrolling off, so what a
    test reads is the settled state rather than a frame of an animation. Requests that
    leave the local server, the web fonts, are refused, so no test waits on the network
    or changes with it; the fallback font is what is measured.
    """
    made = browser.new_context(
        viewport={"width": width, "height": 800}, reduced_motion="reduce", color_scheme=color_scheme
    )
    # Anchored on the server's own origin and a slash, so neither another local port
    # nor a userinfo trick such as http://127.0.0.1:1@elsewhere/ gets through.
    made.route(re.compile("^(?!" + re.escape(base_url) + "/)"), lambda route: route.abort())
    return made


@pytest.fixture
def context(browser, base_url):
    made = new_context(browser, base_url)
    yield made
    made.close()


@pytest.fixture
def page(context):
    return context.new_page()


def settle(page):
    """Wait two frames, so scroll handlers have run and styles have been recomputed."""
    page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")


def scroll_to(page, y: int) -> None:
    page.evaluate("y => window.scrollTo(0, y)", y)
    page.wait_for_function(
        "y => Math.abs(window.scrollY - Math.min(y, document.documentElement.scrollHeight"
        " - innerHeight)) < 2",
        arg=y,
    )
    settle(page)


def bottom(page) -> int:
    return page.evaluate("() => document.documentElement.scrollHeight - innerHeight")


def shown(page, selector: str) -> bool:
    return page.evaluate(
        "s => { const e = document.querySelector(s);"
        " return !!e && getComputedStyle(e).visibility === 'visible'; }",
        selector,
    )


def box(page, selector: str) -> dict:
    return page.evaluate(
        "s => { const r = document.querySelector(s).getBoundingClientRect();"
        " return {top: r.top, bottom: r.bottom, left: r.left, right: r.right,"
        " width: r.width, height: r.height}; }",
        selector,
    )


def past_inline_back(page) -> int:
    """A scroll position just below the page's own Back, where the bar takes over."""
    return (
        int(
            page.evaluate(
                "() => document.querySelector('main .back').getBoundingClientRect()"
                ".bottom + scrollY"
            )
        )
        + 40
    )


# --- Back -------------------------------------------------------------------------------


def test_back_returns_to_the_page_you_came_from(page, base_url):
    # Arrive from the front page, so going back through history and following the link's
    # own target land in the same place; the history path is the one under test.
    page.goto(base_url + "/")
    page.click(f'main a[href="{DEEP_PATH}"]')
    page.wait_for_url(base_url + DEEP_PATH)
    page.click("main .back")
    page.wait_for_url(base_url + "/")


def test_back_returns_through_history_not_to_the_link_target(page, base_url):
    # Arrive from a page that is not the parent, so history and the link's own target
    # differ: the 404 page's footer links to /about/, whose Back points at /.
    page.goto(base_url + "/404.html")
    page.click(f'footer a[href="{DEEP_PATH}"]')
    page.wait_for_url(base_url + DEEP_PATH)
    page.click("main .back")
    page.wait_for_url(base_url + "/404.html")


def test_back_opened_directly_goes_to_the_page_above(page, base_url):
    # No history on this site to return through, so the link's own target is used.
    page.goto(base_url + DEEP_PATH)
    page.click("main .back")
    page.wait_for_url(base_url + PARENT_PATH)


def test_back_never_leaves_for_the_site_you_arrived_from(page, base_url):
    # A visitor who followed a link from another site has history, but going back
    # through it would leave this one; Back goes to the page above instead.
    page.goto("about:blank")
    page.goto(base_url + DEEP_PATH, referer="https://example.com/somewhere")
    page.click("main .back")
    page.wait_for_url(base_url + PARENT_PATH)


def test_back_in_a_tab_opened_from_this_site_goes_to_the_page_above(context, page, base_url):
    # A page opened in a new tab has a referrer on this site but no history to go back
    # through; Back has to follow its link rather than call history.back() on nothing.
    page.goto(base_url + "/")
    with context.expect_page() as opened:
        page.click(f'main a[href="{DEEP_PATH}"]', modifiers=["ControlOrMeta"])
    tab = opened.value
    tab.wait_for_url(base_url + DEEP_PATH)
    assert tab.url == base_url + DEEP_PATH
    assert tab.evaluate("() => history.length") == 1
    tab.click("main .back")
    tab.wait_for_url(base_url + PARENT_PATH)


def test_a_modified_click_on_back_opens_the_page_above_in_a_new_tab(context, page, base_url):
    page.goto(base_url + "/")
    page.click(f'main a[href="{DEEP_PATH}"]')
    page.wait_for_url(base_url + DEEP_PATH)
    with context.expect_page() as opened:
        page.click("main .back", modifiers=["ControlOrMeta"])
    opened.value.wait_for_url(base_url + PARENT_PATH)
    assert opened.value.url == base_url + PARENT_PATH
    assert page.url == base_url + DEEP_PATH


# --- The bar ----------------------------------------------------------------------------


def test_the_bar_takes_over_back_once_the_page_scrolls_past_it(page, base_url):
    page.goto(base_url + DEEP_PATH)
    assert not shown(page, "#dock")
    scroll_to(page, past_inline_back(page))
    assert shown(page, "#dock")
    # The bar's Back is the same link, and it works from there.
    assert page.get_attribute("#dock .back", "href") == PARENT_PATH
    scroll_to(page, 0)
    assert not shown(page, "#dock")


def test_the_bar_follows_back_when_the_window_changes_width(page, base_url):
    # The inline Back sits higher on a phone than on a wider screen, so the point past
    # which the bar takes over moves with the width. Between the two, a narrower window
    # has to bring the bar out without waiting for the next scroll.
    page.goto(base_url + DEEP_PATH)
    wide = past_inline_back(page) - 40
    page.set_viewport_size({"width": 360, "height": 800})
    settle(page)
    narrow = past_inline_back(page) - 40
    assert narrow < wide, "Back no longer moves with the width; pick another breakpoint"
    page.set_viewport_size({"width": 1280, "height": 800})
    scroll_to(page, (narrow + wide) // 2)
    assert not shown(page, "#dock")
    page.set_viewport_size({"width": 360, "height": 800})
    page.wait_for_function(
        "() => getComputedStyle(document.getElementById('dock')).visibility === 'visible'"
    )


def test_the_front_page_has_no_bar(page, base_url):
    page.goto(base_url + "/")
    assert page.query_selector("#dock") is None


# --- To top -----------------------------------------------------------------------------


def test_to_top_stays_away_while_reading_down_and_comes_back_on_the_way_up(page, base_url):
    page.goto(base_url + DEEP_PATH)
    assert not shown(page, "#to-top")
    start = past_inline_back(page) + 600
    scroll_to(page, start)
    assert not shown(page, "#to-top"), "shown while reading down"
    scroll_to(page, start - 200)
    assert shown(page, "#to-top"), "not shown on the way up"
    scroll_to(page, start + 400)
    assert not shown(page, "#to-top"), "not hidden again on the next scroll down"
    scroll_to(page, bottom(page))
    assert shown(page, "#to-top"), "not shown at the end of the page"


def test_to_top_returns_to_the_top_and_hands_focus_to_home(page, base_url):
    page.goto(base_url + DEEP_PATH)
    scroll_to(page, bottom(page))
    page.click("#to-top")
    page.wait_for_function("() => window.scrollY === 0")
    settle(page)
    assert page.evaluate("() => document.activeElement.id") == "home"
    assert not shown(page, "#to-top")


def test_to_top_is_not_hidden_while_it_has_focus(page, base_url):
    page.goto(base_url + DEEP_PATH)
    start = past_inline_back(page) + 600
    scroll_to(page, start)
    scroll_to(page, start - 200)
    page.focus("#to-top")
    scroll_to(page, start + 400)
    assert shown(page, "#to-top")


# --- Anchors ----------------------------------------------------------------------------


def test_a_jump_up_to_a_heading_lands_below_the_header_and_the_bar(page, base_url):
    page.goto(base_url + DEEP_PATH)
    limit = past_inline_back(page)
    target = page.evaluate(
        "limit => [...document.querySelectorAll('main h2[id], main h3[id]')]"
        ".map(h => ({id: h.id, y: h.getBoundingClientRect().top + scrollY}))"
        ".find(h => h.y > limit + 400).id",
        limit,
    )
    scroll_to(page, bottom(page))
    page.evaluate("id => { location.hash = id; }", target)
    settle(page)
    heading = box(page, f"#{target}")
    covered = box(page, "#banner")["bottom"]
    if shown(page, "#dock"):
        covered = max(covered, box(page, "#dock")["bottom"])
    assert heading["top"] >= covered, (heading, covered)


# --- Theme ------------------------------------------------------------------------------


def theme(page) -> str:
    return page.get_attribute("html", "data-theme")


@pytest.mark.parametrize(("scheme", "expected"), [("dark", "night"), ("light", "day")])
def test_without_a_choice_the_theme_follows_the_system_setting(browser, base_url, scheme, expected):
    context = new_context(browser, base_url, color_scheme=scheme)
    try:
        page = context.new_page()
        # The clock says the opposite of the system setting, so the old clock rule fails both.
        noon_or_late = "2026-10-06T12:30:00" if scheme == "dark" else "2026-10-06T23:30:00"
        page.clock.install(time=noon_or_late)
        page.goto(base_url + "/")
        assert theme(page) == expected
        assert page.get_attribute("#dark-switch", "aria-checked") == str(scheme == "dark").lower()
    finally:
        context.close()


def test_the_system_setting_wins_over_the_clock(browser, base_url):
    context = new_context(browser, base_url, color_scheme="light")
    try:
        page = context.new_page()
        page.clock.install(time="2026-10-06T23:30:00")
        page.goto(base_url + "/")
        assert theme(page) == "day"
    finally:
        context.close()


def test_the_theme_follows_a_change_of_the_system_setting_until_a_choice_is_made(page, base_url):
    page.goto(base_url + "/")
    assert theme(page) == "day"
    page.emulate_media(color_scheme="dark")
    page.wait_for_function("() => document.documentElement.dataset.theme === 'night'")
    assert page.get_attribute("#dark-switch", "aria-checked") == "true"
    page.emulate_media(color_scheme="light")
    page.wait_for_function("() => document.documentElement.dataset.theme === 'day'")
    page.click("#dark-switch")
    assert theme(page) == "night"
    page.emulate_media(color_scheme="dark")
    page.emulate_media(color_scheme="light")
    page.wait_for_timeout(100)
    assert theme(page) == "night"


@pytest.mark.parametrize("choice", ["day", "night", "reactor"])
def test_a_stored_choice_wins_over_the_system_setting(browser, base_url, choice):
    system = "light" if choice != "day" else "dark"
    context = new_context(browser, base_url, color_scheme=system)
    try:
        page = context.new_page()
        page.add_init_script(f"try {{ localStorage.setItem('theme', '{choice}') }} catch (e) {{}}")
        page.goto(base_url + "/")
        assert theme(page) == choice
        page.emulate_media(color_scheme="dark" if system == "light" else "light")
        page.wait_for_timeout(100)
        assert theme(page) == choice
    finally:
        context.close()


@pytest.mark.parametrize("scheme", ["dark", "light"])
def test_no_timer_changes_the_theme_of_a_page_that_is_open(browser, base_url, scheme):
    context = new_context(browser, base_url, color_scheme=scheme)
    try:
        page = context.new_page()
        page.clock.install(time="2026-10-06T19:50:00")
        page.goto(base_url + "/")
        before = theme(page)
        page.clock.run_for(20 * 60 * 1000)
        assert theme(page) == before
        assert page.get_attribute("html", "data-theme") == ("night" if scheme == "dark" else "day")
    finally:
        context.close()


@pytest.mark.parametrize(
    ("choice", "switch", "console"),
    [("day", "false", "false"), ("night", "true", "false"), ("reactor", "true", "true")],
)
def test_the_theme_controls_report_the_theme_in_all_three_themes(
    page, base_url, choice, switch, console
):
    page.add_init_script(f"try {{ localStorage.setItem('theme', '{choice}') }} catch (e) {{}}")
    page.goto(base_url + "/")
    assert theme(page) == choice
    assert page.get_attribute("#dark-switch", "aria-checked") == switch
    assert page.get_attribute("#console-theme", "aria-pressed") == console
    # The picture matches the state: the knob is moved and the moon is shown when it is on.
    moved = page.evaluate(
        "getComputedStyle(document.querySelector('#dark-switch .knob')).transform !== 'none'"
    )
    assert moved == (switch == "true")
    moon = page.is_visible("#dark-switch .moon")
    assert moon == (switch == "true")


@pytest.mark.parametrize("choice", ["night", "reactor"])
def test_the_switch_is_already_on_before_site_js_runs_in_a_dark_theme(page, base_url, choice):
    page.add_init_script(f"try {{ localStorage.setItem('theme', '{choice}') }} catch (e) {{}}")
    page.route("**/assets/site.js", lambda route: route.abort())
    page.goto(base_url + "/")
    assert theme(page) == choice
    # site.js never ran, so the markup still says off; the picture must already say on.
    assert page.get_attribute("#dark-switch", "aria-checked") == "false"
    moved = page.evaluate(
        "getComputedStyle(document.querySelector('#dark-switch .knob')).transform !== 'none'"
    )
    assert moved
    assert page.is_visible("#dark-switch .moon")
    assert not page.is_visible("#dark-switch .sun")


def test_a_click_still_wins_over_a_system_change_when_storage_is_blocked(page, base_url):
    page.add_init_script(
        "Storage.prototype.setItem = function () { throw new Error('blocked'); };"
        "Storage.prototype.getItem = function () { throw new Error('blocked'); };"
    )
    page.goto(base_url + "/")
    assert theme(page) == "day"
    page.click("#dark-switch")
    assert theme(page) == "night"
    page.emulate_media(color_scheme="light")
    page.emulate_media(color_scheme="dark")
    page.emulate_media(color_scheme="light")
    page.wait_for_timeout(100)
    assert theme(page) == "night"


def test_turning_the_dark_switch_off_in_the_console_theme_goes_to_day(page, base_url):
    page.goto(base_url + "/")
    page.click("#console-theme")
    assert page.get_attribute("#dark-switch", "aria-checked") == "true"
    page.click("#dark-switch")
    assert theme(page) == "day"
    assert page.get_attribute("#dark-switch", "aria-checked") == "false"
    assert page.get_attribute("#console-theme", "aria-pressed") == "false"


def test_the_dark_switch_flips_the_theme_and_the_choice_survives_a_reload(page, base_url):
    page.goto(base_url + "/")
    before = theme(page)
    page.click("#dark-switch")
    after = theme(page)
    assert after == ("day" if before == "night" else "night")
    assert page.get_attribute("#dark-switch", "aria-checked") == str(after == "night").lower()
    page.reload()
    assert theme(page) == after


def test_the_console_theme_toggles_and_forgets_itself_when_turned_off(page, base_url):
    page.goto(base_url + "/")
    page.click("#console-theme")
    assert theme(page) == "reactor"
    assert page.get_attribute("#console-theme", "aria-pressed") == "true"
    page.reload()
    assert theme(page) == "reactor"
    page.click("#console-theme")
    assert theme(page) == "day"  # the system setting, light here
    assert page.evaluate("() => localStorage.getItem('theme')") is None


# --- Layout -----------------------------------------------------------------------------


@pytest.mark.parametrize("width", [360, 1440])
def test_nothing_scrolls_sideways_and_every_control_is_big_enough(browser, base_url, width):
    context = new_context(browser, base_url, width)
    try:
        page = context.new_page()
        page.goto(base_url + DEEP_PATH)
        controls = ["main .back", "#dark-switch", "#console-theme"]
        for selector in controls:
            size = box(page, selector)
            assert size["width"] >= TARGET and size["height"] >= TARGET, (selector, size)
        # Bring the bar and To top out together: past Back, down, then a little back up.
        start = past_inline_back(page) + 600
        scroll_to(page, start)
        scroll_to(page, start - 200)
        for selector in ("#dock .back", "#to-top"):
            assert shown(page, selector), selector
            size = box(page, selector)
            assert size["width"] >= TARGET and size["height"] >= TARGET, (selector, size)
            assert size["left"] >= 0 and size["right"] <= width, (selector, size)
        # The bar spans the header's width, so its Back lines up under the header's edge.
        assert box(page, "#dock .dock-in")["left"] == box(page, "#banner .bar")["left"]
        # To top carries its label only where the margin beside the column can hold it.
        assert page.is_visible("#to-top span") == (width >= 1440)
        assert page.evaluate("() => document.documentElement.scrollWidth") <= width
        # At the end of the page the footer has room to scroll clear of To top.
        scroll_to(page, bottom(page))
        fab = box(page, "#to-top")
        covered = page.evaluate(
            "f => [...document.querySelectorAll('footer a')].filter(a => {"
            " const r = a.getBoundingClientRect();"
            " return r.right > f.left && r.left < f.right && r.bottom > f.top && r.top < f.bottom;"
            " }).map(a => a.textContent)",
            fab,
        )
        assert covered == []
    finally:
        context.close()


def test_no_page_scrolls_sideways_on_a_phone(browser, built, base_url):
    # Every page, because the one that overflows is the one with a long path in its
    # prose: a long unbreakable identifier in one paragraph is enough to do it.
    paths = sorted(
        "/" + "".join(f"{part}/" for part in index.parent.relative_to(built).parts)
        for index in built.rglob("index.html")
    )
    context = new_context(browser, base_url, 360)
    try:
        page = context.new_page()
        wide = {}
        for path in paths:
            page.goto(base_url + path)
            # The release data and the scripts that load after the page paint rows and cards.
            page.wait_for_load_state("networkidle")
            settle(page)
            width = page.evaluate("() => document.documentElement.scrollWidth")
            if width > 360:
                wide[path] = width
        assert not wide, wide
        # The walk found the real pages, not an empty or partial build.
        assert {"/", DEEP_PATH} <= set(paths)
    finally:
        context.close()


def test_a_half_year_version_orders_h2_above_h1_on_the_same_day(page, base_url):
    page.goto(base_url + "/", wait_until="domcontentloaded")
    order = page.evaluate(
        """() => {
          const t = Date.UTC(2026, 8, 22);
          const rows = [
            { id: '#26h1-1', version: '26H1', stage: 'release', beta: null, t },
            { id: '#26h2-1', version: '26H2', stage: 'release', beta: null, t },
          ];
          return rows.sort(RO.newer).map((r) => r.version);
        }"""
    )
    assert order == ["26H2", "26H1"]


# --- Check my version ----------------------------------------------------------------------

SNAPSHOT = json.loads((REPO / "src" / "data" / "releases.json").read_text(encoding="utf-8"))
DAY_MS = 86_400_000


def public(family: str) -> list[dict]:
    """The family's public releases, newest first, with the time in milliseconds."""
    rows = [r for r in SNAPSHOT["releases"] if r["family"] == family and r["stage"] == "release"]
    stamped = [
        {**r, "t": int(datetime.fromisoformat(r["date"].replace("Z", "+00:00")).timestamp() * 1000)}
        for r in rows
    ]
    return sorted(stamped, key=lambda r: -r["t"])


def lookup_ready(page, base_url: str, path: str = "/", query: str = ""):
    page.goto(base_url + path + query)
    page.wait_for_selector("#lk-form:not([hidden])")


def lookup_ask(page, family: str, text: str) -> None:
    page.evaluate("() => { document.getElementById('lk-result').textContent = '' }")
    page.select_option("#lk-family", family)
    page.fill("#lk-build", text)
    page.click("#lk-form button")


def answer(page) -> str:
    page.wait_for_selector("#lk-result .lk-say")
    return page.inner_text("#lk-result .lk-say")


@pytest.mark.parametrize("path", ["/", "/compare/"])
def test_check_my_version_calls_the_newest_public_release_current(page, base_url, path):
    ios = public("iOS")
    lookup_ready(page, base_url, path)
    assert page.get_attribute("#lk-result", "role") == "status"
    assert page.get_attribute("#lk-result", "aria-live") == "polite"
    lookup_ask(page, "iOS", ios[0]["build"])
    first = answer(page)
    assert first.startswith("Current for iOS: iOS ")
    assert ios[0]["version"] in first
    assert page.locator("#lk-result a").count() == 0
    # A version works as well as a build, and so does the platform name before it.
    lookup_ask(page, "iOS", "iOS " + ios[0]["version"])
    assert answer(page) == first


@pytest.mark.parametrize("path", ["/", "/compare/"])
def test_check_my_version_says_how_far_behind_an_older_release_is(page, base_url, path):
    android = public("Android")
    newest, old = android[0], android[2]
    lookup_ready(page, base_url, path)
    lookup_ask(page, "Android", old["build"])
    text = answer(page)
    found = re.fullmatch(
        r"Superseded by Android (\S+) on ([A-Z][a-z]{2} \d{1,2}, \d{4}): "
        r"(\d+) public releases? and (\d+) days? behind\."
        r"( The newest of its line is Android \S+\.)?",
        text,
    )
    assert found, text
    assert found.group(1) == newest["version"]
    between = [r for r in android if old["t"] < r["t"] < newest["t"]]
    assert int(found.group(3)) == len(between)
    assert int(found.group(4)) == newest["t"] // DAY_MS - old["t"] // DAY_MS
    link = page.locator("#lk-result a")
    assert link.get_attribute("href") == (
        f"/compare/?family=Android&from={quote(old['id'], safe='')}"
        f"&to={quote(newest['id'], safe='')}"
        f"&platform=Android&build={quote(old['build'], safe='')}"
    )
    # The link opens Compare on exactly those two releases.
    link.click()
    page.wait_for_selector("#cmp-result .cmp-card")
    assert page.input_value("#c-family") == "Android"
    assert page.input_value("#c-from") == old["id"]
    assert page.input_value("#c-to") == newest["id"]
    # Compare's own lookup comes up filled with the same question.
    assert page.input_value("#lk-family") == "Android"
    assert page.input_value("#lk-build") == old["build"]


def test_check_my_version_calls_the_newest_of_an_older_line_current_for_that_line(page, base_url):
    ios = public("iOS")
    lookup_ready(page, base_url)
    lookup_ask(page, "iOS", ios[2]["build"])
    text = answer(page)
    assert text.startswith(f"Current for iOS {ios[2]['major']}: iOS {ios[2]['version']}"), text
    assert f"The newest public release is iOS {ios[0]['version']}." in text
    assert "behind" not in text
    # A bare major works when every release of it has one version.
    lookup_ask(page, "Android", "Android 16")
    assert answer(page).startswith("Current for Android 16: Android 16.0.0")


def test_check_my_version_names_the_newest_of_a_routeros_line(page, base_url):
    ros = public("RouterOS")
    stable = next(r for r in ros if r["version"] == "7.24.5")
    long_term = next(r for r in ros if r["version"] == "7.23.8")
    assert long_term["t"] > stable["t"]
    lookup_ready(page, base_url)
    lookup_ask(page, "RouterOS", stable["build"])
    assert answer(page).startswith("Current for RouterOS: RouterOS 7.24.5")
    lookup_ask(page, "RouterOS", long_term["build"])
    text = answer(page)
    head = "Current for RouterOS Long-term: RouterOS 7.23.8 is the newest of its line."
    assert text.startswith(head), text
    assert "The newest public release is RouterOS 7.24.5." in text, text
    assert "behind" not in text and page.locator("#lk-result a").count() == 0
    lookup_ask(page, "RouterOS", "7.25rc1")
    assert answer(page).endswith("ahead of the newest public release, RouterOS 7.24.5.")


def test_check_my_version_leaves_out_the_cve_count_without_security_data(page, base_url):
    ios = public("iOS")
    empty = json.dumps(
        {
            "schema": 1,
            "generatedAt": "2026-10-11T00:00:00Z",
            "sources": {"apple": {"status": "ok"}, "android": {"status": "ok"}},
            "notes": {},
            "releases": {},
        }
    )
    for pattern in ("**/data/security.json", "**/api/security.json"):
        page.route(
            pattern,
            lambda route: route.fulfill(status=200, content_type="application/json", body=empty),
        )
    # Ask only once the security data has loaded (and holds nothing for this build).
    with page.expect_response("**/api/security.json"):
        lookup_ready(page, base_url, "/compare/")
    page.wait_for_load_state("networkidle")
    lookup_ask(page, "iOS", ios[1]["build"])
    assert answer(page).startswith("Current for iOS")
    assert page.locator("#lk-result .lk-cve").count() == 0


def test_check_my_version_says_so_when_nothing_matches(page, base_url):
    lookup_ready(page, base_url)
    lookup_ask(page, "macOS", "not-a-build-9")
    text = answer(page)
    assert text.startswith("Not found:") and "not-a-build-9" in text
    assert page.locator("#lk-result a").count() == 0
    # A version of another platform is not a match either.
    ios = public("iOS")
    lookup_ask(page, "tvOS", ios[0]["build"])
    assert answer(page).startswith("Not found:")
    page.fill("#lk-build", "  ")
    page.click("#lk-form button")
    assert answer(page) == "Enter a version or a build number."


def test_check_my_version_keeps_the_query_in_the_address_and_restores_it(page, base_url):
    mac = public("macOS")
    lookup_ready(page, base_url)
    lookup_ask(page, "macOS", mac[0]["version"])
    expected = answer(page)
    query = page.evaluate("() => location.search")
    assert f"platform=macOS&build={quote(mac[0]['version'], safe='')}" in query
    page.reload()
    page.wait_for_selector("#lk-form:not([hidden])")
    assert page.input_value("#lk-family") == "macOS"
    assert page.input_value("#lk-build") == mac[0]["version"]
    assert answer(page) == expected
    # Straight from a shared address, nothing pressed.
    lookup_ready(page, base_url, "/", f"?platform=iOS&build={public('iOS')[1]['build']}")
    assert answer(page).startswith("Superseded by") or answer(page).startswith("Current")
    # An empty query leaves the address bare.
    page.fill("#lk-build", "")
    page.click("#lk-form button")
    assert page.evaluate("() => location.search") == ""


def test_check_my_version_drops_its_query_when_the_platform_changes(page, base_url):
    ios = public("iOS")
    lookup_ready(page, base_url)
    lookup_ask(page, "iOS", ios[0]["build"])
    assert "build=" in page.evaluate("() => location.search")
    page.select_option("#lk-family", "macOS")
    assert page.evaluate("() => location.search") == ""
    assert page.locator("#lk-result p").count() == 0


def test_check_my_version_and_compare_keep_each_others_query(page, base_url):
    ios = public("iOS")
    lookup_ready(page, base_url, "/compare/")
    lookup_ask(page, "iOS", ios[1]["build"])
    page.select_option("#c-family", "macOS")
    query = page.evaluate("() => location.search")
    assert "family=macOS" in query and "from=" in query and "to=" in query
    assert "platform=iOS" in query and quote(ios[1]["build"]) in query
    lookup_ask(page, "iOS", ios[2]["build"])
    query = page.evaluate("() => location.search")
    assert "family=macOS" in query and quote(ios[2]["build"]) in query
    assert query.count("build=") == 1


def test_check_my_version_works_from_the_keyboard(page, base_url):
    ios = public("iOS")
    lookup_ready(page, base_url)
    page.focus("#lk-family")
    page.keyboard.press("Tab")
    assert page.evaluate("() => document.activeElement.id") == "lk-pick"
    page.keyboard.press("Tab")
    assert page.evaluate("() => document.activeElement.id") == "lk-build"
    page.keyboard.type(ios[0]["build"])
    page.keyboard.press("Enter")
    assert answer(page).startswith("Current for iOS")
    page.keyboard.press("Tab")
    assert page.evaluate("() => document.activeElement.className") == "lk-go"
    # Space on Check asks again (the old answer is gone first, so it has to be drawn anew);
    # Shift+Tab walks back to the platform.
    page.evaluate("() => { document.getElementById('lk-result').textContent = ''; }")
    page.keyboard.press("Space")
    assert answer(page).startswith("Current for iOS")
    page.keyboard.press("Shift+Tab")
    page.keyboard.press("Shift+Tab")
    page.keyboard.press("Shift+Tab")
    assert page.evaluate("() => document.activeElement.id") == "lk-family"
    for selector in ("#lk-family", "#lk-pick", "#lk-build", ".lk-go"):
        assert box(page, selector)["height"] >= TARGET, selector


@pytest.mark.parametrize("path", ["/", "/compare/"])
def test_check_my_version_offers_the_known_builds_to_pick(page, base_url, path):
    ios = public("iOS")
    lookup_ready(page, base_url, path)
    assert page.locator('label[for="lk-pick"]').inner_text().lower() == "pick a build"

    def offered() -> list[str]:
        return page.eval_on_selector_all("#lk-pick option", "els => els.map(e => e.value)")

    def builds(family: str) -> set[str]:
        return {r["build"] or r["version"] for r in SNAPSHOT["releases"] if r["family"] == family}

    # An empty first choice, then every iOS release (a beta too), by build.
    values = offered()
    assert values[0] == "" and set(values[1:]) == builds("iOS")
    assert page.input_value("#lk-pick") == ""
    # Picking a build fills the input and names that release, without pressing Check.
    page.evaluate("() => { document.getElementById('lk-result').textContent = '' }")
    page.select_option("#lk-pick", ios[1]["build"])
    assert page.input_value("#lk-build") == ios[1]["build"]
    page.wait_for_selector("#lk-result .lk-hit")
    hit = page.inner_text("#lk-result .lk-hit")
    assert hit.startswith(f"iOS {ios[1]['version']} · {ios[1]['build']}"), hit
    # The picker is not a URL parameter: the address keeps ?platform= and ?build= only.
    query = page.evaluate("() => location.search")
    assert f"platform=iOS&build={quote(ios[1]['build'], safe='')}" in query and "pick" not in query
    # Typing another build moves the picker, and text that is no build empties it.
    page.fill("#lk-build", ios[0]["build"])
    assert page.input_value("#lk-pick") == ios[0]["build"]
    page.fill("#lk-build", "not-a-build-9")
    assert page.input_value("#lk-pick") == ""
    # A version, in any case and with the platform's name, picks the release it names.
    page.fill("#lk-build", "26.6.2")
    assert page.input_value("#lk-pick") == "23G90"
    page.fill("#lk-build", "iOS 26.6.2")
    assert page.input_value("#lk-pick") == "23G90"
    page.fill("#lk-build", "23g90")
    assert page.input_value("#lk-pick") == "23G90"
    # A new platform refills the list with its own builds and clears the answer.
    page.fill("#lk-build", ios[0]["build"])
    page.select_option("#lk-family", "macOS")
    assert set(offered()[1:]) == builds("macOS") and offered()[0] == ""
    assert ios[1]["build"] not in offered()
    assert page.locator("#lk-result p").count() == 0
    # iPadOS shares builds with iOS, yet the picker stays empty after a platform change while the
    # input keeps its text, with no answer drawn.
    page.select_option("#lk-family", "iOS")
    page.fill("#lk-build", "23G90")
    assert page.input_value("#lk-pick") == "23G90"
    page.select_option("#lk-family", "iPadOS")
    assert "23G90" in offered()
    assert page.input_value("#lk-pick") == "" and page.input_value("#lk-build") == "23G90"
    assert page.locator("#lk-result p").count() == 0
    # Quick picks (Up and Down on the list) settle on the last one, and that one is answered.
    page.select_option("#lk-family", "iOS")
    page.select_option("#lk-pick", ios[0]["build"])
    page.select_option("#lk-pick", ios[2]["build"])
    page.select_option("#lk-pick", ios[1]["build"])
    assert page.input_value("#lk-build") == ios[1]["build"]
    expected = f"iOS {ios[1]['version']} · {ios[1]['build']}"
    page.wait_for_function(
        "(text) => { const hit = document.querySelector('#lk-result .lk-hit');"
        " return !!hit && hit.textContent.includes(text); }",
        arg=expected,
    )
    assert page.inner_text("#lk-result .lk-hit").startswith(expected)
    # An address with ?build= comes up with that build chosen.
    lookup_ready(page, base_url, path, f"?platform=iOS&build={ios[1]['build']}")
    assert page.input_value("#lk-pick") == ios[1]["build"]


@pytest.mark.parametrize("path", ["/", "/compare/"])
def test_check_my_version_does_not_scroll_sideways_at_360px(browser, base_url, path):
    ios = public("iOS")
    context = new_context(browser, base_url, 360)
    try:
        page = context.new_page()
        lookup_ready(page, base_url, path)
        for text in (ios[2]["build"], "x" * 64):
            lookup_ask(page, "iOS", text)
            answer(page)
            settle(page)
            assert page.evaluate("() => document.documentElement.scrollWidth") <= 360
            for selector in ("#lk-family", "#lk-pick", "#lk-build", ".lk-go", "#lk-result a"):
                if page.locator(selector).count():
                    size = box(page, selector)
                    assert size["right"] <= 360 and size["left"] >= 0, (selector, size)
    finally:
        context.close()


# --- Check my version: Check answers visibly --------------------------------------------------


def phone_context(browser, devices, base_url: str, reduced_motion: str = "no-preference"):
    """An iPhone 13 profile (touch, small screen) on the same Chromium, as CI runs it."""
    device = dict(devices["iPhone 13"])
    device.pop("default_browser_type", None)
    made = browser.new_context(**device, reduced_motion=reduced_motion)
    made.route(re.compile("^(?!" + re.escape(base_url) + "/)"), lambda route: route.abort())
    return made


def press_check(page, tap: bool) -> None:
    if tap:
        page.locator("#lk-form button").tap()
    else:
        page.click("#lk-form button")


def assert_checked_visibly(page) -> None:
    """The answer holds focus, carries the flash and is on screen."""
    page.wait_for_function("() => document.activeElement === document.getElementById('lk-result')")
    assert page.evaluate(
        "() => document.getElementById('lk-result').classList.contains('lk-flash')"
    )
    page.wait_for_function(
        "() => { const r = document.getElementById('lk-result').getBoundingClientRect();"
        " return r.top >= 0 && r.bottom <= innerHeight; }"
    )


@pytest.mark.parametrize("path", ["/", "/compare/"])
@pytest.mark.parametrize("tap", [True, False], ids=["tap", "click"])
def test_check_redraws_focuses_and_flashes_an_answer_the_pick_already_showed(
    browser, devices, base_url, path, tap
):
    build = public("iOS")[0]["build"]
    context = phone_context(browser, devices, base_url) if tap else new_context(browser, base_url)
    try:
        page = context.new_page()
        lookup_ready(page, base_url, path)
        page.select_option("#lk-family", "iOS")
        page.select_option("#lk-pick", build)
        page.wait_for_selector("#lk-result .lk-say")
        assert page.evaluate("() => document.activeElement.id") != "lk-result"
        page.evaluate("() => { window.firstDraw = document.querySelector('#lk-result p'); }")
        press_check(page, tap)
        assert_checked_visibly(page)
        assert page.evaluate("() => !window.firstDraw.isConnected")
        assert page.locator("#lk-result .lk-say").count() == 1
    finally:
        context.close()


@pytest.mark.parametrize("path", ["/", "/compare/"])
def test_check_focuses_and_flashes_a_typed_answer_on_a_phone(browser, devices, base_url, path):
    context = phone_context(browser, devices, base_url)
    try:
        page = context.new_page()
        lookup_ready(page, base_url, path)
        page.select_option("#lk-family", "iOS")
        page.fill("#lk-build", public("iOS")[0]["build"])
        press_check(page, True)
        assert_checked_visibly(page)
        name = page.evaluate(
            "() => getComputedStyle(document.getElementById('lk-result')).animationName"
        )
        assert name == "lk-flash"
        assert page.locator("#lk-result .lk-say").count() == 1
    finally:
        context.close()


@pytest.mark.parametrize("path", ["/", "/compare/"])
def test_check_does_not_animate_the_flash_when_motion_is_reduced(browser, devices, base_url, path):
    context = phone_context(browser, devices, base_url, reduced_motion="reduce")
    try:
        page = context.new_page()
        lookup_ready(page, base_url, path)
        page.select_option("#lk-family", "iOS")
        page.fill("#lk-build", public("iOS")[0]["build"])
        press_check(page, True)
        assert_checked_visibly(page)
        name = page.evaluate(
            "() => getComputedStyle(document.getElementById('lk-result')).animationName"
        )
        assert name == "none"
    finally:
        context.close()


@pytest.mark.parametrize("path", ["/", "/compare/"])
def test_picking_a_build_answers_without_moving_focus_or_flashing(page, base_url, path):
    lookup_ready(page, base_url, path)
    page.select_option("#lk-family", "iOS")
    page.select_option("#lk-pick", public("iOS")[0]["build"])
    page.wait_for_selector("#lk-result .lk-say")
    assert page.evaluate("() => document.activeElement.id") != "lk-result"
    assert not page.evaluate(
        "() => document.getElementById('lk-result').classList.contains('lk-flash')"
    )
