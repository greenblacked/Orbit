"""Where the security notes script loads, and what it may do, checked as source."""

from __future__ import annotations

import re

import pytest
from helpers import REPO

SRC = REPO / "src"
SCRIPT = SRC / "assets" / "security.js"
WITH_NOTES = ["timeline/index.html", "compare/index.html"]


def loaded(path: str) -> list[str]:
    html = (SRC / path).read_text(encoding="utf-8")
    return re.findall(r'<script src="/assets/([a-z.-]+\.js)"', html)


@pytest.mark.parametrize("path", WITH_NOTES)
def test_the_timeline_and_compare_load_the_notes_after_the_release_data(path):
    names = loaded(path)
    assert names.count("security.js") == 1
    assert names.index("security.js") == names.index("releases.js") + 1


OTHERS = sorted(p.relative_to(SRC).as_posix() for p in SRC.rglob("*.html"))
OTHERS = [path for path in OTHERS if path not in WITH_NOTES]


@pytest.mark.parametrize("path", OTHERS)
def test_no_other_page_loads_the_notes(path):
    assert "security.js" not in loaded(path)


def test_the_front_page_neither_loads_nor_names_the_notes():
    html = (SRC / "index.html").read_text(encoding="utf-8")
    assert "security" not in html.lower()
    for script in loaded("index.html"):
        text = (SRC / "assets" / script).read_text(encoding="utf-8")
        assert "security.js" not in text and "/data/security.json" not in text, script


def test_the_notes_script_writes_text_only_and_never_a_style():
    text = SCRIPT.read_text(encoding="utf-8")
    for banned in (
        "innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "document.write",
        "eval(",
        "cssText",
        'setAttribute("style"',
        "setAttribute('style'",
        ".style.",
    ):
        assert banned not in text, banned


def test_the_notes_script_reads_the_snapshot_before_the_optional_api():
    text = SCRIPT.read_text(encoding="utf-8")
    assert text.index("/data/security.json") < text.index("/api/security.json")
    assert "loadJson(SNAPSHOT)" in text
    assert "console." not in text
