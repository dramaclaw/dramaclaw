// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import ky from "ky";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const runtimeState = vi.hoisted(() => ({ isCeRuntime: true }));

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

vi.mock("@/lib/runtime-config", () => ({
  isCeRuntime: () => runtimeState.isCeRuntime,
}));

import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("generation credit cost CE runtime contract", () => {
  it("still requests the cost endpoint and accepts zero-cost CE responses", async () => {
    runtimeState.isCeRuntime = true;
    let requestCount = 0;
    let requestedPath = "";

    server.use(
      http.get("http://localhost:3000/api/v1/generation-credit-cost", ({ request }) => {
        requestCount += 1;
        requestedPath = new URL(request.url).pathname;
        return HttpResponse.json({
          ok: true,
          data: {
            cost: 0,
            display: "0",
          },
        });
      }),
    );

    const { result } = renderHook(() => useGenerationCreditCost("beat_tts"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(requestCount).toBeGreaterThan(0);
    expect(requestedPath).toBe("/api/v1/generation-credit-cost");
    expect(result.current.isError).toBe(false);
    expect(result.current.data?.data).toEqual({
      cost: 0,
      display: "0",
    });
  });
});
