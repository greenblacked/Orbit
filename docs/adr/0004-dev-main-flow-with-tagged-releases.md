# 0004: A dev and main flow with tagged releases

## Context

Changes should be reviewable and revertable one at a time, and the owner wants to look at the next release on a real host before it is public. A deploy from every merge would make production follow the branch tip, and a second Worker or a staging branch would add moving parts.

## Decision

Working branches named `<type>/<kebab>` merge into `dev`. `dev` is promoted to `main` by one pull request with a merge commit, never a squash. A push to `main` uploads a Preview of the same Worker at a separate host behind Cloudflare Access. Production changes only when the **Cut release** workflow tags `vX.Y.Z` on `main` and the **Release** workflow deploys it, smoke-tests it on `workers.dev` and rolls back if a check fails. Deploy credentials live in environment-scoped secrets: the production environment admits only `v*` tags and the staging environment only `main`.

## Consequences

- Production is always a tagged, reviewed state, and a rollback is a new patch release or a one-line `wrangler rollback`.
- The Preview shows what the next release will ship, and it never touches production.
- A single Worker means a token that can upload a Preview could also deploy production, so the branch and tag rulesets on `main` and `v*` are part of the design ([SETUP.md](../../SETUP.md)).
- There is no staging branch to keep in sync.
