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

import { useGenerateScript } from "@/lib/queries/scripts";
import { BillingRuleNotConfiguredError } from "@/lib/api-errors";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("script generation query", () => {
  it("uses the canonical /script/generate endpoint and surfaces ok:false errors", async () => {
    let requestedPath = "";
    let receivedBody: unknown = undefined;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/script/generate",
        async ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          receivedBody = await request.clone().json();
          return HttpResponse.json({
            ok: false,
            code: "identity_plan_required",
            error: "请先规划本集身份",
          });
        },
      ),
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/literal-script/generate",
        () => HttpResponse.error(),
      ),
    );

    const { result } = renderHook(() => useGenerateScript("demo", 1), {
      wrapper,
    });

    result.current.mutate({});

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/episodes/1/script/generate");
    expect(receivedBody).toEqual({});
    expect(result.current.data).toEqual({
      ok: false,
      code: "identity_plan_required",
      error: "请先规划本集身份",
    });
  });

  it("surfaces missing feature billing rules as a typed error", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/episodes/1/script/generate",
        () =>
          HttpResponse.json(
            {
              ok: false,
              error: "计费规则未配置，请联系管理员设置积分规则",
              data: {
                error_code: "BILLING_RULE_NOT_CONFIGURED",
                billing_kind: "feature",
                billing_key: "script_writer",
              },
            },
            { status: 409 },
          ),
      ),
    );

    const { result } = renderHook(() => useGenerateScript("demo", 1), {
      wrapper,
    });

    await expect(result.current.mutateAsync({})).rejects.toBeInstanceOf(
      BillingRuleNotConfiguredError,
    );
  });
});
