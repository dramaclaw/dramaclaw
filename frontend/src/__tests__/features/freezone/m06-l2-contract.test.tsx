// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import ky from "ky";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";
import { apiCall } from "@/api/client";
import {
  getFreezoneCanvas,
  listFreezoneCanvases,
  putFreezoneCanvas,
} from "@/api/canvas";
import { fetchFreezoneJobResult, submitFreezoneGen } from "@/api/ops";
import { pushToPipeline } from "@/api/push";
import { createStreamClient } from "@/task-center/stream-client";
import { useTaskStream } from "@/hooks/use-task-stream";
import { useStartIngest } from "@/lib/queries/ingest";
import { useAuthStore } from "@/stores/auth-store";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost/" }),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    apiCall: vi.fn(),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      key === "common.billingRuleNotConfigured"
        ? "计费规则未配置，请联系管理员设置积分规则"
        : (options?.defaultValue ?? key),
  }),
}));

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  readonly withCredentials: boolean;
  readyState = 1;
  listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, callback: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    this.listeners.get(type)?.forEach((callback) => callback(event));
  }

  close() {
    this.readyState = 2;
  }
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("M06 frontend L2 contract", () => {
  beforeEach(() => {
    MockEventSource.instances.length = 0;
    vi.stubGlobal("EventSource", MockEventSource);
    vi.mocked(apiCall).mockReset();
    useAuthStore.setState({ username: "local", role: "owner" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ username: null, role: null });
  });

  it("starts ingest and consumes task stream terminal updates with cookie SSE", async () => {
    let startBody: unknown = null;
    const taskEvents: unknown[] = [];

    server.use(
      http.post("http://localhost/api/v1/projects/demo/ingest/start", async ({ request }) => {
        startBody = await request.json();
        return HttpResponse.json({
          ok: true,
          task_type: "ingest_fast",
          message: "ingest queued",
          task_key: "ingest_fast:demo:ep1",
        });
      }),
    );

    const { result: ingest } = renderHook(() => useStartIngest("demo"), { wrapper });

    let ingestResponse: Awaited<ReturnType<typeof ingest.current.mutateAsync>> | null = null;
    await act(async () => {
      ingestResponse = await ingest.current.mutateAsync({
        filename: "novel.txt",
        rebuild: true,
        spine_template: "drama",
      });
    });

    expect(startBody).toEqual({
      filename: "novel.txt",
      rebuild: true,
      spine_template: "drama",
    });
    expect(ingestResponse).toMatchObject({
      ok: true,
      task_type: "ingest_fast",
      message: "ingest queued",
    });

    const streamClient = createStreamClient({
      streamPath: "/api/v1/projects/demo/tasks/stream",
      onEvent: (task) => taskEvents.push(task),
      onDelete: vi.fn(),
      onHealth: vi.fn(),
    });
    streamClient.start();

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toContain("/api/v1/projects/demo/tasks/stream");
    expect(MockEventSource.instances[0].url).not.toContain("token=");
    expect(MockEventSource.instances[0].withCredentials).toBe(true);

    MockEventSource.instances[0].dispatch("task_updated", {
      task_key: "ingest_fast:demo:ep1",
      task_type: "ingest_fast",
      status: "running",
      progress: 25,
      current_task: "parsing chapters",
    });
    MockEventSource.instances[0].dispatch("task_updated", {
      task_key: "ingest_fast:demo:ep1",
      task_type: "ingest_fast",
      status: "completed",
      progress: 100,
      current_task: "ingest completed",
      result: { episodes: 3 },
    });

    expect(taskEvents).toHaveLength(2);
    expect(taskEvents[1]).toMatchObject({
      task_key: "ingest_fast:demo:ep1",
      status: "completed",
      result: { episodes: 3 },
    });

    streamClient.close();
  });

  it("keeps the legacy ingest task stream cookie-backed and closes on terminal event", async () => {
    const onComplete = vi.fn();
    const { result, unmount } = renderHook(
      () =>
        useTaskStream({
          taskType: "ingest_fast",
          project: "demo",
          episode: 1,
          enabled: true,
          showCompleteToast: false,
          onComplete,
        }),
      { wrapper },
    );

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    expect(MockEventSource.instances[0].url).toBe(
      "/api/v1/projects/demo/tasks/ingest_fast/1/stream",
    );
    expect(MockEventSource.instances[0].url).not.toContain("api_key=");
    expect(MockEventSource.instances[0].withCredentials).toBe(true);

    act(() => {
      MockEventSource.instances[0].dispatch("completed", {
        status: "completed",
        progress: 100,
        current_task: "ingest completed",
        result: { chapters: 12 },
        logs: ["parsed", "stored"],
      });
    });

    await waitFor(() => expect(result.current.status).toBe("completed"));
    expect(result.current.result).toEqual({ chapters: 12 });
    expect(result.current.logs).toEqual(["parsed", "stored"]);
    expect(onComplete).toHaveBeenCalledWith({ chapters: 12 });
    expect(MockEventSource.instances[0].readyState).toBe(2);

    unmount();
  });

  it("maps billing rule task stream failures to the unified billing message", async () => {
    const onError = vi.fn();
    const { result, unmount } = renderHook(
      () =>
        useTaskStream({
          taskType: "ingest_fast",
          project: "demo",
          episode: 1,
          enabled: true,
          showCompleteToast: false,
          onError,
        }),
      { wrapper },
    );

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    await act(async () => {
      MockEventSource.instances[0].dispatch("failed", {
        status: "failed",
        progress: 0,
        current_task: "功能扣费失败",
        error: "Request failed with status code 409 Conflict: POST /ingest/start",
        error_code: "BILLING_RULE_NOT_CONFIGURED",
        logs: [],
      });
    });

    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(toast.error).toHaveBeenCalledWith("计费规则未配置，请联系管理员设置积分规则");
    expect(onError).toHaveBeenCalledWith("计费规则未配置，请联系管理员设置积分规则");
    expect(toast.error).not.toHaveBeenCalledWith(
      expect.stringContaining("Request failed with status code 409"),
    );
    expect(MockEventSource.instances[0].readyState).toBe(2);

    unmount();
  });

  it("covers freezone canvas CRUD, image job result, and push to a canonical slot", async () => {
    vi.mocked(apiCall)
      .mockResolvedValueOnce([
        {
          id: "default",
          modified_at: "2026-06-17T00:00:00Z",
          size: 1,
          schema_version: 2,
          revision: 4,
        },
      ])
      .mockResolvedValueOnce({
        schema_version: 2,
        canvas_id: "default",
        revision: 4,
        nodes: [{ id: "n1", type: "freezoneImageNode" }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      })
      .mockResolvedValueOnce({
        saved: true,
        revision: 5,
        client_save_id: "save-1",
      })
      .mockResolvedValueOnce({
        task_type: "freezone_gen",
        job_id: "job-1",
        task_key: "freezone_gen:demo:job-1",
      })
      .mockResolvedValueOnce({
        url: "/static/projects/demo/freezone/_outputs/freezone_gen/job-1.png",
        size: 2048,
      })
      .mockResolvedValueOnce({
        target_path: "episodes/1/beats/2/frame.png",
        target_url: "/static/projects/demo/episodes/1/beats/2/frame.png",
        backup: "episodes/1/beats/2/frame.png.bak",
        stale_marked: 1,
        affected_count: 1,
      });

    const canvases = await listFreezoneCanvases("demo");
    const canvas = await getFreezoneCanvas("demo", "default");
    const saveResult = await putFreezoneCanvas("demo", "default", {
      ...canvas,
      nodes: [{ id: "n1", type: "freezoneImageNode", data: { imageUrl: "/input.png" } }],
      client_save_id: "save-1",
      base_revision: 4,
    });
    const job = await submitFreezoneGen("demo", {
      prompt: "cinematic frame",
      aspectRatio: "16:9",
      imageSize: "2K",
      canvasId: "default",
      nodeId: "n1",
    });
    const jobResult = await fetchFreezoneJobResult("demo", job.task_type, job.job_id);
    const pushResult = await pushToPipeline(
      "demo",
      jobResult.url,
      { kind: "frame", episode: 1, beat: 2 },
      { mark_stale: true },
    );

    expect(canvases).toEqual([
      expect.objectContaining({ id: "default", revision: 4 }),
    ]);
    expect(canvas).toMatchObject({ canvas_id: "default", revision: 4 });
    expect(saveResult).toMatchObject({ saved: true, revision: 5 });
    expect(job).toEqual({
      task_type: "freezone_gen",
      job_id: "job-1",
      task_key: "freezone_gen:demo:job-1",
    });
    expect(jobResult).toEqual({
      url: "/static/projects/demo/freezone/_outputs/freezone_gen/job-1.png",
      size: 2048,
    });
    expect(pushResult).toMatchObject({
      target_path: "episodes/1/beats/2/frame.png",
      stale_marked: 1,
    });

    expect(vi.mocked(apiCall).mock.calls).toEqual([
      ["projects/demo/freezone/canvases", undefined],
      ["projects/demo/freezone/canvases/default", undefined],
      [
        "projects/demo/freezone/canvases/default",
        {
          method: "PUT",
          json: expect.objectContaining({
            canvas_id: "default",
            client_save_id: "save-1",
            base_revision: 4,
          }),
        },
      ],
      [
        "projects/demo/freezone/gen",
        {
          method: "POST",
          json: expect.objectContaining({
            prompt: "cinematic frame",
            aspect_ratio: "16:9",
            image_size: "2K",
            canvas_id: "default",
            node_id: "n1",
          }),
        },
      ],
      ["projects/demo/freezone/jobs/freezone_gen/job-1/result"],
      [
        "projects/demo/freezone/push",
        {
          method: "POST",
          json: {
            source_url: "/static/projects/demo/freezone/_outputs/freezone_gen/job-1.png",
            target: { kind: "frame", episode: 1, beat: 2 },
            mark_stale: true,
          },
        },
      ],
    ]);
  });
});
