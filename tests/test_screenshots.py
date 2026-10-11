"""scripts/screenshots.py: the PNGs it promises, and a failure on what it must catch."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

import pytest
from helpers import REPO, load_script

shots = load_script("screenshots")
page_slug = load_script("site_pages").page_slug


@pytest.fixture
def need_browser():
    """Skip without Playwright; main() starts its own driver, so the shared one stays out."""
    try:
        import playwright.sync_api  # noqa: F401
    except ImportError:
        if os.environ.get("REQUIRE_BROWSER") == "1":
            raise
        pytest.skip("playwright is not installed")


def run_script(*args: str) -> subprocess.CompletedProcess:
    """The script as a user runs it: its own process, so its Playwright driver is its own."""
    return subprocess.run(  # noqa: S603 - fixed interpreter and script path
        [sys.executable, str(REPO / "scripts" / "screenshots.py"), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def browser_args() -> list[str]:
    args: list[str] = []
    if os.environ.get("BROWSER_EXECUTABLE"):
        args += ["--executable", os.environ["BROWSER_EXECUTABLE"]]
    if os.environ.get("BROWSER_CHANNEL"):
        args += ["--channel", os.environ["BROWSER_CHANNEL"]]
    return args


def test_the_themes_are_read_from_the_stylesheet(built):
    assert shots.detect_themes(built) == ["day", "night", "reactor"]


def test_a_theme_added_to_the_css_is_picked_up(tmp_path, built):
    copy = tmp_path / "site"
    shutil.copytree(built, copy)
    css = copy / "assets" / "site.css"
    css.write_text(css.read_text() + '\nhtml[data-theme="paper"] { --bg: #fff; }\n')
    assert shots.detect_themes(copy) == ["day", "night", "paper", "reactor"]


@pytest.mark.parametrize(
    "selector",
    [
        '[data-theme="paper"]',
        "[data-theme='paper']",
        "[data-theme=paper]",
        '[ data-theme = "paper" ]',
    ],
    ids=["double-quoted", "single-quoted", "bare", "spaced"],
)
def test_a_theme_is_found_in_every_quoting_form_css_allows(tmp_path, built, selector):
    copy = tmp_path / "site"
    shutil.copytree(built, copy)
    css = copy / "assets" / "site.css"
    css.write_text(css.read_text() + f"\nhtml{selector} {{ --bg: #fff; }}\n")
    assert shots.detect_themes(copy) == ["day", "night", "paper", "reactor"]


def test_a_commented_out_or_quoted_theme_is_not_a_theme_and_an_escape_is_decoded(tmp_path, built):
    copy = tmp_path / "site"
    shutil.copytree(built, copy)
    css = copy / "assets" / "site.css"
    css.write_text(
        css.read_text()
        + '\n/* html[data-theme="ghost"] {} */\n.x::after { content: "[data-theme=ghost2]"; }\n'
        + "html[data-th\\65 me=paper] { --bg: #fff; }\n"
    )
    assert shots.detect_themes(copy) == ["day", "night", "paper", "reactor"]


def test_an_unknown_viewport_is_a_usage_error(built):
    with pytest.raises(SystemExit):
        shots.main(["--dist", str(built), "--viewports", "watch"])


def slugs(tmp_path, files):
    """Slugs are computed from paths alone, so pairs that cannot coexist on disk work too."""
    return tmp_path, {name: page_slug(tmp_path, tmp_path / name) for name in files}


@pytest.mark.parametrize(
    "pair",
    [
        ("blog/post/index.html", "blog-post/index.html"),
        ("404/index.html", "404.html"),
        ("a.html/index.html", "a.html"),
        ("index/index.html", "index.html"),
        ("a_2D/index.html", "a-/index.html"),
        ("a/b.html", "a-b.html"),
    ],
)
def test_two_different_pages_never_share_a_screenshot_name(tmp_path, pair):
    site, named = slugs(tmp_path, pair)
    assert len(set(named.values())) == 2, named
    shots.assert_distinct_names([(n, s) for n, s in named.items()])


def test_the_usual_pages_keep_their_plain_names(tmp_path):
    _, named = slugs(tmp_path, ["index.html", "about/index.html", "404.html"])
    assert list(named.values()) == ["index", "about", "404.html"]


def test_a_forced_duplicate_name_fails_loudly(tmp_path):
    with pytest.raises(SystemExit, match="both be saved as"):
        shots.assert_distinct_names([("/a/", "same"), ("/b/", "same")])
    with pytest.raises(SystemExit):
        shots.assert_distinct_names([("/a/", "About"), ("/b/", "about")])
    with pytest.raises(SystemExit):
        shots.capture(None, "http://x", [("/a/", "same"), ("/b/", "same")], [], [], tmp_path)


def test_a_missing_build_is_reported(tmp_path):
    assert shots.main(["--dist", str(tmp_path / "nope")]) == 2


@pytest.mark.browser
def test_it_writes_one_png_per_page_viewport_and_theme(need_browser, tmp_path, built):
    out = tmp_path / "shots"
    result = run_script("--dist", str(built), "--out", str(out), *browser_args())
    assert result.returncode == 0, result.stderr
    names = sorted(p.name for p in out.glob("*.png"))
    assert len(names) == 4 * 3 * 3  # four pages x phone, tablet, desktop x 3 themes
    assert "index-phone-day.png" in names
    assert "about-tablet-night.png" in names
    assert "404.html-desktop-reactor.png" in names
    assert all((out / name).stat().st_size > 1000 for name in names)
    manifest = json.loads((out / "manifest.json").read_text())
    assert len(manifest) == len(names)


@pytest.mark.browser
def test_it_fails_on_a_console_error_and_on_a_csp_violation(need_browser, tmp_path, built):
    broken = tmp_path / "site"
    shutil.copytree(built, broken)
    index = broken / "index.html"
    index.write_text(
        index.read_text().replace("</body>", "<script>console.error('boom')</script></body>")
    )
    out = tmp_path / "shots"
    result = run_script(
        "--dist", str(broken), "--out", str(out), "--viewports", "phone", "--themes", "day",
        *browser_args(),
    )  # fmt: skip
    assert result.returncode == 1
    assert "CSP violation" in result.stderr
    assert "index phone day" in result.stderr
    # It still wrote what it could.
    assert (out / "about-phone-day.png").is_file()


@pytest.mark.browser
def test_it_fails_on_a_request_to_another_origin(need_browser, tmp_path, built):
    broken = tmp_path / "site"
    shutil.copytree(built, broken)
    about = broken / "about" / "index.html"
    about.write_text(
        about.read_text().replace("</body>", '<img src="https://example.org/x.png" alt=""></body>')
    )
    result = run_script(
        "--dist", str(broken), "--out", str(tmp_path / "s"), "--viewports", "phone",
        "--themes", "day", *browser_args(),
    )  # fmt: skip
    assert result.returncode == 1
    # The CSP blocks it first, and says so; the request guard is the second net.
    assert "example.org" in result.stderr


def snapshot(root):
    return {p: p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


@pytest.mark.parametrize("where", ["src", "src/nested", "dist-itself", "dist-child", "root"])
def test_an_out_that_overlaps_the_source_the_build_or_the_repository_is_refused(
    where, tmp_path, built
):
    out = {
        "src": REPO / "src",
        "src/nested": REPO / "src" / "nested",
        "dist-itself": built,
        "dist-child": built / "assets",
        "root": REPO,
    }[where]
    before = snapshot(REPO / "src")
    built_before = snapshot(built)
    result = run_script("--dist", str(built), "--out", str(out), "--executable", "/nonexistent")
    assert result.returncode == 2
    assert "refusing to write screenshots" in result.stderr
    assert snapshot(REPO / "src") == before
    assert snapshot(built) == built_before
    assert not (REPO / "src" / "nested").exists()


def test_an_out_containing_the_build_is_refused(tmp_path, built):
    result = run_script("--dist", str(built), "--out", str(built.parent))
    assert result.returncode == 2
    assert "contains the built site" in result.stderr


def test_a_failed_browser_launch_deletes_nothing(tmp_path, built):
    out = tmp_path / "shots"
    out.mkdir()
    old = out / "index-phone-day.png"
    old.write_bytes(b"old")
    keep = out / "mine.png"
    keep.write_bytes(b"mine")
    (out / "manifest.json").write_text(json.dumps([{"file": old.name}]))
    result = run_script("--dist", str(built), "--out", str(out), "--executable", "/nonexistent")
    assert result.returncode == 2
    assert old.read_bytes() == b"old"
    assert keep.read_bytes() == b"mine"


def test_only_pngs_the_last_manifest_names_are_cleared(tmp_path):
    (tmp_path / "a.png").write_bytes(b"a")
    (tmp_path / "mine.png").write_bytes(b"m")
    (tmp_path / "manifest.json").write_text(json.dumps([{"file": "a.png"}, {"file": "../x.png"}]))
    shots.clear_previous(tmp_path)
    assert not (tmp_path / "a.png").exists()
    assert (tmp_path / "mine.png").exists()
