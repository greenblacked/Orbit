"""scripts/stale_data.py: warns on old snapshots, and never fails."""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone

import pytest
from helpers import REPO, load_script

stale = load_script("stale_data")

NOW = datetime(2026, 11, 1, 12, 0, 0, tzinfo=timezone.utc)


def run(tmp_path, capsys, security=None, releases=None, raw=None):
    """Run main() on two files; each is a dict (JSON) or absent (no file)."""
    sec, rel = tmp_path / "security.json", tmp_path / "releases.json"
    if security is not None:
        sec.write_text(json.dumps(security), encoding="utf-8")
    if releases is not None:
        rel.write_text(json.dumps(releases), encoding="utf-8")
    if raw is not None:
        sec.write_text(raw, encoding="utf-8")
    code = stale.main(["--security", str(sec), "--releases", str(rel)], now=NOW)
    return code, capsys.readouterr().out


def test_fresh_data_prints_a_summary_and_no_warning(tmp_path, capsys):
    code, out = run(
        tmp_path,
        capsys,
        {"generatedAt": "2026-10-20T00:00:00Z"},
        {"fetchedAt": "2026-10-25T00:00:00Z"},
    )
    assert code == 0
    assert "::warning" not in out
    assert "security: 12d 12h old, within the 21-day limit" in out
    assert "releases: 7d 12h old, within the 14-day limit" in out


def test_security_older_than_21_days_warns(tmp_path, capsys):
    code, out = run(
        tmp_path,
        capsys,
        {"generatedAt": "2026-10-10T00:00:00Z"},
        {"fetchedAt": "2026-10-30T00:00:00Z"},
    )
    assert code == 0
    assert out.count("::warning") == 1
    assert (
        "::warning title=security data is stale::"
        "security.json generatedAt is 22d 12h old, over the 21-day limit"
    ) in out


def test_releases_older_than_14_days_warns(tmp_path, capsys):
    code, out = run(
        tmp_path,
        capsys,
        {"generatedAt": "2026-10-30T00:00:00Z"},
        {"fetchedAt": "2026-10-16T00:00:00Z"},
    )
    assert code == 0
    assert out.count("::warning") == 1
    assert (
        "::warning title=releases data is stale::"
        "releases.json fetchedAt is 16d 12h old, over the 14-day limit"
    ) in out


def test_both_stale_warns_twice(tmp_path, capsys):
    code, out = run(
        tmp_path,
        capsys,
        {"generatedAt": "2026-08-01T00:00:00Z"},
        {"fetchedAt": "2026-08-01T00:00:00Z"},
    )
    assert code == 0
    assert out.count("::warning") == 2


@pytest.mark.parametrize(
    ("stamp", "warns"),
    [
        ("2026-10-11T12:00:00Z", False),  # exactly 21 days
        ("2026-10-11T11:59:59Z", True),  # a second over
    ],
)
def test_the_security_limit_is_over_21_days(tmp_path, capsys, stamp, warns):
    _, out = run(tmp_path, capsys, {"generatedAt": stamp}, {"fetchedAt": "2026-10-31T00:00:00Z"})
    assert ("::warning" in out) is warns


def test_a_future_timestamp_is_not_stale(tmp_path, capsys):
    code, out = run(
        tmp_path,
        capsys,
        {"generatedAt": "2027-01-01T00:00:00Z"},
        {"fetchedAt": "2027-01-01T00:00:00Z"},
    )
    assert code == 0
    assert "::warning" not in out
    assert "0d 0h old" in out


@pytest.mark.parametrize(
    "doc",
    [{}, {"generatedAt": None}, {"generatedAt": 5}, {"generatedAt": "yesterday"}, [], "text"],
)
def test_a_missing_or_invalid_field_warns_and_still_exits_0(tmp_path, capsys, doc):
    code, out = run(tmp_path, capsys, doc, {"fetchedAt": "2026-10-31T00:00:00Z"})
    assert code == 0
    assert "::warning title=security data::security.json has no readable generatedAt" in out
    assert "security: age unknown" in out


def test_missing_files_and_broken_json_exit_0(tmp_path, capsys):
    code, out = run(tmp_path, capsys)
    assert code == 0
    assert out.count("::warning") == 2
    code, out = run(tmp_path, capsys, raw="{not json")
    assert code == 0
    assert "security.json has no readable generatedAt" in out


def test_a_timestamp_without_a_zone_is_read_as_utc(tmp_path, capsys):
    _, out = run(
        tmp_path,
        capsys,
        {"generatedAt": "2026-10-30T12:00:00"},
        {"fetchedAt": "2026-10-30T12:00:00+00:00"},
    )
    assert "::warning" not in out


def test_the_committed_data_is_readable():
    root = stale.ROOT / "src" / "data"
    assert stale.parse_time(stale.read_field(root / "security.json", "generatedAt"))
    assert stale.parse_time(stale.read_field(root / "releases.json", "fetchedAt"))


def test_annotation_escapes_workflow_command_characters():
    assert stale.annotation("t", "50%\nnext") == "::warning title=t::50%25%0Anext"


@pytest.mark.parametrize(
    ("stamp", "warns"),
    [("2026-10-18T12:00:00Z", False), ("2026-10-18T11:59:59Z", True)],
)
def test_the_releases_limit_is_over_14_days(tmp_path, capsys, stamp, warns):
    _, out = run(tmp_path, capsys, {"generatedAt": "2026-10-31T00:00:00Z"}, {"fetchedAt": stamp})
    assert ("::warning" in out) is warns


def test_just_over_the_limit_does_not_say_the_limit_or_less(tmp_path, capsys):
    _, out = run(
        tmp_path,
        capsys,
        {"generatedAt": "2026-10-11T11:00:00Z"},
        {"fetchedAt": "2026-10-31T00:00:00Z"},
    )
    assert "generatedAt is 21d 1h old, over the 21-day limit" in out


@pytest.mark.parametrize("stamp", ["0001-01-01T00:00:00+01:00", "9999-12-31T23:59:59-01:00"])
def test_an_out_of_range_date_is_one_warning_not_a_crash(tmp_path, capsys, stamp):
    code, out = run(tmp_path, capsys, {"generatedAt": stamp}, {"fetchedAt": "2026-10-31T00:00:00Z"})
    assert code == 0
    assert "security.json has no readable generatedAt" in out
    assert "releases: " in out


def test_deeply_nested_json_is_one_warning_not_a_crash(tmp_path, capsys):
    code, out = run(tmp_path, capsys, raw="[" * 100000)
    assert code == 0
    assert "security.json has no readable generatedAt" in out


def test_a_naive_now_is_read_as_utc(tmp_path):
    sec = tmp_path / "s.json"
    sec.write_text(json.dumps({"generatedAt": "2026-10-30T00:00:00Z"}), encoding="utf-8")
    code = stale.main(
        ["--security", str(sec), "--releases", str(sec)], now=datetime(2026, 11, 1, 12, 0, 0)
    )
    assert code == 0


def test_run_as_a_script_with_stale_and_missing_data_exits_0(tmp_path):
    sec = tmp_path / "s.json"
    sec.write_text(json.dumps({"generatedAt": "2020-01-01T00:00:00Z"}), encoding="utf-8")
    result = subprocess.run(  # noqa: S603 - fixed argv, no shell
        [
            sys.executable,
            str(REPO / "scripts" / "stale_data.py"),
            "--security",
            str(sec),
            "--releases",
            str(tmp_path / "missing.json"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    assert result.stdout.count("::warning") == 2
