// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import ky from "ky";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

import {
  useImageGenerationGuard,
  useVerifyImageGenerationPassword,
  useSketchImageUsage,
} from "@/lib/queries/sketch-image-usage";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("sketch image usage queries", () => {
  it("loads episode sketch image usage", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/sketch-image-usage",
        () =>
          HttpResponse.json({
            ok: true,
            data: { today_requests: 3, total_requests: 8 },
          }),
      ),
    );

    const { result } = renderHook(() => useSketchImageUsage("demo", 1), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.data.today_requests).toBe(3);
  });

  it("fetches per-scope guard context", async () => {
    let query = new URLSearchParams();
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/image-generation-guard",
        ({ request }) => {
          query = new URL(request.url).searchParams;
          return HttpResponse.json({
            ok: true,
            data: {
              attempt_count: 3,
              next_attempt: 4,
              level: "confirm",
              message: "Beat 3 已连续生成 4 次，确认继续生成吗？",
            },
          });
        },
      ),
    );

    const { result } = renderHook(() => useImageGenerationGuard("demo", 1), {
      wrapper,
    });

    result.current.mutate({
      taskType: "sketch_grid",
      scope: "sketch_grid:1x1_2-3_sketch:3",
      subject: "Beat 3",
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(query.get("task_type")).toBe("sketch_grid");
    expect(query.get("scope")).toBe("sketch_grid:1x1_2-3_sketch:3");
    expect(result.current.data?.data.level).toBe("confirm");
  });

  it("verifies the NiceGUI operator password for locked image generation", async () => {
    let body: unknown = null;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/image-generation-guard/verify-password",
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({
            ok: true,
            data: { verified: true },
          });
        },
      ),
    );

    const { result } = renderHook(
      () => useVerifyImageGenerationPassword("demo", 1),
      { wrapper },
    );

    result.current.mutate({ password: "secret" });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(body).toEqual({ password: "secret" });
    expect(result.current.data?.data.verified).toBe(true);
  });
});
