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
  useCharacterVoiceSamples,
  useDeleteCharacterVoiceSample,
  useRecordCharacterVoiceSample,
  useTrimCharacterVoiceSample,
  useUploadCharacterVoiceSample,
} from "@/lib/queries/characters";
import { queryKeys } from "@/lib/query-keys";
import type { OkResponse } from "@/types/api";
import type { Character } from "@/types/character";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function wrapperWithClient(qc: QueryClient) {
  return function TestQueryProvider({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("character voice sample query hooks", () => {
  it("fetches default and age voice slots", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/characters/%E7%A7%A6/voice-samples",
        () =>
          HttpResponse.json({
            ok: true,
            data: {
              character: "秦",
              slots: [
                {
                  slot: "default",
                  label: "默认（兜底）",
                  path: "assets/characters/秦/voices/voice_default.wav",
                  url: "/static/admin/demo/assets/characters/秦/voices/voice_default.wav",
                  sha256: "sha",
                  updated_at: "2026-05-13T00:00:00+00:00",
                  inherited_from_default: false,
                  required: true,
                },
                {
                  slot: "child",
                  label: "幼年",
                  path: "",
                  url: "",
                  sha256: "",
                  updated_at: "",
                  inherited_from_default: true,
                  required: false,
                },
              ],
            },
          }),
      ),
    );

    const { result } = renderHook(() => useCharacterVoiceSamples("demo", "秦"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.data.slots.map((slot) => slot.slot)).toEqual([
      "default",
      "child",
    ]);
  });

  it("uploads a voice sample to a specific slot", async () => {
    let contentType = "";
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/characters/%E7%A7%A6/voice-samples/default/upload",
        async ({ request }) => {
          contentType = request.headers.get("content-type") ?? "";
          return HttpResponse.json({
            ok: true,
            data: { slot: "default", path: "voice_default.wav" },
          });
        },
      ),
    );

    const { result } = renderHook(() => useUploadCharacterVoiceSample("demo", "秦"), {
      wrapper,
    });
    result.current.mutate({ slot: "default", file: new File(["voice"], "voice.wav") });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(contentType).toContain("multipart/form-data");
  });

  it("updates the cached character list when the default voice upload returns", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData<OkResponse<Character[]>>(queryKeys.characters("demo"), {
      ok: true,
      data: [
        {
          name: "秦",
          age_group: "youth",
          reference_audio_path: "",
          reference_audio_url: "",
        },
      ],
    });

    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/characters/%E7%A7%A6/voice-samples/default/upload",
        () =>
          HttpResponse.json({
            ok: true,
            data: {
              slot: "default",
              label: "默认（兜底）",
              path: "assets/characters/秦/voices/voice_default.wav",
              url: "/static/admin/demo/assets/characters/秦/voices/voice_default.wav",
              sha256: "sha-default",
              updated_at: "2026-05-18T06:18:28+00:00",
              inherited_from_default: false,
              required: true,
            },
          }),
      ),
    );

    const { result } = renderHook(
      () => useUploadCharacterVoiceSample("demo", "秦"),
      {
        wrapper: wrapperWithClient(qc),
      },
    );

    result.current.mutate({
      slot: "default",
      file: new File(["voice"], "voice.wav"),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    const cached = qc.getQueryData<OkResponse<Character[]>>(
      queryKeys.characters("demo"),
    );
    expect(cached?.data[0]).toMatchObject({
      reference_audio_path: "assets/characters/秦/voices/voice_default.wav",
      reference_audio_url:
        "/static/admin/demo/assets/characters/秦/voices/voice_default.wav",
      reference_audio_sha256: "sha-default",
      reference_audio_updated_at: "2026-05-18T06:18:28+00:00",
    });
  });

  it("invalidates audio billing quotes after a character voice changes", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/characters/%E7%A7%A6/voice-samples/default/upload",
        () =>
          HttpResponse.json({
            ok: true,
            data: { slot: "default", path: "voice_default.wav" },
          }),
      ),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(
      () => useUploadCharacterVoiceSample("demo", "秦"),
      { wrapper: wrapperWithClient(qc) },
    );

    result.current.mutate({
      slot: "default",
      file: new File(["voice"], "voice.wav"),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.audioBillingQuotes("demo"),
    });
  });

  it("posts recorded data URLs to the record endpoint", async () => {
    let body: unknown = null;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/characters/%E7%A7%A6/voice-samples/youth/record",
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({
            ok: true,
            data: { slot: "youth", path: "voice_youth.wav" },
          });
        },
      ),
    );

    const { result } = renderHook(() => useRecordCharacterVoiceSample("demo", "秦"), {
      wrapper,
    });
    result.current.mutate({ slot: "youth", dataUrl: "data:audio/wav;base64,dm9pY2U=" });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(body).toEqual({ data_url: "data:audio/wav;base64,dm9pY2U=" });
  });

  it("posts trim ranges to the trim endpoint", async () => {
    let body: unknown = null;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/characters/%E7%A7%A6/voice-samples/default/trim",
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({
            ok: true,
            data: { slot: "default", path: "voice_default.wav" },
          });
        },
      ),
    );

    const { result } = renderHook(() => useTrimCharacterVoiceSample("demo", "秦"), {
      wrapper,
    });
    result.current.mutate({
      slot: "default",
      sourcePath: "assets/characters/秦/voices/voice_default.wav",
      startSeconds: 1.2,
      durationSeconds: 4,
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(body).toEqual({
      source_path: "assets/characters/秦/voices/voice_default.wav",
      start_seconds: 1.2,
      duration_seconds: 4,
    });
  });

  it("deletes a specific voice slot", async () => {
    let called = false;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/characters/%E7%A7%A6/voice-samples/child/delete",
        () => {
          called = true;
          return HttpResponse.json({
            ok: true,
            data: { slot: "child", path: "" },
          });
        },
      ),
    );

    const { result } = renderHook(() => useDeleteCharacterVoiceSample("demo", "秦"), {
      wrapper,
    });
    result.current.mutate("child");

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(called).toBe(true);
  });
});
