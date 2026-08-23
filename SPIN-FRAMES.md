# Making 360° spins with `spin-frames.sh`

The [360° spin feature](README.md#360-spins-and-video) takes a numbered frame
sequence. Producing one by hand means guessing where your turntable rotation
starts and ends and doing per-clip ffmpeg math. The bundled
[`spin-frames.sh`](spin-frames.sh) automates all of it: point it at a video (or
a folder of them) and it emits, per clip, everything the app can ingest:

- `<name>-spin/` — the extracted frames
- `<name>-spin.zip` — the same frames zipped, for the one-file upload
- `<name>-loop.mp4` — a muted H.264 loop, if you'd rather show a video

## Requirements

`ffmpeg`, `ffprobe`, `zip`, and `bash` — on macOS: `brew install ffmpeg`
(the rest is preinstalled); on Debian/Ubuntu: `apt install ffmpeg zip`.
Nothing here runs on the server; this is a companion tool for wherever your
camera footage lives.

## Usage

```bash
./spin-frames.sh SPIN0001.MP4                 # one clip
./spin-frames.sh clip1.MP4 clip2.MOV          # several
./spin-frames.sh ~/Videos/yoyo-spins/         # every video in a folder
./spin-frames.sh -p 31 ~/Videos/yoyo-spins/   # known turntable period: skip detection
```

| Option | Meaning | Default |
|---|---|---|
| `-p SECONDS` | your turntable's seconds-per-rotation (skips detection) | auto-detect |
| `-s SECONDS` | trim this much lead-in (skips in-point detection) | auto-detect |
| `-n FRAMES` | frames per rotation | 60 (app cap: 180) |
| `-w PIXELS` | output size (square when auto-centered) | 1000 |
| `-M` | skip the loop `.mp4` | off |
| `-C` | don't auto-center — keep the full frame | centering on |
| `-m FRACTION` | breathing room around the yoyo when centering | 0.18 |
| `-L LIMIT` | centering motion threshold, 0-255 (see below) | 96 |

Outputs land next to each input video. Re-running a folder is safe — the
script ignores its own `-loop.mp4` outputs.

## How it finds the in and out points

Two detectors, both plain ffmpeg:

- **In-point** — your hand placing the yoyo (or reaching for the camera)
  spikes the frame-to-frame difference signal (`signalstats` YDIF); a bare
  rotating turntable is low and steady. The clip's in-point is the first
  moment the signal stays calm for two straight seconds.
- **Rotation period** — a reference frame is taken at the in-point, then
  every later frame is scored against it with SSIM (structural similarity).
  The earliest score peak is the moment the yoyo looks like the start
  again: one full rotation. The extraction stops half a frame short of it,
  so the loop wraps without a duplicated-frame stutter.

Each clip reports what was detected (`rotation period: 30.90s (detected,
match 0.971)`) and writes `check-loop.jpg` into the frames folder — the
first and last frame side by side. If those two don't look near-identical,
the loop will visibly jump; trust that image over any score.

### Auto-centering

The yoyo doesn't need to sit dead-center on the turntable. The script finds
it by **motion**: the yoyo is the only thing in the shot that rotates, so
differencing consecutive frames across one full rotation lights up exactly
the yoyo — any colorway, any exposure, white-on-white included — while the
tent, table, stand, and shadows stay dark. ffmpeg's `bbox` filter takes the
per-pixel box of everything that moved (a small speckle-cleanup pass keeps
sensor noise out of it), the boxes are unioned across the rotation, and each
frame is cropped to a square centered on the result before scaling to `-w`.
Frames and the loop `.mp4` get the same framing, so they always match.

The measurement is deliberately paranoid, because field footage earned it:
the crop centers on the **median** of the per-frame boxes (sized by their
95th percentile), so a stray flicker can't drag it — and if the box still
doesn't come out roughly yoyo-shaped, the threshold escalates 1.5× and tries
again, up to twice, before giving up.

Two honest limits:

- **Reflections count as motion.** A rotating yoyo's reflection moving on a
  glossy tent wall or table is real movement — it's why the default threshold
  sits at 96 rather than just above sensor noise, and it's what the automatic
  escalation exists to shed. If a crop still looks off, *raise* `-L`; if part
  of the yoyo is left outside the crop, *lower* it. The box in the script's
  output (`yoyo at WxH+X+Y, motion >= L`) tells you what it saw and which
  threshold finally produced it.
- **The camera must be locked.** Motion detection assumes the only motion is
  the yoyo — a handheld or bumped clip reads as full-frame motion and the
  script falls back to the uncropped frame rather than guessing.

Shoot 4K to give the crop headroom — a 4K frame cropped to the yoyo still
lands well above the 1000px output size, so the frames stay crisp.

### The half-rotation caveat

Half a rotation shows the yoyo's *other* cup. On a centered, two-sided
colorway that mirror view can match the start almost perfectly — so on a
clip too short to contain two full rotations, the detector cannot always
tell a full turn from a half. The script prints a note whenever that
ambiguity exists. A half-rotation loop looks flawless on symmetric yoyos
(and is half the frames); for one-sided art or engravings, record longer
or pass `-p` with your table's true period.

## Recording tips (any camera, any turntable)

- **Lock the camera.** Tripod or propped phone — both detectors assume the
  only motion is the turntable. A handheld clip fails detection.
- **Plain, static background** — a photography light tent is ideal: even
  white keeps period detection strong *and* is what auto-centering needs to
  isolate the yoyo, so placement on the table stops mattering.
- **Shoot 4K at 30fps.** 4K buys crop headroom for auto-centering; 30fps is
  the right rate, not a compromise — frames are extracted at ~2/s and the
  loop renders at 30, so 60fps doubles file size and heat for zero output
  difference (and at 30 the camera spends more bitrate and shutter time on
  each frame, which in a bright tent means cleaner stills).
- **Capture at least one full rotation** after your hand leaves, plus a few
  seconds of margin. Know your table: a "30s" turntable often runs a couple
  of seconds over.
- **Time your table once**, then use `-p` forever — it's faster and immune
  to the half-rotation ambiguity. Run once without `-p` on a long clip
  (two-plus rotations) to measure it.
- Any format ffmpeg decodes works — GoPro, iPhone (rotation metadata is
  honored), Android, mirrorless. One caveat: HDR footage (e.g. iPhone HDR
  video) is tone-flattened naively, so colors may look washed out; shoot
  SDR for product spins if you can.

## Troubleshooting

- **"could not detect a rotation"** — the camera moved, the table stopped,
  or the clip ends before a full turn. Re-shoot, or pass `-p` if you know
  the period.
- **Loop jumps at the wrap** — check `check-loop.jpg`; if the halves
  differ, the detected period was off (wobbling stand, exposure hunting).
  Pass `-p` with a manually timed period.
- **Frames look dim/washed** — HDR source; see recording tips.
