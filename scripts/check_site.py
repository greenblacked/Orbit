#!/usr/bin/env python3
"""Check a built site: every local link resolves, and every page stays inside a size budget.

    python scripts/check_site.py dist/site
    python scripts/check_site.py dist/site --page-budget 300000 --image-budget 100000

Links: every ``href``, ``src``, ``srcset`` and form ``action`` that points at this site
(a path, or a relative path) must name a file in the build, or a directory with an
``index.html``; a ``#fragment`` must name an ``id`` on the page it points at. External
links, ``mailto:`` and ``tel:`` are not fetched, so the check is offline and cannot flake.

Budget (uncompressed bytes, defaults below, both can be raised with a flag when a page
earns it): a page weighs its HTML plus every distinct local stylesheet, script and image it
loads plus every local file a loaded stylesheet (or the page's own ``<style>`` and ``style``
attributes) pulls in through ``url()``, each file once, and must stay under
``--page-budget``; every image file in the build must stay under ``--image-budget``. A budget
is a tripwire for the commit that adds a 3 MB photograph, not a tuning target. Icons
(``<link rel="icon">``) are small by nature and are not counted toward a page.

A form that would POST (``method=post``, or ``formmethod=post`` on a button) is refused: the
Worker serves static files and has no handler to receive it.

``@import`` is refused in every stylesheet, ``<style>`` block and ``style`` attribute (link
stylesheets directly), as is a ``url()`` that climbs out of the site or names no file (a
directory is not a file). What counts as a reference, a stylesheet or an ``@import``, and
what is refused, is decided by ``scripts/site_refs.py``, the same module the preview bundle
uses, so the two cannot disagree about a page.

Standard library only.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

from site_pages import page_files
from site_refs import PageInfo, inspect_page

PAGE_BUDGET = 500_000
IMAGE_BUDGET = 200_000
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico"}


def inspect_all(root: Path) -> dict[Path, PageInfo]:
    """Every page of the build, read and judged once by ``site_refs``."""
    root = root.resolve()
    return {page: inspect_page(root, page) for page in page_files(root)}


def _unique(problems: list[str]) -> list[str]:
    return list(dict.fromkeys(problems))


def check_links(root: Path) -> list[str]:
    """Links and loaded files that name nothing, climb out of the site, or point at a
    ``#fragment`` the target page lacks."""
    root = root.resolve()
    pages = inspect_all(root)
    by_file = pages
    problems: list[str] = []
    for info in pages.values():
        problems += [p.text for p in info.problems if p.category in ("link", "asset")]
        for ref, target in info.targets:
            fragment = unquote(urlsplit(ref.value.strip()).fragment)
            if ref.navigates and fragment and fragment != "top" and target.suffix == ".html":
                known = by_file.get(target)
                ids = known.doc.ids if known else inspect_page(root, target).doc.ids
                if fragment not in ids:
                    problems.append(
                        f"{info.name}:{ref.line}: <{ref.tag}> {ref.value.strip()} points at "
                        f"#{fragment}, which the target page lacks"
                    )
    return _unique(problems)


def check_css(root: Path) -> list[str]:
    """``@import`` anywhere, and ``url()`` references that climb out of the site or miss."""
    return _unique(
        p.text for info in inspect_all(root).values() for p in info.problems if p.category == "css"
    )


def check_policy(root: Path) -> list[str]:
    """What the preview cannot carry and the site has no use for (see ``site_refs``)."""
    return _unique(
        p.text
        for info in inspect_all(root).values()
        for p in info.problems
        if p.category == "policy"
    )


def page_weight(root: Path, info: PageInfo) -> int:
    """The page's HTML plus each distinct file it loads, once."""
    page = root.resolve() / info.name
    return page.stat().st_size + sum(path.stat().st_size for path in info.weighed if path != page)


def check_budget(root: Path, page_budget: int, image_budget: int) -> list[str]:
    root = root.resolve()
    problems: list[str] = []
    for image in sorted(path for path in root.rglob("*") if path.suffix.lower() in IMAGE_SUFFIXES):
        size = image.stat().st_size
        if size > image_budget:
            problems.append(
                f"{image.relative_to(root).as_posix()} is {size} bytes, over the image budget of "
                f"{image_budget}"
            )
    for info in inspect_all(root).values():
        weight = page_weight(root, info)
        if weight > page_budget:
            problems.append(
                f"{info.name} weighs {weight} bytes with what it loads, "
                f"over the page budget of {page_budget}"
            )
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="check_site", description=__doc__.split("\n", 1)[0])
    parser.add_argument("root", type=Path, nargs="?", default=Path("dist/site"), help="built site")
    parser.add_argument("--page-budget", type=int, default=PAGE_BUDGET, help="bytes per page")
    parser.add_argument("--image-budget", type=int, default=IMAGE_BUDGET, help="bytes per image")
    args = parser.parse_args(argv)
    args.root = args.root.resolve()
    if not args.root.is_dir():
        print(f"no built site at {args.root}; run scripts/build_site.py first", file=sys.stderr)
        return 2
    problems = (
        check_links(args.root)
        + check_css(args.root)
        + check_policy(args.root)
        + check_budget(args.root, args.page_budget, args.image_budget)
    )
    for problem in problems:
        print(f"::error::{problem}" if _in_actions() else f"error: {problem}", file=sys.stderr)
    if problems:
        print(f"check_site: {len(problems)} problem(s)", file=sys.stderr)
        return 1
    pages = len(page_files(args.root))
    print(f"check_site: {pages} page(s), links resolve, within budget")
    return 0


def _in_actions() -> bool:
    return os.environ.get("GITHUB_ACTIONS") == "true"


if __name__ == "__main__":
    sys.exit(main())
