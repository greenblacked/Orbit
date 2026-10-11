#!/usr/bin/env python3
"""Validate the committed validation results.

Standard library only. A result is ``results/<vendor>/<family>/<build>.json``:

    {vendor, family, build, version, stage, status, checks: [{name, status, detail?}],
     testedAt, runner}

Only results for publicly released builds may be committed (results/README.md says why),
so this refuses a file whose ``stage`` is ``beta`` or ``rc``, and a file whose build the
releases snapshot lists only as a beta or an RC. A build the snapshot also lists as a
release is accepted: a release candidate and the final release often share a build.

    python scripts/check_results.py
    python scripts/check_results.py --results results --snapshot src/data/releases.json

Exit status 0 when every file is valid (or there are none), 1 with one line per problem.
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
CHECK_FIELDS = ("name", "status", "detail")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
TESTED_AT_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
MAX_BYTES = 256 * 1024
PRIVATE = "pre-release software results stay private until the build is publicly released"


def text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def snapshot_stages(snapshot: Path | None) -> dict[tuple[str, str, str], set[str]]:
    """The stages the snapshot lists for each (vendor, family, build)."""
    stages: dict[tuple[str, str, str], set[str]] = {}
    if snapshot is None or not snapshot.is_file():
        return stages
    try:
        releases = json.loads(snapshot.read_text(encoding="utf-8"))["releases"]
    except (OSError, ValueError, KeyError, TypeError):
        return stages
    for release in releases if isinstance(releases, list) else []:
        if not isinstance(release, dict):
            continue
        key = (release.get("vendor"), release.get("family"), release.get("build"))
        stages.setdefault(key, set()).add(release.get("stage"))
    return stages


def check_document(doc: object, vendor: str, family: str, build: str, stages: dict) -> list[str]:
    """Why ``doc`` is not a valid result for this path, as a list of messages."""
    if not isinstance(doc, dict):
        return ["the file must hold a JSON object"]
    problems: list[str] = []
    extra = sorted(set(doc) - set(FIELDS))
    missing = [name for name in FIELDS if name not in doc]
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
    if seen & set(PRE_RELEASE) and "release" not in seen:
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


def problems(results: Path, snapshot: Path | None = None) -> list[str]:
    """Every problem under ``results``, one ``path: message`` string each."""
    found: list[str] = []
    if not results.is_dir():
        return found
    stages = snapshot_stages(snapshot)
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
        if len(parts) != 3 or path.suffix != ".json":
            found.append(f"{label}: expected <vendor>/<family>/<build>.json")
            continue
        vendor, family, build = parts[0], parts[1], path.stem
        if not all(NAME_RE.fullmatch(part) for part in (vendor, family, build)):
            found.append(f"{label}: vendor, family and build must match {NAME_RE.pattern}")
            continue
        if path.stat().st_size > MAX_BYTES:
            found.append(f"{label}: larger than {MAX_BYTES} bytes")
            continue
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            found.append(f"{label}: not readable JSON ({error})")
            continue
        found += [f"{label}: {m}" for m in check_document(doc, vendor, family, build, stages)]
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="check_results", description=__doc__.split("\n", 1)[0])
    parser.add_argument("--results", type=Path, default=ROOT / "results")
    parser.add_argument("--snapshot", type=Path, default=ROOT / "src" / "data" / "releases.json")
    args = parser.parse_args(argv)
    found = problems(args.results, args.snapshot)
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
