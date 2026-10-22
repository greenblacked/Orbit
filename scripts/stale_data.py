#!/usr/bin/env python3
"""Warn when the committed data snapshots are getting old. Never fails a build.

Standard library only. The security notes carry ``generatedAt`` and the releases snapshot
``fetchedAt``. This warns when security is older than 21 days or releases older than 14, well
before the security page marks a row stale after 30 days (src/assets/security.js). That page
judges each row by its own ``checkedAt``, which can be older than ``generatedAt`` when a
source could not be read again, so this is a refresh reminder for the snapshots as a whole,
not a check of every row.

    python scripts/stale_data.py
    python scripts/stale_data.py --security PATH --releases PATH

A stale, missing or unreadable value prints a GitHub ``::warning::`` annotation that says how
to refresh it, and a summary line always follows. The exit status is 0 whatever the data says
and whatever goes wrong while running: this is a nudge to refresh, not a gate. That covers
runtime errors only. A bad command-line argument still exits 2 through argparse, which is
fine because CI passes no arguments.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECURITY_MAX_AGE = timedelta(days=21)
RELEASES_MAX_AGE = timedelta(days=14)
# (label, field, maximum age, how to refresh)
CHECKS = (
    (
        "security",
        "generatedAt",
        SECURITY_MAX_AGE,
        "run the Security snapshot workflow (Actions, Run workflow)",
    ),
    ("releases", "fetchedAt", RELEASES_MAX_AGE, "run `node deploy/snapshot_releases.mjs`"),
)
MINUTE = timedelta(minutes=1)


def parse_time(value: object) -> datetime | None:
    """A UTC datetime from an ISO 8601 string such as ``2026-10-18T22:06:46Z``, else None."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    try:
        return parsed.astimezone(timezone.utc)
    except OverflowError:  # year 1 or 9999 with an offset
        return None


def read_field(path: Path, field: str) -> object:
    """The top-level ``field`` of a JSON file, or None when it cannot be read."""
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError):
        return None
    return doc.get(field) if isinstance(doc, dict) else None


def describe_age(age: timedelta, limit: timedelta) -> str:
    """``21d 0h 30m`` for an age: whole minutes, rounded up when over ``limit`` so that an age
    just past the limit never reads as exactly the limit."""
    minutes = -(-age // MINUTE) if age > limit else age // MINUTE
    days, rest = divmod(minutes, 24 * 60)
    hours, minutes = divmod(rest, 60)
    return f"{days}d {hours}h {minutes}m"


def annotation(title: str, message: str) -> str:
    """A workflow-command warning; ``%`` and line breaks are escaped as the runner expects."""
    escaped = message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    return f"::warning title={title}::{escaped}"


def assess(paths: dict[str, Path], now: datetime) -> tuple[list[str], list[str]]:
    """(warnings, summaries) for each snapshot, judged against ``now``."""
    warnings: list[str] = []
    summaries: list[str] = []
    for label, field, limit, refresh in CHECKS:
        path = paths[label]
        stamp = parse_time(read_field(path, field))
        if stamp is None:
            warnings.append(annotation(f"{label} data", f"{path.name} has no readable {field}"))
            summaries.append(f"{label}: age unknown ({field} missing or invalid)")
            continue
        age = max(now - stamp, timedelta(0))
        old = f"{describe_age(age, limit)} old"
        if age > limit:
            warnings.append(
                annotation(
                    f"{label} data is stale",
                    f"{path.name} {field} is {old}, over the {limit.days}-day limit; "
                    f"refresh it: {refresh}",
                )
            )
            summaries.append(f"{label}: {old}, over the {limit.days}-day limit")
        else:
            summaries.append(f"{label}: {old}, within the {limit.days}-day limit")
    return warnings, summaries


def main(argv: list[str] | None = None, now: datetime | None = None) -> int:
    parser = argparse.ArgumentParser(prog="stale_data", description=__doc__.split("\n", 1)[0])
    parser.add_argument("--security", type=Path, default=ROOT / "src" / "data" / "security.json")
    parser.add_argument("--releases", type=Path, default=ROOT / "src" / "data" / "releases.json")
    args = parser.parse_args(argv)
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    warnings, summaries = assess({"security": args.security, "releases": args.releases}, now)
    for line in warnings:
        print(line)
    print("data freshness: " + "; ".join(summaries))
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception as error:  # a freshness nudge must never turn a build red
        print(annotation("stale data check", f"could not run: {error}"))
        code = 0
    sys.exit(code)
