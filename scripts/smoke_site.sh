#!/usr/bin/env bash
# Confirm a deployed site is the version just uploaded.
#
# No token and no Wrangler: curl and python3 only, so this can run in a step that
# does not hold the Cloudflare credential. version.txt is retried until its first
# line is the expected version, not merely until it answers: a host can answer for a
# while with the previous version while the new one propagates, and that must not
# fail a healthy deploy. The other paths are required once it matches, since they
# were uploaded in the same version: the front page must carry the same version in its
# site-version meta tag, the icon must be served, and a path that does not exist must
# answer 404 (the Worker's not_found_handling), not the front page.
#
# The wait is bounded by elapsed time, not by a count of attempts: each request's
# own timeout is cut to what is left, so a host that accepts and then stalls cannot
# stretch the poll past WAIT_SECONDS. That keeps several URLs inside a job's
# timeout-minutes, which matters because a job that times out is cancelled rather
# than failed, and a cancelled release job skips its rollback.
#
# Test hook: with SMOKE_SITE_TEST_MODE=1 the script also accepts exactly
# http://127.0.0.1:<port>, waits 0.1s between attempts and gives up after 3s, so a
# test can serve versions from a local socket. Unset by default; it changes nothing
# else, and every other URL still has to be https.
set -Eeuo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: smoke_site.sh <https-url> <version>" >&2
  exit 2
fi

url=$1
version=$2
url=${url%/}

delay=2
wait_seconds=90
loopback_ok=0
if [ "${SMOKE_SITE_TEST_MODE:-}" = 1 ]; then
  loopback_ok=1
  delay=0.1
  wait_seconds=3
fi

# A strict shape, not a glob: a glob lets "https://a b", "https://x@evil.example" and
# "https://a/../" through. Labels of letters, digits and hyphens joined by dots, an
# optional port, then an optional path with no whitespace, "@", "?", "#" or ".." segment.
https_re='^https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:[0-9]{1,5})?(/[A-Za-z0-9._~%!$&()*+,;=:-]*)*$'
dotdot_re='/\.\.(/|$)'
case "$url" in
  https://*)
    if ! [[ "$url" =~ $https_re ]] || [[ "$url" =~ $dotdot_re ]]; then
      echo "smoke url must be https and a hostname" >&2
      exit 1
    fi
    ;;
  http://127.0.0.1:[0-9]*)
    port=${url#http://127.0.0.1:}
    if [ "$loopback_ok" -ne 1 ] || ! [[ "$port" =~ ^[0-9]+$ ]]; then
      echo "smoke url must be https and a hostname" >&2
      exit 1
    fi
    ;;
  *)
    echo "smoke url must be https and a hostname" >&2
    exit 1
    ;;
esac

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

# Ninety seconds: long enough for a new version to reach the host a request lands
# on, short enough that a deploy that never serves it fails the job well inside its
# timeout. No single request may outlast what remains of that budget.
deadline=$((SECONDS + wait_seconds))
answered=0
got=""
attempts=0
while [ "$SECONDS" -lt "$deadline" ]; do
  remaining=$((deadline - SECONDS))
  limit=$((remaining < 10 ? remaining : 10))
  if [ "$limit" -lt 1 ]; then
    limit=1
  fi
  attempts=$((attempts + 1))
  if curl -fsS --max-time "$limit" -o "$tmp" "$url/version.txt"; then
    answered=1
    got=$(tr -d '\r' <"$tmp" | head -n 1)
    if [ "$got" = "$version" ]; then
      break
    fi
  fi
  sleep "$delay"
done
if [ "$answered" -ne 1 ]; then
  echo "version.txt did not answer at $url within ${wait_seconds}s" >&2
  exit 1
fi
if [ "$got" != "$version" ]; then
  echo "version.txt is '$got' after ${wait_seconds}s ($attempts attempts), expected '$version'" >&2
  exit 1
fi

curl -fsS --max-time 20 -o "$tmp" "$url/"
if ! grep -qF "<meta name=\"site-version\" content=\"$version\">" "$tmp"; then
  echo "the front page does not carry site-version '$version'" >&2
  exit 1
fi
curl -fsS --max-time 20 -o /dev/null "$url/favicon.png"
code=$(curl -sS --max-time 20 -o /dev/null --write-out '%{http_code}' "$url/no-such-page-$$/" || true)
if [ "$code" != 404 ]; then
  echo "a path that does not exist answered HTTP ${code:-none}, expected 404" >&2
  exit 1
fi
