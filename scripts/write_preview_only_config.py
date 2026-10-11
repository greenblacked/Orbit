#!/usr/bin/env python3
"""Write a copy of the Wrangler config whose custom domain serves Preview traffic only.

Until the first release exists, the stage Preview needs ``orbit.szolotov.com`` attached to
the Worker, and only a Wrangler deploy command attaches a route. A custom-domain route with
``"previews_enabled": true`` and ``"enabled": false`` serves Preview traffic and no
Production traffic, so attaching it that way puts nothing on the live domain. The config
the release deploys (``deploy/wrangler.json``) stays Production and Preview and is never
changed: this writes a second file, which ``wrangler triggers deploy`` applies.

Usage: ``write_preview_only_config.py CONFIG OUTPUT``. On every route with
``custom_domain`` true this sets ``enabled`` to false and ``previews_enabled`` to true, and
keeps every other key. Write OUTPUT next to CONFIG so relative paths in it (``main``,
``assets.directory``) still resolve. A config with no custom-domain route is an error:
there would be nothing to attach, and a silent no-op would look like success.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def preview_only(config: object) -> dict:
    """A copy of ``config`` with every custom-domain route set to Preview traffic only."""
    if not isinstance(config, dict):
        raise SystemExit("the Wrangler config is not a JSON object")
    routes = config.get("routes")
    if not isinstance(routes, list):
        raise SystemExit("the Wrangler config has no routes list")
    result = json.loads(json.dumps(config))
    found = 0
    for route in result["routes"]:
        if isinstance(route, dict) and route.get("custom_domain") is True:
            route["enabled"] = False
            route["previews_enabled"] = True
            found += 1
    if found == 0:
        raise SystemExit("the Wrangler config has no custom-domain route to attach")
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="write_preview_only_config", description=__doc__.split("\n", 1)[0]
    )
    parser.add_argument("config", type=Path, help="the Wrangler JSON config to read")
    parser.add_argument("output", type=Path, help="where to write the Preview-only copy")
    args = parser.parse_args(argv)
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"cannot read {args.config} as JSON: {error}") from None
    args.output.write_text(json.dumps(preview_only(config), indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
