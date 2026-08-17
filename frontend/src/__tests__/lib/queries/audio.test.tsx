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
  useAudioBillingQuote,
  useGenerateAudio,
  useRegenerateBeatAudio,
} from "@/lib/queries/audio";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("IndexTTS2 audio query contract", () => {
  it("quotes the exact selected Beat quantity through the audio feature endpoint", async () => {
    let receivedBody: unknown = undefined;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/audio/billing-quote",
        async ({ request }) => {
          receivedBody = await request.clone().json();
          return HttpResponse.json({
            ok: true,
            data: {
              beat_numbers: [2, 4],
              quantity: 2,
              unit_cost: 3,
              cost: 6,
              display: "6",
              prereq_errors: [],
            },
          });
        },
      ),
    );

    const { result } = renderHook(
      () =>
        useAudioBillingQuote("demo", 1, {
          beatNumbers: [2, 4],
          mode: "redo_selected",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(receivedBody).toEqual({
      beat_numbers: [2, 4],
      mode: "redo_selected",
    });
    expect(result.current.data?.data.quantity).toBe(2);
    expect(result.current.data?.data.cost).toBe(6);
  });

  it("posts selected beat audio generation to /audio/generate as an async IndexTTS2 task", async () => {
    let requestedPath = "";
    let receivedBody: unknown = undefined;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/audio/generate",
        async ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          receivedBody = await request.clone().json();
          return HttpResponse.json({
            ok: true,
            task_type: "audio_generation_indextts2",
            message: "started",
          });
        },
      ),
    );

    const { result } = renderHook(() => useGenerateAudio("demo", 1), {
      wrapper,
    });

    result.current.mutate({
      beatNumbers: [2, 4],
      mode: "redo_selected",
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/episodes/1/audio/generate");
    expect(receivedBody).toEqual({
      beat_numbers: [2, 4],
      mode: "redo_selected",
    });
    expect(result.current.data?.ok).toBe(true);
    if (result.current.data?.ok !== true) throw new Error("expected task response");
    expect(result.current.data?.task_type).toBe("audio_generation_indextts2");
  });

  it("treats single beat regeneration as an async IndexTTS2 task", async () => {
    let requestedPath = "";
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/beats/5/audio",
        ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          return HttpResponse.json({
            ok: true,
            task_type: "audio_generation_indextts2",
            message: "started",
          });
        },
      ),
    );

    const { result } = renderHook(() => useRegenerateBeatAudio("demo", 1), {
      wrapper,
    });

    result.current.mutate(5);

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/episodes/1/beats/5/audio");
    expect(result.current.data?.ok).toBe(true);
    if (result.current.data?.ok !== true) throw new Error("expected task response");
    expect(result.current.data?.task_type).toBe("audio_generation_indextts2");
  });
});
