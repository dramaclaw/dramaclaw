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
}));

import { queryKeys } from "@/lib/query-keys";
import { BillingRuleNotConfiguredError } from "@/lib/api-errors";
import { deriveEpisodeStats } from "@/lib/episode-stats";
import {
  derivePipelineEpisodeStatuses,
  isPlanEpisodeAssetsResult,
  mergeEpisodeIntoList,
  useEpisodeDetail,
  usePlanEpisodeProps,
  usePlanEpisodeScenes,
  usePlanEpisodes,
  usePlanIdentities,
  useUpdateEpisode,
} from "@/lib/queries/episodes";

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

describe("episode identity planning", () => {
  it("starts the identity planning actor task and returns TaskResponse", async () => {
    let requestedPath = "";
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/identities/:action",
        async ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          return HttpResponse.json({
            ok: true,
            task_type: "identity_planner",
            message: "第 1 集身份规划任务已启动",
          });
        },
      ),
    );

    const { result } = renderHook(() => usePlanIdentities("demo"), { wrapper });
    result.current.mutate(1);

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe(
      "/api/v1/projects/demo/episodes/1/identities/plan",
    );
    expect(result.current.data?.ok).toBe(true);
    expect(result.current.data).toMatchObject({
      ok: true,
      task_type: "identity_planner",
    });
  });

  it("surfaces missing feature billing rules as a typed error", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/identities/plan",
        () =>
          HttpResponse.json(
            {
              ok: false,
              error: "计费规则未配置，请联系管理员设置积分规则",
              data: {
                error_code: "BILLING_RULE_NOT_CONFIGURED",
                billing_kind: "feature",
                billing_key: "identity_planner",
              },
            },
            { status: 409 },
          ),
      ),
    );

    const { result } = renderHook(() => usePlanIdentities("demo"), { wrapper });

    await expect(result.current.mutateAsync(1)).rejects.toBeInstanceOf(
      BillingRuleNotConfiguredError,
    );
  });
});

describe("episode planning", () => {
  it("surfaces missing feature billing rules as a typed error", async () => {
    server.use(
      http.post("http://localhost:3000/api/v1/projects/demo/episodes/plan", () =>
        HttpResponse.json(
          {
            ok: false,
            error: "计费规则未配置，请联系管理员设置积分规则",
            data: {
              error_code: "BILLING_RULE_NOT_CONFIGURED",
              billing_kind: "feature",
              billing_key: "build_episodes",
            },
          },
          { status: 409 },
        ),
      ),
    );

    const { result } = renderHook(() => usePlanEpisodes("demo"), { wrapper });

    await expect(result.current.mutateAsync({})).rejects.toBeInstanceOf(
      BillingRuleNotConfiguredError,
    );
  });
});

describe("pipeline status contract", () => {
  it("aborts in-flight episode detail GETs when the query unmounts", async () => {
    let seenRequest = false;
    let aborted = false;
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/episodes/1",
        async ({ request }) => {
          seenRequest = true;
          request.signal.addEventListener("abort", () => {
            aborted = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 250));
          return HttpResponse.json({
            ok: true,
            data: { episode: 1 },
          });
        },
      ),
    );

    const { unmount } = renderHook(() => useEpisodeDetail("demo", 1), {
      wrapper,
    });

    await waitFor(() => expect(seenRequest).toBe(true));
    unmount();

    await waitFor(() => expect(aborted).toBe(true));
  });

  it("derives list-card stage dots from the v2 backend pipeline payload", () => {
    expect(
      derivePipelineEpisodeStatuses({
        project: "demo",
        global: {
          ingested: true,
          configured: true,
          characters: 2,
          episodes: 3,
          portraits_done: true,
        },
        current_episode: 2,
        episode_status: {
          identity_plan: true,
          identity_images: true,
          script: true,
          sketches: true,
          coloring: false,
          global_optimize: false,
          first_frames: false,
          tts: false,
          video: false,
        },
        next_step: "global_optimize_video",
        next_step_name: "全局视频优化",
      }),
    ).toEqual([
      {
        episode: 2,
        script: true,
        sketch: true,
        audio: false,
        video: false,
        compose: false,
      },
    ]);
  });
});

describe("episode list stats", () => {
  it("counts episodes, planned identities, and key events like NiceGUI", () => {
    expect(
      deriveEpisodeStats([
        {
          number: 1,
          title: "第一集",
          identity_ids: ["秦_幼年", "赵_青年"],
          key_events: ["入宫"],
        },
        {
          number: 2,
          title: "第二集",
          identity_ids: ["秦_青年"],
          key_events: ["冲突", "离别"],
        },
      ]),
    ).toEqual({
      totalEpisodes: 2,
      totalIdentities: 3,
      totalKeyEvents: 3,
      totalScenes: 0,
      totalProps: 0,
    });
  });
});

describe("episode list cache merging", () => {
  it("updates only the planned episode after identity planning returns fresh detail", () => {
    expect(
      mergeEpisodeIntoList(
        [
          { number: 1, title: "第一集", identity_ids: ["陆辰_青年时期"] },
          { number: 2, title: "第二集", identity_ids: [] },
        ],
        {
          number: 2,
          title: "第二集",
          identity_ids: ["陆辰_青年时期", "沈月白_青年时期"],
          identity_default_map: { 陆辰: "陆辰_青年时期" },
        },
      ),
    ).toEqual([
      { number: 1, title: "第一集", identity_ids: ["陆辰_青年时期"] },
      {
        number: 2,
        title: "第二集",
        identity_ids: ["陆辰_青年时期", "沈月白_青年时期"],
        identity_default_map: { 陆辰: "陆辰_青年时期" },
      },
    ]);
  });
});

describe("episode scene / prop planning", () => {
  it("plans episode scenes through the canonical scene endpoint and refreshes episode detail", async () => {
    let requestedPath = "";
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/scenes/plan",
        async ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          return HttpResponse.json({
            ok: true,
            data: {
              kind: "scene",
              total_count: 1,
              new_count: 1,
              scene_menu: [{ scene_id: "宫门" }],
              logs: ["planned scenes"],
              episode: { number: 1, title: "第一集", scene_menu: [{ scene_id: "宫门" }] },
            },
          });
        },
      ),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => usePlanEpisodeScenes("demo"), {
      wrapper: wrapperWithClient(queryClient),
    });

    result.current.mutate(1);

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/episodes/1/scenes/plan");
    expect(result.current.data?.ok).toBe(true);
    if (result.current.data && isPlanEpisodeAssetsResult(result.current.data)) {
      expect(result.current.data.data.kind).toBe("scene");
    }
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.episodeDetail("demo", 1),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.episodes("demo"),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.scenes("demo"),
    });
  });

  it("accepts queued episode scene planning tasks without requiring episode detail", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/2/scenes/plan",
        () =>
          HttpResponse.json({
            ok: true,
            task_type: "episode_scene_planner",
            task_id: "task-1",
            task_key: "task:episode_scene_planner:project:demo:2",
            backend: "celery",
            queue: "default",
            data: { target_episode: 2, asset_kind: "scene" },
            message: "第 2 集场景规划已进入队列",
          }),
      ),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => usePlanEpisodeScenes("demo"), {
      wrapper: wrapperWithClient(queryClient),
    });

    result.current.mutate(2);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({
      ok: true,
      task_type: "episode_scene_planner",
      message: "第 2 集场景规划已进入队列",
    });
    expect(result.current.isError).toBe(false);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.tasks("demo"),
    });
  });

  it("plans episode props through the canonical prop endpoint and refreshes episode detail", async () => {
    let requestedPath = "";
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/props/plan",
        async ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          return HttpResponse.json({
            ok: true,
            data: {
              kind: "prop",
              total_count: 1,
              prop_menu: [{ prop_id: "玉佩", prop_type: "object" }],
              logs: ["planned props"],
              episode: { number: 1, title: "第一集", prop_menu: [{ prop_id: "玉佩" }] },
            },
          });
        },
      ),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => usePlanEpisodeProps("demo"), {
      wrapper: wrapperWithClient(queryClient),
    });

    result.current.mutate(1);

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/episodes/1/props/plan");
    expect(result.current.data?.ok).toBe(true);
    if (result.current.data && isPlanEpisodeAssetsResult(result.current.data)) {
      expect(result.current.data.data.kind).toBe("prop");
    }
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.episodeDetail("demo", 1),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.episodes("demo"),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.props("demo"),
    });
  });
});

describe("episode detail queries", () => {
  it("fetches complete episode detail from the detail endpoint", async () => {
    let requestedPath = "";
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/episodes/1",
        async ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          return HttpResponse.json({
            ok: true,
            data: {
              number: 1,
              title: "第一集",
              summary: "摘要",
              raw_content: "原文",
              beat_source_text: "分镜源文本",
              content_summary: "摘要",
              character_names: ["秦"],
              key_events: ["入宫"],
              cliffhanger: "悬念",
              identity_ids: ["秦_幼年"],
              identity_default_map: { 秦: "秦_幼年" },
              scene_menu: [{ scene_id: "宫门" }],
              prop_menu: [
                {
                  prop_id: "玉佩",
                  prop_type: "object",
                  visual_prompt: "",
                  description: "",
                  owner_identity_id: "",
                },
              ],
            },
          });
        },
      ),
    );

    const { result } = renderHook(() => useEpisodeDetail("demo", 1), {
      wrapper,
    });

    await waitFor(() =>
      expect(result.current.data?.data.beat_source_text).toBe("分镜源文本"),
    );
    expect(result.current.data?.data.identity_default_map).toEqual({
      秦: "秦_幼年",
    });
    expect(requestedPath).toBe("/api/v1/projects/demo/episodes/1");
  });

  it("patches source fields and refreshes dependent episode caches", async () => {
    let receivedBody: unknown = undefined;
    server.use(
      http.patch(
        "http://localhost:3000/api/v1/projects/demo/episodes/1",
        async ({ request }) => {
          receivedBody = await request.clone().json();
          return HttpResponse.json({
            ok: true,
            data: {
              number: 1,
              title: "第一集",
              beat_source_text: "新分镜源文本",
              identity_default_map: { 秦: "秦_青年" },
            },
          });
        },
      ),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useUpdateEpisode("demo"), {
      wrapper: wrapperWithClient(queryClient),
    });

    result.current.mutate({
      episodeNum: 1,
      data: {
        beat_source_text: "新分镜源文本",
        identity_default_map: { 秦: "秦_青年" },
      },
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(receivedBody).toEqual({
      beat_source_text: "新分镜源文本",
      identity_default_map: { 秦: "秦_青年" },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.episodes("demo"),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.episodeDetail("demo", 1),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.script("demo", 1),
    });
  });
});
