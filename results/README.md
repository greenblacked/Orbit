# Validation results

One JSON file per tested build, at `results/<vendor>/<family>/<build>.json`, for example
`results/apple/iOS/24B91.json`. The build copies them into the site as
`/data/results/<vendor>/<family>/<build>.json`.

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
| `vendor`, `family`, `build` | Must equal the directory names and the file name (without `.json`). A build is letters, digits, `.`, `_` and `-`. |
| `version` | The release version, a non-empty string. |
| `stage` | `release`. |
| `status` | `pass`, `warn`, `fail` or `untested`. |
| `checks` | A list of `{ name, status, detail? }`; `status` as above, `detail` an optional string. No other keys. |
| `testedAt` | UTC, `YYYY-MM-DDTHH:MM:SSZ`. |
| `runner` | Who or what ran the checks, a non-empty string. |

No other keys are allowed, and no other files than this README and the result files.

```bash
python scripts/check_results.py            # results/ against src/data/releases.json
```
