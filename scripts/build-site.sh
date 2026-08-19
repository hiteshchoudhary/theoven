#!/usr/bin/env bash
#
# Assembles the full public site into ./dist:
#
#   /        the hand-written landing page   (apps/landing, no build step)
#   /docs/   the Starlight documentation     (apps/web, built by Astro)
#
# Two separate things deliberately. The landing page is a design surface and wants direct
# control over every pixel; the docs are a content surface and want search, syntax
# highlighting, and a sidebar generated from the filesystem. Trying to make one tool serve
# both is how you end up fighting a framework for a hero section.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT="$ROOT/dist"

echo "==> Building docs with Astro"
bun run --cwd apps/web build

echo "==> Assembling $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"

# Landing page first: it owns the site root.
cp -R apps/landing/. "$OUT/"

# Docs underneath. Astro is configured with base: '/docs', so its internal links already
# expect this location.
mkdir -p "$OUT/docs"
cp -R apps/web/dist/. "$OUT/docs/"

echo "==> Generating llms.txt"
bun scripts/generate-llms.mjs "$OUT"

echo "==> Checking internal links"
bun scripts/check-links.mjs "$OUT"

echo "==> Site assembled"
find "$OUT" -maxdepth 2 -type d | sed "s|$OUT|  .|" | sort
echo
echo "    total: $(du -sh "$OUT" | cut -f1)"
