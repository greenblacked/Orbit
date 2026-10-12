# 0008: Security notes are a separate payload

## Context

A visitor looking at a release, or comparing two, wants to know what changed for security. The vendors answer that in their own pages: Apple's security content pages, the Android Security Bulletins, Microsoft's security update guide, MikroTik's advisories. None of them is in the release feeds the Worker reads, and the release contract (`deploy/releases.js`, pinned by `tests/snapshot.test.mjs`) has no field for it.

Security data differs from release data in four ways. It is per page, not per feed entry, and an index has to be walked to find the pages. Some documents are large. The vendors' wording is theirs and is not ours to copy ([ADR 0006](0006-list-vendors-before-their-feeds.md)). And a missing note is not the same as a build with no fixes, so a wrong "0" would be worse than saying nothing.

## Decision

1. **A separate payload.** Security notes live in `src/data/security.json`, not in `releases.json`. The release contract and its tests stay unchanged. Android's security patch level lives in the security payload for the same reason.
2. **Snapshot-only serving.** The Worker answers `/api/security.json` by reading `/data/security.json` from `ASSETS`, with the same API headers as the other routes (the static file at `/data/security.json` has only the static headers). It fetches nothing from a vendor, so no allowlist entry, cold-path latency or body cap is added to the Worker. A missing snapshot gives a 503 JSON error with `cache-control: no-store`, like the releases route. The local preview server answers only `/api/health` and `/api/releases.json`, and `screenshots.py` fails on any status of 400 or more, so the client loads `/data/security.json` first and treats `/api/security.json` as optional, without logging an error; the route that adds `/api/security.json` to `serve_site.py` does so with a test.
3. **Manual refresh.** A snapshot script run by hand refreshes the file, as `snapshot_releases.mjs` does for releases. Parsing happens there, in CI or on a developer machine, never in the Worker. A scheduled workflow may follow as its own pipeline pull request.
4. **Only rows we already show.** Notes are attached to ids that exist in `releases.json`. A release the feed omits gets no note; adding it is a release-adapter change.
5. **Facts only.** The file stores CVE ids, page titles, dates, URLs and the vendor's own severity label. It never stores a vendor's impact or description text.
6. **Careful wording.** Compare says `Listed in NEWER's notes, not in OLDER's`, never "newly fixed", because whether a vendor's page is cumulative is not verified. Counts read `N CVEs listed in VENDOR notes`, never an exposure figure.
7. **Phasing.** Phase 1 is Apple and Android. RouterOS and SteamOS follow as notes-only (a vendor page is linked, with no CVE matching). Windows (MSRC CVRF) waits until a document is measured, and is parsed in CI with an explicit byte cap, never in the Worker. Each vendor's adapter is admitted only after a probe fixture with provenance is committed, as ADR 0006 requires, together with a check of the vendor's terms of use.
8. **Outside first paint.** The UI loads after paint, on the timeline and compare pages only. A line on the home cards is a later, optional change that needs its own budget decision.

### Data contract (schema 1)

```json
{
  "schema": 1,
  "generatedAt": "ISO timestamp",
  "sources": { "source id": { "status": "ok | failed", "checkedAt": "ISO timestamp", "index": "https url" } },
  "notes": {
    "https url": {
      "source": "source id", "title": "short title", "published": "YYYY-MM-DD or null",
      "cves": [{ "id": "CVE-YYYY-NNNN", "severity": "vendor label or null" }],
      "noCveEntries": false
    }
  },
  "releases": {
    "release id from releases.json": {
      "status": "listed | no-cve-entries | not-found | not-applicable | unavailable | not-connected",
      "notes": ["https url"], "cves": ["CVE-YYYY-NNNN"], "count": "number or null",
      "patchLevel": "YYYY-MM-DD or null", "checkedAt": "ISO timestamp"
    }
  }
}
```

- `releases[id].cves` is the sorted, de-duplicated union of the CVEs of that release's notes. `count` equals `cves.length` and is non-null only for `listed` and `no-cve-entries`.
- Android stores its `patchLevel` and the URLs of its own bulletin only, not a union over every earlier bulletin (about 130 since 2015-08, which would put thousands of ids in each row). Compare takes the bulletins with a month in (older patch level, newer patch level] from `notes` and does the set difference in the page. A `count` for Android covers only the CVEs listed in the bulletin read, which can include vendor-component CVEs and CVEs for other Android versions.
- If a release id has no key in `releases`, the page shows the Not connected state when the family has no adapter, and otherwise the No match state.
- The join key is the release id from `releases.json`, never a URL.
- Tests enforce: every note URL is https on a host in the vendor's `security.hosts` list in the families data (a separate list from `source.hosts`, which bounds release links; Apple's security pages are on support.apple.com, which release links must not gain); every `releases[].notes` entry exists in `notes`; every release key exists in `releases.json`; only `stage: "release"` rows are `listed` or `no-cve-entries`, and betas and release candidates are `not-applicable` because vendors publish security pages only for released builds, following the same rule as [ADR 0005](0005-public-results-only-for-released-builds.md).
- Caps on notes, CVEs per note and total payload bytes are chosen from measured fixtures when the first adapter lands, and tested. `check_site.py` weighs only files a page loads directly, so the payload cap is a test, not a budget.

### Empty and unknown states

| State | Condition | Status | Shown |
| --- | --- | --- | --- |
| Pre-release | beta or release candidate | `not-applicable` | "Security notes cover released builds only." No count. |
| Listed | page matched, at least one CVE | `listed` | "N CVEs listed in VENDOR notes", with a link |
| No CVE entries | the page says so | `no-cve-entries` | "VENDOR lists no CVE entries for this build", with a link. The only place a count of 0 appears. |
| Recently shipped, no match | within a grace window (14 days, to be confirmed) of the release date | `not-found` | "Security notes not published yet (checked DATE)" |
| Older, no match | past the grace window | `not-found` | "No matching security note found (checked DATE)", with the index link. Never 0. |
| Not connected | no adapter for the family | `not-connected` | "Security details not connected for FAMILY yet", with the vendor link |
| Unavailable | source failed, or `checkedAt` older than 30 days (to be confirmed) | `unavailable` | "Could not refresh security data (snapshot DATE)". Never 0. |
| Android, no patch level | the security payload has no patch level for it | `not-found`, `patchLevel` null | "No patch level published for this build" |
| Android, no bulletin | patch level known, no bulletin for the month | `unavailable`, `patchLevel` set | "No Android Security Bulletin read for YYYY-MM yet" |
| Android, empty bulletin | its own bulletin read, no rows | `no-cve-entries` | "Bulletin lists no CVEs" |
| Severity absent | the vendor gives none | unchanged | "Severity not published", never an invented value |
| Compare, side unknown | either side has no known note | none | "Security comparison unavailable: no known note for SIDE" |
| Compare, Android inverted | the newer build's patch level is not greater | none | "Patch level is not newer; no CVEs listed beyond OLDER's" |

An Android range with a missing bulletin is `unavailable` or `not-found`, never `listed`: the site shows a CVE list only when every bulletin it needs was read.

## Consequences

- The release contract, its Worker merge and its tests do not change, and a broken security parser cannot hide a release.
- The site never shows a security number that was not read from a vendor page. Absence is shown as absence.
- Security data is as fresh as the last manual refresh. Without a schedule it goes stale, so the payload carries `generatedAt` and per-source `checkedAt`, and the page shows the snapshot date when a source is `failed`.
- Coverage follows `releases.json`. Apple's feed may omit base releases that have a security page, and those rows show no note until the release adapter has them.
- Joins by release id can orphan a row when an adapter changes an id. The invariant tests fail on it.
- The Compare difference is only as good as the vendors' cumulative wording, which is why it is worded as a listing and not a claim.
- Status: accepted. The payload, the route and the first adapters are added in follow-up changes; until they land, `/api/security.json` does not exist. When the route lands, the Failure modes and Limits sections of `docs/architecture.md` gain a row for it.
- Terms of use for each source are unverified; the owner accepts or checks each before its adapter is admitted.

## Alternatives rejected

- **Security fields on `releases.json`.** It changes the exact key set the release tests pin, `deploy/releases.js` and every client, ties a parser failure to the release list, and puts per-page data in a per-entry contract.
- **A live fetch in the Worker.** It adds allowlist entries, a chain of fetches on the cold path, each with the Worker's 8-second timeout, and a body cap, since the Microsoft document may exceed the 2 MiB `MAX_BODY_BYTES` (not yet measured). Parsing it at request time is unsafe on the Worker's CPU and memory limits. The Worker's cached copy also expires after 7 days.
- **Copying vendor text.** Impact descriptions are the vendors' wording. Storing ids, titles, dates, URLs and severity labels, and linking to the page, keeps the site within ADR 0006's rule of copying no release notes.
