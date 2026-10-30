// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "@/__mocks__/msw/server";
import ky from "ky";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));
import {
  createVoiceDesign,
  getVoiceDesign,
  useVoiceDesignQuote,
  VoiceDesignApiError,
} from "@/lib/queries/voice-design";
import { useSaveGeneratedCharacterVoice } from "@/lib/queries/characters";
import { queryKeys } from "@/lib/query-keys";

afterEach(() => server.resetHandlers());

const id = "178727cd-e421-451c-87e7-68779d72a8ec";
const body = {
  request_id: id,
  surface: "canvas" as const,
  description: "温柔",
  preview_text: "今天的天气很好，我们沿着河边慢慢走回家。",
  language: "zh" as const,
};
const base = "http://localhost:3000/api/v1/projects/demo";
function provider(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}
it("uses project quote and actual surface", async () => {
  server.use(
    http.get(`${base}/voice-design/quote`, ({ request }) => {
      expect(new URL(request.url).searchParams.get("surface")).toBe("canvas");
      return HttpResponse.json({
        ok: true,
        data: { cost: 7, display: "7", unit: "call", quantity: 1 },
      });
    }),
  );
  const { result } = renderHook(() => useVoiceDesignQuote("demo", "canvas"), {
    wrapper: provider(new QueryClient()),
  });
  await waitFor(() => expect(result.current.data?.display).toBe("7"));
});
it("creates one request without touching formal character cache and queries its original ID", async () => {
  const calls: unknown[] = [];
  server.use(
    http.post(`${base}/voice-design/candidates`, async ({ request }) => {
      calls.push(await request.json());
      return HttpResponse.json(
        { ok: true, data: { candidate_id: id, status: "generating" } },
        { status: 202 },
      );
    }),
    http.get(`${base}/voice-design/candidates/${id}`, () =>
      HttpResponse.json({
        ok: true,
        data: {
          candidate_id: id,
          status: "unknown",
          failure: {
            code: "generation_unknown",
            message: "查询原任务",
            retryable: true,
          },
        },
      }),
    ),
  );
  expect(await createVoiceDesign("demo", body)).toMatchObject({
    candidate_id: id,
    status: "generating",
  });
  expect(await getVoiceDesign("demo", id)).toMatchObject({ status: "unknown" });
  expect(calls).toEqual([body]);
});
it.each([402, 403, 409, 422, 429, 502, 503, 504])(
  "retains structured HTTP %s errors without retries",
  async (status) => {
    let calls = 0;
    server.use(
      http.post(`${base}/voice-design/candidates`, () => {
        calls++;
        return HttpResponse.json(
          {
            ok: false,
            code: "provider_unavailable",
            error: "明确原因",
            retryable: true,
            request_id: id,
          },
          { status },
        );
      }),
    );
    await expect(createVoiceDesign("demo", body)).rejects.toMatchObject({
      message: "明确原因",
      code: "provider_unavailable",
    });
    expect(calls).toBe(1);
  },
);
it("publishes generated voice through existing cache update only after successful save", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const before = {
    ok: true,
    data: [{ name: "秦", reference_audio_path: "old.wav" }],
  };
  qc.setQueryData(queryKeys.characters("demo"), before);
  const slot = {
    slot: "default",
    label: "默认",
    path: "new.wav",
    url: "/new.wav",
    sha256: "new-sha",
    updated_at: "now",
    required: true,
    inherited_from_default: false,
  };
  let fail = true;
  const calls: unknown[] = [];
  server.use(
    http.post(
      `${base}/characters/%E7%A7%A6/voice-samples/default/save-generated`,
      async ({ request }) => {
        calls.push(await request.json());
        return fail
          ? HttpResponse.json(
              {
                ok: false,
                code: "save_failed",
                error: "保存失败",
                retryable: true,
                request_id: id,
              },
              { status: 500 },
            )
          : HttpResponse.json({ ok: true, data: slot });
      },
    ),
  );
  const { result } = renderHook(
    () => useSaveGeneratedCharacterVoice("demo", "秦"),
    { wrapper: provider(qc) },
  );
  const input = {
    slot: "default",
    candidate_id: id,
    save_request_id: id,
    expected_slot: { path: "old.wav", sha256: "", updated_at: "" },
    replace_existing: true,
  };
  await expect(result.current.mutateAsync(input)).rejects.toBeInstanceOf(
    VoiceDesignApiError,
  );
  expect(qc.getQueryData(queryKeys.characters("demo"))).toEqual(before);
  fail = false;
  await result.current.mutateAsync(input);
  expect(qc.getQueryData(queryKeys.characters("demo"))).toMatchObject({
    data: [
      { reference_audio_path: "new.wav", reference_audio_sha256: "new-sha" },
    ],
  });
  expect(calls[0]).toEqual(calls[1]);
  expect(
    qc.getQueryState(queryKeys.characterVoiceSamples("demo", "秦"))
      ?.isInvalidated ?? true,
  ).toBe(true);
});
