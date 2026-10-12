# Source probe

The release adapters and the readiness benchmark are built against what each vendor really
sends. The vendor sites cannot be reached from every development environment, so the
**Source probe** workflow fetches them from a GitHub runner and prints what came back into
the job log.

## What it does

`scripts/probe_sources.py` reads `scripts/probe_sources.json`, a list of
`{id, vendor, kind, url}` plus the optional `raw_tables`, `raw_slice`, `accept`, `max_bytes` and `match_titles` below (`kind` is `release`, `security` or `enrichment`), and makes one GET
per source: 20 second timeout, at most 3 redirects and only to https, at most 2 MB read (`max_bytes` below raises it), at
least one second between two requests to the same host. A body that is still arriving after 60
seconds is cut and marked. A list entry or a redirect to localhost, a `.local` or `.internal`
name or an IP literal is refused.

Per source the log shows the id, the final URL, the HTTP status, the content type, the byte
length, the SHA-256 of the body and a trimmed excerpt:

- JSON: the top-level keys and the first two items of the first list found.
- XML, RSS, Atom: the root tag and the first three `item` or `entry` elements.
- HTML: the `<title>` (300 characters), up to 4000 characters of visible text and the first 40 links that
  mention security, release, bulletin, changelog or update.
- Anything else: the first 1500 characters.

Two optional fields change what is fetched and printed for one source:

- `raw_tables: N` (an integer from 1 to 10), for an HTML source, prints after the excerpt the
  raw outer HTML of the first N top-level `<table>` elements, each cut at 6000 characters. The
  tables are located with `html.parser` from the standard library, not a pattern over the
  HTML, so a nested table stays inside its outer one and an unclosed table runs to the end of
  the page. The adapters for the Android and Windows pages need this markup, which the visible
  text excerpt drops. The tables go through the same sanitising as the rest of the excerpt.
- `raw_slice` (one `{"start": "<marker>", "chars": N}` object or a list of up to 3), for an HTML
  source, prints after the excerpt N raw characters of the body starting at the first
  occurrence of the marker (1 to 80 characters, no control characters). It is for pages whose
  structure is not a table, such as the Apple security pages. If the marker is not in the body
  the log says `marker not found` and the run carries on. The slices of one source add up to at
  most 30000 characters. The text goes through the same sanitising as the tables.
- `accept` sets the `Accept` request header. It must be one of `application/json`,
  `application/xml` or `*/*` (the default). The same URL may be listed twice when the `accept`
  values differ, as `msrc-cvrf-2026-sep` and `msrc-cvrf-2026-sep-json` do, to see both
  representations of the MSRC CVRF month.
- `max_bytes: N` (an integer from 1 to 16777216) raises or lowers the read limit of 2 MB for one
  source. The MSRC CVRF month is larger than 2 MB, so a cut body would not parse and only the
  document header would print; both CVRF sources set 16 MB.

- `match_titles: "<text>"` (1 to 40 letters, digits and spaces) prints, after the JSON excerpt, the title, date and tags of up to 30 items whose title contains the text (case-insensitive); it applies only to a JSON list of objects with a `title` key, as for `steamos-getnewsforapp-1675200-100`.

A failing source is reported with its error class and the run carries on. The exit status is 0
unless the list file is invalid, then 1.

## Safe output

Everything in an excerpt came from a third party. Control and format characters are removed,
`::` is written `: :` and `##[` is written `# #[`, and every excerpt line is prefixed with two spaces, a vertical bar and a space, so
neither workflow-command form can appear at the start of a line. Excerpts are bounded (a long
title or link is cut at 300 characters). Request headers and the environment are never
printed.

## Running it

The workflow runs on `workflow_dispatch` and on a pull request from this repository that
changes the script, the list or the workflow (a fork's pull request is skipped, so it cannot
use the runner to fetch arbitrary URLs). It has read access to the repository and nothing else: no secret, no
token, no upload, and it commits nothing. Read the result in the job log.

To add a source, add an entry to `scripts/probe_sources.json`: https only, no credentials in
the URL, a unique kebab-case id (a unique URL, unless the `accept` differs), at most 40 entries (the script refuses more). `tests/test_probe_sources.py` checks the
list and the output handling without any network access.
