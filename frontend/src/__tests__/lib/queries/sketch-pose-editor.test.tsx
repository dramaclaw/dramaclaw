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
  useCropSketch,
  useSaveSketchPoseEditor,
  useSketchPoseEditor,
} from "@/lib/queries/sketch-pose-editor";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("sketch pose editor queries", () => {
  it("loads the pose editor payload for a beat sketch", async () => {
    let requestedPath = "";
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/5/sketch/pose-editor",
        ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          return HttpResponse.json({
            ok: true,
            data: {
              beat_num: 5,
              sketch_url: "/static/demo/sketches/ep001/beat_05.png",
              width: 64,
              height: 96,
              candidates: [],
              skeleton_edges: [],
              pose_presets: {},
              skeletons: [],
            },
          });
        },
      ),
    );

    const { result } = renderHook(
      () => useSketchPoseEditor("demo", 1, 5, true),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe(
      "/api/v1/projects/demo/episodes/1/beats/5/sketch/pose-editor",
    );
    const payload = result.current.data;
    expect(payload?.ok).toBe(true);
    if (!payload?.ok) throw new Error("expected ok response");
    expect(payload.data.width).toBe(64);
  });

  it("saves pose editor strokes and skeletons", async () => {
    let receivedBody: unknown = undefined;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/5/sketch/pose-editor",
        async ({ request }) => {
          receivedBody = await request.clone().json();
          return HttpResponse.json({
            ok: true,
            data: {
              beat_num: 5,
              sketch_url: "/static/demo/sketches/ep001/beat_05.png",
            },
          });
        },
      ),
    );

    const { result } = renderHook(() => useSaveSketchPoseEditor("demo", 1), {
      wrapper,
    });

    result.current.mutate({
      beatNum: 5,
      state: {
        strokes: [{ points: [{ x: 1, y: 2 }], width: 4 }],
        skeletons: [],
      },
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(receivedBody).toEqual({
      strokes: [{ points: [{ x: 1, y: 2 }], width: 4 }],
      skeletons: [],
    });
  });

  it("crops the current canonical sketch", async () => {
    let receivedBody: unknown = undefined;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/5/sketch/crop",
        async ({ request }) => {
          receivedBody = await request.clone().json();
          return HttpResponse.json({
            ok: true,
            data: {
              beat_num: 5,
              sketch_url: "/static/demo/sketches/ep001/beat_05.png",
              width: 20,
              height: 30,
            },
          });
        },
      ),
    );

    const { result } = renderHook(() => useCropSketch("demo", 1), {
      wrapper,
    });

    result.current.mutate({
      beatNum: 5,
      crop: { x: 4, y: 6, width: 20, height: 30 },
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(receivedBody).toEqual({ x: 4, y: 6, width: 20, height: 30 });
  });
});
