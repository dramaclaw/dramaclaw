/** Selected stretches in their chosen order, snapped exactly as a single render snaps its endpoints. */
export function renderSelection(ranges, fps, duration = Infinity) {
  if (!Array.isArray(ranges) || !ranges.length || ranges.length > 100) throw new Error('ranges: choose 1 to 100 time ranges');
  let count = 0;
  const spans = ranges.map((range) => {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] < 0 || range[1] <= range[0]) throw new Error('a range is [from, to] in seconds, to after from');
    const first = Math.round(range[0] * fps);
    const last = Math.round(Math.min(range[1], duration) * fps);
    if (last <= first) throw new Error(`nothing to render between ${range[0]} and ${range[1]}`);
    const span = { from: first / fps, to: last / fps, first, at: count, count: last - first };
    count += span.count;
    return span;
  });
  return { spans, count, duration: count / fps };
}

/** The source frame for a frame on the joined timeline. Repeated or overlapping stretches remain repeated. */
export function selectionFrame(spans, frame) {
  const span = spans.find((part) => frame < part.at + part.count) ?? spans.at(-1);
  return span.first + Math.max(0, Math.min(span.count - 1, frame - span.at));
}

/** Trim the film's mix clips to each stretch and place them consecutively, retaining speed, gain and fade phase.
 * @template {{ at: number, from: number, to?: number, speed?: number, fade?: { skip: number } }} T
 * @param {T[]} clips @param {readonly { from: number, to: number }[]} ranges @returns {T[]}
 */
export function selectionClips(clips, ranges) {
  let offset = 0;
  return ranges.flatMap(({ from, to }) => {
    const at = offset;
    offset += to - from;
    return clips.flatMap((clip) => {
      const speed = clip.speed ?? 1;
      const start = Math.max(from, clip.at);
      const end = Math.min(to, clip.at + ((clip.to ?? Infinity) - clip.from) / speed);
      if (end <= start) return [];
      const skip = start - clip.at;
      return [{ ...clip, at: at + start - from, from: clip.from + skip * speed, to: clip.from + (end - clip.at) * speed,
        ...(clip.fade ? { fade: { ...clip.fade, skip: clip.fade.skip + skip } } : {}) }];
    });
  });
}
