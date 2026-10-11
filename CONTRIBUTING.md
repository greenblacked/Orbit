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
3. Open a pull request into `dev`. `ci` and `security` must be green.
4. When a batch is ready, promote `dev` to `main` with a pull request (merge commit). The push to `main` uploads a Preview at `https://stage.orbit.szolotov.com`, behind Cloudflare Access. There is no `stage` branch.
5. Release from `main` with the **Cut release** workflow. Nothing else deploys production.

## Checks

```bash
python scripts/build_site.py --version local
python scripts/check_site.py dist/site             # internal links and the size budget
python -m pytest -m "not browser"                  # build, pipeline and bundle tests
bash scripts/preview.sh                            # build, serve, smoke, screenshots, bundle
```

`bash scripts/preview.sh` is the one to run for any change a visitor can see: look at every screenshot (phone, tablet, desktop; day, night and the console theme) before you open the pull request, and share `dist/preview/index.html` with whoever reviews it. The README describes what it writes.

Commits carry your name and nobody else's: no tool attribution, no generated-by footers.
