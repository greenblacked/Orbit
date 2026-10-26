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


FAMILIES = REPO / "src" / "data" / "families.json"
DEVICES = REPO / "src" / "data" / "devices.json"


def problems(root, snap=None, devices=DEVICES):
    if snap is None:
        # An empty but valid snapshot: no build is a pre-release in it.
        snap = root.parent / "empty-snapshot.json"
        snap.write_text(json.dumps({"releases": []}), encoding="utf-8")
    return check.problems(root, snap, FAMILIES, devices)


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
    assert check.problems(results, REPO / "src" / "data" / "releases.json", FAMILIES) == []


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


def test_the_snapshot_match_ignores_another_vendor_or_build(root, tmp_path):
    put(root, valid())
    snap = snapshot(
        tmp_path,
        release("T0001", "beta", vendor="other"),
        release("T0002", "beta"),
    )
    assert problems(root, snap) == []


def test_a_build_that_is_a_pre_release_under_another_family_is_refused(root, tmp_path):
    put(root, valid())
    found = problems(root, snapshot(tmp_path, release("T0001", "beta", family="iPadOS")))
    assert len(found) == 1
    assert "only a pre-release in the snapshot" in found[0]
    # Listed as a release under any family of the vendor, it is accepted.
    snap = snapshot(
        tmp_path, release("T0001", "beta", family="iPadOS"), release("T0001", "release")
    )
    assert problems(root, snap) == []


@pytest.mark.parametrize("family", ["ios", "iPhone", "IOS", "iOS2"])
def test_a_wrong_case_or_unknown_family_is_refused(root, tmp_path, family):
    # The snapshot lists the build as a beta of the real family; a misfiled result must
    # not slip past by naming a family the snapshot does not know.
    put(root, valid(family=family), family=family)
    snap = snapshot(tmp_path, release("T0001", "beta"))
    found = problems(root, snap)
    assert any("not a vendor and family in the families config" in line for line in found)
    assert any("only a pre-release in the snapshot" in line for line in found)


def test_an_unknown_vendor_is_refused(root):
    put(root, valid(vendor="other"), vendor="other")
    assert any("not a vendor and family" in line for line in problems(root))


def test_a_missing_or_unreadable_snapshot_refuses_every_result(root, tmp_path):
    put(root, valid())
    found = check.problems(root, tmp_path / "missing.json", FAMILIES)
    assert len(found) == 1 and "snapshot is missing" in found[0]
    bad = tmp_path / "bad.json"
    bad.write_text("not json", encoding="utf-8")
    found = check.problems(root, bad, FAMILIES)
    assert len(found) == 1 and "snapshot is not readable" in found[0]
    bad.write_text(json.dumps({"releases": "none"}), encoding="utf-8")
    found = check.problems(root, bad, FAMILIES)
    assert len(found) == 1 and "no releases list" in found[0]
    bad.write_text(json.dumps({"other": []}), encoding="utf-8")
    assert "not readable" in check.problems(root, bad, FAMILIES)[0]
    assert check.problems(root, None, FAMILIES)[0].endswith("so none is accepted")


def test_a_missing_families_config_refuses_every_result(root, tmp_path):
    put(root, valid())
    snap = snapshot(tmp_path)
    found = check.problems(root, snap, tmp_path / "none.json")
    assert len(found) == 1 and "families config is missing" in found[0]


def test_no_result_file_needs_no_snapshot(root, tmp_path):
    assert check.problems(root, tmp_path / "missing.json", tmp_path / "none.json") == []


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
    empty = snapshot(tmp_path)
    args = ["--results", str(root), "--snapshot", str(empty), "--families", str(FAMILIES)]
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
    assert [p.name for p in (out / "data" / "results").iterdir()] == ["index.json"]
    index = json.loads((out / "data" / "results" / "index.json").read_text(encoding="utf-8"))
    assert index == {"schema": 1, "results": []}


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


def valid_device(**changes):
    return valid(device="iPhone 18 Pro", **changes)


def put_device(root, doc, slug="iphone-18-pro", vendor="apple", family="iOS", build="T0001"):
    path = root / vendor / family / build / f"{slug}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def devices_file(tmp_path, families):
    path = tmp_path / "devices.json"
    path.write_text(json.dumps({"schema": 1, "families": families}), encoding="utf-8")
    return path


@pytest.mark.parametrize(
    ("name", "slug"),
    [
        ("iPhone 18 Pro", "iphone-18-pro"),
        ("iPad Pro 11-inch (M5)", "ipad-pro-11-inch-m5"),
        ("iPad Pro 12.9-inch (6th generation)", "ipad-pro-12-9-inch-6th-generation"),
        ("iPhone SE (3rd generation)", "iphone-se-3rd-generation"),
        ("  --iPad (A16)--  ", "ipad-a16"),
    ],
)
def test_the_device_slug_is_the_lower_cased_name_with_runs_of_other_characters_as_a_dash(
    name, slug
):
    assert check.device_slug(name) == slug


def test_a_valid_per_device_result_passes(root):
    put_device(root, valid_device())
    put_device(
        root,
        valid(family="iPadOS", device="iPad Pro 11-inch (M5)"),
        slug="ipad-pro-11-inch-m5",
        family="iPadOS",
    )
    assert problems(root) == []


def test_a_per_device_result_without_a_device_is_refused(root):
    put_device(root, valid())
    assert any("missing field(s): device" in line for line in problems(root))


def test_a_wrong_slug_is_refused_naming_the_file(root):
    put_device(root, valid_device(), slug="iphone-17-pro")
    found = problems(root)
    assert len(found) == 1
    assert found[0].startswith("results/apple/iOS/T0001/iphone-17-pro.json: ")
    assert "'iphone-18-pro'" in found[0] and "does not match the file name" in found[0]


def test_an_unknown_device_is_refused(root):
    put_device(root, valid(device="iPhone 99"), slug="iphone-99")
    found = problems(root)
    assert len(found) == 1
    assert "device 'iPhone 99' is not in the iOS 27 device list" in found[0]
    put_device(root, valid(device=7), slug="seven")
    assert any("device must be a non-empty string" in line for line in problems(root))


def test_a_device_listed_for_a_different_major_is_refused(root, tmp_path):
    lists = {
        "iOS": {
            "26": {"devices": ["iPhone 17 Pro"]},
            "27": {"devices": ["iPhone 18 Pro"]},
        }
    }
    devices = devices_file(tmp_path, lists)
    put_device(root, valid_device(version="27.1"))
    assert problems(root, devices=devices) == []
    put_device(root, valid_device(version="26.4"), build="T0002")
    found = problems(root, devices=devices)
    assert len(found) == 1
    assert "T0002/iphone-18-pro.json" in found[0]
    assert "device 'iPhone 18 Pro' is not in the iOS 26 device list" in found[0]


def test_a_major_without_a_device_list_is_refused(root):
    put_device(root, valid_device(version="26.4"))
    assert any("iOS 26 has no device list" in line for line in problems(root))
    put_device(root, valid_device(version="beta"), build="T0002")
    assert any("version must start with the OS major" in line for line in problems(root))


def test_a_family_without_a_device_list_is_refused(root):
    put_device(root, valid(family="macOS", device="MacBook Pro"), "macbook-pro", family="macOS")
    found = problems(root)
    assert len(found) == 1
    assert "macOS has no device list in the devices config" in found[0]


def test_a_device_key_in_a_per_build_file_is_refused(root):
    put(root, valid_device())
    found = problems(root)
    assert len(found) == 1
    assert found[0].startswith("results/apple/iOS/T0001.json: ")
    assert "device is not allowed in a per-build file" in found[0]


def test_one_build_may_not_use_both_layouts(root):
    put(root, valid())
    put_device(root, valid_device())
    found = problems(root)
    assert len(found) == 2
    assert any("T0001.json: build T0001 also has a per-device directory" in m for m in found)
    assert any("T0001/iphone-18-pro.json: build T0001 also has a per-build" in m for m in found)
    # Different builds may use different layouts.
    put_device(root, valid_device(build="T0002"), build="T0002")
    assert len(problems(root)) == 2


def test_the_per_device_result_still_follows_every_other_rule(root):
    put_device(root, valid_device(stage="beta", status="ok", extra=1, build="T0009"))
    found = "\n".join(problems(root))
    assert "stage 'beta' is refused" in found
    assert "status must be one of" in found
    assert "unknown field(s): extra" in found
    assert "build 'T0009' does not match its path ('T0001')" in found


def test_a_per_device_path_must_be_a_json_file_of_safe_names(root):
    (root / "apple" / "iOS" / "T0001").mkdir(parents=True)
    (root / "apple" / "iOS" / "T0001" / "notes.txt").write_text("x", encoding="utf-8")
    (root / "apple" / "iOS" / "T0001" / ".hidden.json").write_text("{}", encoding="utf-8")
    deep = root / "apple" / "iOS" / "T0001" / "a" / "b.json"
    deep.parent.mkdir()
    deep.write_text("{}", encoding="utf-8")
    found = "\n".join(problems(root))
    assert "T0001/notes.txt: expected <vendor>/<family>/<build>.json" in found
    assert "T0001/.hidden.json: vendor, family, build and slug must match" in found
    assert "T0001/a/b.json: expected <vendor>/<family>/<build>.json" in found


def test_a_missing_or_unreadable_devices_config_refuses_per_device_results_only(root, tmp_path):
    put(root, valid())
    assert problems(root, devices=tmp_path / "none.json") == []
    put_device(root, valid_device(), build="T0002")
    found = problems(root, devices=tmp_path / "none.json")
    assert len(found) == 1
    assert "T0002/iphone-18-pro.json" in found[0] and "devices config is missing" in found[0]
    bad = tmp_path / "bad.json"
    bad.write_text("not json", encoding="utf-8")
    assert "devices config is not readable" in problems(root, devices=bad)[0]
    bad.write_text(json.dumps({"families": {"iOS": []}}), encoding="utf-8")
    assert "devices config is not readable" in problems(root, devices=bad)[0]
    bad.write_text(
        json.dumps({"families": {"iOS": {"27": {"devices": "iPhone 18 Pro"}}}}),
        encoding="utf-8",
    )
    assert "must be a list of strings" in problems(root, devices=bad)[0]


def test_main_takes_the_devices_config(root, tmp_path, capsys):
    put_device(root, valid_device())
    snap = snapshot(tmp_path)
    args = ["--results", str(root), "--snapshot", str(snap), "--families", str(FAMILIES)]
    assert check.main([*args, "--devices", str(DEVICES)]) == 0
    assert "1 result file(s) ok" in capsys.readouterr().out
    assert check.main([*args, "--devices", str(tmp_path / "none.json")]) == 1
    assert "results/apple/iOS/T0001/iphone-18-pro.json" in capsys.readouterr().err


def test_the_build_lists_the_results_in_a_sorted_index(root, tmp_path):
    put(root, valid(build="T0003"), build="T0003")
    put_device(root, valid_device(status="warn", build="T0002"), build="T0002")
    put_device(
        root,
        valid(family="iPadOS", device="iPad Pro 11-inch (M5)", status="fail", build="T0002"),
        slug="ipad-pro-11-inch-m5",
        family="iPadOS",
        build="T0002",
    )
    put_device(root, valid_device(), slug="iphone-18-pro", build="T0001")
    put_device(
        root,
        valid(device="iPhone 17"),
        slug="iphone-17",
        build="T0001",
    )
    out = tmp_path / "site"
    site.build(REPO / "src", out, "v1", results=root)
    results = out / "data" / "results"
    index = json.loads((results / "index.json").read_text(encoding="utf-8"))
    assert index["schema"] == 1
    assert [(r["family"], r["build"], r["device"], r["status"]) for r in index["results"]] == [
        ("iOS", "T0001", "iPhone 17", "pass"),
        ("iOS", "T0001", "iPhone 18 Pro", "pass"),
        ("iOS", "T0002", "iPhone 18 Pro", "warn"),
        ("iOS", "T0003", None, "pass"),
        ("iPadOS", "T0002", "iPad Pro 11-inch (M5)", "fail"),
    ]
    assert all(r["vendor"] == "apple" for r in index["results"])
    for entry in index["results"]:
        assert entry["path"].startswith("/data/results/apple/")
        assert (out / entry["path"].lstrip("/")).is_file(), entry
    assert index["results"][3]["path"] == "/data/results/apple/iOS/T0003.json"
    assert index["results"][0]["path"] == "/data/results/apple/iOS/T0001/iphone-17.json"
    # The same tree always gives the same bytes.
    first = (results / "index.json").read_bytes()
    site.build(REPO / "src", out, "v1", results=root)
    assert (results / "index.json").read_bytes() == first


def test_the_build_refuses_a_bad_device_result_and_keeps_the_previous_build(root, tmp_path):
    out = tmp_path / "site"
    site.build(REPO / "src", out, "v1", results=root)
    put_device(root, valid(device="iPhone 99"), slug="iphone-99")
    with pytest.raises(SystemExit, match="not in the iOS 27 device list"):
        site.build(REPO / "src", out, "v2", results=root)
    assert (out / "version.txt").read_text(encoding="utf-8").strip() == "v1"
