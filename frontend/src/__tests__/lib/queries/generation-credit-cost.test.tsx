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

import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { BillingRuleNotConfiguredError } from "@/lib/api-errors";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("generation credit cost query hook", () => {
  it("fetches generation credit cost by kind", async () => {
    let requestedPath = "";
    let requestedKind = "";
    let requestedValue: string | null = null;
    server.use(
      http.get("http://localhost:3000/api/v1/generation-credit-cost", ({ request }) => {
        const url = new URL(request.url);
        requestedPath = url.pathname;
        requestedKind = url.searchParams.get("kind") ?? "";
        requestedValue = url.searchParams.get("value");
        return HttpResponse.json({
          ok: true,
          data: {
            cost: 3,
            display: "3",
          },
        });
      }),
    );

    const { result } = renderHook(() => useGenerationCreditCost("beat_tts"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/generation-credit-cost");
    expect(requestedKind).toBe("beat_tts");
    expect(requestedValue).toBeNull();
    expect(result.current.data?.data).toEqual({
      cost: 3,
      display: "3",
    });
  });

  it("sends value when querying by model", async () => {
    let requestedKind = "";
    let requestedValue = "";
    server.use(
      http.get("http://localhost:3000/api/v1/generation-credit-cost", ({ request }) => {
        const url = new URL(request.url);
        requestedKind = url.searchParams.get("kind") ?? "";
        requestedValue = url.searchParams.get("value") ?? "";
        return HttpResponse.json({
          ok: true,
          data: {
            cost: 5,
            display: "5",
          },
        });
      }),
    );

    const { result } = renderHook(
      () => useGenerationCreditCost("model", "gpt-image-2"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedKind).toBe("model");
    expect(requestedValue).toBe("gpt-image-2");
    expect(result.current.data?.data.display).toBe("5");
  });

  it("sends value when querying by feature", async () => {
    let requestedKind = "";
    let requestedValue = "";
    server.use(
      http.get("http://localhost:3000/api/v1/generation-credit-cost", ({ request }) => {
        const url = new URL(request.url);
        requestedKind = url.searchParams.get("kind") ?? "";
        requestedValue = url.searchParams.get("value") ?? "";
        return HttpResponse.json({
          ok: true,
          data: {
            cost: 6,
            display: "6",
          },
        });
      }),
    );

    const { result } = renderHook(
      () => useGenerationCreditCost("feature", "ingest_fast"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedKind).toBe("feature");
    expect(requestedValue).toBe("ingest_fast");
    expect(result.current.data?.data.display).toBe("6");
  });

  it("surfaces missing feature billing rules as a typed error", async () => {
    server.use(
      http.get("http://localhost:3000/api/v1/generation-credit-cost", () =>
        HttpResponse.json(
          {
            ok: false,
            error: "计费规则未配置，请联系管理员设置积分规则",
            data: {
              error_code: "BILLING_RULE_NOT_CONFIGURED",
              billing_kind: "feature",
              billing_key: "build_characters",
            },
          },
          { status: 409 },
        ),
      ),
    );

    const { result } = renderHook(
      () => useGenerationCreditCost("feature", "build_characters"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toBeInstanceOf(BillingRuleNotConfiguredError);
  });

  it("sends value when querying by image selection", async () => {
    let requestedKind = "";
    let requestedValue = "";
    server.use(
      http.get("http://localhost:3000/api/v1/generation-credit-cost", ({ request }) => {
        const url = new URL(request.url);
        requestedKind = url.searchParams.get("kind") ?? "";
        requestedValue = url.searchParams.get("value") ?? "";
        return HttpResponse.json({
          ok: true,
          data: {
            cost: 7,
            display: "7",
          },
        });
      }),
    );

    const { result } = renderHook(
      () => useGenerationCreditCost("image_selection", "newapi_gpt_image2"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedKind).toBe("image_selection");
    expect(requestedValue).toBe("newapi_gpt_image2");
    expect(result.current.data?.data.display).toBe("7");
  });

  it("sends value when querying by fixed image kind", async () => {
    let requestedKind = "";
    let requestedValue = "";
    server.use(
      http.get("http://localhost:3000/api/v1/generation-credit-cost", ({ request }) => {
        const url = new URL(request.url);
        requestedKind = url.searchParams.get("kind") ?? "";
        requestedValue = url.searchParams.get("value") ?? "";
        return HttpResponse.json({
          ok: true,
          data: {
            cost: 9,
            display: "9",
          },
        });
      }),
    );

    const { result } = renderHook(
      () => useGenerationCreditCost("fixed_image", "scene_master"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedKind).toBe("fixed_image");
    expect(requestedValue).toBe("scene_master");
    expect(result.current.data?.data.display).toBe("9");
  });

  it("sends value when querying by video backend", async () => {
    let requestedKind = "";
    let requestedValue = "";
    server.use(
      http.get("http://localhost:3000/api/v1/generation-credit-cost", ({ request }) => {
        const url = new URL(request.url);
        requestedKind = url.searchParams.get("kind") ?? "";
        requestedValue = url.searchParams.get("value") ?? "";
        return HttpResponse.json({
          ok: true,
          data: {
            cost: 12,
            display: "12",
          },
        });
      }),
    );

    const { result } = renderHook(
      () => useGenerationCreditCost("video_backend", "newapi_seedance-1.0-pro-fast"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedKind).toBe("video_backend");
    expect(requestedValue).toBe("newapi_seedance-1.0-pro-fast");
    expect(result.current.data?.data.display).toBe("12");
  });

  it("sends surface, params, quantity, and image mode metadata", async () => {
    let requestedSurface = "";
    let requestedParams = "";
    let requestedQuantity = "";
    let requestedModeKey = "";
    let requestedImageRole = "";
    server.use(
      http.get("http://localhost:3000/api/v1/generation-credit-cost", ({ request }) => {
        const url = new URL(request.url);
        requestedSurface = url.searchParams.get("surface") ?? "";
        requestedParams = url.searchParams.get("params") ?? "";
        requestedQuantity = url.searchParams.get("quantity") ?? "";
        requestedModeKey = url.searchParams.get("mode_key") ?? "";
        requestedImageRole = url.searchParams.get("image_role") ?? "";
        return HttpResponse.json({
          ok: true,
          data: {
            cost: 18,
            display: "18",
          },
        });
      }),
    );

    const { result } = renderHook(
      () =>
        useGenerationCreditCost("image_selection", "newapi_gpt_image2", {
          surface: "canvas",
          params: { size: "2K" },
          quantity: 3,
          modeKey: "2x2_1-1",
          imageRole: "render",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedSurface).toBe("canvas");
    expect(JSON.parse(requestedParams)).toEqual({ size: "2K" });
    expect(requestedQuantity).toBe("3");
    expect(requestedModeKey).toBe("2x2_1-1");
    expect(requestedImageRole).toBe("render");
    expect(result.current.data?.data.display).toBe("18");
  });
});
