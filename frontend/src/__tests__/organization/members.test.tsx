// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";
import { OrganizationMembers } from "@/components/organization/organization-members";
import type { MemberListParams } from "@/types/org";

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
  "organization.members.batchRows": "Batch member rows",
  "organization.members.previewRows": "Preview rows",
  "organization.members.submitBatch": "Submit batch",
  "organization.members.result.existing": "Already exists",
  "organization.members.result.rejected": "Rejected",
  "organization.members.change": "Change member",
  "organization.members.refreshBeforeEdit": "Refresh before editing",
  "organization.members.lastAdminProtected": "Last active administrator is protected.",
  "organization.members.action.suspend": "Suspend",
  "organization.members.action.promote": "Promote to administrator",
  "organization.members.action.demote": "Demote to member",
  "organization.members.action.remove": "Remove",
  "organization.members.confirm.sessions": "Affected sessions will be invalidated.",
  "organization.errors.concurrent": "Member data changed.",
  "organization.errors.generic": "Organization request failed",
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
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

const orgMe = {
  user: {
    user_id: "viewer-1",
    username: "viewer",
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
  capabilities: {
    manage_members: true,
    manage_invites: true,
    manage_gateway_key: true,
    start_model_tasks: true,
  },
  gateway_key: { state: "active", key_version: 3 },
  denial_reason: null,
};

const member = {
  user_id: "user-1",
  username: "alice",
  role: "org_admin",
  membership_status: "active",
  model_billing_entitlement: "platform",
  updated_at: "old-version",
};

function renderMembers(options?: {
  params?: MemberListParams;
  onParamsChange?: (params: MemberListParams) => void;
  onForbidden?: () => void;
  orgMeResponse?: unknown;
  onOrgMeRequest?: () => void;
}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  server.use(
    http.get("*/api/v1/org/me", () => {
      options?.onOrgMeRequest?.();
      return HttpResponse.json(options?.orgMeResponse ?? orgMe);
    }),
    http.get("*/api/v1/org/members", () =>
      HttpResponse.json([member], { headers: { "X-Total-Count": "1" } }),
    ),
  );
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <OrganizationMembers
          params={options?.params ?? { limit: 20, offset: 0 }}
          onParamsChange={options?.onParamsChange ?? vi.fn()}
          onForbidden={options?.onForbidden ?? vi.fn()}
        />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  document.documentElement.lang = "en";
});

describe("organization members", () => {
  it("uses X-Total-Count and preserves a legal zero offset", async () => {
    const observed: URL[] = [];
    renderMembers();
    server.use(
      http.get("*/api/v1/org/members", ({ request }) => {
        observed.push(new URL(request.url));
        return HttpResponse.json([member], { headers: { "X-Total-Count": "21" } });
      }),
    );

    expect(await screen.findByText("alice")).toBeVisible();
    expect(screen.getByText("21 members")).toBeVisible();
    expect(observed[0].searchParams.get("offset")).toBe("0");
  });

  it("keeps capability-denied members at zero on focus", async () => {
    let memberCalls = 0;
    let orgMeCalls = 0;
    const onForbidden = vi.fn();
    server.use(
      http.get("*/api/v1/org/members", () => {
        memberCalls += 1;
        return HttpResponse.json([], { headers: { "X-Total-Count": "0" } });
      }),
    );
    renderMembers({
      onForbidden,
      onOrgMeRequest: () => {
        orgMeCalls += 1;
      },
      orgMeResponse: {
        ...orgMe,
        membership: {
          role: "org_member",
          membership_status: "active",
          updated_at: "2026-07-29T00:00:00Z",
        },
        capabilities: {
          manage_members: false,
          manage_invites: false,
          manage_gateway_key: false,
          start_model_tasks: false,
        },
        denial_reason: "ORG_MEMBERSHIP_INACTIVE",
      },
    });

    await waitFor(() => expect(onForbidden).toHaveBeenCalledTimes(1));
    expect(orgMeCalls).toBe(1);
    expect(memberCalls).toBe(0);

    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(orgMeCalls).toBe(2));
    expect(memberCalls).toBe(0);
  });

  it("refetches org/me and members on focus for an allowed EE member page", async () => {
    let orgMeCalls = 0;
    let memberCalls = 0;
    renderMembers({
      onOrgMeRequest: () => {
        orgMeCalls += 1;
      },
    });
    server.use(
      http.get("*/api/v1/org/members", () => {
        memberCalls += 1;
        return HttpResponse.json([member], { headers: { "X-Total-Count": "1" } });
      }),
    );

    await screen.findByText("alice");
    expect(orgMeCalls).toBe(1);
    expect(memberCalls).toBe(1);

    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await waitFor(() => expect(orgMeCalls).toBe(2));
    await waitFor(() => expect(memberCalls).toBe(2));
  });

  it.each([
    [
      "organization updated_at is missing",
      {
        ...orgMe,
        organization: {
          org_id: "org-1",
          name: "Acme",
          status: "active",
        },
      },
    ],
    [
      "membership updated_at is missing",
      {
        ...orgMe,
        membership: {
          role: "org_admin",
          membership_status: "active",
        },
      },
    ],
    [
      "organization org_id is empty",
      {
        ...orgMe,
        organization: { ...orgMe.organization, org_id: "" },
      },
    ],
    [
      "organization updated_at is not a string",
      {
        ...orgMe,
        organization: { ...orgMe.organization, updated_at: 123 },
      },
    ],
  ])("fail-closes incomplete access snapshot when %s", async (_name, orgMeResponse) => {
    let memberCalls = 0;
    const onForbidden = vi.fn();
    server.use(
      http.get("*/api/v1/org/members", () => {
        memberCalls += 1;
        return HttpResponse.json([], { headers: { "X-Total-Count": "0" } });
      }),
    );

    renderMembers({ onForbidden, orgMeResponse });

    await waitFor(() => expect(onForbidden).toHaveBeenCalledTimes(1));
    expect(memberCalls).toBe(0);
    expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Batch add" })).not.toBeInTheDocument();
  });

  it(
    "clears inactive add fields and removes passwords from DOM and mutation cache",
    async () => {
    const requests: Array<{ body: unknown; key: string | null }> = [];
    const { client } = renderMembers();
    server.use(
      http.post("*/api/v1/org/members", async ({ request }) => {
        requests.push({
          body: await request.json(),
          key: request.headers.get("Idempotency-Key"),
        });
        return HttpResponse.json({ ...member, username: "new_user" }, { status: 201 });
      }),
    );
    await screen.findByText("alice");

    await userEvent.click(screen.getByRole("button", { name: "Add member" }));
    await userEvent.click(screen.getByRole("tab", { name: "Create account" }));
    await userEvent.type(screen.getByLabelText("Username"), "new_user");
    await userEvent.type(screen.getByLabelText("Password"), "Secret-pass-123");
    await userEvent.click(screen.getByRole("tab", { name: "Existing user" }));
    await userEvent.click(screen.getByRole("tab", { name: "Create account" }));
    expect(screen.getByLabelText("Password")).toHaveValue("");

    await userEvent.type(screen.getByLabelText("Username"), "new_user");
    await userEvent.type(screen.getByLabelText("Password"), "Secret-pass-123");
    await userEvent.click(screen.getByRole("button", { name: "Create and add" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].key).toMatch(/^member-/);
    await waitFor(() =>
      expect(screen.queryByDisplayValue("Secret-pass-123")).not.toBeInTheDocument(),
    );
    expect(JSON.stringify(client.getMutationCache().getAll())).not.toContain(
      "Secret-pass-123",
    );
    },
  );

  it("uses stable batch ids and renders stable per-item status without raw messages", async () => {
    renderMembers();
    server.use(
      http.post("*/api/v1/org/members/batch", async ({ request }) => {
        const body = (await request.json()) as {
          items: Array<{ client_item_id: string }>;
        };
        return HttpResponse.json({
          accepted_count: 1,
          rejected_count: 1,
          items: [
            { client_item_id: body.items[0].client_item_id, status: "existing" },
            {
              client_item_id: body.items[1].client_item_id,
              status: "rejected",
              code: "ORG_USER_HAS_CURRENT_ORG",
              message: "SQL DSN token password canary",
            },
          ],
        });
      }),
    );
    await screen.findByText("alice");
    await userEvent.click(screen.getByRole("button", { name: "Batch add" }));
    fireEvent.change(screen.getByLabelText("Batch member rows"), {
      target: { value: "existing|user-1\ncreate|new_user|Secret-pass-123" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Preview rows" }));
    expect(screen.getByText("row-001")).toBeVisible();
    expect(screen.getByText("row-002")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Submit batch" }));

    expect(await screen.findByText("Already exists")).toBeVisible();
    expect(screen.getByText("Rejected")).toBeVisible();
    expect(document.body.textContent).not.toContain("SQL DSN token password canary");
    expect(document.body.textContent).not.toContain("Secret-pass-123");
  });

  it("removes a valid batch password from the preview DOM but still submits it", async () => {
    const passwordCanary = "PASSWORD-BATCH-CANARY";
    const backendCanary = "BACKEND-BATCH-MESSAGE-CANARY";
    const requests: unknown[] = [];
    const consoleValues: unknown[][] = [];
    const consoleSpies = ["log", "warn", "error"].map((method) =>
      vi
        .spyOn(console, method as "log" | "warn" | "error")
        .mockImplementation((...values: unknown[]) => {
          consoleValues.push(values);
        }),
    );
    const { client } = renderMembers();
    server.use(
      http.post("*/api/v1/org/members/batch", async ({ request }) => {
        const body = await request.json();
        requests.push(body);
        return HttpResponse.json({
          accepted_count: 0,
          rejected_count: 1,
          items: [
            {
              client_item_id: "row-001",
              status: "rejected",
              code: "ORG_USER_HAS_CURRENT_ORG",
              message: backendCanary,
            },
          ],
        });
      }),
    );

    try {
      await screen.findByText("alice");
      await userEvent.click(screen.getByRole("button", { name: "Batch add" }));
      fireEvent.change(screen.getByLabelText("Batch member rows"), {
        target: { value: `create|new_user|${passwordCanary}` },
      });
      await userEvent.click(screen.getByRole("button", { name: "Preview rows" }));

      expect(screen.queryByDisplayValue(passwordCanary)).not.toBeInTheDocument();
      expect(
        (screen.queryByLabelText("Batch member rows") as HTMLTextAreaElement | null)?.value ??
          "",
      ).not.toContain(passwordCanary);
      expect(document.body.textContent).not.toContain(passwordCanary);
      expect(screen.getByText("row-001")).toBeVisible();
      expect(screen.getByText("new_user")).toBeVisible();

      await userEvent.click(screen.getByRole("button", { name: "Submit batch" }));
      await waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0]).toEqual({
        items: [
          {
            client_item_id: "row-001",
            mode: "create",
            username: "new_user",
            password: passwordCanary,
          },
        ],
      });
      expect(await screen.findByText("Rejected")).toBeVisible();

      const publicState = JSON.stringify({
        dom: document.body.textContent,
        queryCache: client.getQueryCache().getAll(),
        mutationCache: client.getMutationCache().getAll(),
        localStorage: { ...localStorage },
        sessionStorage: { ...sessionStorage },
        consoleValues,
      });
      expect(publicState).not.toContain(passwordCanary);
      expect(publicState).not.toContain(backendCanary);
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it("uses updated_at and protects the last active admin", async () => {
    renderMembers();
    await screen.findByText("alice");
    await userEvent.click(
      within(screen.getByRole("row", { name: /alice/ })).getByRole("button", {
        name: "Change member",
      }),
    );
    expect(
      await screen.findByText("Last active administrator is protected."),
    ).toBeVisible();
    expect(await screen.findByRole("menuitem", { name: "Demote to member" })).toHaveAttribute(
      "data-disabled",
      "",
    );
    expect(screen.getByRole("menuitem", { name: "Suspend" })).toHaveAttribute(
      "data-disabled",
      "",
    );
    expect(screen.getByRole("menuitem", { name: "Remove" })).toHaveAttribute(
      "data-disabled",
      "",
    );
  });

  it("fail-closes every write when the member page contains a phantom admin", async () => {
    let postCalls = 0;
    let patchCalls = 0;
    renderMembers();
    server.use(
      http.get("*/api/v1/org/members", () =>
        HttpResponse.json(
          [
            member,
            {
              role: "org_admin",
              membership_status: "active",
              model_billing_entitlement: "platform",
            },
          ],
          { headers: { "X-Total-Count": "2" } },
        ),
      ),
      http.post("*/api/v1/org/members", () => {
        postCalls += 1;
        return HttpResponse.json(member, { status: 201 });
      }),
      http.post("*/api/v1/org/members/batch", () => {
        postCalls += 1;
        return HttpResponse.json({
          accepted_count: 0,
          rejected_count: 0,
          items: [],
        });
      }),
      http.patch("*/api/v1/org/members/:userId", () => {
        patchCalls += 1;
        return HttpResponse.json(member);
      }),
    );

    await screen.findByText("alice");
    const addButton = screen.getByRole("button", { name: "Add member" });
    const batchButton = screen.getByRole("button", { name: "Batch add" });
    const changeButton = within(screen.getByRole("row", { name: /alice/ })).getByRole(
      "button",
      { name: "Refresh before editing" },
    );

    expect(addButton).toBeDisabled();
    expect(batchButton).toBeDisabled();
    expect(changeButton).toBeDisabled();
    fireEvent.click(addButton);
    fireEvent.click(batchButton);
    fireEvent.click(changeButton);
    expect(screen.queryByRole("menuitem", { name: "Demote to member" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Suspend" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remove" })).not.toBeInTheDocument();
    expect(postCalls).toBe(0);
    expect(patchCalls).toBe(0);
  });

  it.each([
    ["refresh resolves", false],
    ["refresh rejects", true],
  ])("discards stale changes when %s and sends PATCH once", async (_name, reject) => {
    const patchBodies: unknown[] = [];
    let listCalls = 0;
    const { client } = renderMembers();
    server.use(
      http.get("*/api/v1/org/members", () => {
        listCalls += 1;
        if (reject && listCalls > 1) return HttpResponse.error();
        return HttpResponse.json(
          [{ ...member, role: "org_member" }],
          { headers: { "X-Total-Count": "1" } },
        );
      }),
      http.patch("*/api/v1/org/members/user-1", async ({ request }) => {
        patchBodies.push(await request.json());
        return HttpResponse.json(
          {
            ok: false,
            error: {
              code: "ORG_CONCURRENT_MODIFICATION",
              message: "backend stale canary",
              request_id: "stale-1",
            },
          },
          { status: 409 },
        );
      }),
    );
    await screen.findByText("alice");
    const changeButton = screen.getByRole("button", { name: "Change member" });
    await userEvent.click(changeButton);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Promote to administrator" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(listCalls).toBeGreaterThan(1));
    const staleConfirm = screen.queryByRole("button", { name: "Confirm" });
    if (staleConfirm) await userEvent.click(staleConfirm);
    expect(patchBodies).toEqual([
      { role: "org_admin", expected_updated_at: "old-version" },
    ]);
    const mutations = client.getMutationCache().getAll();
    expect(mutations).toHaveLength(1);
    expect(mutations[0].state.status).toBe("error");
    expect(mutations[0].state.isPaused).toBe(false);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
    await waitFor(() => expect(changeButton).toHaveFocus());
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(
      "old-version",
    );
    expect(document.body.textContent).not.toContain("backend stale canary");
  });

  it("on a members 403 clears only org cache and returns to overview", async () => {
    const onForbidden = vi.fn();
    const { client } = renderMembers({ onForbidden });
    client.setQueryData(["projects"], ["keep-me"]);
    server.use(
      http.get("*/api/v1/org/members", () =>
        HttpResponse.json(
          {
            ok: false,
            error: {
              code: "ORG_ADMIN_REQUIRED",
              message: "backend forbidden canary",
              request_id: "forbidden-1",
            },
          },
          { status: 403 },
        ),
      ),
    );

    await waitFor(() => expect(onForbidden).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(client.getQueryData(["org", "members"])).toBeUndefined());
    expect(client.getQueryData(["projects"])).toEqual(["keep-me"]);
    expect(document.body.textContent).not.toContain("backend forbidden canary");
  });
});
