// @ts-check
/**
 * Versions saved on their own while a project is worked on, when the person turned Auto versions on (prefs.mjs
 * `autoVersions`). Only for projects open in Studio (the ones someone watches), and only when something changed since
 * the last version (history.mjs saveVersion gives null otherwise). The moments:
 *
 *   an app's agent starts a turn     what was there before it ('agent'), to come back to if the turn goes wrong
 *   that turn ends                   what it did ('auto')
 *   the folder rests for IDLE_MS     after the person's edits, or an agent's that the app does not run ('auto'); at
 *                                    most MAX_MS after the first change of a stretch of work that never rests
 *   the project is closed            what changed since the last version, if a rest was still awaited ('auto')
 *
 *   const auto = createAutoVersions({ on: () => readPrefs().autoVersions, working: agentIn, roots: watchers.roots, save });
 *   auto.changed(root)   // on each change of the folder
 *   auto.start() … auto.stop()
 */

export const IDLE_MS = 2 * 60_000;
export const MAX_MS = 10 * 60_000;
/** How often whether an app's agent is working is looked at. */
export const POLL_MS = 3_000;

/**
 * @param {{ on: () => boolean, working: (root: string) => boolean, roots: () => string[],
 *   save: (root: string, kind: 'auto' | 'agent') => Promise<unknown>, idleMs?: number, maxMs?: number, pollMs?: number }} o
 */
export function createAutoVersions({ on, working, roots, save, idleMs = IDLE_MS, maxMs = MAX_MS, pollMs = POLL_MS }) {
  /** @type {Map<string, { timer: NodeJS.Timeout | null, since: number | null, agent: boolean }>} per project */
  const projects = new Map();
  /** @type {NodeJS.Timeout | null} */
  let polling = null;

  const of = (/** @type {string} */ root) => {
    let p = projects.get(root);
    if (!p) { p = { timer: null, since: null, agent: working(root) }; projects.set(root, p); }
    return p;
  };
  const saveNow = (/** @type {string} */ root, /** @type {'auto' | 'agent'} */ kind) => {
    const p = projects.get(root);
    if (p) { if (p.timer) clearTimeout(p.timer); p.timer = null; p.since = null; }
    void save(root, kind).catch(() => {});
  };

  const poll = () => {
    const open = new Set(roots());
    for (const [root, p] of projects) {
      if (open.has(root)) continue;
      if (p.timer && on()) saveNow(root, 'auto');
      else if (p.timer) clearTimeout(p.timer);
      projects.delete(root);
    }
    if (!on()) return;
    for (const root of open) {
      const p = of(root);
      const now = working(root);
      if (now === p.agent) continue;
      p.agent = now;
      saveNow(root, now ? 'agent' : 'auto');
    }
  };

  return {
    /** The folder at `root` changed: a version once it rests, unless an app's agent is mid-turn (saved when it ends). */
    changed(/** @type {string} */ root) {
      if (!on()) return;
      const p = of(root);
      if (p.agent) return;
      p.since ??= Date.now();
      if (p.timer) clearTimeout(p.timer);
      const wait = Math.max(0, Math.min(idleMs, p.since + maxMs - Date.now()));
      p.timer = setTimeout(() => saveNow(root, 'auto'), wait);
      p.timer.unref?.();
    },
    poll,
    start() {
      polling ??= setInterval(poll, pollMs);
      polling.unref?.();
    },
    stop() {
      if (polling) clearInterval(polling);
      polling = null;
      for (const p of projects.values()) if (p.timer) clearTimeout(p.timer);
      projects.clear();
    },
  };
}
