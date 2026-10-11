# Release Orbit

The source of <https://orbit.szolotov.com>, a static site served by Cloudflare Workers static assets (Worker `orbit`). It was started from the shared web template, so its design and its CI and CD pipeline match every other site made from it.

## Layout

| Path | What lives there |
| --- | --- |
| `src/` | The site: `index.html`, `about/index.html`, `404.html`, the icons, `_headers`, and `assets/` (`site.css`, `theme.js`, `site.js`). Edit these. |
| `scripts/build_site.py` | Copies `src/` to `dist/site/` and stamps every page and `version.txt` with a version. Standard library only. |
| `scripts/check_branch_name.py` | The rule behind the `branch-name` CI job: `<type>/<kebab>` for working branches, with a tool-named prefix refused. |
| `scripts/check_site.py` | Offline check of a build: every local link, asset and `#fragment` resolves, and no page or image is over the size budget. Run by CI and by `preview.sh`. |
| `scripts/serve_site.py` | Serves `dist/site` on loopback the way the Worker does: the 404 page, the trailing-slash redirect and the `_headers` file, so the CSP a browser enforces locally is the production one. |
| `scripts/site_pages.py` | The page list and URL rules the other scripts share. |
| `scripts/site_refs.py` | The one place that finds and judges what a page refers to (HTML references with `rel` tokens and head or body position; CSS `url()`, `image-set()` and `@import` after decoding escapes), and the one policy for it. `check_site.py` and `bundle_preview.py` use only this, so they cannot disagree about a page; `tests/test_tool_parity.py` holds them to it. |
| `scripts/screenshots.py` | Full-page PNGs of every page at phone (390x844), tablet (820x1180) and desktop (1440x900) in every theme the CSS defines, into `dist/preview/screenshots/`. Fails on a console error, an uncaught exception, a CSP violation or a request outside the site. |
| `scripts/bundle_preview.py` | The whole built site as ONE self-contained HTML file, `dist/preview/index.html`, for sharing as a private page: CSS and JS inlined, images as data URIs, every page switchable by hash route, labelled as a preview of a version and commit. Under 5 MB. Its first head element is a Content-Security-Policy `<meta>` that allows only the file's own inline code and `data:` URIs, so nothing can be fetched from outside the file; that policy is the boundary and applies to the preview only (the site keeps its `_headers` policy). The build also fails on a fetching construct it recognises, and on `<meta http-equiv=refresh>`, `ping` and `srcdoc`, which a policy does not stop; that scan is an early warning with a clear message, not the guarantee. |
| `scripts/preview.sh` | The preview loop in one command: build, check, serve on loopback, smoke-test, screenshots, bundle. Run it before a pull request that changes anything visible. |
| `scripts/check_release_order.py` | The guard the release deploy runs just before it deploys: fails when a greater `vX.Y.Z` tag exists, so an older release cannot overwrite a newer one. |
| `scripts/check_stage_tip.py` | The guard the stage Preview runs just before it uploads: a run that is no longer the tip of `main` skips its upload, so an older push cannot overwrite a newer one. |
| `scripts/smoke_site.sh` | Post-deploy check: the version is live, the front page carries it, the icon is served, a missing path answers 404. |
| `deploy/` | `wrangler.json` (assets, routes) and the pinned, locked Wrangler. |
| `tests/` | Build tests, and browser tests that drive the built site in Chrome. |
| `.github/workflows/` | `ci`, `security`, `deploy` (dry run and the stage Preview from `main`), `release`, `cut-release`, `dependabot-auto-merge`. |

## Working on the site

```bash
python scripts/build_site.py --version local       # writes dist/site/
python -m http.server 8000 --directory dist/site   # look at it on http://127.0.0.1:8000
python -m pip install --require-hashes -r .github/requirements/site-browser.txt
python -m pytest -m "not browser"                  # build tests
REQUIRE_BROWSER=1 BROWSER_CHANNEL=chrome python -m pytest -m browser   # needs Chrome
```

The header, footer, Back bar and To top button are repeated on each page. When you change one, change it on every page; the browser tests check the behaviour on the front page and on `/about/`.

## The preview loop

```bash
python -m pip install --require-hashes -r .github/requirements/site-browser.txt   # once
bash scripts/preview.sh                                  # Playwright's own Chromium
bash scripts/preview.sh --executable /opt/pw-browsers/chromium   # or any Chromium binary
bash scripts/preview.sh --channel chrome                 # or an installed Chrome
```

It builds `dist/site`, runs `check_site.py`, serves the build on `127.0.0.1` with the real response headers, runs `smoke_site.sh` against it, and writes:

- `dist/preview/screenshots/<page>-<viewport>-<theme>.png`: every page at phone (390x844), tablet (820x1180) and desktop (1440x900) in day, night and the console theme. The run fails on a console error, an uncaught exception or a CSP violation.
- `dist/preview/index.html`: the whole site as one self-contained file (CSS and JS inlined, images as data URIs, every page reachable by hash route), labelled as a preview of a version and commit, to share as a private page. It uses system fonts, so it looks slightly different from the live site.

`PLAYWRIGHT_BROWSERS_PATH` is honoured. CI runs the same loop in the `site-browser` job and keeps `dist/preview` as the `preview` artifact. `AGENTS.md` says what an agent does with the output.

## The design

`src/assets/site.css` holds the whole design. The day, night and console (reactor) themes are three sets of variables on `:root`; the theme follows the visitor's clock (night 20:00 to 06:00) until they choose, and the choice is stored in `localStorage`. Every control is at least 44px, every transition sits inside `prefers-reduced-motion: no-preference`, focus is always visible, and a heading reached by a link lands below the header and the bar. Site-specific rules go in the "Template additions" block at the end of the file, so a later change to the shared design can be diffed against the rest. `src/assets/site.js` runs the theme control, the header that hides while reading down, Back, the bar and To top; `theme.js` runs in the head so the page never flashes the wrong theme.

## Accessibility

The home link in the header is named by its visible text (the site title), so the accessible name contains what a sighted user reads (WCAG 2.5.3, label in name). Focus rings are always visible, and every transition and animation sits inside `prefers-reduced-motion: no-preference`. `tests/test_accessibility.py` keeps that true without any extra dependency: a source check for label-in-name, reduced motion and focus styles, and a browser audit of every built page for landmarks, exactly one `h1`, heading order, image `alt`, a name on every link and button, unique ids, a skip link that lands, a focus ring on everything the keyboard reaches, and no motion under reduced motion. It does not measure colour contrast.

## Security headers, SEO and budgets

- `src/_headers` sets, on every path: a Content-Security-Policy with no `'unsafe-inline'` or `'unsafe-eval'` (scripts and styles only from this origin, Google Fonts the single outside origin, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and a `Permissions-Policy` that turns the camera, microphone and geolocation off. Because the policy forbids inline code, a page that adds a `<style>`, a `style=""` attribute or an inline script is blocked until the policy is widened on purpose; `tests/test_headers.py` fails first, and the screenshot run fails on a CSP violation.
- HSTS is deliberately not in `_headers`. These headers reach every host the Worker answers on, `workers.dev` and the Preview hosts included, and a long `max-age` with `includeSubDomains` or `preload` cannot be taken back. Turn it on in the Cloudflare zone (SSL/TLS, Edge Certificates, HTTP Strict Transport Security) once every subdomain of the domain serves HTTPS, starting with a short `max-age`.
- `build_site.py` writes `robots.txt` and `sitemap.xml` from the pages in `src/` and the production domain, so a new page appears in the sitemap without editing anything. A Preview build (`--noindex`) blocks crawlers and has no sitemap. Each page head carries a description, a canonical link and Open Graph and Twitter Card meta (`og:title`, `og:description`, `og:url`, `twitter:card`); copy the block when you add a page and change the three values. A page's path may use only `a-z`, `0-9`, `.`, `_` and `-` in each directory and file name, starting with a letter or digit; the build refuses any other and names the file. `404.html` is `noindex`.
- `scripts/check_site.py` fails the build on a broken local link, asset or `#fragment`, on a local reference whose path climbs above the site root (`../../x` from `/about/`; a browser would clamp it at the root, but the preview bundler refuses it, so the check does too), on a page whose HTML plus the stylesheets, scripts and images it loads, and every local file those stylesheets pull in through `url()` (background images, fonts), is over 500,000 bytes, on any `@import` (link stylesheets directly; `@import` is not supported, here or in the preview bundle), and on any image over 200,000 bytes (uncompressed; `--page-budget` and `--image-budget` change them). The defaults are a tripwire for a commit that adds an unoptimised photograph, not a target.

## Branches and releases

Working branches are named `<type>/<kebab>`, with a type of `feat`, `fix`, `chore`, `docs`, `ci` or `test` (`feat/contact-form`, `chore/bump-node-22.4`). The `branch-name` job in `ci.yml` fails a pull request from any other name, and refuses a tool-named prefix (`claude/`, `codex/`, `copilot/`, `ai/`, `bot/`). `main`, `dev` and `dependabot/*` are exempt, so the promotion pull request passes. See [CONTRIBUTING.md](CONTRIBUTING.md).

Work lands on `dev` through pull requests, and `dev` is promoted to `main` with one pull request and a merge commit. There is no `stage` branch: a push to `main` uploads a Preview named `stage` at <https://stage.orbit.szolotov.com> (the `staging` environment admits `main` only), so the Preview shows what the next release will ship. A release is cut from `main`: run the __Cut release__ workflow with a version such as `1.0.0`. It tags `v1.0.0`, and the __Release__ workflow deploys production at <https://orbit.szolotov.com>, checks it on `workers.dev`, and rolls back if the checks fail.

The one-time setup (GitHub environments, Cloudflare secrets, required checks, custom domain) and the rollback steps are in [SETUP.md](SETUP.md).
