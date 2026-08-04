// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { server } from "@/__mocks__/msw/server";
import { getOrgMe } from "@/lib/queries/org";
import { useAuthStore } from "@/stores/auth-store";

const passwordCanary = "DIRECT-MEMBER-PASSWORD-CANARY";

beforeAll(() => {
  server.close();
  server.listen({ onUnhandledRequest: "error" });
});

afterAll(() => {
  server.close();
  server.listen({ onUnhandledRequest: "bypass" });
});

beforeEach(() => {
  useAuthStore.getState().reset();
  localStorage.clear();
  sessionStorage.clear();
  server.use(
    http.post("*/api/v1/auth/login", async ({ request }) => {
      expect(request.credentials).toBe("include");
      expect(new URL(request.url).search).toBe("");
      expect(await request.json()).toEqual({
        username: "new_member",
        password: passwordCanary,
      });
      return HttpResponse.json({
        ok: true,
        data: {
          username: "new_member",
          role: "org_member",
          credit_balance: 0,
        },
      });
    }),
    http.get("*/api/v1/account/avatar", () =>
      HttpResponse.json({ error: "not configured" }, { status: 404 }),
    ),
    http.get("*/api/v1/org/me", ({ request }) => {
      expect(request.credentials).toBe("include");
      expect(new URL(request.url).search).toBe("");
      return HttpResponse.json({
        user: {
          user_id: "member-2",
          username: "new_member",
          model_billing_entitlement: "org_sponsored",
        },
        organization: {
          org_id: "org-1",
          name: "Acme",
          status: "active",
          updated_at: "2026-08-03T00:00:00Z",
        },
        membership: {
          role: "org_member",
          membership_status: "active",
          updated_at: "2026-08-03T00:01:00Z",
        },
        capabilities: {
          manage_members: false,
          manage_invites: false,
          manage_gateway_key: false,
          start_model_tasks: true,
        },
        gateway_key: { state: "active", key_version: 1 },
        denial_reason: null,
      });
    }),
  );
});

describe("direct organization member login", () => {
  it("accepts a provisioned member account without exposing management authority or its secret", async () => {
    await useAuthStore.getState().login("new_member", passwordCanary);

    expect(useAuthStore.getState()).toMatchObject({
      username: "new_member",
      role: "org_member",
    });

    const organization = await getOrgMe();
    expect(organization).toMatchObject({
      user: {
        username: "new_member",
        model_billing_entitlement: "org_sponsored",
      },
      organization: { org_id: "org-1" },
      membership: { role: "org_member", membership_status: "active" },
      capabilities: {
        manage_members: false,
        manage_invites: false,
        manage_gateway_key: false,
        start_model_tasks: true,
      },
    });

    expect(JSON.stringify(useAuthStore.getState())).not.toContain(passwordCanary);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(passwordCanary);
  });
});
