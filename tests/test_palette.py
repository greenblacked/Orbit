"""The per-family accent tokens in site.css match families.json and meet WCAG AA.

Each family has --fam-text (words on the page), --fam-text-card (words on a card), --fam-a
(the fill) and --fam-on (the text colour that sits on that fill). The text colour must reach
4.5:1 against the theme's --bg, the card text colour 4.5:1 against its --card, and --fam-on
4.5:1 against the fill. The hex values come from src/data/families.json: on the day theme
the accent text colour, on night and the console theme the accent itself.
"""

from __future__ import annotations

import json
import re

import pytest
from helpers import REPO

CSS = (REPO / "src" / "assets" / "site.css").read_text(encoding="utf-8")
FAMILIES = json.loads((REPO / "src" / "data" / "families.json").read_text(encoding="utf-8"))[
    "families"
]
THEMES = ["day", "night", "reactor"]
HEX = re.compile(r"#[0-9a-fA-F]{6}")


def luminance(color: str) -> float:
    channels = [int(color[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def ratio(a: str, b: str) -> float:
    high, low = sorted((luminance(a), luminance(b)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def declarations(selector: str) -> dict[str, str]:
    """The custom properties of every rule whose selector list names ``selector``."""
    bare = re.sub(r"/\*.*?\*/", "", CSS, flags=re.DOTALL)
    found: dict[str, str] = {}
    for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", bare):
        names = [name.strip() for name in match.group(1).split(",")]
        if selector in names:
            found.update(re.findall(r"(--[a-z-]+):\s*([^;]+);", match.group(2)))
    assert found, f"no rule for {selector}"
    return found


def theme_surface(theme: str) -> dict[str, str]:
    return declarations(":root" if theme == "day" else f'html[data-theme="{theme}"]')


def tokens(family: dict, theme: str) -> dict[str, str]:
    name = f".fam-{family['id'].lower()}"
    return declarations(name if theme == "day" else f'html[data-theme="{theme}"] {name}')


def ids() -> list[str]:
    return [family["id"] for family in FAMILIES]


@pytest.mark.parametrize("theme", THEMES)
@pytest.mark.parametrize("family", FAMILIES, ids=ids())
def test_the_tokens_are_the_accents_of_the_families_config(family, theme):
    accent = tokens(family, theme)
    wanted = family["accentText"] if theme == "day" else family["accent"]
    assert accent["--fam-text"].lower() == wanted.lower()
    assert accent["--fam-a"].lower() == wanted.lower()


@pytest.mark.parametrize("theme", THEMES)
@pytest.mark.parametrize("family", FAMILIES, ids=ids())
def test_the_accent_text_is_readable_on_the_page_and_on_a_card(family, theme):
    surface, accent = theme_surface(theme), tokens(family, theme)
    assert ratio(accent["--fam-text"], surface["--bg"]) >= 4.5, (family["id"], theme)
    assert ratio(accent["--fam-text-card"], surface["--card"]) >= 4.5, (family["id"], theme)


def mix(accent: str, base: str, share: float) -> str:
    """``color-mix(in srgb, accent share, base)`` as a hex colour."""
    a = [int(accent[i : i + 2], 16) for i in (1, 3, 5)]
    b = [int(base[i : i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(
        f"{round(x * share + y * (1 - share)):02x}" for x, y in zip(a, b, strict=True)
    )


@pytest.mark.parametrize("theme", THEMES)
@pytest.mark.parametrize("family", FAMILIES, ids=ids())
def test_small_text_is_readable_on_the_family_tint(family, theme):
    # .fam::before paints up to 11% of --fam-a behind the copy; the small labels and links
    # there use --fam-text-card, the large title may use --fam-text at 3:1.
    surface, accent = theme_surface(theme), tokens(family, theme)
    tint = mix(accent["--fam-a"], surface["--bg"], 0.11)
    assert ratio(accent["--fam-text-card"], tint) >= 4.5, (family["id"], theme)
    assert ratio(accent["--fam-text"], tint) >= 3.0, (family["id"], theme)


def test_the_small_family_text_uses_the_tint_safe_token():
    bare = re.sub(r"/\*.*?\*/", "", CSS, flags=re.DOTALL)
    for selector in (".r-stage", ".more"):
        rule = re.search(re.escape(selector) + r"\s*\{([^{}]*)\}", bare)
        assert rule, selector
        assert "color: var(--fam-text-card)" in rule.group(1), selector


@pytest.mark.parametrize("theme", THEMES)
@pytest.mark.parametrize("family", FAMILIES, ids=ids())
def test_text_on_the_accent_fill_is_readable(family, theme):
    accent = tokens(family, theme)
    assert ratio(accent["--fam-on"], accent["--fam-a"]) >= 4.5, (family["id"], theme)


@pytest.mark.parametrize("theme", THEMES)
@pytest.mark.parametrize("family", FAMILIES, ids=ids())
def test_every_token_is_a_plain_hex_colour(family, theme):
    for name in ("--fam-text", "--fam-text-card", "--fam-a", "--fam-on"):
        assert HEX.fullmatch(tokens(family, theme)[name]), (family["id"], theme, name)


def test_the_ratio_function_matches_known_values():
    assert round(ratio("#000000", "#ffffff"), 1) == 21.0
    assert ratio("#777777", "#ffffff") < 4.6


@pytest.mark.parametrize("theme", THEMES)
@pytest.mark.parametrize("family", FAMILIES, ids=ids())
def test_every_family_has_the_far_end_of_its_gradient(family, theme):
    # A family missing from a --fam-b list has no --fam-b: the .tile gradient turns invalid and
    # its --fam-on text sits unseen on the light card.
    assert "--fam-b" in tokens(family, theme), (family["id"], theme)


def test_family_ids_are_one_plain_token():
    # famClass() lowercases an id into a class name, so it must be one token of letters and digits.
    for family in FAMILIES:
        assert re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", family["id"]), family["id"]
    assert len({family["id"].lower() for family in FAMILIES}) == len(FAMILIES)
