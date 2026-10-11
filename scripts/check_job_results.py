#!/usr/bin/env python3
"""Fail unless an aggregate job received exactly the expected successful results."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

JOB_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
KNOWN_RESULTS = {"success", "failure", "cancelled", "skipped"}


def reject_duplicate_keys(pairs):
    """Build a JSON object while refusing ambiguous duplicate member names."""
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value


def evaluate(
    expected: list[str], raw: str | None, skippable: list[str] | None = None
) -> tuple[bool, list[tuple[str, str]]]:
    """Return the verdict and safe summary rows without reflecting JSON values.

    `skippable` names the jobs the caller allows to be skipped on this run (the
    branch-name job outside pull requests, and codeql while the repository is
    private). A `skipped` result passes for those and nothing else; every other
    job still has to succeed, and a cancelled or failed job fails whether or not
    it is listed. A list naming a job the
    aggregate does not expect, or anything that is not a job id, fails the gate rather
    than being trimmed, because a wrong list means the caller and the workflow disagree.
    """
    skippable = list(skippable or [])
    if not expected or len(expected) != len(set(expected)):
        return False, []
    if any(not JOB_ID_RE.fullmatch(job) for job in expected):
        return False, []
    if any(job not in expected for job in skippable):
        return False, [(job, "invalid") for job in expected]
    rows = [(job, "invalid") for job in expected]
    if raw is None:
        return False, rows
    try:
        needs = json.loads(raw, object_pairs_hook=reject_duplicate_keys)
    except (json.JSONDecodeError, TypeError, ValueError):
        return False, rows
    if not isinstance(needs, dict) or set(needs) != set(expected):
        return False, rows

    rows = []
    passed = True
    for job in expected:
        entry = needs[job]
        result = entry.get("result") if isinstance(entry, dict) else None
        safe_result = result if isinstance(result, str) and result in KNOWN_RESULTS else "invalid"
        rows.append((job, safe_result))
        if result != "success" and not (result == "skipped" and job in skippable):
            passed = False
    return passed, rows


def append_summary(path: str | None, rows: list[tuple[str, str]]) -> bool:
    """Append the bounded result table GitHub displays, if a summary path was supplied."""
    if not path:
        return True
    try:
        with Path(path).open("a", encoding="utf-8") as summary:
            summary.write("| Job | Result |\n| --- | --- |\n")
            for job, result in rows:
                summary.write(f"| `{job}` | {result} |\n")
    except OSError:
        return False
    return True


def main(argv: list[str] | None = None) -> int:
    expected = list(sys.argv[1:] if argv is None else argv)
    skippable = os.environ.get("SKIPPABLE", "").split()
    passed, rows = evaluate(expected, os.environ.get("NEEDS_JSON"), skippable)
    summary_written = append_summary(os.environ.get("GITHUB_STEP_SUMMARY"), rows)
    if passed and summary_written:
        print(f"all {len(rows)} required job(s) succeeded")
        return 0
    print("aggregate job results did not satisfy the required set", file=sys.stderr)
    return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
