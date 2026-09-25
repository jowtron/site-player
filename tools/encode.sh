#!/bin/sh
# Encode an album's masters for site-player: NN.webm (Opus 160k) and NN.m4a
# (AAC 192k, for browsers without WebM Opus, mostly older iPhones).
#
#   tools/encode.sh <folder of WAV/FLAC/AIFF masters> <out folder, e.g. research/audio/home>
#
# Files are numbered in the order ls sorts them, so name the masters with
# their track numbers first ("01 …", "02 …"). Needs ffmpeg; the AAC encoder
# is Apple's (aac_at, macOS), which beats ffmpeg's own at this bitrate.
# Ogg Opus files you already have can be rewrapped instead, losslessly, for
# a proper seek index: ffmpeg -i in.opus -c:a copy NN.webm
set -eu
src=$1; out=$2
mkdir -p "$out"
n=0
ls "$src" | grep -iE '\.(wav|flac|aiff?)$' | while IFS= read -r f; do
  n=$((n + 1)); nn=$(printf %02d "$n")
  ffmpeg -loglevel error -y -i "$src/$f" -map_metadata -1 -c:a libopus -b:a 160k -vbr on -application audio -f webm "$out/$nn.webm"
  ffmpeg -loglevel error -y -i "$src/$f" -map_metadata -1 -c:a aac_at -b:a 192k -movflags +faststart "$out/$nn.m4a"
  echo "$nn  $f"
done
