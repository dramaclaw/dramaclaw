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
  useGenerateScenePanoAsync,
  useScenes,
} from "@/lib/queries/scenes";
import { useGeneratePropReferenceAsync, useProps } from "@/lib/queries/props";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("asset query hooks", () => {
  it("fetches scenes from the project scenes endpoint", async () => {
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/scenes", () =>
        HttpResponse.json({
          ok: true,
          data: [{ name: "皇宫大殿", scene_type: "interior" }],
        }),
      ),
    );

    const { result } = renderHook(() => useScenes("demo"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.data[0].name).toBe("皇宫大殿");
  });

  it("starts a scoped scene 360 generation task", async () => {
    let body: unknown = null;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/scenes/%E7%9A%87%E5%AE%AB%E5%A4%A7%E6%AE%BF/pano/generate-async",
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({
            ok: true,
            task_type: "stage_asset",
            scope: "stage_asset:scene:pano",
            message: "started",
          });
        },
      ),
    );

    const { result } = renderHook(
      () => useGenerateScenePanoAsync("demo", "皇宫大殿"),
      { wrapper },
    );
    result.current.mutate({ source: "master" });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.ok).toBe(true);
    if (result.current.data?.ok) {
      expect(result.current.data.task_type).toBe("stage_asset");
    }
    expect(body).toEqual({ source: "master" });
  });

  it("fetches props from the project props endpoint", async () => {
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/props", () =>
        HttpResponse.json({
          ok: true,
          data: [{ name: "七星剑", prop_type: "weapon" }],
        }),
      ),
    );

    const { result } = renderHook(() => useProps("demo"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.data[0].name).toBe("七星剑");
  });

  it("starts a prop reference generation task", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/props/%E4%B8%83%E6%98%9F%E5%89%91/reference/generate-async",
        () =>
          HttpResponse.json({
            ok: true,
            task_type: "prop_reference_asset",
            scope: "prop:seven-star-sword",
            message: "started",
          }),
      ),
    );

    const { result } = renderHook(
      () => useGeneratePropReferenceAsync("demo", "七星剑"),
      { wrapper },
    );
    result.current.mutate();
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.ok).toBe(true);
    if (result.current.data?.ok) {
      expect(result.current.data.task_type).toBe("prop_reference_asset");
    }
  });
});
