# 0001: No framework or bundler

## Context

The site is a handful of pages that show release data and a few interactive drawings. It must load fast on a phone, run under a strict Content-Security-Policy with no inline code, and stay easy to read, review and keep working for years without a toolchain upgrade treadmill.

## Decision

The site is plain HTML, one stylesheet and small ES scripts, served as written. There is no framework, no bundler and no transpiler. Scripts that are not needed for first paint are loaded on idle as modules. The build only copies files and stamps a version. The scripts in `scripts/` use the Python standard library only.

## Consequences

- There is no build graph to break and nothing to audit but the files that ship. Every byte a page loads can be counted, which is what makes the performance budgets simple to enforce.
- Shared markup (header, footer, controls) is repeated on each page and must be changed on each. Tests check the behaviour that matters.
- Code is written for current browsers with feature detection and fallbacks, not compiled for old ones.
- A small preview bundler inlines the built site into one file for review. It is a script in this repository, not a build step for the site.
