"""The security notes on the timeline and Compare, driven in Chromium with a mocked payload.

The real src/data/security.json is empty, so each test serves its own schema-1 payload for the
release ids of the bundled snapshot. The clock is fixed so the 14-day and 30-day rules are
the same on every run.
"""

from __future__ import annotations

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
CLOCK = "(() => { const t = Date.parse('2026-10-12T12:00:00Z'); Date.now = () => t; })();"
RECORD = """
window.__csp = [];
document.addEventListener("securitypolicyviolation", (e) => {
  window.__csp.push(e.violatedDirective + " " + e.blockedURI);
});
"""
GENERATED = "2026-10-11T00:00:00Z"
CHECKED = "2026-10-10T00:00:00Z"
TARGET = 44
APPLE = "https://example.org/apple/"
ANDROID = "https://example.org/android/"


def releases(family, stage="release"):
    return [r for r in SNAPSHOT["releases"] if r["family"] == family and r["stage"] == stage]


def cve(n):
    return f"CVE-2026-{n:04d}"


def note(source, title, numbers, severity=None):
    cves = [{"id": cve(n), "severity": (severity or {}).get(n)} for n in sorted(numbers)]
    return {"source": source, "title": title, "published": None, "cves": cves}


def entry(status, notes=(), numbers=(), patch=None):
    listed = status == "listed"
    return {
        "status": status,
        "notes": sorted(notes),
        "cves": [cve(n) for n in sorted(numbers)],
        "count": len(numbers) if listed else (0 if status == "no-cve-entries" else None),
        "patchLevel": patch,
        "checkedAt": CHECKED,
    }


def payload(notes, rows):
    sources = {"apple": {"status": "ok"}, "android": {"status": "ok"}}
    return {
        "schema": 1,
        "generatedAt": GENERATED,
        "sources": sources,
        "notes": notes,
        "releases": rows,
    }


def apple_payload(big=False):
    ios = releases("iOS")
    a, b, c = APPLE + "100001", APPLE + "100002", APPLE + "100003"
    first = range(1, 26) if big else range(1, 5)
    notes = {
        a: note("apple", "iOS newest", first, {1: "High"} if not big else None),
        b: note("apple", "iOS older", [3, 4]),
        c: note("apple", "iOS none", []),
    }
    rows = {
        ios[0]["id"]: entry("listed", [a], first),
        ios[1]["id"]: entry("listed", [b], [3, 4]),
        ios[2]["id"]: entry("no-cve-entries", [c]),
        ios[3]["id"]: entry("not-found"),
        ios[4]["id"]: entry("unavailable"),
    }
    return payload(notes, rows)


def android_payload(missing=None, newer_patch="2026-06-05"):
    android = releases("Android")
    newer, older = android[0], android[1]
    months = ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]
    notes = {}
    for index, month in enumerate(months):
        if month != missing:
            notes[ANDROID + month + "-01"] = note("android", month, [100 + index])
    rows = {
        newer["id"]: entry("listed", [ANDROID + "2026-06-01"], [106], newer_patch),
        older["id"]: entry("listed", [ANDROID + "2025-12-01"], [100], "2025-12-05"),
    }
    return payload(notes, rows)


def make_context(browser, base_url, width=1280, theme=None):
    context = browser.new_context(viewport={"width": width, "height": 900}, reduced_motion="reduce")
    context.add_init_script(RECORD)
    context.add_init_script(CLOCK)
    if theme:
        context.add_init_script(
            f"try {{ localStorage.setItem('theme', '{theme}') }} catch (e) {{}}"
        )
    context.route(
        re.compile("^(?!" + re.escape(base_url) + "/)"), lambda route: route.fulfill(body="")
    )
    return context


def serve_security(page, body):
    text = json.dumps(body)
    for pattern in ("**/data/security.json", "**/api/security.json"):
        page.route(
            pattern,
            lambda route: route.fulfill(status=200, content_type="application/json", body=text),
        )


def watch(page):
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    return errors


def said(locator):
    """The first text of a note, without its screen-reader suffix."""
    return locator.evaluate("e => e.querySelector('a, span').childNodes[0].nodeValue")


def open_timeline(browser, base_url, body=None, width=1280, theme=None):
    context = make_context(browser, base_url, width, theme)
    page = context.new_page()
    errors = watch(page)
    if body is not None:
        serve_security(page, body)
    page.goto(base_url + "/timeline/")
    page.wait_for_selector(".tl-item")
    if body is not None:
        page.wait_for_selector(".sec")
    return context, page, errors


def open_compare(browser, base_url, body, family, newer, older, width=1280, theme=None):
    context = make_context(browser, base_url, width, theme)
    page = context.new_page()
    errors = watch(page)
    serve_security(page, body)
    page.goto(base_url + "/compare/")
    page.wait_for_selector(".cmp-cards")
    page.select_option("#c-family", family)
    page.select_option("#c-to", newer["id"])
    page.select_option("#c-from", older["id"])
    return context, page, errors


def test_the_timeline_shows_one_line_per_row_with_an_entry_and_nothing_for_the_rest(
    browser, base_url
):
    body = apple_payload()
    ios = releases("iOS")
    body["releases"][releases("iOS", "beta")[0]["id"]] = entry("not-applicable")
    context, page, errors = open_timeline(browser, base_url, body)
    try:
        expected = {
            ios[0]["id"]: "4 CVEs listed in Apple notes",
            ios[1]["id"]: "2 CVEs listed in Apple notes",
            ios[2]["id"]: "Apple lists no CVE entries for this build",
            ios[3]["id"]: "No matching security note found (checked Oct 10, 2026)",
            ios[4]["id"]: "Could not refresh security data (snapshot Oct 11, 2026)",
        }
        for release_id, text in expected.items():
            line = page.locator(f'.tl-item[data-id="{release_id}"] .sec')
            assert said(line) == text, release_id
        # Only the first three have a note to open; the others are plain text.
        links = page.locator(".sec-link")
        assert links.count() == 3
        for index in range(3):
            link = links.nth(index)
            assert link.get_attribute("target") == "_blank"
            assert link.get_attribute("rel") == "noopener noreferrer"
            assert link.locator(".sr-only").text_content() == " (opens in a new tab)"
        first = page.locator(f'.tl-item[data-id="{ios[0]["id"]}"] .sec-link')
        assert first.get_attribute("href") == APPLE + "100001"
        assert page.locator(".sec").count() == len(expected)
        assert page.locator(".tl-item").count() == len(SNAPSHOT["releases"])
        # A pre-release row, and every row without an entry, stay quiet.
        beta = page.locator(f'.tl-item[data-id="{releases("iOS", "beta")[0]["id"]}"]')
        assert beta.locator(".sec").count() == 0
        assert page.locator(".tl-item:not(.has-sec) .sec").count() == 0
        assert page.evaluate("() => window.__csp") == []
        assert errors == []
    finally:
        context.close()


def test_the_other_states_say_what_they_know_and_nothing_more(browser, base_url):
    router = releases("RouterOS")[0]
    windows = releases("Windows")[0]
    note_url = "https://example.org/routeros/1"
    body = payload(
        {note_url: note("mikrotik", "RouterOS notes", [])},
        {
            router["id"]: {
                "status": "linked",
                "notes": [note_url],
                "cves": [],
                "count": None,
                "patchLevel": None,
                "checkedAt": CHECKED,
            },
            windows["id"]: entry("not-connected"),
        },
    )
    body["sources"]["mikrotik"] = {"status": "ok"}
    context, page, errors = open_timeline(browser, base_url, body)
    try:
        linked = page.locator(f'.tl-item[data-id="{router["id"]}"] .sec')
        assert said(linked) == "MikroTik security notes for this build (CVEs not counted)"
        assert "0" not in linked.inner_text()
        absent = page.locator(f'.tl-item[data-id="{windows["id"]}"] .sec')
        assert said(absent) == "Security details not connected for Windows yet"
        assert errors == []
    finally:
        context.close()


def test_a_failed_source_turns_a_listed_row_into_the_unavailable_state(browser, base_url):
    body = apple_payload()
    body["sources"]["apple"] = {"status": "failed"}
    context, page, _ = open_timeline(browser, base_url, body)
    try:
        line = page.locator(f'.tl-item[data-id="{releases("iOS")[0]["id"]}"] .sec')
        assert said(line).startswith("Could not refresh security data")
        assert line.locator("a").count() == 0
    finally:
        context.close()


def test_a_failed_source_marks_a_linkless_no_cve_entries_row_unavailable(browser, base_url):
    ios = releases("iOS")
    row = entry("no-cve-entries")
    row["source"] = "apple"
    body = payload({}, {ios[0]["id"]: row})
    body["sources"]["apple"] = {"status": "failed"}
    context, page, _ = open_timeline(browser, base_url, body)
    try:
        line = page.locator(f'.tl-item[data-id="{ios[0]["id"]}"] .sec')
        assert said(line).startswith("Could not refresh security data")
        assert line.locator("a").count() == 0
    finally:
        context.close()


@pytest.mark.parametrize("theme", ["day", "night", "reactor"])
def test_the_timeline_notes_fit_a_phone_and_their_links_are_big_enough(browser, base_url, theme):
    context, page, errors = open_timeline(browser, base_url, apple_payload(), 360, theme)
    try:
        assert page.evaluate("() => document.documentElement.scrollWidth") <= 360
        for link in page.locator(".sec-link").all():
            size = link.bounding_box()
            assert size["height"] >= TARGET, size
            assert size["x"] >= 0 and size["x"] + size["width"] <= 360, size
        assert errors == []
    finally:
        context.close()


@pytest.mark.parametrize("path", ["/timeline/", "/compare/"])
def test_with_the_empty_payload_the_pages_show_no_security_line_and_no_error(
    browser, base_url, path
):
    context = make_context(browser, base_url)
    try:
        page = context.new_page()
        errors = watch(page)
        page.goto(base_url + path)
        page.wait_for_selector(".tl-item, .cmp-cards")
        page.wait_for_load_state("networkidle")
        assert page.locator(".sec, .sec-cmp").count() == 0
        assert page.evaluate("() => window.__csp") == []
        assert errors == []
    finally:
        context.close()


def test_compare_lists_what_the_newer_notes_have_and_the_older_do_not(browser, base_url):
    ios = releases("iOS")
    context, page, errors = open_compare(browser, base_url, apple_payload(), "iOS", ios[0], ios[1])
    try:
        page.wait_for_selector(".sec-cmp")
        section = page.locator(".sec-cmp")
        assert section.locator("h2").inner_text() == "Security notes"
        lead = f"Listed in iOS {ios[0]['version']}'s notes, not in iOS {ios[1]['version']}'s"
        assert section.locator(".sec-lead").inner_text() == lead
        assert section.locator(".sec-count").inner_text() == "2 CVEs"
        assert section.locator(".cve-id").all_inner_texts() == [cve(1), cve(2)]
        assert section.locator(".sev").all_inner_texts() == ["High"]
        assert "Severity not published for 1 of 2." in section.inner_text()
        # The section sits before "In between".
        order = page.locator(".cmp-result h2").all_inner_texts()
        assert order[:2] == ["Security notes", "In between"]
        assert section.locator(".sec-link").count() == 2
        assert errors == []
    finally:
        context.close()


def test_compare_announces_the_cve_count_in_a_separate_live_region(browser, base_url):
    ios = releases("iOS")
    context, page, errors = open_compare(browser, base_url, apple_payload(), "iOS", ios[0], ios[1])
    try:
        page.wait_for_selector(".sec-cmp")
        assert page.get_attribute("#cmp-result", "aria-live") is None
        assert page.locator("#cmp-result [aria-live]").count() == 0
        want = f"2 CVEs listed in iOS {ios[0]['version']}'s notes, not in iOS {ios[1]['version']}'s"
        assert page.inner_text("#cmp-live") == want
        assert errors == []
    finally:
        context.close()


def test_compare_announces_why_the_security_comparison_is_unavailable(browser, base_url):
    ios = releases("iOS")
    context, page, errors = open_compare(browser, base_url, apple_payload(), "iOS", ios[0], ios[3])
    try:
        page.wait_for_selector(".sec-cmp")
        live = page.inner_text("#cmp-live")
        assert live.startswith("Comparing iOS ")
        assert "Security comparison unavailable: no known note for" in live
        assert errors == []
    finally:
        context.close()


def test_compare_caps_a_long_list_and_says_how_many_more(browser, base_url):
    ios = releases("iOS")
    context, page, _ = open_compare(
        browser, base_url, apple_payload(big=True), "iOS", ios[0], ios[2], width=360
    )
    try:
        page.wait_for_selector(".sec-cmp")
        assert page.locator(".sec-cmp .sec-count").inner_text() == "25 CVEs"
        assert page.locator(".sec-cmp .cve").count() == 20
        assert "and 5 more" in page.locator(".sec-cmp").inner_text()
        assert "Severity not published for 25 of 25." in page.locator(".sec-cmp").inner_text()
        assert page.evaluate("() => document.documentElement.scrollWidth") <= 360
        for link in page.locator(".sec-cmp .sec-link").all():
            assert link.bounding_box()["height"] >= TARGET
    finally:
        context.close()


def test_compare_says_when_a_side_has_no_known_note_or_no_counted_cves(browser, base_url):
    ios = releases("iOS")
    beta = releases("iOS", "beta")[0]
    context, page, _ = open_compare(browser, base_url, apple_payload(), "iOS", beta, ios[0])
    try:
        page.wait_for_selector(".sec-cmp")
        text = page.locator(".sec-cmp .sec-say").inner_text()
        start = "Security comparison unavailable: no known note for iOS "
        assert text.startswith(start + beta["version"])
        assert ios[0]["version"] not in text
        assert page.locator(".sec-cmp .cve").count() == 0
    finally:
        context.close()
    router = releases("RouterOS")
    body = apple_payload()
    ros = "https://example.org/routeros/1"
    body["notes"][ros] = note("apple", "RouterOS notes", [])
    for release in router[:2]:
        body["releases"][release["id"]] = {
            "status": "linked",
            "notes": [ros],
            "cves": [],
            "count": None,
            "patchLevel": None,
            "checkedAt": CHECKED,
        }
    context, page, _ = open_compare(browser, base_url, body, "RouterOS", router[0], router[1])
    try:
        page.wait_for_selector(".sec-cmp")
        text = page.locator(".sec-cmp .sec-say").inner_text()
        assert text.startswith("Cannot compare: CVEs not counted for RouterOS ")
        assert " and RouterOS " in text
    finally:
        context.close()


def test_android_compares_the_bulletins_between_the_two_patch_levels(browser, base_url):
    android = releases("Android")
    context, page, errors = open_compare(
        browser, base_url, android_payload(), "Android", android[0], android[1]
    )
    try:
        page.wait_for_selector(".sec-cmp")
        assert page.locator(".sec-cmp .sec-count").inner_text() == "6 CVEs"
        assert page.locator(".sec-cmp .cve-id").all_inner_texts() == [
            cve(n) for n in range(101, 107)
        ]
        assert errors == []
    finally:
        context.close()


def test_android_lists_no_cves_unless_every_bulletin_it_needs_was_read(browser, base_url):
    android = releases("Android")
    context, page, _ = open_compare(
        browser, base_url, android_payload(missing="2026-03"), "Android", android[0], android[1]
    )
    try:
        page.wait_for_selector(".sec-cmp")
        assert page.locator(".sec-cmp .sec-say").inner_text() == (
            "Security comparison unavailable: no bulletin read for 2026-03"
        )
        assert page.locator(".sec-cmp .cve").count() == 0
    finally:
        context.close()


def test_android_with_a_patch_level_that_is_not_newer_says_so(browser, base_url):
    android = releases("Android")
    context, page, _ = open_compare(
        browser,
        base_url,
        android_payload(newer_patch="2025-12-05"),
        "Android",
        android[0],
        android[1],
    )
    try:
        page.wait_for_selector(".sec-cmp")
        text = page.locator(".sec-cmp .sec-say").inner_text()
        assert text.startswith("Patch level is not newer; no CVEs listed beyond Android ")
    finally:
        context.close()


def test_android_in_one_bulletin_month_or_from_a_first_part_level_is_unavailable(browser, base_url):
    android = releases("Android")
    for newer_patch, older_patch in (("2026-09-05", "2026-09-01"), ("2026-06-05", "2025-12-01")):
        body = android_payload(newer_patch=newer_patch)
        body["releases"][android[1]["id"]]["patchLevel"] = older_patch
        context, page, _ = open_compare(browser, base_url, body, "Android", android[0], android[1])
        try:
            page.wait_for_selector(".sec-cmp")
            text = page.locator(".sec-cmp .sec-say").inner_text()
            assert text.startswith("Security comparison unavailable: bulletins are read by month")
            assert page.locator(".sec-cmp .cve").count() == 0
            assert page.locator(".sec-cmp .sec-count").count() == 0
        finally:
            context.close()
