// SPDX-License-Identifier: Elastic-2.0
export const GRASS_STEP_SOURCES = [1, 2, 3].map(index =>
  `/piko/world/audio/grass-step-${index}-v1.wav`);

/** Separate from UI sounds: short contact events, not a looping recording. */
export function createGrassFootsteps() {
  const abort = new AbortController();
  let context: AudioContext | undefined;
  let disposed = false;
  let previous = -1;
  const buffers: AudioBuffer[] = [];
  const playing = new Set<AudioBufferSourceNode>();
  try {
    const Context = window.AudioContext ?? (window as unknown as {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;
    if (Context) {
      context = new Context();
      const decoder = context;
      void Promise.allSettled(GRASS_STEP_SOURCES.map(async src => {
        const response = await fetch(src, {signal: abort.signal});
        if (!response.ok) throw new Error("Footstep audio unavailable");
        return decoder.decodeAudioData(await response.arrayBuffer());
      })).then(results => {
        if (!disposed) for (const result of results) {
          if (result.status === "fulfilled") buffers.push(result.value);
        }
      }).catch(() => {});
    }
  } catch { /* A missing audio device must not prevent movement. */ }
  const stop = () => {
    playing.forEach(source => { try { source.stop(); } catch { /* Already ended. */ } });
    playing.clear();
  };
  const unlock = () => {
    if (!disposed && context && context.state !== "running" && context.state !== "closed") void context.resume().catch(() => {});
  };
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);
  document.addEventListener("touchend", unlock, true);
  return {
    unlock,
    step() {
      if (disposed || context?.state !== "running" || !buffers.length) return;
      // Choose a different recording each contact without changing pitch.
      const index = previous < 0 ? 0 : (previous + 1 + Math.floor(Math.random() * (buffers.length - 1))) % buffers.length;
      previous = index;
      if (playing.size >= 2) stop();
      try {
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = buffers[index];
        gain.gain.value = 1.2;
        source.connect(gain).connect(context.destination);
        playing.add(source);
        source.onended = () => { playing.delete(source); source.disconnect(); gain.disconnect(); };
        source.start();
      } catch { /* Audio-device changes must not interrupt the movement ticker. */ }
    },
    stop,
    destroy() {
      disposed = true;
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
      document.removeEventListener("touchend", unlock, true);
      abort.abort();
      stop();
      buffers.length = 0;
      if (context && context.state !== "closed") void context.close().catch(() => {});
    },
  };
}
