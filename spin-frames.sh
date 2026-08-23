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
#   -w PIXELS    output size (default 1000; frames are square when centered)
#   -p SECONDS   skip detection and use this rotation period
#   -M           skip making the loop .mp4
#   -C           don't auto-center (keep the full frame, old behavior)
#   -m FRACTION  breathing room around the yoyo when centering (default 0.18)
#   -L LIMIT     centering motion threshold 0-255 (default 96). Raise it if
#                reflections widen the box; lower it if a slow, dim spin
#                leaves part of the yoyo outside the crop.
#
# Auto-centering: the yoyo doesn't have to sit dead-center on the table. It is
# found by MOTION — the yoyo is the only thing in the shot that rotates, so
# differencing consecutive frames across one full rotation lights up exactly
# the yoyo (any color, any exposure, white-on-white included) while the tent,
# table, stand, and shadows stay dark. Frames are cropped to a square centered
# on that motion box and scaled to -w. Shoot 4K for crop headroom.
#
# Output, next to each input video:
#   <name>-spin/spin_001.jpg...   the frames (plus check-loop.jpg, see below)
#   <name>-spin.zip               the frames zipped, for the app's zip upload
#   <name>-loop.mp4               muted H.264 loop (skipped with -M)
#
# Eyeball checks, one image each per spin:
#   check-loop.jpg    first + last frame side by side — if they don't look
#                     nearly identical, the loop will visibly jump.
#   check-center.jpg  a mid-rotation frame with red crosshairs at frame
#                     center — the lines should land on the yoyo's axle.
# Defaults keep frames far inside the app's 5 MB/frame limit.
set -euo pipefail

SKIP=""; TARGET=60; WIDTH=1000; PERIOD=""; MAKE_MP4=1; CENTER=1; MARGIN=0.18
LIMIT=96   # centering motion threshold, applied to frame-to-frame differences
           # amplified 8x. The box is per-pixel, so the bar must clear ALL
           # ambient motion, not just the median: sensor noise and — measured
           # on real light-tent footage — the yoyo's own moving reflection on
           # the tent wall reach ~48-90 amplified, while true rotation edges
           # saturate toward 255. 96 tracked the yoyo to the pixel on white,
           # dark, ringed, and splash colorways alike.
MIN_PERIOD=5          # ignore SSIM peaks earlier than this (yoyo is symmetric;
                      # a half-turn can look briefly similar on some finishes)
ANALYZE_FPS=10        # detection sample rate; 10/s at 320px gray is plenty

while getopts "s:n:w:p:Mm:L:C" opt; do
  case $opt in
    s) SKIP=$OPTARG ;;
    n) TARGET=$OPTARG ;;
    w) WIDTH=$OPTARG ;;
    p) PERIOD=$OPTARG ;;
    M) MAKE_MP4=0 ;;
    C) CENTER=0 ;;
    m) MARGIN=$OPTARG ;;
    L) LIMIT=$OPTARG ;;
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

# Finds the yoyo's bounding box across one full rotation — by MOTION, not
# color: the yoyo is the only thing in the shot that rotates, while the tent,
# table, stand, and their shadows hold still. Consecutive sampled frames are
# differenced (tblend), the small luma differences amplified 8x, and ffmpeg's
# bbox filter reports the per-frame box of every pixel that moved — per-PIXEL,
# which matters: cropdetect judges whole rows/columns by average and goes
# blind to a small subject on a wide 4K frame.
#
# Two defenses keep reflections from skewing the result (a rotating yoyo's
# reflection moving on a glossy tent wall IS real motion, and field footage
# showed it stretching naive boxes clear to the frame edge):
#   - The GEOMETRY is robust, not a min/max union: the crop centers on the
#     MEDIAN of the per-frame box centers, sized by 95th-percentile extents,
#     so a flicker in a handful of frames can't drag it.
#   - If the box still isn't yoyo-shaped (much wider than tall, or spanning
#     most of the frame), the threshold ESCALATES 1.5x and tries again, up to
#     twice — dim reflections drop out long before true rotation edges.
# Detection runs at 960px with a median denoise pass; results are scaled back
# to source pixels.
DETECT_W=960
bbox_pass() { # $1=video $2=in-point $3=period $4=source-width $5=threshold -> "X Y W H" if yoyo-shaped
  local log
  log=$(mktemp "${TMPDIR:-/tmp}/spinbbox.XXXXXX")
  $FF -ss "$2" -t "$3" -i "$1" \
    -vf "fps=5,scale=$DETECT_W:-2,format=gray,tblend=all_mode=difference,lutyuv=y='clip(val*8,0,255)',median=radius=1,bbox=min_val=$5,metadata=print:file=$log" \
    -f null - 2>/dev/null
  awk -v sf="$(awk -v iw="$4" -v dw="$DETECT_W" 'BEGIN { printf "%.6f", iw/dw }')" -v dw="$DETECT_W" '
    function sorted(src, n, dst,   i, j, t) {
      for (i = 1; i <= n; i++) dst[i] = src[i]
      for (i = 2; i <= n; i++) { t = dst[i]; j = i - 1
        while (j > 0 && dst[j] > t) { dst[j+1] = dst[j]; j-- }
        dst[j+1] = t }
    }
    /lavfi.bbox.x1=/ { split($0,a,"="); x1[++n]=a[2]+0 }
    /lavfi.bbox.y1=/ { split($0,a,"="); y1[n]=a[2]+0 }
    /lavfi.bbox.x2=/ { split($0,a,"="); x2[n]=a[2]+0 }
    /lavfi.bbox.y2=/ { split($0,a,"="); y2[n]=a[2]+0 }
    END {
      if (n < 20) exit                       # too few moving frames to trust
      for (i = 1; i <= n; i++) {
        cx[i] = (x1[i] + x2[i]) / 2; cy[i] = (y1[i] + y2[i]) / 2
        w[i]  = x2[i] - x1[i] + 1;   h[i]  = y2[i] - y1[i] + 1
      }
      sorted(cx, n, scx); sorted(cy, n, scy); sorted(w, n, sw); sorted(h, n, sh)
      mx = scx[int(n/2)+1]; my = scy[int(n/2)+1]
      p = int(0.95 * n); if (p < 1) p = 1
      bw = sw[p]; bh = sh[p]
      # Yoyo-shaped or bust: reflections stretch boxes wide and shallow, and a
      # bumped camera reads as full-frame motion. Reject both and let the
      # caller escalate the threshold instead of mis-centering.
      if (bw > 1.45 * bh || bw > 0.8 * dw || bw < 0.1 * dw) exit
      printf "%d %d %d %d", (mx - bw/2) * sf, (my - bh/2) * sf, bw * sf, bh * sf
    }
  ' "$log"
  rm -f "$log"
}

detect_bbox() { # $1=video $2=in-point $3=period $4=source-width  -> "X Y W H THRESHOLD" or ""
  local L=$LIMIT try box
  for try in 1 2 3; do
    box=$(bbox_pass "$1" "$2" "$3" "$4" "$L")
    if [ -n "$box" ]; then echo "$box $L"; return; fi
    L=$(awk -v l="$L" 'BEGIN { printf "%d", l * 1.5 }')
  done
}

# Turns a bounding box into a centered square crop with breathing room,
# clamped to the frame. Echoes "W:H:X:Y" for ffmpeg's crop filter, or ""
# when the box spans (nearly) the whole frame — i.e. the background never
# read as background, so cropping would be a guess.
square_crop() { # $1=bx $2=by $3=bw $4=bh $5=iw $6=ih  -> echoes crop args or ""
  awk -v bx="$1" -v by="$2" -v bw="$3" -v bh="$4" -v iw="$5" -v ih="$6" -v m="$MARGIN" '
    BEGIN {
      if (bw >= 0.97*iw && bh >= 0.97*ih) exit   # detection saw no background
      side = (bw > bh ? bw : bh) * (1 + 2*m)
      max = (iw < ih ? iw : ih); if (side > max) side = max
      side = int(side/2)*2
      x = int(bx + bw/2 - side/2); y = int(by + bh/2 - side/2)
      if (x < 0) x = 0; if (y < 0) y = 0
      if (x + side > iw) x = iw - side
      if (y + side > ih) y = ih - side
      printf "%d:%d:%d:%d", side, side, int(x/2)*2, int(y/2)*2
    }'
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

  # Auto-center: find the yoyo across one rotation and build a square crop
  # around it, so it needn't sit dead-center on the turntable.
  cropf=""
  cropnote="full frame"
  if [ "$CENTER" = 1 ]; then
    read -r iw ih <<EOF
$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$video" | tr ',' ' ')
EOF
    bbox=$(detect_bbox "$video" "$inpoint" "$period" "$iw")
    if [ -n "$bbox" ]; then
      read -r bx by bw bh usedL <<EOF
$bbox
EOF
      crop=$(square_crop "$bx" "$by" "$bw" "$bh" "$iw" "$ih")
      if [ -n "$crop" ]; then
        cropf="crop=$crop,"
        cropnote="centered (yoyo at ${bw}x${bh}+${bx}+${by}, motion >= $usedL -> crop $crop)"
      else
        cropnote="full frame (subject box implausible; try -L higher)"
      fi
    else
      cropnote="full frame (no yoyo-shaped motion found; camera moved, or try -L)"
    fi
    echo "   framing: $cropnote"
  fi

  # Stop half a frame-interval short of a full turn: the frame at exactly
  # `period` equals frame 1, and a duplicated endpoint stutters on loop.
  read -r fps dur <<EOF
$(awk -v p="$period" -v t="$TARGET" 'BEGIN { printf "%.4f %.3f", t/p, p*(t-0.5)/t }')
EOF

  rm -rf "$out"; mkdir -p "$out"
  $FF -ss "$inpoint" -t "$dur" -i "$video" -vf "${cropf}fps=$fps,scale=$WIDTH:-2" -q:v 3 "$out/spin_%03d.jpg"
  count=$(ls "$out" | grep -c '^spin_')

  first="$out/spin_001.jpg"
  last="$out/$(ls "$out" | grep '^spin_' | tail -1)"
  $FF -i "$first" -i "$last" -filter_complex hstack "$out/check-loop.jpg"

  # Centering check: a mid-rotation frame (the widest pose) with crosshairs at
  # frame center — the lines should land on the yoyo's axle. Judge this by eye
  # the same way you judge check-loop.jpg.
  mid="$out/$(ls "$out" | grep '^spin_' | awk 'NR==1{n=0} {a[++n]=$0} END{print a[int(n/2)]}')"
  $FF -i "$mid" -vf "drawbox=x=iw/2-1:y=0:w=2:h=ih:color=red@0.8:t=fill,drawbox=x=0:y=ih/2-1:w=iw:h=2:color=red@0.8:t=fill" "$out/check-center.jpg"

  (cd "$out" && rm -f "../$base-spin.zip" && zip -q "../$base-spin.zip" spin_*.jpg)

  if [ "$MAKE_MP4" = 1 ]; then
    $FF -ss "$inpoint" -t "$period" -i "$video" -an -c:v libx264 -preset slow -crf 24 \
      -pix_fmt yuv420p -vf "${cropf}fps=30,scale=1080:-2" -movflags +faststart "$dir/$base-loop.mp4"
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
