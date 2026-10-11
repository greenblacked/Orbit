#!/usr/bin/env python3
"""Full-page screenshots of every built page, at three sizes, in every theme.

    python scripts/screenshots.py                          # dist/site -> dist/preview/screenshots
    python scripts/screenshots.py --executable /opt/pw-browsers/chromium
    python scripts/screenshots.py --base-url http://127.0.0.1:8000   # use a server already running

For each page in the build, each viewport (phone 390x844, tablet 820x1180, desktop
1440x900) and each theme the stylesheet defines (day, night and the console theme here;
read from the CSS, so a theme added later is captured without editing this file), one PNG
named ``<page>-<viewport>-<theme>.png``. The run fails, after writing what it can, when
any page logs a console error, raises an uncaught exception, trips the
Content-Security-Policy, requests something outside the site (other than the font hosts,
which are answered with an empty file so the system fallback fonts are what is pictured),
or does not end up in the theme asked for.

The browser: Playwright's own Chromium (``PLAYWRIGHT_BROWSERS_PATH`` is honoured), or
``--executable PATH`` / ``BROWSER_EXECUTABLE`` for any Chromium binary, or ``--channel
chrome`` / ``BROWSER_CHANNEL`` for an installed Chrome. Playwright is installed from the
hashed requirements file: ``python -m pip install --require-hashes -r
.github/requirements/site-browser.txt``.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
from pathlib import Path
from urllib.parse import urlsplit

from serve_site import make_server
from site_pages import page_files, page_slug, page_url
from site_refs import css_attribute_values

ROOT = Path(__file__).resolve().parent.parent
VIEWPORTS = {
    "phone": {"width": 390, "height": 844},
    "tablet": {"width": 820, "height": 1180},
    "desktop": {"width": 1440, "height": 900},
}
# Phones and tablets are emulated as touch devices, so the meta viewport and the
# (pointer: coarse) rules apply the way they do on the real thing.
MOBILE = {"phone", "tablet"}
FONT_HOSTS = {"fonts.googleapis.com", "fonts.gstatic.com"}
THEME_ORDER = ["day", "night"]
RECORD_CSP = """
window.__csp = [];
document.addEventListener("securitypolicyviolation", (event) => {
  window.__csp.push(event.violatedDirective + " " + event.blockedURI);
});
"""
INSTALL_HINT = (
    "Playwright or its browser is not available. Install the driver with\n"
    "  python -m pip install --require-hashes -r .github/requirements/site-browser.txt\n"
    "and point at a browser with --executable PATH (or BROWSER_EXECUTABLE), --channel chrome\n"
    "(or BROWSER_CHANNEL), or run `python -m playwright install chromium`."
)


def detect_themes(dist: Path) -> list[str]:
    """The themes the site's stylesheets define: day (the default) plus each data-theme."""
    found: set[str] = set()
    for css in dist.rglob("*.css"):
        for value in css_attribute_values(css.read_text(encoding="utf-8"), "data-theme"):
            if re.fullmatch(r"[a-z][a-z0-9-]*", value):
                found.add(value)
    ordered = [theme for theme in THEME_ORDER if theme == "day" or theme in found]
    return ordered + sorted(found - set(THEME_ORDER))


def route_handler(base: str, problems: list[str], label: str):
    def handle(route) -> None:
        url = route.request.url
        if url.startswith(base + "/") or url.startswith("data:"):
            route.continue_()
        elif urlsplit(url).hostname in FONT_HOSTS:
            route.fulfill(status=200, body="", content_type="text/css")
        else:
            problems.append(f"{label}: requested outside the site: {url}")
            route.abort()

    return handle


def assert_distinct_names(pages) -> None:
    """Fail loudly if two pages would be written to the same file: one shot would overwrite
    the other and the manifest would point both pages at it. Case is folded, because a
    case-insensitive file system makes ``About`` and ``about`` one file."""
    seen: dict[str, str] = {}
    for url, slug in pages:
        key = slug.casefold()
        if key in seen:
            raise SystemExit(
                f"pages {seen[key]} and {url} would both be saved as {slug}-<viewport>-<theme>.png"
            )
        seen[key] = url


def capture(
    browser, base: str, pages, themes, viewports, out: Path
) -> tuple[list[dict], list[str]]:
    shots: list[dict] = []
    problems: list[str] = []
    assert_distinct_names(pages)
    for viewport in viewports:
        size = VIEWPORTS[viewport]
        for theme in themes:
            context = browser.new_context(
                viewport=size,
                device_scale_factor=1,
                is_mobile=viewport in MOBILE,
                has_touch=viewport in MOBILE,
                reduced_motion="reduce",
            )
            context.add_init_script(RECORD_CSP)
            context.add_init_script(
                f"try {{ localStorage.setItem('theme', {json.dumps(theme)}); }} catch (e) {{}}"
            )
            for url, slug in pages:
                label = f"{slug} {viewport} {theme}"
                page = context.new_page()
                page.route("**/*", route_handler(base, problems, label))
                page.on(
                    "console",
                    lambda msg, label=label: (
                        problems.append(f"{label}: console {msg.type}: {msg.text}")
                        if msg.type == "error"
                        else None
                    ),
                )
                page.on(
                    "pageerror",
                    lambda err, label=label: problems.append(f"{label}: uncaught: {err}"),
                )
                page.on(
                    "response",
                    lambda res, label=label: (
                        problems.append(f"{label}: HTTP {res.status} {res.url}")
                        if res.status >= 400 and res.url.startswith(base)
                        else None
                    ),
                )
                page.on(
                    "requestfailed",
                    lambda req, label=label: (
                        problems.append(f"{label}: request failed {req.url}")
                        if req.url.startswith(base)
                        else None
                    ),
                )
                page.goto(base + url, wait_until="load")
                page.wait_for_load_state("networkidle")
                page.evaluate("() => document.fonts.ready.then(() => 0)")
                page.evaluate(
                    "() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))"
                )
                got = page.evaluate("() => document.documentElement.getAttribute('data-theme')")
                if got != theme:
                    problems.append(f"{label}: the page is in theme {got!r}, not {theme!r}")
                for violation in page.evaluate("() => window.__csp"):
                    problems.append(f"{label}: CSP violation: {violation}")
                name = f"{slug}-{viewport}-{theme}.png"
                page.screenshot(path=str(out / name), full_page=True)
                shots.append({"file": name, "page": url, "viewport": viewport, "theme": theme})
                page.close()
            context.close()
    return shots, problems


def unsafe_out(out: Path, dist: Path, root: Path = ROOT) -> str | None:
    """Why ``out`` must not receive screenshots, or ``None``.

    The run replaces earlier PNGs in ``out``, so it must never be the built site, the
    source, or a directory holding either, nor the repository root or a parent of it.
    """
    resolved = out.resolve()
    targets = {
        "the built site": dist.resolve(),
        "the source directory": (root / "src").resolve(),
        "the repository root": root.resolve(),
    }
    for label, target in targets.items():
        if resolved == target:
            return f"it is {label}"
        if label != "the repository root" and target in resolved.parents:
            return f"it is inside {label}"
        if resolved in target.parents:
            return f"it contains {label}"
    return None


def clear_previous(out: Path) -> None:
    """Delete only the PNGs the previous run's manifest names, nothing else."""
    try:
        previous = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        names = [item["file"] for item in previous]
    except (OSError, ValueError, KeyError, TypeError):
        return
    for name in names:
        target = out / str(name)
        if target.parent == out and target.suffix == ".png" and target.is_file():
            target.unlink()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="screenshots", description=__doc__.split("\n", 1)[0])
    parser.add_argument("--dist", type=Path, default=ROOT / "dist" / "site", help="built site")
    parser.add_argument(
        "--out", type=Path, default=ROOT / "dist" / "preview" / "screenshots", help="PNG directory"
    )
    parser.add_argument("--base-url", help="a running server for --dist; default: start one")
    parser.add_argument("--executable", default=os.environ.get("BROWSER_EXECUTABLE"))
    parser.add_argument("--channel", default=os.environ.get("BROWSER_CHANNEL"))
    parser.add_argument("--viewports", default=",".join(VIEWPORTS), help="comma list")
    parser.add_argument("--themes", help="comma list; default: every theme the CSS defines")
    args = parser.parse_args(argv)
    args.dist = args.dist.resolve()
    args.out = args.out.resolve()

    viewports = [v for v in args.viewports.split(",") if v]
    unknown = [v for v in viewports if v not in VIEWPORTS]
    if unknown:
        parser.error(f"unknown viewport(s) {unknown}; choose from {sorted(VIEWPORTS)}")
    if not args.dist.is_dir():
        print(f"no built site at {args.dist}; run scripts/build_site.py first", file=sys.stderr)
        return 2
    themes = [t for t in args.themes.split(",") if t] if args.themes else detect_themes(args.dist)
    pages = [(page_url(args.dist, p), page_slug(args.dist, p)) for p in page_files(args.dist)]
    assert_distinct_names(pages)
    reason = unsafe_out(args.out, args.dist)
    if reason is not None:
        print(f"refusing to write screenshots to {args.out}: {reason}", file=sys.stderr)
        return 2

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(INSTALL_HINT, file=sys.stderr)
        return 2

    server = None
    base = args.base_url.rstrip("/") if args.base_url else None
    if base is None:
        server = make_server(args.dist)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}"

    options: dict = {}
    if args.executable:
        options["executable_path"] = args.executable
    if args.channel:
        options["channel"] = args.channel
    try:
        with sync_playwright() as playwright:
            try:
                browser = playwright.chromium.launch(**options)
            except Exception as error:  # noqa: BLE001 - any launch failure gets the same advice
                print(
                    f"could not start Chromium: {str(error).splitlines()[0]}\n{INSTALL_HINT}",
                    file=sys.stderr,
                )
                return 2
            # Only now, with a working browser, is anything of the last run replaced.
            args.out.mkdir(parents=True, exist_ok=True)
            clear_previous(args.out)
            try:
                shots, problems = capture(browser, base, pages, themes, viewports, args.out)
            finally:
                browser.close()
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()

    (args.out / "manifest.json").write_text(json.dumps(shots, indent=2) + "\n", encoding="utf-8")
    print(
        f"screenshots: {len(shots)} PNG(s) in {args.out} "
        f"({len(pages)} page(s) x {len(viewports)} viewport(s) x {len(themes)} theme(s): "
        f"{', '.join(themes)})"
    )
    for problem in sorted(set(problems)):
        print(f"error: {problem}", file=sys.stderr)
    if problems:
        print(f"screenshots: {len(set(problems))} problem(s)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
