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
- Open questions per vendor: MikroTik (which feed carries the stable and long-term channels, and the channel labels), Android (a machine-readable source for stable releases and monthly patch levels, since the developer pages cover betas) and Valve (the shape and channel labels of the Steam news data for the Steam Deck app). The Windows questions are answered below.

## Update: the Windows adapter (2026-10-12)

Windows was the first of the four to meet the conditions above. A read-only probe fetched the pages from a GitHub runner on 2026-10-12 and recorded the answer of each (status, content type, size, SHA-256 and the raw tables). Both answered 200 `text/html` with no redirect:

- https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information (132,531 bytes, SHA-256 `3c9fc9b33646c4ef971499c714960fc8718c6c1fef195da02c2ac94f69d20ceb`)
- https://learn.microsoft.com/en-us/windows/release-health/release-information, the Windows 10 page (320,848 bytes, SHA-256 `7a66752e80d19cacbf08ddfbefffa5588a69e7e2a70efcf130089fd903c0243c`)

Everything below is read from those records, and the recorded tables are committed under `tests/fixtures/microsoft/`:

- The first table of each page lists the servicing versions with the columns Version, Servicing option, Availability date, two End of updates columns, Latest update (Latest update for ESU on the Windows 10 page), Latest revision date and Latest build. The Latest update cell links to `https://support.microsoft.com/help/<KB>` with a label such as `2026-09 D` or `2026-09 OOB`. The second table is the LTSC table, whose end-date columns are named differently, and the adapter ignores it.
- The adapter emits one release per row whose servicing option is General Availability Channel: the family `Windows`, the version (`25H2`), the latest build (`26200.9550`), the latest revision date as midnight UTC, and the title `Windows 11 25H2 (2026-09 D)`. The stage is always `release`: these pages carry no pre-release channel, so nothing maps to `beta` or `rc`. The id carries the build, so each monthly update is a new entry once the snapshot merges.
- The families stay one `Windows` family, as the config has it. The title says 11 or 10, which the adapter reads from the page title; a later `Windows 11` and `Windows 10` family pair would be picked up without a code change.
- The contract has no end-of-support field, so a version whose End of updates cells all read "End of updates" says so in its title (Windows 10 22H2). A version still updated for some edition is not marked. The adapter does not compare dates with the clock, so parsing stays a pure function of the page.
- The link is the KB article only when it is `https://support.microsoft.com/help/<digits>` with no port or credentials, and otherwise the release-health page. `support.microsoft.com` is therefore added to the Microsoft vendor's `hosts`, which the pages use to accept a release link.
- The parser is a small strict scanner over the first table, bounded in input, rows and cell size, with no DOM and no `eval`. A page whose first table lacks the expected headers yields nothing, and the Worker then serves the last good copy.

Not settled by the probe: Microsoft's terms of use for automated reads of Microsoft Learn were not read. The Worker's existing ten-minute cache and identifying User-Agent apply, and the owner should check the terms before the first release.
