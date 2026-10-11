# 0005: Public results only for released builds

## Context

The site pairs each release with the outcome of testing it. Testing a pre-release build produces findings about software that is not yet public, and pre-release software is often shared under terms that keep it private. A repository that is public must not become a channel for them.

## Decision

Only results for builds with stage `release` are committed or published. `scripts/check_results.py` refuses a result whose stage is `beta` or `rc`, and refuses a build that the releases snapshot lists only as a beta or release candidate, whatever the file says. A build shared by a release candidate and the final release is accepted once it is listed as a release. CI and the site build both run the check, and the site copies only validated files. The dial reads an optional `status` on a release and shows anything else as untested, so a pre-release never displays a result.

## Consequences

- A pre-release result cannot reach the repository, its history or the site through an ordinary change.
- Results appear only after a build ships, so the validation layer lags the beta cycle by design.
- The rule is enforced by code and tests, not by reviewer attention.
