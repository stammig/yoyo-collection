#!/bin/bash
# spin-frames.sh — batch-convert turntable videos into Yoyo Collection 360-spin
# uploads: a numbered frame sequence (+ .zip of it) and a compressed loop .mp4.
#
# The rotation period is detected automatically: a reference frame is grabbed
# just after the start, then every later frame is scored against it with SSIM
# (structural similarity). The moment the score peaks again is the moment the
# yoyo looks like the start again — one full rotation. The earliest peak wins,
# so a clip holding 3 rotations still trims to one.
#
# Usage:
#   ./spin-frames.sh [options] video.MP4 [more videos ...]
#   ./spin-frames.sh [options] /path/to/folder     # every video inside
#
# Options:
#   -s SECONDS   skip this much lead-in before the reference frame
#                (default: auto — finds when your hand leaves the shot)
#   -n FRAMES    frames per rotation to extract (default 60; app cap is 180)
#   -w PIXELS    frame width (default 1000)
#   -p SECONDS   skip detection and use this rotation period
#   -M           skip making the loop .mp4
#
# Output, next to each input video:
#   <name>-spin/spin_001.jpg...   the frames (plus check-loop.jpg, see below)
#   <name>-spin.zip               the frames zipped, for the app's zip upload
#   <name>-loop.mp4               muted H.264 loop (skipped with -M)
#
# Eyeball check: <name>-spin/check-loop.jpg is the first and last frame side
# by side — if they don't look nearly identical, the loop will visibly jump.
# Defaults keep frames far inside the app's 5 MB/frame limit.
set -euo pipefail

SKIP=""; TARGET=60; WIDTH=1000; PERIOD=""; MAKE_MP4=1
MIN_PERIOD=5          # ignore SSIM peaks earlier than this (yoyo is symmetric;
                      # a half-turn can look briefly similar on some finishes)
ANALYZE_FPS=10        # detection sample rate; 10/s at 320px gray is plenty

while getopts "s:n:w:p:M" opt; do
  case $opt in
    s) SKIP=$OPTARG ;;
    n) TARGET=$OPTARG ;;
    w) WIDTH=$OPTARG ;;
    p) PERIOD=$OPTARG ;;
    M) MAKE_MP4=0 ;;
    *) exit 1 ;;
  esac
done
shift $((OPTIND - 1))
[ $# -ge 1 ] || { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

for tool in ffmpeg ffprobe zip; do
  command -v "$tool" >/dev/null || { echo "error: $tool is required but not installed." >&2; exit 1; }
done

# A folder argument means "every video in it" — but never this script's own
# -loop.mp4 outputs, or re-running on a folder would process its own results.
VIDEOS=()
for arg in "$@"; do
  if [ -d "$arg" ]; then
    found=0
    for f in "$arg"/*.[Mm][Pp]4 "$arg"/*.[Mm][Oo][Vv] "$arg"/*.[Ww][Ee][Bb][Mm] "$arg"/*.[Aa][Vv][Ii]; do
      [ -e "$f" ] || continue
      case "$f" in *-loop.mp4|*-loop.MP4) continue ;; esac
      VIDEOS+=("$f"); found=1
    done
    [ "$found" = 1 ] || echo "!! no videos found in $arg" >&2
  else
    VIDEOS+=("$arg")
  fi
done
[ ${#VIDEOS[@]} -ge 1 ] || exit 1

FF="ffmpeg -hide_banner -loglevel error -y"
SUMMARY=""

# Finds when the scene settles: a hand placing the yoyo (or hitting record)
# spikes the frame-to-frame difference (signalstats YDIF), while a bare
# turntable is low and steady. The in-point is the first moment the signal
# stays near its steady-state level for 2 straight seconds.
detect_inpoint() { # $1=video  -> echoes seconds
  local log
  log=$(mktemp "${TMPDIR:-/tmp}/spinydif.XXXXXX")
  $FF -i "$1" -vf "fps=$ANALYZE_FPS,scale=320:-2,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=$log"     -f null - 2>/dev/null
  awk -v fps="$ANALYZE_FPS" '
    /pts_time:/ { split($0,a,"pts_time:"); t[++i]=a[2]+0 }
    /YDIF=/     { split($0,b,"=");         v[i]=b[2]+0 }
    END {
      if (i < 3*fps) { print 0; exit }             # clip too short to judge
      # Steady-state estimate: mean YDIF over the middle half of the clip.
      lo=int(i*0.25); hi=int(i*0.75); sum=0; cnt=0
      for (n=lo; n<=hi; n++) { sum+=v[n]; cnt++ }
      thresh = 2*(sum/cnt) + 0.5
      w = 2*fps                                    # must stay calm this long
      for (n=1; n+w<=i; n++) {
        ok=1
        for (k=n; k<=n+w; k++) if (v[k] > thresh) { ok=0; break }
        if (ok) { printf "%.2f", t[n]+0.3; exit }  # small margin past the calm edge
      }
      print 2                                      # fallback: old default
    }' "$log"
  rm -f "$log"
}

detect_period() { # $1=video $2=in-point  -> echoes period seconds, or "" on weak match
  local ref log
  ref=$(mktemp "${TMPDIR:-/tmp}/spinref.XXXXXX").jpg
  log=$(mktemp "${TMPDIR:-/tmp}/spinssim.XXXXXX")
  $FF -ss "$2" -i "$1" -frames:v 1 "$ref"
  # Score every sampled frame against the reference. Grayscale at 320px: the
  # rotation signal is shape, not color, and small frames keep this fast.
  $FF -ss "$2" -i "$1" -loop 1 -i "$ref" -filter_complex \
    "[0:v]fps=$ANALYZE_FPS,scale=320:-2,format=gray[a];[1:v]scale=320:-2,format=gray[b];[a][b]ssim=stats_file=$log:shortest=1" \
    -f null - 2>/dev/null
  awk -v fps="$ANALYZE_FPS" -v minp="$MIN_PERIOD" '
    { n=0; v=0
      for (i=1;i<=NF;i++) { if ($i ~ /^n:/) n=substr($i,3)+0; if ($i ~ /^All:/) v=substr($i,5)+0 }
      if (n >= minp*fps) { val[n]=v; if (v>max) max=v; last=n } }
    END {
      if (max < 0.75) exit          # nothing ever looked like the start again
      for (n=minp*fps; n<=last; n++) # earliest frame within a hair of the best
        if (n in val && val[n] >= max-0.01) { printf "%.2f %.3f", n/fps, val[n]; exit }
    }' "$log"
  rm -f "$ref" "$log"
}

for video in "${VIDEOS[@]}"; do
  base=$(basename "${video%.*}")
  dir=$(dirname "$video")
  out="$dir/$base-spin"
  echo "── $base ──"

  inpoint=$SKIP
  if [ -z "$inpoint" ]; then
    inpoint=$(detect_inpoint "$video")
    echo "   in-point: ${inpoint}s (auto — scene settles here)"
  else
    echo "   in-point: ${inpoint}s (manual)"
  fi

  period=$PERIOD
  if [ -z "$period" ]; then
    read -r period conf <<EOF
$(detect_period "$video" "$inpoint")
EOF
    if [ -z "$period" ]; then
      echo "   !! could not detect a rotation (no frame re-matched the start)."
      echo "      Did the camera move? Re-run with -p <seconds> to set it manually."
      SUMMARY="$SUMMARY\n$base: FAILED (no period detected)"
      continue
    fi
    echo "   rotation period: ${period}s (detected, match ${conf})"
    # A detected period can be a mirage: half a rotation shows the yoyo's OTHER
    # cup, and on a centered, symmetric yoyo that scores nearly as well as a
    # full turn. Only a clip long enough to hold two detected periods can tell
    # the difference — flag it when this one can't.
    clipdur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$video")
    if awk -v d="$clipdur" -v i="$inpoint" -v p="$period" 'BEGIN { exit !(d < i + 2*p) }'; then
      echo "   note: clip is shorter than two detected periods, so this could be a"
      echo "         mirror-side HALF rotation. Fine for symmetric colorways; for"
      echo "         one-sided art, record longer or pass -p <known full period>."
    fi
  else
    echo "   rotation period: ${period}s (manual)"
  fi

  # Stop half a frame-interval short of a full turn: the frame at exactly
  # `period` equals frame 1, and a duplicated endpoint stutters on loop.
  read -r fps dur <<EOF
$(awk -v p="$period" -v t="$TARGET" 'BEGIN { printf "%.4f %.3f", t/p, p*(t-0.5)/t }')
EOF

  rm -rf "$out"; mkdir -p "$out"
  $FF -ss "$inpoint" -t "$dur" -i "$video" -vf "fps=$fps,scale=$WIDTH:-2" -q:v 3 "$out/spin_%03d.jpg"
  count=$(ls "$out" | grep -c '^spin_')

  first="$out/spin_001.jpg"
  last="$out/$(ls "$out" | grep '^spin_' | tail -1)"
  $FF -i "$first" -i "$last" -filter_complex hstack "$out/check-loop.jpg"

  (cd "$out" && rm -f "../$base-spin.zip" && zip -q "../$base-spin.zip" spin_*.jpg)

  if [ "$MAKE_MP4" = 1 ]; then
    $FF -ss "$inpoint" -t "$period" -i "$video" -an -c:v libx264 -preset slow -crf 24 \
      -pix_fmt yuv420p -vf "fps=30,scale=1080:-2" -movflags +faststart "$dir/$base-loop.mp4"
    mp4size=$(du -h "$dir/$base-loop.mp4" | cut -f1 | tr -d ' ')
  else
    mp4size="skipped"
  fi

  zipsize=$(du -h "$dir/$base-spin.zip" | cut -f1 | tr -d ' ')
  echo "   $count frames -> $base-spin.zip ($zipsize), loop mp4: $mp4size"
  SUMMARY="$SUMMARY\n$base: ${period}s rotation, $count frames, zip $zipsize, mp4 $mp4size"
done

echo; echo "── summary ──"; printf "%b\n" "$SUMMARY"
echo "Eyeball each <name>-spin/check-loop.jpg: the two halves should match."
