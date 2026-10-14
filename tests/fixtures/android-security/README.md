# Android security bulletin fixtures

Both files are built from the raw output of the read-only source probe of 2026-10-12. Nothing in
them was written by hand except the wrapper (the doctype, the `<html lang>`, `<head>`,
`<meta charset>` and `<title>` elements, the `<body>` tag and the comment at the top) and the
closing tags.

- `aosp-2026-10.html` is the Android Security Bulletin for October 2026,
  `https://source.android.com/docs/security/bulletin/2026/2026-10-01` (200, `text/html;
  charset=utf-8`, 189,019 bytes, sha256
  `4f9e7c912fc1ac13e4860475ad32468ca2b8691a17083baa2bf828e9d6112973`).
- `pixel-2026-10.html` is the Pixel Update Bulletin for October 2026,
  `https://source.android.com/docs/security/bulletin/pixel/2026/2026-10-01` (200, `text/html;
  charset=utf-8`, 187,280 bytes, sha256
  `30cbfde2e170d173899af64bf5328262585573f9b07d978fc0102547c45d3df5`).

Each file holds, in this order:

1. The `<title>` text the probe recorded (`title:` line), in a `<title>` element.
2. The probe's raw tables, copied byte for byte and complete: six for the AOSP bulletin (two CVE
   tables of 7 and 18 rows, the Subcomponent/CVE table, Abbreviation, Prefix, Version history) and
   five for the Pixel bulletin (two CVE tables of 2 and 4 rows, Abbreviation, Prefix, Version
   history). The probe asked for up to six tables and recorded the first six (AOSP) and five (Pixel).
3. The probe's 4,000-character raw slice from the `<h1` on. It carries the date line
   (`Published October 5, 2026 | Updated October 8, 2026`; the Pixel page has `Published October
   6, 2026` only) and the patch-level sentence (`Security patch levels of 2026-10-01 or higher
   address all of these issues`, wrapped across lines; the Pixel page says `security patch levels
   of 2026-10-05 or later address all issues in this bulletin and all issues in the October 2026
   Android Security Bulletin`). The AOSP slice stops in the middle of a word. The Pixel slice ends
   in whitespace inside an unclosed `<table>` (Kernel components), which the scanner drops. That
   table is a prefix of the recorded Pixel table 1 (compared ignoring indentation), cut short by
   the slice.

The order differs from the page (the slice is last), so the tests do not depend on it: the
scanner reads the tables and the text separately.

What the probe did not record: the rest of either page, any bulletin before October 2026, and the
pre-2026 URL form `https://source.android.com/docs/security/bulletin/YYYY-MM-01`, which is read
from the links of the October 2026 page (2025-03 to 2025-12). Vendor text in these files is data
only. The terms of use for reading these pages automatically were not checked (the owner accepted them on 2026-10-14; see ADR 0008).
