// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createStreamClient } from "@/task-center/stream-client";
import { sampleTask } from "@/__mocks__/msw/handlers/tasks";

const PROJECT_STREAM_PATH = "/api/v1/projects/demo/tasks/stream";

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials: boolean;
  readyState = 0;
  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  onerror: ((e: Event) => void) | null = null;
  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    this.readyState = 1;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(cb);
  }
  dispatch(type: string, data: unknown) {
    const evt = new MessageEvent(type, { data: JSON.stringify(data) });
    this.listeners.get(type)?.forEach((cb) => cb(evt));
  }
  triggerError() {
    this.onerror?.(new Event("error"));
  }
  close() {
    this.readyState = 2;
  }
}

beforeEach(() => {
  MockEventSource.instances.length = 0;
  // @ts-expect-error — replace global EventSource in test env
  globalThis.EventSource = MockEventSource;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("stream-client", () => {
  it("opens exactly one EventSource with cookie credentials", () => {
    const client = createStreamClient({ streamPath: PROJECT_STREAM_PATH, onEvent: vi.fn(), onDelete: vi.fn(), onHealth: vi.fn() });
    client.start();
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toContain(PROJECT_STREAM_PATH);
    // Cookie-backed auth: the URL carries no credential query param;
    // credentials ride on the HttpOnly cookie via withCredentials.
    expect(MockEventSource.instances[0].url).not.toContain("token=");
    expect(MockEventSource.instances[0].withCredentials).toBe(true);
    client.close();
  });

  it("parses task_updated events with source tag", () => {
    const onEvent = vi.fn();
    const client = createStreamClient({streamPath: PROJECT_STREAM_PATH, onEvent, onDelete: vi.fn(), onHealth: vi.fn() });
    client.start();
    const es = MockEventSource.instances[0];
    const task = sampleTask();
    es.dispatch("task_updated", task);
    expect(onEvent).toHaveBeenCalledWith(task, expect.stringMatching(/^(snapshot|live)$/));
    client.close();
  });

  it("calls onDelete on deleted events", () => {
    const onDelete = vi.fn();
    const client = createStreamClient({streamPath: PROJECT_STREAM_PATH, onEvent: vi.fn(), onDelete, onHealth: vi.fn() });
    client.start();
    MockEventSource.instances[0].dispatch("deleted", { task_key: "abc" });
    expect(onDelete).toHaveBeenCalledWith("abc");
    client.close();
  });

  it("reports health transitions (connecting → connected via heartbeat)", () => {
    const onHealth = vi.fn();
    const client = createStreamClient({streamPath: PROJECT_STREAM_PATH, onEvent: vi.fn(), onDelete: vi.fn(), onHealth });
    client.start();
    expect(onHealth).toHaveBeenCalledWith("connecting");
    MockEventSource.instances[0].dispatch("heartbeat", { ts: "now" });
    expect(onHealth).toHaveBeenLastCalledWith("connected");
    client.close();
  });

  it("transitions to reconnecting on error with backoff", () => {
    const onHealth = vi.fn();
    const client = createStreamClient({streamPath: PROJECT_STREAM_PATH, onEvent: vi.fn(), onDelete: vi.fn(), onHealth });
    client.start();
    MockEventSource.instances[0].triggerError();
    expect(onHealth).toHaveBeenCalledWith("reconnecting");
    vi.advanceTimersByTime(1100); // 1s backoff
    expect(MockEventSource.instances).toHaveLength(2);
    client.close();
  });

  it("transitions to polling on the 3rd failed reconnect (>= 3, not > 3)", () => {
    const onHealth = vi.fn();
    const onPollingStart = vi.fn();
    const client = createStreamClient({
      streamPath: PROJECT_STREAM_PATH,
      onEvent: vi.fn(),
      onDelete: vi.fn(),
      onHealth,
      onPollingStart,
    });
    client.start();
    MockEventSource.instances[0].triggerError();
    vi.advanceTimersByTime(1100);
    MockEventSource.instances[1].triggerError();
    vi.advanceTimersByTime(2100);
    MockEventSource.instances[2].triggerError();
    expect(onHealth).toHaveBeenCalledWith("polling");
    expect(onPollingStart).toHaveBeenCalledOnce();
    client.close();
  });

  it("polling retry cadence is a flat 15s (not exponential)", () => {
    const client = createStreamClient({
      streamPath: PROJECT_STREAM_PATH,
      onEvent: vi.fn(),
      onDelete: vi.fn(),
      onHealth: vi.fn(),
      pollingRetryMs: 15_000,
    });
    client.start();
    MockEventSource.instances[0].triggerError();
    vi.advanceTimersByTime(1100);
    MockEventSource.instances[1].triggerError();
    vi.advanceTimersByTime(2100);
    MockEventSource.instances[2].triggerError(); // → polling
    const before = MockEventSource.instances.length;
    vi.advanceTimersByTime(14_000);
    expect(MockEventSource.instances.length).toBe(before);
    vi.advanceTimersByTime(1_500);
    expect(MockEventSource.instances.length).toBe(before + 1);
    client.close();
  });

  it("recovers from polling on heartbeat alone (no task_updated needed)", () => {
    const onHealth = vi.fn();
    const onPollingStop = vi.fn();
    const client = createStreamClient({
      streamPath: PROJECT_STREAM_PATH,
      onEvent: vi.fn(),
      onDelete: vi.fn(),
      onHealth,
      onPollingStop,
    });
    client.start();
    MockEventSource.instances[0].triggerError();
    vi.advanceTimersByTime(1100);
    MockEventSource.instances[1].triggerError();
    vi.advanceTimersByTime(2100);
    MockEventSource.instances[2].triggerError();
    vi.advanceTimersByTime(15_000);
    MockEventSource.instances[3].dispatch("heartbeat", { ts: "now" });
    expect(onHealth).toHaveBeenLastCalledWith("connected");
    expect(onPollingStop).toHaveBeenCalledOnce();
    client.close();
  });

  it("stops an established stream when the session probe confirms auth loss", async () => {
    const checkSession = vi.fn(async () => false);
    const onHealth = vi.fn();
    const client = createStreamClient({
      streamPath: PROJECT_STREAM_PATH,
      onEvent: vi.fn(),
      onDelete: vi.fn(),
      onHealth,
      checkSession,
    } as Parameters<typeof createStreamClient>[0] & {
      checkSession: () => Promise<boolean>;
    });
    client.start();
    MockEventSource.instances[0].dispatch("heartbeat", { ts: "healthy" });

    MockEventSource.instances[0].triggerError();
    await vi.advanceTimersByTimeAsync(1_100);
    MockEventSource.instances[1].triggerError();
    await vi.advanceTimersByTimeAsync(2_100);
    MockEventSource.instances[2].triggerError();
    await vi.advanceTimersByTimeAsync(0);

    expect(checkSession).toHaveBeenCalledOnce();
    expect(onHealth).toHaveBeenLastCalledWith("failed");
    const countAfterAuthLoss = MockEventSource.instances.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(MockEventSource.instances).toHaveLength(countAfterAuthLoss);
  });

  it.each([
    ["5xx result", vi.fn(async () => null)],
    ["network failure", vi.fn(async () => Promise.reject(new Error("offline")))],
  ])("keeps reconnecting when the session probe has a transient %s", async (_case, checkSession) => {
    const client = createStreamClient({
      streamPath: PROJECT_STREAM_PATH,
      onEvent: vi.fn(),
      onDelete: vi.fn(),
      onHealth: vi.fn(),
      checkSession,
      pollingRetryMs: 15_000,
    });
    client.start();
    MockEventSource.instances[0].dispatch("heartbeat", { ts: "healthy" });

    MockEventSource.instances[0].triggerError();
    await vi.advanceTimersByTimeAsync(1_100);
    MockEventSource.instances[1].triggerError();
    await vi.advanceTimersByTimeAsync(2_100);
    MockEventSource.instances[2].triggerError();
    await vi.advanceTimersByTimeAsync(15_100);

    expect(checkSession).toHaveBeenCalledOnce();
    expect(MockEventSource.instances).toHaveLength(4);
    client.close();
  });

  it("closes immediately when the shared session-expired event fires", () => {
    const client = createStreamClient({
      streamPath: PROJECT_STREAM_PATH,
      onEvent: vi.fn(),
      onDelete: vi.fn(),
      onHealth: vi.fn(),
    });
    client.start();
    const es = MockEventSource.instances[0];

    window.dispatchEvent(new Event("session-expired"));

    expect(es.readyState).toBe(2);
    vi.advanceTimersByTime(30_000);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("allows a fresh stream client to monitor after login", () => {
    const expiredClient = createStreamClient({
      streamPath: PROJECT_STREAM_PATH,
      onEvent: vi.fn(),
      onDelete: vi.fn(),
      onHealth: vi.fn(),
    });
    expiredClient.start();
    window.dispatchEvent(new Event("session-expired"));
    expiredClient.close();

    const onHealth = vi.fn();
    const freshClient = createStreamClient({
      streamPath: PROJECT_STREAM_PATH,
      onEvent: vi.fn(),
      onDelete: vi.fn(),
      onHealth,
    });
    freshClient.start();
    MockEventSource.instances[1].dispatch("heartbeat", { ts: "fresh-login" });

    expect(MockEventSource.instances).toHaveLength(2);
    expect(onHealth).toHaveBeenLastCalledWith("connected");
    freshClient.close();
  });

  it("fires onReconnected after a disconnect→reconnect so provider can rehydrate", () => {
    const onReconnected = vi.fn();
    const client = createStreamClient({
      streamPath: PROJECT_STREAM_PATH,
      onEvent: vi.fn(),
      onDelete: vi.fn(),
      onHealth: vi.fn(),
      onReconnected,
    });
    client.start();
    MockEventSource.instances[0].triggerError();
    vi.advanceTimersByTime(1100);
    MockEventSource.instances[1].dispatch("heartbeat", { ts: "now" });
    expect(onReconnected).toHaveBeenCalledOnce();
    client.close();
  });

  it("tags initial events as snapshot vs live via onEvent second arg", () => {
    const onEvent = vi.fn();
    const client = createStreamClient({streamPath: PROJECT_STREAM_PATH, onEvent, onDelete: vi.fn(), onHealth: vi.fn() });
    client.start();
    MockEventSource.instances[0].dispatch("task_updated", sampleTask());
    expect(onEvent).toHaveBeenCalledWith(expect.anything(), "snapshot");
    MockEventSource.instances[0].dispatch("heartbeat", { ts: "now" });
    MockEventSource.instances[0].dispatch("task_updated", sampleTask({ task_key: "b" }));
    expect(onEvent).toHaveBeenLastCalledWith(expect.anything(), "live");
    client.close();
  });

  it("adds snapshot=false query param when snapshotQueryParam=true", () => {
    const client = createStreamClient({
      streamPath: PROJECT_STREAM_PATH,
      onEvent: vi.fn(),
      onDelete: vi.fn(),
      onHealth: vi.fn(),
      snapshotQueryParam: true,
    });
    client.start();
    expect(MockEventSource.instances[0].url).toContain("snapshot=false");
    client.close();
  });

  it("close() disposes EventSource and clears timers", () => {
    const client = createStreamClient({streamPath: PROJECT_STREAM_PATH, onEvent: vi.fn(), onDelete: vi.fn(), onHealth: vi.fn() });
    client.start();
    const es = MockEventSource.instances[0];
    client.close();
    expect(es.readyState).toBe(2);
  });
});
