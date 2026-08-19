// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import ky from "ky";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

vi.mock("@/components/confirm-dialog-host", () => ({
  confirmDialog: vi.fn(),
}));

import { confirmDialog } from "@/components/confirm-dialog-host";
import { server } from "@/__mocks__/msw/server";
import { sampleTask } from "@/__mocks__/msw/handlers/tasks";
import { useCancelTask, useTasks } from "@/lib/queries/tasks";
import { useTaskCenterStore } from "@/task-center/store";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useTasks polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTaskCenterStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    useTaskCenterStore.getState().reset();
  });

  it("does not poll when the task center owns the same connected project", async () => {
    let requestCount = 0;
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () => {
        requestCount += 1;
        return HttpResponse.json({ ok: true, data: [] });
      }),
    );

    useTaskCenterStore.getState().setProject("demo");
    useTaskCenterStore.getState().setHealth("connected");

    renderHook(() => useTasks({ project: "demo" }), { wrapper });

    await vi.waitFor(() => expect(requestCount).toBe(1));

    await vi.advanceTimersByTimeAsync(6000);

    expect(requestCount).toBe(1);
  });

  it("keeps polling active tasks when the task center owns a different project", async () => {
    let requestCount = 0;
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () => {
        requestCount += 1;
        return HttpResponse.json({
          ok: true,
          data: [sampleTask({ task_key: "running", status: "running" })],
        });
      }),
    );

    useTaskCenterStore.getState().setProject("other");
    useTaskCenterStore.getState().setHealth("connected");

    renderHook(() => useTasks({ project: "demo" }), { wrapper });

    await vi.waitFor(() => expect(requestCount).toBe(1));

    await vi.advanceTimersByTimeAsync(2500);

    expect(requestCount).toBeGreaterThan(1);
  });

  it("refetches tasks when a consumer remounts inside the global stale window", async () => {
    let requestCount = 0;
    server.use(
      http.get("*/api/v1/projects/demo/tasks", () => {
        requestCount += 1;
        return HttpResponse.json({ ok: true, data: [] });
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 30_000,
        },
      },
    });
    const sharedWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const first = renderHook(() => useTasks({ project: "demo" }), {
      wrapper: sharedWrapper,
    });
    await vi.waitFor(() => expect(requestCount).toBe(1));
    first.unmount();

    renderHook(() => useTasks({ project: "demo" }), {
      wrapper: sharedWrapper,
    });
    await vi.waitFor(() => expect(requestCount).toBe(2));
  });
});

describe("useCancelTask running confirmation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a running task alive when the user declines no-refund termination", async () => {
    let requestCount = 0;
    server.use(
      http.delete("*/api/v1/projects/demo/tasks/video/1", () => {
        requestCount += 1;
        return HttpResponse.json(
          {
            ok: false,
            status: "running",
            requires_confirmation: true,
            refund_eligible: false,
            message: "终止不会退还积分",
          },
          { status: 409 },
        );
      }),
    );
    vi.mocked(confirmDialog).mockResolvedValue(false);
    const { result } = renderHook(() => useCancelTask(), { wrapper });

    const response = await act(() =>
      result.current.mutateAsync({
        type: "video",
        project: "demo",
        episode: 1,
      }),
    );

    expect(response).toMatchObject({ ok: false, continued: true });
    expect(requestCount).toBe(1);
  });

  it("sends an explicit no-refund acknowledgement after user confirmation", async () => {
    const requests: URL[] = [];
    server.use(
      http.delete("*/api/v1/projects/demo/tasks/video/1", ({ request }) => {
        const url = new URL(request.url);
        requests.push(url);
        if (url.searchParams.get("force") !== "true") {
          return HttpResponse.json(
            {
              ok: false,
              status: "running",
              requires_confirmation: true,
              refund_eligible: false,
              message: "终止不会退还积分",
            },
            { status: 409 },
          );
        }
        return HttpResponse.json({
          ok: true,
          status: "cancelled",
          requires_confirmation: false,
          refund_eligible: false,
          refund_status: "not_refunded",
        });
      }),
    );
    vi.mocked(confirmDialog).mockResolvedValue(true);
    const { result } = renderHook(() => useCancelTask(), { wrapper });

    const response = await act(() =>
      result.current.mutateAsync({
        type: "video",
        project: "demo",
        episode: 1,
      }),
    );

    expect(response).toMatchObject({ ok: true, refund_status: "not_refunded" });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.searchParams.get("force")).toBe("true");
    expect(requests[1]?.searchParams.get("acknowledge_no_refund")).toBe("true");
  });
});
