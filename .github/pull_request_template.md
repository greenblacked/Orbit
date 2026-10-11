## What

<!-- What this pull request changes, in a sentence or two. -->

## Why

<!-- The problem it solves or the reason for the change. -->

## Verification

- [ ] `python -m pytest -m "not browser"` passes
- [ ] `node --test 'tests/*.test.mjs'` passes when the Worker, a source or a sigil changed
- [ ] For a change to `src/`: `bash scripts/preview.sh` finishes with no error, and I looked at every screenshot (phone, tablet, desktop; day, night and console themes). Screenshots or the preview bundle are attached or linked.
- [ ] No secrets, tokens or personal data in the diff, the screenshots or this description
- [ ] No results for pre-release (beta or release-candidate) builds
- [ ] No inline script or style, and the Content-Security-Policy is unchanged
- [ ] Documentation is updated when behaviour changed
