#!/usr/bin/env python3
"""Build the site: copy src/ to dist/site/ and stamp it with a version.

Standard library only. The site is plain HTML, one stylesheet and two small scripts, so
there is nothing to compile; the build exists to give every deploy an exact version
(version.txt and a meta tag on every page, which the smoke test reads back), to write
robots.txt and sitemap.xml from the pages that exist (a preview build blocks crawlers and
has no sitemap), and to refuse to overwrite a directory that is not a previous build.

    python scripts/build_site.py --version v1.2.3
    python scripts/build_site.py --version stage-abc1234 --noindex

The validation results under ``results/`` are copied to ``data/results/`` in the build, after
``check_results.py`` has accepted them: a result for a beta or an RC fails the build.
``data/results/index.json`` lists them (vendor, family, build, device or null, status, path).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import sys
from pathlib import Path
from xml.sax.saxutils import escape

from check_results import problems as result_problems
from site_pages import indexable_urls, invalid_page_paths

ROOT = Path(__file__).resolve().parent.parent
SENTINEL = ".site-build"
SENTINEL_TEXT = (
    "This directory was produced by scripts/build_site.py. "
    "A new build deletes it only when this file is present.\n"
)
# A version is a label written into pages and into version.txt. It is never a path.
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$")
STAMP = "{{version}}"
# Files whose text carries the version token. Everything else is copied byte for byte.
STAMPED = {".html"}
# The production host. Sitemap URLs are absolute, so they need it.
DOMAIN = "orbit.szolotov.com"
DOMAIN_RE = re.compile(r"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$")
REQUIRED = ("index.html", "404.html", "favicon.png", "apple-touch-icon.png")


def normalise_version(raw: str) -> str:
    """The version label, or exit. Rejects anything that is not a single token."""
    version = raw.strip()
    if VERSION_RE.fullmatch(version) is None:
        raise SystemExit(
            f"refusing version {raw!r}: use a token such as v1.2.3, pr-abcdef0 or stage-abcdef0"
        )
    return version


def unsafe_output(root: Path, output: Path) -> str | None:
    """Why ``output`` must not be replaced, or ``None`` when it may be."""
    resolved_root = root.resolve()
    resolved_out = output.resolve()
    if resolved_out == Path.home().resolve():
        return "it is the home directory"
    if resolved_out == resolved_root or resolved_out in resolved_root.parents:
        return "it is the repository root or a directory that contains it"
    if output.is_symlink():
        return "it is a symbolic link"
    if output.exists():
        marker = output / SENTINEL
        try:
            genuine = (
                output.is_dir()
                and stat.S_ISREG(os.lstat(marker).st_mode)
                and marker.read_text(encoding="utf-8") == SENTINEL_TEXT
            )
        except (OSError, UnicodeDecodeError):
            genuine = False
        if not genuine:
            return f"it is not a previous build (no regular {SENTINEL} file with its text)"
    return None


def overlaps_source(source: Path, output: Path) -> str | None:
    """Why ``output`` and ``source`` must not be used together, or ``None``."""
    src = source.resolve()
    out = output.resolve()
    if out == src:
        return "it is the source directory"
    if src in out.parents:
        return "it is inside the source directory"
    if out in src.parents:
        return "it contains the source directory"
    return None


def robots(noindex: bool, domain: str = DOMAIN) -> str:
    if noindex:
        return "User-agent: *\nDisallow: /\n"
    return f"User-agent: *\nAllow: /\n\nSitemap: https://{domain}/sitemap.xml\n"


def sitemap(urls: list[str], domain: str = DOMAIN) -> str:
    """sitemap.xml for the given page paths, absolute on ``domain``."""
    entries = "".join(
        f"  <url><loc>{escape(f'https://{domain}{url}')}</loc></url>\n" for url in urls
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + entries + "</urlset>\n"
    )


def copy_results(results: Path, output: Path) -> int:
    """Copy the validated result files to ``output/data/results``; return how many.

    The directory is always made, with an ``index.json`` listing what it holds, so the page
    that reads it finds an empty index rather than a missing path. Call it only after
    ``check_results`` has accepted the files.
    """
    target = output / "data" / "results"
    target.mkdir(parents=True, exist_ok=True)
    entries = []
    for path in sorted(results.rglob("*.json")) if results.is_dir() else []:
        relative = path.relative_to(results)
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)
        doc = json.loads(path.read_text(encoding="utf-8"))
        entries.append(
            {
                "vendor": doc["vendor"],
                "family": doc["family"],
                "build": doc["build"],
                "device": doc.get("device"),
                "status": doc["status"],
                "path": f"/data/results/{relative.as_posix()}",
            }
        )
    entries.sort(key=lambda e: (e["vendor"], e["family"], e["build"], e["device"] or ""))
    index = {"schema": 1, "results": entries}
    (target / "index.json").write_text(
        json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return len(entries)


def build(
    source: Path,
    output: Path,
    version: str,
    *,
    noindex: bool = False,
    domain: str = DOMAIN,
    results: Path | None = None,
) -> None:
    """Replace ``output`` with the site in ``source`` stamped with ``version``.

    With ``results``, the validation results in that directory are copied to
    ``data/results`` after they pass ``check_results``.
    """
    version = normalise_version(version)
    if DOMAIN_RE.fullmatch(domain) is None:
        raise SystemExit(f"refusing domain {domain!r}: expected a lower-case hostname")
    if not source.is_dir():
        raise SystemExit(f"no source directory at {source}")
    links = sorted(path for path in source.rglob("*") if path.is_symlink())
    if links:
        # A link would publish whatever it points at on the machine that builds the site.
        raise SystemExit(
            "refusing symbolic link(s) under the source: " + ", ".join(str(p) for p in links)
        )
    missing = [name for name in REQUIRED if not (source / name).is_file()]
    if missing:
        raise SystemExit(f"{source} lacks required file(s): {', '.join(missing)}")
    bad = invalid_page_paths(source)
    if bad:
        raise SystemExit(
            "refusing page path(s) outside [a-z0-9][a-z0-9._-]* in each segment: "
            + ", ".join(f"{source / name}" for name in bad)
        )
    reason = overlaps_source(source, output) or unsafe_output(ROOT, output)
    if reason is not None:
        raise SystemExit(f"refusing to write {output}: {reason}")
    if results is not None:
        # Before anything is deleted, so a refused result leaves the previous build alone.
        bad_results = result_problems(
            results,
            source / "data" / "releases.json",
            source / "data" / "families.json",
            source / "data" / "devices.json",
        )
        if bad_results:
            raise SystemExit("refusing result file(s):\n" + "\n".join(bad_results))
    # Read and check every page before anything is deleted, so a refusal leaves the
    # previous build alone rather than a half-made one.
    files = sorted(path for path in source.rglob("*") if path.is_file())
    stamped: dict[Path, str] = {}
    for path in files:
        if path.suffix in STAMPED:
            text = path.read_text(encoding="utf-8")
            if STAMP not in text:
                raise SystemExit(f"{path} has no {STAMP} for the build to fill in")
            stamped[path] = text.replace(STAMP, version)
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    (output / SENTINEL).write_text(SENTINEL_TEXT, encoding="utf-8")
    # Wrangler reads this and does not upload the sentinel: a dotfile with no other
    # purpose should not be part of the site a visitor can fetch.
    (output / ".assetsignore").write_text(f"{SENTINEL}\n", encoding="utf-8")
    for path in files:
        target = output / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        if path in stamped:
            target.write_text(stamped[path], encoding="utf-8")
        else:
            shutil.copyfile(path, target)
    if results is not None:
        copy_results(results, output)
    (output / "version.txt").write_text(version + "\n", encoding="utf-8")
    (output / "robots.txt").write_text(robots(noindex, domain), encoding="utf-8")
    if not noindex:
        urls = indexable_urls(output)
        (output / "sitemap.xml").write_text(sitemap(urls, domain), encoding="utf-8")
    print(f"built {output} for {version}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="build_site", description=__doc__.split("\n", 1)[0])
    parser.add_argument("--version", required=True, help="label for this build, e.g. v1.2.3")
    parser.add_argument("--noindex", action="store_true", help="write a robots.txt that blocks all")
    parser.add_argument("--src", type=Path, default=ROOT / "src", help="source directory")
    parser.add_argument("--out", type=Path, default=ROOT / "dist" / "site", help="output directory")
    parser.add_argument(
        "--results", type=Path, default=ROOT / "results", help="validation results directory"
    )
    args = parser.parse_args(argv)
    build(
        args.src.resolve(),
        args.out.resolve(),
        args.version,
        noindex=args.noindex,
        results=args.results.resolve(),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
