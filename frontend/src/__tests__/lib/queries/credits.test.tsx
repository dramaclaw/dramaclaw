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
import { useCreditSummary } from "@/lib/queries/credits";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("credit summary query", () => {
  it("only polls while reservations are pending", async () => {
    server.use(
      http.get("http://localhost:3000/api/v1/credits/me/summary", () =>
        HttpResponse.json({
          ok: true,
          data: {
            balance: 92,
            earned: 150,
            spent: 60,
            refunded: 10,
            pending: 0,
            promotion_count: 2,
            updated_at: null,
          },
        }),
      ),
    );
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useCreditSummary(), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const query = queryClient.getQueryCache().find({
      queryKey: queryKeys.creditSummary(),
    });
    type CreditSummaryQueryState = {
      state: {
        data?: {
          data: {
            pending: number;
          };
        };
        error?: Error | null;
      };
    };
    const options = query?.options as {
      refetchInterval?: (query: CreditSummaryQueryState) => number | false;
      refetchIntervalInBackground?: unknown;
      refetchOnMount?: unknown;
      refetchOnWindowFocus?: unknown;
      retry?: unknown;
      staleTime?: unknown;
    };
    const intervalQuery = query as unknown as CreditSummaryQueryState;
    expect(options.refetchInterval?.(intervalQuery)).toBe(false);
    if (intervalQuery.state.data?.data) {
      intervalQuery.state.data.data.pending = 8;
    }
    expect(options.refetchInterval?.(intervalQuery)).toBe(60_000);
    intervalQuery.state.error = new Error("summary refresh failed");
    expect(options.refetchInterval?.(intervalQuery)).toBe(false);
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(options.refetchOnMount).toBe("always");
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.retry).toBe(false);
    expect(options.staleTime).toBe(60_000);
  });

  it("does not multiply a failed summary request through ky or react-query retries", async () => {
    let requests = 0;
    server.use(
      http.get("http://localhost:3000/api/v1/credits/me/summary", () => {
        requests += 1;
        return HttpResponse.json({ ok: false }, { status: 500 });
      }),
    );
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useCreditSummary(), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // The test renderer mounts effects twice under React StrictMode. Each
    // mount may issue one request, but neither Ky nor React Query may retry it
    // (the previous configuration produced up to six requests here).
    expect(requests).toBe(2);
  });
});
