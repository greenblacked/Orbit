# Validation results

One JSON file per tested build, at `results/<vendor>/<family>/<build>.json`, for example
`results/apple/iOS/24B91.json`, or one per tested build and device, at
`results/<vendor>/<family>/<build>/<device-slug>.json`, for example
`results/apple/iOS/24B91/iphone-18-pro.json`. The build copies them into the site as
`/data/results/<vendor>/<family>/<build>.json` (or `.../<build>/<device-slug>.json`) and lists
them in `/data/results/index.json`.

## Only publicly released builds

Only results for publicly released builds (stage `release`) may be committed here. Results for beta and release-candidate builds are not published: pre-release software results stay private until the build is publicly released. When a build ships, add its file then.

`scripts/check_results.py` enforces this and CI runs it, as does the site build, so a result
for a beta or an RC cannot reach the repository or the site:

- `stage` must be `release`; `beta` and `rc` are refused.
- A build that the releases snapshot (`src/data/releases.json`) lists only as a beta or an RC
  is refused, whatever the file says. A build that the snapshot also lists as a release
  (a release candidate and the final release often share one build) is accepted.

## File format

```json
{
  "vendor": "apple",
  "family": "iOS",
  "build": "24B91",
  "version": "27.1",
  "stage": "release",
  "status": "pass",
  "checks": [
    { "name": "boots to the home screen", "status": "pass" },
    { "name": "restores from a backup", "status": "warn", "detail": "slow on the first run" }
  ],
  "testedAt": "2026-10-20T09:30:00Z",
  "runner": "device-lab-1"
}
```

| Field | Rule |
| --- | --- |
| `vendor`, `family`, `build` | Must equal the directory names and the file name (without `.json`); per device, the build is the build directory. A build is letters, digits, `.`, `_` and `-`. |
| `version` | The release version, a non-empty string. |
| `stage` | `release`. |
| `status` | `pass`, `warn`, `fail` or `untested`. |
| `checks` | A list of `{ name, status, detail? }`; `status` as above, `detail` an optional string. No other keys. |
| `testedAt` | UTC, `YYYY-MM-DDTHH:MM:SSZ`. |
| `runner` | Who or what ran the checks, a non-empty string. |

No other keys are allowed (a per-device file adds `device`, below), and no other files than this README and the result files.

## Results per device

A result for one device goes in `results/<vendor>/<family>/<build>/<device-slug>.json`. It has
every field above and one more:

| Field | Rule |
| --- | --- |
| `device` | The device's name exactly as listed in `src/data/devices.json` for the family and the build's major. |

- The major is the leading number of `version`: `27.1` is major 27.
- The file name is the slug of `device`: the name lower-cased, every run of characters
  outside `a-z0-9` replaced by one `-`, and leading and trailing `-` removed. `iPhone 18 Pro` is
  `iphone-18-pro` and `iPad Pro 11-inch (M5)` is `ipad-pro-11-inch-m5`.
- A per-build file (`<build>.json`) must not carry `device`.
- A build uses one layout: a `<build>.json` file and a `<build>/` directory may not both exist.
- A family or major with no list in `devices.json` takes no per-device result. This
  repository keeps device lists only for iOS 27 and iPadOS 27; a family or major without a
  list takes no per-device result, and a result stays per build.

`src/data/devices.json` is the official device list Apple publishes for each OS major:

```json
{
  "schema": 1,
  "checkedAt": "2026-10-26",
  "families": {
    "iOS": {
      "27": { "source": "https://www.apple.com/os/ios/", "default": "iPhone 18 Pro", "devices": ["iPhone 18 Pro"] }
    }
  }
}
```

`devices` keeps Apple's order and names, `default` is one of them and `source` is the Apple page
the list came from. `tests/test_devices.py` checks the file and `scripts/check_results.py` reads
it. The build writes `/data/results/index.json`, `{"schema": 1, "results": [...]}`, with one
`{vendor, family, build, device, status, path}` per result (`device` is `null` for a per-build
file) sorted by vendor, family, build and device, so a page can tell what exists without
requesting a missing file.

```bash
python scripts/check_results.py            # results/ against releases.json, families.json and devices.json
```
