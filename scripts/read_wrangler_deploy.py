#!/usr/bin/env python3
"""Read the workers.dev URL out of a Wrangler deploy or preview log.

Wrangler appends one JSON object per line when ``WRANGLER_OUTPUT_FILE_PATH`` is set.
The line with ``"type": "deploy"`` carries ``targets``, the URLs that version is
served at. This prints ``url=`` and, when Wrangler sent one, ``version_id=`` in the
form ``GITHUB_OUTPUT`` expects, and nothing else on stdout. It also prints
``custom_url=https://orbit.szolotov.com`` when a target is that custom domain as Wrangler
renders it, ``orbit.szolotov.com (custom domain)`` with its optional zone and flag
suffixes and no scheme: the release checks that line to know this deploy attached the
custom domain, because it cannot fetch that domain from a GitHub runner (Bot Fight Mode
answers it with a 403).

A target is accepted only as ``https`` on a ``workers.dev`` host, with no user, port,
path or query. Anything else is dropped. When several targets qualify, the one with
the fewest labels wins: that is ``name.account.workers.dev``, not a longer preview
host. A missing or unreadable URL is an error, because a deploy that succeeded and
then left no address cannot be smoke-tested.

``--preview`` reads the last ``"type": "preview"`` line instead and takes its
``preview_urls``. It prints ``url=`` for the workers.dev Preview URL, when there is
one, and ``custom_url=`` for the Preview's host under the production custom domain,
when Wrangler reported one. A Preview URL is accepted under the same https rules, on
a ``workers.dev`` host or on ``orbit.szolotov.com`` or one of its subdomains. Wrangler
only reports the custom host once that domain is enabled for Preview traffic, so a
missing ``custom_url`` is for the caller to turn into an error, not for this script.

``--active`` reads the JSON ``wrangler deployments status --json`` prints instead: the
Worker's current production deployment. It prints ``version_id=`` for the version
serving all of its traffic, which is what a release rolls back to if its smoke test
fails. Without that ID ``wrangler rollback`` picks the version uploaded before the
newest one, which after an earlier failed release is that failed release, not what was
serving. A deployment that splits traffic between versions, a gradual rollout, has no
single version to return to and is an error: finish or revert the rollout first.

``--active-is VERSION_ID`` reads the same JSON and succeeds, printing ``version_id=``,
only when that version serves all of the traffic. A release uses it to prove the custom
domain serves the version it just deployed without fetching through the zone. Any
other version, a split, or an unreadable status is an error.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# One label is 1-63 characters, cannot start or end with a hyphen. The host must be
# at least three labels so a bare https://workers.dev cannot pass.
HOST_RE = re.compile(
    r"^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){2,}$"
)
# The production custom domain. A Preview is served at <name>.<this domain> once the
# domain's route has previews_enabled, so a host is trusted only at or below it.
CUSTOM_DOMAIN = "orbit.szolotov.com"
PRODUCTION_URL = f"https://{CUSTOM_DOMAIN}"
STAGE_URL = f"https://stage.{CUSTOM_DOMAIN}"
VERSION_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _acceptable(url: object) -> str | None:
    if not isinstance(url, str) or HOST_RE.fullmatch(url) is None:
        return None
    if not url.endswith(".workers.dev"):
        return None
    return url


def _acceptable_preview(url: object) -> str | None:
    if not isinstance(url, str) or HOST_RE.fullmatch(url) is None:
        return None
    host = url.removeprefix("https://")
    if host.endswith(".workers.dev") or host == CUSTOM_DOMAIN or host.endswith("." + CUSTOM_DOMAIN):
        return url
    return None


def parse_preview(text: str) -> tuple[str, str]:
    """``(workers_dev_url, custom_url)`` from the last preview line; either may be empty.

    ``custom_url`` is the stage host when it is reported, else the shortest other host
    at or below the custom domain, so the caller can say which host it got instead.
    """
    urls: list[str] = []
    for raw in text.splitlines():
        if not raw.strip():
            continue
        try:
            item = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(item, dict) or item.get("type") != "preview":
            continue
        reported = item.get("preview_urls")
        urls = []
        if isinstance(reported, list):
            for entry in reported:
                url = _acceptable_preview(entry)
                if url is not None:
                    urls.append(url)
    if not urls:
        raise SystemExit("wrangler preview reported no https workers.dev or custom-domain URL")
    urls.sort(key=lambda url: (url.count("."), len(url)))
    workers_dev = next((url for url in urls if url.endswith(".workers.dev")), "")
    custom = [url for url in urls if not url.endswith(".workers.dev")]
    chosen = STAGE_URL if STAGE_URL in custom else (custom[0] if custom else "")
    return workers_dev, chosen


def parse_active(text: str) -> str:
    """The version ID serving 100% of a deployment, from ``deployments status --json``."""
    try:
        deployment = json.loads(text)
    except json.JSONDecodeError:
        raise SystemExit("wrangler deployments status did not print JSON") from None
    versions = deployment.get("versions") if isinstance(deployment, dict) else None
    if not isinstance(versions, list):
        raise SystemExit("the active deployment lists no versions")
    serving = [
        item.get("version_id")
        for item in versions
        if isinstance(item, dict)
        and isinstance(item.get("percentage"), (int, float))
        and not isinstance(item.get("percentage"), bool)
        and item["percentage"] == 100
    ]
    if len(versions) != 1 or len(serving) != 1:
        raise SystemExit(
            "the active deployment splits traffic between versions; finish or revert the "
            "gradual rollout before releasing"
        )
    version_id = serving[0]
    if not isinstance(version_id, str) or VERSION_ID_RE.fullmatch(version_id) is None:
        raise SystemExit("the active deployment's version ID is not a version ID")
    return version_id


def _is_production_custom_domain(target: object) -> bool:
    """Whether a deploy target is Wrangler's rendering of the production custom domain.

    Wrangler adds ``https://`` to a ``workers.dev`` target only. A custom-domain route is
    the bare pattern followed by ``(custom domain)``, ``(custom domain - zone id: ...)``
    or ``(custom domain - zone name: ...)`` and then flags such as ``[previews: enabled]``
    (``renderRoute`` in Wrangler's deploy helpers). Without the marker the target is a
    plain route, which does not attach the domain. The host is compared whole and
    case-sensitively, so ``orbit.szolotov.com.evil.com`` and ``evil.orbit.szolotov.com`` fail.
    """
    if not isinstance(target, str):
        return False
    host, separator, rest = target.partition(" ")
    if host != CUSTOM_DOMAIN or not separator:
        return False
    marker = "(custom domain"
    if not (rest.startswith(marker) and rest[len(marker) : len(marker) + 1] in (")", " ")):
        return False
    # A domain attached with `enabled: false` renders `[production: disabled, ...]`: it is
    # on the Worker but serves no production traffic, so it does not count as attached.
    return "production: disabled" not in rest


def parse_deploy(text: str) -> tuple[str, str, str]:
    """``(url, version_id, custom_url)`` from the last deploy line that has a workers.dev target.

    ``version_id`` and ``custom_url`` are empty when the line has none we can trust.
    """
    chosen: str | None = None
    version_id = ""
    custom = ""
    for raw in text.splitlines():
        if not raw.strip():
            continue
        try:
            item = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(item, dict) or item.get("type") != "deploy":
            continue
        targets = item.get("targets")
        found = []
        custom_found = ""
        if isinstance(targets, list):
            for target in targets:
                url = _acceptable(target)
                if url is not None:
                    found.append(url)
                if _is_production_custom_domain(target):
                    custom_found = PRODUCTION_URL
        if not found:
            continue
        # Fewer labels first, then the shorter URL. A preview host is longer.
        found.sort(key=lambda url: (url.count("."), len(url)))
        chosen = found[0]
        custom = custom_found
        candidate = item.get("version_id")
        version_id = (
            candidate if isinstance(candidate, str) and VERSION_ID_RE.fullmatch(candidate) else ""
        )
    if chosen is None:
        raise SystemExit("wrangler deploy reported no https workers.dev target")
    return chosen, version_id, custom


def parse(text: str) -> tuple[str, str]:
    """``(url, version_id)``. ``version_id`` is empty when the line has none we can trust."""
    url, version_id, _custom = parse_deploy(text)
    return url, version_id


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="read_wrangler_deploy", description=__doc__.split("\n", 1)[0]
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--preview", action="store_true", help="read a wrangler preview log, not a deploy log"
    )
    mode.add_argument(
        "--active",
        action="store_true",
        help="read `wrangler deployments status --json` and print the serving version ID",
    )
    mode.add_argument(
        "--active-is",
        metavar="VERSION_ID",
        help="succeed only when `wrangler deployments status --json` shows this version at 100%%",
    )
    parser.add_argument("path", type=Path, help="the WRANGLER_OUTPUT_FILE_PATH file")
    args = parser.parse_args(argv)
    if not args.path.is_file():
        print(f"no wrangler output at {args.path}", file=sys.stderr)
        return 1
    if args.active:
        sys.stdout.write(f"version_id={parse_active(args.path.read_text(encoding='utf-8'))}\n")
        return 0
    if args.active_is is not None:
        if VERSION_ID_RE.fullmatch(args.active_is) is None:
            raise SystemExit("--active-is needs the version ID the deploy reported")
        serving = parse_active(args.path.read_text(encoding="utf-8"))
        if serving != args.active_is:
            raise SystemExit(
                f"the active deployment serves version {serving}, not {args.active_is}"
            )
        sys.stdout.write(f"version_id={serving}\n")
        return 0
    if args.preview:
        url, custom_url = parse_preview(args.path.read_text(encoding="utf-8"))
        if url:
            sys.stdout.write(f"url={url}\n")
        if custom_url:
            sys.stdout.write(f"custom_url={custom_url}\n")
        return 0
    url, version_id, custom_url = parse_deploy(args.path.read_text(encoding="utf-8"))
    sys.stdout.write(f"url={url}\n")
    if custom_url:
        sys.stdout.write(f"custom_url={custom_url}\n")
    if version_id:
        sys.stdout.write(f"version_id={version_id}\n")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
