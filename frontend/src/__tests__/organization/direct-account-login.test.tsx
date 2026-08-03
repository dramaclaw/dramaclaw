// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";
import { OrganizationMembers } from "@/components/organization/organization-members";
import { getOrgMe } from "@/lib/queries/org";
import { queryKeys } from "@/lib/query-keys";
import { resetUserSessionState } from "@/lib/reset-region-state";
import { useAuthStore } from "@/stores/auth-store";
import type { Member, MembershipStatus, OrgMe, OrgRole } from "@/types/org";

const passwordCanary = "P0G2-PASSWORD-CANARY-7319";
const serverMessageCanary = "P0G2-SERVER-MESSAGE-CANARY-8427";
const primaryOrgId = "org-1";

const labels: Record<string, string> = {
  "organization.members.title": "Members",
  "organization.members.search": "Search members",
  "organization.members.total": "members",
  "organization.members.next": "Next page",
  "organization.members.add": "Add member",
  "organization.members.batch": "Batch add",
  "organization.members.existing": "Existing user",
  "organization.members.create": "Create account",
  "organization.members.userId": "User ID",
  "organization.members.username": "Username",
  "organization.members.password": "Password",
  "organization.members.createAndAdd": "Create and add",
  "organization.members.added": "Member added",
  "organization.members.change": "Change member",
  "organization.roles.admin": "Organization administrator",
  "organization.roles.member": "Organization member",
  "organization.status.active": "Active",
  "organization.status.suspended": "Suspended",
  "organization.entitlement.platform": "Platform",
  "organization.entitlement.orgSponsored": "Organization sponsored",
  "organization.errors.generic": "Organization request failed",
  "common.cancel": "Cancel",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number }) =>
      key === "organization.members.total"
        ? `${values?.count ?? 0} members`
        : labels[key] ?? key,
    i18n: { language: "en" },
  }),
}));

interface Account {
  userId: string;
  username: string;
  password: string;
  entitlement: "platform" | "org_sponsored";
}

interface Membership {
  orgId: string;
  role: OrgRole;
  status: MembershipStatus;
  updatedAt: string;
}

interface ServiceState {
  accounts: Map<string, Account>;
  memberships: Map<string, Membership>;
  sessionUsername: string | null;
  createCalls: number;
  loginCalls: number;
  orgMeCalls: number;
  memberListCalls: number;
  createRequest: {
    body: unknown;
    headers: Array<[string, string]>;
    idempotencyKeys: string[];
    url: URL;
  } | null;
  createResponse: Record<string, unknown> | null;
  loginRequest: { body: unknown; credentials: RequestCredentials } | null;
}

function initialState(): ServiceState {
  return {
    accounts: new Map([
      [
        "org_admin",
        {
          userId: "admin-1",
          username: "org_admin",
          password: "admin-password",
          entitlement: "platform",
        },
      ],
    ]),
    memberships: new Map([
      [
        "org_admin",
        {
          orgId: primaryOrgId,
          role: "org_admin",
          status: "active",
          updatedAt: "2026-08-03T00:00:00Z",
        },
      ],
    ]),
    sessionUsername: "org_admin",
    createCalls: 0,
    loginCalls: 0,
    orgMeCalls: 0,
    memberListCalls: 0,
    createRequest: null,
    createResponse: null,
    loginRequest: null,
  };
}

let state = initialState();

function currentAccount(): Account | null {
  return state.sessionUsername ? state.accounts.get(state.sessionUsername) ?? null : null;
}

function currentMembership(): Membership | null {
  return state.sessionUsername
    ? state.memberships.get(state.sessionUsername) ?? null
    : null;
}

function memberSnapshot(account: Account, membership: Membership): Member {
  return {
    user_id: account.userId,
    username: account.username,
    role: membership.role,
    membership_status: membership.status,
    model_billing_entitlement: account.entitlement,
    updated_at: membership.updatedAt,
  };
}

function orgMeSnapshot(account: Account, membership: Membership): OrgMe {
  const isActive = membership.status === "active";
  const isAdmin = isActive && membership.role === "org_admin";
  return {
    user: {
      user_id: account.userId,
      username: account.username,
      model_billing_entitlement: account.entitlement,
    },
    organization: {
      org_id: membership.orgId,
      name: membership.orgId === primaryOrgId ? "Acme" : "Other organization",
      status: "active",
      updated_at: "2026-08-03T00:00:00Z",
    },
    membership: {
      role: membership.role,
      membership_status: isActive ? "active" : "suspended",
      updated_at: membership.updatedAt,
    },
    capabilities: {
      manage_members: isAdmin,
      manage_invites: isAdmin,
      manage_gateway_key: isAdmin,
      start_model_tasks: isActive,
    },
    gateway_key: { state: "active", key_version: 1 },
    denial_reason: isActive ? null : "ORG_MEMBERSHIP_INACTIVE",
  };
}

const closedLoopHandlers = [
  http.get("*/api/v1/org/me", ({ request }) => {
    state.orgMeCalls += 1;
    const account = currentAccount();
    const membership = currentMembership();
    if (!account || !membership) {
      return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (membership.orgId !== primaryOrgId) {
      return HttpResponse.json({ error: "cross-org context denied" }, { status: 403 });
    }
    expect(request.credentials).toBe("include");
    expect(new URL(request.url).search).toBe("");
    return HttpResponse.json(orgMeSnapshot(account, membership));
  }),
  http.get("*/api/v1/org/members", ({ request }) => {
    state.memberListCalls += 1;
    const membership = currentMembership();
    if (
      !membership ||
      membership.orgId !== primaryOrgId ||
      membership.role !== "org_admin" ||
      membership.status !== "active"
    ) {
      return HttpResponse.json({ error: "forbidden" }, { status: 403 });
    }
    expect(request.credentials).toBe("include");
    const members = [...state.accounts.values()].flatMap((account) => {
      const accountMembership = state.memberships.get(account.username);
      return accountMembership?.orgId === primaryOrgId
        ? [memberSnapshot(account, accountMembership)]
        : [];
    });
    return HttpResponse.json(members, {
      headers: { "X-Total-Count": String(members.length) },
    });
  }),
  http.post("*/api/v1/org/members", async ({ request }) => {
    state.createCalls += 1;
    const url = new URL(request.url);
    const idempotencyKeys = [...request.headers]
      .filter(([name]) => name.toLowerCase() === "idempotency-key")
      .map(([, value]) => value);
    const body = await request.json();
    state.createRequest = {
      body,
      headers: [...request.headers],
      idempotencyKeys,
      url,
    };
    const membership = currentMembership();
    if (
      !membership ||
      membership.orgId !== primaryOrgId ||
      membership.role !== "org_admin" ||
      membership.status !== "active"
    ) {
      return HttpResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const input = body as { mode?: unknown; username?: unknown; password?: unknown };
    if (
      input.mode !== "create" ||
      typeof input.username !== "string" ||
      typeof input.password !== "string"
    ) {
      return HttpResponse.json({ error: "invalid request" }, { status: 422 });
    }
    const account: Account = {
      userId: "member-2",
      username: input.username,
      password: input.password,
      entitlement: "org_sponsored",
    };
    const newMembership: Membership = {
      orgId: primaryOrgId,
      role: "org_member",
      status: "active",
      updatedAt: "2026-08-03T00:01:00Z",
    };
    state.accounts.set(account.username, account);
    state.memberships.set(account.username, newMembership);
    state.createResponse = {
      ...memberSnapshot(account, newMembership),
      message: serverMessageCanary,
    };
    return HttpResponse.json(state.createResponse, { status: 201 });
  }),
  http.post("*/api/v1/auth/logout", ({ request }) => {
    expect(request.credentials).toBe("include");
    state.sessionUsername = null;
    return new HttpResponse(null, { status: 204 });
  }),
  http.post("*/api/v1/auth/login", async ({ request }) => {
    state.loginCalls += 1;
    const body = (await request.json()) as { username?: unknown; password?: unknown };
    state.loginRequest = { body, credentials: request.credentials };
    const account =
      typeof body.username === "string" ? state.accounts.get(body.username) : undefined;
    if (!account || account.password !== body.password) {
      return HttpResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }
    state.sessionUsername = account.username;
    return HttpResponse.json({
      ok: true,
      data: {
        username: account.username,
        role: state.memberships.get(account.username)?.role ?? "user",
        credit_balance: 0,
      },
    });
  }),
  http.get("*/api/v1/auth/me", ({ request }) => {
    expect(request.credentials).toBe("include");
    const account = currentAccount();
    if (!account) return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
    return HttpResponse.json({
      ok: true,
      data: {
        username: account.username,
        role: currentMembership()?.role ?? "user",
        credit_balance: 0,
      },
    });
  }),
  http.get("*/api/v1/account/avatar", () =>
    HttpResponse.json({ error: "not configured" }, { status: 404 }),
  ),
];

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

function renderMembers(client: QueryClient, onForbidden = vi.fn()) {
  return {
    onForbidden,
    ...render(
      <QueryClientProvider client={client}>
        <OrganizationMembers
          params={{ limit: 20, offset: 0 }}
          onParamsChange={vi.fn()}
          onForbidden={onForbidden}
        />
      </QueryClientProvider>,
    ),
  };
}

beforeAll(() => {
  server.close();
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => {
  server.close();
  server.listen({ onUnhandledRequest: "bypass" });
});

beforeEach(() => {
  server.use(...closedLoopHandlers);
  state = initialState();
  useAuthStore.getState().reset();
  useAuthStore.setState({ username: "org_admin", role: "org_admin" });
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.lang = "en";
});

describe("P0G-2 direct account and cookie-backed login", () => {
  it("closes create, logout, member login, org context, secret cleanup, and fail-closed cases", async () => {
    const consoleValues: unknown[][] = [];
    const consoleSpies = (["log", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
        consoleValues.push(values);
      }),
    );
    const client = makeClient();

    try {
      const adminView = renderMembers(client);
      expect(await screen.findByText("org_admin")).toBeVisible();
      expect(client.getQueryData<OrgMe>(queryKeys.orgMe())?.capabilities.manage_members).toBe(
        true,
      );

      await userEvent.click(screen.getByRole("button", { name: "Add member" }));
      await userEvent.click(screen.getByRole("tab", { name: "Create account" }));
      await userEvent.type(screen.getByLabelText("Username"), "new_member");
      await userEvent.type(screen.getByLabelText("Password"), passwordCanary);
      await userEvent.click(screen.getByRole("button", { name: "Create and add" }));

      expect(await screen.findByText("new_member")).toBeVisible();
      expect(state.createCalls).toBe(1);
      expect(state.createRequest).toMatchObject({
        body: { mode: "create", username: "new_member", password: passwordCanary },
        idempotencyKeys: [expect.stringMatching(/^member-/)],
      });
      expect(state.createRequest?.url.search).toBe("");
      expect(
        [...(state.createRequest?.url.searchParams.keys() ?? [])].filter((name) =>
          /org|tenant/i.test(name),
        ),
      ).toEqual([]);
      expect(
        state.createRequest?.headers.filter(([name]) => /org|tenant/i.test(name)),
      ).toEqual([]);
      expect(state.createResponse).not.toHaveProperty("password");
      expect(JSON.stringify(state.createResponse)).not.toContain(passwordCanary);
      const newMemberRow = screen.getByRole("row", { name: /new_member/ });
      expect(within(newMemberRow).getByText("Organization member")).toBeVisible();
      expect(within(newMemberRow).getByText("Active")).toBeVisible();
      expect(within(newMemberRow).getByText("Organization sponsored")).toBeVisible();
      expect(state.memberListCalls).toBe(2);

      const publicStateAfterCreate = JSON.stringify({
        dom: document.body.textContent,
        queryCache: client.getQueryCache().getAll(),
        mutationCache: client.getMutationCache().getAll(),
        localStorage: { ...localStorage },
        sessionStorage: { ...sessionStorage },
        consoleValues,
      });
      expect(publicStateAfterCreate).not.toContain(passwordCanary);
      expect(publicStateAfterCreate).not.toContain(serverMessageCanary);

      await useAuthStore.getState().logout();
      resetUserSessionState({ queryClient: client });
      expect(useAuthStore.getState()).toMatchObject({ username: null, role: null });
      expect(client.getQueryCache().getAll()).toHaveLength(0);
      expect(JSON.stringify({ ...localStorage })).not.toContain(passwordCanary);
      adminView.unmount();

      await useAuthStore.getState().login("new_member", passwordCanary);
      expect(state.loginCalls).toBe(1);
      expect(state.loginRequest).toEqual({
        body: { username: "new_member", password: passwordCanary },
        credentials: "include",
      });
      const authMeResponse = await fetch("/api/v1/auth/me", { credentials: "include" });
      expect(await authMeResponse.json()).toMatchObject({
        data: { username: "new_member", role: "org_member" },
      });
      const memberOrgMe = await getOrgMe();
      expect(memberOrgMe).toMatchObject({
        user: {
          username: "new_member",
          model_billing_entitlement: "org_sponsored",
        },
        organization: { org_id: primaryOrgId },
        membership: { role: "org_member", membership_status: "active" },
        capabilities: { manage_members: false },
      });

      const memberView = renderMembers(client);
      await waitFor(() => expect(memberView.onForbidden).toHaveBeenCalledOnce());
      expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
      expect(state.memberListCalls).toBe(2);
      expect(client.getQueryData<OrgMe>(queryKeys.orgMe())?.capabilities.manage_members).toBe(
        false,
      );
      memberView.unmount();

      await useAuthStore.getState().logout();
      const callsBeforeBadLogin = state.loginCalls;
      await expect(
        useAuthStore.getState().login("new_member", "wrong-password"),
      ).rejects.toThrow("Invalid credentials");
      expect(state.loginCalls).toBe(callsBeforeBadLogin + 1);
      expect(state.createCalls).toBe(1);
      expect(state.sessionUsername).toBeNull();

      state.sessionUsername = "new_member";
      state.memberships.get("new_member")!.status = "suspended";
      const inactiveClient = makeClient();
      const inactiveView = renderMembers(inactiveClient);
      await waitFor(() => expect(inactiveView.onForbidden).toHaveBeenCalledOnce());
      expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
      inactiveView.unmount();

      state.memberships.get("new_member")!.status = "active";
      state.memberships.get("new_member")!.orgId = "org-2";
      const crossOrgClient = makeClient();
      const orgMeCallsBeforeCrossOrg = state.orgMeCalls;
      const crossOrgView = renderMembers(crossOrgClient);
      await waitFor(() => expect(crossOrgView.onForbidden).toHaveBeenCalledOnce());
      expect(state.orgMeCalls).toBe(orgMeCallsBeforeCrossOrg + 1);
      expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
      expect(state.createCalls).toBe(1);
      expect(state.loginCalls).toBe(callsBeforeBadLogin + 1);
      crossOrgView.unmount();

      const finalPublicState = JSON.stringify({
        dom: document.body.textContent,
        queryCache: [
          client.getQueryCache().getAll(),
          inactiveClient.getQueryCache().getAll(),
          crossOrgClient.getQueryCache().getAll(),
        ],
        mutationCache: client.getMutationCache().getAll(),
        localStorage: { ...localStorage },
        sessionStorage: { ...sessionStorage },
        consoleValues,
      });
      expect(finalPublicState).not.toContain(passwordCanary);
      expect(finalPublicState).not.toContain(serverMessageCanary);
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });
});
