# Contributing

This is a small static site. Changes arrive as pull requests, and the checks that gate them are the same ones you can run locally.

## Naming a branch

Every working branch is named `<type>/<kebab>`: a type of `feat`, `fix`, `chore`, `docs`, `ci` or `test`, a slash, then lower-case letters and digits in hyphen-separated words (a `.<digits>` segment is allowed for versions), for example `feat/contact-form` or `fix/footer-link`. The `branch-name` job in `ci.yml` rejects a pull request from any other name, and prints the rule, so a rename costs one command:

```bash
git branch -m feat/contact-form
git push --set-upstream origin feat/contact-form   # then reopen the pull request
```

A branch whose prefix names a tool (`claude/`, `codex/`, `copilot/`, `ai/`, `bot/`) is refused with its own message: branch names are published and carry no tooling attribution.

Exempt, because they are not working branches: the long-lived branches `main` and `dev`, and the bot namespace `dependabot/`. The promotion pull request, whose head is `dev`, therefore passes. `scripts/check_branch_name.py` is the whole rule; run it yourself with `python scripts/check_branch_name.py feat/my-change`.

## From change to production

1. Branch from `dev`: `git switch -c feat/my-change dev`.
2. Make the change and run the checks below.
3. Open a pull request into `dev`, one change per pull request, and fill in the template. `ci` and `security` must be green and every review thread answered.
4. When a batch is ready, the owner promotes `dev` to `main` with a pull request and a merge commit, never a squash. The push to `main` uploads a Preview at `https://stage.orbit.szolotov.com`, behind Cloudflare Access and for the owner only. There is no `stage` branch.
5. The owner releases from `main` with the **Cut release** workflow. Nothing else deploys production. Only the owner merges.

## Checks

```bash
python scripts/build_site.py --version local
python scripts/check_site.py dist/site             # internal links and the size budget
python -m pytest -m "not browser"                  # build, pipeline and bundle tests
node --test 'tests/*.test.mjs'                     # parser, registry, Worker and sigil tests (Node 22)
bash scripts/preview.sh                            # build, serve, smoke, screenshots, bundle
ruff check . && ruff format --check .              # when ruff is installed
```

The browser tests need Playwright and a Chromium: `python -m pip install --require-hashes -r .github/requirements/site-browser.txt`, then `--executable PATH`, `--channel chrome` or `PLAYWRIGHT_BROWSERS_PATH`.

## The preview loop

`bash scripts/preview.sh` is the one to run for any change a visitor can see. Look at every screenshot in `dist/preview/screenshots/` (phone, tablet, desktop; day, night and the console theme) for overflow, clipped text, small controls and unreadable contrast, fix what you find and run it again. Share the screenshots and `dist/preview/index.html` with whoever reviews the pull request, and say in its description what they show. The README describes what the script writes, and [AGENTS.md](AGENTS.md) lists the rules for the site's security policy and size budgets.

## Commits

- One logical change per commit, so each can be reviewed and reverted alone.
- Write the subject in the imperative, under about 70 characters, in the Conventional Commits style: `feat: add a filter to the timeline`, `fix: keep the footer inside the viewport`, with a type of `feat`, `fix`, `docs`, `test`, `ci`, `chore`, `refactor`, `perf`, `build` or `release`. Put the reason in the body when it is not obvious.
- A change to the pipeline (`.github/workflows/`, `deploy/`, `scripts/check_*.py`) is its own commit and its own pull request.
- Sign-off (the Developer Certificate of Origin) is not required. By contributing you agree that your work is released under the [MIT licence](LICENSE).
- Commits carry your name and nobody else's: no tool attribution, no generated-by footers.

## Other things to know

- Never commit a secret, a token or personal data, and never add a result for a beta or release-candidate build ([results/README.md](results/README.md) says why).
- Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes.
- Be kind: the [Code of Conduct](CODE_OF_CONDUCT.md) applies everywhere the project is discussed.
- The design and the reasons behind it are in [docs/architecture.md](docs/architecture.md) and the [decision records](docs/adr/0001-no-framework-or-bundler.md).
