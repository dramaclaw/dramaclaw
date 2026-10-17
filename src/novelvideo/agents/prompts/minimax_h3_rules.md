# MiniMax H3 prompt rules

Used by `agents/minimax_h3_prompt_builder.py` to compile a drama beat into
the official MiniMax H3 prompt format. Sources: the official HF guides
(`MiniMaxAI/MiniMax-H3/docs/VIDEO_PROMPT_WRITING_GUIDE_{base,ref}_en.md`),
the `photoreal-short-drama-generator` project's production convention
(`references/規則核心.md`, `3-提示詞.md`), and the community skills in
`github.com/gordonlu/awesome-minimax-h3-skills/community-skills`
(`h3-performance-director`, `h3-micro-cinematic-director`,
`cinematic-key-art-animator`, `reference-motion-transfer`,
`h3-keyframe-film`, `h3-shot-pattern-library`). Edit this file to tune the
rewriter without touching code.

## Output format

**ref2va** (used whenever there is at least one reference image besides the
first frame): six sections, each on its own line, in this exact order, all
in English except dialogue:

```
subject_definitions:
...

summary:
...

retention_analysis:
...

detailed_description:
...

overall_soundscape:
...

non_diegetic_music:
...
```

**fl2va** (first frame only, no references): the official alignment
sentence, a blank line, then three sections:

```
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description:
...

overall_soundscape:
...

non_diegetic_music:
...
```

## Rules

1. **One beat = one continuous event, exactly one `[Shot 1]`.** The
   literal text `[Shot 1]` (square brackets included) MUST appear exactly
   once, at the start of the first sentence of `detailed_description`
   (ref2va) or `integrated_multimodal_description` (fl2va) — e.g.
   "`[Shot 1]` At 0.00 seconds, ..." — never omit the bracketed marker
   and never add a `[Shot 2]`. No cut, reverse shot or insert — a
   multi-shot story is a separate clip per shot, not sections inside this
   one. [micro-cinematic §1; keyframe-film]

2. **Opening line.**
   - fl2va: the verbatim alignment sentence above, followed by a blank
     line, then the three sections.
   - ref2va: **the literal tag `<Picture 1>` MUST appear inside the very
     first sentence of `detailed_description`**, immediately after
     `[Shot 1]` — e.g. "`[Shot 1]` At 0.00 seconds, ... fully matching
     `<Picture 1>`: ...". This is a hard requirement, not optional
     phrasing — a `detailed_description` that never writes the literal
     `<Picture 1>` tag anywhere is a hard error, exactly like a
     `<Picture N>` reference image you forgot to cite. It reinforces the
     frame-0 pin applied separately via `MiniMaxH3AddGuide`.
     [keyframe-film; reference-motion-transfer]

3. **Build on the first frame; don't re-stage it.** Allowed camera: locked
   static, a short single push-in, or one brief lateral track — never an
   orbit, never a move that goes behind the subject, never an abrupt
   angle switch. If the beat has more than one character and the camera
   move risks losing track of identity, downgrade to a locked static
   shot. At most one camera move, and only with a visible reason tied to
   the action (never "cinematic"/"dynamic"/"dramatic" as the reason). With
   no reason, write: "The camera holds a static shot throughout."
   [shot-pattern-library §5/§32; micro-cinematic Rules 3-4]

4. **Budget the beat by its duration** (`detailed_description`'s pacing,
   roughly 2-3 Vietnamese syllables per spoken second):
   - 5s: 2-3 beats of action, one action + one recovery.
   - 6-9s: 3-5 beats, one action chain + one performance turn.
   - 10-12s: two phases — a main chain, then a secondary response.
   - A visible change should occur every 1-2 seconds; the hook (first
     visible change) lands within 0.5-0.8s; the peak lands at 60-80% of
     the duration, never on the last frame; hold 0.5-1.0s at the very end
     on a stable pose. Timestamps are written `X.XX`, and the last one
     equals the total duration. [micro-cinematic §4/§13; performance-director §29; key-art-animator §7]

5. **Emotion → objective → tactic → one visible gesture.** Never write a
   bare emotion adjective ("she looks nervous"); always convert it into
   an observable behavior (a half-step retreat, a tightened jaw, hands
   clasped). For subtext, pair the surface action with exactly one
   contradictory body cue (e.g. she says "I'm fine" while taking half a
   step back). At most one performance turn per clip — do not chain
   fear → anger → sadness → confidence into one beat.
   [performance-director §2-5]

6. **A speaking beat is "planted action":** feet stay put, but there is at
   least one multi-joint upper-body change (a lean, a turn, a hand that
   reaches then pauses). Blink, breathing, or a camera push-in alone does
   not count as motion. Non-speaking characters in the same shot get
   micro-motion only (a breath, a blink, a small gaze shift) — never a
   frozen background figure. [cinematic-key-art-animator §9-10; performance-director §30-31]

7. **Dialogue.**
   - **If you are given a line to speak, it MUST appear inside a `<d>`
     tag somewhere in `detailed_description` — never silently drop it.**
     A prompt that is otherwise well-formed but simply never quotes the
     given line is still wrong; there is no valid reason to omit it.
   - **One given line = one `<d>` tag, even if it has several sentences.**
     Do not split a single speaker's one line into multiple separate
     `<d>` tags sentence-by-sentence — that reads as several distinct
     speech events with gaps between them, not one continuous line.
   - Keep the spoken line verbatim, in its original language, inside
     `<d>[Language] ...</d>` (e.g. `<d>[Vietnamese] Anh với ai mà nhắn nhớ
     nhau vậy?</d>`). **Never translate the line into another language,
     even when every other sentence in the prompt is in English** — the
     `[Language]` tag and the words inside `<d>` must both match the
     line's actual original language, copied character-for-character.
     Attach it to a named, on-screen `<Subject N> (S1)` (or state
     explicitly that the voice is off-screen). Describe the voice
     outside the tag: gender, age, timbre, accent/regional note,
     delivery (e.g. "a warm medium-pitched Vietnamese woman, anxious,
     speaking in a tense, quiet tone, at a normal pace").
   - **More than one speaker in one beat:** if given several lines, one
     per speaker, write one `<d>` turn per line, in the given order,
     each with its own stable `(S1)`, `(S2)`, ... id tied to that
     speaker. Never merge two speakers' lines into a single turn, never
     invent an extra line for a speaker who wasn't given one, and keep
     each line exactly as given.
   - If a voice-timbre reference audio is attached, say so: "... in the
     timbre referenced from `<Audio 1>`."
   - "Exact lines, no added words" — never paraphrase, translate, or add a
     parenthetical translation.
   - Make sure the line's natural reading length fits inside the beat's
     allotted window (roughly 2-3 Vietnamese syllables per second); if it
     clearly does not fit, shorten the performance around it rather than
     the line itself and flag it.
   - Always close dialogue with: "Exactly as the voice stops, the lips
     close and the jaw ceases all speaking motion. This single line is
     the only speech in the video."
     [anthology §1.3; reference-motion-transfer §8.6; photoreal 規則核心]

8. **Never let text render on screen.** Every section must say there are
   no subtitles, captions, on-screen text, logos or watermarks anywhere
   in frame. Never use a double quote `"` outside `<d>...</d>` — H3 can
   render quoted text literally on screen. **This includes wrapping a
   `<d>` tag itself in quotes** — write `he says: <d>[English] ...</d>`,
   never `he says: "<d>[English] ...</d>"`; the tag already marks it as
   spoken, a quote mark right before or after it is still a stray quote.

9. **Identity.**
   - **Describe what you actually see in the attached images — not what a
     text hint says.** You have been shown the real first frame and every
     reference image, each labeled with its `<Picture N>` tag. A
     character's recorded `appearance_details` text, when given, is only
     ever a supplementary hint — the image is authoritative. Never let a
     text hint override, contradict, or fill in a detail the image itself
     doesn't show; if the two disagree, trust the image. When there is no
     text hint at all, describe the subject from the image alone (you can
     still see its hair, face, and clothing directly — there is no need to
     fall back to a generic "matches the picture" statement unless the
     image genuinely isn't visible/attached).
   - **Keep `subject_definitions` brief — this is an identity anchor, not
     a full description.** The attached image already carries every visual
     detail; this text only needs enough for the model to lock onto the
     right identity and not drift. One short clause, **2-3 visual anchors
     maximum** (e.g. hair + one outfit color/item), under ~15 words per
     subject — never a long list of separate features (face shape, exact
     accessory, fabric texture, etc.). This budget matters: everything
     else in the prompt (the full shot, every dialogue line, timing) still
     has to fit and stay correct, and an overloaded `subject_definitions`
     measurably increases the odds of a different section (most often the
     dialogue) getting dropped or malformed. Never personality, backstory,
     or plot information (this also prevents the reference card's
     unrelated context leaking into the shot). **Every subject that has a
     reference image MUST cite its `<Picture N>` tag directly inside its
     `subject_definitions` sentence** — e.g. "`<Subject 1>` is Nikola
     Tesla, on the character sheet `<Picture 2>`, with ..." — never
     describe a referenced subject's appearance without naming the
     picture it comes from; a reference image attached but never cited
     anywhere in the prompt is a hard error.
   - `retention_analysis` states, per subject: "`<Subject N>` appears in
     [Shot 1]: fully_preserved - [identity/proportions/outfit] stay
     consistent." Use `partially_preserved` for a scene/prop reference
     that only lends lighting/mood, not identity.
   - When the beat has exactly one character, add: "No costume change, no
     face change, no second person." [reference-motion-transfer; verify-recurring-identity-board; h3-keyframe-film]

10. **Anti-freeze.** Always include: "Do not replace character action with
    camera movement, lighting changes, particles, fog, or environmental
    effects. All motion happens at natural real-time speed, not slow
    motion." Avoid "slowly / gently / gradually / subtle / lingering"
    unless the beat is deliberately a calm, still moment.
    [cinematic-key-art-animator §3/§6]

11. **Ending and continuity.** End on an explicit stable pose, gaze and
    prop state — never "continues ..." or "keeps ...". Props must not
    switch hands or location without an explained action; keep one
    consistent light direction throughout. [performance-director Rule 5; h3-reality-physics-guard §4.7-4.8]

12. **Sound.**
    - `overall_soundscape`: 1-4 sentences of diegetic sound tied to the
      visible action (room tone, footsteps, cloth, a door).
    - `non_diegetic_music`: 1-3 sentences describing genre/tempo/mood
      through instrumentation and pacing (not bare mood words), or
      exactly `N/A` if there is none. Never ask for music while also
      writing "no BGM" — pick one. [anthology]

13. **9:16 short-drama framing.** Favor medium shot / medium close-up /
    close-up; keep faces, eyes and the pressure of the relationship
    central to the frame. Write realistic short-drama acting, not
    theatrical/stage delivery. Target 350-500 English words for
    `detailed_description` on a ref2va beat (stay near the low end for a
    5-8s beat). [anthology; official ref guide]

## Self-check before returning (mirrors the lint)

- Exactly one `[Shot 1]`; sections present, in order, correctly labeled.
- `<Picture N>` tags are numbered 1..N matching the attached images, in
  the order they were attached (first frame is always `<Picture 1>`).
  **Check `<Picture 1>` specifically** — it's easy to cite every reference
  image but forget the first frame itself; the very first sentence of
  `detailed_description`, right after `[Shot 1]`, must contain it.
- No bare emotion adjective with no accompanying behavior.
- At most one camera-move verb/phrase.
- Every `<d>` line has a language tag and a named or explicitly
  off-screen speaker.
- No `"` outside `<d>`.
- Last timestamp equals the beat duration.
- `non_diegetic_music` is present (text or `N/A`).
- Does not end on "continues"/"keeps".

If more than a few of these would fail, restart the plan rather than patch
sentence by sentence (one dominant performance intention, one shot
pattern, one ending).
