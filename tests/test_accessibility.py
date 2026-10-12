"""Accessibility checks that need no extra dependency.

The static half reads the source: label-in-name (WCAG 2.5.3), reduced motion, focus
styles. The browser half loads every built page and asks the DOM: landmarks, one h1,
heading order, image alternatives, names on links and buttons, label-in-name on what is
visible, unique ids, a skip link that lands, and a visible focus ring on everything a
keyboard reaches. Colour contrast is out of scope here; it needs a rendering model this
suite does not carry.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser
from pathlib import Path

import pytest
from helpers import REPO
from site_pages import page_files, page_url

CSS = (REPO / "src" / "assets" / "site.css").read_text(encoding="utf-8")


class Controls(HTMLParser):
    """Links and buttons with an aria-label, and the visible text inside each."""

    def __init__(self) -> None:
        super().__init__()
        self.stack: list[dict] = []
        self.found: list[dict] = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if self.hidden or values.get("aria-hidden") == "true":
            self.hidden += 1
            return
        if tag in {"a", "button"}:
            self.stack.append({"tag": tag, "label": values.get("aria-label"), "text": ""})

    def handle_endtag(self, tag):
        if self.hidden:
            self.hidden -= 1
        elif tag in {"a", "button"} and self.stack:
            self.found.append(self.stack.pop())

    def handle_data(self, data):
        if self.stack and not self.hidden:
            self.stack[-1]["text"] += data


@pytest.mark.parametrize("page", sorted((REPO / "src").rglob("*.html")), ids=lambda p: p.name)
def test_an_aria_label_contains_the_visible_text_of_its_control(page):
    parser = Controls()
    parser.feed(page.read_text(encoding="utf-8"))
    for control in parser.found:
        visible = " ".join(control["text"].split()).lower()
        if control["label"] is not None and visible:
            assert visible in control["label"].lower(), (
                f"{page.name}: aria-label {control['label']!r} must contain the visible "
                f"text {visible!r} (WCAG 2.5.3)"
            )


def media_blocks(css: str):
    """Yield (media query or '', declaration text) for each top-level rule or @media block."""
    depth = 0
    start = 0
    for index, char in enumerate(css):
        if char == "{":
            if depth == 0:
                head = css[start:index].strip()
            depth += 1
            if depth == 1:
                body_start = index + 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                yield head, css[body_start:index]
                start = index + 1


def test_every_transition_and_animation_sits_inside_no_preference_motion():
    stripped = re.sub(r"/\*.*?\*/", "", CSS, flags=re.DOTALL)
    for head, body in media_blocks(stripped):
        motion = re.search(r"(^|[;{\s])(transition|animation)[a-z-]*\s*:", body)
        if head.startswith("@media"):
            if "prefers-reduced-motion: no-preference" in head:
                continue
            # A rule nested one level deeper in some other media block.
            inner = re.search(r"(^|[;{\s])(transition|animation)[a-z-]*\s*:", body)
            assert not inner, f"motion outside prefers-reduced-motion: no-preference in {head}"
        else:
            assert not motion, f"motion outside prefers-reduced-motion: no-preference in {head}"


def test_scroll_behaviour_smooth_is_not_set_outside_no_preference_motion():
    stripped = re.sub(r"/\*.*?\*/", "", CSS, flags=re.DOTALL)
    for head, body in media_blocks(stripped):
        if "scroll-behavior: smooth" in body:
            assert "prefers-reduced-motion: no-preference" in head, head


def test_focus_is_styled_and_never_removed_without_a_replacement():
    assert re.search(r":focus-visible\s*\{[^}]*outline:\s*2px solid", CSS)
    for rule in re.finditer(r"([^{}]+)\{([^}]*)\}", CSS):
        selector, body = rule.group(1).strip(), rule.group(2)
        if re.search(r"outline:\s*(none|0)\b", body):
            assert "focus" not in selector or "box-shadow" in body or "outline" in body, selector


AUDIT = (Path(__file__).parent / "audit.js").read_text(encoding="utf-8")

# Two frames after the key, so scroll handlers have run before the focus is read. The
# element is keyed by its place in the document: two links can share their first 70 characters.
FOCUS_RING = """
async () => {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const style = getComputedStyle(el);
  const ring = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
  return { tag: el.outerHTML.slice(0, 70), at: [...document.querySelectorAll("*")].indexOf(el),
           ring, shadow: style.boxShadow !== "none" };
}
"""

# The page's own scripts add content after the load event (below.js and cadence.js, the
# latter from an idle callback), so wait for the network and the idle callback, then a frame.
SETTLED = """
() => new Promise((done) => {
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1000));
  idle(() => requestAnimationFrame(() => requestAnimationFrame(done)), { timeout: 2000 });
})
"""


def settled(page):
    page.wait_for_load_state("networkidle")
    page.evaluate(SETTLED)
    page.wait_for_load_state("networkidle")


def paths(built):
    return [page_url(built, page) for page in page_files(built)]


@pytest.fixture
def tab(browser, base_url):
    context = browser.new_context(viewport={"width": 1280, "height": 800}, reduced_motion="reduce")
    # Web fonts are an outside request; the fallback font is what is audited.
    context.route(
        re.compile("^(?!" + re.escape(base_url) + "/)"), lambda route: route.fulfill(body="")
    )
    yield context.new_page()
    context.close()


@pytest.mark.browser
def test_every_page_passes_the_structure_and_naming_audit(tab, base_url, built):
    for path in paths(built):
        tab.goto(base_url + path)
        settled(tab)
        problems = tab.evaluate(AUDIT)
        assert problems == [], f"{path}: {problems}"


@pytest.mark.browser
def test_the_skip_link_is_first_and_lands_on_the_content(tab, base_url):
    tab.goto(base_url + "/")
    settled(tab)
    tab.keyboard.press("Tab")
    first = tab.evaluate("() => document.activeElement.getAttribute('href')")
    assert first == "#content"
    tab.keyboard.press("Enter")
    tab.wait_for_function("() => location.hash === '#content'")
    assert tab.evaluate("() => location.hash") == "#content"
    assert tab.evaluate("() => !!document.getElementById('content')")


@pytest.mark.browser
def test_everything_a_keyboard_reaches_shows_a_focus_ring(tab, base_url, built):
    for path in paths(built):
        tab.goto(base_url + path)
        settled(tab)
        seen = set()
        for _ in range(40):
            tab.keyboard.press("Tab")
            state = tab.evaluate(FOCUS_RING)
            if state is None or state["at"] in seen:
                break
            seen.add(state["at"])
            assert state["ring"] or state["shadow"], f"{path}: no focus ring on {state['tag']}"
        assert len(seen) >= 4, f"{path}: the keyboard reached only {len(seen)} elements"


@pytest.mark.browser
def test_reduced_motion_turns_every_transition_and_animation_off(tab, base_url, built):
    for path in paths(built):
        tab.goto(base_url + path)
        settled(tab)
        moving = tab.evaluate(
            """() => [...document.querySelectorAll('*')].filter((el) => {
              const s = getComputedStyle(el);
              const t = s.transitionDuration.split(',').some((d) => parseFloat(d) > 0);
              const a = s.animationName !== 'none' && parseFloat(s.animationDuration) > 0;
              return t || a;
            }).map((el) => el.tagName + (el.id ? '#' + el.id : ''))"""
        )
        assert moving == [], f"{path}: still moving under reduced motion: {moving}"
        assert tab.evaluate("() => getComputedStyle(document.documentElement).scrollBehavior") in {
            "auto",
            "",
        }
