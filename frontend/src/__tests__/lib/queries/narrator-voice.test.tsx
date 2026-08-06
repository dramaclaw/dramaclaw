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

import {
  useCopyProjectNarratorVoice,
  useDeleteNarratorVoice,
  useNarratorVoiceSources,
  useNarratorVoiceStatus,
  useRecordNarratorVoice,
  useUploadNarratorVoice,
} from "@/lib/queries/video";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function wrapperWithClient(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("narrator voice query hooks", () => {
  it("loads project narrator voice status", async () => {
    let requestedPath = "";
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/narrator-voice", ({ request }) => {
        requestedPath = new URL(request.url).pathname;
        return HttpResponse.json({
          ok: true,
          data: {
            narration_style: "third_person",
            source: "project_narrator",
            reference_path: "assets/narrator/voice.wav",
            reference_url: "/static/demo/assets/narrator/voice.wav",
            reference_sha256: "sha",
            heading: "第三人称项目解说声线",
            detail: "assets/narrator/voice.wav",
            explanation: "第三人称解说使用项目级声线",
            is_first_person: false,
          },
        });
      }),
    );

    const { result } = renderHook(() => useNarratorVoiceStatus("demo"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/narrator-voice");
    expect(result.current.data?.data.reference_path).toBe("assets/narrator/voice.wav");
  });

  it("loads reusable project audio sources", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/narrator-voice/sources",
        () =>
          HttpResponse.json({
            ok: true,
            data: {
              options: [
                {
                  label: "已生成音频 · beat_01.mp3",
                  path: "/project/audio/ep001/beat_01.mp3",
                  rel_path: "audio/ep001/beat_01.mp3",
                },
              ],
            },
          }),
      ),
    );

    const { result } = renderHook(() => useNarratorVoiceSources("demo"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.data.options[0]?.rel_path).toBe(
      "audio/ep001/beat_01.mp3",
    );
  });

  it("uploads narrator voice audio as multipart form data", async () => {
    let contentType = "";
    let byteLength = 0;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/narrator-voice/upload",
        async ({ request }) => {
          contentType = request.headers.get("content-type") ?? "";
          byteLength = contentType ? 1 : 0;
          return HttpResponse.json({ ok: true, data: { reference_path: "assets/narrator/voice.wav" } });
        },
      ),
    );

    const { result } = renderHook(() => useUploadNarratorVoice("demo"), {
      wrapper,
    });
    result.current.mutate(new File(["voice"], "voice.wav"));

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(contentType).toContain("multipart/form-data");
    expect(byteLength).toBeGreaterThan(0);
  });

  it("posts recorded narrator voice data URLs", async () => {
    let body: unknown = null;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/narrator-voice/record",
        async ({ request }) => {
          body = await request.clone().json();
          return HttpResponse.json({ ok: true, data: { reference_path: "assets/narrator/voice.webm" } });
        },
      ),
    );

    const { result } = renderHook(() => useRecordNarratorVoice("demo"), {
      wrapper,
    });
    result.current.mutate("data:audio/webm;base64,dm9pY2U=");

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(body).toEqual({ data_url: "data:audio/webm;base64,dm9pY2U=" });
  });

  it("copies an existing project audio file as narrator voice", async () => {
    let body: unknown = null;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/narrator-voice/copy",
        async ({ request }) => {
          body = await request.clone().json();
          return HttpResponse.json({ ok: true, data: { reference_path: "assets/narrator/voice.mp3" } });
        },
      ),
    );

    const { result } = renderHook(() => useCopyProjectNarratorVoice("demo"), {
      wrapper,
    });
    result.current.mutate("/project/audio/ep001/beat_01.mp3");

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(body).toEqual({ source_path: "/project/audio/ep001/beat_01.mp3" });
  });

  it("deletes the configured narrator voice", async () => {
    let called = false;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/narrator-voice/delete",
        () => {
          called = true;
          return HttpResponse.json({ ok: true, data: { reference_path: "" } });
        },
      ),
    );

    const { result } = renderHook(() => useDeleteNarratorVoice("demo"), {
      wrapper,
    });
    result.current.mutate();

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(called).toBe(true);
  });

  it("invalidates dependent generation state after narrator voice changes", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/narrator-voice/delete",
        () => HttpResponse.json({ ok: true, data: { reference_path: "" } }),
      ),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useDeleteNarratorVoice("demo"), {
      wrapper: wrapperWithClient(qc),
    });

    result.current.mutate();

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["seedance2-beat-status", "demo"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["audio-billing-quote", "demo"],
    });
  });
});
