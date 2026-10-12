# 0006: List a vendor before its feed is connected

## Context

MikroTik (RouterOS), Google (Android), Microsoft (Windows) and Valve (SteamOS for the Steam Deck) were asked for next to Apple. Research for each found candidate sources, but when this change was prepared none of them could be read from the build environment except a few Android developer pages, and those hold HTML tables for pre-release builds only. No feed layout, channel label, version or build format, cadence or term of use was confirmed for the other three. Most of the release lists that did turn up came from search summaries and third-party news pages, which disagree with one another in places. An adapter written against a guessed layout would either fail quietly or publish a wrong "latest" version, and a stale pre-release table would have shown an Android beta from last year as the newest Android.

## Decision

The four families are added everywhere a family appears: the config with an accent that meets the contrast rules in all three themes, a card and a section with a drawn device on the front page, a ring on the dial, a chip on the timeline, an option on the compare page, and the notices and source links of every page. No adapter is registered and no release row is added to the snapshot. A family without releases already renders its empty state ("No release yet"), and the Worker fetches nothing for it.

The source link of each vendor in `families.json` is where a reader goes for that vendor's own release information. It is a link, not a fetch: the Worker's allowlist is the adapter's `urls`, and there is none.

An adapter is added for a vendor only when all of these hold, in a session that can reach its host:

- the real document has been fetched and a recorded sample is committed under `tests/fixtures/`;
- the format, the channel labels (a pre-release must map to `beta` or `rc`) and the version and build shapes are written down from that sample;
- the terms of use allow automated polling, and the poll interval, cache and User-Agent follow them;
- the parser is strict, skips malformed entries, keeps only https links on the vendor's hosts and copies no release notes.

## Consequences

- The site never shows a number that was not read from the vendor.
- Connecting a vendor later is one adapter file, one registry line, a fixture and a snapshot refresh; the pages, colours, filters and dial need no change.
- Until then the four platforms look empty. The About page says so.
- Provenance of the source links. The four links below are the vendors' own landing pages for release information, shown as where to look. None was fetched and read when this change was prepared (mikrotik.com answered 403 to the research), so they are unverified: https://mikrotik.com/download/changelogs, https://developer.android.com/about/versions, https://learn.microsoft.com/en-us/windows/release-health/release-information and https://store.steampowered.com/news/app/1675200. Each must be checked by hand before its adapter lands, and the host lists in `families.json` stay at the single source host until then.
- SteamOS is listed but shows no releases until a verified Steam source and adapter exist.
- Open questions per vendor: MikroTik (which feed carries the stable and long-term channels, and the channel labels), Android (a machine-readable source for stable releases and monthly patch levels, since the developer pages cover betas), Windows (a structured source on Microsoft Learn or the update history pages, and how hotpatch and out-of-band updates are labelled) and Valve (the shape and channel labels of the Steam news data for the Steam Deck app).

## Update: the Android adapter (2026-10-12)

A read-only probe fetched each vendor source from a GitHub runner on 2026-10-12. For Android it read https://source.android.com/docs/setup/reference/build-numbers (status 200, `text/html; charset=utf-8`, 342,995 bytes, sha256 `77b4266e1122dc2495a65e2d93c38be3bd6a23715734a1affc5575c0036e8b7a`). The page holds three tables. The second has the columns Build ID, Tag, Version, Supported devices and Security patch level, and lists AOSP release tags newest first, for example `android-17.0.0_r1` with build `CP2A.260605.016` and patch level 2026-06-05.

The Google adapter, `deploy/sources/android.js`, is connected on that basis:

- Format: the table is found by its header cells, not by its position, and read by a bounded scanner. One release per tag of the form `android-<major>.<minor>.<patch>_r<N>`; `version` is the tag's version part, `build` is the Build ID, `date` is the day in the build id's date segment (`CP2A.260605.016` is 2026-06-05) and the security patch level only when the build id has none.
- Stage: the page lists no pre-release, so every row is a `release`. A tag that is not of that form (a beta tag, say) is skipped, not guessed at.
- Security refreshes: the `android-security-*` rows have a bare numeric build id and are security-only. The release contract has no stage for them, so they are skipped.
- The link of every release is the build-numbers page, https on `source.android.com` only; `families.json` lists that host beside `developer.android.com`. No text of the page is kept.
- The fixture is an excerpt of the probe's raw tables. The probe cut table 2 at 6,000 characters, after `android-15.0.0_r20`, so older rows are not in the fixture.
- The snapshot holds `android-17.0.0_r1` only. The older rows in the probe excerpt are outside the dial's 26-week window, and the Worker merges them in from the live page.
- Open: the terms of use of the page have not been read for automated polling. The Worker reads it at most every ten minutes with the site's User-Agent, and the owner confirms the terms before the next release. The other three vendors are unchanged by this update.
