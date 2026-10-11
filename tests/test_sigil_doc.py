"""docs/sigils.md and src/assets/sigil.js must agree on every constant of the sigil rule.

The page lists the constants in a table (``| `name` | value |``) and the script keeps them in
one ``SPEC`` object, one ``name: value,`` per line. A number changed on one side and not the
other fails here. Reading text only; no browser and no Node.
"""

from __future__ import annotations

import ast
import re

from helpers import REPO

SCRIPT = (REPO / "src" / "assets" / "sigil.js").read_text(encoding="utf-8")
DOC = (REPO / "docs" / "sigils.md").read_text(encoding="utf-8")


def script_constants() -> dict[str, object]:
    block = re.search(r"var SPEC = \{\n(.*?)\n  \};", SCRIPT, re.DOTALL)
    assert block, "sigil.js has no SPEC object"
    found: dict[str, object] = {}
    for line in block.group(1).splitlines():
        entry = re.fullmatch(r"\s+(\w+):\s*(.+?),?\s*", line)
        assert entry, f"cannot read the SPEC line {line!r}"
        found[entry.group(1)] = ast.literal_eval(entry.group(2))
    return found


def doc_constants() -> dict[str, object]:
    section = DOC.split("## Constants", 1)[1].split("\n## ", 1)[0]
    found: dict[str, object] = {}
    for row in re.finditer(r"^\| `(\w+)` \| (.+?) \|$", section, re.MULTILINE):
        found[row.group(1)] = ast.literal_eval(row.group(2))
    return found


def test_the_script_and_the_page_list_the_same_constants():
    script, doc = script_constants(), doc_constants()
    assert script, "no constants found in sigil.js"
    assert sorted(script) == sorted(doc), (
        f"only in the script: {sorted(set(script) - set(doc))}, "
        f"only in the page: {sorted(set(doc) - set(script))}"
    )
    for name, value in script.items():
        assert doc[name] == value, (
            f"{name}: sigil.js has {value!r}, docs/sigils.md has {doc[name]!r}"
        )


def test_the_page_states_the_rule_with_the_script_numbers():
    spec = script_constants()
    # The prose and the pseudo-code carry the same numbers as the table.
    assert f"r_j = {spec['ringBase']} + {spec['ringSpan']} * j / rings" in DOC
    assert f"{spec['spokeMin']} + {spec['spokeSpan']} * digit" in DOC
    assert f"min({spec['maxDots']}, ord(SUFFIX) - 96)" in DOC
    assert f"mod {spec['hashMod']}" in DOC and f"mod {spec['lcgMod']}" in DOC
    assert f"x * {spec['lcgMul']} + {spec['lcgAdd']}" in DOC


def test_the_generic_examples_in_the_page_are_the_ones_the_node_test_pins():
    test = (REPO / "tests" / "sigil.test.mjs").read_text(encoding="utf-8")
    for build, digits in [
        ("BP2A.250605.031", "2, 8, 3, 5, 1, 6, 0, 4"),
        ("26100.4351", "3, 7, 6, 3, 4, 6, 3, 1"),
        ("24.04.3", "4, 9, 7, 8, 0, 1, 7, 8"),
    ]:
        assert f"`{build}`" in DOC and digits in DOC
        assert build in test and f"[{digits}]" in test


def test_the_page_has_every_worked_example():
    for build in ["24B5099f", "26B5101f", "24K5103f", "24N5103f", "23G90", "19H422"]:
        assert f"### {build} " in DOC
