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
  submitEpayCheckout,
  useCreateRechargeOrder,
  useCreateRechargeLinkOrder,
  useRechargeLinkPackages,
} from "@/lib/queries/payments";
import { BackendStatusError } from "@/lib/api-errors";
import { paymentErrorToastMessage } from "@/lib/payment-errors";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  document.querySelectorAll("form").forEach((form) => form.remove());
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function wrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("recharge checkout", () => {
  it("maps structured payment failures to actionable messages", () => {
    const t = ((key: string) => key) as never;

    expect(
      paymentErrorToastMessage(
        new BackendStatusError("PAYMENT_TOO_MANY_PENDING", 429),
        t,
        "credits.recharge.createFailed",
      ),
    ).toBe("credits.recharge.errors.tooManyPending");
    expect(
      paymentErrorToastMessage(
        new BackendStatusError("payment service unavailable", 503),
        t,
        "credits.recharge.createFailed",
      ),
    ).toBe("credits.recharge.errors.serviceUnavailable");
  });

  it("posts the selected package with an explicit idempotency key", async () => {
    let capturedHeader = "";
    let capturedBody: unknown;
    server.use(
      http.post("http://localhost:3000/api/v1/payments/orders", async ({ request }) => {
        capturedHeader = request.headers.get("idempotency-key") ?? "";
        capturedBody = await request.json();
        return HttpResponse.json({
          ok: true,
          data: {
            order: { order_id: "pay-1" },
            checkout: null,
          },
        });
      }),
    );
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useCreateRechargeOrder(), {
      wrapper: wrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        packageId: "paypkg-1",
        paymentMethod: "wxpay",
        idempotencyKey: "web-request-0001",
      });
    });

    expect(capturedHeader).toBe("web-request-0001");
    expect(capturedBody).toEqual({
      package_id: "paypkg-1",
      payment_method: "wxpay",
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("sends a recharge link token only in the request header", async () => {
    const token = "abcdefghijklmnopqrstuvwxyz_0123456789-ABCDE";
    let capturedToken = "";
    let capturedUrl = "";
    server.use(
      http.get(
        "http://localhost:3000/api/v1/payments/recharge-link/packages",
        ({ request }) => {
          capturedToken = request.headers.get("x-recharge-token") ?? "";
          capturedUrl = request.url;
          return HttpResponse.json({
            ok: true,
            data: {
              link: { subject_type: "org_generic", expires_at: null },
              items: [],
            },
          });
        },
      ),
    );
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useRechargeLinkPackages(token, true), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(capturedToken).toBe(token);
    expect(new URL(capturedUrl).search).toBe("");
    expect(capturedUrl).not.toContain(token);
  });

  it("creates a linked recharge order with token and idempotency headers", async () => {
    const token = "abcdefghijklmnopqrstuvwxyz_0123456789-ABCDE";
    let capturedToken = "";
    let capturedIdempotency = "";
    let capturedBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/payments/recharge-link/orders",
        async ({ request }) => {
          capturedToken = request.headers.get("x-recharge-token") ?? "";
          capturedIdempotency = request.headers.get("idempotency-key") ?? "";
          capturedBody = await request.json();
          return HttpResponse.json({
            ok: true,
            data: { order: { order_id: "pay-linked-1" }, checkout: null },
          });
        },
      ),
    );
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useCreateRechargeLinkOrder(token), {
      wrapper: wrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        packageId: "paypkg-org-1",
        paymentMethod: "alipay",
        idempotencyKey: "link-request-0001",
      });
    });

    expect(capturedToken).toBe(token);
    expect(capturedIdempotency).toBe("link-request-0001");
    expect(capturedBody).toEqual({
      package_id: "paypkg-org-1",
      payment_method: "alipay",
    });
  });

  it("submits only an HTTPS checkout with the exact signed fields", () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => undefined);

    submitEpayCheckout({
      action: "https://pay.example.test/submit.php",
      method: "POST",
      fields: { pid: "pid-1", money: "1.00", sign: "signed-value" },
    });

    const form = document.querySelector("form");
    expect(submit).toHaveBeenCalledOnce();
    expect(form?.method).toBe("post");
    expect(form?.action).toBe("https://pay.example.test/submit.php");
    expect(
      Object.fromEntries(
        [...(form?.querySelectorAll("input") ?? [])].map((input) => [
          input.name,
          input.value,
        ]),
      ),
    ).toEqual({ pid: "pid-1", money: "1.00", sign: "signed-value" });
  });

  it("rejects a public plaintext checkout before creating a form", () => {
    expect(() =>
      submitEpayCheckout({
        action: "http://pay.example.test/submit.php",
        method: "POST",
        fields: { pid: "pid-1" },
      }),
    ).toThrow("unsafe checkout URL");
    expect(document.querySelector("form")).toBeNull();
  });
});
