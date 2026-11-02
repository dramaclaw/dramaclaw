/** Keep a canvas subscribed, with a bounded reconnect and old-server fallback. */
export const CANVAS_AGENTS_CHANGED_EVENT = "freezone:canvas-agents-changed";
const POLL_MS = 5_000;
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

type Options<T> = {
  projectId: string;
  canvasId: string;
  getAgentIds: () => string[];
  onFrame: (frame: T) => void;
  poll: (agentIds: string[], signal: AbortSignal) => Promise<T[]>;
};

export function startCanvasCommandStream<T>({
  projectId, canvasId, getAgentIds, onFrame, poll,
}: Options<T>): () => void {
  let disposed = false;
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let fallback = false;
  let agents = "";
  let polling = false;
  const abort = new AbortController();

  const deliver = (frame: T) => { if (!disposed) onFrame(frame); };
  const tick = async () => {
    if (disposed || !fallback || polling) return;
    polling = true;
    try {
      const frames = await poll(agents.split(","), abort.signal);
      frames.forEach(deliver);
    } catch {
      // Auth/API can be temporarily unavailable; the shared HTTP client handles auth.
    } finally {
      polling = false;
      if (!disposed && fallback) pollTimer = setTimeout(tick, POLL_MS);
    }
  };
  const stopFallback = () => {
    fallback = false;
    clearTimeout(pollTimer);
  };
  const connect = () => {
    if (disposed) return;
    clearTimeout(reconnectTimer);
    clearTimeout(stableTimer);
    source?.close();
    agents = [...new Set(getAgentIds())].sort().join(",") || "main";
    if (typeof EventSource === "undefined") {
      if (!fallback) {
        fallback = true;
        void tick();
      }
      return;
    }
    // Same root and cookie credentials as lib/api.ts, including the region cookie.
    const url = new URL("/api/v1/chat/canvas-commands/stream", window.location.origin);
    url.search = new URLSearchParams({
      project_id: projectId, canvas_id: canvasId, agent_ids: agents,
    }).toString();
    const current = new EventSource(url.toString(), { withCredentials: true });
    source = current;
    current.onopen = () => {
      if (disposed || source !== current) return;
      stopFallback();
      stableTimer = setTimeout(() => { failures = 0; }, 25_000);
    };
    current.onmessage = (event) => {
      if (disposed || source !== current) return;
      try { deliver(JSON.parse(event.data) as T); } catch { /* Ignore invalid frames. */ }
    };
    current.onerror = () => {
      if (disposed || source !== current) return;
      current.close();
      source = null;
      clearTimeout(stableTimer);
      failures += 1;
      // Native EventSource hides HTTP status, including 404 from older servers.
      if (failures >= 3 && !fallback) {
        fallback = true;
        void tick();
      }
      reconnectTimer = setTimeout(connect, RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)]);
    };
  };
  const refreshAgents = () => {
    const next = [...new Set(getAgentIds())].sort().join(",") || "main";
    if (next !== agents) connect();
  };
  const visible = () => { if (document.visibilityState === "visible") connect(); };
  window.addEventListener(CANVAS_AGENTS_CHANGED_EVENT, refreshAgents);
  window.addEventListener("storage", refreshAgents);
  document.addEventListener("visibilitychange", visible);
  connect();
  return () => {
    disposed = true;
    source?.close();
    abort.abort();
    stopFallback();
    clearTimeout(reconnectTimer);
    clearTimeout(stableTimer);
    window.removeEventListener(CANVAS_AGENTS_CHANGED_EVENT, refreshAgents);
    window.removeEventListener("storage", refreshAgents);
    document.removeEventListener("visibilitychange", visible);
  };
}
