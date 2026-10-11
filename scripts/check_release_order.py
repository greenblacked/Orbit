#!/usr/bin/env python3
"""Fail when a newer ``vX.Y.Z`` release tag exists than the one being deployed.

Two releases cut close together start two Release runs. The production deploy is
serialised by a concurrency group, but a group orders nothing: it runs whichever run is
waiting, so the older tag can deploy after the newer one and leave production on the older
version. This is the check the deploying job makes right before it deploys, so the run that
loses the race stops instead of overwriting the newer release.

Usage: ``check_release_order.py [--include-equal] vX.Y.Z < tag-names`` where stdin holds one
tag name or ``refs/tags/`` ref per line (the workflow reads them from the API at that
moment). Versions are compared as numbers, so ``v1.10.0`` is newer than ``v1.9.0``.
Anything on stdin that is not ``vX.Y.Z`` is ignored. Exit status 1 names the newer tags.
``--include-equal`` also fails on a tag that spells the same number, which is what Cut
release asks before it creates one.

The tag being checked must be canonical: each number is ``0`` or starts with 1-9, so ``v01.2.3``
is refused (exit 2). A tag already in the list that is not canonical (somebody pushed ``v01.2.3``
by hand) still counts as the number it spells, so it cannot let an older release through; it is
named as written. The same pattern is in ``release.yml`` and ``cut-release.yml``.
"""

from __future__ import annotations

import re
import sys

_NUMBER = r"(0|[1-9][0-9]*)"
CANONICAL_RE = re.compile(rf"v{_NUMBER}\.{_NUMBER}\.{_NUMBER}")
# ASCII digits only: ``\d`` would also match other scripts' digits, which int() accepts.
LOOSE_RE = re.compile(r"(?:refs/tags/)?v([0-9]+)\.([0-9]+)\.([0-9]+)")


def parse(name: str) -> tuple[int, int, int] | None:
    """``(major, minor, patch)`` for a canonical ``vX.Y.Z`` tag name, else ``None``."""
    match = CANONICAL_RE.fullmatch(name.strip())
    return tuple(int(part) for part in match.groups()) if match else None  # type: ignore[return-value]


def _existing_version(name: str) -> tuple[int, int, int] | None:
    """The number an existing tag spells, canonical or not (``v01.2.3`` is 1.2.3)."""
    match = LOOSE_RE.fullmatch(name.strip())
    return tuple(int(part) for part in match.groups()) if match else None  # type: ignore[return-value]


def newer_tags(tag: str, existing: list[str], include_equal: bool = False) -> list[str]:
    """The ``vX.Y.Z`` names in ``existing`` that are greater than ``tag`` (or equal, when
    ``include_equal``), oldest first."""
    current = parse(tag)
    if current is None:
        raise ValueError(f"{tag!r} is not a canonical vX.Y.Z tag (no leading zeros)")
    found: dict[tuple[int, int, int], list[str]] = {}
    for name in existing:
        version = _existing_version(name)
        if version is not None and (version > current or (include_equal and version == current)):
            written = name.strip().removeprefix("refs/tags/")
            if written not in found.setdefault(version, []):
                found[version].append(written)
    return [written for version in sorted(found) for written in found[version]]


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    include_equal = "--include-equal" in args
    args = [arg for arg in args if arg != "--include-equal"]
    if len(args) != 1:
        print("usage: check_release_order.py [--include-equal] vX.Y.Z < tag-names", file=sys.stderr)
        return 2
    try:
        newer = newer_tags(args[0], sys.stdin.read().splitlines(), include_equal)
    except ValueError as error:
        print(f"::error::{error}", file=sys.stderr)
        return 2
    if newer:
        print(
            f"::error::{args[0]} is not newer than {', '.join(newer)}; not deploying over it",
            file=sys.stderr,
        )
        print("::error::re-run the newer release if it has not deployed", file=sys.stderr)
        return 1
    print(f"no release newer than {args[0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
