"""The Google Fonts request must include the Instrument Sans weights 400, 500 and 600."""

from __future__ import annotations

import re

from helpers import REPO
from site_pages import page_files

SRC = REPO / "src"
CSS = (SRC / "assets" / "site.css").read_text(encoding="utf-8")
SANS = re.compile(r"family=Instrument\+Sans:wght@([0-9;]+)")
# 450 belongs to Newsreader; a new weight here means the font request needs a look.
KNOWN_CSS_WEIGHTS = {400, 450, 500, 600}


def test_css_weights_are_known() -> None:
    used = {int(w) for w in re.findall(r"font-weight:\s*(\d{3})", CSS)}
    assert 600 in used
    assert used <= KNOWN_CSS_WEIGHTS, sorted(used)


def test_every_page_requests_the_sans_weights_the_css_uses() -> None:
    for page in page_files(SRC):
        match = SANS.search(page.read_text(encoding="utf-8"))
        assert match is not None, f"{page.relative_to(SRC)} has no Instrument Sans request"
        asked = {int(w) for w in match.group(1).split(";")}
        assert {400, 500, 600} <= asked, f"{page.relative_to(SRC)} asks for {sorted(asked)}"
