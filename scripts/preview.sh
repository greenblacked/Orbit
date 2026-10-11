#!/usr/bin/env bash
# The local preview loop: build the site, check it, serve it, smoke-test it, take
# screenshots of every page at phone, tablet and desktop size in every theme, and bundle
# it into one shareable HTML file. Run it before opening a pull request that changes
# anything a visitor can see, then look at the pictures.
#
#   bash scripts/preview.sh
#   bash scripts/preview.sh --executable /opt/pw-browsers/chromium
#   bash scripts/preview.sh --no-screenshots        # build, check, smoke and bundle only
#
# Writes: dist/site (the build), dist/preview/screenshots/<page>-<viewport>-<theme>.png
# and dist/preview/index.html (the bundle). The server is on 127.0.0.1 only and is
# stopped when the script ends.
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/preview.sh [--version V] [--commit C] [--port N]
                          [--executable PATH | --channel NAME] [--no-screenshots]

  --version V       label stamped into the build (default preview-<short sha>, or local)
  --commit C        commit shown on the bundle (default: git's short HEAD)
  --port N          port for the local server (default: a free one)
  --executable P    Chromium binary for the screenshots (also BROWSER_EXECUTABLE)
  --channel NAME    installed browser channel, e.g. chrome (also BROWSER_CHANNEL)
  --no-screenshots  skip the screenshots (they need Playwright and a browser)

Exit codes: 0 done, 1 a step failed, 2 usage error.
USAGE
}

die_usage() {
  echo "preview.sh: $1" >&2
  usage >&2
  exit 2
}

version=""
commit=""
port=""
executable=${BROWSER_EXECUTABLE:-}
channel=${BROWSER_CHANNEL:-}
screenshots=1
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --no-screenshots)
      screenshots=0
      shift
      ;;
    --version | --commit | --port | --executable | --channel)
      [ $# -ge 2 ] || die_usage "$1 needs a value"
      case "$1" in
        --version) version=$2 ;;
        --commit) commit=$2 ;;
        --port) port=$2 ;;
        --executable) executable=$2 ;;
        --channel) channel=$2 ;;
      esac
      shift 2
      ;;
    *) die_usage "unknown argument: $1" ;;
  esac
done

root=$(CDPATH="" cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null && pwd -P)
cd "$root"
py=${PYTHON:-python3}

if [ -z "$version" ]; then
  if sha=$(git rev-parse --short HEAD 2>/dev/null); then
    version="preview-$sha"
  else
    version="local"
  fi
fi
if [ -z "$port" ]; then
  port=$("$py" -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
fi
[[ "$port" =~ ^[0-9]+$ ]] || die_usage "--port must be a number"

step() {
  echo
  echo "==> $1"
}

server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

step "build ($version)"
"$py" scripts/build_site.py --version "$version"

step "check links and the size budget"
"$py" scripts/check_site.py dist/site

mkdir -p dist/preview
step "serve on 127.0.0.1:$port"
"$py" scripts/serve_site.py --port "$port" >dist/preview/server.log 2>&1 &
server_pid=$!
url="http://127.0.0.1:$port"
ready=0
for _ in $(seq 1 100); do
  if curl -fsS --max-time 2 -o /dev/null "$url/version.txt" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.1
done
if [ "$ready" -ne 1 ]; then
  echo "preview.sh: the local server did not answer; see dist/preview/server.log" >&2
  exit 1
fi
echo "serving $url"

step "smoke test"
SMOKE_SITE_TEST_MODE=1 bash scripts/smoke_site.sh "$url" "$version"

if [ "$screenshots" -eq 1 ]; then
  step "screenshots"
  shot_args=(--base-url "$url")
  if [ -n "$executable" ]; then shot_args+=(--executable "$executable"); fi
  if [ -n "$channel" ]; then shot_args+=(--channel "$channel"); fi
  "$py" scripts/screenshots.py "${shot_args[@]}"
fi

step "bundle"
bundle_args=()
if [ -n "$commit" ]; then bundle_args+=(--commit "$commit"); fi
"$py" scripts/bundle_preview.py ${bundle_args[@]+"${bundle_args[@]}"}

echo
echo "Preview ready."
echo "  site:        $root/dist/site"
if [ "$screenshots" -eq 1 ]; then
  echo "  screenshots: $root/dist/preview/screenshots"
fi
echo "  bundle:      $root/dist/preview/index.html"
echo "Look at every screenshot (phone, tablet, desktop; each theme) before opening the pull request."
