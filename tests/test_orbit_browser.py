"""The Release Orbit dial, the time machine and the effects, driven in a real browser.

The clock is fixed (``Date.now`` is 2026-10-12 12:00 UTC) so the window of the dial and the
day the hand points at are the same on every run; the data is the repository's snapshot, which
the test server answers as ``/api/releases.json``. Like the other browser tests, these need the
``playwright`` package and a browser, and are skipped without them unless ``REQUIRE_BROWSER=1``.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone

import pytest
from helpers import REPO

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

SNAPSHOT = json.loads((REPO / "src" / "data" / "releases.json").read_text(encoding="utf-8"))
FAMILIES = ["iOS", "iPadOS", "macOS", "watchOS", "tvOS", "visionOS"]
NOW = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)  # noqa: UP017
CLOCK = "(() => { const t = Date.parse('2026-10-12T12:00:00Z'); Date.now = () => t; })();"
RECORD = """
window.__csp = [];
document.addEventListener("securitypolicyviolation", (e) => {
  window.__csp.push(e.violatedDirective + " " + e.blockedURI);
});
"""
# A browser that reports plenty of cores but has no WebGL.
NO_WEBGL = """
const real = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
  return /webgl/.test(kind) ? null : real.call(this, kind, ...rest);
};
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
"""
MANY_CORES = "Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });"
HAND = "#orbit-dial .hand"
IOS = "#latest-grid [data-family='iOS']"


def make_context(browser, base_url, width=1280, motion="reduce", scripts=(), **options):
    context = browser.new_context(
        viewport={"width": width, "height": 900}, reduced_motion=motion, **options
    )
    for script in (RECORD, CLOCK, *scripts):
        context.add_init_script(script)
    # The web fonts are an outside request: answer them empty so nothing waits or logs.
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


def when(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def in_window(weeks: int, data=SNAPSHOT) -> int:
    start = NOW - timedelta(weeks=weeks)
    return sum(
        1
        for r in data["releases"]
        if r["family"] in FAMILIES and start <= when(r["date"]) <= NOW
    )


def open_front_page(page, base_url):
    page.goto(base_url + "/")
    page.wait_for_selector("#orbit-dial .notch")
    page.wait_for_selector(f"{IOS} .sigil svg")


def serve(page, data):
    page.route(
        "**/api/releases.json",
        lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps(data)
        ),
    )


def show_stage(page):
    page.evaluate("() => document.getElementById('orbit-stage').scrollIntoView({block: 'center'})")


def pending(page):
    page.wait_for_function(
        "() => /as of/i.test(document.getElementById('orbit-live').textContent)"
    )


def text(page, selector):
    return page.text_content(selector).strip()


# --- the dial ---------------------------------------------------------------------------


def test_the_dial_has_one_notch_per_release_in_the_window(page, base_url):
    open_front_page(page, base_url)
    weeks = int(page.get_attribute("#orbit-dial", "data-weeks"))
    # The snapshot spans under 26 weeks of the fixed clock, so the default window stays.
    assert weeks == 26
    assert page.locator("#orbit-dial .ring").count() == len(FAMILIES)
    assert page.locator("#orbit-dial .notch").count() == in_window(weeks)
    assert page.locator("#orbit-dial .notch").count() > 0
    # One ring per family, the first family outermost.
    radii = page.evaluate(
        "() => [...document.querySelectorAll('#orbit-dial .ring')].map("
        "r => [r.getAttribute('data-family'), Number(r.getAttribute('r'))])"
    )
    assert [name for name, _ in radii] == FAMILIES
    assert [radius for _, radius in radii] == sorted((r for _, r in radii), reverse=True)


def test_the_window_widens_to_52_weeks_when_the_data_spans_it(page, base_url):
    data = json.loads(json.dumps(SNAPSHOT))
    old = dict(data["releases"][-1])
    old["id"] = old["id"] + "-old"
    old["url"] = old["url"] + "-old"
    old["date"] = "2026-01-12T17:00:00Z"
    data["releases"].append(old)
    serve(page, data)
    open_front_page(page, base_url)
    assert page.get_attribute("#orbit-dial", "data-weeks") == "52"
    assert page.locator("#orbit-dial .notch").count() == in_window(52, data)
    assert "52" in text(page, "#orbit-weeks")


def test_betas_are_shorter_and_thinner_than_releases_in_the_same_full_colour(page, base_url):
    open_front_page(page, base_url)
    rows = page.evaluate(
        """() => {
          const measure = (g) => {
            const line = g.querySelector('.nl');
            const style = getComputedStyle(line);
            return {
              length: Math.hypot(line.x1.baseVal.value - line.x2.baseVal.value,
                                 line.y1.baseVal.value - line.y2.baseVal.value),
              width: Number(line.getAttribute('stroke-width')),
              opaque: style.strokeOpacity === '1' && getComputedStyle(g).opacity === '1',
              inFamilyColour: style.stroke === getComputedStyle(g.closest('.lane')).color,
            };
          };
          const group = (kind) => [
            ...document.querySelectorAll("#orbit-dial .notch." + kind),
          ].map(measure);
          return { release: group('release'), beta: group('beta') };
        }"""
    )
    assert rows["release"] and rows["beta"]
    assert max(n["length"] for n in rows["beta"]) < min(n["length"] for n in rows["release"])
    assert max(n["width"] for n in rows["beta"]) < min(n["width"] for n in rows["release"])
    for note in rows["release"] + rows["beta"]:
        assert note["opaque"] and note["inFamilyColour"]


def test_a_notch_is_untested_until_a_verdict_exists(page, base_url):
    data = json.loads(json.dumps(SNAPSHOT))
    data["releases"][0]["status"] = "pass"
    data["releases"][1]["status"] = "fail"
    serve(page, data)
    open_front_page(page, base_url)
    total = page.locator("#orbit-dial .notch").count()
    assert page.locator("#orbit-dial .notch[data-status='pass']").count() == 1
    assert page.locator("#orbit-dial .notch[data-status='fail']").count() == 1
    assert page.locator("#orbit-dial .mk-untested").count() == total - 2
    assert page.locator("#orbit-dial .mk-pass").count() == 1
    assert page.locator("#orbit-dial .mk-fail").count() == 1
    assert "validation passed" in page.get_attribute(
        "#orbit-dial .notch[data-status='pass']", "aria-label"
    )


def test_a_notch_opens_a_card_with_its_sigil_build_date_and_link(page, base_url):
    open_front_page(page, base_url)
    notch = page.locator("#orbit-dial .notch[aria-label*='24B5099f']").first
    assert notch.get_attribute("role") == "button"
    notch_id = notch.get_attribute("data-id")
    notch.focus()
    page.wait_for_selector("#orbit-card:not([hidden])")
    card = page.locator("#orbit-card")
    words = card.inner_text()
    assert "27.2 beta 3" in words and "24B5099f" in words and "Oct 5, 2026" in words
    assert card.locator(".sigil svg").count() == 1
    assert card.locator(".sigil").get_attribute("data-build") == "24B5099f"
    assert card.locator("a").get_attribute("href").startswith("https://developer.apple.com/")
    page.keyboard.press("Enter")  # pins the card
    page.mouse.move(1, 1)
    page.wait_for_timeout(500)
    assert page.locator("#orbit-card").is_visible()
    page.focus("#orbit-card a")
    assert page.locator("#orbit-card").is_visible()
    page.keyboard.press("Escape")
    assert page.locator("#orbit-card").is_hidden()
    # Focus goes back to the notch the card belonged to, not to the top of the page.
    assert page.evaluate("() => document.activeElement.getAttribute('data-id')") == notch_id
    assert page.locator("#orbit-dial .notch[tabindex='0']").get_attribute("data-id") == notch_id


def test_hovering_a_notch_shows_its_card(page, base_url):
    open_front_page(page, base_url)
    show_stage(page)
    notch = page.locator("#orbit-dial .notch[aria-label*='23G90']").first
    box = notch.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.wait_for_selector("#orbit-card:not([hidden])")
    assert "23G90" in page.inner_text("#orbit-card")


def test_a_tap_on_a_notch_pins_its_card(browser, base_url):
    context = make_context(browser, base_url, width=390, has_touch=True)
    try:
        page = context.new_page()
        open_front_page(page, base_url)
        show_stage(page)
        box = page.locator("#orbit-dial .notch[aria-label*='24B5099f']").first.bounding_box()
        page.touchscreen.tap(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_selector("#orbit-card:not([hidden])")
        page.wait_for_timeout(400)
        assert page.locator("#orbit-card").is_visible()
    finally:
        context.close()


def test_the_dial_is_a_slider_and_the_notches_are_reachable_by_arrow_keys(page, base_url):
    open_front_page(page, base_url)
    hand = page.locator(HAND)
    assert hand.get_attribute("role") == "slider"
    assert hand.get_attribute("aria-label")
    assert hand.get_attribute("aria-valuetext") == "Now, Oct 12, 2026"
    assert hand.get_attribute("aria-valuemax") == "182"
    # One tab stop for all the notches; the arrow keys move between them.
    assert page.locator("#orbit-dial .notch[tabindex='0']").count() == 1
    page.locator("#orbit-dial .notch[tabindex='0']").focus()
    first = page.evaluate("() => document.activeElement.getAttribute('data-id')")
    page.keyboard.press("ArrowLeft")
    second = page.evaluate("() => document.activeElement.getAttribute('data-id')")
    assert first != second
    assert page.locator("#orbit-dial .notch[tabindex='0']").count() == 1


# --- the time machine -------------------------------------------------------------------


def test_keyboard_scrub_changes_the_grid_and_announces_then_back_to_now_restores(page, base_url):
    open_front_page(page, base_url)
    assert text(page, f"{IOS} [data-f=ver]") == "iOS 27.2"
    assert page.get_attribute(f"{IOS} .sigil", "data-build") == "24B5099f"
    assert page.is_hidden("#orbit-back")

    page.focus(HAND)
    page.keyboard.press("PageDown")
    page.keyboard.press("PageDown")
    pending(page)
    assert page.get_attribute(HAND, "aria-valuetext") == "As of Sep 28, 2026"
    assert text(page, f"{IOS} [data-f=ver]") == "iOS 27.0.1"
    assert page.get_attribute(f"{IOS} .sigil", "data-build") == "24A446"
    assert "27.0.1" in text(page, "#ios [data-f=latest]")
    assert "Sep 28, 2026" in text(page, "#latest-asof")
    assert page.is_visible("#latest-asof")
    assert "Sep 28, 2026" in text(page, "#orbit-live")
    assert page.is_visible("#orbit-back")

    # Going back is only by the button: nothing springs on its own.
    page.wait_for_timeout(600)
    assert text(page, f"{IOS} [data-f=ver]") == "iOS 27.0.1"
    page.click("#orbit-back")
    assert text(page, f"{IOS} [data-f=ver]") == "iOS 27.2"
    assert page.get_attribute(f"{IOS} .sigil", "data-build") == "24B5099f"
    assert page.is_hidden("#orbit-back")
    assert page.is_hidden("#latest-asof")
    assert page.evaluate("() => document.activeElement.classList.contains('hand')")
    page.wait_for_function(
        "() => document.getElementById('orbit-live').textContent === 'Showing the latest releases.'"
    )
    assert page.get_attribute(HAND, "aria-valuetext") == "Now, Oct 12, 2026"


def test_the_hand_moves_by_a_day_a_week_and_to_the_ends(page, base_url):
    open_front_page(page, base_url)
    page.focus(HAND)
    page.keyboard.press("ArrowLeft")
    assert page.get_attribute(HAND, "aria-valuetext") == "As of Oct 11, 2026"
    page.keyboard.press("ArrowRight")
    assert page.get_attribute(HAND, "aria-valuetext") == "Now, Oct 12, 2026"
    page.keyboard.press("ArrowRight")  # nothing lies beyond now
    assert page.get_attribute(HAND, "aria-valuetext") == "Now, Oct 12, 2026"
    page.keyboard.press("PageDown")
    assert page.get_attribute(HAND, "aria-valuetext") == "As of Oct 5, 2026"
    page.keyboard.press("PageUp")
    assert page.get_attribute(HAND, "aria-valuetext") == "Now, Oct 12, 2026"
    page.keyboard.press("Home")
    assert int(page.get_attribute(HAND, "aria-valuenow")) <= 1
    # Before the first release the card says so, and its sigil row goes.
    assert text(page, f"{IOS} [data-f=ver]") == "No release yet"
    assert page.is_hidden(f"{IOS} .rel-sig")
    page.keyboard.press("End")
    assert page.get_attribute(HAND, "aria-valuetext") == "Now, Oct 12, 2026"
    assert text(page, f"{IOS} [data-f=ver]") == "iOS 27.2"


def test_the_hand_can_be_dragged_and_stays_where_it_is_put(page, base_url):
    open_front_page(page, base_url)
    show_stage(page)
    box = page.locator("#orbit-stage").bounding_box()
    scale = box["width"] / 660
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    # From the knob at 12 o'clock, anticlockwise to 9 o'clock: three quarters of the window.
    page.mouse.move(cx, cy - 292 * scale)
    page.mouse.down()
    page.mouse.move(cx - 150 * scale, cy - 160 * scale, steps=8)
    page.mouse.move(cx - 220 * scale, cy, steps=8)
    page.mouse.up()
    assert page.is_visible("#orbit-back")
    assert 133 <= int(page.get_attribute(HAND, "aria-valuenow")) <= 140
    assert text(page, f"{IOS} [data-f=ver]") == "iOS 18.7.10"
    page.wait_for_timeout(500)
    assert page.is_visible("#orbit-back")
    assert text(page, f"{IOS} [data-f=ver]") == "iOS 18.7.10"
    page.click("#orbit-back")
    assert text(page, f"{IOS} [data-f=ver]") == "iOS 27.2"


def release_of(family: str, version: str):
    return next(
        r for r in SNAPSHOT["releases"] if r["family"] == family and r["version"] == version
    )


def centre_of(page, release_id):
    return page.evaluate(
        """(id) => {
          const g = [...document.querySelectorAll('#orbit-dial .notch')]
            .find((n) => n.getAttribute('data-id') === id);
          const b = g.getBoundingClientRect();
          return [b.x + b.width / 2, b.y + b.height / 2];
        }""",
        release_id,
    )


@pytest.mark.parametrize("width", [320, 390, 1280])
def test_the_hands_grab_area_is_at_least_44_css_pixels(browser, base_url, width):
    context = make_context(browser, base_url, width=width)
    try:
        page = context.new_page()
        open_front_page(page, base_url)
        assert page.locator(f"{HAND} .hit").count() == 1, "only the knob takes the pointer"
        box = page.locator(f"{HAND} .hit").bounding_box()
        assert box["width"] >= 43.9 and box["height"] >= 43.9
    finally:
        context.close()


def test_a_notch_under_the_hand_can_still_be_hovered(page, base_url):
    open_front_page(page, base_url)
    page.focus(HAND)
    page.keyboard.press("PageDown")
    page.keyboard.press("PageDown")
    pending(page)
    assert page.get_attribute(HAND, "aria-valuetext") == "As of Sep 28, 2026"
    show_stage(page)
    target = release_of("macOS", "27.0.1")
    x, y = centre_of(page, target["id"])
    # The hand points at the day the release landed; it must not sit on top of the notch.
    assert page.evaluate(
        "([x, y]) => !!document.elementFromPoint(x, y).closest('.notch')", [x, y]
    )
    page.mouse.move(x, y)
    page.wait_for_selector("#orbit-card:not([hidden])")
    assert page.get_attribute("#orbit-card", "data-id") == target["id"]


def stacked_releases():
    """Groups of releases of one family stamped at the same moment, inside the window."""
    start = NOW - timedelta(weeks=26)
    groups: dict = {}
    for r in SNAPSHOT["releases"]:
        if r["family"] in FAMILIES and start <= when(r["date"]) <= NOW:
            groups.setdefault((r["family"], r["date"]), []).append(r)
    return [g for g in groups.values() if len(g) > 1]


def test_releases_stamped_at_one_moment_each_have_their_own_notch_to_open(page, base_url):
    stacks = stacked_releases()
    assert stacks, "the snapshot is expected to hold several same-moment releases"
    open_front_page(page, base_url)
    show_stage(page)
    for group in stacks:
        centres = [centre_of(page, r["id"]) for r in group]
        for i, a in enumerate(centres):
            for b in centres[i + 1 :]:
                assert abs(a[0] - b[0]) + abs(a[1] - b[1]) > 4, "the notches overlap"
        for release, (x, y) in zip(group, centres):
            page.mouse.move(1, 1)
            page.mouse.move(x, y)
            page.wait_for_function(
                "(id) => document.getElementById('orbit-card').getAttribute('data-id') === id",
                arg=release["id"],
            )


def test_hovering_the_knob_opens_the_notch_beneath_it(page, base_url):
    open_front_page(page, base_url)
    page.focus(HAND)
    page.keyboard.press("PageDown")
    page.keyboard.press("PageDown")
    pending(page)
    show_stage(page)
    knob = page.locator(f"{HAND} .hit").bounding_box()
    page.mouse.move(knob["x"] + knob["width"] / 2, knob["y"] + knob["height"] / 2)
    page.wait_for_selector("#orbit-card:not([hidden])")
    assert page.get_attribute("#orbit-card", "data-id") == release_of("iOS", "27.0.1")["id"]


# --- reduced motion, the effects and the fallback --------------------------------------


def test_reduced_motion_has_no_animation_and_no_effects_module_or_canvas(page, base_url):
    open_front_page(page, base_url)
    # Long enough for the idle callback that would load the effects (its timeout is 3 s).
    page.wait_for_timeout(3600)
    loaded = page.evaluate("() => performance.getEntriesByType('resource').map(e => e.name)")
    assert not [name for name in loaded if re.search(r"/(fx|aurora)\.js$", name)]
    assert page.locator(".aurora canvas").count() == 0
    assert page.evaluate("() => document.documentElement.className.includes('fx-')") is False
    moving = page.evaluate(
        """() => [...document.querySelectorAll('body *')].filter((el) => {
          const s = getComputedStyle(el);
          return (s.animationName !== 'none' && parseFloat(s.animationDuration) > 0) ||
            s.transitionDuration.split(',').some((d) => parseFloat(d) > 0);
        }).map((el) => el.tagName + '.' + String(el.getAttribute('class')))"""
    )
    assert moving == []
    flat = "() => getComputedStyle(document.getElementById('orbit-dial')).transform"
    assert page.evaluate(flat) == "none"


def test_without_webgl_the_css_gradient_stays_and_nothing_logs_an_error(browser, base_url):
    context = make_context(browser, base_url, motion="no-preference", scripts=[NO_WEBGL])
    try:
        page = context.new_page()
        errors: list[str] = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        open_front_page(page, base_url)
        page.wait_for_function(
            "() => performance.getEntriesByType('resource')"
            ".some(e => /\\/aurora\\.js$/.test(e.name))",
            timeout=15000,
        )
        page.wait_for_timeout(300)
        assert page.locator(".aurora canvas").count() == 0
        shown = "() => getComputedStyle(document.querySelector('.aurora i')).display"
        assert page.evaluate(shown) != "none"
        assert errors == []
        assert page.evaluate("() => window.__csp") == []
    finally:
        context.close()


def test_the_effects_load_after_the_page_and_the_page_stays_clean_while_they_run(browser, base_url):
    context = make_context(browser, base_url, motion="no-preference", scripts=[MANY_CORES])
    try:
        page = context.new_page()
        errors: list[str] = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        open_front_page(page, base_url)
        # Not part of the first paint: the effects module is not in the page's own scripts.
        html = page.request.get(base_url + "/").text()
        assert "fx.js" not in html and "aurora.js" not in html
        page.wait_for_function(
            "() => performance.getEntriesByType('resource').some(e => /\\/fx\\.js$/.test(e.name))",
            timeout=15000,
        )
        page.wait_for_function("() => document.documentElement.classList.contains('fx-glass')")
        # Use the page: a card, the hand, the hover highlight, a scroll away and back.
        show_stage(page)
        page.locator("#orbit-dial .notch").first.focus()
        page.keyboard.press("Enter")
        page.focus(HAND)
        page.keyboard.press("PageDown")
        page.locator(f"{IOS}").scroll_into_view_if_needed()
        box = page.locator(IOS).bounding_box()
        page.mouse.move(box["x"] + 40, box["y"] + 40)
        page.wait_for_function(
            "() => document.querySelector(\"#latest-grid [data-family='iOS']\")"
            ".style.getPropertyValue('--mx') !== ''"
        )
        page.evaluate("() => window.scrollTo(0, 0)")
        page.wait_for_timeout(300)
        assert errors == []
        assert page.evaluate("() => window.__csp") == []
    finally:
        context.close()


def test_the_dial_tilts_back_as_it_scrolls_away_and_is_flat_while_in_view(browser, base_url):
    context = make_context(browser, base_url, motion="no-preference")
    try:
        page = context.new_page()
        open_front_page(page, base_url)
        flat = "() => getComputedStyle(document.getElementById('orbit-dial')).transform"
        show_stage(page)
        page.wait_for_timeout(200)
        assert page.evaluate(flat) in {"none", "matrix(1, 0, 0, 1, 0, 0)"}
        page.evaluate(
            "() => window.scrollTo(0, document.getElementById('orbit-stage')"
            ".getBoundingClientRect().bottom + scrollY + 300)"
        )
        # Scroll-driven where the browser has it; otherwise a class set by the effects module.
        page.wait_for_function(
            "() => getComputedStyle(document.getElementById('orbit-dial')).transform"
            ".startsWith('matrix3d')",
            timeout=15000,
        )
    finally:
        context.close()


# --- layout and security ---------------------------------------------------------------


def test_nothing_scrolls_sideways_at_320_with_a_card_open_and_the_hand_moved(browser, base_url):
    context = make_context(browser, base_url, width=320)
    try:
        page = context.new_page()
        open_front_page(page, base_url)
        wide = "() => document.documentElement.scrollWidth"
        assert page.evaluate(wide) <= 320
        page.locator("#orbit-dial .notch").last.focus()
        page.keyboard.press("Enter")
        page.wait_for_selector("#orbit-card:not([hidden])")
        assert page.evaluate(wide) <= 320
        card = page.locator("#orbit-card").bounding_box()
        stage = page.locator("#orbit-stage").bounding_box()
        assert card["x"] >= stage["x"] - 1
        assert card["x"] + card["width"] <= stage["x"] + stage["width"] + 1
        page.focus(HAND)
        page.keyboard.press("PageDown")
        page.keyboard.press("PageDown")
        pending(page)
        assert page.evaluate(wide) <= 320
        assert page.evaluate("() => window.__csp") == []
    finally:
        context.close()
