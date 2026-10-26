# Frozen site data

`releases.json` and `security.json` here are exact copies of `src/data/releases.json` and
`src/data/security.json` as of the 2026-10-12 snapshot (78 releases). They are for the tests
only.

Tests that assert what the site shows for particular releases (a current version, a build
number, a filter count, the cadence view) read these files, and the browser tests are served
them in place of the production snapshot. That lets the production snapshot be refreshed
freely without touching a test.

Never refresh these files with the production snapshot. Update them only when a test
deliberately needs new data, and then fix the expectations of the tests that read them in the
same change. `security.json` is keyed to the releases in `releases.json`, so the two are
replaced together.

Tests that validate the production files themselves (their shape, size, age, and that notes
and results point at real releases) keep reading `src/data/`.
