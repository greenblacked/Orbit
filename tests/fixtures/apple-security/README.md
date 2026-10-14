# Apple security fixtures

Raw slices of two Apple Support pages, recorded by the read-only Source probe run on pull request
\#23 (`scripts/probe_sources.json`, `docs/source-probe.md`). Each file is copied byte for byte from
the probe's `raw slices` block: nothing was edited, added or invented. The probe keeps slices of
the page, not the page, so each fixture is a partial document. The adapter is
`deploy/security/apple.js` and its tests are `tests/apple-security.test.mjs` ([ADR 0008](../../../docs/adr/0008-security-notes-are-a-separate-payload.md)).

Vendor content in these files is data only. The adapter keeps ids, titles, dates and URLs from it
and never an impact or description text.

## releases-index-slice.html

- Source id `apple-security-releases-index`, URL `https://support.apple.com/en-us/100100`
  (final URL the same), status 200, `text/html;charset=utf-8`, 319,648 bytes, SHA-256
  `ea0c1b7c1d707064141a5bd3d44346cc55a131d0fa962c1ba496d4f1506209ee`.
- The slice starts at the first `<table` (offset 147,001) and is 30,000 characters long. It holds
  the header row, 57 complete data rows (the newest dated 28 Sep 2026, the oldest 08 Apr 2026) and
  one row cut in its "Available for" cell (`iOS 18.7.7 and iPadOS 18.7.7`), which has no
  `</tr>`. The rest of the table, older rows and everything after it are not in the fixture.
- Of the 57 complete rows, 50 name an OS the site tracks, 10 of them with the text "This update has
  no published CVE entries." and no link. The other 7 are Safari, Xcode and a Beats firmware row.
- SHA-256 of the fixture: `7aa2886c6561c2aa93769e216ce2052e2b3269fb03e92b4f24bfd01ec45f2598`,
  30,000 bytes (the probe's own trailing newline is not part of the slice).

## note-149226-slice-1.html and note-149226-slice-2.html

- Source id `apple-security-note-ios-26-7-1`, URL `https://support.apple.com/en-us/149226`
  (final URL the same), status 200, `text/html;charset=utf-8`, 156,715 bytes, SHA-256
  `e043b2ad5ae0459e5ef8d665875caa3109272e3a8f017a213c3c4abd52702f47`. Its title is "About the
  security content of iOS 26.7.1 and iPadOS 26.7.1".
- Slice 1 starts at the first `<h1` (offset 142,037), is 14,665 characters long and runs to the end
  of the document. It holds the `h1`, the section `h2`, the "Released September 28, 2026" note,
  the one entry (CoreGraphics, CVE-2026-86950) and the Published Date block. Its SHA-256 is
  `268b855cea45069a0ea32af8d5b3610686367ba813c49b75127d51fea4b837b3`.
- Slice 2 starts at the text `Published Date` (offset 146,524) and is 3,000 characters long. It
  ends inside the feedback form's markup. Its SHA-256 is
  `60bae973a0b48c5c49be08f6a9b3887607168c39ec06710e227096ae2a620ae6`.
- The Published Date block has a malformed attribute, `dateTime=September 28, 2026itemprop=...`,
  so the adapter reads the text of the `time` element, not the attribute.

## What the probe did not show

- Only one note page was recorded. A page with several entries, several product sections or
  more than one CVE per entry is not covered, and the CVE reader (an id before the first colon of a
  paragraph, several ids allowed) is written from this one page and from Apple's usual
  "CVE-ID: credit" form.
- No row of the index other than the 57 complete ones was seen, and no page for macOS, watchOS,
  tvOS or visionOS.
- Apple's terms of use for automated reads of these pages were not checked (the owner accepted them on 2026-10-14; see ADR 0008). The snapshot script
  asks for each page once per run, one request a second, with the site's User-Agent.
