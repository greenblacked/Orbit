# 0008: Security notes are a separate payload

## Context

A visitor looking at a release, or comparing two, wants to know what changed for security. The vendors answer that in their own pages: Apple's security content pages, the Android Security Bulletins, Microsoft's security update guide, MikroTik's advisories. None of them is in the release feeds the Worker reads, and the release contract (`deploy/releases.js`, pinned by `tests/snapshot.test.mjs`) has no field for it.

Security data differs from release data in four ways. It is per page, not per feed entry, and an index has to be walked to find the pages. Some documents are large. The vendors' wording is theirs and is not ours to copy ([ADR 0006](0006-list-vendors-before-their-feeds.md)). And a missing note is not the same as a build with no fixes, so a wrong "0" would be worse than saying nothing.

## Decision

1. **A separate payload.** Security notes live in `src/data/security.json`, not in `releases.json`. The release contract and its tests stay unchanged (apart from the unrelated optional `summary` line, a one-line description that is not security data). Android's security patch level lives in the security payload for the same reason.
2. **Snapshot-only serving.** The Worker answers `/api/security.json` by reading `/data/security.json` from `ASSETS`, with the same API headers as the other routes (the static file at `/data/security.json` has only the static headers). It fetches nothing from a vendor, so no allowlist entry, cold-path latency or body cap is added to the Worker. A missing snapshot gives a 503 JSON error with `cache-control: no-store`, like the releases route. The local preview server (`scripts/serve_site.py`) answers `/api/security.json` from `data/security.json`, covered by `tests/test_serve_site.py`. `screenshots.py` fails on any status of 400 or more, so the client asks `/api/security.json` first and reads `/data/security.json` only if that fails (see the update below); a failing API logs one console error before the fallback, as for `/api/releases.json`.
3. **Manual refresh.** A snapshot script run by hand refreshes the file, as `snapshot_releases.mjs` does for releases. Parsing happens there, in CI or on a developer machine, never in the Worker. A scheduled workflow may follow as its own pipeline pull request.
4. **Only rows we already show.** Notes are attached to ids that exist in `releases.json`. A release the feed omits gets no note; adding it is a release-adapter change.
5. **Facts only.** The file stores CVE ids, page titles, dates, URLs and the vendor's own severity label. It never stores a vendor's impact or description text.
6. **Careful wording.** Compare says `Fixed after OLDER, up to NEWER` for the union of the newer release's notes and those of every public release between the two (any of them unknown or stale makes it unavailable); Android keeps `Listed in NEWER's notes, not in OLDER's`. Neither says "newly fixed", and the range is read release by release because whether a vendor's page is cumulative is not verified. Counts read `N CVEs listed in VENDOR notes`, never an exposure figure.
7. **Phasing.** Phase 1 is Apple and Android. RouterOS and SteamOS follow as notes-only: a vendor page is matched and linked, with no CVE matching, and the row is `linked`. Windows (MSRC CVRF) waits until a document is measured, and is parsed in CI with an explicit byte cap, never in the Worker. Each vendor's adapter is admitted only after a probe fixture with provenance is committed, as ADR 0006 requires, together with a check of the vendor's terms of use.
8. **Off the front page.** The UI is `security.js`, a deferred script on the timeline and compare pages only, and it counts toward those pages' script budget. It is never loaded by the front page, which keeps its first-paint budget. A line on the home cards is a later, optional change that needs its own budget decision.

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
      "status": "listed | linked | no-cve-entries | not-found | not-applicable | unavailable | not-connected",
      "notes": ["https url"], "cves": ["CVE-YYYY-NNNN"], "count": "number or null",
      "patchLevel": "YYYY-MM-DD or null", "checkedAt": "ISO timestamp",
      "source": "source id (optional)"
    }
  }
}
```

- `releases[id].cves` is the sorted, de-duplicated union of the CVEs of that release's notes, and `notes` is sorted and de-duplicated too. For `listed`, `count` equals `cves.length` (at least 1) and `notes` is not empty. For `linked`, a vendor page was matched but its CVEs are not counted: `count` is null, `cves` is empty and `notes` holds that page's URL (not empty). For `no-cve-entries`, `cves` is empty, `count` is 0 and its notes (if any) hold no CVEs. For every other status, `notes` and `cves` are empty and `count` is null.
- `releases[id].source` is optional: the id of the adapter whose index the row came from, always a key of `sources`. The builder writes it on every row a source describes except `not-applicable`, and never on `not-connected`. It lets the page treat a row as stale when that source is `failed` even if the row has no note to point at it (an Apple row with `no-cve-entries` and no link). The contract rejects a `source` that is not a key of `sources`.
- Android stores its `patchLevel` and the URLs of its own bulletin only, not a union over every earlier bulletin (about 130 since 2015-08, which would put thousands of ids in each row). Compare takes the bulletins with a month in (older patch level, newer patch level] from `notes` and does the set difference in the page. A `count` for Android covers only the CVEs listed in the bulletin read, which can include vendor-component CVEs and CVEs for other Android versions.
- If a release id has no key in `releases`, the timeline shows nothing for that row (the No entry state). A family with no adapter is written as `not-connected` in the payload to mark the Not connected state (the timeline draws no pill for it): the builder writes it for every `release`-stage row no source describes, and `not-applicable` for that family's other stages.
- The join key is the release id from `releases.json`, never a URL.
- `tests/security.test.mjs` enforces today: `schema` is 1 and `generatedAt` is a date; `sources`, `notes` and `releases` are objects; every note URL (a key of `notes`, and every entry of `releases[].notes`) is a parseable `https` URL with a host; every note names a source in `sources`; every CVE id matches `CVE-YYYY-NNNN` or more digits, and the lists are sorted and unique; every `releases[].notes` entry exists in `notes`, and a listed release's CVEs are exactly those of its notes (every CVE comes from its notes and none is left out), and a `no-cve-entries` release's notes hold no CVEs; every release key exists in `releases.json`; a `releases[].source`, when present, is a string naming a key of `sources`, and is absent on `not-applicable` and `not-connected` rows; only `stage: "release"` rows are `listed` or `no-cve-entries`, and every other row is `not-applicable`, because vendors publish security pages only for released builds, following the same rule as [ADR 0005](0005-public-results-only-for-released-builds.md). Still to add with the first adapter: a check that each note host is in the vendor's `security.hosts` list in the families data (a separate list from `source.hosts`, which bounds release links; Apple's security pages are on support.apple.com, which release links must not gain). Also still to add: the `linked` status. The executable contract does not know it today (its status set and per-status shape checks stop at `listed`, `no-cve-entries`, `not-found`, `not-applicable`, `unavailable` and `not-connected`), so `linked` enters `tests/security.test.mjs` in the same pull request as the first notes-only adapter (RouterOS or SteamOS), with its shape (count null, `cves` empty, `notes` not empty) and the release-stage-only rule. Until then no row may use it. The snapshot also validates the payload before writing (`deploy/security/validate.js`, a pure function; it refuses to write and exits non-zero on an invalid one), and its status set must gain `linked` in that same pull request, or the snapshot will refuse the row.
- Caps on notes, CVEs per note and total payload bytes are chosen from measured fixtures when the first adapter lands, and tested. `check_site.py` weighs only files a page loads directly, so the payload cap is a test, not a budget.

### Empty and unknown states

| State | Condition | Status | Shown |
| --- | --- | --- | --- |
| Pre-release | beta or release candidate | `not-applicable` | Nothing: the row shows no security line. |
| Listed | page matched, at least one CVE | `listed` | "N CVEs listed in VENDOR notes", with a link |
| Linked, CVEs not counted | page matched, notes-only adapter, no CVE matching | `linked` | "VENDOR security notes for this build (CVEs not counted)", with a link. No count. |
| No CVE entries | the page says so | `no-cve-entries` | "VENDOR lists no CVE entries for this build", with a link. The only place a count of 0 appears. |
| No entry | the release id has no key in `releases` | none | Nothing: the row shows no security line. |
| Recently shipped, no match | within a grace window (14 days, to be confirmed) of the release date | `not-found` | "Security notes not published yet (checked DATE)" |
| Older, no match | past the grace window | `not-found` | "No matching security note found (checked DATE)". Never 0. A link to the index is not shown yet. |
| Not connected | no adapter for the family | `not-connected` | nothing on the row; the timeline says once, in a static line, "Security details: Apple and Android" |
| Unavailable | source failed, or `checkedAt` older than 30 days (to be confirmed) | `unavailable` | "Could not refresh security data (snapshot DATE)". Never 0. |
| Android, no patch level | the security payload has no patch level for it | `not-found`, `patchLevel` null | "No patch level published for this build" |
| Android, no bulletin | patch level known, no bulletin for the month | `unavailable`, `patchLevel` set | "No Android Security Bulletin read for YYYY-MM yet" |
| Android, empty bulletin | its own bulletin read, no rows | `no-cve-entries` | "Bulletin lists no CVEs" |
| Severity absent | the vendor gives none | unchanged | "Severity not published", never an invented value |
| Compare, side unknown | either side has no known note | none | "Security comparison unavailable: no known note for SIDE" |
| Compare, side linked | either side is `linked` | none | "Cannot compare: CVEs not counted for SIDE" |
| Compare, Android inverted | the newer build's patch level is not greater | none | "Patch level is not newer; no CVEs listed beyond OLDER's" |

An Android range with a missing bulletin is `unavailable` or `not-found`, never `listed`: the site shows a CVE list only when every bulletin it needs was read.

## Consequences

- The release contract, its Worker merge and its tests do not change, and a broken security parser cannot hide a release.
- The site never shows a security number that was not read from a vendor page. Absence is shown as absence.
- Security data is as fresh as the last manual refresh. Without a schedule it goes stale, so the payload carries `generatedAt` and per-source `checkedAt`, and the page shows the snapshot date when a source is `failed`.
- Coverage follows `releases.json`. Apple's feed may omit base releases that have a security page, and those rows show no note until the release adapter has them.
- Joins by release id can orphan a row when an adapter changes an id. The invariant tests fail on it.
- The Compare difference is only as good as the vendors' cumulative wording, which is why it is worded as a listing and not a claim.
- Status: accepted. The empty schema-1 payload (`src/data/security.json`), the Worker route `/api/security.json` and the local preview route have landed, and `docs/architecture.md` has its rows for them. The first vendor payload, from the Security snapshot workflow on dev 0d42060 (2026-10-13), is committed. Rows turn stale 30 days after `checkedAt`, so the snapshot needs a refresh before about 2026-11-12.
- The owner accepted the terms of use of both vendors for automated reads on 2026-10-14 (Apple's security release pages on `support.apple.com`, the Android Security Bulletins on `source.android.com`).

## Alternatives rejected

- **Security fields on `releases.json`.** It changes the exact key set the release tests pin, `deploy/releases.js` and every client, ties a parser failure to the release list, and puts per-page data in a per-entry contract.
- **A live fetch in the Worker.** It adds allowlist entries, a chain of fetches on the cold path, each with the Worker's 8-second timeout, and a body cap, since the Microsoft document may exceed the 2 MiB `MAX_BODY_BYTES` (not yet measured). Parsing it at request time is unsafe on the Worker's CPU and memory limits. The Worker's cached copy also expires after 7 days.
- **Copying vendor text.** Impact descriptions are the vendors' wording. Storing ids, titles, dates, URLs and severity labels, and linking to the page, keeps the site within ADR 0006's rule of copying no release notes.

## Update: the Apple adapter (2026-10-12)

The first adapter, `deploy/security/apple.js`, reads Apple's "Apple security releases" index and the security content page behind each row. Its fixtures are in `tests/fixtures/apple-security/` with a provenance README, as [ADR 0006](0006-list-vendors-before-their-feeds.md) requires.

- **Matching.** A release matches the index row with its family and version number (`27.0` and `27` are one version). The date only chooses between rows of one version (the nearest wins) and refuses a row 7 or more days away (the gap is counted on UTC dates, so a row exactly 7 days away is refused and 6 days is accepted), because the feed and the index date one release days apart (`iPadOS 26.7` is 2026-09-09 in the feed and 14 Sep 2026 in the index).
- **CVEs.** A note's CVEs are the union of the ids that start a paragraph of the page, not the ids of one platform's section. A page counts for a release only if its heading names the release's own product and version (`covers`); a page that was read and refused is never replaced by the previous note.
- **Links.** A row's link must resolve to `https://support.apple.com/en-us/<digits>`, with no port, credentials, query or fragment. A relative link is resolved against the index. A release that was `listed` or `no-cve-entries` and no longer matches keeps its old entry and is reported as a failure, because markup drift looks like that.
- **Caps.** At most 40 pages a run, 400 notes (shared with Android's monthly bulletins), 500 CVEs a note and 2 MiB of payload; a page over the CVE cap is refused, a source whose notes would take the payload over the notes cap fails alone (its previous notes and rows are kept and the others still write), and a payload over the byte cap is not written. The values are generous against the fixtures and are to be tightened after the first real refresh.
- **Failures.** A page that could not be read again keeps its previous note and its previous `checkedAt`, and the script exits non-zero.
- **Grace window.** The 14-day wording of the table above is applied only in the page; the payload stores `not-found` either way.
- **Deferred.** The check that each note host is in the vendor's `security.hosts` list (see the contract above) is not added in this pull request: it needs a `security.hosts` list in `families.json`, which changes `src/` and the preview loop. The adapter checks its own host (`support.apple.com`) in the meantime, and the contract check follows in its own pull request.
- **Terms of use.** The owner accepted Apple's terms for automated reads of these pages on 2026-10-14. The first payload is committed in `src/data/security.json`.

## Update: the Android security adapter (2026-10-12)

A read-only probe fetched the October 2026 AOSP and Pixel bulletins on 2026-10-12. The recorded tables and the h1 slice of each are the fixtures in `tests/fixtures/android-security/`, with their provenance in its README ([ADR 0006](0006-list-vendors-before-their-feeds.md)). The adapter is `deploy/security/android.js`; it does no I/O and runs in the snapshot step only.

- **Patch level source.** The patch level of a release is the "Security patch level" cell of its row in the AOSP build-numbers page, the page the release adapter already reads, as the exact string. It is never derived from the release date (`android-15.0.0_r25` is dated 2025-04-05 by its build id and has the level 2025-02-05). A tag with no level, a bad one or two different ones has none, and its row is `not-found`.
- **Bulletins.** One bulletin per month, at `/docs/security/bulletin/2026/2026-10-01` from 2026 on and `/docs/security/bulletin/2025-12-01` before (the older form is read from the October 2026 page's links). A page counts as read only if its title starts with "Android Security Bulletin" and it has a publish date. A read page is used when it lists CVE rows and names a patch level in the month of its own URL. With no CVE rows and no CVE table it is used only if it says outright that it has no security patches and names that patch level or has that month in its title, or if it is wordless: it has the month in its title and names that patch level, names no CVE id in its text and has no table with a CVE column. Any other page that yields no CVEs is `unavailable`, never `no-cve-entries`. The wording of an empty bulletin has not been recorded, so that sentence is a guess that fails safe.
- **Compare.** `neededBulletins` returns every month from the oldest to the newest patch level of the Android releases (capped at 200 months), and `match` stores a note for every bulletin read, whether or not a release points at it, so the months in (older, newer] are in `notes`.
- **Pixel.** The Pixel Update Bulletin has the same table shape and the same parser reads it, but its patch level is a device level and this ADR has no rule to join it to an Android release, so it is a separate source (`android-pixel-bulletin`) and is never joined or stored by `match`.
- **Caps.** 2 MiB of input, 2000 CVEs per bulletin (the October 2026 AOSP page has 25), 4 patch levels per page, 5000 build rows and 200 bulletin months. They are bounds on a hostile or changed page, set well above the recorded sizes and pinned by tests; the payload is capped at 400 notes and 2 MiB (see the Apple section for the Apple page cap). The notes cap is shared by both sources on purpose, but an overflow is charged to the source that passes it, in order: that source is recorded as failed and keeps its previous notes and rows, and the other still writes. The order is the registry's, and the other source's previous notes count until it is processed, so a source can fail on a cap that the other source's own run would then lower; the run exits non-zero and the next refresh settles it.
- **Snapshot.** `deploy/snapshot_security.mjs` drives it through the registry (`kind: 'bulletins'`). It reads the build-numbers page (its `index`), parses the patch levels, then reads the bulletins `neededBulletins` names (at most 200), one request a second, each URL once, and only on `source.android.com`. A page that answers a redirect is followed by hand, at most three hops, and only to an https URL on the adapter's own hosts with no userinfo or port; the note stays keyed by the URL the adapter asked for, and any other target fails the page and names its host (the Worker still follows no redirect). Every request sends `Accept-Language: en-US,en;q=0.9`, and an adapter whose host picks the language from a query parameter declares it (`lang: { param: 'hl', value: 'en' }` on Android): the request carries `hl=en`, the key stays the canonical URL, and a redirect to the same parameter with another value (`?hl=it`) is refused as a non-English variant instead of parsed. `buildPayload` folds the result in on its own: if the build-numbers page cannot be read or has no patch levels the source is `failed` and keeps its old rows and notes, and Apple is unaffected (and the reverse). A bulletin that was not fetched keeps its previous note and the rows that point at it, and is reported; a page that was read and refused never does. A release that was `listed` and has lost its patch level keeps its old row and is reported. The notes of the Android source are kept even when no release points at them, because Compare needs the months in between. The Pixel bulletin is not driven: it is never joined to a release. Where the vendors cannot be reached from the author's machine, the manual **Security snapshot** workflow (`.github/workflows/security-snapshot.yml`, `workflow_dispatch` only, read-only, no secret) runs it on a GitHub runner and prints the file base64-encoded with its size and SHA-256; the payload is copied from the log into a pull request and reviewed there, and the workflow commits nothing. Dispatch it on a branch whose `src/data/releases.json` is current, since the payload is joined to that file. The owner accepted the terms of use of `source.android.com` for automated reads on 2026-10-14, and the first payload from the workflow is committed.
- **Deferred, not met.** The check that each note host is in the vendor's `security.hosts` (`source.android.com` is to be added to Google's list when that list lands), which the probe did not do.
- **Terms of use.** The owner accepted the terms of use of source.android.com for automated reads on 2026-10-14.

## Update: one request per page (2026-10-13)

The page asks `/api/security.json` once and reads `/data/security.json` only if that fails (the Worker serves the same bundled file, so asking for both was a second download of the same bytes), and it takes vendor names from the families config that `releases.js` already loaded instead of fetching `families.json` again. If the API answers 200 with JSON that the page rejects (wrong schema or a bad `generatedAt`), the page does not fall back: the Worker re-serves the same bytes as the snapshot, so the snapshot would be rejected too.

## Update: snapshot hardening (2026-10-21)

The snapshot script holds each adapter's index URL, every note URL and every redirect target to the adapter's own hosts with one check: https, no userinfo, no port, and a host that is exactly on the list. A source whose index fails that check, or that throws after its index was parsed, is recorded as failed like any other source failure, and the others still write. The payload is validated before it is written: `deploy/security/validate.js` checks the header, the notes map (https keys, a known source, sorted and unique CVE ids), and that each release's notes exist and its CVEs come from them; the rest of the contract (the join to `releases.json`, patch levels, stages) stays in `tests/support/security_contract.mjs`. A row kept on drift (a release that lost its patch level or its index row) is brought in line with the notes it names before the payload is written: a page read and refused this run is never put back, so a kept row whose note is no longer held becomes `unavailable` and is reported, and any other row lists the union of its notes' CVEs (`listed`, or `no-cve-entries` when the union is empty) instead of blocking the snapshot.
