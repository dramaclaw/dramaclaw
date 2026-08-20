// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import ky from "ky";

// MSW 2 + ky 2 in jsdom: the global Request is replaced by an undici-backed
// implementation that requires an absolute URL, so the production `api` (which
// uses `prefix: "/"` + relative inputs) throws `Failed to parse URL`. Inject a
// test-only ky instance with an absolute `baseUrl` so requests reach MSW.
vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

import { useRenderPlan, useRenderExecute } from "@/lib/queries/render-plan";
import type { RenderPlan } from "@/types/render-plan";

const mockPlan: RenderPlan = {
  plan: [
    { mode_key: "2x3_1-1", rows: 2, cols: 3, beat_numbers: [1, 2, 3, 4, 5],
      location: "闹市街头", padding_count: 1, reasons: [], warnings: [] },
  ],
  plan_hash: "abc123def4567890",
  input_fingerprint: "xyz789abc1234567",
  strategy: "location",
  total_beats: 5,
  total_grids: 1,
};

const server = setupServer(
  http.post("*/render/plan", async () => HttpResponse.json({ ok: true, data: mockPlan })),
  http.post("*/render/execute", async () => HttpResponse.json({
    ok: true,
    data: {
      task_type: "render_plan",
      message: "started",
      scope: "location__abc123def4567890",
      resolved_grids: mockPlan.plan,
    },
  })),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrap(children: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useRenderPlan", () => {
  it("returns a plan on success", async () => {
    const { result } = renderHook(() => useRenderPlan("demo", 1), {
      wrapper: ({ children }) => wrap(children),
    });
    result.current.mutate({
      beat_indices: [1, 2, 3, 4, 5],
      strategy: "location",
      aspect_mode: "9:16",
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const res = result.current.data;
    expect(res?.ok).toBe(true);
    if (!res?.ok) throw new Error("expected ok render plan response");
    expect(res.data.plan_hash).toBe("abc123def4567890");
  });
});

describe("useRenderExecute", () => {
  it("returns scope on success", async () => {
    const { result } = renderHook(() => useRenderExecute("demo", 1), {
      wrapper: ({ children }) => wrap(children),
    });
    result.current.mutate({
      plan: mockPlan.plan,
      plan_hash: mockPlan.plan_hash,
      input_fingerprint: mockPlan.input_fingerprint,
      strategy: "location",
      aspect_mode: "9:16",
      beat_indices: [1, 2, 3, 4, 5],
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const res = result.current.data;
    expect(res?.ok).toBe(true);
    if (!res?.ok) throw new Error("expected ok render execute response");
    expect(res.data.scope).toBe("location__abc123def4567890");
  });
});
