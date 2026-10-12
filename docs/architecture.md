# Architecture

Release Orbit is a static site and one small API, served by a single Cloudflare Worker named `orbit`. This page describes the components, how data moves, what happens when something fails, and the limits the design keeps to. The reasons behind the main choices are in the [decision records](adr/0001-no-framework-or-bundler.md).

## Components

| Component | Where | Job |
| --- | --- | --- |
| Static site | `src/` | Plain HTML, one stylesheet and small scripts. No framework and no bundler. |
| Build | `scripts/build_site.py` | Copies `src/` to `dist/site/`, stamps the version, writes `robots.txt` and `sitemap.xml`, copies `results/` into `data/results/`. Standard library only. |
| Worker | `deploy/worker.js` | Answers `/api/releases.json` and `/api/health`. Every other path is a static asset. |
| Source adapters | `deploy/sources/` | One adapter per feed: `{ id, vendor, urls, parse(text) }`. `urls` is the allowlist the Worker may fetch. The registry is `index.js`. |
| Release contract | `deploy/releases.js` | The release shape, date parsing and the merge of live data with the snapshot. |
| Snapshot | `src/data/releases.json` | The bundled copy of the releases. Refreshed with `node deploy/snapshot_releases.mjs`. |
| Families | `src/data/families.json` | Platform families, their accents and the vendors with their sources. Read by the Worker and the pages. Five vendors: Apple (with an adapter), MikroTik, Google, Microsoft and Valve (listed, no adapter yet). |
| Results | `results/` | One JSON file per publicly released, tested build. |
| Page scripts | `src/assets/` | `releases.js` loads the data. `home.js`, `timeline.js` and `compare.js` draw a page. `sigil.js` and `orbit.js` draw the signature. `below.js` (the mock screens and the developer highlights), `cadence.js`, `sigil-generic.js` (the sigil rule for a build that is not an Apple build), `fx.js` and `aurora.js` load after the first paint. |
| Checks | `scripts/check_*.py`, `tests/` | Site, results and pipeline checks, and the Python and Node tests. |
| Pipeline | `.github/workflows/` | `ci`, `security`, `deploy` (pull request dry run and the Preview), `cut-release`, `release` and `dependabot-auto-merge`. |

## Data flow

1. A browser asks the Worker for a page. Static assets are answered directly, with the headers in `src/_headers`.
2. `releases.js` reads `/data/families.json`, then fetches `/api/releases.json`.
3. For each source in the registry the Worker reads its own edge-cache entry. A copy under 10 minutes old is served as is. An older copy, up to 24 hours, is served at once while a refresh runs in the background. The cache keeps a live copy for 7 days from the fetch.
4. A refresh fetches only the URLs on the source's allowlist, with an 8 second timeout and no redirect followed, parses the feed, and merges the result into the bundled snapshot so history outlives the feed's short window.
5. The answer carries `stale` when any source could not be reached and `snapshot` when part of it is the bundled copy.
6. The page keeps only entries whose family belongs to the entry's vendor and whose link is on a host that vendor's source allows, and writes text with `textContent`. It polls every five minutes while the tab is visible and shows a toast when new ids appear.
7. The sigils, the dial and the pages below the fold are drawn from that one list of releases. The dial's time machine re-draws them as of a chosen day.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| A feed is slow or unreachable | A cached copy is served marked `stale: true`. The source is not asked again for 5 minutes. |
| A feed fails and nothing is cached | A short negative marker holds the same 5 minute back-off, so requests do not each wait for the timeout. The bundled snapshot answers with `snapshot: true`. |
| A feed returns unparseable data | The source counts as failed. Other sources are unaffected. |
| A feed redirects | The redirect is not followed, because it would leave the allowlist. The source counts as failed. |
| The Worker script fails | `/api/*` errors. The page falls back to `/data/releases.json`. Static pages are unaffected. |
| JavaScript is off or blocked | Pages show placeholders and a link to the source. |
| A browser lacks a feature | Scroll-driven effects, WebGL and the pointer highlight are skipped by feature detection and the plain page remains. |
| A production release fails its smoke test | The release job rolls back to the version that was serving. |
| A bad result file is committed | `check_results.py` fails CI and the build. A beta or release-candidate result is refused. |

## Limits

- **Budgets.** First-paint scripts under 60,000 bytes per page, the effect modules budgeted apart, a page with everything it loads under 500,000 bytes, any image under 200,000 bytes.
- **Dial window.** 26 weeks, widening to 52 when the data spans more. The rings are 30 units apart; with more than seven families the gap, and the notches with it, narrow so the innermost ring stays at radius 118, outside the hand's hub and the centre date.
- **Vendors without a feed.** `families.json` may list a vendor whose adapter does not exist yet. Its cards and sections render the empty state, and nothing is fetched for it ([ADR 0006](adr/0006-list-vendors-before-their-feeds.md)).
- **Security policy.** No inline script or style and no widening of the Content-Security-Policy to make a change work. The only outside origin is Google Fonts.
- **Single Worker.** One Worker serves production and, as a Preview, the stage host. Until the first release the stage job attaches the custom domain for Preview traffic only; the first release makes it Production and Preview. Environment-scoped secrets and branch and tag rulesets keep the two apart ([SETUP.md](../SETUP.md)).
- **No runtime dependencies.** The site ships none, `scripts/` use the standard library only, and the Worker needs none beyond the platform.
- **Public data only.** The site shows what vendors have published and results for builds already released ([ADR 0005](adr/0005-public-results-only-for-released-builds.md)).
