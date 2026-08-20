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

import { ProjectQueueLimitError } from "@/lib/api-errors";
import {
  useGenerateIdentityImageAsync,
  useGenerateIdentityPortraitAsync,
  useGeneratePortraitAsync,
} from "@/lib/queries/characters";
import { useGenerateSceneMasterAsync } from "@/lib/queries/scenes";
import { useRegenerateBeatVideo } from "@/lib/queries/video";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("character generation model selection", () => {
  it("posts the selected model when generating a character portrait", async () => {
    let body: unknown = null;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/characters/%E7%A7%A6/portrait-async",
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ ok: true, task_id: "task-portrait" });
        },
      ),
    );

    const { result } = renderHook(() => useGeneratePortraitAsync("demo", "秦"), {
      wrapper,
    });
    result.current.mutate({ model: "openrouter_nanobanana2" });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(body).toEqual({ model: "openrouter_nanobanana2" });
  });

  it("surfaces backend queue-limit errors when generating a character portrait", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/characters/%E7%A7%A6/portrait-async",
        () =>
          HttpResponse.json(
            {
              ok: false,
              error: "当前项目 default 队列任务已满，请等待已有任务完成后再提交",
              data: {
                project_id: "demo",
                queue_kind: "default",
                limit: 3,
                active: 3,
              },
            },
            { status: 429 },
          ),
      ),
    );

    const { result } = renderHook(() => useGeneratePortraitAsync("demo", "秦"), {
      wrapper,
    });

    const promise = result.current.mutateAsync(undefined);
    await expect(promise).rejects.toMatchObject({
      name: "ProjectQueueLimitError",
      queueKind: "default",
    });
    await expect(promise).rejects.toBeInstanceOf(ProjectQueueLimitError);
  });

  it("surfaces backend queue-limit errors when generating a scene master", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/scenes/%E5%8A%9E%E5%85%AC%E5%AE%A4/master/generate-async",
        () =>
          HttpResponse.json(
            {
              ok: false,
              error: "当前项目 default 队列任务已满，请等待已有任务完成后再提交",
              data: {
                project_id: "demo",
                queue_kind: "default",
                limit: 3,
                active: 3,
              },
            },
            { status: 429 },
          ),
      ),
    );

    const { result } = renderHook(
      () => useGenerateSceneMasterAsync("demo", "办公室"),
      { wrapper },
    );

    const promise = result.current.mutateAsync();
    await expect(promise).rejects.toMatchObject({
      name: "ProjectQueueLimitError",
      queueKind: "default",
    });
    await expect(promise).rejects.toBeInstanceOf(ProjectQueueLimitError);
  });

  it("surfaces backend queue-limit errors when generating a beat video", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/6/video",
        () =>
          HttpResponse.json(
            {
              ok: false,
              error: "当前项目 video 队列任务已满，请等待已有任务完成后再提交",
              data: {
                project_id: "demo",
                queue_kind: "video",
                limit: 1,
                active: 1,
              },
            },
            { status: 429 },
          ),
      ),
    );

    const { result } = renderHook(() => useRegenerateBeatVideo("demo", 1), {
      wrapper,
    });

    const promise = result.current.mutateAsync({
      beatNum: 6,
      videoBackend: "huimeng_seedance-1.0-pro-fast",
    });
    await expect(promise).rejects.toMatchObject({
      name: "ProjectQueueLimitError",
      queueKind: "video",
    });
    await expect(promise).rejects.toBeInstanceOf(ProjectQueueLimitError);
  });

  it("posts the selected model when generating an identity image", async () => {
    let requestedPath = "";
    let body: unknown = null;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/characters/%E7%A7%A6/identities/id-1/generate-async",
        async ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          body = await request.json();
          return HttpResponse.json({ ok: true, task_id: "task-image" });
        },
      ),
    );

    const { result } = renderHook(
      () => useGenerateIdentityImageAsync("demo", "秦"),
      { wrapper },
    );
    result.current.mutate({
      identityId: "id-1",
      model: "openrouter_nanobanana2",
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe(
      "/api/v1/projects/demo/characters/%E7%A7%A6/identities/id-1/generate-async",
    );
    expect(body).toEqual({ model: "openrouter_nanobanana2" });
  });

  it("posts the selected model when generating an identity portrait", async () => {
    let body: unknown = null;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/characters/%E7%A7%A6/identities/id-1/portrait/generate-async",
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ ok: true, task_id: "task-identity-portrait" });
        },
      ),
    );

    const { result } = renderHook(
      () => useGenerateIdentityPortraitAsync("demo", "秦"),
      { wrapper },
    );
    result.current.mutate({
      identityId: "id-1",
      model: "openrouter_nanobanana2",
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(body).toEqual({ model: "openrouter_nanobanana2" });
  });
});
