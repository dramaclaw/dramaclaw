// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/__mocks__/msw/server";
import { getOrgBranding, useOrgBranding } from "@/lib/queries/org-branding";
import { queryKeys } from "@/lib/query-keys";

const logoUrl =
  "/assets/org-brand/org_a/sha256/ab/cd/" + "abcd" + "a".repeat(60) + ".png";
const response = {
  schema_version: 1,
  organization: { org_id: "org-1", name: "Claymore", future: true },
  branding: { logo_url: logoUrl, updated_at: "2026-08-21T10:00:00Z", future: true },
  future: true,
};

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("organization branding query", () => {
  it("accepts v1 future fields and keeps only the public display contract", async () => {
    server.use(http.get("*/api/v1/org/branding", () => HttpResponse.json(response)));
    await expect(getOrgBranding()).resolves.toEqual({
      schema_version: 1,
      organization: { org_id: "org-1", name: "Claymore" },
      branding: { logo_url: logoUrl, updated_at: "2026-08-21T10:00:00Z" },
    });
  });

  it.each([
    { ...response, schema_version: 2 },
    { ...response, organization: null },
    { ...response, branding: { ...response.branding, logo_url: "https://evil/logo.png" } },
  ])("fails open for malformed responses", async (body) => {
    server.use(http.get("*/api/v1/org/branding", () => HttpResponse.json(body)));
    await expect(getOrgBranding()).resolves.toBeNull();
  });

  it("disables both ky retries and React Query retries", async () => {
    let requests = 0;
    server.use(http.get("*/api/v1/org/branding", () => {
      requests += 1;
      return HttpResponse.json({ ok: false }, { status: 503 });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: 4 } } });
    const { result } = renderHook(() => useOrgBranding(true), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(requests).toBe(1);
    expect(client.getQueryData(queryKeys.orgBranding())).toBeNull();
  });

  it("makes zero requests when CE or the session is not ready", async () => {
    let requests = 0;
    server.use(http.get("*/api/v1/org/branding", () => {
      requests += 1;
      return HttpResponse.json(response);
    }));
    const client = new QueryClient();
    const { result } = renderHook(() => useOrgBranding(false), { wrapper: wrapperFor(client) });

    expect(result.current.fetchStatus).toBe("idle");
    expect(requests).toBe(0);
  });
});
