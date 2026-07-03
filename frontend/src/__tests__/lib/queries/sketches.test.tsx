// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import ky from "ky";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

import {
  StalePoolSelectError,
  useAssignColors,
  useDetectIdentities,
  useGenerateSketches,
  useBeatDirectorStageManifest,
  useBeatBackgroundAnchors,
  useCropBeatBackgroundAnchor,
  useDirectorControlFrameStatus,
  useDirectorControlToSketch,
  useCutGrid,
  useExportGridPrompt,
  usePoolSelect,
  useRegenerateRenderBeats,
  useRegenerateGrid,
  useUpdateBeatBackgroundAnchor,
  useUploadBeatBackgroundAnchor,
  useUploadGrid,
  useUploadBeatImage,
} from "@/lib/queries/sketches";
import { queryKeys } from "@/lib/query-keys";
import { api } from "@/lib/api";
import { BillingRuleNotConfiguredError } from "@/lib/api-errors";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function wrapperWithClient(queryClient: QueryClient) {
  return function TestWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("sketch generation query", () => {
  it("uses /sketches/generate for whole-episode sketch generation", async () => {
    let requestedPath = "";
    let receivedBody: unknown = undefined;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/sketches/generate",
        async ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          receivedBody = await request.clone().json();
          return HttpResponse.json({
            ok: true,
            task_type: "sketch_generation",
            data: { dispatched: 2, scopes: ["grid_0", "grid_1"] },
            message: "started",
          });
        },
      ),
    );

    const { result } = renderHook(() => useGenerateSketches("demo", 1), {
      wrapper,
    });

    result.current.mutate({ grid_index: -1 });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/episodes/1/sketches/generate");
    expect(receivedBody).toEqual({ grid_index: -1 });
    expect(result.current.data?.ok).toBe(true);
    if (!result.current.data?.ok) throw new Error("expected sketch generation to succeed");
    expect(result.current.data.task_type).toBe("sketch_generation");
  });

  it("passes Sketch model selection and aspect ratio to sketch generation", async () => {
    let receivedBody: unknown = undefined;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/sketches/generate",
        async ({ request }) => {
          receivedBody = await request.clone().json();
          return HttpResponse.json({
            ok: true,
            task_type: "sketch_generation",
            message: "started",
          });
        },
      ),
    );

    const { result } = renderHook(() => useGenerateSketches("demo", 1), {
      wrapper,
    });

    result.current.mutate({
      grid_index: 0,
      aspect_ratio: "16:9",
      image_generation_selection: "openrouter_nanobanana2",
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(receivedBody).toEqual({
      grid_index: 0,
      aspect_ratio: "16:9",
      image_generation_selection: "openrouter_nanobanana2",
    });
  });
});

describe("director control frame queries", () => {
  it("loads beat 3GS director stage manifest", async () => {
    let requestedPath = "";
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/4/director-stage/manifest",
        ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          return HttpResponse.json({
            ok: true,
            data: {
              viewer_kind: "three_d_director",
              mode: "beat",
              project: "demo",
              scene_id: "地下室",
              display_name: "地下室",
              source: {
                ply_url: "/static/admin/demo/director_worlds/地下室/v1/master_sharp.ply",
                source_kind: "master",
              },
              palette: {
                actors: [],
                props: [],
                anonymous_colors: [],
              },
              allowed_destinations: ["view", "beat_selected_background"],
            },
          });
        },
      ),
    );

    const { result } = renderHook(() => useBeatDirectorStageManifest("demo", 1, 4), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/episodes/1/beats/4/director-stage/manifest");
    expect(result.current.data?.ok).toBe(true);
    if (!result.current.data?.ok) throw new Error("expected director stage manifest");
    expect(result.current.data.data.source.ply_url).toContain("/static/");
  });

  it("loads and updates beat background anchors", async () => {
    const paths: string[] = [];
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/4/background-anchors",
        ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json({
            ok: true,
            data: {
              episode: 1,
              beat_num: 4,
              scene_id: "地下室",
              can_choose: true,
              current_anchor: "master",
              anchors: [{ id: "master", label: "master", exists: true, url: "/static/master.png" }],
              error: "",
            },
          });
        },
      ),
      http.patch(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/4/background-anchor",
        async ({ request }) => {
          paths.push(new URL(request.url).pathname);
          expect(await request.clone().json()).toEqual({ anchor_id: "master" });
          return HttpResponse.json({
            ok: true,
            data: {
              episode: 1,
              beat_num: 4,
              scene_id: "地下室",
              can_choose: true,
              current_anchor: "selected_background",
              anchors: [],
              error: "",
            },
          });
        },
      ),
    );

    const { result: query } = renderHook(() => useBeatBackgroundAnchors("demo", 1, 4), {
      wrapper,
    });

    await waitFor(() => expect(query.current.data).toBeDefined());
    expect(query.current.data?.ok).toBe(true);

    const { result: mutation } = renderHook(
      () => useUpdateBeatBackgroundAnchor("demo", 1, 4),
      { wrapper },
    );
    mutation.current.mutate({ anchorId: "master" });

    await waitFor(() => expect(mutation.current.data).toBeDefined());
    expect(paths).toContain("/api/v1/projects/demo/episodes/1/beats/4/background-anchors");
    expect(paths).toContain("/api/v1/projects/demo/episodes/1/beats/4/background-anchor");
    expect(mutation.current.data?.ok).toBe(true);
  });

  it("refreshes beat background anchors on focus without permanent polling", async () => {
    let requestCount = 0;
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/4/background-anchors",
        () => {
          requestCount += 1;
          return HttpResponse.json({
            ok: true,
            data: {
              episode: 1,
              beat_num: 4,
              scene_id: "地下室",
              can_choose: true,
              current_anchor: "master",
              anchors: [
                {
                  id: "director_env_only",
                  label: "director env_only",
                  exists: requestCount > 1,
                  url: requestCount > 1 ? "/static/env_only.png" : null,
                },
              ],
              error: "",
            },
          });
        },
      ),
    );

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          refetchOnWindowFocus: false,
          staleTime: 30_000,
        },
      },
    });
    const { result } = renderHook(() => useBeatBackgroundAnchors("demo", 1, 4), {
      wrapper: wrapperWithClient(queryClient),
    });

    await waitFor(() => expect(result.current.data?.ok).toBe(true));
    if (!result.current.data?.ok) throw new Error("expected background anchors");
    expect(result.current.data.data.anchors[0].exists).toBe(false);
    const stableRequestCount = requestCount;

    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(requestCount).toBe(stableRequestCount);

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    await waitFor(() => expect(requestCount).toBeGreaterThan(stableRequestCount));
    const data = result.current.data;
    expect(data?.ok).toBe(true);
    if (!data?.ok) throw new Error("expected background anchors");
    expect(data.data.anchors[0].exists).toBe(true);
  });

  it("uploads beat background anchor images into selected background", async () => {
    let requestedPath = "";
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/4/background-anchor/upload",
        ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          expect(request.headers.get("content-type") ?? "").toContain("multipart/form-data");
          return HttpResponse.json({
            ok: true,
            data: {
              episode: 1,
              beat_num: 4,
              scene_id: "地下室",
              can_choose: true,
              current_anchor: "selected_background",
              anchors: [],
              error: "",
            },
          });
        },
      ),
    );

    const { result } = renderHook(
      () => useUploadBeatBackgroundAnchor("demo", 1, 4),
      { wrapper },
    );

    result.current.mutate({
      file: new File(["x"], "background.png", { type: "image/png" }),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe(
      "/api/v1/projects/demo/episodes/1/beats/4/background-anchor/upload",
    );
    expect(result.current.data?.ok).toBe(true);
  });

  it("crops beat background anchor images into selected background", async () => {
    let requestedPath = "";
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/4/background-anchor/crop",
        async ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          expect(await request.clone().json()).toEqual({
            anchor_id: "master",
            x: 0,
            y: 0,
            width: 320,
            height: 180,
          });
          return HttpResponse.json({
            ok: true,
            data: {
              episode: 1,
              beat_num: 4,
              scene_id: "地下室",
              can_choose: true,
              current_anchor: "master",
              current_source: "master",
              render_anchor_id: "selected_background",
              anchors: [],
              error: "",
            },
          });
        },
      ),
    );

    const { result } = renderHook(
      () => useCropBeatBackgroundAnchor("demo", 1, 4),
      { wrapper },
    );

    result.current.mutate({
      anchorId: "master",
      crop: { x: 0, y: 0, width: 320, height: 180 },
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe(
      "/api/v1/projects/demo/episodes/1/beats/4/background-anchor/crop",
    );
    expect(result.current.data?.ok).toBe(true);
  });

  it("loads director control frame status for a beat", async () => {
    let requestedPath = "";
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/4/director-control-frame",
        ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          return HttpResponse.json({
            ok: true,
            data: {
              episode: 1,
              beat_num: 4,
              ready: true,
              path: "/tmp/director_control_frames/ep001/beat_04/combined.png",
              url: "/static/admin/demo/director_control_frames/ep001/beat_04/combined.png",
              scope: "director_control_to_sketch:ep001:beat_04",
            },
          });
        },
      ),
    );

    const { result } = renderHook(
      () => useDirectorControlFrameStatus("demo", 1, 4),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe(
      "/api/v1/projects/demo/episodes/1/beats/4/director-control-frame",
    );
    expect(result.current.data?.ok).toBe(true);
    if (!result.current.data?.ok) throw new Error("expected status to load");
    expect(result.current.data.data.ready).toBe(true);
    expect(result.current.data.data.scope).toBe(
      "director_control_to_sketch:ep001:beat_04",
    );
  });

  it("starts director control frame to sketch conversion for a beat", async () => {
    let requestedPath = "";
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/4/director-control-to-sketch",
        ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          return HttpResponse.json({
            ok: true,
            task_type: "sketch_generation",
            scope: "director_control_to_sketch:ep001:beat_04",
            data: {
              episode: 1,
              beat_num: 4,
              ready: true,
              url: "/static/admin/demo/director_control_frames/ep001/beat_04/combined.png",
              scope: "director_control_to_sketch:ep001:beat_04",
            },
          });
        },
      ),
    );

    const { result } = renderHook(
      () => useDirectorControlToSketch("demo", 1, 4),
      { wrapper },
    );

    result.current.mutate();

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe(
      "/api/v1/projects/demo/episodes/1/beats/4/director-control-to-sketch",
    );
    expect(result.current.data?.ok).toBe(true);
    if (!result.current.data?.ok) throw new Error("expected task to start");
    expect(result.current.data.scope).toBe("director_control_to_sketch:ep001:beat_04");
  });
});

describe("render grid query", () => {
  it("regenerates one render grid by grid index", async () => {
    let requestedPath = "";
    let receivedBody: unknown = undefined;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/grids/3/regenerate",
        async ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          receivedBody = await request.clone().json();
          return HttpResponse.json({
            ok: true,
            task_type: "grid_regenerate",
            message: "started",
          });
        },
      ),
    );

    const { result } = renderHook(() => useRegenerateGrid("demo", 1), {
      wrapper,
    });

    result.current.mutate({
      gridIndex: 3,
      model: "nanobanana",
      sceneGrouping: true,
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe(
      "/api/v1/projects/demo/episodes/1/grids/3/regenerate",
    );
    expect(receivedBody).toEqual({
      model: "nanobanana",
      scene_grouping: true,
      character_grouping: false,
    });
  });

  it("passes Render model and sizing settings to grid regeneration", async () => {
    let receivedBody: unknown = undefined;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/grids/3/regenerate",
        async ({ request }) => {
          receivedBody = await request.clone().json();
          return HttpResponse.json({
            ok: true,
            task_type: "grid_regenerate",
            message: "started",
          });
        },
      ),
    );

    const { result } = renderHook(() => useRegenerateGrid("demo", 1), {
      wrapper,
    });

    result.current.mutate({
      gridIndex: 3,
      imageGenerationSelection: "openrouter_nanobanana2",
      sketchAspectPadding: true,
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(receivedBody).toEqual({
      model: "nanobanana",
      scene_grouping: false,
      character_grouping: false,
      image_generation_selection: "openrouter_nanobanana2",
      sketch_aspect_padding: true,
    });
  });

  it("passes Render model and sketch padding settings to selected beat regeneration", async () => {
    let requestedPath = "";
    let receivedBody: unknown = undefined;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/regenerate",
        async ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          receivedBody = await request.clone().json();
          return HttpResponse.json({
            ok: true,
            task_type: "selected_regen",
            scope: "selected__1x1_2-3__1-3",
            message: "started",
          });
        },
      ),
    );

    const { result } = renderHook(() => useRegenerateRenderBeats("demo", 1), {
      wrapper,
    });

    result.current.mutate({
      beatIndices: [1, 3],
      modeKey: "1x1_2-3",
      imageGenerationSelection: "openrouter_nanobanana2",
      sketchAspectPadding: true,
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/episodes/1/beats/regenerate");
    expect(receivedBody).toEqual({
      beat_indices: [1, 3],
      mode_key: "1x1_2-3",
      image_generation_selection: "openrouter_nanobanana2",
      sketch_aspect_padding: true,
    });
  });
});

describe("beat image upload queries", () => {
  it("uploads a sketch image to the beat sketch upload endpoint", async () => {
    let requestedPath = "";
    let contentType = "";
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/5/sketch/upload",
        ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          contentType = request.headers.get("content-type") ?? "";
          return HttpResponse.json({
            ok: true,
            data: { beat_num: 5, pool_id: "beat_05_t20260101000000_sketch" },
          });
        },
      ),
    );

    const { result } = renderHook(() => useUploadBeatImage("demo", 1, "sketch"), {
      wrapper,
    });

    result.current.mutate({
      beatNum: 5,
      file: new File(["x"], "sketch.png", { type: "image/png" }),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/episodes/1/beats/5/sketch/upload");
    expect(contentType).toContain("multipart/form-data");
  });

  it("uploads a render image to the beat render upload endpoint", async () => {
    let requestedPath = "";
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/5/render/upload",
        ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          return HttpResponse.json({
            ok: true,
            data: { beat_num: 5, pool_id: "beat_05_t20260101000000_render" },
          });
        },
      ),
    );

    const { result } = renderHook(() => useUploadBeatImage("demo", 1, "render"), {
      wrapper,
    });

    result.current.mutate({
      beatNum: 5,
      file: new File(["x"], "render.png", { type: "image/png" }),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/episodes/1/beats/5/render/upload");
  });
});

describe("pool selection query", () => {
  it("throws StalePoolSelectError when backend marks the sketch candidate stale", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/5/pool-select",
        () =>
          HttpResponse.json({
            ok: false,
            stale: true,
            error: "该草图已过期，请先重新生成。如确认仍要使用，请传 force=true。",
          }),
      ),
    );

    const { result } = renderHook(() => usePoolSelect("demo", 1), {
      wrapper,
    });

    await expect(
      result.current.mutateAsync({ beatNum: 5, poolId: "stale_sketch" }),
    ).rejects.toBeInstanceOf(StalePoolSelectError);
  });

  it("updates canonical sketch_url without changing render assignments for sketch selection", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/5/pool-select",
        () =>
          HttpResponse.json({
            ok: true,
            data: {
              beat_num: 5,
              pool_id: "sketch_pool",
              image_type: "sketch",
              sketch_url: "/static/demo/sketches/ep001/beat_05.png",
            },
          }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.beats("demo", 1), {
      ok: true,
      data: [
        {
          beat_number: 5,
          narration_segment: "n",
          visual_description: "v",
          frame_url: "/static/demo/frames/ep001/beat_05.png",
          sketch_url: null,
        },
      ],
    });
    queryClient.setQueryData(queryKeys.grids("demo", 1), {
      ok: true,
      data: {
        episode: 1,
        modes: {},
        images: [],
        beat_assignments: { "5": "render_pool" },
      },
    });

    const { result } = renderHook(() => usePoolSelect("demo", 1), {
      wrapper: wrapperWithClient(queryClient),
    });

    await result.current.mutateAsync({ beatNum: 5, poolId: "sketch_pool" });

    const beats = queryClient.getQueryData<{ ok: true; data: Array<{ beat_number: number; sketch_url?: string | null }> }>(
      queryKeys.beats("demo", 1),
    );
    expect(beats?.data[0].sketch_url).toBe("/static/demo/sketches/ep001/beat_05.png");
    const grids = queryClient.getQueryData<{ ok: true; data: { beat_assignments: Record<string, string> } }>(
      queryKeys.grids("demo", 1),
    );
    expect(grids?.data.beat_assignments["5"]).toBe("render_pool");
  });
});

describe("sketch action queries", () => {
  it("cuts a render grid into the render pool", async () => {
    let requestedPath = "";
    let receivedBody: unknown = undefined;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/grids/2/cut",
        async ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          receivedBody = await request.clone().json();
          return HttpResponse.json({
            ok: true,
            data: { added: 2, skipped: 0 },
          });
        },
      ),
    );

    const { result } = renderHook(() => useCutGrid("demo", 1), {
      wrapper,
    });

    result.current.mutate({
      gridIndex: 2,
      rows: 1,
      cols: 2,
      modeKey: "2x2",
      beatNumbers: [5, 6],
      gridType: "render",
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/episodes/1/grids/2/cut");
    expect(receivedBody).toEqual({
      grid_type: "render",
      mode_key: "2x2",
      rows: 1,
      cols: 2,
      beat_start: 5,
      beat_end: 6,
      beat_numbers: [5, 6],
    });
  });

  it("uploads a replacement render grid with mode and beat scope", async () => {
    let requestedPath = "";
    let contentType = "";
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/grids/2/upload",
        async ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          contentType = request.headers.get("content-type") ?? "";
          return HttpResponse.json({
            ok: true,
            data: {
              grid_index: 2,
              grid_path: "custom/render_2x2_5-6_grid_upload.png",
              grid_url: "/static/grid.png",
            },
          });
        },
      ),
    );

    const { result } = renderHook(() => useUploadGrid("demo", 1), {
      wrapper,
    });
    const file = new File(["grid"], "grid.png", { type: "image/png" });

    result.current.mutate({
      gridIndex: 2,
      file,
      gridType: "render",
      modeKey: "2x2",
      beatNumbers: [5, 6],
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/episodes/1/grids/2/upload");
    expect(contentType).toContain("multipart/form-data");
  });

  it("exports a render grid prompt by grid scope", async () => {
    let requestedPath = "";
    let requestedSearch = "";
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/grids/2/prompt",
        ({ request }) => {
          const url = new URL(request.url);
          requestedPath = url.pathname;
          requestedSearch = url.search;
          return HttpResponse.json({
            ok: true,
            data: {
              grid_index: 2,
              prompt: "render prompt text",
              prompt_path: "custom/render_2x2_5-6_prompt.txt",
            },
          });
        },
      ),
    );

    const { result } = renderHook(() => useExportGridPrompt("demo", 1), {
      wrapper,
    });

    result.current.mutate({
      gridIndex: 2,
      gridType: "render",
      modeKey: "2x2",
      beatNumbers: [5, 6],
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/episodes/1/grids/2/prompt");
    expect(requestedSearch).toContain("grid_type=render");
    expect(requestedSearch).toContain("mode_key=2x2");
    expect(requestedSearch).toContain("beat_numbers=5%2C6");
    expect(result.current.data?.ok).toBe(true);
    if (!result.current.data?.ok) throw new Error("expected prompt export to succeed");
    expect(result.current.data.data.prompt).toBe("render prompt text");
  });

  it("uses the v2 assign-colors endpoint and forwards force=true", async () => {
    let requestedPath = "";
    let requestedForce = "";
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/sketches/assign-colors",
        ({ request }) => {
          const url = new URL(request.url);
          requestedPath = url.pathname;
          requestedForce = url.searchParams.get("force") ?? "";
          return HttpResponse.json({
            ok: true,
            data: {
              colors: { hero_main: "#ffffff" },
              count: 1,
              prop_colors: { jade_sword: "#00ff00" },
              prop_count: 1,
            },
          });
        },
      ),
    );

    const { result } = renderHook(() => useAssignColors("demo", 1), {
      wrapper,
    });

    result.current.mutate({ force: true });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/episodes/1/sketches/assign-colors");
    expect(requestedForce).toBe("true");
    expect(result.current.data?.ok).toBe(true);
    if (!result.current.data?.ok) throw new Error("expected assign-colors to succeed");
    expect(result.current.data.data.prop_count).toBe(1);
  });

  it("invalidates episode detail after assigning prop colors", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/sketches/assign-colors",
        () =>
          HttpResponse.json({
            ok: true,
            data: {
              colors: { hero_main: "#ffffff" },
              count: 1,
              prop_colors: { jade_sword: "#00ff00" },
              prop_count: 1,
            },
          }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const episodeDetailKey = queryKeys.episodeDetail("demo", 1);
    queryClient.setQueryData(episodeDetailKey, {
      ok: true,
      data: {
        number: 1,
        prop_menu: [{ prop_id: "jade_sword", marker_color: null }],
      },
    });

    const { result } = renderHook(() => useAssignColors("demo", 1), {
      wrapper: wrapperWithClient(queryClient),
    });

    await result.current.mutateAsync({ force: true });

    expect(queryClient.getQueryState(episodeDetailKey)?.isInvalidated).toBe(
      true,
    );
  });

  it("uses the v2 detect-identities endpoint", async () => {
    let requestedPath = "";
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/sketches/detect-identities",
        ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          return HttpResponse.json({
            ok: true,
            data: {
              detections: { "1": ["hero_main"] },
              identity_detections: { "1": ["hero_main"] },
              prop_detections: { "1": ["jade_sword"] },
              total_beats: 1,
              total_identities: 1,
              total_props: 1,
            },
          });
        },
      ),
    );

    const { result } = renderHook(() => useDetectIdentities("demo", 1), {
      wrapper,
    });

    result.current.mutate();

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/episodes/1/sketches/detect-identities");
    expect(result.current.data?.ok).toBe(true);
    if (!result.current.data?.ok) throw new Error("expected detect identities to succeed");
    expect(result.current.data.data.prop_detections).toEqual({ "1": ["jade_sword"] });
    expect(result.current.data.data.total_props).toBe(1);
  });

  it("uses a long timeout for AI detection because the backend runs model batches synchronously", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/sketches/detect-identities",
        () =>
          HttpResponse.json({
            ok: true,
            data: {
              detections: {},
              identity_detections: {},
              prop_detections: {},
              total_beats: 64,
              total_identities: 0,
              total_props: 0,
            },
          }),
      ),
    );
    const postSpy = vi.spyOn(api, "post");

    const { result } = renderHook(() => useDetectIdentities("demo", 1), {
      wrapper,
    });

    result.current.mutate();

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(postSpy).toHaveBeenCalledWith(
      "api/v1/projects/demo/episodes/1/sketches/detect-identities",
      expect.objectContaining({ timeout: 180_000 }),
    );

    postSpy.mockRestore();
  });

  it("parses AI detection billing errors from backend responses", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/sketches/detect-identities",
        () =>
          HttpResponse.json(
            {
              ok: false,
              error: "计费规则未配置，请联系管理员设置积分规则",
              data: {
                error_code: "BILLING_RULE_NOT_CONFIGURED",
                billing_kind: "feature",
                billing_key: "ai_identity_detection",
              },
            },
            { status: 409 },
          ),
      ),
    );

    const { result } = renderHook(() => useDetectIdentities("demo", 1), {
      wrapper,
    });

    result.current.mutate();

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.error).toBeInstanceOf(BillingRuleNotConfiguredError);
  });

  it("refreshes beats and script caches after AI detection writes detected identities", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/sketches/detect-identities",
        () =>
          HttpResponse.json({
            ok: true,
            data: {
              detections: { "1": ["hero_main"] },
              identity_detections: { "1": ["hero_main"] },
              prop_detections: {},
              total_beats: 1,
              total_identities: 1,
              total_props: 0,
            },
          }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDetectIdentities("demo", 1), {
      wrapper: wrapperWithClient(queryClient),
    });

    result.current.mutate();

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.beats("demo", 1),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.script("demo", 1),
    });
  });
});
