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
