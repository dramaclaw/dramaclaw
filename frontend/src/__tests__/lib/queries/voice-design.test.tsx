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
  useVoiceDesignModels,
  useVoiceDesignHistory,
  VoiceDesignApiError,
} from "@/lib/queries/voice-design";
import { useSaveGeneratedCharacterVoice } from "@/lib/queries/characters";
import { queryKeys } from "@/lib/query-keys";

import { designModels } from "@/__tests__/voice-design-fixtures";
afterEach(() => server.resetHandlers());

const id = "178727cd-e421-451c-87e7-68779d72a8ec";
const body = {
  request_id: id,
  catalog_id: designModels[0].catalog_id,
  config_digest: designModels[0].config_digest,
  surface: "canvas" as const,
  description: "温柔",
  preview_text: "今天的天气很好，我们沿着河边慢慢走回家。",
  language: "zh" as const,
};
const base = "http://localhost:3000/api/v1/projects/demo";
const historyReady = {
  candidate_id: id,
  model: null,
  status: "ready",
  description: body.description,
  preview_text: body.preview_text,
  language: "zh",
  preview_url: `/api/v1/projects/demo/voice-design/candidates/${id}/audio`,
  mime_type: "audio/mpeg",
  duration_seconds: 4.5,
  sha256: "a".repeat(64),
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3600000).toISOString(),
};
function provider(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}
it("uses project quote and actual surface", async () => {
  server.use(
    http.get(`${base}/voice-design/quote`, ({ request }) => {
      expect(new URL(request.url).searchParams.get("surface")).toBe("canvas");
      expect(new URL(request.url).searchParams.get("catalog_id")).toBe("qwen");
      return HttpResponse.json({
        ok: true,
        data: {
          cost: 7,
          display: "7",
          unit: "call",
          quantity: 1,
          model: designModels[0],
        },
      });
    }),
  );
  const { result } = renderHook(
    () => useVoiceDesignQuote("demo", "canvas", designModels[0]),
    {
      wrapper: provider(new QueryClient()),
    },
  );
  await waitFor(() => expect(result.current.data?.display).toBe("7"));
});
it("creates one request without touching formal character cache and queries its original ID", async () => {
  const calls: unknown[] = [];
  server.use(
    http.post(`${base}/voice-design/candidates`, async ({ request }) => {
      calls.push(await request.json());
      return HttpResponse.json(
        {
          ok: true,
          data: {
            candidate_id: id,
            status: "generating",
            model: designModels[0],
          },
        },
        { status: 202 },
      );
    }),
    http.get(`${base}/voice-design/candidates/${id}`, () =>
      HttpResponse.json({
        ok: true,
        data: {
          candidate_id: id,
          status: "unknown",
          model: designModels[0],
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
    model: designModels[0],
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

it("publishes a delayed character save to its original target after hook scope changes", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(queryKeys.characters("demo"), {
    ok: true,
    data: [{ name: "秦", reference_audio_path: "original.wav" }],
  });
  qc.setQueryData(queryKeys.characters("other"), {
    ok: true,
    data: [{ name: "韩", reference_audio_path: "untouched.wav" }],
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  server.use(
    http.post(
      `${base}/characters/%E7%A7%A6/voice-samples/default/save-generated`,
      async () => {
        requested = true;
        await gate;
        return HttpResponse.json({
          ok: true,
          data: {
            slot: "default",
            label: "默认",
            path: "saved.wav",
            url: "/saved.wav",
            sha256: "saved-sha",
            updated_at: "now",
            required: true,
            inherited_from_default: false,
          },
        });
      },
    ),
  );
  const { result, rerender } = renderHook(
    ({ project, name }) => useSaveGeneratedCharacterVoice(project, name),
    { initialProps: { project: "demo", name: "秦" }, wrapper: provider(qc) },
  );
  const pending = result.current.mutateAsync({
    slot: "default",
    candidate_id: id,
    save_request_id: id,
    expected_slot: { path: "original.wav", sha256: "", updated_at: "" },
    replace_existing: true,
  });
  await waitFor(() => expect(requested).toBe(true));
  rerender({ project: "other", name: "韩" });
  release();
  await pending;
  expect(qc.getQueryData(queryKeys.characters("demo"))).toMatchObject({
    data: [
      {
        name: "秦",
        reference_audio_path: "saved.wav",
        reference_audio_sha256: "saved-sha",
      },
    ],
  });
  expect(qc.getQueryData(queryKeys.characters("other"))).toMatchObject({
    data: [{ name: "韩", reference_audio_path: "untouched.wav" }],
  });
});

it("reads only the models envelope and preserves all three immutable snapshots", async () => {
  server.use(
    http.get(`${base}/voice-design/models`, () =>
      HttpResponse.json({ ok: true, data: { models: designModels } }),
    ),
  );
  const { result } = renderHook(() => useVoiceDesignModels("demo"), {
    wrapper: provider(new QueryClient()),
  });
  await waitFor(() =>
    expect(result.current.data?.models).toEqual(designModels),
  );
});
it.each(["catalog", "digest", "request"])(
  "rejects a created candidate with mismatched %s identity",
  async (identity) => {
    let calls = 0;
    const model =
      identity === "catalog"
        ? designModels[1]
        : {
            ...designModels[0],
            config_digest:
              identity === "digest"
                ? "f".repeat(64)
                : designModels[0].config_digest,
          };
    server.use(
      http.post(`${base}/voice-design/candidates`, () => {
        calls++;
        return HttpResponse.json({
          ok: true,
          data: {
            candidate_id: identity === "request" ? crypto.randomUUID() : id,
            status: "generating",
            model,
          },
        });
      }),
    );
    await expect(createVoiceDesign("demo", body)).rejects.toThrow(
      "voiceDesign.errors.invalidResponse",
    );
    expect(calls).toBe(1);
  },
);
it("preserves historical null model records when reading a candidate", async () => {
  server.use(
    http.get(`${base}/voice-design/candidates/${id}`, () =>
      HttpResponse.json({
        ok: true,
        data: { candidate_id: id, status: "expired", model: null },
      }),
    ),
  );
  expect(await getVoiceDesign("demo", id)).toEqual({
    candidate_id: id,
    status: "expired",
    model: null,
  });
});
it.each(["catalog", "digest"])(
  "rejects a quote whose %s differs from the requested snapshot",
  async (identity) => {
    const model =
      identity === "catalog"
        ? designModels[1]
        : { ...designModels[0], config_digest: "f".repeat(64) };
    server.use(
      http.get(`${base}/voice-design/quote`, () =>
        HttpResponse.json({
          ok: true,
          data: { cost: 7, display: "7", unit: "call", quantity: 1, model },
        }),
      ),
    );
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () => useVoiceDesignQuote("demo", "canvas", designModels[0]),
      { wrapper: provider(qc) },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  },
);
it("refetches a new quote when the same catalog changes its configuration digest", async () => {
  const changed = { ...designModels[0], config_digest: "f".repeat(64) };
  let calls = 0;
  server.use(
    http.get(`${base}/voice-design/quote`, () =>
      HttpResponse.json({
        ok: true,
        data: {
          cost: ++calls,
          display: String(calls),
          unit: "call",
          quantity: 1,
          model: calls === 1 ? designModels[0] : changed,
        },
      }),
    ),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result, rerender } = renderHook(
    ({ model }) => useVoiceDesignQuote("demo", "canvas", model),
    {
      initialProps: {
        model: {
          ...designModels[0],
          config_digest: designModels[0].config_digest,
        },
      },
      wrapper: provider(qc),
    },
  );
  await waitFor(() => expect(result.current.data?.display).toBe("1"));
  rerender({ model: changed });
  await waitFor(() =>
    expect(result.current.data?.model.config_digest).toBe(
      changed.config_digest,
    ),
  );
  expect(calls).toBe(2);
});

it("reads legacy temporary history only when opened without creating or quoting", async () => {
  let reads = 0;
  let writes = 0;
  server.use(
    http.get(`${base}/voice-design/candidates`, () => { reads++; return HttpResponse.json({ ok: true, data: { candidates: [historyReady], next_cursor: null, retention_seconds: 604800 } }); }),
    http.post(`${base}/voice-design/candidates`, () => { writes++; return HttpResponse.json({}); }),
  );
  const { result, rerender } = renderHook(({ open }) => useVoiceDesignHistory("demo", open), { initialProps: { open: false }, wrapper: provider(new QueryClient()) });
  expect(reads).toBe(0);
  rerender({ open: true });
  await waitFor(() => expect(result.current.data?.candidates).toEqual([historyReady]));
  expect(reads).toBe(1);
  expect(writes).toBe(0);
});

it.each([
  { candidates: [{ ...historyReady, status: "generating" }], next_cursor: null, retention_seconds: 604800 },
  { candidates: Array.from({ length: 101 }, () => historyReady), next_cursor: null, retention_seconds: 604800 },
])("rejects a temporary history response outside the ready/bounded-page contract", async (data) => {
  server.use(http.get(`${base}/voice-design/candidates`, () => HttpResponse.json({ ok: true, data })));
  const { result } = renderHook(() => useVoiceDesignHistory("demo", true), { wrapper: provider(new QueryClient()) });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.data).toBeUndefined();
});
