"""Every reference a built page makes, found and judged in ONE place.

``check_site.py`` (links, CSS, size) and ``bundle_preview.py`` (the one-file preview) both
need to know what a page refers to and whether that is acceptable. When each found them
with its own regexes they disagreed about comments, ``rel`` tokens, escapes, quoting and
more, so this module is the only code that discovers references; the two scripts take its
answers and add nothing of their own to the discovery.

HTML is read with ``html.parser`` (:func:`parse_html`): every tag with its attributes, where
it is (head, body), the ``rel`` tokens lowercased and split, the ``<style>`` blocks and the
``style`` attributes, with line numbers. CSS is read with a small tokenizer
(:func:`scan_css`): comments are skipped where a browser skips them (not inside a string),
identifiers, at-rule names and function names are decoded before they are compared (so
``@\\69mport`` is ``@import`` and ``\\75rl(`` is ``url(``), and it finds ``url()`` in any case
and quoting, the strings of ``image-set()`` and ``-webkit-image-set()``, and every
``@import``.

The policy, decided here and applied the same way by both tools:

* ``@import`` is refused everywhere, in a stylesheet, a ``<style>`` block (head or body) and
  a ``style`` attribute. Link the stylesheet directly.
* A stylesheet is a ``<link>`` whose ``rel`` has the token ``stylesheet`` (``preload
  stylesheet`` and ``Stylesheet`` count), it belongs in ``<head>``, and its file must be
  served as ``text/css`` (judged by content type, so ``.CSS`` is fine and ``.txt`` is not).
* ``<style>`` blocks are allowed in the head and the body and are processed identically.
* A fetched file is a file: ``url()``, ``src``, ``srcset`` and the like never name a
  directory (only navigation, ``<a href>`` and form actions, may name one with an
  ``index.html``), never climb out of the site, never contain a separator inside a segment.
* No inline ``<script>``, event handler, ``javascript:`` URL, ``ping``, ``srcdoc`` or
  ``<meta http-equiv=refresh>``; no ``style`` or fetch attribute on ``<html>``, ``<head>`` or
  ``<body>``; no ``<link>`` fetch in the body; ``<use>``, ``<image>``, ``<feimage>``,
  ``<base>`` and svg ``<script>`` may only point at a ``#fragment``; a frame may not load
  a page; a presentation attribute may only use ``url(#fragment)``.

One difference is on purpose: a remote subresource is not an error for the real site (its
``_headers`` policy governs it) but the preview must contain everything, so the bundle
alone refuses it. Standard library only.
"""

from __future__ import annotations

import bisect
import mimetypes
import posixpath
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

from site_pages import page_url

UNSUPPORTED_IMPORT = "@import is not supported; link the stylesheet directly"

# --- how a URL is judged -------------------------------------------------------------------

CLIMBS = "climbs out of the built site"
SEPARATOR = "has a separator inside a path segment"
NOT_LOCAL = "is not a local URL and cannot be inlined"
MISSING = "does not resolve to a file in the build"
NOT_A_URL = "is not a valid URL"


@dataclass(frozen=True)
class Resolved:
    """A reference read against its page or stylesheet: the site URL and file, or why not."""

    url: str
    path: Path | None
    problem: str | None


def classify(url: str) -> str:
    """``inline`` (``data:`` or ``#``), ``remote`` (a scheme or host) or ``local``."""
    value = url.strip()
    if value.startswith("#") or value.lower().startswith("data:"):
        return "inline"
    if value.startswith("//") or re.match(r"[A-Za-z][A-Za-z0-9+.-]*:", value):
        return "remote"
    return "local"


# The Worker answers every path under this prefix (wrangler's run_worker_first), so a link to
# one names no file of the build and is not looked up there: <link rel="alternate"> feeds and
# the Subscribe link. Only navigation is exempt; a page can never load a file from it.
WORKER_PREFIX = "/api/"


def is_worker_path(url: str) -> bool:
    """True when a browser would send the URL to the Worker: its path, with percent-encoded
    dots decoded and ``.``/``..`` segments removed, still starts with ``/api/``.

    ``/api/../gone/`` and ``/api/%2e%2e/gone/`` both land on ``/gone/``, so they are not exempt.
    """
    try:
        path = urlsplit(url.strip()).path
    except ValueError:
        return False
    if not path.startswith(WORKER_PREFIX):
        return False
    decoded = unquote(path)
    if "\\" in decoded or "\x00" in decoded:
        return False
    normal = posixpath.normpath(decoded)
    return normal.startswith(WORKER_PREFIX) or normal + "/" == WORKER_PREFIX


def resolve_local(root: Path, base: str, ref: str, *, index: bool = False) -> Resolved:
    """The one place a URL found in a page or a stylesheet becomes a file of the build.

    ``ref`` is read against ``base``, the URL of the page or stylesheet that holds it, the
    way a browser does, except that ``..`` is never clamped at the root: a reference that
    climbs out of the site is refused, as is a path that decodes to a separator, anything
    remote and a file outside ``root`` (a symlink included). A directory is a problem
    unless ``index`` is set (navigation), when its ``index.html`` is the file.
    """
    try:
        parts = urlsplit(ref.strip())
    except ValueError:
        return Resolved("", None, NOT_A_URL)
    if parts.scheme or parts.netloc:
        return Resolved("", None, NOT_LOCAL)
    path = parts.path or urlsplit(base).path  # a bare ?query or #fragment names the page itself
    segments = [] if path.startswith("/") else urlsplit(base).path.split("/")[1:-1]
    for raw in path.split("/"):
        segment = unquote(raw)
        if any(c in segment for c in "/\\\x00"):
            return Resolved("", None, SEPARATOR)
        if segment in ("", "."):
            continue
        if segment == "..":
            if not segments:
                return Resolved("", None, CLIMBS)
            segments.pop()
            continue
        segments.append(segment)
    url = "/" + "/".join(segments) + ("/" if segments and path.endswith("/") else "")
    base_root = root.resolve()
    target = base_root.joinpath(*segments).resolve()
    if target != base_root and base_root not in target.parents:
        return Resolved(url, None, MISSING)
    if target.is_dir() and index:
        target = (target / "index.html").resolve()
        if base_root not in target.parents:
            return Resolved(url, None, MISSING)
    if not target.is_file():
        return Resolved(url, None, MISSING)
    return Resolved(url, target, None)


def parse_srcset(value: str) -> list[tuple[str, str]]:
    """(url, descriptor) per candidate. Commas inside a ``data:`` URL are not separators."""
    out: list[tuple[str, str]] = []
    i, n = 0, len(value)
    while i < n:
        while i < n and (value[i].isspace() or value[i] == ","):
            i += 1
        start = i
        while i < n and not value[i].isspace():
            i += 1
        url = value[start:i]
        if not url:
            break
        descriptor = ""
        if url.endswith(","):
            url = url.rstrip(",")
        else:
            start = i
            while i < n and value[i] != ",":
                i += 1
            descriptor = value[start:i].strip()
        out.append((url, descriptor))
    return out


# --- CSS -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class CssRef:
    """A reference in CSS text: ``start:end`` is the span to replace to swap it for another."""

    value: str
    line: int
    start: int
    end: int
    kind: str  # "url" for url()/src(), "image-set" for a bare string argument of image-set()


@dataclass
class CssScan:
    refs: list[CssRef] = field(default_factory=list)
    imports: list[tuple[int, str]] = field(default_factory=list)  # (line, source line)


_HEX = "0123456789abcdefABCDEF"
_WS = " \t\n\r\f"


def _ident_char(c: str) -> bool:
    return c.isalnum() or c in "_-\\" or ord(c) > 127


def _read_escape(text: str, i: int) -> tuple[str, int]:
    """Decode the escape whose backslash is at ``text[i]``; return (character, next index)."""
    j = i + 1
    if j >= len(text):
        return "�", j
    if text[j] in _HEX:
        k = j
        while k < len(text) and k - j < 6 and text[k] in _HEX:
            k += 1
        code = int(text[j:k], 16)
        if k < len(text) and text[k] in _WS:
            k += 2 if text[k : k + 2] == "\r\n" else 1
        char = chr(code) if 0 < code <= 0x10FFFF and not 0xD800 <= code <= 0xDFFF else "�"
        return char, k
    return text[j], j + 1


def _read_ident(text: str, i: int) -> tuple[str, int]:
    out = []
    while i < len(text) and _ident_char(text[i]):
        if text[i] == "\\":
            if i + 1 < len(text) and text[i + 1] == "\n":
                break
            char, i = _read_escape(text, i)
            out.append(char)
        else:
            out.append(text[i])
            i += 1
    return "".join(out), i


def _read_string(text: str, i: int) -> tuple[str, int]:
    """Decode the string whose opening quote is at ``text[i]``; return (value, next index)."""
    quote = text[i]
    i += 1
    out = []
    while i < len(text) and text[i] != quote:
        if text[i] == "\\":
            if text[i + 1 : i + 2] == "\n":
                i += 2
                continue
            char, i = _read_escape(text, i)
            out.append(char)
        elif text[i] == "\n":
            break  # an unterminated string ends at the newline, as in a browser
        else:
            out.append(text[i])
            i += 1
    return "".join(out), min(i + 1, len(text)) if i < len(text) and text[i] == quote else i


def _read_bare_url(text: str, i: int) -> tuple[str, int]:
    """The unquoted argument of ``url(`` starting at ``i``; return (value, index after ``)``)."""
    out = []
    while i < len(text) and text[i] != ")":
        if text[i] == "\\":
            char, i = _read_escape(text, i)
            out.append(char)
        else:
            out.append(text[i])
            i += 1
    return "".join(out).strip(_WS), min(i + 1, len(text))


def scan_css(text: str) -> CssScan:
    """Every reference and ``@import`` in ``text``, however it is spelled."""
    scan = CssScan()
    newlines = [m.start() for m in re.finditer("\n", text)]

    def line_of(pos: int) -> int:
        return bisect.bisect_left(newlines, pos) + 1

    lines = text.splitlines()
    stack: list[str] = []
    importing = False  # inside an @import prelude: its URL is refused with the rule itself
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if importing and c in ";{":
            importing = False
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
        elif c in "\"'":
            start = i
            value, i = _read_string(text, i)
            if stack and stack[-1].endswith("image-set") and not importing:
                scan.refs.append(CssRef(value, line_of(start), start, i, "image-set"))
        elif c == "@" and i + 1 < n and (_ident_char(text[i + 1]) or text[i + 1] == "\\"):
            start = i
            name, i = _read_ident(text, i + 1)
            if name.lower() == "import":
                importing = True
                row = line_of(start)
                scan.imports.append((row, lines[row - 1].strip()[:80] if row <= len(lines) else ""))
        elif _ident_char(c) and not c.isdigit():
            start = i
            name, i = _read_ident(text, i)
            if i < n and text[i] == "(":
                lower = name.lower()
                i += 1
                if lower in ("url", "src"):
                    j = i
                    while j < n and text[j] in _WS:
                        j += 1
                    if j < n and text[j] in "\"'":
                        value, j = _read_string(text, j)
                        while j < n and text[j] in _WS:
                            j += 1
                        if j < n and text[j] == ")":
                            j += 1
                        if not importing:
                            scan.refs.append(CssRef(value, line_of(start), start, j, "url"))
                        i = j
                    elif lower == "url":
                        value, j = _read_bare_url(text, j)
                        if not importing:
                            scan.refs.append(CssRef(value, line_of(start), start, j, "url"))
                        i = j
                    else:
                        stack.append(lower)
                else:
                    stack.append(lower)
        elif c == "(":
            stack.append("")
            i += 1
        elif c == ")":
            if stack:
                stack.pop()
            i += 1
        else:
            i += 1
    return scan


def css_attribute_values(text: str, attribute: str) -> list[str]:
    """The values compared with ``[attribute=value]`` selectors in ``text``, in order.

    Comments and strings are skipped, escapes are decoded, and the value may be quoted with
    ``"`` or ``'`` or be a bare identifier, as CSS allows all three.
    """
    found: list[str] = []
    wanted = attribute.lower()
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
        elif c in "\"'":
            _, i = _read_string(text, i)
        elif c == "[":
            i += 1
            while i < n and text[i] in _WS:
                i += 1
            name, i = _read_ident(text, i)
            while i < n and text[i] in _WS:
                i += 1
            if name.lower() != wanted or i >= n or text[i] != "=":
                continue
            i += 1
            while i < n and text[i] in _WS:
                i += 1
            if i < n and text[i] in "\"'":
                value, i = _read_string(text, i)
            else:
                value, i = _read_ident(text, i)
            found.append(value)
        else:
            i += 1
    return found


def css_urls(text: str) -> list[str]:
    """Every referenced URL in ``text``, in order, as written (comments ignored)."""
    return [ref.value for ref in scan_css(text).refs]


def css_imports(text: str) -> list[tuple[int, str]]:
    """``(line, source line)`` for each ``@import`` in ``text``; comments are ignored."""
    return scan_css(text).imports


def import_problems(name: str, text: str) -> list[str]:
    """One message per ``@import``, naming the file and line."""
    return [f"{name}:{line}: {UNSUPPORTED_IMPORT} ({source})" for line, source in css_imports(text)]


def replace_css_refs(text: str, swap) -> str:
    """``text`` with each reference replaced by ``swap(ref)`` (``None`` keeps it as it is).

    ``swap`` returns the replacement *URL*; a ``url()`` is rewritten as ``url("…")`` and an
    ``image-set()`` string as ``"…"``.
    """
    out: list[str] = []
    last = 0
    for ref in scan_css(text).refs:
        new = swap(ref)
        if new is None:
            continue
        quoted = new.replace("\\", "\\\\").replace('"', '\\"')
        out.append(text[last : ref.start])
        out.append(f'url("{quoted}")' if ref.kind == "url" else f'"{quoted}"')
        last = ref.end
    out.append(text[last:])
    return "".join(out)


# --- HTML ------------------------------------------------------------------------------------

# Attributes that make the browser fetch something, on any element.
FETCH_ATTRS = ("src", "srcset", "imagesrcset", "poster", "data", "background", "manifest")
# ``href`` only fetches on these (on ``a`` and ``area`` it navigates, which is fine).
FETCH_HREF_TAGS = {"link", "use", "image", "feimage", "base", "script"}
NAVIGATION_HREF_TAGS = {"a", "area"}
NAVIGATION_ATTRS = ("action", "formaction")
SRCSET_ATTRS = ("srcset", "imagesrcset")
FRAME_TAGS = {"iframe", "embed", "object", "frame"}
FRAGMENT_ONLY_TAGS = {"use", "image", "feimage", "base", "script"}
SCRIPT_URL_ATTRS = ("href", "src", "action", "formaction", "data", "poster", "background")
FORBIDDEN_ATTRS = ("ping", "srcdoc")
ICON_RELS = ("icon", "apple-touch-icon")
# ``<link rel>`` is a token list, and the tokens decide whether the link loads a file for THIS
# page. These load one: a stylesheet, an icon, a preload and a module preload (both fetched
# now, from ``href``) and the manifest. Everything else is metadata (canonical, alternate,
# author, license, me, next, prev, help, search, ...) that a visitor or a crawler may follow,
# or a hint for ANOTHER page or connection (prefetch, prerender, preconnect, dns-prefetch);
# none of those weighs on this page, so they navigate.
FETCHING_LINK_RELS = frozenset(
    {
        "stylesheet",
        "icon",
        "apple-touch-icon",
        "apple-touch-icon-precomposed",
        "mask-icon",
        "preload",
        "modulepreload",
        "manifest",
    }
)
# Of those, the page budget counts what the page renders from: not an icon, which the browser
# chrome shows and the image budget already bounds.
WEIGHED_LINK_RELS = frozenset({"stylesheet", "preload", "modulepreload", "manifest"})
BARE_TAGS = {"html", "head", "body"}
VOID_AFTER_HEAD = {"link", "script", "style", "meta", "title", "base", "noscript", "template"}


def first_attr(attrs, name: str) -> str | None:
    """The value of the first ``name`` attribute (the browser ignores a repeat), or None
    when it is absent; a valueless attribute reads as ``""``."""
    for key, value in attrs:
        if key == name:
            return value or ""
    return None


def form_method(attrs, attribute: str = "method") -> str:
    """``get``, ``post`` or ``dialog``: the keyword a ``<form>`` (or a submit button's
    ``formmethod``) names, ASCII case-insensitively; anything else is ``get``, as in HTML."""
    value = (first_attr(attrs, attribute) or "").lower()
    return value if value in ("post", "dialog") else "get"


def is_script_url(url: str) -> bool:
    """``javascript:`` as a browser reads it: tabs, newlines and controls inside the scheme
    are dropped and the case is ignored."""
    return re.sub(r"[\x00-\x20]+", "", url).lower().startswith("javascript:")


@dataclass(frozen=True)
class Ref:
    """One URL an element holds (a ``srcset`` yields one per candidate)."""

    tag: str
    attr: str
    value: str
    line: int
    rel: tuple[str, ...]
    in_head: bool
    in_body: bool
    offset: int = 0  # where the element's start tag begins, to order refs against <style> blocks

    @property
    def bare_attr(self) -> str:
        return self.attr.rsplit(":", 1)[-1]

    @property
    def stylesheet(self) -> bool:
        return self.tag == "link" and self.bare_attr == "href" and "stylesheet" in self.rel

    @property
    def icon(self) -> bool:
        return (
            self.tag == "link"
            and self.bare_attr == "href"
            and any(t in self.rel for t in ICON_RELS)
        )

    @property
    def link_fetches(self) -> bool:
        """A ``<link href>`` whose ``rel`` has a token that loads a file for this page."""
        return (
            self.tag == "link"
            and self.bare_attr == "href"
            and not FETCHING_LINK_RELS.isdisjoint(self.rel)
        )

    @property
    def navigates(self) -> bool:
        """A link a visitor follows (or a form posts to), not a file the page loads."""
        if self.attr in NAVIGATION_ATTRS:
            return True
        return self.bare_attr == "href" and (
            self.tag in NAVIGATION_HREF_TAGS
            or (self.tag == "link" and not self.link_fetches)
            or self.tag not in FETCH_HREF_TAGS
        )

    @property
    def guarded(self) -> bool:
        """Any attribute that can make a request, ``<link>`` of any ``rel`` included: what the
        preview's guard must see as a data URI or a fragment."""
        return self.attr in FETCH_ATTRS or (
            self.bare_attr == "href" and self.tag in FETCH_HREF_TAGS
        )

    @property
    def fetches(self) -> bool:
        """The browser loads this file when it renders the page."""
        return self.guarded and not self.navigates

    @property
    def weighs(self) -> bool:
        """It counts toward the page's weight: loaded content and the ``<link>`` relations in
        ``WEIGHED_LINK_RELS``, never an icon or a ``<link>`` that only carries metadata."""
        if self.tag == "link":
            return self.fetches and not WEIGHED_LINK_RELS.isdisjoint(self.rel)
        return self.fetches


@dataclass(frozen=True)
class Style:
    """A ``<style>`` block (``start:end`` is its content) or a ``style`` attribute."""

    text: str
    line: int
    in_head: bool
    block: bool
    start: int = 0
    end: int = 0


@dataclass(frozen=True)
class Element:
    tag: str
    attrs: tuple[tuple[str, str | None], ...]
    line: int
    start: int  # offset of the start tag in the text
    end: int  # offset just after it
    in_head: bool
    in_body: bool
    self_closing: bool = False  # written <x/>: it ends the element in SVG and MathML


@dataclass
class Document:
    text: str
    elements: list[Element] = field(default_factory=list)
    refs: list[Ref] = field(default_factory=list)
    styles: list[Style] = field(default_factory=list)
    ids: set[str] = field(default_factory=set)
    inline_scripts: list[int] = field(default_factory=list)  # lines of <script> with no src
    script_spans: list[tuple[int, int]] = field(default_factory=list)  # each <script>…</script>
    body_span: tuple[int, int] | None = None  # text between <body …> and </body>

    @property
    def has_body(self) -> bool:
        return self.body_span is not None


class _Parser(HTMLParser):
    def __init__(self, text: str) -> None:
        super().__init__(convert_charrefs=True)
        self.doc = Document(text)
        self.text = text
        starts = [0] + [m.end() for m in re.finditer("\n", text)]
        self._starts = starts
        self._head = False
        self._body = False
        self._style: tuple[int, int, bool] | None = None
        self._script_start = 0
        self._body_start = 0
        self._self_closing = False

    def _offset(self) -> int:
        line, col = self.getpos()
        return self._starts[line - 1] + col

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        raw = self.get_starttag_text() or ""
        start = self._offset()
        end = start + len(raw)
        line = self.getpos()[0]
        if tag == "head":
            self._head = True
        elif tag == "body":
            self._head = False
            self._body = True
            self._body_start = end
            self.doc.body_span = (end, len(self.text))
        values = {name: value for name, value in attrs if value is not None}
        rel = tuple(values.get("rel", "").lower().split())
        self.doc.elements.append(
            Element(tag, tuple(attrs), line, start, end, self._head, self._body, self._self_closing)
        )
        if "id" in values:
            self.doc.ids.add(values["id"])
        if tag == "a" and "name" in values:
            self.doc.ids.add(values["name"])
        for name, value in attrs:
            if value is None:
                continue
            if name == "style" and value:
                self.doc.styles.append(Style(value, line, self._head, False))
            bare = name.rsplit(":", 1)[-1]
            urls: list[str] = []
            if name in SRCSET_ATTRS:
                urls = [url for url, _ in parse_srcset(value)]
            elif name in FETCH_ATTRS or name in NAVIGATION_ATTRS or bare == "href":
                urls = [value]
            urls = [u for u in urls if u.strip()]
            for url in urls:
                self.doc.refs.append(Ref(tag, name, url, line, rel, self._head, self._body, start))
        if tag == "style":
            self._style = (end, line, self._head)
        if tag == "script":
            self._script_start = start
            if "src" not in values:
                self.doc.inline_scripts.append(line)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._self_closing = True
        try:
            super().handle_startendtag(tag, attrs)
        finally:
            self._self_closing = False

    def handle_endtag(self, tag: str) -> None:
        if tag == "style" and self._style is not None:
            begin, line, in_head = self._style
            stop = self._offset()
            self.doc.styles.append(Style(self.text[begin:stop], line, in_head, True, begin, stop))
            self._style = None
        elif tag == "head":
            self._head = False
        elif tag == "body" and self.doc.body_span is not None:
            self.doc.body_span = (self._body_start, self._offset())
            self._body = False
        if tag == "script":
            close = self.text.find(">", self._offset())
            self.doc.script_spans.append(
                (self._script_start, close + 1 if close >= 0 else len(self.text))
            )


def parse_html(text: str) -> Document:
    """Everything a page refers to, read the way a browser tokenizes it."""
    parser = _Parser(text)
    parser.feed(text)
    parser.close()
    return parser.doc


def forbidden_constructs(doc: Document) -> list[tuple[str, str, str]]:
    """``(tag, attribute, value)`` for what the preview's policy cannot cover and the real
    site has no use for: event handlers, ``ping``, ``srcdoc``, ``<meta http-equiv=refresh>``
    and ``javascript:`` URLs."""
    found: list[tuple[str, str, str]] = []
    for el in doc.elements:
        values = dict(el.attrs)
        for name, value in el.attrs:
            if name.startswith("on"):
                found.append((el.tag, name, value or ""))
                continue
            if not value:
                continue
            if name in FORBIDDEN_ATTRS or (
                name.rsplit(":", 1)[-1] in SCRIPT_URL_ATTRS and is_script_url(value)
            ):
                found.append((el.tag, name, value))
        if el.tag == "meta" and "refresh" in (values.get("http-equiv") or "").lower():
            found.append((el.tag, "http-equiv", "refresh"))
    return found


def css_texts(doc: Document) -> list[tuple[str, Style]]:
    """The CSS a page holds, with a label for messages: its blocks and ``style`` attributes."""
    return [("<style>" if s.block else "style attribute", s) for s in doc.styles]


# --- the whole page --------------------------------------------------------------------------


@dataclass(frozen=True)
class Problem:
    category: str  # "link" (navigation), "asset", "css" or "policy"
    text: str


@dataclass
class PageInfo:
    doc: Document
    url: str
    name: str  # the page's path relative to the root
    problems: list[Problem] = field(default_factory=list)
    weighed: list[Path] = field(default_factory=list)  # distinct files the page loads
    targets: list[tuple[Ref, Path]] = field(default_factory=list)  # local refs that resolved
    sheets: list[tuple[str, Path]] = field(default_factory=list)  # (site URL, file), head order
    sheet_offsets: list[int] = field(default_factory=list)  # where each of ``sheets`` is linked
    head_styles: list[Style] = field(default_factory=list)

    def add_weight(self, path: Path | None) -> None:
        if path is not None and path not in self.weighed:
            self.weighed.append(path)


def inspect_page(root: Path, page: Path) -> PageInfo:
    """Read ``page`` and judge everything it refers to: the single source of truth for both
    the size check and the preview bundle."""
    root = root.resolve()
    url = page_url(root, page)
    doc = parse_html(page.read_text(encoding="utf-8"))
    info = PageInfo(doc, url, page.relative_to(root).as_posix(), head_styles=[])
    info.head_styles = [s for s in doc.styles if s.block and s.in_head]
    where = info.name

    def problem(category: str, text: str) -> None:
        item = Problem(category, text)
        if item not in info.problems:
            info.problems.append(item)

    for tag, attr, value in forbidden_constructs(doc):
        problem("policy", f"{where}: <{tag} {attr}={value[:60]}> is not allowed")
    for line in doc.inline_scripts:
        problem("policy", f"{where}:{line}: an inline <script> is not allowed; use <script src>")
    for el in doc.elements:
        names = {n for n, _ in el.attrs}
        if el.tag in BARE_TAGS and (
            "style" in names or names & set(FETCH_ATTRS) or "manifest" in names
        ):
            problem(
                "policy", f"{where}:{el.line}: <{el.tag}> cannot carry style or fetch attributes"
            )
        if el.tag == "link" and el.in_body and "href" in names:
            problem("policy", f"{where}:{el.line}: a <link> belongs in <head>")
        # The Worker serves static assets and has no handler, so nothing could receive a
        # POST; the production policy (form-action 'self') leaves a local one nowhere to go.
        posts = el.tag == "form" and form_method(el.attrs) == "post"
        if posts or (
            el.tag in ("button", "input") and form_method(el.attrs, "formmethod") == "post"
        ):
            problem(
                "policy",
                f"{where}:{el.line}: <{el.tag}> would POST, and a static site has no handler "
                "for a POST; use method=get (or dialog)",
            )

    for ref in doc.refs:
        value = ref.value.strip()
        kind = classify(value)
        label = f"{where}:{ref.line}: <{ref.tag}> {value}"
        if ref.fetches:
            if ref.tag in FRAGMENT_ONLY_TAGS and kind != "inline" and ref.tag != "script":
                problem("policy", f"{label} can only point at a #fragment")
                continue
            if ref.tag == "script" and ref.attr != "src" and kind != "inline":
                problem("policy", f"{label} can only point at a #fragment")
                continue
            if ref.attr == "manifest" and kind != "inline":
                problem("policy", f"{label} cannot be inlined")
                continue
            if doc.has_body and not ref.in_head and not ref.in_body:
                problem("policy", f"{label} is outside <head> and <body>")
                continue
            if ref.in_head and ref.tag not in VOID_AFTER_HEAD and ref.tag not in BARE_TAGS:
                problem("policy", f"{label} is not allowed in <head>")
                continue
        if value.startswith("#") and ref.navigates:
            info.targets.append((ref, page.resolve()))  # a fragment on this very page
        if kind != "local" or (ref.navigates and is_worker_path(value)):
            continue
        result = resolve_local(root, url, value, index=ref.navigates)
        category = "link" if ref.navigates else "asset"
        if result.problem or result.path is None:
            problem(category, f"{label} {result.problem}")
            continue
        info.targets.append((ref, result.path))
        if ref.tag in FRAME_TAGS and (mimetypes.guess_type(result.path.name)[0] == "text/html"):
            problem("policy", f"{label} loads a page into a frame")
        if ref.weighs:
            info.add_weight(result.path)
        if ref.stylesheet:
            if doc.has_body and not ref.in_head:
                problem("policy", f"{label} is a stylesheet outside <head>")
            kind_type = mimetypes.guess_type(result.path.name)[0]
            if kind_type != "text/css":
                problem("policy", f"{label} is not served as text/css")
                continue
            if ref.in_head or not doc.has_body:
                info.sheets.append((result.url, result.path))
                info.sheet_offsets.append(ref.offset)
            _judge_css(
                root,
                result.url,
                result.path.relative_to(root).as_posix(),
                result.path.read_text(encoding="utf-8", errors="replace"),
                info,
                problem,
            )
    for label, style in css_texts(doc):
        _judge_css(root, url, f"{where}: {label}", style.text, info, problem)
    # A presentation attribute (fill, filter, mask, clip-path, marker-*) may use url(#id) only.
    for el in doc.elements:
        for name, value in el.attrs:
            if value and name != "style" and "url(" in value.lower():
                for ref in scan_css(value).refs:
                    if classify(ref.value) != "inline":
                        problem(
                            "policy",
                            f"{where}:{el.line}: <{el.tag} {name}> url({ref.value}) can only "
                            "point at a #fragment",
                        )
    return info


def _judge_css(root, base, name, text, info: PageInfo, problem) -> None:
    scan = scan_css(text)
    for line, source in scan.imports:
        problem("css", f"{name}:{line}: {UNSUPPORTED_IMPORT} ({source})")
    for ref in scan.refs:
        value = ref.value.strip()
        if not value or classify(value) != "local":
            continue
        result = resolve_local(root, base, value)
        if result.problem:
            problem("css", f"{name}:{ref.line}: url({value}) {result.problem}")
        else:
            info.add_weight(result.path)
