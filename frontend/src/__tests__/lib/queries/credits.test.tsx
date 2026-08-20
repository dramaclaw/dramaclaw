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

import { queryKeys } from "@/lib/query-keys";
import {
  creditOrgOf,
  creditScopeOf,
  dormantPersonalBalanceOf,
  useCreditSummary,
} from "@/lib/queries/credits";

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

  it("carries the org member scope, organization and dormant personal balance through", async () => {
    server.use(
      http.get("http://localhost:3000/api/v1/credits/me/summary", () =>
        HttpResponse.json({
          ok: true,
          data: {
            balance: 5000,
            earned: 5000,
            spent: 0,
            refunded: 0,
            pending: 0,
            promotion_count: 0,
            updated_at: null,
            scope: "org_member",
            organization: { org_id: "org-1", name: "星辰文化" },
            dormant_personal_balance: 120,
          },
        }),
      ),
    );
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useCreditSummary(), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const summary = result.current.data?.data;
    expect(summary?.balance).toBe(5000);
    expect(creditScopeOf(summary)).toBe("org_member");
    expect(creditOrgOf(summary)).toEqual({ org_id: "org-1", name: "星辰文化" });
    expect(dormantPersonalBalanceOf(summary)).toBe(120);
  });

  it("reads a backend that predates the scope contract as a personal account", async () => {
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

    // No response validation may reject the three keys being absent.
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const summary = result.current.data?.data;
    expect(summary?.balance).toBe(92);
    expect(creditScopeOf(summary)).toBe("personal");
    expect(creditOrgOf(summary)).toBeNull();
    expect(dormantPersonalBalanceOf(summary)).toBeNull();
  });
});

describe("credit scope helpers", () => {
  it("treats absent, null and unknown scope values as personal", () => {
    expect(creditScopeOf(undefined)).toBe("personal");
    expect(creditScopeOf(null)).toBe("personal");
    expect(creditScopeOf({})).toBe("personal");
    expect(creditScopeOf({ scope: null })).toBe("personal");
    expect(creditScopeOf({ scope: "personal" })).toBe("personal");
    expect(creditScopeOf({ scope: "org_owner" })).toBe("personal");
    expect(creditScopeOf({ scope: "org_member" })).toBe("org_member");
  });

  it("never reports an organization or dormant balance for a personal account", () => {
    const personal = {
      balance: 10,
      earned: 10,
      spent: 0,
      refunded: 0,
      pending: 0,
      promotion_count: 0,
      updated_at: null,
      // Even if a backend leaked these onto a personal payload, the personal
      // UI must not pick them up.
      organization: { org_id: "org-1", name: "星辰文化" },
      dormant_personal_balance: 999,
    } as const;

    expect(creditOrgOf({ ...personal })).toBeNull();
    expect(dormantPersonalBalanceOf({ ...personal })).toBeNull();
  });

  it("hides a zero, negative or missing dormant personal balance", () => {
    const base = {
      balance: 5000,
      earned: 5000,
      spent: 0,
      refunded: 0,
      pending: 0,
      promotion_count: 0,
      updated_at: null,
      scope: "org_member",
      organization: { org_id: "org-1", name: "星辰文化" },
    } as const;

    expect(dormantPersonalBalanceOf({ ...base })).toBeNull();
    expect(dormantPersonalBalanceOf({ ...base, dormant_personal_balance: null })).toBeNull();
    expect(dormantPersonalBalanceOf({ ...base, dormant_personal_balance: 0 })).toBeNull();
    expect(dormantPersonalBalanceOf({ ...base, dormant_personal_balance: -5 })).toBeNull();
    expect(dormantPersonalBalanceOf({ ...base, dormant_personal_balance: Number.NaN })).toBeNull();
    expect(dormantPersonalBalanceOf({ ...base, dormant_personal_balance: 120 })).toBe(120);
  });

  it("drops an organization with no usable name", () => {
    const base = {
      balance: 5000,
      earned: 5000,
      spent: 0,
      refunded: 0,
      pending: 0,
      promotion_count: 0,
      updated_at: null,
      scope: "org_member",
    } as const;

    expect(creditOrgOf({ ...base })).toBeNull();
    expect(creditOrgOf({ ...base, organization: null })).toBeNull();
    expect(creditOrgOf({ ...base, organization: { org_id: "org-1", name: "" } })).toBeNull();
  });
});
