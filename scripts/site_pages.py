"""Which pages a built (or source) site has, and the URL each is served at.

Shared by the build (sitemap), the checks, the screenshots and the preview bundle, so
they cannot disagree about what the site is. Standard library only.
"""

from __future__ import annotations

import re
from pathlib import Path

NOT_FOUND = "404.html"
# Every segment of a page's path (each directory and the file name). URLs are emitted as
# written, so a space, #, ?, % or non-ASCII character would give an invalid sitemap URL
# and a route nobody can address; this is the whole alphabet a page path may use.
SEGMENT_RE = re.compile(r"[a-z0-9][a-z0-9._-]*")


def is_not_found(root: Path, page: Path) -> bool:
    """True for the site's not-found page, ``404.html`` at the root and nowhere else: a page
    such as ``docs/404.html`` is an ordinary page the Worker serves at its own URL."""
    return page.relative_to(root).as_posix() == NOT_FOUND


def page_files(root: Path) -> list[Path]:
    """Every HTML file under ``root``: the front page, the others sorted, the 404 page last."""

    def order(path: Path) -> tuple[bool, bool, str]:
        relative = path.relative_to(root).as_posix()
        return (relative != "index.html", is_not_found(root, path), relative)

    return sorted((path for path in root.rglob("*.html") if path.is_file()), key=order)


def invalid_page_paths(root: Path) -> list[str]:
    """Page paths under ``root`` with a segment outside ``[a-z0-9][a-z0-9._-]*``."""
    return [
        relative
        for relative in (path.relative_to(root).as_posix() for path in page_files(root))
        if any(SEGMENT_RE.fullmatch(segment) is None for segment in relative.split("/"))
    ]


def page_url(root: Path, page: Path) -> str:
    """The path a visitor uses: ``index.html`` is ``/``, ``about/index.html`` is ``/about/``."""
    relative = page.relative_to(root).as_posix()
    if relative == "index.html":
        return "/"
    if relative.endswith("/index.html"):
        return "/" + relative[: -len("index.html")]
    return "/" + relative


def _escape(segment: str) -> str:
    """Letters and digits stay; every other character, ``-``, ``.`` and ``_`` included, is
    ``_`` and two uppercase hex digits per UTF-8 byte, so ``-`` and ``.`` stay free to mean
    something and the result decodes back to exactly one input."""
    return "".join(
        c if c.isascii() and c.isalnum() else "".join(f"_{b:02X}" for b in c.encode())
        for c in segment
    )


def page_slug(root: Path, page: Path) -> str:
    """A file-name-safe name for a page, different for every page of a site.

    ``index``, ``about``, ``blog-post`` for ``blog/post/index.html`` and ``404.html`` for the
    not-found page. ``/`` between directories is ``-`` and a literal ``-`` in a name is
    ``_2D``, so ``/blog/post/`` and ``/blog-post/`` differ; a page that is a file keeps
    ``.html``, which no directory name can contain (its ``.`` is ``_2E``), so ``/404/`` and
    ``/404.html`` differ.
    """
    relative = page.relative_to(root).as_posix()
    if relative == "index.html":
        return "index"
    if relative.endswith("/index.html"):
        slug = "-".join(_escape(s) for s in relative[: -len("/index.html")].split("/"))
        # The front page owns the plain name ``index``; a directory called that gets its
        # first letter escaped.
        return "_69ndex" if slug == "index" else slug
    return "-".join(_escape(s) for s in relative[: -len(".html")].split("/")) + ".html"


def indexable_urls(root: Path) -> list[str]:
    """The URLs that belong in a sitemap: every page except the not-found page."""
    return [page_url(root, page) for page in page_files(root) if not is_not_found(root, page)]
