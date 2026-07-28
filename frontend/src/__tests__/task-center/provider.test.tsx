// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CancelledError } from "@tanstack/query-core";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { http, HttpResponse } from "msw";
import ky from "ky";

const handleSessionExpiredMock = vi.hoisted(() => vi.fn(async () => undefined));

// MSW 2 + ky 2 in jsdom: the global Request is replaced by an undici-backed
// implementation that requires an absolute URL, so the production `api` (which
// uses `prefix: "/"` + relative inputs) throws `Failed to parse URL`. Inject a
// test-only ky instance with an absolute `baseUrl` so requests reach MSW.
vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  handleSessionExpired: handleSessionExpiredMock,
}));

import { server } from "@/__mocks__/msw/server";
import { sampleTask } from "@/__mocks__/msw/handlers/tasks";
import { queryKeys } from "@/lib/query-keys";
import { useTasks } from "@/lib/queries/tasks";
import { TaskCenterProvider } from "@/task-center/provider";
import { useTaskCenterStore } from "@/task-center/store";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";

// MockEventSource copy (keeps test file self-contained — upstream stream-client test uses same pattern)
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
  triggerError() {
    this.onerror?.(new Event("error"));
  }
  close() {
    this.readyState = 2;
  }
}

const i18n = i18next.createInstance();

beforeEach(async () => {
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
            tasks: { types: { script_writer: "Script writer" } },
          },
        },
      },
      interpolation: { escapeValue: false },
    });
  }
  MockEventSource.instances.length = 0;
  handleSessionExpiredMock.mockClear();
  // @ts-expect-error — swap global EventSource
  globalThis.EventSource = MockEventSource;
  useTaskCenterStore.getState().reset();
  useAppStore.setState({ taskPanelOpen: false });
  useAuthStore.setState({ username: "alice", role: "admin" });
});

afterEach(() => {
  useAuthStore.setState({ username: null, role: null });
});

function Harness({
  children,
  queryClient,
}: {
  children?: React.ReactNode;
  queryClient?: QueryClient;
}) {
  const qc =
    queryClient ??
    new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <TaskCenterProvider projectId="demo">{children ?? <div />}</TaskCenterProvider>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

function TasksConsumer() {
  useTasks({ project: "demo", episode: 1 });
  return null;
}

describe("TaskCenterProvider", () => {
  it("runs full session teardown when the auth probe returns 403", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({ ok: true, data: [] }),
      ),
      http.get("*/api/v1/auth/me", () =>
        HttpResponse.json({ detail: "Forbidden" }, { status: 403 }),
      ),
    );
    render(<Harness />);
    await vi.waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    MockEventSource.instances[0].dispatch("heartbeat", { ts: "healthy" });

    MockEventSource.instances[0].triggerError();
    await new Promise((resolve) => window.setTimeout(resolve, 1_100));
    MockEventSource.instances[1].triggerError();
    await new Promise((resolve) => window.setTimeout(resolve, 2_100));
    MockEventSource.instances[2].triggerError();

    await vi.waitFor(() => expect(handleSessionExpiredMock).toHaveBeenCalledOnce());
  });

  it("does NOT open a stream when logged out (no username)", async () => {
    useAuthStore.setState({ username: null });
    render(<Harness />);
    await vi.waitFor(() => {
      expect(MockEventSource.instances.length).toBe(0);
    });
  });

  it("hydrates via project tasks, then opens exactly one stream", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({ ok: true, data: [sampleTask({ task_key: "a", status: "running" })] }),
      ),
    );
    render(<Harness />);
    await vi.waitFor(() => {
      expect(useTaskCenterStore.getState().isHydrated).toBe(true);
      expect(MockEventSource.instances.length).toBe(1);
    });
    expect(useTaskCenterStore.getState().tasks.size).toBe(1);
  });

  it("shares the initial /tasks request with legacy useTasks consumers", async () => {
    let calls = 0;
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () => {
        calls += 1;
        return HttpResponse.json({
          ok: true,
          data: [sampleTask({ task_key: "a", status: "running" })],
        });
      }),
    );
    render(
      <Harness>
        <TasksConsumer />
      </Harness>,
    );

    await vi.waitFor(() => {
      expect(useTaskCenterStore.getState().isHydrated).toBe(true);
      expect(MockEventSource.instances.length).toBe(1);
    });
    expect(calls).toBe(1);
  });

  it("keeps the project task query cache across transient provider unmounts", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [sampleTask({ task_key: "a", status: "running" })],
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { unmount } = render(<Harness queryClient={queryClient} />);

    await vi.waitFor(() => expect(useTaskCenterStore.getState().isHydrated).toBe(true));
    expect(queryClient.getQueryData(queryKeys.tasks("demo"))).toBeDefined();

    unmount();

    expect(queryClient.getQueryData(queryKeys.tasks("demo"))).toBeDefined();
  });

  it("does not report React Query hydrate cancellation as a task-center failure", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const fetchSpy = vi
      .spyOn(queryClient, "fetchQuery")
      .mockRejectedValue(new CancelledError());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<Harness queryClient={queryClient} />);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(
      errorSpy.mock.calls.some((call) => call[0] === "[task-center] hydrate failed"),
    ).toBe(false);

    errorSpy.mockRestore();
  });

  it("clears the project task query cache when the user logs out", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [sampleTask({ task_key: "a", status: "running" })],
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(<Harness queryClient={queryClient} />);

    await vi.waitFor(() => expect(useTaskCenterStore.getState().isHydrated).toBe(true));
    expect(queryClient.getQueryData(queryKeys.tasks("demo"))).toBeDefined();

    act(() => {
      useAuthStore.setState({ username: null, role: null });
    });

    await vi.waitFor(() => {
      expect(queryClient.getQueryData(queryKeys.tasks("demo"))).toBeUndefined();
    });
  });

  it("⌘J keypress toggles taskPanelOpen (not in form fields)", async () => {
    server.use(http.get("*/api/v1/projects/demo/tasks", () => HttpResponse.json({ ok: true, data: [] })));
    render(<Harness />);
    await vi.waitFor(() => expect(useTaskCenterStore.getState().isHydrated).toBe(true));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true }));
    });
    expect(useAppStore.getState().taskPanelOpen).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true }));
    });
    expect(useAppStore.getState().taskPanelOpen).toBe(false);
  });

  it("⌘J suppressed when focus is in an input", async () => {
    server.use(http.get("*/api/v1/projects/demo/tasks", () => HttpResponse.json({ ok: true, data: [] })));
    render(
      <Harness>
        <input data-testid="inp" />
      </Harness>,
    );
    await vi.waitFor(() => expect(useTaskCenterStore.getState().isHydrated).toBe(true));
    const inp = screen.getByTestId("inp") as HTMLInputElement;
    act(() => {
      inp.focus();
      inp.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true }),
      );
    });
    expect(useAppStore.getState().taskPanelOpen).toBe(false);
  });

  it("live events fire toasts immediately — no snapshot suppression with snapshot=false", async () => {
    // Provider requests snapshotQueryParam=true → server sends snapshot=false →
    // there is no snapshot burst. Every event is live from the first one.
    // (Regression guard for the original "silent first-15s" bug.)
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [sampleTask({ task_id: "test-a", task_key: "a", status: "running" })],
        }),
      ),
    );
    const { toast } = await import("sonner");
    const spy = vi.spyOn(toast, "success");
    render(<Harness />);
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));
    // Transition running → completed BEFORE any heartbeat. Must fire.
    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({ task_id: "test-a", task_key: "a", status: "completed" }),
      );
    });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("live terminal transition fires toast without auto-opening the panel", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [sampleTask({ task_id: "test-a", task_key: "a", status: "running" })],
        }),
      ),
    );
    render(<Harness />);
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));
    // Close snapshot window via heartbeat
    act(() => {
      MockEventSource.instances[0].dispatch("heartbeat", { ts: "now" });
    });
    // Transition running → failed
    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({ task_id: "test-a", task_key: "a", status: "failed", error: "oops" }),
      );
    });
    expect(useAppStore.getState().taskPanelOpen).toBe(false);
    expect(useTaskCenterStore.getState().autoExpandedThisSession).toBe(false);
    // Additional failures should keep the panel closed.
    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({ task_id: "test-b", task_key: "b", status: "running" }),
      );
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({ task_id: "test-b", task_key: "b", status: "failed", error: "again" }),
      );
    });
    expect(useAppStore.getState().taskPanelOpen).toBe(false);
  });

  it("invalidates scene asset queries when an episode scene planner completes", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [
            sampleTask({
              task_id: "scene-run-1",
              task_key: "task:episode_scene_planner:alice:demo:1:scene_run_test",
              task_type: "episode_scene_planner",
              episode: 1,
              scope: "scene_run_test",
              status: "running",
            }),
          ],
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(<Harness queryClient={queryClient} />);
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));

    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({
          task_id: "scene-run-1",
          task_key: "task:episode_scene_planner:alice:demo:1:scene_run_test",
          task_type: "episode_scene_planner",
          episode: 1,
          scope: "scene_run_test",
          status: "completed",
          completed_at: new Date().toISOString(),
        }),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.scenes("demo") });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.episodes("demo") });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.episodeDetail("demo", 1),
    });
  });

  it("invalidates beats when a beat video prompt task completes", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [
            sampleTask({
              task_id: "prompt-run-1",
              task_key: "task:beat_video_prompt:project:demo:1:beat:3",
              task_type: "beat_video_prompt",
              episode: 1,
              beat_num: 3,
              status: "running",
            }),
          ],
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(<Harness queryClient={queryClient} />);
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));

    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({
          task_id: "prompt-run-1",
          task_key: "task:beat_video_prompt:project:demo:1:beat:3",
          task_type: "beat_video_prompt",
          episode: 1,
          beat_num: 3,
          status: "completed",
          completed_at: new Date().toISOString(),
        }),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.beats("demo", 1) });
  });

  it.each(["script_writer", "literal_script_writer"])(
    "invalidates script data when a %s task completes",
    async (taskType) => {
      server.use(
        http.get("*/api/v1/projects/demo/tasks", () =>
          HttpResponse.json({
            ok: true,
            data: [
              sampleTask({
                task_id: `${taskType}-run-1`,
                task_key: `task:${taskType}:project:demo:1`,
                task_type: taskType,
                episode: 1,
                status: "running",
              }),
            ],
          }),
        ),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
      render(<Harness queryClient={queryClient} />);
      await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      act(() => {
        MockEventSource.instances[0].dispatch(
          "task_updated",
          sampleTask({
            task_id: `${taskType}-run-1`,
            task_key: `task:${taskType}:project:demo:1`,
            task_type: taskType,
            episode: 1,
            status: "completed",
            completed_at: new Date().toISOString(),
          }),
        );
      });

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: queryKeys.script("demo", 1),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: queryKeys.beats("demo", 1),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: queryKeys.pipelineStatus("demo"),
      });
    },
  );

  it("does not invalidate script data for old completed script task replays", async () => {
    const oldCompletedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [],
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(<Harness queryClient={queryClient} />);
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));

    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({
          task_id: "script-run-old",
          task_key: "task:script_writer:project:demo:1",
          task_type: "script_writer",
          episode: 1,
          status: "completed",
          completed_at: oldCompletedAt,
        }),
      );
    });

    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: queryKeys.script("demo", 1),
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: queryKeys.beats("demo", 1),
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: queryKeys.pipelineStatus("demo"),
    });
  });

  it("does not repeatedly invalidate script data for duplicate completed task events", async () => {
    const completedAt = new Date().toISOString();
    const completedTask = sampleTask({
      task_id: "script-run-duplicate",
      task_key: "task:script_writer:project:demo:1",
      task_type: "script_writer",
      episode: 1,
      status: "completed",
      completed_at: completedAt,
    });
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [
            sampleTask({
              task_id: "script-run-duplicate",
              task_key: "task:script_writer:project:demo:1",
              task_type: "script_writer",
              episode: 1,
              status: "running",
            }),
          ],
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(<Harness queryClient={queryClient} />);
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));

    act(() => {
      MockEventSource.instances[0].dispatch("task_updated", completedTask);
      MockEventSource.instances[0].dispatch("task_updated", completedTask);
    });

    expect(
      invalidateSpy.mock.calls.filter(
        ([opts]) =>
          JSON.stringify(opts?.queryKey) === JSON.stringify(queryKeys.script("demo", 1)),
      ),
    ).toHaveLength(1);
    expect(
      invalidateSpy.mock.calls.filter(
        ([opts]) =>
          JSON.stringify(opts?.queryKey) === JSON.stringify(queryKeys.beats("demo", 1)),
      ),
    ).toHaveLength(1);
    expect(
      invalidateSpy.mock.calls.filter(
        ([opts]) =>
          JSON.stringify(opts?.queryKey) === JSON.stringify(queryKeys.pipelineStatus("demo")),
      ),
    ).toHaveLength(1);
  });

  it("invalidates prop asset queries when an episode prop planner completes", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [
            sampleTask({
              task_id: "prop-run-1",
              task_key: "task:episode_prop_planner:alice:demo:2:prop_run_test",
              task_type: "episode_prop_planner",
              episode: 2,
              scope: "prop_run_test",
              status: "running",
            }),
          ],
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(<Harness queryClient={queryClient} />);
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));

    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({
          task_id: "prop-run-1",
          task_key: "task:episode_prop_planner:alice:demo:2:prop_run_test",
          task_type: "episode_prop_planner",
          episode: 2,
          scope: "prop_run_test",
          status: "completed",
          completed_at: new Date().toISOString(),
        }),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.props("demo") });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.episodes("demo") });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.episodeDetail("demo", 2),
    });
  });

  it("invalidates character and identity asset queries when an identity planner completes", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [
            sampleTask({
              task_id: "identity-run-1",
              task_key: "task:identity_planner:alice:demo:3",
              task_type: "identity_planner",
              episode: 3,
              status: "running",
            }),
          ],
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(<Harness queryClient={queryClient} />);
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));

    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({
          task_id: "identity-run-1",
          task_key: "task:identity_planner:alice:demo:3",
          task_type: "identity_planner",
          episode: 3,
          status: "completed",
          completed_at: new Date().toISOString(),
        }),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.characters("demo") });
    expect(invalidateSpy).toHaveBeenCalledWith({
      predicate: expect.any(Function),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.episodes("demo") });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.episodeDetail("demo", 3),
    });
  });

  it("invalidates prop asset queries when a prop reference generation task completes", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [
            sampleTask({
              task_id: "prop-ref-1",
              task_key: "task:prop_reference_asset:alice:demo:0:prop_ref_test",
              task_type: "prop_reference_asset",
              episode: 0,
              scope: "prop_ref_test",
              status: "running",
            }),
          ],
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(<Harness queryClient={queryClient} />);
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));

    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({
          task_id: "prop-ref-1",
          task_key: "task:prop_reference_asset:alice:demo:0:prop_ref_test",
          task_type: "prop_reference_asset",
          episode: 0,
          scope: "prop_ref_test",
          status: "completed",
          completed_at: new Date().toISOString(),
        }),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.props("demo") });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.episodes("demo") });
  });

  it("invalidates prop asset queries when batch prop reference generation completes", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [
            sampleTask({
              task_id: "batch-prop-ref-1",
              task_key: "task:batch_prop_ref:alice:demo:0",
              task_type: "batch_prop_ref",
              episode: 0,
              status: "running",
            }),
          ],
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(<Harness queryClient={queryClient} />);
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));

    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({
          task_id: "batch-prop-ref-1",
          task_key: "task:batch_prop_ref:alice:demo:0",
          task_type: "batch_prop_ref",
          episode: 0,
          status: "completed",
          completed_at: new Date().toISOString(),
        }),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.props("demo") });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.episodes("demo") });
  });

  it("invalidates scene asset queries when a scene reference generation task completes", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [
            sampleTask({
              task_id: "scene-ref-1",
              task_key: "task:scene_reference_asset:alice:demo:0:scene_ref_test",
              task_type: "scene_reference_asset",
              episode: 0,
              scope: "scene_ref_test",
              status: "running",
            }),
          ],
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(<Harness queryClient={queryClient} />);
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));

    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({
          task_id: "scene-ref-1",
          task_key: "task:scene_reference_asset:alice:demo:0:scene_ref_test",
          task_type: "scene_reference_asset",
          episode: 0,
          scope: "scene_ref_test",
          status: "completed",
          completed_at: new Date().toISOString(),
        }),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.scenes("demo") });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.episodes("demo") });
  });

  it("invalidates character queries when a character portrait task completes", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [
            sampleTask({
              task_id: "portrait-1",
              task_key: "task:character_portrait:alice:demo:0:character:Alice:portrait",
              task_type: "character_portrait",
              episode: 0,
              scope: "character:Alice:portrait",
              status: "running",
            }),
          ],
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(<Harness queryClient={queryClient} />);
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));

    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({
          task_id: "portrait-1",
          task_key: "task:character_portrait:alice:demo:0:character:Alice:portrait",
          task_type: "character_portrait",
          episode: 0,
          scope: "character:Alice:portrait",
          status: "completed",
          completed_at: new Date().toISOString(),
        }),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.characters("demo") });
  });

  it("invalidates identity queries when an identity image task completes", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [
            sampleTask({
              task_id: "identity-1",
              task_key: "task:identity_image:alice:demo:0:character:Alice:identity:young",
              task_type: "identity_image",
              episode: 0,
              scope: "character:Alice:identity:young",
              status: "running",
            }),
          ],
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(<Harness queryClient={queryClient} />);
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));

    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({
          task_id: "identity-1",
          task_key: "task:identity_image:alice:demo:0:character:Alice:identity:young",
          task_type: "identity_image",
          episode: 0,
          scope: "character:Alice:identity:young",
          status: "completed",
          completed_at: new Date().toISOString(),
        }),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.identities("demo", "Alice"),
    });
  });

  it("invalidates identity queries when an identity portrait task completes", async () => {
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () =>
        HttpResponse.json({
          ok: true,
          data: [
            sampleTask({
              task_id: "identity-portrait-1",
              task_key:
                "task:character_portrait:alice:demo:0:character:Alice:identity_portrait:young",
              task_type: "character_portrait",
              episode: 0,
              scope: "character:Alice:identity_portrait:young",
              status: "running",
            }),
          ],
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(<Harness queryClient={queryClient} />);
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));

    act(() => {
      MockEventSource.instances[0].dispatch(
        "task_updated",
        sampleTask({
          task_id: "identity-portrait-1",
          task_key:
            "task:character_portrait:alice:demo:0:character:Alice:identity_portrait:young",
          task_type: "character_portrait",
          episode: 0,
          scope: "character:Alice:identity_portrait:young",
          status: "completed",
          completed_at: new Date().toISOString(),
        }),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.identities("demo", "Alice"),
    });
  });
});
