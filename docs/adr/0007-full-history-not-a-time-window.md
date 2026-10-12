# 0007: Every release we have, not a time window

## Context

[ADR 0006](0006-list-vendors-before-their-feeds.md) kept the Android and SteamOS adapters to the last 180 days so that the dial, which widened to 52 weeks whenever the oldest release was more than 26 weeks old, stayed at 26 weeks, and so that the timeline did not fill with old device builds. The cost was that the Release timeline showed one Android release and two SteamOS ones, although the source pages and the recorded fixtures hold many more. The timeline is meant to list every release the site has for each vendor.

## Decision

- The Android and SteamOS adapters emit every release they can read, newest first. The time window and `WINDOW_DAYS` are gone. The safety bounds stay: Android reads at most 2 MB and 5000 table rows, SteamOS at most 500 news items, the merge caps the list at 2000 releases, and a row or post dated more than a day ahead of the clock is refused. Security-only `android-security-*` rows are still skipped: they carry a bare numeric build id and no Android version, and the release contract has no stage for them, so there is no clean way to show them.
- The dial no longer reads the data's span. Its window is fixed at 26 weeks, and notches are chosen by date, so older releases are neither drawn nor counted however wide the data is.
- The timeline needs no change: it lists everything it is given, grouped by month with the year, and counts per filter.
- `src/data/releases.json` gains the history that is already recorded in the repository, and nothing else. The Android rows are the 21 release rows of `tests/fixtures/google/build-numbers.html` older than `android-17.0.0_r1` (`android-16.0.0_r1` to `r4` and `android-15.0.0_r20` to `r36`), and the SteamOS rows are the 17 other SteamOS posts of `tests/fixtures/valve/getnewsforapp-steamos-titles.json`, made by the adapters' own rules (id, stage, date and build as `parse` derives them; the fixture has no post links, so the news page is the link). Older AOSP history is not in the repository; the live API serves it once deployed, and `node deploy/snapshot_releases.mjs` brings it into the snapshot.
- Apple, MikroTik and Windows are unchanged: the Apple feed and the Windows tables carry no window, and MikroTik publishes one line per channel.

## Consequences

- The Android and SteamOS history grows with each refresh of the snapshot and with the live feed; the Android page reaches back to 2009, so the live timeline will be long. The home page still lists the newest five per family.
- Supersedes the window part of ADR 0006 (the Bounds paragraph of the Android section, the snapshot sentence that follows it, and the SteamOS bounds). The rest of ADR 0006 stands.
- The dial's 52-week widening is removed. A wider dial would be a new decision.
- The fetch volume, the allowlist and the cache are unchanged.
