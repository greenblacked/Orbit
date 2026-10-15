"""The timeline's two views in Chromium: the git-log list (default) and the Cadence lanes.

The list draws a trunk with a dot per release, a branch for each beta and release candidate, and a
sticky bar per month. Cadence (?view=cadence, lanes.js, loaded on demand) draws one lane per
platform over the last 12 months. Release data comes from the snapshot through the local server;
a test that needs particular rows serves its own. Reduced motion is on, so what is read is the
settled state.
"""

from __future__ import annotations

import copy
import json
import os
import re
from datetime import datetime
from urllib.parse import quote

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
FAMILIES = sorted({r["family"] for r in SNAPSHOT["releases"]})
FIRST = next(r for r in SNAPSHOT["releases"] if r["vendor"] == "apple")
TARGET = 43.5
RECORD = """
window.__csp = [];
document.addEventListener("securitypolicyviolation", (e) => {
  window.__csp.push(e.violatedDirective + " " + e.blockedURI);
});
"""


def make_context(browser, base_url, width=1280, theme=None):
    context = browser.new_context(
        viewport={"width": width, "height": 900}, reduced_motion="reduce"
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
def opened(browser, base_url):
    """open(path, width=1280, theme=None, body=None) -> (page, errors)."""
    made = []

    def open_page(path="/timeline/", width=1280, theme=None, body=None):
        context = make_context(browser, base_url, width, theme)
        made.append(context)
        page = context.new_page()
        errors: list[str] = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        if body is not None:
            page.route(
                "**/api/releases.json",
                lambda route: route.fulfill(
                    status=200, content_type="application/json", body=json.dumps(body)
                ),
            )
        page.goto(base_url + path)
        page.wait_for_selector(".tl-item, .lanes-lane, #lanes:not([hidden])")
        return page, errors

    yield open_page
    for context in made:
        context.close()


def crowded():
    """Seventeen iOS releases: fourteen in October 2026 and three in September."""
    data = copy.deepcopy(SNAPSHOT)
    rows = []
    for k in range(17):
        month, day = (10, 12 - k % 10) if k < 14 else (9, 20 - k)
        rows.append(
            {
                **FIRST,
                "id": f"c{k}",
                "family": "iOS",
                "version": f"26.{k}",
                "major": 26,
                "stage": "release",
                "beta": None,
                "build": f"B{k}",
                "title": f"iOS 26.{k}",
                "date": f"2026-{month:02d}-{day:02d}T00:00:00Z",
            }
        )
    data["releases"] = rows
    return data


def lanes_open(page):
    page.wait_for_selector(".lanes-lane .lanes-dot")


# --- the list: a git log -----------------------------------------------------------------


def test_a_release_sits_on_the_trunk_and_a_beta_or_rc_branches_from_it(opened):
    page, errors = opened()
    kinds = page.locator(".tl-item").evaluate_all(
        "els => els.map(e => [e.className.split(' '), e.dataset.id])"
    )
    by_stage = {r["id"]: r["stage"] for r in SNAPSHOT["releases"]}
    seen = set()
    for classes, release_id in kinds:
        stage = by_stage[release_id]
        seen.add(stage)
        assert f"st-{stage}" in classes
        if stage == "release":
            assert "tl-trunk" in classes and "tl-branch" not in classes
        else:
            assert "tl-branch" in classes and "tl-trunk" not in classes
    assert "release" in seen and "beta" in seen, "the snapshot must hold both for this to mean much"
    assert page.locator(".tl-item .tl-dot").count() == len(kinds)
    assert errors == []


def test_the_stage_is_in_the_shape_of_the_dot_and_not_only_its_colour(opened):
    page, _ = opened()
    shapes = {}
    for stage in ("release", "beta", "rc"):
        dot = page.locator(f".tl-item.st-{stage} .tl-dot")
        if dot.count():
            shapes[stage] = dot.first.evaluate(
                "e => { const s = getComputedStyle(e);"
                " return [s.borderTopWidth, s.borderTopLeftRadius, s.transform]; }"
            )
    assert "release" in shapes and "beta" in shapes
    assert len({tuple(v) for v in shapes.values()}) == len(shapes), shapes
    # The text badge stays beside it.
    assert page.locator(".tl-item .badge").count() == page.locator(".tl-item").count()


def test_a_branch_is_indented_from_the_trunk_and_dots_sit_on_their_column(opened):
    page, _ = opened()
    release = page.locator(".tl-item.tl-trunk .tl-dot").first.bounding_box()
    beta = page.locator(".tl-item.tl-branch .tl-dot").first.bounding_box()
    assert beta["x"] > release["x"] + 8


def test_every_row_keeps_a_44px_link_and_no_phone_scrolls_sideways(opened):
    page, errors = opened(width=360)
    heights = page.locator(".tl-link").evaluate_all(
        "els => els.map(e => e.getBoundingClientRect().height)"
    )
    assert heights and min(heights) >= TARGET
    assert page.evaluate("() => document.documentElement.scrollWidth") <= 360
    assert errors == []


@pytest.mark.parametrize("theme", ["day", "night", "reactor"])
def test_a_month_bar_names_the_month_counts_its_releases_and_scales_its_bar(opened, theme):
    page, _ = opened(theme=theme)
    bars = page.locator(".month-bar")
    assert bars.count() >= 2
    first = bars.first
    # The newest month comes from the data, so a refreshed snapshot does not break the test.
    newest = max(r["date"] for r in SNAPSHOT["releases"])[:7]
    name = datetime.strptime(newest, "%Y-%m").strftime("%B %Y")
    in_newest = [r for r in SNAPSHOT["releases"] if r["date"].startswith(newest)]
    assert first.locator("h2.month-h").inner_text() == name
    noun = "release" if len(in_newest) == 1 else "releases"
    assert first.locator(".month-n").inner_text() == f"{len(in_newest)} {noun}"
    assert page.locator(".month").first.locator(".tl-item").count() == len(in_newest)
    shares = page.locator(".month-dens").evaluate_all(
        "els => els.map(e => parseFloat(e.style.getPropertyValue('--d')))"
    )
    assert max(shares) == 1 and all(0 < s <= 1 for s in shares)
    assert page.locator(".month-dens").first.get_attribute("aria-hidden") == "true"


def test_a_month_bar_stays_in_view_below_the_header_while_its_rows_scroll(opened):
    page, _ = opened(body=crowded())
    bar = page.locator(".month-bar").first
    assert bar.evaluate("e => getComputedStyle(e).position") == "sticky"
    top = bar.evaluate("e => e.getBoundingClientRect().top + window.scrollY")
    page.evaluate(f"() => window.scrollTo(0, {top} + 420)")
    page.wait_for_function("() => window.scrollY > 0")
    box = bar.bounding_box()
    assert 0 < box["y"] < 140, box
    covering = page.evaluate(
        "([x, y]) => !!document.elementFromPoint(x, y).closest('.month-bar')",
        [box["x"] + 20, box["y"] + box["height"] / 2],
    )
    assert covering


def test_a_row_focused_from_below_is_not_left_under_the_month_bar(opened):
    page, _ = opened(body=crowded())
    links = page.locator(".tl-link")
    last = links.count() - 1
    links.nth(last).focus()
    page.evaluate("() => window.scrollTo(0, document.documentElement.scrollHeight)")
    # Shift+Tab walks up the list; the browser scrolls the previous link to the top edge.
    page.keyboard.press("Shift+Tab")
    page.keyboard.press("Shift+Tab")
    page.wait_for_function("() => document.activeElement.classList.contains('tl-link')")
    # The bar in force is the stuck one: the last whose top is at or above the link's.
    gap = page.evaluate(
        """() => {
            const top = document.activeElement.getBoundingClientRect().top;
            const bars = [...document.querySelectorAll('.month-bar')]
              .map((b) => b.getBoundingClientRect())
              .filter((b) => b.top <= top);
            return top - Math.max(...bars.map((b) => b.bottom));
        }"""
    )
    assert gap >= 0, gap


# --- the switch --------------------------------------------------------------------------


def test_the_view_switch_is_two_44px_buttons_in_the_filters_and_starts_on_list(opened):
    page, _ = opened()
    buttons = page.locator("#filters #chips-view .chip")
    assert buttons.all_inner_texts() == ["List", "Cadence"]
    assert page.get_attribute("#chips-view [data-v=list]", "aria-pressed") == "true"
    assert page.get_attribute("#chips-view [data-v=cadence]", "aria-pressed") == "false"
    for box in buttons.evaluate_all("els => els.map(e => e.getBoundingClientRect().toJSON())"):
        assert box["height"] >= TARGET and box["width"] >= TARGET
    assert page.locator("#lanes").is_hidden() and page.locator("#timeline").is_visible()


def test_choosing_cadence_sets_the_address_draws_a_lane_per_family_and_back_clears_it(opened):
    page, errors = opened()
    page.click("#chips-view [data-v=cadence]")
    lanes_open(page)
    assert page.url.endswith("/timeline/?view=cadence")
    assert page.get_attribute("#chips-view [data-v=cadence]", "aria-pressed") == "true"
    assert page.locator("#timeline").is_hidden() and page.locator("#tl-more").is_hidden()
    assert page.locator(".lanes-lane").count() == len(FAMILIES)
    labels = page.locator(".lanes-label").all_inner_texts()
    assert sorted(labels) == FAMILIES
    assert page.locator(".lanes-note").inner_text() == (
        "The last 12 months. Switch to List for older releases."
    )
    page.click("#chips-view [data-v=list]")
    page.wait_for_selector(".tl-item")
    assert "view=" not in page.url
    assert page.locator("#lanes").is_hidden()
    assert errors == []


def test_an_address_with_view_cadence_opens_the_lanes(opened):
    page, errors = opened("/timeline/?view=cadence")
    lanes_open(page)
    assert page.get_attribute("#chips-view [data-v=cadence]", "aria-pressed") == "true"
    assert page.locator("#timeline").is_hidden()
    assert errors == []


def test_an_unknown_view_is_the_list(opened):
    page, _ = opened("/timeline/?view=wide")
    assert page.get_attribute("#chips-view [data-v=list]", "aria-pressed") == "true"
    assert page.locator(".tl-item").count() > 0


def test_a_link_to_one_release_always_opens_the_list_and_its_row(opened):
    target = SNAPSHOT["releases"][3]["id"]
    page, _ = opened("/timeline/?view=cadence&id=" + quote(target, safe=""))
    page.wait_for_function("() => document.activeElement.closest('.tl-item') !== null")
    assert page.evaluate("document.activeElement.closest('.tl-item').dataset.id") == target
    assert page.get_attribute("#chips-view [data-v=list]", "aria-pressed") == "true"
    assert page.locator("#lanes").is_hidden()
    assert "view=" not in page.url and "id=" not in page.url


def test_the_filters_apply_in_cadence_and_the_count_line_follows(opened):
    page, _ = opened("/timeline/?view=cadence")
    lanes_open(page)
    page.click("#chips-family [data-v=iOS]")
    page.wait_for_function("() => document.querySelectorAll('.lanes-lane').length === 1")
    assert page.locator(".lanes-label").inner_text() == "iOS"
    assert page.url.endswith("?family=iOS&view=cadence")
    count = page.inner_text("#count")
    assert re.match(r"\d+ iOS releases? in the last 12 months", count), count
    assert int(count.split()[0]) == page.locator(".lanes-dot").count()
    page.click("#chips-stage [data-v=rc]")
    page.wait_for_function("() => document.querySelector('#count').textContent.startsWith('No')")
    page.click("#chips-stage [data-v=all]")
    lanes_open(page)
    page.click("#chips-view [data-v=list]")
    page.wait_for_selector(".tl-item")
    assert set(page.locator(".tl-fam").all_inner_texts()) == {"iOS"}
    assert page.url.endswith("?family=iOS")


# --- the lanes ---------------------------------------------------------------------------


def test_the_board_scrolls_inside_its_own_box_and_opens_at_the_newest_end(opened):
    page, errors = opened("/timeline/?view=cadence", width=360)
    lanes_open(page)
    assert page.evaluate("() => document.documentElement.scrollWidth") <= 360
    board = page.locator(".lanes-board")
    sizes = board.evaluate(
        "e => ({ client: e.clientWidth, scroll: e.scrollWidth, left: e.scrollLeft,"
        " overflow: getComputedStyle(e).overflowX })"
    )
    assert sizes["overflow"] == "auto" and sizes["scroll"] > sizes["client"]
    assert sizes["left"] > 0
    assert sizes["left"] + sizes["client"] >= sizes["scroll"] - 2
    assert page.locator(".lanes-today").count() == 1
    assert page.locator(".lanes-tick").count() >= 12
    assert errors == []


@pytest.mark.parametrize("theme", ["day", "night", "reactor"])
def test_each_dot_is_a_labelled_button_of_44px_in_every_theme(opened, theme):
    page, errors = opened("/timeline/?view=cadence", theme=theme)
    lanes_open(page)
    dots = page.locator(".lanes-dot")
    assert dots.count() > 0
    for box in dots.evaluate_all("els => els.map(e => e.getBoundingClientRect().toJSON())"):
        assert box["width"] >= TARGET and box["height"] >= TARGET, box
    label = dots.first.get_attribute("aria-label")
    pattern = r"[A-Za-z]+ [^,]+, [^,]+(, build [^,]+)?, [A-Z][a-z]{2} \d+, \d{4}"
    assert re.fullmatch(pattern, label), label
    assert dots.first.evaluate("e => e.tagName") == "BUTTON"
    assert page.evaluate("() => window.__csp") == []
    assert errors == []


def test_no_dot_is_clipped_by_the_board_and_none_starts_under_a_label(opened):
    # Fourteen iOS releases in two weeks fill all three rows of the one lane.
    page, _ = opened("/timeline/?view=cadence", body=crowded())
    lanes_open(page)
    edges = page.evaluate(
        """() => {
            const board = document.querySelector('.lanes-board').getBoundingClientRect();
            return [...document.querySelectorAll('.lanes-dot')].map((d) => {
                const b = d.getBoundingClientRect();
                return { clipped: b.bottom > board.bottom - 1 || b.top < board.top, y: b.bottom };
            });
        }"""
    )
    assert edges and not any(e["clipped"] for e in edges), edges
    page.evaluate("() => { document.querySelector('.lanes-board').scrollLeft = 0 }")
    first = page.evaluate(
        """() => {
            const label = document.querySelector('.lanes-label').getBoundingClientRect().right;
            const xs = [...document.querySelectorAll('.lanes-tick')].map((t) => t.getBoundingClientRect().left);
            return { label, tick: Math.min(...xs) };
        }"""
    )
    # The axis starts after the label, so the first month tick is not covered.
    assert first["tick"] >= first["label"], first


def test_each_lane_is_one_tab_stop_and_the_arrows_move_inside_and_across_lanes(opened):
    page, _ = opened("/timeline/?view=cadence")
    lanes_open(page)
    stops = page.locator(".lanes-lane").evaluate_all(
        "lanes => lanes.map(l => [...l.querySelectorAll('.lanes-dot')].map(d => d.tabIndex))"
    )
    for tabs in stops:
        if tabs:
            assert tabs.count(0) == 1 and tabs[-1] == 0, "the newest dot is the first stop"
    lane = page.locator(".lanes-lane").first
    ids = lane.locator(".lanes-dot").evaluate_all("els => els.map(e => e.dataset.id)")
    assert len(ids) >= 3, "the first lane needs a few dots for this test"
    lane.locator(".lanes-dot[tabindex='0']").focus()

    def active():
        return page.evaluate("document.activeElement.dataset.id")

    assert active() == ids[-1]
    page.keyboard.press("ArrowLeft")
    assert active() == ids[-2]
    page.keyboard.press("ArrowRight")
    assert active() == ids[-1]
    page.keyboard.press("ArrowRight")
    assert active() == ids[-1], "an end does not wrap"
    page.keyboard.press("Home")
    assert active() == ids[0]
    page.keyboard.press("End")
    assert active() == ids[-1]
    # The stop follows the focus: leaving and coming back lands on the same dot.
    page.keyboard.press("Home")
    assert lane.locator(".lanes-dot[tabindex='0']").get_attribute("data-id") == ids[0]
    assert lane.locator(".lanes-dot[tabindex='0']").count() == 1
    page.keyboard.press("ArrowDown")
    in_first = (
        "document.activeElement.closest('.lanes-lane') === document.querySelector('.lanes-lane')"
    )
    assert not page.evaluate(in_first)
    page.keyboard.press("ArrowUp")
    assert page.evaluate(in_first)


def test_activating_a_dot_fills_the_readout_with_its_links_and_show_in_list_reveals_the_row(opened):
    page, errors = opened("/timeline/?view=cadence")
    lanes_open(page)
    read = page.locator("#lanes-read")
    assert read.get_attribute("aria-live") == "polite"
    assert "Select a release" in read.inner_text()
    dot = page.locator(".lanes-lane").first.locator(".lanes-dot[tabindex='0']")
    release_id = dot.get_attribute("data-id")
    release = next(r for r in SNAPSHOT["releases"] if r["id"] == release_id)
    dot.focus()
    page.keyboard.press("Enter")
    text = read.inner_text()
    assert release["family"] in text and release["version"] in text
    if release["build"]:
        assert release["build"] in text
    source = read.locator("a", has_text="Source page")
    assert source.get_attribute("href") == release["url"]
    assert source.get_attribute("target") == "_blank"
    assert source.get_attribute("rel") == "noopener noreferrer"
    assert source.locator(".sr-only").text_content() == " (opens in a new tab)"
    show = read.locator("a", has_text="Show in list")
    assert show.get_attribute("href") == "/timeline/?id=" + quote(release_id, safe="-_.!~*'()")
    heights = read.locator("a").evaluate_all(
        "els => els.map(e => e.getBoundingClientRect().height)"
    )
    for height in heights:
        assert height >= TARGET
    show.click()
    page.wait_for_function("() => document.activeElement.closest('.tl-item') !== null")
    assert page.evaluate("document.activeElement.closest('.tl-item').dataset.id") == release_id
    assert page.get_attribute("#chips-view [data-v=list]", "aria-pressed") == "true"
    assert errors == []


def test_a_click_chooses_a_dot_and_the_choice_survives_a_poll_that_changes_nothing(opened):
    page, _ = opened("/timeline/?view=cadence")
    lanes_open(page)
    dot = page.locator(".lanes-lane").first.locator(".lanes-dot[tabindex='0']")
    release_id = dot.get_attribute("data-id")
    dot.click()
    assert page.locator(".lanes-dot.is-sel").get_attribute("data-id") == release_id
    page.evaluate("RO.refresh()")
    page.evaluate("() => new Promise(r => setTimeout(r, 300))")
    assert page.locator(".lanes-dot.is-sel").get_attribute("data-id") == release_id
    assert page.evaluate("document.activeElement.dataset.id") == release_id


def test_a_poll_with_a_new_release_redraws_and_keeps_the_focused_dot(opened):
    first = crowded()
    page, _ = opened("/timeline/?view=cadence", body=first)
    lanes_open(page)
    focus_id = page.locator(".lanes-dot[tabindex='0']").get_attribute("data-id")
    page.focus(f'.lanes-dot[data-id="{focus_id}"]')
    newest = {
        **first["releases"][0],
        "id": "fresh",
        "version": "26.99",
        "date": "2026-10-12T00:00:00Z",
    }
    second = {**first, "releases": [newest, *first["releases"]]}
    page.route(
        "**/api/releases.json",
        lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps(second)
        ),
    )
    page.evaluate("RO.refresh()")
    page.wait_for_selector('.lanes-dot[data-id="fresh"]')
    assert page.evaluate("document.activeElement.dataset.id") == focus_id


def test_lanes_js_loads_only_when_the_view_is_first_shown(opened):
    page, _ = opened()
    names = page.evaluate("() => performance.getEntriesByType('resource').map(e => e.name)")
    assert not any(n.endswith("/assets/lanes.js") for n in names)
    page.click("#chips-view [data-v=cadence]")
    lanes_open(page)
    names = page.evaluate("() => performance.getEntriesByType('resource').map(e => e.name)")
    assert sum(n.endswith("/assets/lanes.js") for n in names) == 1


def test_if_lanes_js_cannot_load_the_view_says_so_and_list_still_works(browser, base_url):
    context = make_context(browser, base_url)
    try:
        page = context.new_page()
        failures: list[str] = []
        page.on("pageerror", lambda e: failures.append(str(e)))
        page.route("**/assets/lanes.js", lambda route: route.abort())
        page.goto(base_url + "/timeline/?view=cadence")
        page.wait_for_function(
            "() => document.querySelector('#lanes').textContent.includes('could not load')"
        )
        assert page.locator(".lanes-lane").count() == 0
        page.click("#chips-view [data-v=list]")
        page.wait_for_selector(".tl-item")
        assert page.locator("#lanes").is_hidden()
        assert failures == []
    finally:
        context.close()


def test_the_lanes_respect_reduced_motion(opened):
    page, _ = opened("/timeline/?view=cadence")
    lanes_open(page)
    behavior = page.locator(".lanes-board").evaluate("e => getComputedStyle(e).scrollBehavior")
    assert behavior == "auto"


def test_the_cadence_view_passes_the_page_audit_and_sideways_check_at_320(opened):
    page, errors = opened("/timeline/?view=cadence", width=320)
    lanes_open(page)
    assert page.evaluate("() => document.documentElement.scrollWidth") <= 320
    problems = page.evaluate((REPO / "tests" / "audit.js").read_text(encoding="utf-8"))
    assert problems == []
    assert errors == []
