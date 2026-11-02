# Basketball held-out set — how the frames and labels were produced

The clip itself is **not** committed. It is a rights-cleared box-side artifact:

- source: Wikimedia Commons, `Merkezefendi Belediyesi Denizli Basket - Samsunspor (24.01.20).webm`
- rights basis: **CC BY 3.0**, author/uploader TBF (Turkish Basketball Federation)
- full-file sha256: `480ed20174e9718aea2c32a77f0b0b26e779dc4e6abcc4b0fb82433c02f74149`
  (1,039,515,202 bytes, 6266.781 s, 1280x720, 30 fps, vp9 + opus)
- clip-root copy used by the harnesses: `bb_q1_1100_1950.mp4`
  (`ffmpeg -ss 1100 -t 850 -i <source> -c:v libx264 -preset veryfast -crf 26
  -c:a aac -b:a 128k`), frame-accurate, 850 s, audio decoded at 8 kHz by the harness

Any reader can re-derive every frame the labels cite:

```sh
# a liveness frame for a non-event window
ffmpeg -ss <t> -i bb_q1_1100_1950.mp4 -frames:v 1 -vf scale=320:-2 frame.jpg
# the score overlay crop the digit reads come from (source-frame geometry)
ffmpeg -ss <t> -i bb_q1_1100_1950.mp4 -frames:v 1 \
    -vf 'crop=760:130:260:570,scale=456:-2' score.jpg
```

## Label discipline

1. Labels were read from the pixels only. Scoring instants come from the broadcast
   score overlay: the score digits were read at native resolution at every state
   change, and the event instant is the **first 1 fps frame whose digits show the
   new score**. No label comes from decide's reason text, a detection model, or a
   model's own output, and nothing here is inherited from the soccer set.
2. A score delta of 1 is a free throw, 2 a field goal, 3 a three-pointer. The
   delta is the digit difference; it is not a claim about shot type.
3. Precision is bounded by the 1 fps grid: the instant is ±1 s. Free-throw
   transitions were corroborated by the frames themselves (two +1 deltas 9 s
   apart, players lined up at the line at t=1169/1178).
4. A non-event window is a 20 s window that lies strictly inside a score-stable
   interval (the score reads are identical on both sides of the interval and the
   increment belongs to the next event), so no scoring event can fall inside it.
   Each window was also liveness-checked on a 320 px frame and classed
   `live_play_no_score` (hard negative) or `dead_ball` (stoppage).
5. A catalogue of score states is authoritative for **scoring events**, not for
   the whole-video basket count: the span is one continuous quarter of play, so
   no cut/replay breaks the digit timeline.

## What is deliberately absent

There is no frame-level **detection** slice (per-frame `player` / `hoop` /
`basketball` boxes) in this set. Detection boxes need native-resolution
inspection per object; that labelling pass is not part of ADAAAA-7765 and
`detect_precision.py` therefore has no basketball label space yet
(`evalSet.vocabulary = ("score",)`). Do not substitute fixture boxes for it.
