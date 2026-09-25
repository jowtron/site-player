#!/bin/sh
# Upload an album's encoded files to the site's R2 bucket.
#
#   tools/upload.sh <bucket> <folder, e.g. research/audio/home>
#
# Files land at <slug>/NN.webm and <slug>/NN.m4a, the slug being the folder's
# name. ⚠ Run it from the site's own folder: wrangler takes the account from
# its wrangler.jsonc, whatever CLOUDFLARE_ACCOUNT_ID says.
set -eu
bucket=$1; dir=${2%/}; slug=$(basename "$dir")
for f in "$dir"/*.webm "$dir"/*.m4a; do
  [ -e "$f" ] || continue
  case $f in *.webm) type=audio/webm ;; *) type=audio/mp4 ;; esac
  npx wrangler r2 object put "$bucket/$slug/$(basename "$f")" --file "$f" --content-type "$type" --remote >/dev/null
  echo "$slug/$(basename "$f")"
done
