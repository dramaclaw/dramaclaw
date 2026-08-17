// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
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
  type OfficialMediaCatalogStatus,
  useCheckOfficialMediaCatalog,
  useOfficialMediaCatalogWatcher,
} from "@/lib/queries/model-gateway";
import { queryKeys } from "@/lib/query-keys";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function catalogStatus(
  overrides: Partial<OfficialMediaCatalogStatus> = {},
): OfficialMediaCatalogStatus {
  return {
    autoUpdate: true,
    source: "remote",
    schemaVersion: 1,
    catalogVersion: "2026.08.07.1",
    modelCount: 2,
    lastCheckedAt: "2026-08-07T10:00:00Z",
    sha256: "a".repeat(64),
    revision: "b".repeat(40),
    publishedAt: "2026-08-07T10:00:00Z",
    remoteUrl: "https://catalog.example.test/manifest.json",
    lastError: "",
    ...overrides,
  };
}

describe("official media catalog watcher", () => {
  it("polls only while automatic updates are enabled", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/v1/model-gateway/official/media-catalog",
        () => HttpResponse.json({ ok: true, data: catalogStatus() }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result } = renderHook(() => useOfficialMediaCatalogWatcher(), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const query = queryClient.getQueryCache().find({
      queryKey: [...queryKeys.modelGateway(), "official-media-catalog"],
    });
    type CatalogQueryState = {
      state: {
        data?: { data: OfficialMediaCatalogStatus };
      };
    };
    const options = query?.options as {
      refetchInterval?: (current: CatalogQueryState) => number | false;
      refetchIntervalInBackground?: unknown;
      refetchOnWindowFocus?: unknown;
    };
    const intervalQuery = query as unknown as CatalogQueryState;
    expect(options.refetchInterval?.(intervalQuery)).toBe(60_000);
    if (intervalQuery.state.data?.data) {
      intervalQuery.state.data.data.autoUpdate = false;
    }
    expect(options.refetchInterval?.(intervalQuery)).toBe(false);
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(true);
  });

  it("dispatches once when a later status response has a new SHA256", async () => {
    let current = catalogStatus();
    server.use(
      http.get(
        "http://localhost:3000/api/v1/model-gateway/official/media-catalog",
        () => HttpResponse.json({ ok: true, data: current }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const onCatalogUpdated = vi.fn();
    window.addEventListener("media-model-catalog-updated", onCatalogUpdated);

    try {
      const { result } = renderHook(() => useOfficialMediaCatalogWatcher(), {
        wrapper: wrapper(queryClient),
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(onCatalogUpdated).not.toHaveBeenCalled();

      current = catalogStatus({
        catalogVersion: "2026.08.07.2",
        sha256: "c".repeat(64),
      });
      await act(async () => {
        await result.current.refetch();
      });
      await waitFor(() => expect(onCatalogUpdated).toHaveBeenCalledTimes(1));

      await act(async () => {
        await result.current.refetch();
      });
      expect(onCatalogUpdated).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(
        "media-model-catalog-updated",
        onCatalogUpdated,
      );
    }
  });

  it("keeps manual checks on the same single event path", async () => {
    const initial = catalogStatus();
    const updated = catalogStatus({
      catalogVersion: "2026.08.07.2",
      sha256: "d".repeat(64),
      updated: true,
    });
    server.use(
      http.get(
        "http://localhost:3000/api/v1/model-gateway/official/media-catalog",
        () => HttpResponse.json({ ok: true, data: initial }),
      ),
      http.post(
        "http://localhost:3000/api/v1/model-gateway/official/media-catalog/check",
        () => HttpResponse.json({ ok: true, data: updated }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const onCatalogUpdated = vi.fn();
    window.addEventListener("media-model-catalog-updated", onCatalogUpdated);

    try {
      const { result } = renderHook(
        () => ({
          watcher: useOfficialMediaCatalogWatcher(),
          check: useCheckOfficialMediaCatalog(),
        }),
        { wrapper: wrapper(queryClient) },
      );
      await waitFor(() => expect(result.current.watcher.isSuccess).toBe(true));

      await act(async () => {
        await result.current.check.mutateAsync();
      });
      await waitFor(() => expect(onCatalogUpdated).toHaveBeenCalledTimes(1));
      expect(result.current.watcher.data?.data.sha256).toBe(updated.sha256);
    } finally {
      window.removeEventListener(
        "media-model-catalog-updated",
        onCatalogUpdated,
      );
    }
  });
});
