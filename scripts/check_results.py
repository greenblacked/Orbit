#!/usr/bin/env python3
"""Validate the committed validation results.

Standard library only. A result is ``results/<vendor>/<family>/<build>.json``:

    {vendor, family, build, version, stage, status, checks: [{name, status, detail?}],
     testedAt, runner}

or, for one device, ``results/<vendor>/<family>/<build>/<device-slug>.json`` with the same
fields and a ``device`` that is listed for that family and the build's major in
src/data/devices.json, whose slug (``device_slug``) is the file name. A per-build file has no
``device``, and a build may use only one of the two layouts.

Only results for publicly released builds may be committed (results/README.md says why),
so this refuses a file whose ``stage`` is ``beta`` or ``rc``, and a file whose build the
releases snapshot lists only as a beta or an RC. A build the snapshot also lists as a
release is accepted: a release candidate and the final release often share a build.

    python scripts/check_results.py
    python scripts/check_results.py --results results --snapshot src/data/releases.json

With any result file present, a missing or unreadable snapshot is an error, and so is a
vendor and family that families.json does not list. Exit status 0 when every file is valid
(or there are none), 1 with one line per problem.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATUSES = ("pass", "warn", "fail", "untested")
PRE_RELEASE = ("beta", "rc")
FIELDS = (
    "vendor",
    "family",
    "build",
    "version",
    "stage",
    "status",
    "checks",
    "testedAt",
    "runner",
)
DEVICE_FIELDS = (*FIELDS, "device")
CHECK_FIELDS = ("name", "status", "detail")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
TESTED_AT_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
MAX_BYTES = 256 * 1024
PRIVATE = "pre-release software results stay private until the build is publicly released"


def text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def device_slug(name: str) -> str:
    """The file name of a device: lower case, each run outside [a-z0-9] one ``-``, trimmed."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def known_devices(devices: Path | None) -> dict[str, dict[str, list[str]]]:
    """The device names listed for each family and OS major in the devices config.

    Raises ``ValueError`` when the file is missing or unreadable.
    """
    if devices is None or not devices.is_file():
        raise ValueError(f"the devices config is missing ({devices})")
    try:
        families = json.loads(devices.read_text(encoding="utf-8"))["families"]
        return {
            family: {major: list(entry["devices"]) for major, entry in majors.items()}
            for family, majors in families.items()
        }
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise ValueError(f"the devices config is not readable ({devices}: {error})") from None


def device_problems(doc: dict, family: str, slug: str, devices: dict) -> list[str]:
    """Why the ``device`` of a per-device result is wrong for ``family`` and its file name."""
    device = doc.get("device")
    if "device" not in doc:
        return []
    if not text(device):
        return ["device must be a non-empty string"]
    found: list[str] = []
    if device_slug(device) != slug:
        found.append(
            f"device {device!r} has the slug {device_slug(device)!r}, "
            f"which does not match the file name ({slug!r})"
        )
    majors = devices.get(family)
    if majors is None:
        found.append(f"{family} has no device list in the devices config")
        return found
    version = doc.get("version")
    lead = re.match(r"\d+", version) if isinstance(version, str) else None
    if lead is None:
        found.append("version must start with the OS major to place the device")
        return found
    major = str(int(lead.group()))
    if major not in majors:
        found.append(f"{family} {major} has no device list in the devices config")
    elif device not in majors[major]:
        found.append(f"device {device!r} is not in the {family} {major} device list")
    return found


def snapshot_stages(snapshot: Path | None) -> dict[tuple[str, str, str], set[str]]:
    """The stages the snapshot lists for each (vendor, family, build).

    Raises ``ValueError`` when the snapshot is missing, unreadable or has no releases list:
    without it a beta could not be told from a release, so nothing is accepted.
    """
    if snapshot is None or not snapshot.is_file():
        raise ValueError(f"the releases snapshot is missing ({snapshot})")
    try:
        releases = json.loads(snapshot.read_text(encoding="utf-8"))["releases"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ValueError(f"the releases snapshot is not readable ({snapshot}: {error})") from None
    if not isinstance(releases, list):
        raise ValueError(f"the releases snapshot has no releases list ({snapshot})")
    stages: dict[tuple[str, str, str], set[str]] = {}
    for release in releases:
        if not isinstance(release, dict):
            continue
        key = (release.get("vendor"), release.get("family"), release.get("build"))
        stages.setdefault(key, set()).add(release.get("stage"))
    return stages


def known_families(families: Path | None) -> set[tuple[str, str]]:
    """The (vendor, family) pairs listed in the families config.

    Raises ``ValueError`` when the file is missing or unreadable.
    """
    if families is None or not families.is_file():
        raise ValueError(f"the families config is missing ({families})")
    try:
        entries = json.loads(families.read_text(encoding="utf-8"))["families"]
        return {(entry["vendor"], entry["id"]) for entry in entries}
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ValueError(f"the families config is not readable ({families}: {error})") from None


def check_document(
    doc: object,
    vendor: str,
    family: str,
    build: str,
    stages: dict,
    known: set,
    slug: str | None = None,
    devices: dict | None = None,
) -> list[str]:
    """Why ``doc`` is not a valid result for this path, as a list of messages.

    ``slug`` is the file name of a per-device result (``None`` for a per-build one) and
    ``devices`` the lists from ``known_devices`` (``None`` skips the device-list check).
    """
    if not isinstance(doc, dict):
        return ["the file must hold a JSON object"]
    problems: list[str] = []
    if (vendor, family) not in known:
        problems.append(f"{vendor}/{family} is not a vendor and family in the families config")
    allowed = FIELDS if slug is None else DEVICE_FIELDS
    extra = sorted(set(doc) - set(allowed))
    missing = [name for name in allowed if name not in doc]
    if slug is None and "device" in doc:
        extra.remove("device")
        problems.append("device is not allowed in a per-build file; use <build>/<device>.json")
    if slug is not None and devices is not None:
        problems += device_problems(doc, family, slug, devices)
    if extra:
        problems.append(f"unknown field(s): {', '.join(extra)}")
    if missing:
        problems.append(f"missing field(s): {', '.join(missing)}")
    for name in ("vendor", "family", "build", "version", "runner"):
        if name in doc and not text(doc[name]):
            problems.append(f"{name} must be a non-empty string")
    for name, expected in (("vendor", vendor), ("family", family), ("build", build)):
        if text(doc.get(name)) and doc[name] != expected:
            problems.append(f"{name} {doc[name]!r} does not match its path ({expected!r})")
    stage = doc.get("stage")
    if stage in PRE_RELEASE:
        problems.append(f"stage {stage!r} is refused: {PRIVATE}")
    elif "stage" in doc and stage != "release":
        problems.append(f"stage must be 'release', not {stage!r}")
    seen = stages.get((vendor, family, build), set())
    # The same build under any other family of the vendor counts too.
    same_build = [kinds for (v, _, b), kinds in stages.items() if v == vendor and b == build]
    pre = bool(seen & set(PRE_RELEASE)) or any(k & set(PRE_RELEASE) for k in same_build)
    released = "release" in seen or any("release" in k for k in same_build)
    if pre and not released:
        problems.append(f"build {build} is only a pre-release in the snapshot: {PRIVATE}")
    if "status" in doc and doc["status"] not in STATUSES:
        problems.append(f"status must be one of {', '.join(STATUSES)}")
    tested = doc.get("testedAt")
    if "testedAt" in doc:
        valid = isinstance(tested, str) and TESTED_AT_RE.fullmatch(tested) is not None
        if valid:
            try:
                datetime.strptime(tested, "%Y-%m-%dT%H:%M:%SZ")
            except ValueError:
                valid = False
        if not valid:
            problems.append("testedAt must be a UTC time like 2026-10-20T09:30:00Z")
    if "checks" in doc:
        problems += check_list(doc["checks"])
    return problems


def check_list(checks: object) -> list[str]:
    if not isinstance(checks, list):
        return ["checks must be a list"]
    problems: list[str] = []
    for index, entry in enumerate(checks):
        where = f"checks[{index}]"
        if not isinstance(entry, dict):
            problems.append(f"{where} must be an object")
            continue
        extra = sorted(set(entry) - set(CHECK_FIELDS))
        if extra:
            problems.append(f"{where} has unknown field(s): {', '.join(extra)}")
        if not text(entry.get("name")):
            problems.append(f"{where}.name must be a non-empty string")
        if entry.get("status") not in STATUSES:
            problems.append(f"{where}.status must be one of {', '.join(STATUSES)}")
        if "detail" in entry and not isinstance(entry["detail"], str):
            problems.append(f"{where}.detail must be a string")
    return problems


def problems(
    results: Path,
    snapshot: Path | None = None,
    families: Path | None = None,
    devices: Path | None = None,
) -> list[str]:
    """Every problem under ``results``, one ``path: message`` string each.

    A directory with no result file needs neither the snapshot nor the families config.
    Once a result file exists, a missing or unreadable one is an error and nothing passes.
    The devices config is read only once a per-device result exists, and a missing or
    unreadable one refuses each per-device result.
    """
    found: list[str] = []
    if not results.is_dir():
        return found
    entries = [p for p in results.rglob("*") if p.is_symlink() or not p.is_dir()]
    if all(p.relative_to(results).parts == ("README.md",) for p in entries):
        return found
    try:
        stages = snapshot_stages(snapshot)
        known = known_families(families or ROOT / "src" / "data" / "families.json")
    except ValueError as error:
        return [f"{results.name}: {error}; no result can be checked, so none is accepted"]
    device_lists: dict | None = None
    device_error = ""
    for path in sorted(results.rglob("*")):
        relative = path.relative_to(results)
        label = f"{results.name}/{relative.as_posix()}"
        if path.is_symlink():
            found.append(f"{label}: a symbolic link is refused")
            continue
        if path.is_dir():
            continue
        parts = relative.parts
        if parts == ("README.md",):
            continue
        if len(parts) not in (3, 4) or path.suffix != ".json":
            found.append(
                f"{label}: expected <vendor>/<family>/<build>.json"
                " or <vendor>/<family>/<build>/<device-slug>.json"
            )
            continue
        per_device = len(parts) == 4
        vendor, family = parts[0], parts[1]
        build, slug = (parts[2], path.stem) if per_device else (path.stem, None)
        names = (vendor, family, build) if slug is None else (vendor, family, build, slug)
        if not all(NAME_RE.fullmatch(part) for part in names):
            what = "vendor, family and build" if slug is None else "vendor, family, build and slug"
            found.append(f"{label}: {what} must match {NAME_RE.pattern}")
            continue
        sibling = results / vendor / family / f"{build}.json"
        if per_device and (sibling.is_file() or sibling.is_symlink()):
            found.append(f"{label}: build {build} also has a per-build file ({sibling.name})")
            continue
        if not per_device and (results / vendor / family / build).is_dir():
            found.append(f"{label}: build {build} also has a per-device directory ({build}/)")
            continue
        if per_device and device_lists is None and not device_error:
            try:
                device_lists = known_devices(devices or ROOT / "src" / "data" / "devices.json")
            except ValueError as error:
                device_error = str(error)
        if per_device and device_lists is None:
            found.append(f"{label}: {device_error}; a per-device result cannot be checked")
            continue
        if path.stat().st_size > MAX_BYTES:
            found.append(f"{label}: larger than {MAX_BYTES} bytes")
            continue
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            found.append(f"{label}: not readable JSON ({error})")
            continue
        messages = check_document(doc, vendor, family, build, stages, known, slug, device_lists)
        found += [f"{label}: {m}" for m in messages]
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="check_results", description=__doc__.split("\n", 1)[0])
    parser.add_argument("--results", type=Path, default=ROOT / "results")
    parser.add_argument("--snapshot", type=Path, default=ROOT / "src" / "data" / "releases.json")
    parser.add_argument("--families", type=Path, default=ROOT / "src" / "data" / "families.json")
    parser.add_argument("--devices", type=Path, default=ROOT / "src" / "data" / "devices.json")
    args = parser.parse_args(argv)
    found = problems(args.results, args.snapshot, args.families, args.devices)
    for line in found:
        print(line, file=sys.stderr)
    if found:
        print(f"{len(found)} problem(s) in the results", file=sys.stderr)
        return 1
    count = sum(1 for _ in args.results.rglob("*.json")) if args.results.is_dir() else 0
    print(f"{count} result file(s) ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
