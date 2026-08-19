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
  useSaveSketchRegenQueue,
  useSketchRegenQueue,
  type SketchRegenQueueItem,
} from "@/lib/queries/sketch-regen-queue";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("sketch regen queue queries", () => {
  it("loads the persisted episode queue", async () => {
    let requestedPath = "";
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/sketch-regen-queue",
        ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          return HttpResponse.json({
            ok: true,
            data: {
              items: [
                {
                  id: "2x2_2-3_sketch:1,2",
                  modeKey: "2x2_2-3_sketch",
                  modeLabel: "2×2",
                  beatNumbers: [1, 2],
                  sceneIds: ["store"],
                  createdAt: "2026-05-18T00:00:00.000Z",
                },
              ],
            },
          });
        },
      ),
    );

    const { result } = renderHook(() => useSketchRegenQueue("demo", 1), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe(
      "/api/v1/projects/demo/episodes/1/sketch-regen-queue",
    );
    expect(result.current.data?.data.items[0].beatNumbers).toEqual([1, 2]);
  });

  it("persists a replaced queue", async () => {
    let receivedBody: unknown = undefined;
    const item: SketchRegenQueueItem = {
      id: "1x1_2-3_sketch:3",
      modeKey: "1x1_2-3_sketch",
      modeLabel: "1×1",
      beatNumbers: [3],
      sceneIds: ["store"],
      createdAt: "2026-05-18T00:01:00.000Z",
    };
    server.use(
      http.put(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/sketch-regen-queue",
        async ({ request }) => {
          receivedBody = await request.clone().json();
          return HttpResponse.json({ ok: true, data: { items: [item] } });
        },
      ),
    );

    const { result } = renderHook(() => useSaveSketchRegenQueue("demo", 1), {
      wrapper,
    });

    result.current.mutate([item]);
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(receivedBody).toEqual({ items: [item] });
  });
});
