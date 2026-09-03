#!/usr/bin/env bash
#
# Populates .camoufox-prefetched/ so the Docker build can skip downloading the
# Camoufox browser itself.
#
# This is an OPTIONAL speed-up, not a build step. The build works without it:
# `camoufox-js fetch` downloads the browser when it finds no matching
# version.json. Use this when that download is the problem -- camoufox-js has no
# resume support, so on a connection that can't hold a single 663MB transfer it
# restarts from zero every time and takes the whole (10min+) RUN layer with it.
# curl -C - resumes instead, which is the difference between "eventually
# finishes" and "never does".
#
# Safe to re-run: an interrupted download resumes, and an already-current
# prefetch is left alone unless --force is passed.
#
# Usage:
#   ./scripts/prefetch-camoufox.sh [--force]
#
# GITHUB_TOKEN is optional and only raises the API rate limit. Unauthenticated
# calls get 60/hour per IP and GitHub's secondary limiter is stricter still on
# bursts, which repeated builds do hit.
set -euo pipefail

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

cd "$(dirname "$0")/.."
DEST=".camoufox-prefetched"
ZIP_CACHE=".camoufox-prefetched.zip"   # kept outside DEST so a re-extract can't eat it

# Always the Linux x86_64 build regardless of what this script is run on: it is
# being staged for the container, not for this machine. Fetching the host's
# platform here would produce an image whose browser cannot execute.
REPO="daijro/camoufox"
OS_ARCH="lin.x86_64"

api() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" "$@"
  else
    curl -fsSL "$@"
  fi
}

# Pick the newest release that is neither a prerelease nor a draft, matching how
# camoufox-js chooses (pkgman.ts: it skips both, so pinning anything else here
# would leave version.json disagreeing with what the build expects and trigger a
# re-download of the very thing this script just staged).
echo "Resolving latest Camoufox release for ${OS_ARCH}..."
ASSET_JSON="$(api "https://api.github.com/repos/${REPO}/releases")"

read -r ASSET_NAME ASSET_URL <<EOF
$(printf '%s' "$ASSET_JSON" | python -c '
import json, re, sys
releases = json.load(sys.stdin)
pattern = re.compile(r"^camoufox-(.+)-(.+)-lin\.x86_64\.zip$")
for release in releases:
    if release.get("prerelease") or release.get("draft"):
        continue
    for asset in release.get("assets", []):
        if pattern.match(asset["name"]):
            print(asset["name"], asset["browser_download_url"])
            sys.exit(0)
sys.exit("no matching non-prerelease asset found")
')
EOF

# camoufox-js derives these from the filename the same way, and writes the same
# two fields; version.json has to match or the build re-downloads.
VERSION="$(printf '%s' "$ASSET_NAME" | sed -E 's/^camoufox-(.+)-(.+)-lin\.x86_64\.zip$/\1/')"
RELEASE="$(printf '%s' "$ASSET_NAME" | sed -E 's/^camoufox-(.+)-(.+)-lin\.x86_64\.zip$/\2/')"
echo "Latest: ${ASSET_NAME}  (version=${VERSION} release=${RELEASE})"

if [ "$FORCE" -eq 0 ] && [ -f "${DEST}/version.json" ] &&
   grep -q "\"version\":\"${VERSION}\"" "${DEST}/version.json" 2>/dev/null &&
   grep -q "\"release\":\"${RELEASE}\"" "${DEST}/version.json" 2>/dev/null; then
  echo "Already current. Nothing to do (pass --force to re-fetch)."
  exit 0
fi

# --retry-all-errors covers the mid-transfer resets specifically; -C - makes each
# retry continue rather than start over.
echo "Downloading (resumable)..."
curl -L --retry 30 --retry-delay 5 --retry-all-errors -C - -o "$ZIP_CACHE" "$ASSET_URL"

echo "Extracting..."
rm -rf "$DEST"
mkdir -p "$DEST"
if command -v unzip >/dev/null 2>&1; then
  unzip -q "$ZIP_CACHE" -d "$DEST"
else
  # Git Bash on Windows generally has no unzip; Python is the safer assumption
  # and is already required to build this image anyway (node-gyp).
  python -c "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$ZIP_CACHE" "$DEST"
fi

# No trailing newline and no BOM: camoufox-js JSON.parses this, and a BOM (which
# is what Windows PowerShell's `-Encoding utf8` writes) makes it throw
# "Unexpected token" and fail the build.
printf '{"version":"%s","release":"%s"}' "$VERSION" "$RELEASE" > "${DEST}/version.json"

# Restore .gitkeep -- rm -rf above removes it, and the Dockerfile's COPY needs
# this directory to survive in a fresh clone.
cat > "${DEST}/.gitkeep" <<'GITKEEP'
Keeps this directory present in a fresh clone.

The Dockerfile COPYs this directory unconditionally and Docker's COPY fails on a
missing source, so the directory has to exist even when empty. Empty is a
perfectly good state: camoufox-js downloads the browser during the build when it
finds no matching version.json here.

Run scripts/prefetch-camoufox.sh to populate it. That only makes the build faster
(and survives a connection that can't hold a 663MB transfer); it is never
required for a correct build.
GITKEEP

rm -f "$ZIP_CACHE"
echo "Done. ${DEST} holds Camoufox v${VERSION}-${RELEASE}; the build will skip its download."
