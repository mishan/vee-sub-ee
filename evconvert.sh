#!/usr/bin/env bash
# evconvert.sh — Convert EV's graphics/sound resources to PNG/WAV via
# resource_dasm, then build the sprite-atlas manifest.
#
# Requires: resource_dasm (github.com/fuzziqersoftware/resource_dasm),
#           ImageMagick (magick), node.
#
# Usage: ./evconvert.sh [EV_data dir] [output dir]
#
# resource_dasm chokes on paths with spaces, so sources are staged under a
# temp dir with simple names first.

set -euo pipefail

DATA="${1:-EV_data}"
OUT="${2:-evassets}"
RD="${RESOURCE_DASM:-resource_dasm}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

convert_file() { # <source .rsrc> <short name> <kind: img|snd>
  local src="$1" short="$2" kind="$3"
  local dest="$OUT/$short"
  mkdir -p "$dest"
  cp "$DATA/$src" "$TMP/$short.rsrc"
  (cd "$TMP" && "$RD" --index-format=as/ad "$short.rsrc" >/dev/null 2>&1) || true
  local outdir="$TMP/$short.rsrc.out"
  if [ "$kind" = img ]; then
    (cd "$outdir" && ls ./*.bmp | xargs -P "$(nproc)" -I{} magick {} {}.png)
    for f in "$outdir"/*.bmp.png; do
      local n; n="$(basename "$f")"; n="${n#"$short".rsrc_}"
      mv "$f" "$dest/${n%.bmp.png}.png"
    done
  else
    for f in "$outdir"/*.wav; do
      local n; n="$(basename "$f")"
      mv "$f" "$dest/${n#"$short".rsrc_}"
    done
  fi
  echo "$short: $(ls "$dest" | wc -l) files"
}

convert_file "EV Graphics.rsrc" graphics img
convert_file "EV Titles.rsrc"   titles   img

# Named resources export as PICT_<id>_<name>.png / snd_<id>_<name>.wav; the
# engine looks assets up by ID, so give every named one a suffix-free alias.
for dir in "$OUT/graphics" "$OUT/titles"; do
  for f in "$dir"/PICT_*_*.png; do
    [ -e "$f" ] || continue
    id="$(basename "$f" | cut -d_ -f2)"
    [ -e "$dir/PICT_$id.png" ] || cp "$f" "$dir/PICT_$id.png"
  done
done
for dir in "$OUT/sounds" "$OUT/music"; do
  for f in "$dir"/snd_*_*.wav; do
    [ -e "$f" ] || continue
    id="$(basename "$f" | cut -d_ -f2)"
    [ -e "$dir/snd_$id.wav" ] || cp "$f" "$dir/snd_$id.wav"
  done
done
convert_file "EV Sounds.rsrc"   sounds   snd
convert_file "EV Music.rsrc"    music    snd

node "$(dirname "$0")/evatlas.js" "$DATA/EV Graphics.rsrc" "$OUT"
