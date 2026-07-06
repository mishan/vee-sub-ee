#!/usr/bin/env bash
# evsprites.sh — Composite each spïn's sprite sheet with its mask into a
# single transparent PNG the engine can draw directly.
#
# Masks are white-where-opaque, so ImageMagick's CopyOpacity does the whole
# job. Output: evassets/sprites/spin_<id>.png (per manifest.json).
#
# Usage: ./evsprites.sh [evassets dir]

set -euo pipefail
ASSETS="${1:-evassets}"
mkdir -p "$ASSETS/sprites"

node -e '
const m = require(process.argv[1] + "/manifest.json");
for (const [id, s] of Object.entries(m.spins))
  if (s.sprites && s.masks)
    console.log([id, s.sprites, s.masks].join("\t"));
' "$(cd "$ASSETS" && pwd)" | while IFS=$'\t' read -r id sprites masks; do
  magick "$ASSETS/$sprites" "$ASSETS/$masks" -alpha off -compose CopyOpacity -composite \
    "$ASSETS/sprites/spin_$id.png"
done

echo "composited $(ls "$ASSETS/sprites" | wc -l) sprite sheets into $ASSETS/sprites/"
