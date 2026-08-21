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
| `-w PIXELS` | frame width | 1000 |
| `-M` | skip the loop `.mp4` | off |

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
- **Plain, static background,** with the yoyo filling a good share of the
  frame. The similarity signal is strongest when the subject dominates.
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
