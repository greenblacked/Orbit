# 0003: Deterministic build sigils

## Context

A build string such as `24B5099f` is hard to tell apart at a glance, yet the same build appears in several places: cards, the dial, the timeline. A decorative image per build would need storage and curation, and a random one would change between visits.

## Decision

Each build gets a glyph computed from its string alone. The lead number sets the rings, the train letter the rotation and the spoke lengths, the digits the spokes and the suffix the dots. A build that does not match the Apple format is reduced by a fixed checksum into the same parameters. Colour is the platform accent and carries no information about the build. The rule is written in [docs/sigils.md](../sigils.md), with a micro form for small sizes, and the script and the document are held to the same constants by a test.

## Consequences

- The same build always draws the same sigil, with no stored assets and no network.
- The rule is a public contract: changing it changes every sigil, so a change is a deliberate, documented one.
- Different builds can in principle draw similar glyphs. The sigil is a recognition aid, never an identifier, and the build string is always shown beside it.
- Any vendor's builds get a sigil without special cases.
