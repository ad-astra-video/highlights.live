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
# the score-digit band the 1 fps state sweep reads (the correction in revision 2)
ffmpeg -ss <t> -i bb_q1_1100_1950.mp4 -frames:v 1 \
    -vf 'crop=150:44:606:638,scale=900:264:flags=neighbor' digits.png
```

`<t>` is always **clip seconds** (0-849). Source seconds = clip seconds + 1100.


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
   apart, players lined up at the line at source t=1171/1180).
4. A non-event window is a 20 s window that lies strictly inside a score-stable
   interval — the state intervals in `coverage.state_intervals_clip_s` of the
   label manifest — so no scoring transition can fall inside it. **No** non-event
   window contains a transition; that was checked against the transition list, not
   assumed. Each window was also liveness-checked on a 320 px frame and classed
   `live_play_no_score` (hard negative) or `dead_ball` (stoppage).
5. A catalogue of score states is authoritative for **scoring events**, not for
   the whole-video basket count: the span is one continuous feed (Q1 into early
   Q2, period flag `1.Ç` until clip ≈660 s, `2.Ç` after), so no cut/replay breaks
   the digit timeline.
6. **Revision 2 (after ADAAAA-7770).** The first catalogue placed each instant at
   the *last* frame of the state it named (7-69 s late) and missed the final
   transition. Revision 2 derives the states by template-matching the 1 fps digit
   band for the whole clip against 16 pixel-read states (unambiguous: 16 runs, 15
   transitions, no flicker), takes the instant as the first frame showing the new
   digits, and re-derives the non-event window `score` strings from the state
   intervals. Reproduce the sweep with the `digits.png` crop above at 1 s steps
   and compare each crop against the state at clip t=5/40/74/110/153/200/260/330/
   420/467/476/510/600/750/790/830 s (the state representatives).


## What is deliberately absent

There is no frame-level **detection** slice (per-frame `player` / `hoop` /
`basketball` boxes) in this set. Detection boxes need native-resolution
inspection per object; that labelling pass is not part of ADAAAA-7765 and
`detect_precision.py` therefore has no basketball label space yet
(`evalSet.vocabulary = ("score",)`). Do not substitute fixture boxes for it.
