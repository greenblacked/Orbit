"""scripts/preview.sh: the loop runs end to end on a copy of the site, and refuses bad input."""

from __future__ import annotations

import shutil
import subprocess

import pytest
from helpers import REPO


@pytest.fixture(scope="module")
def copy(tmp_path_factory):
    target = tmp_path_factory.mktemp("copy") / "site"
    shutil.copytree(
        REPO,
        target,
        ignore=shutil.ignore_patterns(
            "dist", "node_modules", "__pycache__", ".pytest_cache", ".git"
        ),
    )
    return target


def preview(copy, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(  # noqa: S603 - fixed argv
        ["bash", str(copy / "scripts" / "preview.sh"), *args],  # noqa: S607
        cwd=copy,
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )


def test_the_loop_builds_checks_serves_smokes_and_bundles(copy):
    result = preview(copy, "--no-screenshots", "--version", "t-1", "--commit", "abc1234")
    assert result.returncode == 0, result.stdout + result.stderr
    out = result.stdout
    for step in ("==> build", "==> check links", "==> serve", "==> smoke test", "==> bundle"):
        assert step in out
    assert "==> screenshots" not in out
    bundle = copy / "dist" / "preview" / "index.html"
    assert bundle.is_file()
    assert "abc1234" in bundle.read_text(encoding="utf-8")
    assert (copy / "dist" / "site" / "version.txt").read_text() == "t-1\n"


def test_the_server_is_stopped_when_the_script_ends(copy):
    result = preview(copy, "--no-screenshots", "--version", "t-2")
    assert result.returncode == 0
    port = next(line for line in result.stdout.splitlines() if line.startswith("serving "))
    port = port.rsplit(":", 1)[1]
    gone = subprocess.run(  # noqa: S603
        ["curl", "-sS", "--max-time", "2", f"http://127.0.0.1:{port}/version.txt"],  # noqa: S607
        capture_output=True,
        check=False,
    )
    assert gone.returncode != 0


@pytest.mark.parametrize(
    "args",
    [["--bogus"], ["--port"], ["--port", "x1"], ["--version"], ["--executable"]],
)
def test_bad_arguments_are_a_usage_error(copy, args):
    assert preview(copy, *args).returncode == 2


def test_help_exits_zero_and_names_the_options(copy):
    result = preview(copy, "--help")
    assert result.returncode == 0
    assert "--no-screenshots" in result.stdout


def test_a_broken_link_stops_the_loop_before_anything_is_served(copy):
    index = copy / "src" / "index.html"
    original = index.read_text(encoding="utf-8")
    try:
        index.write_text(original.replace("</main>", '<a href="/gone/">x</a></main>'))
        result = preview(copy, "--no-screenshots", "--version", "t-3")
    finally:
        index.write_text(original, encoding="utf-8")
    assert result.returncode != 0
    assert "/gone/" in result.stderr
    assert "==> serve" not in result.stdout
