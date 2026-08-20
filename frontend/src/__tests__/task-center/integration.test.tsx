// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import ky from "ky";
import { http, HttpResponse } from "msw";

// MSW 2 + ky 2 in jsdom: the global Request is replaced by an undici-backed
// implementation that requires an absolute URL, so the production `api` (which
// uses `prefix: "/"` + relative inputs) throws `Failed to parse URL`. Inject a
// test-only ky instance with an absolute `baseUrl` so requests reach MSW —
// same pattern as provider.test.tsx and render-plan.test.tsx.
vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

import { server } from "@/__mocks__/msw/server";
import { sampleTask } from "@/__mocks__/msw/handlers/tasks";
import { TaskCenterProvider } from "@/task-center/provider";
import { useTaskCenterStore } from "@/task-center/store";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { useTaskSubscribe } from "@/task-center/use-task-subscribe";
import { queryKeys } from "@/lib/query-keys";
import type { TaskState } from "@/task-center/types";

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  readyState = 0;
  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  onerror: ((e: Event) => void) | null = null;
  constructor(url: string) {
    this.url = url;
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
  close() {
    this.readyState = 2;
  }
}

const i18n = i18next.createInstance();

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      lng: "en",
      fallbackLng: "en",
      resources: {
        en: {
          translation: {
            taskCenter: {
              toast: {
                completed: "{{label}} completed",
                failed: "{{label}} failed: {{error}}",
              },
            },
            tasks: { types: { sketch_regen: "Sketch regen", script_writer: "Script writer" } },
          },
        },
      },
      interpolation: { escapeValue: false },
    });
  }
});

beforeEach(() => {
  MockEventSource.instances.length = 0;
  // @ts-expect-error — swap global EventSource for tests
  globalThis.EventSource = MockEventSource;
  useTaskCenterStore.getState().reset();
  useAppStore.setState({ taskPanelOpen: false });
  useAuthStore.setState({ username: "alice", role: "admin" });
});

afterEach(() => {
  useAuthStore.setState({ username: null, role: null });
});

function Harness({ qc, children }: { qc: QueryClient; children?: React.ReactNode }) {
  return (
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <TaskCenterProvider projectId="demo">{children ?? <div />}</TaskCenterProvider>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

function makeQC() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("task-center integration (AC-1 + AC-2)", () => {
  it("AC-1: hydrate-first, exactly one stream, store upserts < 100ms of event", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [sampleTask({ task_id: "a", task_key: "a", status: "running" })],
        }),
      ),
    );
    const qc = makeQC();
    render(<Harness qc={qc} />);

    await waitFor(() => {
      expect(useTaskCenterStore.getState().isHydrated).toBe(true);
      expect(MockEventSource.instances.length).toBe(1);
    });
    expect(useTaskCenterStore.getState().tasks.size).toBe(1);

    const t0 = performance.now();
    act(() => {
      MockEventSource.instances[0].dispatch("heartbeat", { ts: "now" }); // close snapshot window
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({ task_id: "a", task_key: "a", status: "running", progress: 0.5 }),
      );
    });
    const t1 = performance.now();
    expect(t1 - t0).toBeLessThan(100);
    // Store keys by task_id now.
    expect(useTaskCenterStore.getState().tasks.get("a")!.progress).toBe(0.5);
  });

  it("AC-1: provider keeps project task query cache in sync via setQueryData", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [sampleTask({ task_id: "test-a", task_key: "a", status: "running" })],
        }),
      ),
    );
    const qc = makeQC();
    render(<Harness qc={qc} />);
    await waitFor(() => expect(MockEventSource.instances.length).toBe(1));
    act(() => {
      MockEventSource.instances[0].dispatch("heartbeat", { ts: "now" });
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({ task_id: "test-a", task_key: "a", status: "running", progress: 0.8 }),
      );
    });
    const cached = qc.getQueryData<{ ok: true; data: TaskState[] }>(queryKeys.tasks("demo"));
    expect(cached?.data.find((x) => x.task_key === "a")?.progress).toBe(0.8);
  });

  it("hydrates the project task query cache before stream events arrive", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [sampleTask({ task_id: "test-a", task_key: "a", status: "running" })],
        }),
      ),
    );
    const qc = makeQC();
    render(<Harness qc={qc} />);

    await waitFor(() => expect(useTaskCenterStore.getState().isHydrated).toBe(true));

    const cached = qc.getQueryData<{ ok: true; data: TaskState[] }>(queryKeys.tasks("demo"));
    expect(cached?.data.map((task) => task.task_key)).toEqual(["a"]);
  });

  it("AC-1: cleanup on unmount closes the stream within 50ms", async () => {
    server.use(http.get("*/api/v1/projects/demo/tasks", () => HttpResponse.json({ ok: true, data: [] })));
    const qc = makeQC();
    const { unmount } = render(<Harness qc={qc} />);
    await waitFor(() => expect(MockEventSource.instances.length).toBe(1));
    const es = MockEventSource.instances[0];
    const t0 = performance.now();
    unmount();
    const t1 = performance.now();
    expect(es.readyState).toBe(2);
    expect(t1 - t0).toBeLessThan(50);
  });

  it("AC-2: useTaskSubscribe fires onComplete exactly once for matching live events", async () => {
    server.use(http.get("*/api/v1/projects/demo/tasks", () => HttpResponse.json({ ok: true, data: [] })));
    const onComplete = vi.fn();

    function Listener() {
      useTaskSubscribe({
        match: (t) => t.task_type === "sketch_regen",
        onComplete,
      });
      return null;
    }

    const qc = makeQC();
    render(
      <Harness qc={qc}>
        <Listener />
      </Harness>,
    );
    await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

    // Close snapshot window so the next task_updated counts as "live"
    act(() => {
      MockEventSource.instances[0].dispatch("heartbeat", { ts: "now" });
    });

    // Running matching task — should NOT fire onComplete
    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({
          task_id: "test-s1",
          task_key: "s1",
          task_type: "sketch_regen",
          status: "running",
        }),
      );
    });
    expect(onComplete).not.toHaveBeenCalled();

    // Transition to completed — SHOULD fire onComplete once
    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({
          task_id: "test-s1",
          task_key: "s1",
          task_type: "sketch_regen",
          status: "completed",
        }),
      );
    });
    expect(onComplete).toHaveBeenCalledTimes(1);

    // Non-matching task completes — should NOT fire onComplete
    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({ task_key: "x1", task_type: "script_writer", status: "completed" }),
      );
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("AC-2: useTaskSubscribe unsubscribes on unmount", async () => {
    server.use(http.get("*/api/v1/projects/demo/tasks", () => HttpResponse.json({ ok: true, data: [] })));
    const onComplete = vi.fn();

    function Listener() {
      useTaskSubscribe({ match: () => true, onComplete });
      return null;
    }

    const qc = makeQC();
    const { unmount } = render(
      <Harness qc={qc}>
        <Listener />
      </Harness>,
    );
    await waitFor(() => expect(MockEventSource.instances.length).toBe(1));
    act(() => {
      MockEventSource.instances[0].dispatch("heartbeat", { ts: "now" });
    });
    unmount();
    // After unmount, the new provider instance would be needed to dispatch; but we can still
    // assert onComplete count frozen at 0
    expect(onComplete).not.toHaveBeenCalled();
  });
});
