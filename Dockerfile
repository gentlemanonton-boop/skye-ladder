# Skye graduation watcher — runs the SKYE bonding curve relayer 24/7.
#
# This image is INTENTIONALLY minimal: it does not include the Anchor or
# Solana toolchains, the Rust programs, the frontend, or any of the test
# scripts. The .dockerignore at the repo root excludes all of those.
# Build target is just enough Node.js to run scripts/graduate-watcher.ts.
#
# Build & run locally:
#   docker build -t skye-watcher .
#   docker run -e RELAYER_KEYPAIR_JSON="$(cat ~/.skye/relayer-keypair.json)" skye-watcher
#
# Deploy to Railway / Fly / Render: just push the repo, the platform's
# Docker auto-detection picks up this file.

FROM node:20-slim AS base
WORKDIR /app

# Install deps. We do this BEFORE copying source so the layer is cached
# across rebuilds when only the watcher script itself changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy only what the watcher needs.
COPY tsconfig.json ./
COPY scripts/graduate-watcher.ts ./scripts/graduate-watcher.ts

# Configurable env vars (override at deploy time):
#   RELAYER_KEYPAIR_JSON  — REQUIRED. Hot wallet's secret key as a JSON
#                            byte array, e.g. "[12,34,56,...]".
#   ADMIN_KEYPAIR_JSON    — RECOMMENDED. Admin authority's secret key as a
#                            JSON byte array. Used to auto-switch the transfer
#                            hook from curve → AMM after graduation. Without
#                            this, a manual update_pool + update_extra_metas
#                            call is required or transfers will freeze.
#   RPC_URL               — optional. Solana RPC. Defaults to public mainnet.
#   WATCHER_INTERVAL_S    — optional. Poll interval in seconds. Default 10.
ENV NODE_ENV=production

# Run continuously via the npm script defined in package.json. The watcher
# handles its own polling loop and exits cleanly when the curve graduates
# (the container exits with code 0; Railway/Fly will NOT restart on clean
# exit, which is what we want — the work is done, no need to keep paying).
CMD ["npm", "run", "watcher"]
