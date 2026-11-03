"""The weekly data check workflow: read-only, pinned like the snapshot workflows, no payload."""

from __future__ import annotations

import re

from helpers import REPO

WORKFLOWS = REPO / ".github" / "workflows"
USES = r"uses: (\S+@[0-9a-f]{40}  # v[0-9.]+)"


def read(name):
    return (WORKFLOWS / name).read_text(encoding="utf-8")


def test_the_data_check_runs_weekly_or_by_hand_and_nothing_else():
    text = read("data-check.yml")
    head = text.split("\njobs:\n", 1)[0]
    assert re.search(
        r"^on:\n  schedule:\n    - cron: '[0-9]+ [0-9]+ \* \* [0-9]'\n  workflow_dispatch:\n\npermissions:",
        head,
        flags=re.MULTILINE,
    )
    assert head.count("cron:") == 1
    minute = re.search(r"cron: '(\d+) ", head).group(1)
    assert minute not in ("0", "15", "30", "45")
    assert "pull_request" not in head and "push:" not in head


def test_the_data_check_is_read_only_with_a_timeout():
    text = read("data-check.yml")
    assert re.search(r"^permissions: \{\}$", text, flags=re.MULTILINE)
    assert text.count("permissions:") == 2
    assert re.search(r"^    permissions:\n      contents: read\n", text, flags=re.MULTILINE)
    assert re.search(r"^    timeout-minutes: \d+$", text, flags=re.MULTILINE)
    assert "secrets." not in text and "upload-artifact" not in text
    assert "GITHUB_TOKEN" not in text and "GH_TOKEN" not in text and "github.token" not in text
    assert "write" not in text
    assert text.count("persist-credentials: false") == 1


def test_the_data_check_pins_the_same_actions_as_the_snapshot_workflows():
    text = read("data-check.yml")
    snapshot = read("security-snapshot.yml")
    found = re.findall(USES, text)
    assert len(found) == 2
    assert len(re.findall(r"^\s*- uses:", text, flags=re.MULTILINE)) == 2
    for action in found:
        assert action in snapshot, action


def test_the_data_check_runs_both_snapshot_scripts_in_order_fenced_and_prints_no_payload():
    text = read("data-check.yml")
    releases = text.index("node deploy/snapshot_releases.mjs")
    security = text.index("node deploy/snapshot_security.mjs")
    assert releases < security
    assert text.count("::stop-commands::${token}") == 2
    assert text.count("uuidgen") == 2
    assert "BASE64" not in text and "base64" not in text
    assert text.count("::error::") >= 3
    for run in re.findall(r"^ +run: [|>][-+]?\n((?: {10,}.*\n|\n)+)", text, flags=re.MULTILINE):
        assert "${{" not in run
