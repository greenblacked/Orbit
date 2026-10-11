#!/usr/bin/env python3
"""Fail unless a pull request's head branch has an allowed name.

Working branches are named ``fb-<kebab>`` (for example ``fb-contact-form``): lower-case
letters, digits and single hyphens after the ``fb-`` prefix. The long-lived branches
``main``, ``stage`` and ``dev`` and the bot namespace ``dependabot/`` are exempt, which
also lets a promotion pull request (head ``dev`` or ``stage``) through.

The name comes from the environment (``HEAD_REF``) or the first argument, never from a
workflow expression spliced into a shell line: a branch name is chosen by whoever opens
the pull request.

    HEAD_REF=fb-contact-form python scripts/check_branch_name.py
    python scripts/check_branch_name.py dependabot/github_actions/actions-1
"""

from __future__ import annotations

import os
import re
import sys

WORKING_BRANCH = re.compile(r"^fb-[a-z0-9][a-z0-9-]*$")
LONG_LIVED = frozenset({"main", "stage", "dev"})
BOT_PREFIXES = ("dependabot/",)
# GitHub caps a ref at 255 bytes; nothing here needs more than a short name.
MAX_LENGTH = 100


def is_allowed(name: str) -> bool:
    """True when ``name`` may head a pull request."""
    if len(name) > MAX_LENGTH:
        return False
    if name in LONG_LIVED or name.startswith(BOT_PREFIXES):
        return True
    return WORKING_BRANCH.fullmatch(name) is not None


def printable(name: str) -> str:
    """The name made safe to print in a workflow annotation."""
    cleaned = re.sub(r"[^\x20-\x7e]", "?", name[:MAX_LENGTH]).replace("%", "%25")
    return cleaned + ("..." if len(name) > MAX_LENGTH else "")


def message(name: str) -> str:
    return (
        f"branch '{printable(name)}' is not an allowed name. Working branches are "
        "fb-<kebab> (lower-case letters, digits and hyphens, for example "
        "fb-contact-form). main, stage, dev and dependabot/* are exempt. "
        "Rename the branch and reopen the pull request."
    )


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) > 1:
        print("usage: check_branch_name.py [BRANCH]", file=sys.stderr)
        return 2
    name = args[0] if args else os.environ.get("HEAD_REF", "")
    if not name:
        print("no head branch (not a pull request): nothing to check")
        return 0
    if is_allowed(name):
        print(f"branch '{printable(name)}' is allowed")
        return 0
    print(f"::error title=Branch name::{message(name)}")
    print(message(name), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
