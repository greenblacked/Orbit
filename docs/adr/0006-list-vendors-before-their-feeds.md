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
- Until then the four platforms look empty. The About page says so. (See the 2026-10-12 update: MikroTik is connected, so this now covers Android, Windows and SteamOS.)
- Provenance of the source links. The four links below are the vendors' own landing pages for release information, shown as where to look. None was fetched and read when this change was prepared (mikrotik.com answered 403 to the research), so they are unverified: https://mikrotik.com/download/changelogs, https://developer.android.com/about/versions, https://learn.microsoft.com/en-us/windows/release-health/release-information and https://store.steampowered.com/news/app/1675200. Each must be checked by hand before its adapter lands, and the host lists in `families.json` stay at the single source host until then.
- SteamOS is listed but shows no releases until a verified Steam source and adapter exist.
- Open questions per vendor: MikroTik (which feed carries the stable and long-term channels, and the channel labels), Android (a machine-readable source for stable releases and monthly patch levels, since the developer pages cover betas), Windows (a structured source on Microsoft Learn or the update history pages, and how hotpatch and out-of-band updates are labelled) and Valve (the shape and channel labels of the Steam news data for the Steam Deck app).

## Update 2026-10-12: MikroTik is connected

A read-only probe fetched each vendor source from a GitHub runner on 2026-10-12 and recorded status, content type, size, SHA-256 and an excerpt. It settled the MikroTik open questions, and the adapter `deploy/sources/mikrotik.js` is registered:

- `https://upgrade.mikrotik.com/routeros/NEWESTa7.stable`, `.../NEWESTa7.long-term` and `.../NEWESTa7.testing` answer 200 `text/plain` with one line, `<version> <unix-seconds>` (`7.24.5 1790691687`, `7.23.8 1791452776`, `7.25rc1 1790864328`). The channel is in the URL only.
- `https://download.mikrotik.com/routeros/latest-stable-and-long-term.rss` answers 200 `application/rss+xml` with items titled `RouterOS <version> [<channel>]`, linking `https://mikrotik.com/download?v=<version>`, dated by `pubDate`. It is not polled: it names the same versions as the stable and long-term files with a different date (for 7.23.8, the item is dated a day after the NEWEST timestamp), and a failure of it would fail the whole source. Its excerpt in the probe was a re-serialised form, not the raw bytes, so no fixture was kept.
- Not used: `NEWEST7a.*` answers 404, and the plain `NEWEST7.*` files answer a stale `7.12.1` and `0.00`, so neither is a source. `https://mikrotik.com/current.rss` redirects to a stable-only feed that the RSS above already covers.
- Channels map as follows: `stable` and `long-term` are `release`, with the channel kept in the title (`RouterOS 7.23.8 long-term`); `testing` carries `rc` or `beta` versions (`7.25rc1`) and is a pre-release with its iteration number. A pre-release's `version` is its number alone (`7.25`) with the full string (`7.25rc1`) kept as its build, title and id. A pre-release version in a stable channel, or a plain version in testing, is skipped as malformed.
- MikroTik has no build ids. A release's build is its version string, which the snapshot contract requires to be non-empty and which the build sigil hashes like any generic build.
- The date of a release is its NEWEST unix timestamp in UTC, the one date source. A timestamp more than a day in the future is not believed and the release is skipped. The link is always built from the version, never read from a document.
- The three NEWEST documents are fixtures under `tests/fixtures/mikrotik/`, copied from the probe excerpts.

The terms of use for automated polling of these endpoints were not part of the probe and are still to be confirmed by hand, and the gate above (terms allow automated polling) is open until the owner confirms them or accepts the exception here; the Worker asks each URL at most once per cache window with the site's User-Agent. The vendor's source link in `families.json` stays the changelogs page. Android, Windows and Valve remain as described above.


## Update: the Android adapter (2026-10-12)

A read-only probe fetched each vendor source from a GitHub runner on 2026-10-12. For Android it read <https://source.android.com/docs/setup/reference/build-numbers> (status 200, `text/html; charset=utf-8`, 342,995 bytes, sha256 `77b4266e1122dc2495a65e2d93c38be3bd6a23715734a1affc5575c0036e8b7a`). The probe recorded the first three tables of the page. The second has the columns Build ID, Tag, Version, Supported devices and Security patch level, and lists AOSP release tags newest first, for example `android-17.0.0_r1` with build `CP2A.260605.016` and patch level 2026-06-05.

The Google adapter, `deploy/sources/android.js`, is connected on that basis:

- Format: the table is found by its header cells, not by its position, and read by a bounded scanner. One release per tag of the form `android-<major>.<minor>.<patch>_r<N>`; `version` is the tag's version part, `build` is the Build ID, `date` is the day in the build id's date segment (`CP2A.260605.016` is 2026-06-05) and the security patch level only when the build id has none.
- Stage: the recorded rows include no pre-release tag, so every row is a `release`, and the adapter skips any tag that is not of the release form (a beta tag, say) instead of guessing. The probe cut table 2 at 6,000 characters, so the whole page was not read.
- Security refreshes: the `android-security-*` rows have a bare numeric build id and are security-only. The release contract has no stage for them, so they are skipped.
- The link of every release is the build-numbers page, https on `source.android.com` only; `families.json` lists that host as the Google vendor's source, and the vendor's source link on every page now points at the build-numbers page (named "AOSP build numbers") because that is where the data comes from; `developer.android.com/about/versions` is no longer linked and stays unverified. No text of the page is kept.
- Ordering within a day: many tags share a build day, so the revision number is added as the time of day in seconds (`android-15.0.0_r36` is `00:00:36`), which keeps the higher revision first and the "latest" card on the newest revision. The shared merge breaks date ties by id as a string, which would put `r10` before `r9`.
- Bounds: the page reaches back to 2009 (about three hundred release tags). Only rows dated within 180 days of the newest row are emitted, and a row dated more than a day after the Worker's clock is refused (a typo such as `CP2A.990605.016` must not pin a release in 2099). Without the window the live dial would widen to 52 weeks (it does so when the oldest release is more than 26 weeks old), and the timeline and the Android recent list would fill with old device builds. To show all of AOSP history, raise `WINDOW_DAYS` knowing the dial then shows 52 weeks.
- Dates: `date` is the build-cut day from the build id, not the day the tag was published (`android-15.0.0_r24`, build `BD4A.240925.111`, is dated 2024-09-25 although its patch level is 2025-01-05), so the order on the dial can differ from tag order. This is accepted.
- The scanner skips the content of `script`, `style`, `template` and `textarea` elements and reads a tag name only when a space, `/` or `>` follows it (`<table-x>` is not a table). It still ends a tag at the first `>`, even inside a quoted attribute, and fails closed: a change of markup that breaks the table gives no rows, and the Worker then serves the snapshot as stale.
- The Worker's `Accept` header now includes `text/html;q=0.6`, since this is the first HTML source.
- The fixture is an excerpt of the probe's raw tables. The probe's raw excerpt stopped at 6,000 characters part-way through the `android-15.0.0_r17` row; the fixture keeps the complete rows up to and including `android-15.0.0_r20`, so older rows are not in it.
- The snapshot holds `android-17.0.0_r1` only, the one row inside the dial's 26-week window. The Worker serves the live rows within the 180-day window described below, merged with the snapshot; older rows are not emitted. The snapshot's `fetchedAt` is still the Apple refresh time.
- Open: the terms of use of the page have not been read for automated polling. The Worker reads it at most every ten minutes per Cloudflare location (the Cache API is per data centre) with the site's User-Agent, and the owner confirms the terms before the next release. The other three vendors are unchanged by this update.
