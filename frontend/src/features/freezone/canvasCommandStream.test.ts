import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANVAS_AGENTS_CHANGED_EVENT, startCanvasCommandStream } from "./canvasCommandStream";
import { addFreezoneCanvasAgent, loadFreezoneCanvasAgentsWithSource } from "./canvasAgents";

class Source {
  static instances: Source[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn();
  constructor(public url: string, public options: unknown) { Source.instances.push(this); }
}
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  Source.instances = [];
  vi.stubGlobal("EventSource", Source);
});
afterEach(() => {
  dispose?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function start(getAgentIds = () => ["main"]) {
  const onFrame = vi.fn();
  const poll = vi.fn().mockResolvedValue([{ bridge_key: "fallback" }]);
  dispose = startCanvasCommandStream({ projectId: "p", canvasId: "c", getAgentIds, onFrame, poll });
  return { onFrame, poll };
}

describe("canvas command stream", () => {
  it("uses cookies, forwards frames and does not poll a healthy connection", async () => {
    const { onFrame, poll } = start();
    const source = Source.instances[0];
    expect(source.options).toEqual({ withCredentials: true });
    expect(new URL(source.url).pathname).toBe("/api/v1/chat/canvas-commands/stream");
    source.onopen?.();
    source.onmessage?.({ data: '{"bridge_key":"one"}' });
    expect(onFrame).toHaveBeenCalledWith({ bridge_key: "one" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).not.toHaveBeenCalled();
    expect(Source.instances).toHaveLength(1);
  });

  it("retries at 1, 2, 5 seconds then falls back every five seconds", async () => {
    const { poll } = start();
    Source.instances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(999);
    expect(Source.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    Source.instances[1].onerror?.();
    await vi.advanceTimersByTimeAsync(2_000);
    Source.instances[2].onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(Source.instances).toHaveLength(4);
    expect(poll).toHaveBeenCalledTimes(2);
    Source.instances[3].onopen?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("rebuilds on changed agents and closes timers on cleanup", async () => {
    let agents = ["main"];
    start(() => agents);
    window.dispatchEvent(new Event(CANVAS_AGENTS_CHANGED_EVENT));
    expect(Source.instances).toHaveLength(1);
    agents = ["main", "agent-two"];
    window.dispatchEvent(new Event(CANVAS_AGENTS_CHANGED_EVENT));
    expect(Source.instances[0].close).toHaveBeenCalled();
    expect(new URL(Source.instances[1].url).searchParams.get("agent_ids")).toBe("agent-two,main");
    Source.instances[1].onerror?.();
    dispose?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Source.instances).toHaveLength(2);
  });

  it("keeps the connection while hidden and refreshes on return", () => {
    start();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(Source.instances[0].close).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(Source.instances[0].close).toHaveBeenCalled();
    expect(Source.instances).toHaveLength(2);
    vi.restoreAllMocks();
  });
});

it("falls back when EventSource is unavailable and cancels in-flight polling", async () => {
  vi.stubGlobal("EventSource", undefined);
  const { poll } = start();
  await vi.advanceTimersByTimeAsync(0);
  expect(poll).toHaveBeenCalledTimes(1);
  const signal = poll.mock.calls[0][1] as AbortSignal;
  dispose?.();
  expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(poll).toHaveBeenCalledTimes(1);
});

it("ignores stale callbacks after the canvas subscription is disposed", () => {
  const { onFrame } = start();
  const source = Source.instances[0];
  dispose?.();
  source.onmessage?.({ data: '{"bridge_key":"late"}' });
  source.onerror?.();
  expect(onFrame).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("reading the actual agent store does not recursively reconnect", () => {
  window.localStorage.clear();
  start(() => loadFreezoneCanvasAgentsWithSource("p", "c").state.agents.map((agent) => agent.id));
  expect(Source.instances).toHaveLength(1);
  addFreezoneCanvasAgent("p", "c", 2_000);
  expect(Source.instances).toHaveLength(2);
  expect(Source.instances[0].close).toHaveBeenCalledTimes(1);
  expect(new URL(Source.instances[1].url).searchParams.get("agent_ids")).toBe("agent-2000,main");
});
