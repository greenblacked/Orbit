# One-time setup

Do this once, before the first tag, or the `cloudflare` job fails after the GitHub Release has already been created. Re-running the Release workflow retries the deploy; the release job is safe to repeat.

## What the pipeline does

One Cloudflare Worker, `orbit`, serves everything. There is no separate deploy branch, no `stage` branch and no second Worker. The branches are `dev` and `main`.

| Where | What | Deployed by |
| --- | --- | --- |
| Pull request | Builds the site and runs `wrangler deploy --dry-run`. No credential is involved. | `deploy.yml`, job `dry-run` |
| `https://stage.orbit.szolotov.com` | A Preview of the Worker named `stage`, uploaded on every push to `main` (merging the `dev` pull request counts), served behind Cloudflare Access. It never touches production. | `deploy.yml`, job `preview`, GitHub environment `staging` |
| `https://orbit.szolotov.com` | Production. Only a release deploys it: **Cut release** on `main` creates the annotated tag `vX.Y.Z` and dispatches **Release** on it, which deploys, verifies through `workers.dev` and rolls back on failure. | `cut-release.yml`, then `release.yml`, GitHub environment `production` |

## Cloudflare

1. **The Worker.** Nothing to create by hand: the first release (or the first push to `main`) creates the Worker named in `deploy/wrangler.json`. Cut the first release before relying on `stage.orbit.szolotov.com`: a Worker made by `wrangler preview` alone has `workers.dev` on and no custom domain, so the Preview host does not answer until a release has attached `orbit.szolotov.com` (step 5).
2. **The API token.** Open **My Profile, API Tokens, Create Token** (or **Manage Account, Account API Tokens**). Start from the **Edit Cloudflare Workers** template. Scope **Account resources** to the one account and **Zone resources** to the active zone of `orbit.szolotov.com`. The token needs **Account / Workers Scripts / Edit**, and on the zone **Zone / Zone / Read**, **Zone / DNS / Edit** and **Zone / Workers Routes / Edit**: `wrangler deploy` creates the custom domain with its DNS record and certificate. Keep **Account / Workers Tail / Read**, **Account / Account Settings / Read** and the user membership read the template includes; `wrangler deploy` and `wrangler rollback` call them. The template's Workers KV and R2 permissions are unused here and can be removed if the form allows. Validate the grants with a real deploy rather than narrowing them from documentation alone. Do not use the account's Global API Key, and set an expiry you will actually rotate.
3. **The account ID.** Copy it from the Workers overview, or from the URL when the account is open. It is not a secret, and it still should not be committed.
4. **Bot Fight Mode, and why the smoke test uses `workers.dev`.** Leave Bot Fight Mode on. It answers a GitHub runner's request for `orbit.szolotov.com` with HTTP 403, Cloudflare documents that no WAF rule can skip it, and the one exception, an IP Access rule that matches first, would mean allow-listing GitHub's address ranges, which are shared with anyone who runs code there. A Worker is zoneless and its `workers.dev` host sits outside the zone, so the release is verified there: `version.txt` equals the tag, the front page carries it, the icon is served, a missing path answers 404 and `/api/health` answers JSON with `ok` true. Then `wrangler deployments status` must show the new version serving 100 percent of traffic, and because one deployment is active on every address of a Worker, the custom domain serves the version that passed. One request to `orbit.szolotov.com` is made for the log only and can never fail the job. So keep `workers_dev` set to `true` in `deploy/wrangler.json`: turning it off removes the address the release is verified on, and the release fails when Wrangler reports none.
5. **The custom domain, for Production and Preview.** After the first deploy, open **Workers & Pages, `orbit`, Settings, Domains & Routes** and check that `orbit.szolotov.com` is enabled for **Production and Preview**; `deploy/wrangler.json` sets `previews_enabled`, so the first release applies it. Until it is, `stage.orbit.szolotov.com` does not answer and the `preview` job fails with an error that says so. Delete any `stage` DNS record created by hand: Cloudflare serves a Preview named `stage` from the domain's Preview wildcard, and a record of the same name would shadow it.
6. **Cloudflare Access on `stage.orbit.szolotov.com`.** The stage Preview is for the owner, not the public, and the job that uploads it fetches nothing from it, so Access does not break the pipeline. In **Zero Trust, Access, Applications** add a **Self-hosted** application with the destination `stage.orbit.szolotov.com` and a policy that allows only the owner's identities (an email list or your identity provider). Test it in a private window: you should get the Access login, not the site. Do not put a policy on production's `workers.dev` address, which the release smoke test fetches without credentials. If the Worker's **Domains & Routes** page offers Access for Preview URLs separately, turn that on as well, so the `workers.dev` Preview address is not an open back door; after any Access change, check that a release still reaches the production `workers.dev` address.

## GitHub

1. **Settings, Environments**: create `production` and `staging`.
2. `production`: deployment branch policy **Selected tags**, pattern `v*`. Add the secret `CLOUDFLARE_API_TOKEN` and the variable `CLOUDFLARE_ACCOUNT_ID`. Do not also store the token as a repository Actions secret: a pull request from this repository can read a repository secret by editing a workflow, and an environment whose tags are only `v*` does not hand the token to a branch.
3. `staging`: deployment branch policy **Selected branches**, `main` only. Add the same secret and the same account-id variable.
4. Optional on either environment: the variable `DEPLOY_URL`, an `https` origin with no path, shown as the environment's link. It is never fetched, because a host in the zone answers a runner with Bot Fight Mode's 403. Optional on `production`: required reviewers, if you want a person to approve each tag deploy.
5. Branches: create `dev` from `main`. There is no `stage` branch. CI and Security run on pull requests and on pushes to `main` and `dev`.
6. **Settings, Rules, Rulesets**: a branch ruleset on `main` and one on `dev`, each requiring a pull request and the status checks `ci` and `security`, and blocking force pushes and deletion. Require the two aggregate checks, not the jobs behind them. Anyone who can push to `main` gets a job that holds the Cloudflare token, and with one Worker that token can also deploy production, so the ruleset on `main` is the control that keeps the two apart; the `staging` environment admitting only `main` is the second. This is an accepted trade-off of the single-Worker layout. The ruleset on `dev` is mandatory, not optional: Dependabot targets `dev` and `dependabot-auto-merge.yml` runs `gh pr merge --auto --squash` on its patch and minor updates; auto-merge is bounded only by the required checks on the target branch, so without this ruleset a bump can reach `dev` before `ci` and `security` have passed.
7. **Settings, General, Pull Requests**: enable **Allow auto-merge**, so Dependabot patch and minor updates merge on their own once `ci` and `security` pass. Dependabot targets `dev` (`.github/dependabot.yml`), so its updates travel the same road as everything else (into `dev`, then promoted to `main`), which is why the `dev` ruleset in step 6 is required. `dependabot-auto-merge.yml` acts only on a pull request into `dev`: GitHub raises Dependabot security updates against `main` whatever `target-branch` says, and those wait for a person. The job runs on `pull_request` and uses no third-party action, so a Dependabot pull request cannot change what it runs; it enables auto-merge only when every commit on the pull request is Dependabot's and GitHub-verified and every update in its metadata is a minor or patch bump, turns auto-merge off again if a later push makes the pull request ineligible (GitHub would otherwise keep it on), and checks out nothing. Each promotion leaves a merge commit on `main` that `dev` does not have, so a commit-ancestry check would always fail; compare content instead. When a change lands on `main` that `dev` lacks (a hotfix, say), bring `main` back into `dev` (a merge commit, through a pull request) before the next promotion; `git diff --quiet origin/dev...origin/main` exits 0 when `main` holds nothing but merge commits of `dev`, and 1 when something is missing.
8. **Settings, Rules, Rulesets**: a tag ruleset targeting `refs/tags/v*` (Targets: tags, pattern `v*`) that restricts updates and deletion, and does **not** restrict creation. Without it anyone with write access can point production at an old commit by moving a released tag, or delete a released tag and re-create it elsewhere. Creation stays open on purpose: **Cut release** creates the tag through the API with `GITHUB_TOKEN`, and the built-in `github-actions` identity is reported not to be selectable as a ruleset bypass actor (only roles, teams, deploy keys and installed Apps are), so a ruleset restricting creation would make every release fail when the tag POST is refused. The trade-off: a person with write access can still push a new `vX.Y.Z` tag. That tag deploys production only if its commit is an ancestor of `main` (checked in `release.yml`) and the `production` environment admits it, so the damage is bounded to deploying a commit already on `main`; add required reviewers on `production` (step 4) if you want a person to approve each one. If you need creation locked too, create the tag with a dedicated GitHub App token (for example `actions/create-github-app-token`) and add that App to the ruleset's bypass list; that is a change to `cut-release.yml`, not a setting. Check it in two parts. First, as a non-admin, push a tag at an existing release and expect it to be rejected (`git push --force origin <existing-tag>`), and try deleting one. Second, run **Cut release** once with the ruleset active and confirm the tag is created and `release.yml` starts on it. The second part is not optional: no offline check can tell you the token is allowed to create the ref.
9. Code scanning: the `codeql` job in `security.yml` needs GitHub code scanning. On a private repository without Advanced Security, remove that job and its entries in the `security` job's `needs` and in its `check_job_results.py` arguments.
10. Branch names: working branches are `<type>/<kebab>` with a type of `feat`, `fix`, `chore`, `docs`, `ci` or `test`, and a tool-named prefix such as `claude/` is refused. The `branch-name` job needs no setting; `ci` already requires it.

## Promoting: dev, then main

Working branches (`<type>/<kebab>`) merge into `dev`. Promotion is one pull request with a merge commit, never a squash, so each change stays reviewable and revertable on its own.

```bash
# Make sure dev contains the content of main; if it does not, merge main into dev first.
# Promotion merge commits exist only on main, so compare content, not ancestry.
git fetch origin
git diff --quiet origin/dev...origin/main && echo "dev is up to date with main"

gh pr create --base main --head dev --title "promote: dev to main" --body "What this batch changes."
gh pr merge --merge        # after ci and security are green
```

The merge pushes to `main`, and `deploy.yml` uploads the stage Preview at `https://stage.orbit.szolotov.com`: look at it behind Access before cutting a release.

A promotion pull request passes the `branch-name` check because its head is `dev`.

## Releasing

On `main`, run the **Cut release** workflow with `X.Y.Z`. It checks that the version is greater than every existing tag and that the run is at the tip of `main`, creates the annotated tag `vX.Y.Z` through the API, and dispatches **Release** on it (a tag made with `GITHUB_TOKEN` starts no workflow by itself). Release refuses anything that is not a `vX.Y.Z` tag ref and a tagged commit that is not an ancestor of `main`, creates the GitHub Release with generated notes, deploys the production Worker, smoke-tests `workers.dev`, checks the new version serves 100 percent of traffic, and rolls back to the version that was serving if any of that fails. Just before it deploys it lists the release tags and refuses, without deploying, when a greater `vX.Y.Z` tag exists, so an older release that loses the race against a newer one stops instead of overwriting it (re-run the newer release if it never deployed). Production is deployed by nothing else.

## Lockfile

`deploy/package-lock.json` pins Wrangler and every package under it with a sha512 integrity. If you ever need to regenerate it, run `npm install --package-lock-only --ignore-scripts` in `deploy/`, and make `WRANGLER_VERSION` in `deploy.yml` and `release.yml`, `deploy/package.json` and the lockfile agree; `tests/test_pipeline.py` compares every workflow's pin with the lockfile in `ci`'s build job, so a disagreement fails the required `ci` check. The `dry-run deploy` job in `deploy.yml` also runs `scripts/check_wrangler_pin.py`, but that job is not part of `ci` or `security` and is advisory unless you add it to a ruleset.

## Rollback

Automatic: the `cloudflare` job records the version production is serving before it deploys, and runs `wrangler rollback <that version>` when a later step fails. The first release has nothing to return to; if its smoke test fails, fix forward or roll back in the dashboard. Re-running an older release does not roll production back, because the order guard refuses it; roll back by cutting a new patch release with the change reverted (preferred), or with the commands below or Cloudflare's Worker deployments rollback.

By hand, from `deploy/` after `npm ci --ignore-scripts`, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set:

```bash
./node_modules/.bin/wrangler deployments list --config wrangler.json
./node_modules/.bin/wrangler rollback <version-id> --config wrangler.json --yes
```

Or use **Workers & Pages, `orbit`, Deployments** in the dashboard.
