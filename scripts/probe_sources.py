#!/usr/bin/env python3
"""Read-only probe of every vendor source, for the job log.

Fetches each URL in ``scripts/probe_sources.json`` once and prints what the real response
looks like: status, content type, size, a digest and a trimmed excerpt. The adapters and the
readiness benchmark are built against these real payloads. It writes nothing, sends no
credentials and prints neither request headers nor the environment.

Everything printed from a response is untrusted. Each line is prefixed with ``  | ``, control
and format characters are removed, ``::`` is written ``: :`` and ``##[`` is written ``# #[``,
so neither workflow-command form can appear in an excerpt. Standard library only.

Exit status: 0 when the list is valid (individual sources may fail and are reported), 1 when
the list file is invalid.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_LIST = HERE / "probe_sources.json"

USER_AGENT = "orbit-source-probe (+https://orbit.szolotov.com)"
TIMEOUT = 20  # per socket operation
READ_DEADLINE = 60  # seconds for the whole body
MAX_SOURCES = 40
MAX_REDIRECTS = 3
MAX_BYTES = 2 * 1024 * 1024
EXCERPT_CHARS = 4000
MIN_GAP = 1.0  # seconds between two requests to one host
KINDS = ("release", "security", "enrichment")
ID_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
# Query parameter names that would mean a secret in the URL.
SECRET_PARAMS = {
    "key", "apikey", "api_key", "api-key", "token", "access_token", "secret",
    "password", "passwd", "auth", "sig", "signature",
}  # fmt: skip
LINK_PATTERN = re.compile(r"security|release|bulletin|changelog|update", re.IGNORECASE)
PREFIX = "  | "


# --- the list ---------------------------------------------------------------------------


def validate_sources(data: object) -> list[str]:
    """Every problem with the parsed list, empty when it is usable."""
    if not isinstance(data, list) or not data:
        return ["the list must be a non-empty JSON array"]
    if len(data) > MAX_SOURCES:
        return [f"the list must have at most {MAX_SOURCES} entries"]
    problems: list[str] = []
    ids: set[str] = set()
    urls: set[str] = set()
    for index, entry in enumerate(data):
        where = f"entry {index}"
        if not isinstance(entry, dict):
            problems.append(f"{where}: not an object")
            continue
        if set(entry) != {"id", "vendor", "kind", "url"}:
            problems.append(f"{where}: keys must be exactly id, vendor, kind, url")
            continue
        ident, vendor, kind, url = (entry[k] for k in ("id", "vendor", "kind", "url"))
        if not isinstance(ident, str) or not ID_PATTERN.match(ident):
            problems.append(f"{where}: id must be kebab-case")
        elif ident in ids:
            problems.append(f"{where}: duplicate id {ident}")
        else:
            ids.add(ident)
        if not isinstance(vendor, str) or not vendor.strip():
            problems.append(f"{where}: vendor must be a non-empty string")
        if kind not in KINDS:
            problems.append(f"{where}: kind must be one of {', '.join(KINDS)}")
        if not isinstance(url, str):
            problems.append(f"{where}: url must be a string")
            continue
        problems.extend(f"{where}: {p}" for p in url_problems(url))
        if url in urls:
            problems.append(f"{where}: duplicate url {url}")
        urls.add(url)
    return problems


def host_refused(host: str) -> bool:
    """True for localhost, local-only names and any IP literal: only public DNS names pass."""
    host = host.strip("[]").rstrip(".").lower()
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        return True
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def url_problems(url: str) -> list[str]:
    parts = urllib.parse.urlsplit(url)
    problems = []
    if parts.scheme != "https":
        problems.append("url must be https")
    if not parts.hostname:
        problems.append("url has no host")
    elif host_refused(parts.hostname):
        problems.append("url host must be a public DNS name")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        problems.append("url must not carry credentials")
    for name, _ in urllib.parse.parse_qsl(parts.query, keep_blank_values=True):
        if name.lower() in SECRET_PARAMS:
            problems.append(f"url has a secret-looking query parameter {name}")
    if any(c.isspace() for c in url):
        problems.append("url contains whitespace")
    return problems


def load_sources(path: Path) -> list[dict]:
    """The validated list. Raises ValueError with every problem when it is invalid."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"cannot read {path.name}: {type(exc).__name__}") from exc
    problems = validate_sources(data)
    if problems:
        raise ValueError("\n".join(problems))
    return data


# --- making output safe -----------------------------------------------------------------


def clean(text: str) -> str:
    """Remove control and format characters; keep newlines and turn tabs into spaces.

    Unicode line and paragraph separators and NEL count as line breaks, so a renderer cannot
    show a line start where this code saw none.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\x85", "\n").replace("\u2028", "\n").replace("\u2029", "\n")
    text = text.replace("\t", " ")
    return "".join(
        ch for ch in text if ch == "\n" or unicodedata.category(ch) not in ("Cc", "Cf", "Cs")
    )


def break_commands(text: str) -> str:
    """``::`` becomes ``: :`` and ``##[`` becomes ``# #[``, the two workflow-command forms."""
    text = re.sub(r":(?=:)", ": ", text)
    return re.sub(r"#(?=#\[)", "# ", text)


def sanitize(text: str, *, prefix: str = PREFIX) -> str:
    """Make untrusted text safe to print: cleaned, `::` and `##[` broken, lines prefixed."""
    lines = break_commands(clean(text)).split("\n")
    return "\n".join(prefix + line for line in lines)


def one_line(text: object, limit: int = 300) -> str:
    """A short single-line value (a URL, a header) made safe."""
    value = break_commands(clean(str(text))).replace("\n", " ")
    return value[:limit]


def cut(text: str, limit: int = EXCERPT_CHARS) -> str:
    return text if len(text) <= limit else text[:limit] + f"\n[cut at {limit} chars]"


# --- excerpts ---------------------------------------------------------------------------


def first_list(value: object, depth: int = 0) -> tuple[str, list] | None:
    """The first list found, breadth-first by key order, as (path, list)."""
    if isinstance(value, list):
        return "$", value
    if not isinstance(value, dict) or depth > 4:
        return None
    for key, child in value.items():
        if isinstance(child, list):
            return str(key), child
    for key, child in value.items():
        found = first_list(child, depth + 1)
        if found:
            return f"{key}.{found[0]}", found[1]
    return None


def json_excerpt(text: str) -> str:
    data = json.loads(text)
    out: dict = {}
    if isinstance(data, dict):
        out["top_level_keys"] = list(data)
    else:
        out["top_level_type"] = type(data).__name__
    found = first_list(data)
    if found:
        path, items = found
        out["first_list"] = {"path": path, "length": len(items), "first_2_items": items[:2]}
    return cut(json.dumps(out, indent=2, ensure_ascii=False, default=str))


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def xml_excerpt(text: str) -> str:
    # A document with a DTD is not parsed: entity expansion is not worth the risk for a probe.
    if re.search(r"<!(DOCTYPE|ENTITY)", text, re.IGNORECASE):
        return "[XML with a DTD or entities: not parsed]"
    root = ET.fromstring(text)  # noqa: S314 - a DTD or entity is refused above
    parts = [f"root: {local_name(root.tag)}"]
    entries = [e for e in root.iter() if local_name(e.tag) in ("item", "entry")]
    parts.append(f"item/entry elements: {len(entries)}")
    for element in entries[:3]:
        parts.append(ET.tostring(element, encoding="unicode").strip())
    return cut("\n".join(parts))


class _Page(HTMLParser):
    SKIP = {"script", "style", "noscript", "template", "svg"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.text: list[str] = []
        self.links: list[str] = []
        self._in_title = False
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._in_title = True
        elif tag in self.SKIP:
            self._skip += 1
        elif tag == "a":
            href = dict(attrs).get("href")
            if href and LINK_PATTERN.search(href):
                self.links.append(href)

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag in self.SKIP and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.text.append(data)


def html_excerpt(text: str) -> str:
    page = _Page()
    page.feed(text)
    page.close()
    visible = re.sub(r"\s+", " ", " ".join(page.text)).strip()
    links = [link[:300] for link in dict.fromkeys(page.links)][:40]
    parts = [
        "title: " + re.sub(r"\s+", " ", page.title).strip()[:300],
        "visible text:",
        visible[:EXCERPT_CHARS],
        f"matching links (first {len(links)}, max 40):",
        *links,
    ]
    return cut("\n".join(parts), EXCERPT_CHARS + 2000)


def text_excerpt(text: str) -> str:
    return cut(text.strip(), 1500)


def kind_of(content_type: str, text: str) -> str:
    """json, xml, html or text, from the content type and then the first bytes."""
    ctype = content_type.split(";")[0].strip().lower()
    head = text.lstrip()[:512].lower()
    if ctype.endswith("json") or head.startswith(("{", "[")):
        return "json"
    if ctype.endswith("xml") or head.startswith(("<?xml", "<rss", "<feed")):
        return "xml"
    if ctype == "text/html" or head.startswith(("<!doctype html", "<html")):
        return "html"
    return "text"


def excerpt(content_type: str, text: str) -> str:
    """A trimmed, unsanitised excerpt. A parse failure falls back to plain text."""
    kind = kind_of(content_type, text)
    try:
        if kind == "json":
            return "json\n" + json_excerpt(text)
        if kind == "xml":
            return "xml\n" + xml_excerpt(text)
        if kind == "html":
            return "html\n" + html_excerpt(text)
    except Exception as exc:  # best effort: a parser fault must not erase the report
        return f"{kind} (parse failed: {type(exc).__name__})\n" + text_excerpt(text)
    return "text\n" + text_excerpt(text)


# --- fetching ---------------------------------------------------------------------------


class RedirectRefusedError(urllib.error.URLError):
    """A redirect the probe will not follow."""


class LimitedRedirects(urllib.request.HTTPRedirectHandler):
    """At most MAX_REDIRECTS hops, and only to https."""

    def __init__(self) -> None:
        self.hops = 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urljoin(req.full_url, newurl)
        parts = urllib.parse.urlsplit(target)
        if parts.scheme != "https":
            raise RedirectRefusedError("redirect to a non-https URL refused")
        if not parts.hostname or host_refused(parts.hostname):
            raise RedirectRefusedError("redirect to a local or IP-literal host refused")
        self.hops += 1
        if self.hops > MAX_REDIRECTS:
            raise RedirectRefusedError("too many redirects")
        return super().redirect_request(req, fp, code, msg, headers, target)


def read_body(response, *, clock=time.monotonic) -> tuple[bytes, str]:
    """Up to MAX_BYTES + 1 bytes in chunks, stopping at READ_DEADLINE. Returns (body, note)."""
    deadline = clock() + READ_DEADLINE
    chunks: list[bytes] = []
    got = 0
    while got <= MAX_BYTES:
        if clock() > deadline:
            return b"".join(chunks), "read deadline"
        chunk = response.read(min(65536, MAX_BYTES + 1 - got))
        if not chunk:
            break
        chunks.append(chunk)
        got += len(chunk)
    return b"".join(chunks), ""


def fetch(url: str) -> dict:
    """One GET. Returns status, final_url, content_type, body, truncated; raises on failure.

    An HTTP error status is a result, not a failure: its body is often the useful part.
    """
    request = urllib.request.Request(  # noqa: S310 - https only, checked by validate_sources
        url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"}
    )
    opener = urllib.request.build_opener(LimitedRedirects())
    try:
        response = opener.open(request, timeout=TIMEOUT)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        body, note = read_body(response)
        headers = response.headers
        status = response.status if hasattr(response, "status") else response.code
        final_url = response.geturl()
        charset = headers.get_content_charset() or "utf-8"
        content_type = headers.get("Content-Type", "")
    return {
        "status": status,
        "final_url": final_url,
        "content_type": content_type,
        "charset": charset,
        "body": body[:MAX_BYTES],
        "truncated": len(body) > MAX_BYTES or bool(note),
        "note": note,
    }


def decode(body: bytes, charset: str) -> str:
    try:
        return body.decode(charset, errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


def report(source: dict, result: dict | None, error: BaseException | None) -> str:
    """The log block for one source."""
    lines = [
        "=" * 72,
        f"id: {one_line(source['id'])}  vendor: {one_line(source['vendor'])}"
        f"  kind: {one_line(source['kind'])}",
        f"url: {one_line(source['url'])}",
    ]
    if error is not None or result is None:
        name = type(error).__name__ if error is not None else "Unknown"
        detail = ""
        if isinstance(error, urllib.error.URLError) and not isinstance(error.reason, str):
            detail = f" ({type(error.reason).__name__})"
        elif isinstance(error, RedirectRefusedError):
            detail = f" ({one_line(error.reason, 80)})"
        lines.append(f"error: {name}{detail}")
        return "\n".join(lines)
    body = result["body"]
    lines += [
        f"final url: {one_line(result['final_url'])}",
        f"status: {result['status']}",
        f"content-type: {one_line(result['content_type'])}",
        f"bytes: {len(body)}" + (f" (truncated at {MAX_BYTES})" if result["truncated"] else "")
        + (f" ({one_line(result['note'], 40)})" if result.get("note") else ""),
        f"sha256: {hashlib.sha256(body).hexdigest()}",
        "excerpt:",
        sanitize(excerpt(result["content_type"], decode(body, result["charset"]))),
    ]
    return "\n".join(lines)


def run(sources: list[dict], *, sleep=time.sleep, clock=time.monotonic, out=sys.stdout) -> None:
    last: dict[str, float] = {}
    for source in sources:
        host = urllib.parse.urlsplit(source["url"]).hostname or ""
        wait = MIN_GAP - (clock() - last[host]) if host in last else 0
        if wait > 0:
            sleep(wait)
        result = error = None
        try:
            result = fetch(source["url"])
        except Exception as exc:  # any failure is recorded, never fatal
            error = exc
        last[host] = clock()
        print(report(source, result, error), file=out, flush=True)
    print("=" * 72, file=out)
    print(f"probed {len(sources)} sources", file=out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--list", type=Path, default=DEFAULT_LIST, help="the sources file")
    args = parser.parse_args(argv)
    try:
        sources = load_sources(args.list)
    except ValueError as exc:
        print(f"invalid source list:\n{exc}", file=sys.stderr)
        return 1
    run(sources)
    return 0


if __name__ == "__main__":
    sys.exit(main())
