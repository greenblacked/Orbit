"""scripts/check_results.py: results are valid, and only for publicly released builds."""

from __future__ import annotations

import json
import os

import pytest
from helpers import REPO, load_script

check = load_script("check_results")
site = load_script("build_site")


def valid(**changes):
    doc = {
        "vendor": "apple",
        "family": "iOS",
        "build": "T0001",
        "version": "27.1",
        "stage": "release",
        "status": "pass",
        "checks": [
            {"name": "boots", "status": "pass"},
            {"name": "restores", "status": "warn", "detail": "slow"},
        ],
        "testedAt": "2026-10-20T09:30:00Z",
        "runner": "lab-1",
    }
    doc.update(changes)
    return doc


def release(build, stage, family="iOS", vendor="apple"):
    return {"vendor": vendor, "family": family, "build": build, "stage": stage}


def put(root, doc, vendor="apple", family="iOS", build="T0001"):
    path = root / vendor / family / f"{build}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def snapshot(tmp_path, *releases):
    path = tmp_path / "releases.json"
    path.write_text(json.dumps({"releases": list(releases)}), encoding="utf-8")
    return path


def problems(root, snap=None):
    return check.problems(root, snap)


@pytest.fixture
def root(tmp_path):
    path = tmp_path / "results"
    path.mkdir()
    (path / "README.md").write_text("# Results\n", encoding="utf-8")
    return path


def test_the_repository_commits_the_readme_and_no_results_yet():
    results = REPO / "results"
    assert (results / "README.md").is_file()
    assert list(results.rglob("*.json")) == []
    assert check.problems(results, REPO / "src" / "data" / "releases.json") == []


def test_the_readme_says_why_only_released_builds_are_committed():
    text = (REPO / "results" / "README.md").read_text(encoding="utf-8")
    assert "pre-release software results stay private until the build is publicly released" in text
    assert "check_results.py" in text


def test_an_empty_directory_and_a_missing_one_are_fine(root, tmp_path):
    assert problems(root) == []
    assert problems(tmp_path / "nowhere") == []


def test_a_valid_result_passes(root):
    put(root, valid())
    assert problems(root) == []


def test_every_status_and_an_empty_check_list_are_allowed(root):
    for status in ("pass", "warn", "fail", "untested"):
        put(root, valid(status=status, checks=[{"name": "x", "status": status}]))
        assert problems(root) == [], status
    put(root, valid(checks=[]))
    assert problems(root) == []


@pytest.mark.parametrize("stage", ["beta", "rc"])
def test_a_pre_release_stage_is_refused(root, stage):
    put(root, valid(stage=stage))
    found = problems(root)
    assert len(found) == 1
    assert f"stage '{stage}' is refused" in found[0]
    assert "results stay private until the build is publicly released" in found[0]


@pytest.mark.parametrize("stage", ["final", "", None, 3, "Release"])
def test_any_other_stage_is_refused(root, stage):
    put(root, valid(stage=stage))
    assert any("stage must be 'release'" in line for line in problems(root))


@pytest.mark.parametrize("stage", ["beta", "rc"])
def test_a_build_that_is_only_a_pre_release_in_the_snapshot_is_refused(root, tmp_path, stage):
    put(root, valid())
    found = problems(root, snapshot(tmp_path, release("T0001", stage)))
    assert len(found) == 1
    assert "only a pre-release in the snapshot" in found[0]


def test_a_build_the_snapshot_also_lists_as_a_release_is_accepted(root, tmp_path):
    # A release candidate and the final release often share one build.
    put(root, valid())
    snap = snapshot(tmp_path, release("T0001", "rc"), release("T0001", "release"))
    assert problems(root, snap) == []


def test_the_snapshot_match_is_by_vendor_family_and_build(root, tmp_path):
    put(root, valid())
    snap = snapshot(
        tmp_path,
        release("T0001", "beta", family="iPadOS"),
        release("T0001", "beta", vendor="other"),
        release("T0002", "beta"),
    )
    assert problems(root, snap) == []


def test_a_missing_or_unreadable_snapshot_does_not_block_a_valid_result(root, tmp_path):
    put(root, valid())
    assert problems(root, tmp_path / "missing.json") == []
    bad = tmp_path / "bad.json"
    bad.write_text("not json", encoding="utf-8")
    assert problems(root, bad) == []


def test_the_path_must_match_the_document(root):
    put(root, valid(vendor="other"))
    put(root, valid(family="macOS"), build="T0002")
    put(root, valid(build="T0003"), build="T0004")
    found = "\n".join(problems(root))
    assert "vendor 'other' does not match its path ('apple')" in found
    assert "family 'macOS' does not match its path ('iOS')" in found
    assert "build 'T0003' does not match its path ('T0004')" in found


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"status": "ok"}, "status must be one of"),
        ({"status": None}, "status must be one of"),
        ({"testedAt": "2026-10-20 09:30:00"}, "testedAt must be a UTC time"),
        ({"testedAt": "2026-10-20T09:30:00+02:00"}, "testedAt must be a UTC time"),
        ({"testedAt": "2026-02-30T09:30:00Z"}, "testedAt must be a UTC time"),
        ({"testedAt": 20261020}, "testedAt must be a UTC time"),
        ({"runner": ""}, "runner must be a non-empty string"),
        ({"version": "  "}, "version must be a non-empty string"),
        ({"version": 27}, "version must be a non-empty string"),
        ({"checks": "none"}, "checks must be a list"),
        ({"checks": ["x"]}, "checks[0] must be an object"),
        ({"checks": [{"status": "pass"}]}, "checks[0].name must be a non-empty string"),
        ({"checks": [{"name": "x", "status": "maybe"}]}, "checks[0].status must be one of"),
        ({"checks": [{"name": "x", "status": "pass", "detail": 3}]}, "checks[0].detail"),
        ({"checks": [{"name": "x", "status": "pass", "notes": "n"}]}, "unknown field(s): notes"),
        ({"extra": 1}, "unknown field(s): extra"),
    ],
)
def test_the_schema_is_enforced(root, changes, message):
    put(root, valid(**changes))
    assert any(message in line for line in problems(root)), problems(root)


def test_a_missing_field_is_named(root):
    doc = valid()
    del doc["runner"]
    del doc["checks"]
    put(root, doc)
    assert any("missing field(s): checks, runner" in line for line in problems(root))


def test_files_that_are_not_results_are_refused(root):
    (root / "apple" / "iOS").mkdir(parents=True)
    (root / "apple" / "iOS" / "notes.txt").write_text("x", encoding="utf-8")
    (root / "apple" / "T0001.json").write_text(json.dumps(valid()), encoding="utf-8")
    (root / "stray.json").write_text("{}", encoding="utf-8")
    (root / "apple" / "iOS" / "bad.json").write_text("not json", encoding="utf-8")
    (root / "apple" / "iOS" / "list.json").write_text("[]", encoding="utf-8")
    (root / "apple" / "iOS" / ".hidden.json").write_text("{}", encoding="utf-8")
    found = "\n".join(problems(root))
    assert "apple/iOS/notes.txt: expected <vendor>/<family>/<build>.json" in found
    assert "apple/T0001.json: expected <vendor>/<family>/<build>.json" in found
    assert "stray.json: expected <vendor>/<family>/<build>.json" in found
    assert "apple/iOS/bad.json: not readable JSON" in found
    assert "apple/iOS/list.json: the file must hold a JSON object" in found
    assert "apple/iOS/.hidden.json: vendor, family and build must match" in found


def test_a_symbolic_link_is_refused(root, tmp_path):
    target = tmp_path / "elsewhere.json"
    target.write_text(json.dumps(valid()), encoding="utf-8")
    link = root / "apple" / "iOS" / "T0001.json"
    link.parent.mkdir(parents=True)
    os.symlink(target, link)
    assert any("a symbolic link is refused" in line for line in problems(root))


def test_main_exits_zero_or_one_and_reports(root, tmp_path, capsys):
    args = ["--results", str(root), "--snapshot", str(tmp_path / "none.json")]
    assert check.main(args) == 0
    assert "0 result file(s) ok" in capsys.readouterr().out
    put(root, valid())
    assert check.main(args) == 0
    assert "1 result file(s) ok" in capsys.readouterr().out
    put(root, valid(stage="beta"), build="T0009")
    assert check.main(args) == 1
    err = capsys.readouterr().err
    assert "results/apple/iOS/T0009.json" in err
    assert "problem(s) in the results" in err


def test_a_real_beta_build_in_the_snapshot_is_refused(root):
    snap = REPO / "src" / "data" / "releases.json"
    releases = json.loads(snap.read_text(encoding="utf-8"))["releases"]
    released = {(r["vendor"], r["family"], r["build"]) for r in releases if r["stage"] == "release"}
    betas = [
        r
        for r in releases
        if r["stage"] in ("beta", "rc") and (r["vendor"], r["family"], r["build"]) not in released
    ]
    assert betas, "the snapshot holds a pre-release build to test with"
    beta = betas[0]
    put(
        root,
        valid(vendor=beta["vendor"], family=beta["family"], build=beta["build"]),
        vendor=beta["vendor"],
        family=beta["family"],
        build=beta["build"],
    )
    assert any("only a pre-release in the snapshot" in line for line in problems(root, snap))


def test_the_build_copies_results_into_the_site(root, tmp_path):
    put(root, valid())
    out = tmp_path / "site"
    site.build(REPO / "src", out, "v1", results=root)
    copied = out / "data" / "results" / "apple" / "iOS" / "T0001.json"
    assert json.loads(copied.read_text(encoding="utf-8")) == valid()
    assert not (out / "data" / "results" / "README.md").exists()


def test_the_build_makes_an_empty_results_directory_when_there_are_none(root, tmp_path):
    out = tmp_path / "site"
    site.build(REPO / "src", out, "v1", results=root)
    assert (out / "data" / "results").is_dir()
    assert list((out / "data" / "results").iterdir()) == []


def test_the_build_refuses_a_pre_release_result_and_keeps_the_previous_build(root, tmp_path):
    out = tmp_path / "site"
    site.build(REPO / "src", out, "v1", results=root)
    put(root, valid(stage="rc"))
    with pytest.raises(SystemExit, match="stay private"):
        site.build(REPO / "src", out, "v2", results=root)
    assert (out / "version.txt").read_text(encoding="utf-8").strip() == "v1"
    assert not (out / "data" / "results" / "apple").exists()


def test_the_default_build_reads_the_repository_results(tmp_path):
    out = tmp_path / "site"
    assert site.main(["--version", "v1", "--out", str(out)]) == 0
    assert (out / "data" / "results").is_dir()
