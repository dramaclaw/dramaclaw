// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createElement, type PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "@/__mocks__/msw/server";
import {
  acceptOrgInvite,
  addOrgMember,
  addOrgMembersBatch,
  getOrgInvitePreview,
  getOrgMe,
  listOrgInvites,
  listOrgMembers,
  OrgApiError,
  patchOrgMember,
  revokeOrgInvite,
  useAcceptOrgInvite,
  useCreateOrgInvite,
  useOrgInvites,
  useOrgMembers,
  usePatchOrgMember,
} from "@/lib/queries/org";
import { queryKeys } from "@/lib/query-keys";
import type {
  Invite,
  InviteListParams,
  InvitePreview,
  MemberListParams,
} from "@/types/org";

const member = {
  user_id: "user-1",
  username: "alice",
  role: "org_admin" as const,
  membership_status: "active" as const,
  model_billing_entitlement: "platform" as const,
  created_at: "2026-07-29T00:00:00Z",
  updated_at: "2026-07-29T00:01:00Z",
};

const invite = {
  invite_id: "invite-1",
  target_masked: "a***e",
  role: "org_member" as const,
  status: "pending" as const,
  expires_at: "2026-07-30T00:00:00Z",
  accepted_at: null,
  created_at: "2026-07-29T00:00:00Z",
};

function wrapperFor(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function expectCookieOnlyRequest(request: Request): void {
  const url = new URL(request.url);
  expect(url.searchParams.has("org_id")).toBe(false);
  expect(url.searchParams.has("tenant_id")).toBe(false);
  expect(request.headers.has("X-Org-ID")).toBe(false);
  expect(request.headers.has("Authorization")).toBe(false);
  expect(request.headers.has("X-API-Key")).toBe(false);
  expect(request.credentials).toBe("include");
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  server.use(
    http.all("*/api/v1/org/*", ({ request }) => {
      throw new Error(`Unhandled organization request: ${request.method}`);
    }),
  );
});

describe("organization API contract", () => {
  it("mirrors optional invite role fields from the current OpenAPI", () => {
    const inviteWithoutRole: Invite = {
      invite_id: "invite-without-role",
      target_masked: "a***e",
      status: "pending",
      expires_at: "2026-07-30T00:00:00Z",
    };
    const previewWithoutRole: InvitePreview = {
      org_name: "Acme",
      target_masked: "a***e",
      status: "pending",
      expires_at: "2026-07-30T00:00:00Z",
    };

    expect(inviteWithoutRole).not.toHaveProperty("role");
    expect(previewWithoutRole).not.toHaveProperty("role");
  });

  it("reads the bare /org/me DTO without BT4 or BT5 fields", async () => {
    server.use(
      http.get("*/api/v1/org/me", ({ request }) => {
        expectCookieOnlyRequest(request);
        return HttpResponse.json({
          user: {
            user_id: "user-1",
            username: "alice",
            model_billing_entitlement: "platform",
          },
          organization: {
            org_id: "org-1",
            name: "Acme",
            status: "active",
            updated_at: "2026-07-29T00:00:00Z",
          },
          membership: {
            role: "org_admin",
            membership_status: "active",
            updated_at: "2026-07-29T00:00:00Z",
          },
          capabilities: { manage_members: true, manage_invites: true },
          denial_reason: null,
        });
      }),
    );

    const result = await getOrgMe();

    expect(result.organization?.org_id).toBe("org-1");
    expect(result.capabilities).toEqual({ manage_members: true, manage_invites: true });
    expect(result).not.toHaveProperty("current_org");
    expect(result).not.toHaveProperty("key");
  });

  it("implements member list, create, batch and patch wire contracts", async () => {
    const observed: Array<{
      method: string;
      url: string;
      body: unknown;
      idempotency: string | null;
    }> = [];
    server.use(
      http.get("*/api/v1/org/members", ({ request }) => {
        expectCookieOnlyRequest(request);
        observed.push({
          method: request.method,
          url: request.url,
          body: null,
          idempotency: null,
        });
        return HttpResponse.json([member], { headers: { "X-Total-Count": "7" } });
      }),
      http.post("*/api/v1/org/members", async ({ request }) => {
        expectCookieOnlyRequest(request);
        observed.push({
          method: request.method,
          url: request.url,
          body: await request.json(),
          idempotency: request.headers.get("Idempotency-Key"),
        });
        return HttpResponse.json(member, { status: 201 });
      }),
      http.post("*/api/v1/org/members/batch", async ({ request }) => {
        expectCookieOnlyRequest(request);
        observed.push({
          method: request.method,
          url: request.url,
          body: await request.json(),
          idempotency: request.headers.get("Idempotency-Key"),
        });
        return HttpResponse.json({
          accepted_count: 1,
          rejected_count: 0,
          items: [{ client_item_id: "row-1", status: "created", code: null, member }],
        });
      }),
      http.patch("*/api/v1/org/members/:userId", async ({ request }) => {
        expect(new URL(request.url).pathname).toContain("user%2Fwith%2Fslash");
        expectCookieOnlyRequest(request);
        observed.push({
          method: request.method,
          url: request.url,
          body: await request.json(),
          idempotency: null,
        });
        return HttpResponse.json({ ...member, role: "org_member" });
      }),
    );

    const page = await listOrgMembers({
      status: "active",
      role: "org_admin",
      q: "ali",
      sort: "updated_at",
      dir: "desc",
      limit: 25,
      offset: 5,
    });
    await addOrgMember({
      body: { mode: "existing", user_id: "user-1" },
      idempotencyKey: "member-key-1",
    });
    const batch = await addOrgMembersBatch({
      body: {
        items: [{ client_item_id: "row-1", mode: "existing", user_id: "user-1" }],
      },
      idempotencyKey: "batch-key-1",
    });
    await patchOrgMember("user/with/slash", {
      role: "org_member",
      expected_updated_at: "2026-07-29T00:01:00Z",
    });

    expect(page).toEqual({ items: [member], total: 7 });
    expect(batch.items[0]).toMatchObject({ client_item_id: "row-1", status: "created" });
    expect(Object.fromEntries(new URL(observed[0].url).searchParams)).toEqual({
      status: "active",
      role: "org_admin",
      q: "ali",
      sort: "updated_at",
      dir: "desc",
      limit: "25",
      offset: "5",
    });
    expect(observed[1]).toMatchObject({ idempotency: "member-key-1" });
    expect(observed[2]).toMatchObject({ idempotency: "batch-key-1" });
    expect(observed[3].body).toEqual({
      role: "org_member",
      expected_updated_at: "2026-07-29T00:01:00Z",
    });
  });

  it("allowlists runtime member selectors in both URL and query key", async () => {
    const selectorCanary = "BT10A-SELECTOR-CANARY";
    const observedUrls: string[] = [];
    server.use(
      http.get("*/api/v1/org/members", ({ request }) => {
        observedUrls.push(request.url);
        return HttpResponse.json([member], { headers: { "X-Total-Count": "1" } });
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const runtimeParams = {
      status: "active",
      role: "org_admin",
      q: "ali",
      sort: "updated_at",
      dir: "desc",
      limit: 25,
      offset: 0,
      org_id: selectorCanary,
      "X-Org-ID": selectorCanary,
      "x-org-id": selectorCanary,
      Org_ID: selectorCanary,
      tenant_id: selectorCanary,
      token: selectorCanary,
      arbitrary: selectorCanary,
    } as MemberListParams;
    const originalParams = { ...runtimeParams };

    await listOrgMembers(runtimeParams);
    const { result } = renderHook(() => useOrgMembers(runtimeParams), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(observedUrls).toHaveLength(2);
    for (const observedUrl of observedUrls) {
      expect(Object.fromEntries(new URL(observedUrl).searchParams)).toEqual({
        status: "active",
        role: "org_admin",
        q: "ali",
        sort: "updated_at",
        dir: "desc",
        limit: "25",
        offset: "0",
      });
    }
    expect(queryClient.getQueryCache().getAll()[0]?.queryKey).toEqual([
      "org",
      "members",
      {
        status: "active",
        role: "org_admin",
        q: "ali",
        sort: "updated_at",
        dir: "desc",
        limit: 25,
        offset: 0,
      },
    ]);
    expect(runtimeParams).toEqual(originalParams);
    expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain(selectorCanary);
  });

  it("implements invite create, list, revoke, preview and accept wire contracts", async () => {
    const observed: Array<{
      method: string;
      url: string;
      body: unknown;
      key: string | null;
    }> = [];
    server.use(
      http.post("*/api/v1/org/invites", async ({ request }) => {
        expectCookieOnlyRequest(request);
        observed.push({
          method: request.method,
          url: request.url,
          body: await request.json(),
          key: request.headers.get("Idempotency-Key"),
        });
        return HttpResponse.json({ invite, token: "RAW-TOKEN-CANARY" }, { status: 201 });
      }),
      http.get("*/api/v1/org/invites", ({ request }) => {
        expectCookieOnlyRequest(request);
        observed.push({ method: request.method, url: request.url, body: null, key: null });
        return HttpResponse.json([invite], { headers: { "X-Total-Count": "1" } });
      }),
      http.delete("*/api/v1/org/invites/:inviteId", ({ request }) => {
        expect(new URL(request.url).pathname).toContain("invite%2Fwith%2Fslash");
        expectCookieOnlyRequest(request);
        observed.push({ method: request.method, url: request.url, body: null, key: null });
        return HttpResponse.json({ ...invite, status: "revoked" });
      }),
      http.get("*/api/v1/org/invites/:token/preview", ({ request }) => {
        expect(new URL(request.url).pathname).toContain("token%2Fwith%2Fslash");
        expectCookieOnlyRequest(request);
        observed.push({ method: request.method, url: request.url, body: null, key: null });
        return HttpResponse.json({
          org_name: "Acme",
          target_masked: "a***e",
          role: "org_member",
          status: "pending",
          expires_at: "2026-07-30T00:00:00Z",
        });
      }),
      http.post("*/api/v1/org/invites/:token/accept", async ({ request }) => {
        expect(new URL(request.url).pathname).toContain("token%2Fwith%2Fslash");
        expectCookieOnlyRequest(request);
        observed.push({
          method: request.method,
          url: request.url,
          body: await request.json(),
          key: request.headers.get("Idempotency-Key"),
        });
        return HttpResponse.json({
          user_id: "user-1",
          org_id: "org-1",
          role: "org_member",
          membership_status: "active",
          model_billing_entitlement: "platform",
        });
      }),
    );

    const consumeToken = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const create = renderHook(() => useCreateOrgInvite(), {
      wrapper: wrapperFor(queryClient),
    });
    let created: unknown;
    await act(async () => {
      created = await create.result.current.mutateAsync({
        body: { target_username: "alice", expires_in_hours: 24 },
        idempotencyKey: "invite-key-1",
        consumeToken,
      });
    });
    await waitFor(() => expect(create.result.current.isSuccess).toBe(true));
    const page = await listOrgInvites({ status: "pending", limit: 10, offset: 0 });
    const revoked = await revokeOrgInvite("invite/with/slash");
    const preview = await getOrgInvitePreview("token/with/slash");
    const accepted = await acceptOrgInvite("token/with/slash", {
      body: { mode: "existing" },
      idempotencyKey: "accept-key-1",
    });

    expect(consumeToken).toHaveBeenCalledWith("RAW-TOKEN-CANARY");
    expect(created).toEqual(invite);
    expect(page).toEqual({ items: [invite], total: 1 });
    expect(revoked.status).toBe("revoked");
    expect(preview).not.toHaveProperty("viewer_state");
    expect(accepted).toMatchObject({ org_id: "org-1", membership_status: "active" });
    expect(observed[0].key).toBe("invite-key-1");
    expect(observed[4].key).toBe("accept-key-1");
    expect(JSON.stringify(observed.map(({ body }) => body))).not.toContain('"org_id"');
  });

  it("allowlists runtime invite selectors in both URL and query key", async () => {
    const selectorCanary = "BT10A-SELECTOR-CANARY";
    const observedUrls: string[] = [];
    server.use(
      http.get("*/api/v1/org/invites", ({ request }) => {
        observedUrls.push(request.url);
        return HttpResponse.json([invite], { headers: { "X-Total-Count": "1" } });
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const runtimeParams = {
      status: "pending",
      sort: "created_at",
      dir: "asc",
      limit: 10,
      offset: 0,
      org_id: selectorCanary,
      "X-Org-ID": selectorCanary,
      "x-org-id": selectorCanary,
      Org_ID: selectorCanary,
      tenant_id: selectorCanary,
      token: selectorCanary,
      arbitrary: selectorCanary,
    } as InviteListParams;
    const originalParams = { ...runtimeParams };

    await listOrgInvites(runtimeParams);
    const { result } = renderHook(() => useOrgInvites(runtimeParams), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(observedUrls).toHaveLength(2);
    for (const observedUrl of observedUrls) {
      expect(Object.fromEntries(new URL(observedUrl).searchParams)).toEqual({
        status: "pending",
        sort: "created_at",
        dir: "asc",
        limit: "10",
        offset: "0",
      });
    }
    expect(queryClient.getQueryCache().getAll()[0]?.queryKey).toEqual([
      "org",
      "invites",
      {
        status: "pending",
        sort: "created_at",
        dir: "asc",
        limit: 10,
        offset: 0,
      },
    ]);
    expect(runtimeParams).toEqual(originalParams);
    expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain(selectorCanary);
  });

  it.each([
    [401, "AUTH_REQUIRED"],
    [403, "ORG_ADMIN_REQUIRED"],
    [404, "ORG_MEMBER_NOT_FOUND"],
    [409, "ORG_CONCURRENT_MODIFICATION"],
    [422, "ORG_REQUEST_INVALID"],
    [429, "ORG_RATE_LIMITED"],
  ])("maps HTTP %s stable errors without exposing backend messages", async (status, code) => {
    if (status === 401) window.history.replaceState({}, "", "/login");
    server.use(
      http.get("*/api/v1/org/invites/:token/preview", () =>
        HttpResponse.json(
          {
            ok: false,
            error: {
              code,
              message: "BACKEND-MESSAGE-CANARY",
              request_id: `request-${status}`,
              ...(status === 422
                ? {
                    field_errors: [
                      {
                        path: "body.username",
                        code: "invalid",
                        message: "FIELD-MESSAGE-CANARY",
                      },
                    ],
                  }
                : {}),
            },
          },
          { status },
        ),
      ),
    );

    const error = await getOrgInvitePreview("RAW-TOKEN-CANARY").catch(
      (value: unknown) => value,
    );
    if (status === 401) window.history.replaceState({}, "", "/");

    expect(error).toBeInstanceOf(OrgApiError);
    expect(error).toMatchObject({ status, code, requestId: `request-${status}` });
    if (!(error instanceof OrgApiError)) throw error;
    if (status === 422) {
      expect(error.fieldErrors).toEqual([
        { path: "body.username", code: "invalid", message: "Invalid value." },
      ]);
    }
    expect(JSON.stringify(error)).not.toContain("BACKEND-MESSAGE-CANARY");
    expect(String(error)).not.toContain("FIELD-MESSAGE-CANARY");
    expect(String(error)).not.toContain("RAW-TOKEN-CANARY");
  });

  it("fail-closes malformed field errors, unknown codes and non-JSON bodies", async () => {
    const rawToken = "BT10A-RAW-TOKEN-CANARY";
    const password = "BT10A-PASSWORD-CANARY";
    const dsn = "postgresql://BT10A-SQL-DSN-CANARY";
    const canaries = `${rawToken}:${password}:${dsn}`;
    server.use(
      http.get("*/api/v1/org/me", () =>
        HttpResponse.json(
          {
            ok: false,
            error: {
              code: "ORG_REQUEST_INVALID",
              message: canaries,
              request_id: "request-field-errors",
              field_errors: [
                { path: `body.${canaries}`, code: "missing", message: canaries },
                { path: "body.password", code: canaries, message: canaries },
                {
                  path: "body.items.0.password",
                  code: "string_too_short",
                  message: canaries,
                },
                { path: "body.123456.password", code: "invalid", message: canaries },
              ],
            },
          },
          { status: 422 },
        ),
      ),
    );

    const fieldError = await getOrgMe().catch((value: unknown) => value);

    expect(fieldError).toBeInstanceOf(OrgApiError);
    if (!(fieldError instanceof OrgApiError)) throw fieldError;
    expect(fieldError.fieldErrors).toEqual([
      { path: "request", code: "missing", message: "Invalid value." },
      { path: "body.password", code: "invalid", message: "Invalid value." },
      {
        path: "body.items.0.password",
        code: "string_too_short",
        message: "Invalid value.",
      },
      { path: "request", code: "invalid", message: "Invalid value." },
    ]);
    expect(JSON.stringify(fieldError)).not.toContain(rawToken);
    expect(JSON.stringify(fieldError)).not.toContain(password);
    expect(JSON.stringify(fieldError)).not.toContain(dsn);
    expect(String(fieldError)).toBe("OrgApiError: Organization request failed");

    server.use(
      http.get("*/api/v1/org/me", () =>
        HttpResponse.json(
          {
            ok: false,
            error: {
              code: "FUTURE_UNKNOWN_CODE",
              message: "UPSTREAM-SECRET-CANARY",
              request_id: "request-unknown",
            },
          },
          { status: 418 },
        ),
      ),
    );
    const unknown = await getOrgMe().catch((value: unknown) => value);
    expect(unknown).toMatchObject({
      status: 418,
      code: "ORG_REQUEST_FAILED",
      requestId: "request-unknown",
    });
    expect(String(unknown)).not.toContain("UPSTREAM-SECRET-CANARY");

    server.use(
      http.get(
        "*/api/v1/org/me",
        () => new HttpResponse("NON-JSON-SECRET-CANARY", { status: 502 }),
      ),
    );
    const nonJson = await getOrgMe().catch((value: unknown) => value);
    expect(nonJson).toMatchObject({
      status: 502,
      code: "ORG_REQUEST_FAILED",
      requestId: null,
    });
    expect(String(nonJson)).not.toContain("NON-JSON-SECRET-CANARY");
  });

  it("consumes first-response invite tokens outside query, mutation and storage caches", async () => {
    server.use(
      http.post("*/api/v1/org/invites", () =>
        HttpResponse.json({ invite, token: "RAW-TOKEN-CANARY" }, { status: 201 }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.orgInvites(), []);
    queryClient.setQueryData(queryKeys.orgMe(), { organization: null });
    queryClient.setQueryData(queryKeys.orgMembers(), []);
    queryClient.setQueryData(queryKeys.projects(), ["project-a"]);
    const consumeToken = vi.fn();
    const { result } = renderHook(() => useCreateOrgInvite(), {
      wrapper: wrapperFor(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        body: { target_username: "alice" },
        idempotencyKey: "invite-key-1",
        consumeToken,
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(consumeToken).toHaveBeenCalledWith("RAW-TOKEN-CANARY");
    expect(result.current.data).toEqual(invite);
    expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain(
      "RAW-TOKEN-CANARY",
    );
    expect(JSON.stringify(queryClient.getMutationCache().getAll())).not.toContain(
      "RAW-TOKEN-CANARY",
    );
    expect(JSON.stringify(localStorage)).not.toContain("RAW-TOKEN-CANARY");
    expect(JSON.stringify(sessionStorage)).not.toContain("RAW-TOKEN-CANARY");
    expect(queryClient.getQueryState(queryKeys.orgInvites())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.orgMe())?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.orgMembers())?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.projects())?.isInvalidated).toBe(false);
  });

  it("uses one organization query root and invalidates only the required scopes", async () => {
    expect(queryKeys.org()).toEqual(["org"]);
    expect(queryKeys.orgMe()).toEqual(["org", "me"]);
    expect(queryKeys.orgMembers()).toEqual(["org", "members"]);
    expect(queryKeys.orgInvites()).toEqual(["org", "invites"]);

    server.use(
      http.post("*/api/v1/org/invites/:token/accept", () =>
        HttpResponse.json({
          user_id: "user-1",
          org_id: "org-1",
          role: "org_member",
          membership_status: "active",
          model_billing_entitlement: "platform",
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.orgMe(), { organization: null });
    queryClient.setQueryData(queryKeys.orgMembers(), []);
    queryClient.setQueryData(queryKeys.orgInvites(), []);
    queryClient.setQueryData(queryKeys.projects(), ["project-a"]);
    const { result } = renderHook(() => useAcceptOrgInvite("RAW-TOKEN-CANARY"), {
      wrapper: wrapperFor(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        body: { mode: "existing" },
        idempotencyKey: "accept-key-1",
      });
    });

    expect(queryClient.getQueryState(queryKeys.orgMe())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.orgMembers())?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.orgInvites())?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.projects())?.isInvalidated).toBe(false);
    expect(JSON.stringify(queryClient.getMutationCache().getAll())).not.toContain(
      "RAW-TOKEN-CANARY",
    );
  });

  it("invalidates only org me, members, and invites after a successful member patch", async () => {
    server.use(
      http.patch("*/api/v1/org/members/user-1", () =>
        HttpResponse.json({ ...member, role: "org_member" }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.orgMe(), { organization: null });
    queryClient.setQueryData(queryKeys.orgMembers(), []);
    queryClient.setQueryData(queryKeys.orgInvites(), []);
    queryClient.setQueryData(queryKeys.projects(), ["project-a"]);
    const { result } = renderHook(() => usePatchOrgMember(), {
      wrapper: wrapperFor(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        userId: "user-1",
        body: {
          role: "org_member",
          expected_updated_at: member.updated_at,
        },
      });
    });

    expect(queryClient.getQueryState(queryKeys.orgMe())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.orgMembers())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.orgInvites())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.projects())?.isInvalidated).toBe(false);
  });
});
