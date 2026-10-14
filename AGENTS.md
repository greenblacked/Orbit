# AGENTS.md

The working agreement for any coding agent on this site. `CLAUDE.md` imports this file, so there is one set of rules. A human contributor follows the same ones; see also [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

A static site (plain HTML in `src/`, one stylesheet, a few small scripts) served by a Cloudflare Worker. `scripts/build_site.py` copies `src/` to `dist/site/`. Link stylesheets directly from the page: `@import` is not supported, and `check_site.py` and `bundle_preview.py` refuse it. There is no framework and no bundler, and the Python scripts use the standard library only. The README's project layout lists the files and docs/architecture.md explains how they fit; SETUP.md is the one-time Cloudflare and GitHub setup.

## Commands

```bash
python scripts/build_site.py --version local     # build dist/site
python scripts/check_site.py dist/site           # local links, fragments and the size budget
python -m pytest -m "not browser"                # build, pipeline, header and bundle tests
node --test 'tests/*.test.mjs'                   # parser, registry, Worker and device tests (Node 22)
python scripts/check_results.py                  # the validation results under results/
bash scripts/preview.sh                          # build, serve, smoke, screenshots, bundle
ruff check . && ruff format --check .            # when ruff is installed
```

The browser tests and the screenshots need Playwright (`python -m pip install --require-hashes -r .github/requirements/site-browser.txt`) and a Chromium: `--executable PATH`, `--channel chrome` or `PLAYWRIGHT_BROWSERS_PATH`.

## Branches

- Work happens on `<type>/<kebab>` branches (`feat/contact-form`): a type of `feat`, `fix`, `chore`, `docs`, `ci` or `test`, a slash, then lower-case letters, digits and hyphens. CI's `branch-name` job fails any other name, and a tool-named prefix such as `claude/` or `ai/`. Exempt: `main`, `dev` and `dependabot/*`.
- Branch from `dev` and open the pull request into `dev`. Never push to `main`.
- The flow is `dev` to `main`, by one pull request with a merge commit, never a squash. There is no `stage` branch. Only the owner merges.
- Production is released only with the **Cut release** workflow on `main`. Never create a tag or deploy by hand.

## Before opening any pull request that changes what a visitor sees

Any change to `src/` (markup, styles, scripts, images, copy) is a UI change.

1. Run `bash scripts/preview.sh`. It must finish with no error: a console error, a CSP violation, a broken link or a page over budget fails it.
2. Open every PNG in `dist/preview/screenshots/` and look: phone, tablet and desktop, in day, night and the console theme. You are looking for overflow or sideways scroll, clipped or overlapping text, controls under 44px, unreadable contrast in any theme, and a layout that differs between sizes in a way you did not intend. Fix what you find and run the loop again.
3. Share the screenshots and the bundled preview, `dist/preview/index.html`, with the owner in the chat. The bundle is one file: publish it as a private page (for example a private artifact) or attach it, and give the link. State the version and commit it shows.
4. Only then open the pull request, and say in its description what the screenshots show.

A change that touches no visible file (a workflow, a test, a script, docs) still runs `python -m pytest -m "not browser"`.

## Adding a page

Copy an existing page into `src/<name>/index.html` and change its head values. Every
directory and file name in a page's path must match `[a-z0-9][a-z0-9._-]*`: URLs are
emitted as written, so a space, `#`, `?`, `%` or a non-ASCII letter would break the
sitemap and the preview routes. The build refuses such a path and names the file.

## After a merge to `main`

The push to `main` uploads a Preview. Share <https://stage.orbit.szolotov.com> (behind Cloudflare Access) with the owner in the chat and say what to look at. It is a separate version of the same Worker, so production is untouched.

## Rules that keep the site safe

- The Content-Security-Policy in `src/_headers` allows no inline script or style. Do not add an inline `<script>`, `<style>`, `style=""` or `on...=` attribute, and do not widen the policy to make a change work without asking. `tests/test_headers.py` and the screenshot run both fail on it.
- Do not add a dependency to `scripts/`. They run on a bare Python.
- Do not edit `.github/workflows/`, `deploy/` or `scripts/check_*.py` as a side effect of a content change. A change to the pipeline is its own pull request, and the owner reads it line by line.
- Every workflow sets top-level `permissions`, every job a `timeout-minutes`, and every action is pinned to a full commit SHA with its exact tag in a comment. Nothing pipes a download into a shell. Untrusted values (branch names, titles) reach a shell only through `env:`, never `${{ }}` inside `run:`.
- `dependabot-auto-merge.yml` runs on `pull_request` and uses no third-party action: under that trigger the workflow and its `uses:` refs come from the pull request, and Dependabot edits exactly those refs, so any action in the job could be swapped for an unreviewed version that runs with the write token (a step `if:` does not stop an action's `pre` entry). It reads the update type from the metadata block in Dependabot's commit messages through the API and enables auto-merge only when every commit is Dependabot's (author login and a GitHub-verified signature) and every update is minor or patch, and it turns auto-merge back off when a later push makes the pull request ineligible. Do not switch it to `pull_request_target` (GitHub's workflow execution protection blocks that trigger on public repositories from 2026-11-02), and do not add a `uses:` line, a checkout, or an expression inside `run:`: the pull request's number and URL reach the shell only through `env:`.
- No secrets, tokens or personal data in the repository, in a screenshot or in a pull request description.
- Keep the home link, the Back and To top controls, the skip link, one `h1` per page, `alt` on every image and visible focus. `tests/test_accessibility.py` checks them.

## Commits and pull requests

- One logical change per commit, subject in the imperative under about 70 characters, with the reason in the body when it is not obvious.
- One change per pull request.
- No tool attribution anywhere published: no generated-by footers, no co-author trailers for tools, no session links, no tool names in branch names, commit messages or pull request descriptions.
- Merge only when `ci` and `security` are green and every review thread is answered.
