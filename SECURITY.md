# Security policy

## Supported versions

Release Orbit is a website, not a library. Only the version served at <https://orbit.szolotov.com> (the latest `vX.Y.Z` tag) is supported. A fix ships as a new patch release.

## Reporting a vulnerability

Report privately with GitHub private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Please do not open a public issue, pull request or discussion for a vulnerability.

Include what you found, where, the steps to reproduce it and the impact you expect. You will get an acknowledgement, and the report stays private until a fix is released.

## Scope

In scope:

- The site and the `/api/*` endpoints served from the production host.
- The Worker, the build scripts and the GitHub Actions workflows in this repository, including anything that could leak a secret, run untrusted code with privileges, or let a pull request change what production serves.
- The Content-Security-Policy and the other response headers in `src/_headers`.
- The rule that results for pre-release builds are never published.

Out of scope:

- The vendors' own sites and feeds, and the software they release.
- Findings that need a modified browser, a compromised device or physical access.
- Missing HSTS on this host, which is set in the Cloudflare zone by design, and automated scanner output with no demonstrated impact.
- Denial of service by volume.

## What not to do

- Do not access, change or delete data that is not yours, and do not test against other people's accounts.
- Do not run load or automated scanning against the production or Preview hosts.
- Do not publish details before a fix is released.
- Do not put secrets, tokens or personal data in a report. Describe where they are instead.
