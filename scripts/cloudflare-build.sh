#!/usr/bin/env bash
#
# Cloudflare Pages build entrypoint for the docs site.
#
# Why this script exists instead of a build command in the dashboard:
#
# Cloudflare's build image picks a package manager by sniffing lockfiles, and for Bun it looks
# for `bun.lockb` — the binary format Bun used before 1.2. We are on Bun 1.2, which writes the
# text format `bun.lock`, so detection falls through to npm. npm then chokes on the
# `workspace:*` protocol our packages use:
#
#     npm error code EUNSUPPORTEDPROTOCOL
#     npm error Unsupported URL Type "workspace:": workspace:*
#
# So we set SKIP_DEPENDENCY_INSTALL=1 in the Pages environment and drive Bun ourselves here.
# Keeping it in the repo means the fix is reviewable and survives someone editing the dashboard.
#
# Pages settings that go with this file:
#   Build command:           bash scripts/cloudflare-build.sh
#   Build output directory:  dist
#   Root directory:          (empty — repo root)
#   Environment variables:   SKIP_DEPENDENCY_INSTALL=1, BUN_VERSION=1.2.23

set -euo pipefail

if ! command -v bun >/dev/null 2>&1; then
  echo "==> Bun not on PATH; installing it."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${HOME}/.bun"
  export PATH="${BUN_INSTALL}/bin:${PATH}"
fi

echo "==> Bun $(bun --version)"

# --frozen-lockfile so a drifted lockfile fails the build here rather than silently shipping
# different dependency versions than we tested against.
echo "==> Installing workspace dependencies"
bun install --frozen-lockfile

echo "==> Building the site (landing page + docs)"
bash scripts/build-site.sh

echo "==> Done. Output is in dist/"
