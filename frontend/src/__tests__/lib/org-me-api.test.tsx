// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/__mocks__/msw/server";
import { getOrgMe, OrgApiError, useOrgMe } from "@/lib/queries/org";
import { queryKeys } from "@/lib/query-keys";
import type { OrgMeMembership, OrgMeOrganization } from "@/types/org";

// @ts-expect-error /org/me exact objects always carry updated_at, even when null.
const organizationWithoutUpdatedAt: OrgMeOrganization = {
  org_id: "org-1", name: "Acme", status: "active",
};
// @ts-expect-error /org/me exact objects always carry updated_at, even when null.
const membershipWithoutUpdatedAt: OrgMeMembership = {
  role: "org_member", membership_status: "active",
};
void organizationWithoutUpdatedAt;
void membershipWithoutUpdatedAt;

const authoritativeOrgMe = {
  user: {
    user_id: "user-1",
    username: "alice",
    model_billing_entitlement: "platform",
  },
  organization: {
    org_id: "org-1",
    name: "Acme",
    status: "active",
    updated_at: "2026-08-02T00:00:00Z",
  },
  membership: {
    role: "org_member",
    membership_status: "active",
    updated_at: "2026-08-02T00:00:00Z",
  },
  capabilities: {
    manage_members: false,
    manage_invites: false,
    manage_gateway_key: false,
    start_model_tasks: true,
  },
  gateway_key: { state: "active", key_version: 3 },
  denial_reason: null,
};

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("strict organization access snapshot", () => {
  it("requests only the cookie-backed /org/me endpoint", async () => {
    const requests: Array<{ method: string; pathname: string; search: string }> = [];
    server.use(
      http.get("*/api/v1/org/me", ({ request }) => {
        const url = new URL(request.url);
        requests.push({ method: request.method, pathname: url.pathname, search: url.search });
        expect(request.credentials).toBe("include");
        expect(request.headers.get("X-Org-ID")).toBeNull();
        return HttpResponse.json(authoritativeOrgMe);
      }),
    );

    await expect(getOrgMe()).resolves.toEqual(authoritativeOrgMe);
    expect(requests).toEqual([{ method: "GET", pathname: "/api/v1/org/me", search: "" }]);
  });

  it.each([
    ["missing wire capability", {
      ...authoritativeOrgMe,
      capabilities: {
        manage_members: false,
        manage_gateway_key: false,
        start_model_tasks: true,
      },
    }],
    ["extra top-level field", { ...authoritativeOrgMe, credential_id: "SECRET-CANARY" }],
    ["incoherent access decision", {
      ...authoritativeOrgMe,
      denial_reason: "ORG_CREDENTIAL_MISSING",
    }],
    ["incoherent available decision for a known gateway", {
      ...authoritativeOrgMe,
      capabilities: { ...authoritativeOrgMe.capabilities, start_model_tasks: false },
    }],
    ["incoherent denial for an unknown gateway", {
      ...authoritativeOrgMe,
      gateway_key: { state: "UPSTREAM-SECRET-GATEWAY-STATE", key_version: 1 },
      denial_reason: "ORG_CREDENTIAL_MISSING",
    }],
    ["invalid timestamp", {
      ...authoritativeOrgMe,
      organization: { ...authoritativeOrgMe.organization, updated_at: "2026-02-30T00:00:00Z" },
    }],
  ])("rejects %s before caching", async (_name, body) => {
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(body)));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useOrgMe(), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(OrgApiError);
    expect(client.getQueryData(queryKeys.orgMe())).toBeUndefined();
    expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain("SECRET-CANARY");
  });

  it("maps server errors to a stable safe error without exposing raw details", async () => {
    server.use(
      http.get("*/api/v1/org/me", () => HttpResponse.json({
        ok: false,
        error: {
          code: "ORG_MEMBERSHIP_INACTIVE",
          message: "RAW-PROVIDER-SECRET",
          request_id: "request-1",
        },
      }, { status: 403 })),
    );

    const error = await getOrgMe().catch((value: unknown) => value);
    expect(error).toMatchObject({
      name: "OrgApiError",
      status: 403,
      code: "ORG_MEMBERSHIP_INACTIVE",
      requestId: "request-1",
    });
    expect(String(error)).not.toContain("RAW-PROVIDER-SECRET");
  });

  it.each([
    ["platform entitlement", authoritativeOrgMe],
    ["org-sponsored entitlement", {
      ...authoritativeOrgMe,
      user: { ...authoritativeOrgMe.user, model_billing_entitlement: "org_sponsored" },
    }],
    ["disabled entitlement", {
      ...authoritativeOrgMe,
      user: { ...authoritativeOrgMe.user, model_billing_entitlement: "disabled" },
    }],
    ["suspended organization", {
      ...authoritativeOrgMe,
      organization: { ...authoritativeOrgMe.organization, status: "suspended" },
    }],
    ["administrator membership", {
      ...authoritativeOrgMe,
      membership: { ...authoritativeOrgMe.membership, role: "org_admin" },
    }],
    ["suspended membership", {
      ...authoritativeOrgMe,
      membership: { ...authoritativeOrgMe.membership, membership_status: "suspended" },
    }],
    ["never-configured gateway", {
      ...authoritativeOrgMe,
      gateway_key: { state: "never_configured", key_version: null },
    }],
    ["no-active gateway", {
      ...authoritativeOrgMe,
      gateway_key: { state: "no_active", key_version: 4 },
    }],
  ])("accepts authoritative enum variant: %s", async (_name, body) => {
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(body)));
    await expect(getOrgMe()).resolves.toEqual(body);
  });

  it.each([
    ["entitlement", { user: { ...authoritativeOrgMe.user, model_billing_entitlement: "future" } }],
    ["organization status", {
      organization: { ...authoritativeOrgMe.organization, status: "deleted" },
    }],
    ["membership role", {
      membership: { ...authoritativeOrgMe.membership, role: "platform_admin" },
    }],
    ["membership status", {
      membership: { ...authoritativeOrgMe.membership, membership_status: "left" },
    }],
  ])("rejects unknown %s enum", async (_name, override) => {
    const body = { ...authoritativeOrgMe, ...override };
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(body)));
    await expect(getOrgMe()).rejects.toMatchObject({ code: "ORG_REQUEST_FAILED" });
  });

  it.each([
    ["active/null", { state: "active", key_version: null }],
    ["no_active/null", { state: "no_active", key_version: null }],
    ["never_configured/version", { state: "never_configured", key_version: 1 }],
    ["non-string state", { state: 1, key_version: 1 }],
    ["zero version", { state: "active", key_version: 0 }],
    ["negative version", { state: "active", key_version: -1 }],
    ["unsafe version", { state: "active", key_version: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects incoherent gateway summary: %s", async (_name, gatewayKey) => {
    const body = { ...authoritativeOrgMe, gateway_key: gatewayKey };
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(body)));
    await expect(getOrgMe()).rejects.toMatchObject({ code: "ORG_REQUEST_FAILED" });
  });

  it("normalizes an unknown gateway state before returning or caching it", async () => {
    const body = {
      ...authoritativeOrgMe,
      gateway_key: { state: "UPSTREAM-SECRET-GATEWAY-STATE", key_version: 1 },
    };
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(body)));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useOrgMe(), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.gateway_key).toEqual({ state: "unknown", key_version: 1 });
    expect(result.current.data?.capabilities.start_model_tasks).toBe(false);
    expect(client.getQueryData(queryKeys.orgMe())).toEqual(result.current.data);
    expect(JSON.stringify(client.getQueryCache().getAll()))
      .not.toContain("UPSTREAM-SECRET-GATEWAY-STATE");
  });

  // gateway_mismatch is a value this build knows, so it must survive parsing
  // instead of being flattened into the unknown sentinel: the paired denial
  // reason is what tells the member an admin has to rebind, and the two have to
  // stay consistent with each other in the cache.
  it("keeps a known gateway mismatch state instead of flattening it to unknown", async () => {
    const body = {
      ...authoritativeOrgMe,
      capabilities: { ...authoritativeOrgMe.capabilities, start_model_tasks: false },
      gateway_key: { state: "gateway_mismatch", key_version: 3 },
      denial_reason: "ORG_CREDENTIAL_GATEWAY_MISMATCH",
    };
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(body)));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useOrgMe(), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.gateway_key)
      .toEqual({ state: "gateway_mismatch", key_version: 3 });
    expect(result.current.data?.denial_reason).toBe("ORG_CREDENTIAL_GATEWAY_MISMATCH");
    expect(result.current.data?.capabilities.start_model_tasks).toBe(false);
    expect(client.getQueryData(queryKeys.orgMe())).toEqual(result.current.data);
  });

  // The mismatch row always carries the version of the credential it belongs
  // to, so a versionless one is as malformed as a versionless active row.
  it.each([null, 0, -1, "3"])(
    "rejects a gateway mismatch without a positive version %j",
    async (keyVersion) => {
      const body = {
        ...authoritativeOrgMe,
        capabilities: { ...authoritativeOrgMe.capabilities, start_model_tasks: false },
        gateway_key: { state: "gateway_mismatch", key_version: keyVersion },
        denial_reason: "ORG_CREDENTIAL_GATEWAY_MISMATCH",
      };
      server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(body)));
      await expect(getOrgMe()).rejects.toMatchObject({ code: "ORG_REQUEST_FAILED" });
    },
  );

  it("accepts an unavailable capability snapshot for an unknown gateway state", async () => {
    const body = {
      ...authoritativeOrgMe,
      capabilities: { ...authoritativeOrgMe.capabilities, start_model_tasks: false },
      gateway_key: { state: "UPSTREAM-SECRET-GATEWAY-STATE", key_version: 1 },
    };
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(body)));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useOrgMe(), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.gateway_key).toEqual({ state: "unknown", key_version: 1 });
    expect(result.current.data?.denial_reason).toBeNull();
    expect(result.current.data?.capabilities.start_model_tasks).toBe(false);
    expect(client.getQueryData(queryKeys.orgMe())).toEqual(result.current.data);
    expect(JSON.stringify(client.getQueryCache().getAll()))
      .not.toContain("UPSTREAM-SECRET-GATEWAY-STATE");
  });

  it("normalizes combined unknown gateway and denial values before caching", async () => {
    const body = {
      ...authoritativeOrgMe,
      gateway_key: { state: "UPSTREAM-SECRET-GATEWAY-STATE", key_version: null },
      denial_reason: "UPSTREAM-SECRET-DENIAL",
    };
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(body)));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useOrgMe(), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.gateway_key).toEqual({ state: "unknown", key_version: null });
    expect(result.current.data?.denial_reason).toBeNull();
    expect(result.current.data?.capabilities.start_model_tasks).toBe(false);
    expect(client.getQueryData(queryKeys.orgMe())).toEqual(result.current.data);
    expect(JSON.stringify(client.getQueryCache().getAll()))
      .not.toMatch(/UPSTREAM-SECRET-(?:GATEWAY-STATE|DENIAL)/);
  });

  it.each([
    "MODEL_ACCESS_DENIED",
    "ORG_MEMBERSHIP_INACTIVE",
    "ORG_SUSPENDED",
    "ORG_CREDENTIAL_MISSING",
    "ORG_CREDENTIAL_DISABLED",
    "ORG_CREDENTIAL_GATEWAY_MISMATCH",
    "ORG_AUTHZ_STALE",
  ])("accepts allowlisted denial reason %s", async (denialReason) => {
    const body = {
      ...authoritativeOrgMe,
      capabilities: { ...authoritativeOrgMe.capabilities, start_model_tasks: false },
      denial_reason: denialReason,
    };
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(body)));
    await expect(getOrgMe()).resolves.toEqual(body);
  });

  it("normalizes an unknown denial reason before returning or caching it", async () => {
    const body = {
      ...authoritativeOrgMe,
      denial_reason: "UPSTREAM-SECRET-DENIAL",
    };
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(body)));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useOrgMe(), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.denial_reason).toBeNull();
    expect(result.current.data?.capabilities.start_model_tasks).toBe(false);
    expect(client.getQueryData(queryKeys.orgMe())).toEqual(result.current.data);
    expect(JSON.stringify(client.getQueryCache().getAll()))
      .not.toContain("UPSTREAM-SECRET-DENIAL");
  });

  it.each([undefined, 1, false, {}])("rejects non-string denial reason %j", async (denialReason) => {
    const body = { ...authoritativeOrgMe, denial_reason: denialReason };
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(body)));
    await expect(getOrgMe()).rejects.toMatchObject({ code: "ORG_REQUEST_FAILED" });
  });

  it.each([
    ["organization timezone-free", {
      organization: { ...authoritativeOrgMe.organization, updated_at: "2026-08-02T00:00:00" },
    }],
    ["membership timezone-free", {
      membership: { ...authoritativeOrgMe.membership, updated_at: "2026-08-02T00:00:00" },
    }],
    ["organization invalid offset", {
      organization: { ...authoritativeOrgMe.organization, updated_at: "2026-08-02T00:00:00+14:01" },
    }],
    ["membership invalid offset", {
      membership: { ...authoritativeOrgMe.membership, updated_at: "2026-08-02T00:00:00-15:00" },
    }],
  ])("rejects invalid zoned timestamp: %s", async (_name, override) => {
    const body = { ...authoritativeOrgMe, ...override };
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(body)));
    await expect(getOrgMe()).rejects.toMatchObject({ code: "ORG_REQUEST_FAILED" });
  });

  it.each([
    ["malformed envelope", 500, { ok: false, error: { message: "BODY-CANARY" } }, null],
    ["unknown code", 418, {
      ok: false,
      error: { code: "FUTURE_UNKNOWN", message: "BODY-CANARY", request_id: "request-unknown" },
    }, "request-unknown"],
  ])("safely degrades %s", async (_name, status, body, requestId) => {
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(body, { status })));
    const error = await getOrgMe().catch((value: unknown) => value);
    expect(error).toMatchObject({
      name: "OrgApiError", status, code: "ORG_REQUEST_FAILED", requestId,
    });
    expect(JSON.stringify(error)).not.toContain("BODY-CANARY");
    expect(String(error)).not.toContain("BODY-CANARY");
  });

  it("safely degrades non-JSON errors without retaining response text", async () => {
    server.use(http.get("*/api/v1/org/me", () =>
      new HttpResponse("NON-JSON-SECRET", { status: 502 })));
    const error = await getOrgMe().catch((value: unknown) => value);
    expect(error).toMatchObject({
      name: "OrgApiError", status: 502, code: "ORG_REQUEST_FAILED", requestId: null,
    });
    expect(JSON.stringify(error)).not.toContain("NON-JSON-SECRET");
    expect(String(error)).not.toContain("NON-JSON-SECRET");
  });
});
