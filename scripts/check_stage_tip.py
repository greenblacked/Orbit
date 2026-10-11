#!/usr/bin/env python3
"""Say whether this run is still the tip of ``main``, so a superseded one skips its upload.

Two pushes to ``main`` close together start two Preview runs. A concurrency group orders
nothing it does not cancel, so the older run can reach the upload after the newer one and
leave the stage Preview on code that is not the tip of main. Right before it uploads, the
job reads the current tip of ``refs/heads/main`` from the API and calls this with both SHAs.

Usage: ``check_stage_tip.py RUN_SHA TIP_SHA``. Prints ``current=true`` or ``current=false``
on stdout, for ``$GITHUB_OUTPUT``; a superseded run is not a failure, so the status is 0
either way. A SHA that is not 40 hex digits is exit status 2: a failed read of the tip is
never read as "current", and never as "superseded" either.
"""

from __future__ import annotations

import re
import sys

SHA_RE = re.compile(r"[0-9a-f]{40}")


def is_current(run_sha: str, tip_sha: str) -> bool:
    """True when ``run_sha`` is the tip. Both must be full lower-case SHAs."""
    for name, value in (("run", run_sha), ("tip", tip_sha)):
        if not SHA_RE.fullmatch(value):
            raise ValueError(f"the {name} SHA is not 40 hex digits: {value[:60]!r}")
    return run_sha == tip_sha


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 2:
        print("usage: check_stage_tip.py RUN_SHA TIP_SHA", file=sys.stderr)
        return 2
    try:
        current = is_current(args[0].strip(), args[1].strip())
    except ValueError as error:
        print(f"::error::{error}", file=sys.stderr)
        return 2
    if not current:
        print(
            f"::notice::{args[0][:7]} is no longer the tip of main ({args[1][:7]}); "
            "skipping its upload, the newer push uploads instead",
            file=sys.stderr,
        )
    print(f"current={'true' if current else 'false'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
