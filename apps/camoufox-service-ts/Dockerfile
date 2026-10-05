FROM node:22-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true

RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

# better-sqlite3 (a camoufox-js dependency, used for its session/fingerprint
# cache) has no prebuilt binary for this platform in its lockfile-pinned
# version and falls back to compiling from source via node-gyp, which needs
# Python + a C++ toolchain -- absent from the bare node:22-slim image.
#
# Camoufox is a real Firefox build, not a headless-only artifact -- it links
# against the same GTK/X11/audio/font stack desktop Firefox does, none of
# which node:22-slim carries (confirmed by actually running the built image,
# not just building it: the browser process died on launch with
# "libgtk-3.so.0: cannot open shared object file"). This is the standard
# Firefox-on-Debian runtime dependency set (the same list `playwright
# install-deps firefox` would pull in); Camoufox itself still runs headless
# via its own launch args, this is just what the binary is linked against.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libgtk-3-0 \
    libx11-xcb1 \
    libasound2 \
    libdbus-glib-1-2 \
    libxt6 \
    libxrender1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libcairo2 \
    libgdk-pixbuf-2.0-0 \
    libnss3 \
    libnspr4 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --fetch-timeout is raised well above pnpm's 60s default because this build has to
# survive a slow link: tarballs here have been observed arriving at 1-40 KiB/s, and a
# 900KB package (rollup's platform binary, say) simply cannot land inside a minute at
# that rate. The default aborted this step with "The operation was aborted due to
# timeout" after 191 of 196 packages, discarding the whole layer. A longer per-request
# ceiling costs nothing on a fast connection -- it bounds the wait, it does not add to
# it.
RUN pnpm install --frozen-lockfile --fetch-timeout=600000

# Everything from here to `pnpm run build` is deliberately ordered so that the
# browser fetch sits ABOVE the source copy. Docker invalidates every layer after
# the first one that changes, so with `COPY . .` above the fetch (as it was
# originally) editing a single .ts file re-ran the fetch -- which even with the
# prefetch populated still re-downloads the ~65MB GeoIP database on every code
# change, and on a bad connection can fail the build outright. The fetch depends
# only on node_modules and CAMOUFOX_INSTALL_DIR, never on this service's source,
# so it belongs before it.

# camoufox-js defaults to caching the browser download under the *running
# user's* home directory (os.homedir()/.cache/camoufox). This fetch step runs
# as root, but the container runs as `node` at USER below -- a different
# $HOME -- so without pinning CAMOUFOX_INSTALL_DIR to a fixed, chown-able
# path, the binary looks missing at runtime and silently re-downloads on
# every cold start (caught by actually running the built image, not just
# building it: /health hung on a fresh 663MB download instead of returning).
ENV CAMOUFOX_INSTALL_DIR=/usr/src/app/.camoufox

# The 663MB browser download inside `camoufox-js fetch` (below) proved too
# fragile to rely on over an unstable connection -- camoufox-js's own
# downloader has no resume support, so any mid-transfer drop loses the whole
# attempt and the whole ~10min+ RUN layer with it (repeatedly, during
# development). scripts/prefetch-camoufox.sh stages that same release here
# using `curl -C -`, which resumes instead of restarting.
#
# OPTIONAL, and empty is a valid state. When this holds a version.json matching
# the latest release, CamoufoxUpdate.isUpdateNeeded() (pkgman.js) skips the
# download outright and `fetch` below only confirms that and pulls the small
# (~65MB) GeoIP database, which never had this problem. When it holds just the
# .gitkeep -- as in any fresh clone, since the browser itself is far too large
# for git -- `fetch` downloads the browser as it normally would and the build
# is merely slower. The directory is committed (empty) rather than ignored
# outright because COPY fails on a missing source, which would make a fresh
# clone unbuildable instead of just slow.
COPY .camoufox-prefetched/ ${CAMOUFOX_INSTALL_DIR}/

# `fetch` also unconditionally pulls a GeoIP database from a *second*,
# unrelated GitHub repo (P3TERX/GeoLite.mmdb) for the `geoip: true` launch
# option -- a second unauthenticated GitHub API call, on top of the browser
# binary's own, that hit GitHub's secondary rate limit during development
# (well after the 663MB browser download itself had already succeeded once,
# losing that whole RUN layer on the retry).
#
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is NOT the fix for that (tried it first --
# it turns out to skip the browser binary too, not just GeoIP: "Skipping
# browser download / update check due to PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
# set!"). The actual fix is authenticating the calls: getAuthorizationHeaders()
# in camoufox-js reads GITHUB_TOKEN and attaches it as a Bearer token
# automatically when present, which raises the rate limit and avoids the
# secondary-abuse throttling unauthenticated bursts hit. Passed as a BuildKit
# secret (`--secret id=github_token,env=GITHUB_TOKEN`), not a plain ARG, so it
# never lands in the image layers or `docker history` -- this is a
# pre-deployment, one-off build aid, not something to bake into the shipped
# image.
RUN --mount=type=secret,id=github_token,env=GITHUB_TOKEN \
    pnpm exec camoufox-js fetch

# Source last, and listed explicitly rather than `COPY . .`. A blanket copy also
# pulled .camoufox-prefetched/ into the image a second time (1.2GB of it), on top
# of the copy the line above had already placed at CAMOUFOX_INSTALL_DIR -- nothing
# reads that duplicate, and it cannot be reclaimed by deleting it later because
# the bytes are already committed to a lower layer. Listing sources also means a
# new top-level file has to be added here consciously rather than silently
# inflating the image.
COPY api.ts trawl-deps.ts screenshot.ts screenshotHideSelectors.ts tsconfig.json ./
COPY helpers/ ./helpers/
COPY shared/ ./shared/
COPY trawl/ ./trawl/

RUN pnpm run build

RUN chown -R node:node /usr/src/app

ARG PORT
ENV PORT=${PORT}

EXPOSE ${PORT}

USER node

CMD [ "pnpm", "start" ]
