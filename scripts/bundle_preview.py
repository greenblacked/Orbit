#!/usr/bin/env python3
"""Bundle the built site into ONE self-contained HTML file, for sharing as a preview.

    python scripts/bundle_preview.py                       # dist/site -> dist/preview/index.html
    python scripts/bundle_preview.py --commit abc1234

Every page of the build becomes a ``<template>`` inside the file, with the scripts
inlined, images and icons as ``data:`` URIs, and links between pages rewritten
to hash routes (``#/about/``). Each distinct stylesheet text is stored once in a
``<template data-sheet="N">``; a route lists its sheet ids in order in ``data-sheets`` and
the router puts them into ``#app`` ahead of the page content. So the whole site can be
clicked through from one file opened from disk, a chat attachment or a private artifact
page. A strip at the top says it
is a preview and of which version and commit. Nothing is fetched: the web fonts are
dropped, so the system fallback fonts are what shows.

The boundary is a Content-Security-Policy ``<meta>`` that is the first element after the
charset in the bundle's head. It allows the file's own inline code, each script and style
by the SHA-256 of its exact text (no ``'unsafe-inline'``), and ``data:`` URIs and nothing
else, so a construct no scanner thought of (a CSS escape, an unusual attribute, an SVG
reference) still cannot make a request. A ``<meta>`` policy does not cover
navigation, so a refresh, ``<a ping>`` and ``srcdoc`` are refused outright; so are an
inline event handler (any ``on*`` attribute) and a ``javascript:`` URL, which the hashes
would also stop in a browser. The guard
below is an early warning that names the offending construct; the policy is what holds.
It is for the preview only: the real site keeps its own ``_headers`` policy.

Every URL-bearing attribute (``src``,
``srcset``, ``poster``, ``data``, ``background``, ``link href`` and so on) and every CSS
``url()`` is inlined as a data URI, and the build fails on any that is still not a ``data:``
URI or a ``#`` reference, local or remote: a frame onto a built page, a stylesheet in the
body, a missing file. Plain ``<a href>`` links to other sites
stay; they only navigate.

A link a script builds at run time (``/compare/?family=iOS&from=17``, ``/timeline/?id=x``) is
not in the static HTML, so the router mends it when it is clicked: an absolute same-site path
that names a page of the bundle (``/about``, ``/about/index.html`` included) is pointed at
that page's hash route, the query dropped and a ``#fragment`` kept, also for a modifier or
middle click. An external URL and a path that is no page are left alone.

Forms: the policy's ``form-action 'none'`` blocks every submit, so a GET form whose action
is a page of the build (or has none, meaning its own page) gets that page's hash route as its
action and the router navigates there on submit; the query the form would add is dropped, as
for a link. ``method=dialog`` is untouched. A POST form, an action that is not a page, and a
local ``formaction`` fail the build, naming the page: a static site has no handler for them.
An action on another site fails it too, as production's ``form-action 'self'`` blocks it as well.

The page scripts (``site.js``, and ``theme.js`` in the head) are written for one page per
load, so the router runs the scripts a route names each time it is shown, and removes the
listeners they added to ``window`` and ``document`` first. A route runs its own page's
head scripts only, before its content is inserted (production's parser stops for a head
script before it reaches ``<body>``), then its body scripts after. Once a later route's
content and body scripts have run, the router dispatches ``DOMContentLoaded`` on
``document`` (the first show gets the browser's own), so an init-on-``DOMContentLoaded``
handler runs once per show. Not reproduced: a head script's ``defer``, ``async`` and
``type="module"`` timing, which also runs before the content here (the site has none), and
``document.readyState``, which reads ``"complete"`` on every show after the first, where
production reads ``"loading"`` while a head script runs, and the raw text of a tagged
template (``String.raw``), which sees the ``<\\/`` escape that closing tags get in an inline
script. A script that is not written for
one page per load needs a look here.

The pages fetch their data (``/data/*.json``), which a bundle cannot do, so every JSON file
under ``data/`` is embedded as ``<script type="application/json" data-seed="/data/NAME">``
(a data block the browser never runs) and a page that finds its seed reads that instead.

Standard library only. The file must stay under 5 MB.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import html
import mimetypes
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

import site_refs
from site_pages import page_files, page_url
from site_refs import (
    FETCH_ATTRS,
    FRAME_TAGS,
    ICON_RELS,
    NAVIGATION_ATTRS,
    classify,
    first_attr,
    forbidden_constructs,
    form_method,
    import_problems,
    inspect_page,
    is_worker_path,
    parse_html,
    parse_srcset,
    replace_css_refs,
    resolve_local,
    scan_css,
)

ROOT = Path(__file__).resolve().parent.parent
# The bundle opens on any host or as file://, where a root-relative /api/ link would resolve
# to the wrong place; the Worker that answers it lives on the production origin.
PRODUCTION_ORIGIN = "https://orbit.szolotov.com"
MAX_BYTES = 5_000_000
# The preview's only boundary against a request: nothing but the file itself. Scripts and
# styles are allowed by hash (see ``preview_csp``), never by ``'unsafe-inline'``, so an
# inline event handler or a ``javascript:`` URL in a page cannot run.
CSP_FIXED = (
    "default-src 'none'; img-src data:; media-src data:; font-src data:; "
    "connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; "
    "worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'"
)


def sha256_source(text: str) -> str:
    """A CSP hash source for ``text``, exactly as the browser reads the element's content."""
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return "'sha256-" + base64.b64encode(digest).decode("ascii") + "'"


def preview_csp(scripts: list[str], styles: list[str], style_attrs: list[str]) -> str:
    """The policy for a bundle whose inline scripts, styles and style attributes are these."""
    script_src = " ".join(sha256_source(t) for t in scripts) or "'none'"
    style_src = " ".join(sha256_source(t) for t in styles) or "'none'"
    if style_attrs:
        style_src += " 'unsafe-hashes' " + " ".join(sha256_source(t) for t in style_attrs)
    return f"{CSP_FIXED}; script-src {script_src}; style-src {style_src}"


HOME_SCRIPT = "/assets/home.js"
BELOW_SCRIPT = "/assets/below.js"
LOOKUP_SCRIPT = "/assets/lookup.js"
COMPARE_SCRIPT = "/assets/compare.js"
TIMELINE_SCRIPT = "/assets/timeline.js"
LANES_SCRIPT = "/assets/lanes.js"
# The live site loads the generic sigil rule on demand; a bundle cannot fetch it, so it runs
# right after sigil.js on every page that loads sigil.js, before any script that draws.
SIGIL_SCRIPT = "/assets/sigil.js"
SIGIL_GENERIC_SCRIPT = "/assets/sigil-generic.js"
HOME_CHECK = 'window.location.pathname === "/"'
HOME_CHECK_BUNDLE = '(window.location.hash.slice(1).split("#")[0] || "/") === "/"'

ROUTER = r"""
(function () {
  var app = document.getElementById("app");
  var scripts = {};
  document.querySelectorAll("script[data-page-script]").forEach(function (s) {
    scripts[s.getAttribute("data-page-script")] = s.textContent;
  });
  var undo = [];
  function run(source) {
    var added = [];
    var timers = [];
    var win = window.addEventListener, doc = document.addEventListener, tick = window.setInterval;
    window.addEventListener = function (type, fn, opts) {
      added.push([window, type, fn, opts]);
      return win.call(window, type, fn, opts);
    };
    document.addEventListener = function (type, fn, opts) {
      added.push([document, type, fn, opts]);
      return doc.call(document, type, fn, opts);
    };
    window.setInterval = function () {
      var id = tick.apply(window, arguments);
      timers.push(id);
      return id;
    };
    try {
      var el = document.createElement("script");
      el.textContent = source;
      document.body.appendChild(el);
      el.remove();
    } finally {
      window.addEventListener = win;
      document.addEventListener = doc;
      window.setInterval = tick;
    }
    undo.push(function () {
      added.forEach(function (a) { a[0].removeEventListener(a[1], a[2], a[3]); });
      timers.forEach(function (id) { window.clearInterval(id); });
    });
  }
  function runAll(names) {
    (names || "").split(" ").forEach(function (name) {
      if (!name) return;
      if (Object.prototype.hasOwnProperty.call(scripts, name)) run(scripts[name]);
      else console.error("preview: page script " + name + " is not in the bundle");
    });
  }
  function route() {
    var hash = window.location.hash.slice(1);
    if (hash.charAt(0) !== "/") return { path: "/", frag: "" };
    var cut = hash.indexOf("#", 1);
    if (cut < 0) return { path: hash, frag: "" };
    return { path: hash.slice(0, cut), frag: decodeURIComponent(hash.slice(cut + 1)) };
  }
  function jump(id) {
    var el = id ? document.getElementById(id) : null;
    if (el) el.scrollIntoView();
    else window.scrollTo(0, 0);
  }
  function show() {
    var r = route();
    var tpl = document.querySelector('template[data-route="' + r.path + '"]');
    var missing = !tpl;
    if (missing) tpl = document.querySelector('template[data-route="/404.html"]');
    while (undo.length) undo.pop()();
    app.textContent = "";
    if (!tpl) {
      app.textContent = "No page at " + r.path;
      return;
    }
    // A head script runs before the page's content exists, as in production, where the
    // parser stops for it before it reaches <body>.
    runAll(tpl.getAttribute("data-head-scripts"));
    (tpl.getAttribute("data-sheets") || "").split(" ").forEach(function (id) {
      var sheet = id ? document.querySelector('template[data-sheet="' + id + '"]') : null;
      if (sheet) app.appendChild(sheet.content.cloneNode(true));
    });
    app.appendChild(tpl.content.cloneNode(true));
    document.title = "Preview · " + tpl.getAttribute("data-title");
    runAll(tpl.getAttribute("data-scripts"));
    // The first show happens while the document loads, so the browser fires the event
    // itself; every later show has to, or an init-on-DOMContentLoaded handler never runs.
    if (document.readyState !== "loading") {
      document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: true }));
    }
    document.querySelectorAll("#preview-note nav a").forEach(function (a) {
      var here = !missing && a.getAttribute("href") === "#" + r.path;
      if (here) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    jump(r.frag);
  }
  // The hash route of a same-site path a script built at run time ("/compare/?from=1#top"),
  // or null when the href is not one or names no page of the bundle. Only the static HTML is
  // rewritten at build time, so these would otherwise leave the file. The query is dropped, as
  // for a static link; the fragment is kept.
  function routeOf(href) {
    if (href.charAt(0) !== "/" || href.charAt(1) === "/") return null;
    var frag = "";
    var cut = href.indexOf("#");
    if (cut >= 0) {
      frag = href.slice(cut);
      href = href.slice(0, cut);
    }
    var q = href.indexOf("?");
    var path = q >= 0 ? href.slice(0, q) : href;
    var tries = [path, path.replace(/index\.html$/, "")];
    if (path.slice(-1) !== "/") tries.push(path + "/");
    var routes = {};
    document.querySelectorAll("template[data-route]").forEach(function (t) {
      routes[t.getAttribute("data-route")] = true;
    });
    for (var i = 0; i < tries.length; i++) {
      if (Object.prototype.hasOwnProperty.call(routes, tries[i])) return "#" + tries[i] + frag;
    }
    return null;
  }
  // Point such a link at its hash route before the browser acts on it, so a plain click,
  // a modifier click, a middle click and the context menu's "open in new tab" all stay inside
  // the file.
  function mend(event) {
    if (event.defaultPrevented) return;
    var link = event.target.closest ? event.target.closest("a[href]") : null;
    var route = link ? routeOf(link.getAttribute("href")) : null;
    if (route) link.setAttribute("href", route);
  }
  document.addEventListener("click", mend);
  document.addEventListener("auxclick", mend);
  document.addEventListener("contextmenu", mend);
  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var link = event.target.closest ? event.target.closest("a[href]") : null;
    if (!link) return;
    var href = link.getAttribute("href");
    if (href.charAt(0) === "#" && href.charAt(1) !== "/") {
      event.preventDefault();
      jump(decodeURIComponent(href.slice(1)));
    }
  });
  // The policy's form-action is 'none', so a submit is never left to the browser. The
  // build points a GET form at the hash route of its page ("#/about/"); the query the
  // form would add is dropped, as for a link. A form that names no route (method=dialog,
  // or a page's own script handling it) is left alone.
  document.addEventListener("submit", function (event) {
    if (event.defaultPrevented) return;
    var form = event.target;
    var action = form && form.getAttribute ? form.getAttribute("action") : null;
    if (!action || action.slice(0, 2) !== "#/") return;
    event.preventDefault();
    window.location.hash = action.slice(1);
  });
  window.addEventListener("hashchange", show);
  show();
})();
"""

NOTE_CSS = """
#app { display: contents; }
#preview-note {
  display: flex; flex-wrap: wrap; align-items: center; gap: .25rem 1rem;
  padding: .5rem 1rem; font: 500 .75rem/1.4 var(--font-mono);
  background: #ffd84d; color: #141413; border-bottom: 1px solid #141413;
}
#preview-note strong { letter-spacing: .08em; text-transform: uppercase; }
#preview-note nav { display: flex; flex-wrap: wrap; gap: 0 .75rem; margin-left: auto; }
#preview-note a { color: inherit; text-decoration: underline; padding: .5rem 0; }
#preview-note a[aria-current="page"] { font-weight: 700; text-decoration-thickness: 2px; }
"""


def is_remote(url: str) -> bool:
    return classify(url) == "remote"


def is_inline(url: str) -> bool:
    """A ``data:`` URI or an in-page ``#`` reference: nothing to fetch."""
    return classify(url) == "inline"


def external_requests(text: str) -> list[str]:
    """Everything in ``text`` that would be fetched from outside the file.

    That is any remote URL, and any local one that is not a ``data:`` URI or a ``#``
    reference, in any URL-bearing attribute of any element and in any CSS ``url()``; and
    every construct the policy cannot cover (see ``site_refs.forbidden_constructs``). The
    references are found by ``site_refs``, the module the size check uses, and this is the
    early warning in front of the Content-Security-Policy.
    """
    doc = parse_html(text)
    bad = [f"<{tag} {attr}={value[:60]}>" for tag, attr, value in forbidden_constructs(doc)]
    for ref in doc.refs:
        if ref.attr in NAVIGATION_ATTRS:
            if is_remote(ref.value):
                bad.append(f"<{ref.tag} {ref.attr}={ref.value}>")
        elif ref.guarded and not is_inline(ref.value):
            bad.append(f"<{ref.tag} {ref.attr}={ref.value}>")
    # ``url()`` is a fetch in a ``style`` attribute and in a ``<style>`` block, and also in
    # SVG presentation attributes (fill, filter, mask, clip-path, marker-*): look in all.
    sources = [style.text for style in doc.styles]
    sources += [
        value
        for el in doc.elements
        for name, value in el.attrs
        if value and name != "style" and "url(" in value.lower()
    ]
    for css in sources:
        scan = scan_css(css)
        bad += [
            f"css url({ref.value})"
            for ref in scan.refs
            if ref.value.strip() and not is_inline(ref.value)
        ]
        bad += [f"css @import (line {n}): {src}" for n, src in scan.imports]
    return bad


def resolve(root: Path, base: str, ref: str) -> tuple[str, Path]:
    """``site_refs.resolve_local`` for the bundle: the file, or the build fails saying why."""
    result = resolve_local(root, base, ref)
    if result.path is not None:
        return result.url, result.path
    if result.problem == site_refs.MISSING:
        raise SystemExit(f"cannot inline {ref} (on {base}): no such file in the build")
    if result.problem == site_refs.CLIMBS:
        raise SystemExit(f"{ref} (on {base}) {result.problem}")
    raise SystemExit(f"{ref} {result.problem}")


def data_uri(root: Path, base: str, ref: str, frame: bool = False) -> str:
    _, target = resolve(root, base, ref)
    kind = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    if frame and kind == "text/html":
        raise SystemExit(f"cannot inline {ref} into a frame: a page loses its own assets")
    return f"data:{kind};base64,{base64.b64encode(target.read_bytes()).decode('ascii')}"


def escape_raw_text(text: str, tag: str) -> str:
    """``text`` made safe to put inside a ``<style>`` or ``<script>`` element.

    The HTML parser ends a raw-text element at the first ``</style`` or ``</script`` in any
    case, wherever it sits (a CSS string or comment, a JS string, regex or template). ``<\\/``
    is transparent in a JS string, a regex literal, a comment and an untagged template: the
    text means the same thing and the element no longer ends early. It is not transparent to
    a tagged template that reads the raw strings (``String.raw``): that sees the backslash.
    Applied before hashing, so the policy hash is of the text the browser reads.
    A raw ``<!--`` followed by ``<script`` inside a script is refused in ``bundle``: the
    parser then ignores the closing tag, and no escape is valid JS everywhere."""
    return re.sub(rf"</({tag})", r"<\\/\1", text, flags=re.IGNORECASE)


def inline_css(root: Path, css: str, css_url: str) -> str:
    """The stylesheet with every local reference as a data URI.

    ``@import`` is refused (the build fails naming the file and line), never dropped.

    ``css_url`` is the URL of the file the text came from (the page's own URL for a
    ``<style>`` block or a ``style`` attribute), which is what each reference is read
    against."""

    problems = import_problems(css_url, css)
    if problems:
        raise SystemExit("\n".join(problems))

    def swap(ref) -> str | None:
        value = ref.value.strip()
        if classify(value) != "local" or not value:
            return None  # the guard fails the build on whatever remote one is left
        return data_uri(root, css_url, value)

    return escape_raw_text(replace_css_refs(css, swap), "style")


def page_route(root: Path, base: str, ref: str) -> str:
    """The route of the page a link points at, however it is spelled.

    ``/about/``, ``/about``, ``/about/index.html`` and ``../about/index.html`` all name the
    page that ``/about/`` is, so all become ``#/about/``. The link is read by
    ``site_refs.resolve_local`` like every other reference, with ``index`` set (it is
    navigation); a link to nothing in the build keeps the URL it spells, so a dead link
    stays one for the size check to report.
    """
    found = resolve_local(root, base, ref, index=True)
    if found.path is None:
        return found.url
    return page_url(root.resolve(), found.path)


def rewrite_body(root: Path, body: str, here: str, routes: set[str]) -> str:
    """Links between pages become hash routes; everything the page would fetch is inlined.

    Local ``src``, ``srcset``, ``poster``, ``data`` and ``background``, and ``url()`` in
    ``style`` attributes and ``<style>`` blocks, become data URIs; ``<script>`` elements
    (the page scripts are carried separately) are removed. What this cannot inline is left
    as it is, and the guard in ``bundle`` fails the build on it. Tags and styles are found
    by ``site_refs`` (so a tag inside a comment is not one), never by pattern.
    """
    doc = parse_html(body)

    def one(tag: str, attribute: str, raw: str) -> str:
        raw = raw.strip()
        if classify(raw) != "local":
            return raw
        if attribute == "href":
            if tag in ("a", "area"):
                if is_worker_path(raw):
                    return PRODUCTION_ORIGIN + raw
                route = page_route(root, here, raw)
                if route in routes:
                    fragment = urlsplit(raw).fragment
                    return f"#{route}#{fragment}" if fragment else f"#{route}"
            return raw
        return data_uri(root, here, raw, frame=tag in FRAME_TAGS)

    def form_action(raw: str, label: str) -> str:
        """A GET form's ``action`` as the hash route of the page it names.

        The preview's policy has ``form-action 'none'`` and the router takes the submit
        over, so the action must be a route. One that is not a page of the build has no
        handler on a static site: the build fails rather than ship a form that does nothing.
        """
        raw = raw.strip()
        if classify(raw) == "remote":
            return raw  # the guard in ``bundle`` fails the build on it
        if classify(raw) == "inline" and not raw.startswith("#"):
            return raw
        route = page_route(root, here, raw)
        if route not in routes:
            raise SystemExit(
                f"page {here}: {label} is not a page of the build, and a static site has "
                "no handler for a form"
            )
        fragment = urlsplit(raw).fragment
        return f"#{route}#{fragment}" if fragment else f"#{route}"

    edits: list[tuple[int, int, str]] = [(a, b, "") for a, b in doc.script_spans]
    for style in doc.styles:
        if style.block:
            edits.append((style.start, style.end, inline_css(root, style.text, here)))
    for el in doc.elements:
        if any(a <= el.start < b for a, b in doc.script_spans):
            continue  # the whole element is removed above
        # The start tag is rebuilt from the attributes the parser read, so the rewrite
        # cannot disagree with discovery about where a value ends.
        changed = False
        rebuilt: list[str] = []
        goes_to_route = el.tag == "form" and form_method(el.attrs) == "get"
        for name, value in el.attrs:
            if name == "formaction" and (value or "") and classify(value) != "remote":
                raise SystemExit(
                    f"page {here}: <{el.tag} formaction={value}> cannot be bundled: the "
                    "preview routes a form by its action, so put the target there"
                )
            if goes_to_route and name == "action":
                new = form_action(value or "", f"<form action={value or ''}>")
                changed = changed or new != value
                rebuilt.append(f'{name}="{html.escape(new, quote=True)}"')
                continue
            if value is None:
                rebuilt.append(name)
                continue
            bare = name.rsplit(":", 1)[-1]
            new = value
            if name in ("srcset", "imagesrcset"):
                items = [(one(el.tag, "src", url), desc) for url, desc in parse_srcset(value)]
                new = ", ".join(" ".join(filter(None, item)) for item in items)
            elif name in FETCH_ATTRS and name != "manifest":
                new = one(el.tag, name, value)
            elif bare == "href":
                new = one(el.tag, "href", value)
            elif name == "style":
                new = inline_css(root, value, here)
            changed = changed or new != value
            rebuilt.append(f'{name}="{html.escape(new, quote=True)}"')
        if goes_to_route and first_attr(el.attrs, "action") is None:
            # No action means "this page", which is a route here like any other.
            rebuilt.append(f'action="{html.escape(form_action("", "<form>"), quote=True)}"')
            changed = True
        if changed:
            # A dropped "/" would nest the next sibling inside this one in SVG and MathML.
            close = "/>" if el.self_closing else ">"
            edits.append((el.start, el.end, "<" + " ".join([el.tag, *rebuilt]) + close))
    for begin, stop, text in sorted(edits, reverse=True):
        body = body[:begin] + text + body[stop:]
    return body


def first(pattern: str, text: str, default: str = "") -> str:
    found = re.search(pattern, text, flags=re.DOTALL | re.IGNORECASE)
    return found.group(1) if found else default


def collect(dist: Path) -> dict:
    """Read every page: its title, body, and which stylesheets and scripts it names.

    The references come from ``site_refs.inspect_page``; a page it finds a problem with
    (anything but a dead link between pages, which is the size check's business) fails the
    build, the same verdict ``check_site.py`` gives.
    """
    pages = []
    for file in page_files(dist):
        info = inspect_page(dist, file)
        fatal = [p.text for p in info.problems if p.category != "link"]
        if fatal:
            raise SystemExit("\n".join(fatal))
        text = file.read_text(encoding="utf-8")
        head = first(r"<head>(.*?)</head>", text)
        span = info.doc.body_span
        if span is None:
            raise SystemExit(f"{file} has no <body>")
        body = text[span[0] : span[1]]
        url = info.url
        # Percent-encoded, so a name with a space survives the space-joined list in
        # ``data-scripts``; the router and ``data-page-script`` use the same spelling.
        body_scripts = [
            quote(resolve(dist, url, ref.value)[0], safe="/")
            for ref in info.doc.refs
            if ref.tag == "script" and ref.attr == "src" and ref.in_body
        ]
        icon_rels = {ref.value: ref.rel for ref in info.doc.refs if ref.icon}
        pages.append(
            {
                "url": url,
                "title": html.unescape(first(r"<title>(.*?)</title>", head)).strip() or url,
                "body": body.strip(),
                # Linked sheets and head <style> blocks in the order the page writes them:
                # that order is the cascade, so the bundle must keep it.
                "styles": [
                    text
                    for _, text in sorted(
                        [
                            (off, ("sheet", u))
                            for off, (u, _) in zip(info.sheet_offsets, info.sheets, strict=True)
                        ]
                        + [(st.start, ("style", st.text)) for st in info.head_styles],
                        key=lambda item: item[0],
                    )
                ],
                "head_scripts": [
                    quote(resolve(dist, url, ref.value)[0], safe="/")
                    for ref in info.doc.refs
                    if ref.tag == "script" and ref.attr == "src" and not ref.in_body
                ],
                "body_scripts": body_scripts,
                "icons": [
                    (next(r for r in ICON_RELS if r in rel), href)
                    for href, rel in icon_rels.items()
                ],
                "theme": first(r'<meta name="theme-color" content="([^"]*)"', head, "#f4f1ea"),
                "site_name": html.unescape(
                    first(r'<meta property="og:site_name" content="([^"]*)"', head)
                ),
                "lang": first(r'<html[^>]*\blang="([^"]+)"', text, "en"),
            }
        )
    return {"pages": pages}


def read_asset(dist: Path, url_path: str) -> str:
    """The text of an asset by its normalised site URL (see ``resolve``)."""
    return resolve(dist, "/", quote(url_path))[1].read_text(encoding="utf-8")


def unique(items) -> list[str]:
    seen: list[str] = []
    for item in items:
        for value in item if isinstance(item, tuple) else (item,):
            if value and value not in seen:
                seen.append(value)
    return seen


def bundle(dist: Path, version: str, commit: str, built: str) -> str:
    pages = collect(dist)["pages"]
    if not pages:
        raise SystemExit(f"no pages in {dist}")
    routes = {page["url"] for page in pages}
    front = pages[0]
    site_name = front["site_name"] or front["title"]

    # home.js loads below.js (the drawn devices that step through releases) and lookup.js
    # (Check my version; compare.js loads it too) after the page has painted, which a bundle
    # cannot do; the bundle runs them right after home.js (lookup.js right after compare.js)
    # instead. timeline.js loads lanes.js (the Cadence view) the first time that view is shown,
    # so the bundle runs it right after timeline.js; timeline.js finds window.Lanes and does not
    # fetch.
    for page in pages:
        if HOME_SCRIPT in page["body_scripts"]:
            at = page["body_scripts"].index(HOME_SCRIPT) + 1
            page["body_scripts"].insert(at, BELOW_SCRIPT)
            page["body_scripts"].insert(at + 1, LOOKUP_SCRIPT)
        if COMPARE_SCRIPT in page["body_scripts"] and LOOKUP_SCRIPT not in page["body_scripts"]:
            at = page["body_scripts"].index(COMPARE_SCRIPT) + 1
            page["body_scripts"].insert(at, LOOKUP_SCRIPT)
        if (
            TIMELINE_SCRIPT in page["body_scripts"]
            and LANES_SCRIPT not in page["body_scripts"]
            and (dist / "assets" / "lanes.js").is_file()
        ):
            at = page["body_scripts"].index(TIMELINE_SCRIPT) + 1
            page["body_scripts"].insert(at, LANES_SCRIPT)
        if (dist / "assets" / "sigil-generic.js").is_file():
            for key in ("head_scripts", "body_scripts"):
                if SIGIL_SCRIPT in page[key]:
                    page[key].insert(page[key].index(SIGIL_SCRIPT) + 1, SIGIL_GENERIC_SCRIPT)

    # Every script, head or body, is stored once by its URL and run by the router when a
    # route that names it is shown. A head script keeps its own page's list: the union of
    # all pages' head scripts would run a page-only script on every route.
    page_scripts: dict[str, str] = {}
    for page in pages:
        for path in [*page["head_scripts"], *page["body_scripts"]]:
            if path not in page_scripts:
                source = read_asset(dist, unquote(path))
                page_scripts[path] = source.replace(HOME_CHECK, HOME_CHECK_BUNDLE)
    for path, source in page_scripts.items():
        lowered = source.lower()
        if "<!--" in lowered and "<script" in lowered:
            raise SystemExit(f"{path} contains <!-- before <script and cannot be inlined")
        page_scripts[path] = escape_raw_text(source, "script")

    icons = "".join(
        f'<link rel="{rel}" href="{data_uri(dist, front["url"], href)}">\n'
        for rel, href in front["icons"]
    )
    # Each distinct stylesheet text is stored once, in a <template data-sheet>; a route
    # lists the ids it needs, in the page's own order (the cascade), repeats included.
    sheets: list[str] = []
    templates = []
    for page in pages:
        names = " ".join(page["body_scripts"])
        head_names = " ".join(page["head_scripts"])
        body = rewrite_body(dist, page["body"], page["url"], routes)
        ids = []
        for kind, value in page["styles"]:
            css = (
                inline_css(dist, read_asset(dist, value), value)
                if kind == "sheet"
                else inline_css(dist, value, page["url"])
            )
            if css not in sheets:
                sheets.append(css)
            ids.append(str(sheets.index(css)))
        templates.append(
            f'<template data-route="{html.escape(page["url"])}" '
            f'data-title="{html.escape(page["title"])}" data-scripts="{html.escape(names)}" '
            f'data-head-scripts="{html.escape(head_names)}" '
            f'data-sheets="{" ".join(ids)}">\n'
            f"{body}\n</template>"
        )
    templates = [
        f'<template data-sheet="{n}"><style>{css}</style></template>'
        for n, css in enumerate(sheets)
    ] + templates
    nav = "".join(
        f'<a href="#{html.escape(page["url"])}">{html.escape(page["url"])}</a>' for page in pages
    )
    scripts = "\n".join(
        f'<script type="text/plain" data-page-script="{html.escape(path)}">{source}</script>'
        for path, source in page_scripts.items()
    )
    seed_files = [
        (path.name, path.read_text(encoding="utf-8").replace("<", "\\u003c"))
        for path in sorted((dist / "data").glob("*.json"))
    ]
    seeds = "\n".join(
        f'<script type="application/json" data-seed="/data/{html.escape(name)}">'
        + text
        + "</script>"
        for name, text in seed_files
    )
    label = (
        f"<strong>Preview</strong><span>{html.escape(site_name)}</span>"
        f"<span>version <code>{html.escape(version)}</code></span>"
        f"<span>commit <code>{html.escape(commit)}</code></span>"
        f"<span>built {html.escape(built)}</span>"
        f'<nav aria-label="Preview pages">{nav}</nav>'
    )
    # The exact text of each element, hashed as the browser will read it. The page scripts
    # are hashed too: the router runs each by putting its text in a new <script>, and the
    # policy admits that only if the text is one listed here. The embedded data
    # scripts are listed too, so the policy names every inline script the file holds.
    style_text = f"\n{NOTE_CSS}\n"
    router_text = f"\n{ROUTER}\n"
    shell = parse_html(label + "\n".join(templates))
    policy = preview_csp(
        unique([router_text, *page_scripts.values(), *(text for _, text in seed_files)]),
        unique([style_text, *(s.text for s in shell.styles if s.block)]),
        [s.text for s in shell.styles if not s.block],
    )
    out = f"""<!DOCTYPE html>
<html lang="{html.escape(front["lang"])}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="{policy}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="{html.escape(front["theme"])}">
<title>Preview \u00b7 {html.escape(site_name)} \u00b7 {html.escape(version)}</title>
{icons}<style>{style_text}</style>
</head>
<body>
<div id="preview-note" role="note">{label}</div>
<div id="app"></div>
{chr(10).join(templates)}
{scripts}
{seeds}
<script>{router_text}</script>
</body>
</html>
"""
    leaks = external_requests(out)
    if leaks:
        raise SystemExit("the bundle would fetch from outside the file: " + ", ".join(leaks))
    return out


def git_commit() -> str:
    try:
        result = subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["git", "rev-parse", "--short", "HEAD"],  # noqa: S607 - git from PATH is intended
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    value = result.stdout.strip()
    return value if result.returncode == 0 and re.fullmatch(r"[0-9a-f]{4,40}", value) else "unknown"


def refuse_out(out: Path, dist: Path) -> str | None:
    """Why ``out`` must not be written, or None.

    Inside the repository only ``dist/preview`` is a place for a bundle: anything else
    is the source, the built site or a tracked file, and ``--out src/index.html`` would
    replace the front page. An existing file is overwritten only when it is itself a
    previous bundle, so a typo cannot destroy an unrelated file anywhere.
    """
    target = out.resolve()
    if target.is_dir():
        return "it is a directory"
    if dist.resolve() in target.parents:
        return "it is inside the built site"
    root = ROOT.resolve()
    if root in target.parents and (root / "dist" / "preview") not in target.parents:
        return "inside the repository only dist/preview may hold the bundle"
    if target.exists():
        old = target.read_text(encoding="utf-8", errors="replace")
        if '<div id="preview-note" role="note">' not in old or "<title>Preview" not in old:
            return "it exists and is not a previous bundle"
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bundle_preview", description=__doc__.split("\n", 1)[0])
    parser.add_argument("--dist", type=Path, default=ROOT / "dist" / "site", help="built site")
    parser.add_argument(
        "--out", type=Path, default=ROOT / "dist" / "preview" / "index.html", help="the one file"
    )
    parser.add_argument("--commit", help="commit to show; default: git's short HEAD")
    parser.add_argument("--max-bytes", type=int, default=MAX_BYTES, help="size limit in bytes")
    args = parser.parse_args(argv)
    # Resolved once: every helper below compares paths, and a relative --dist would not
    # match the absolute paths ``inspect_page`` works with.
    args.dist = args.dist.resolve()
    args.out = args.out.resolve()
    version_file = args.dist / "version.txt"
    if not version_file.is_file():
        print(f"no built site at {args.dist}; run scripts/build_site.py first", file=sys.stderr)
        return 2
    version = version_file.read_text(encoding="utf-8").strip()
    commit = args.commit or git_commit()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", commit):
        parser.error("--commit must be a short token such as abc1234")
    stamp = dt.datetime.fromtimestamp(
        int(os.environ.get("SOURCE_DATE_EPOCH", dt.datetime.now(dt.timezone.utc).timestamp())),
        dt.timezone.utc,
    )
    text = bundle(args.dist, version, commit, stamp.strftime("%Y-%m-%d %H:%M UTC"))
    size = len(text.encode("utf-8"))
    if size > args.max_bytes:
        print(f"the bundle is {size} bytes, over the {args.max_bytes} limit", file=sys.stderr)
        return 1
    problem = refuse_out(args.out, args.dist)
    if problem:
        print(f"refusing --out {args.out}: {problem}", file=sys.stderr)
        return 2
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(text, encoding="utf-8")
    print(
        f"bundle: {args.out} ({size} bytes, {len(page_files(args.dist))} page(s), "
        f"{version} {commit})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
