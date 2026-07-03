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
import { fetchReleaseNotifications, useReleaseNotifications } from "@/lib/queries/release-notifications";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("release notification query", () => {
  it("includes locale in the request and query key", async () => {
    let seenLocale = "";
    server.use(
      http.get("http://localhost:3000/api/v1/release-notifications", ({ request }) => {
        const url = new URL(request.url);
        seenLocale = url.searchParams.get("locale") ?? "";
        return HttpResponse.json({
          ok: true,
          data: {
            source: "local_file",
            current_version: "1.0.2",
            current_tag: "v1.0.2",
            current_items: [],
            update_available: false,
            latest_version: null,
            latest_tag: null,
            release_url: null,
            update_items: [],
            attention: "low",
            latest_published_at: null,
          },
        });
      }),
    );

    const { result } = renderHook(() => useReleaseNotifications("en"), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(seenLocale).toBe("en");
    expect(queryKeys.releaseNotifications("zh")).not.toEqual(queryKeys.releaseNotifications("en"));
  });

  it("normalizes fetch locale before calling the endpoint", async () => {
    let seenLocale = "";
    server.use(
      http.get("http://localhost:3000/api/v1/release-notifications", ({ request }) => {
        seenLocale = new URL(request.url).searchParams.get("locale") ?? "";
        return HttpResponse.json({ ok: true, data: { source: "none", current_items: [] } });
      }),
    );

    await fetchReleaseNotifications("zh-CN");

    expect(seenLocale).toBe("zh");
  });

  it("defaults missing and unknown locales to zh", async () => {
    const seenLocales: string[] = [];
    server.use(
      http.get("http://localhost:3000/api/v1/release-notifications", ({ request }) => {
        seenLocales.push(new URL(request.url).searchParams.get("locale") ?? "");
        return HttpResponse.json({ ok: true, data: { source: "none", current_items: [] } });
      }),
    );

    await fetchReleaseNotifications(undefined);
    await fetchReleaseNotifications("fr-FR");

    expect(seenLocales.length).toBeGreaterThanOrEqual(2);
    expect(seenLocales.every((locale) => locale === "zh")).toBe(true);
  });
});
