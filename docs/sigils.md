# Build sigils

A build sigil is a deterministic glyph drawn from a build string. Same build, same sigil. The colour is the only part not derived from the string: on the site it is the accent of the platform family whose card, dial or section shows the glyph, so a build that two families share (iOS and iPadOS can ship the same build) is drawn once in each family's accent. Anywhere one glyph stands for several families at once, the page ink is the colour to use. The reference implementation is [`src/assets/sigil.js`](../src/assets/sigil.js); `tests/sigil.test.mjs` pins its geometry to the examples below and `tests/test_sigil_doc.py` holds its constants to the table in this page.

## Grammar

An Apple build is `LEAD TRAIN NUM [SUFFIX]`, matching `^(\d+)([A-Z])(\d+)([a-z]?)$`. For example `24B5099f` is LEAD 24, TRAIN B, NUM 5099, SUFFIX f. Release builds such as `23G90` have no suffix; betas carry a lowercase one. Anything that does not match (`BP2A.250605.031`, `26100.4351`, `24.04.3`) is a generic build, see [Generic builds](#generic-builds).

## Geometry

The unit radius is R = 1. The viewBox runs from -1.05 to 1.05 on both axes, so the rendered size is 2.1 R px (R = size / 2.1 px per unit). Angles are degrees clockwise from 12 o'clock. 12 o'clock is absolute north: a sigil container must never be rotated, or the rotation is counted twice. Use unrounded floating-point degrees before the trigonometry; `polar(a, r) = (r sin a, -r cos a)`.

## The Apple rule, full form (size 40 px and up)

Let `t = TRAIN - 'A'` (0 to 25).

1. Rings: `rings = 1 + (LEAD mod 5)`, concentric at `r_j = 0.18 + 0.52 * j / rings` for `j = 1..rings`. The outermost is always r = 0.70 and heavier. Stroke widths: 0.014 for the rings, 0.026 for the outer ring.
2. Rotation: `rotation = t * 360 / 26`.
3. Spokes: 11 of them, at angle `rotation + k * 360 / 11` (k = 0 to 10), starting at r = 0.70. Spoke k has length `0.05 + 0.25 * digit[(k + t) mod len(NUM)] / 9`: a 0 digit is a 0.05 stub, a 9 reaches r = 1.0. Because the lookup is offset by t, the train letter changes the shape as well as the angle: builds that differ only in the train letter are not rotations of each other. Stroke width 0.02. Spoke 0 is the index spoke: width 0.04, capped with a dot of radius 0.035.
4. Dots: `dots = SUFFIX ? min(6, ord(SUFFIX) - 96) : 0`, placed evenly on r = 0.10 starting at the rotation angle, each of radius 0.032.
5. Minimum stroke: every stroke width is `max(unit width * scale, 1 px)` and every dot radius is `max(unit radius * scale, 1 px)`.
6. The r = 1.0 guide circle is optional decoration, not part of the rule: `sigil.js` draws it only with `{guide: true}`, at 22% opacity and 0.8 px wide, and never below 40 px.
7. Colour: the accent of the family whose view shows the glyph (the page ink where one glyph stands for several families). It carries no information about the build.

## Micro form (below 40 px)

Same rotation, spoke angles and digit lookup, everything quantised. Sizes are in px.

- Outer ring only, r = 0.70 R, 1.5 px. The inner rings are dropped.
- 11 spokes from r = 0.70 R, 1 px wide. For the digit `d = digit[(k + t) mod len(NUM)]`, the length is 0.10 R for d of 0 to 2, 0.20 R for 3 to 6 and 0.30 R for 7 to 9.
- The index spoke (k = 0) is 2 px wide with a cap dot of radius 1.5 px.
- Any suffix is shown as one centre dot of radius 2 px; the dot count is not shown.
- The build string always sits next to the sigil at this size.

## Pseudo-code

```text
parse build -> lead, train, num, suffix
t     = train - 'A'
rot   = t * 360 / 26
rings = 1 + lead % 5
digit(k) = num[(k + t) % len(num)]
full:  for j in 1..rings: circle(r = 0.18 + 0.52*j/rings, w = j == rings ? 0.026 : 0.014)
       for k in 0..10: a = rot + k*360/11; L = 0.05 + 0.25*digit(k)/9
           line(polar(a, 0.70), polar(a, 0.70 + L), w = k == 0 ? 0.04 : 0.02); if k == 0: dot(tip, 0.035)
       n = suffix ? min(6, ord(suffix) - 96) : 0
       for i in 0..n-1: dot(polar(rot + i*360/n, 0.10), 0.032)
micro: circle(0.70, 1.5px); spokes quantised to 0.10/0.20/0.30, 1px (index 2px + 1.5px dot); suffix -> dot(0, 2px)
all strokes and dots clamped to >= 1 px
```

## Generic builds

A build string that is not an Apple build (an Android `BP2A.250605.031`, a Windows `26100.4351`, an Ubuntu `24.04.3`) is hashed into the same parameters the Apple rule reads from its grammar, and then drawn by the same geometry. The hash is integer arithmetic only, so every engine draws the same glyph.

1. Normalise: upper-case the string and keep only `A-Z` and `0-9`. If nothing is left, use `0`.
2. Checksum: start with `a = 1, b = 0`; for each character code `c`, `a = (a + c) mod 251` and then `b = (b + a) mod 251`.
3. Parameters: `rings = 1 + a mod 5`, `t = b mod 26`, `dots = a mod 7` (0 to 6).
4. Digits: seed `x = a * 251 + b`; eight times, `x = (x * 75 + 74) mod 65537` and take `x mod 10`. The eight digits play the part of NUM, so `len(NUM) = 8`.
5. From there on the rule is the Apple rule: rotation, spokes, dots, the micro form and the minimum stroke are unchanged.

Pinned values, checked by `tests/sigil.test.mjs`:

| Build | rings | t | dots | digits |
| --- | --- | --- | --- | --- |
| `BP2A.250605.031` | 5 | 15 | 4 | 2, 8, 3, 5, 1, 6, 0, 4 |
| `26100.4351` | 5 | 19 | 1 | 3, 7, 6, 3, 4, 6, 3, 1 |
| `24.04.3` | 4 | 9 | 3 | 4, 9, 7, 8, 0, 1, 7, 8 |

## Known collisions

- A suffix of g or later clamps to 6 dots, so `...f`, `...g` and `...h` look the same.
- LEAD mod 5 repeats every 5 years, so `19H422` has the same shape as `24H422`.
- The micro form shows only whether a suffix exists, not how many dots.
- iOS and iPadOS ship the same build string for the same release, so their sigils are identical by design.
- The generic rule is a checksum, not a cryptographic hash: two different strings can draw the same glyph.

## Constants

Every number the drawing uses, as `SPEC` in `sigil.js`.

| Name | Value |
| --- | --- |
| `viewBox` | 1.05 |
| `ringMod` | 5 |
| `ringBase` | 0.18 |
| `ringSpan` | 0.52 |
| `ringWidth` | 0.014 |
| `outerWidth` | 0.026 |
| `trains` | 26 |
| `spokes` | 11 |
| `spokeStart` | 0.7 |
| `spokeMin` | 0.05 |
| `spokeSpan` | 0.25 |
| `spokeWidth` | 0.02 |
| `indexWidth` | 0.04 |
| `indexCap` | 0.035 |
| `dotRing` | 0.1 |
| `dotSize` | 0.032 |
| `maxDots` | 6 |
| `minStroke` | 1 |
| `microBelow` | 40 |
| `microRing` | 1.5 |
| `microSpoke` | 1 |
| `microIndex` | 2 |
| `microCap` | 1.5 |
| `microDot` | 2 |
| `microLen` | [0.1, 0.2, 0.3] |
| `microCuts` | [2, 6] |
| `guideWidth` | 0.8 |
| `guideOpacity` | 0.22 |
| `hashMod` | 251 |
| `lcgMul` | 75 |
| `lcgAdd` | 74 |
| `lcgMod` | 65537 |
| `genericDigits` | 8 |

## Family accents

Marks and anything on black use the base accents (at least 3.85:1 on `#f4f1ea`, at least 4.78:1 on `#000`). Text set on paper uses the darker text accents (at least 4.6:1 on `#f4f1ea`). The values live in `src/data/families.json`.

| Family | Mark, and on black | Text on paper |
| --- | --- | --- |
| iOS | `#d7452f` | `#c53b26` |
| iPadOS | `#a36f14` | `#926312` |
| macOS | `#288b35` | `#247c2f` |
| watchOS | `#158591` | `#137883` |
| tvOS | `#7869d9` | `#6a5ad5` |
| visionOS | `#cc3fa1` | `#bd3293` |

Ink on paper is `#161512` on `#f4f1ea`. Build strings and numbers are set in a monospaced face.

## Worked examples

Real builds from the releases snapshot. Lengths are in units of R, for spokes 0 to 10.

### 24B5099f (iOS and iPadOS 27.2 beta 3)

- LEAD 24 gives rings = 1 + 24 mod 5 = 5.
- Train B gives t = 1 and rotation = 1 x 360 / 26 = 13.85 degrees.
- NUM 5099 gives digits [5, 0, 9, 9]; spoke k reads digit[(k + 1) mod 4].
- Lengths: 0.050 0.300 0.300 0.189 0.050 0.300 0.300 0.189 0.050 0.300 0.300
- Micro-form lengths: 0.10 0.30 0.30 0.20 0.10 0.30 0.30 0.20 0.10 0.30 0.30
- Suffix f gives 6 dots.

### 26B5101f (macOS 27.2 beta 3)

- LEAD 26 gives rings = 1 + 26 mod 5 = 2.
- Train B gives t = 1 and rotation = 13.85 degrees.
- NUM 5101 gives digits [5, 1, 0, 1]; spoke k reads digit[(k + 1) mod 4].
- Lengths: 0.078 0.050 0.078 0.189 0.078 0.050 0.078 0.189 0.078 0.050 0.078
- Micro-form lengths: 0.10 0.10 0.10 0.20 0.10 0.10 0.10 0.20 0.10 0.10 0.10
- Suffix f gives 6 dots.

### 24K5103f (tvOS 27.2 beta 3)

- LEAD 24 gives rings = 5.
- Train K gives t = 10 and rotation = 10 x 360 / 26 = 138.46 degrees.
- NUM 5103 gives digits [5, 1, 0, 3]; spoke k reads digit[(k + 10) mod 4].
- Lengths: 0.050 0.133 0.189 0.078 0.050 0.133 0.189 0.078 0.050 0.133 0.189
- Micro-form lengths: 0.10 0.20 0.20 0.10 0.10 0.20 0.20 0.10 0.10 0.20 0.20
- Suffix f gives 6 dots.

### 24N5103f (visionOS 27.2 beta 3)

Same digits and suffix as 24K5103f, different shape.

- LEAD 24 gives rings = 5.
- Train N gives t = 13 and rotation = 13 x 360 / 26 = 180.00 degrees.
- NUM 5103 gives digits [5, 1, 0, 3]; spoke k reads digit[(k + 13) mod 4].
- Lengths: 0.078 0.050 0.133 0.189 0.078 0.050 0.133 0.189 0.078 0.050 0.133
- Micro-form lengths: 0.10 0.10 0.20 0.20 0.10 0.10 0.20 0.20 0.10 0.10 0.20
- Suffix f gives 6 dots.

### 23G90 (iOS and iPadOS 26.6.2)

- LEAD 23 gives rings = 1 + 23 mod 5 = 4.
- Train G gives t = 6 and rotation = 6 x 360 / 26 = 83.08 degrees.
- NUM 90 gives digits [9, 0]; spoke k reads digit[(k + 6) mod 2].
- Lengths: 0.300 0.050 0.300 0.050 0.300 0.050 0.300 0.050 0.300 0.050 0.300
- Micro-form lengths: 0.30 0.10 0.30 0.10 0.30 0.10 0.30 0.10 0.30 0.10 0.30
- No suffix, so 0 dots.

### 19H422 (iOS and iPadOS 15.8.8)

- LEAD 19 gives rings = 1 + 19 mod 5 = 5.
- Train H gives t = 7 and rotation = 7 x 360 / 26 = 96.92 degrees.
- NUM 422 gives digits [4, 2, 2]; spoke k reads digit[(k + 7) mod 3].
- Lengths: 0.106 0.106 0.161 0.106 0.106 0.161 0.106 0.106 0.161 0.106 0.106
- Micro-form lengths: 0.10 0.10 0.20 0.10 0.10 0.20 0.10 0.10 0.20 0.10 0.10
- No suffix, so 0 dots.
