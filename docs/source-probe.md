# Source probe

The release adapters and the readiness benchmark are built against what each vendor really
sends. The vendor sites cannot be reached from every development environment, so the
**Source probe** workflow fetches them from a GitHub runner and prints what came back into
the job log.

## What it does

`scripts/probe_sources.py` reads `scripts/probe_sources.json`, a list of
`{id, vendor, kind, url}` (`kind` is `release`, `security` or `enrichment`), and makes one GET
per source: 20 second timeout, at most 3 redirects and only to https, at most 2 MB read, at
least one second between two requests to the same host.

Per source the log shows the id, the final URL, the HTTP status, the content type, the byte
length, the SHA-256 of the body and a trimmed excerpt:

- JSON: the top-level keys and the first two items of the first list found.
- XML, RSS, Atom: the root tag and the first three `item` or `entry` elements.
- HTML: the `<title>`, up to 4000 characters of visible text and the first 40 links that
  mention security, release, bulletin, changelog or update.
- Anything else: the first 1500 characters.

A failing source is reported with its error class and the run carries on. The exit status is 0
unless the list file is invalid, then 1.

## Safe output

Everything in an excerpt came from a third party. Control characters are removed, `::` is
written `: :`, and every line starts with `  | `, so no excerpt can act as a workflow command.
Request headers and the environment are never printed.

## Running it

The workflow runs on `workflow_dispatch` and on a pull request that changes the script, the
list or the workflow. It has read access to the repository and nothing else: no secret, no
token, no upload, and it commits nothing. Read the result in the job log.

To add a source, add an entry to `scripts/probe_sources.json`: https only, no credentials in
the URL, a unique kebab-case id, under 40 entries. `tests/test_probe_sources.py` checks the
list and the output handling without any network access.
