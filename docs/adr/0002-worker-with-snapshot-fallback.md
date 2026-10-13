# 0002: A Worker with a snapshot fallback

## Context

Releases come from public vendor feeds. A browser cannot fetch them directly: the feeds are not served for cross-origin use, and the Content-Security-Policy allows connections only to the site's own origin. A feed can also be slow, down or briefly malformed, and the site should not go blank when it is.

## Decision

A Cloudflare Worker answers `/api/releases.json` and `/api/health`, and everything else is static assets. The Worker reads one adapter per source, fetches only that adapter's allowlisted URLs, and caches each source on its own: fresh for 10 minutes, served at once while refreshing for up to 24 hours, kept for 7 days. A failed refresh marks the copy stale and backs off for 5 minutes. A live result is merged with the copy already cached and with a snapshot of the releases committed with the site, which is also the last fallback, and the page falls back to the same file if the API itself is unavailable.

## Consequences

- One source failing never blanks another, and an outage costs one timeout, not one per request.
- History does not depend on the feed's short window, because the cached copy and the snapshot are merged in. The snapshot must be refreshed and committed from time to time.
- Responses say plainly when they are stale or from the snapshot, so the interface can tell the visitor.
- Adding a vendor means adding an adapter and a registry entry, with its allowlist, and nothing else in the Worker.
