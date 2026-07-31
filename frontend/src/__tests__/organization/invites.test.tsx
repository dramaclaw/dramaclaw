// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";
import { OrganizationInvites } from "@/components/organization/organization-invites";

const labels: Record<string, string> = {
  "organization.invites.title": "Invitations",
  "organization.invites.loading": "Loading invitations",
  "organization.invites.returning": "Returning to organization",
  "organization.invites.empty": "No invitations",
  "organization.invites.create": "Create invitation",
  "organization.invites.target": "Username",
  "organization.invites.submit": "Create",
  "organization.invites.copy": "Copy link",
  "organization.invites.closeSecret": "Done",
  "organization.invites.secretUnavailableTitle": "Invitation created",
  "organization.invites.secretUnavailableDescription": "The link cannot be shown again.",
  "organization.invites.revoke": "Revoke",
  "organization.invites.confirmRevoke": "Confirm revoke",
  "organization.invites.previous": "Previous",
  "organization.invites.next": "Next",
  "organization.retry": "Retry",
  "organization.errors.generic": "Organization request failed",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number }) =>
      values?.count === undefined ? (labels[key] ?? key) : `${labels[key] ?? key} ${values.count}`,
    i18n: { language: "en" },
  }),
}));

const admin = {
  user: { user_id: "user-1", username: "alice", model_billing_entitlement: "platform" },
  organization: {
    org_id: "org-1",
    name: "Acme",
    status: "active",
    updated_at: "2026-07-30T00:00:00Z",
  },
  membership: {
    role: "org_admin",
    membership_status: "active",
    updated_at: "2026-07-30T00:00:00Z",
  },
  capabilities: { manage_members: true, manage_invites: true },
};

function renderInvites(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const onForbidden = vi.fn();
  const onParamsChange = vi.fn();
  const result = render(
    <QueryClientProvider client={client}>
      <OrganizationInvites params={{ limit: 20, offset: 0 }} {...{ onForbidden, onParamsChange }} />
    </QueryClientProvider>,
  );
  return { client, onForbidden, onParamsChange, ...result };
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  localStorage.clear();
  sessionStorage.clear();
});

describe("organization invitations", () => {
  it.each([
    ["missing org id", { ...admin, organization: { ...admin.organization, org_id: "" } }],
    ["missing org version", { ...admin, organization: { ...admin.organization, updated_at: null } }],
    ["missing membership version", { ...admin, membership: { ...admin.membership, updated_at: null } }],
    ["capability deny", { ...admin, capabilities: { ...admin.capabilities, manage_invites: false } }],
    ["unknown capability", { ...admin, capabilities: { ...admin.capabilities, manage_invites: "yes" } }],
  ])("fails closed before list or writes for %s", async (_name, orgMe) => {
    let inviteRequests = 0;
    server.use(
      http.get("*/api/v1/org/me", () => HttpResponse.json(orgMe)),
      http.all("*/api/v1/org/invites*", () => {
        inviteRequests += 1;
        return HttpResponse.json([]);
      }),
    );

    const { onForbidden } = renderInvites();

    await waitFor(() => expect(onForbidden).toHaveBeenCalledTimes(1));
    expect(inviteRequests).toBe(0);
    expect(screen.queryByRole("button", { name: "Create invitation" })).not.toBeInTheDocument();
  });

  it("renders loading, empty, total-count pagination and refreshes on focus", async () => {
    let listRequests = 0;
    server.use(
      http.get("*/api/v1/org/me", () => HttpResponse.json(admin)),
      http.get("*/api/v1/org/invites", () => {
        listRequests += 1;
        return HttpResponse.json([], { headers: { "X-Total-Count": "21" } });
      }),
    );

    const { onParamsChange } = renderInvites();
    expect(screen.getByRole("status", { name: "Loading invitations" })).toBeVisible();
    expect(await screen.findByText("No invitations")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onParamsChange).toHaveBeenCalledWith(expect.objectContaining({ offset: 20 }));

    expect(listRequests).toBe(1);
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(listRequests).toBe(2));
  });

  it("keeps the one-time token only in local DOM until copied and closed", async () => {
    const token = "RAW-TOKEN-CANARY";
    let createKey = "";
    server.use(
      http.get("*/api/v1/org/me", () => HttpResponse.json(admin)),
      http.get("*/api/v1/org/invites", () =>
        HttpResponse.json([], { headers: { "X-Total-Count": "0" } }),
      ),
      http.post("*/api/v1/org/invites", async ({ request }) => {
        createKey = request.headers.get("Idempotency-Key") ?? "";
        return HttpResponse.json(
          {
            invite: {
              invite_id: "invite-1",
              target_masked: "a***e",
              status: "pending",
              expires_at: "2026-07-31T00:00:00Z",
            },
            token,
          },
          { status: 201 },
        );
      }),
    );
    const { client } = renderInvites();

    await userEvent.click(await screen.findByRole("button", { name: "Create invitation" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Username" }), "alice");
    await userEvent.dblClick(screen.getByRole("button", { name: "Create" }));

    const expected = `${window.location.origin}/invite/${encodeURIComponent(token)}`;
    expect(await screen.findByText(expected)).toBeVisible();
    expect(createKey).toMatch(/^invite-/);
    await userEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expected);
    expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain(token);
    expect(JSON.stringify(client.getMutationCache().getAll())).not.toContain(token);
    expect(localStorage.getItem("invite")).toBeNull();
    expect(sessionStorage.getItem("invite")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(document.body.textContent).not.toContain(token);
  });

  it("uses a new key and immutable body for each user submission after a request settles", async () => {
    const keys: string[] = [];
    const bodies: unknown[] = [];
    let attempts = 0;
    server.use(
      http.get("*/api/v1/org/me", () => HttpResponse.json(admin)),
      http.get("*/api/v1/org/invites", () =>
        HttpResponse.json([], { headers: { "X-Total-Count": "0" } }),
      ),
      http.post("*/api/v1/org/invites", async ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key") ?? "");
        bodies.push(await request.json());
        attempts += 1;
        if (attempts === 1) return HttpResponse.error();
        return HttpResponse.json({
          invite: {
            invite_id: `invite-${attempts}`,
            target_masked: "a***e",
            status: "pending",
            expires_at: "2026-07-31T00:00:00Z",
          },
          token: null,
        }, { status: 201 });
      }),
    );
    renderInvites();

    await userEvent.click(await screen.findByRole("button", { name: "Create invitation" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Username" }), "alice");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByRole("alert");
    expect(keys).toHaveLength(1);

    await userEvent.clear(screen.getByRole("textbox", { name: "Username" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Username" }), "bob");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
    expect(bodies).toEqual([
      { target_username: "alice", expires_in_hours: 24 },
      { target_username: "bob", expires_in_hours: 24 },
    ]);
  });

  it("shows a safe replay terminal when create succeeds without a one-time token", async () => {
    server.use(
      http.get("*/api/v1/org/me", () => HttpResponse.json(admin)),
      http.get("*/api/v1/org/invites", () =>
        HttpResponse.json([], { headers: { "X-Total-Count": "0" } }),
      ),
      http.post("*/api/v1/org/invites", () => HttpResponse.json({
        invite: {
          invite_id: "invite-replay",
          target_masked: "a***e",
          status: "pending",
          expires_at: "2026-07-31T00:00:00Z",
        },
        token: null,
      }, { status: 201 })),
    );
    renderInvites();

    await userEvent.click(await screen.findByRole("button", { name: "Create invitation" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Username" }), "alice");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("Invitation created")).toBeVisible();
    expect(screen.getByText("The link cannot be shown again.")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Username" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
  });

  it("clears only organization cache and returns safely on a forbidden list", async () => {
    server.use(
      http.get("*/api/v1/org/me", () => HttpResponse.json(admin)),
      http.get("*/api/v1/org/invites", () =>
        HttpResponse.json({ ok: false, error: { code: "ORG_ADMIN_REQUIRED", message: "Bearer SQL CANARY", request_id: "r-1" } }, { status: 403 }),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["projects"], "keep");
    client.setQueryData(["org", "members"], "remove");
    const { onForbidden } = renderInvites(client);

    await waitFor(() => expect(onForbidden).toHaveBeenCalledTimes(1));
    expect(client.getQueryData(["projects"])).toBe("keep");
    expect(client.getQueryData(["org", "members"])).toBeUndefined();
    expect(document.body.textContent).not.toContain("Bearer SQL CANARY");
  });

  it("converges org-me 403 through one organization-only cleanup", async () => {
    server.use(http.get("*/api/v1/org/me", () =>
      HttpResponse.json({ ok: false, error: { code: "ORG_ADMIN_REQUIRED", message: "CANARY", request_id: "r-1" } }, { status: 403 }),
    ));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["projects"], "keep");
    client.setQueryData(["org", "members"], "remove");
    const { onForbidden } = renderInvites(client);

    await waitFor(() => expect(onForbidden).toHaveBeenCalledTimes(1));
    expect(client.getQueryData(["org", "members"])).toBeUndefined();
    expect(client.getQueryData(["projects"])).toBe("keep");
  });

  it("converges a background org-me 403 even while the old admin data remains cached", async () => {
    const canary = "SQL DSN Bearer RAW-TOKEN-CANARY";
    let orgMeRequests = 0;
    let listRequests = 0;
    let writeRequests = 0;
    server.use(
      http.get("*/api/v1/org/me", () => {
        orgMeRequests += 1;
        if (orgMeRequests === 1) return HttpResponse.json(admin);
        return HttpResponse.json({
          ok: false,
          error: {
            code: "ORG_ADMIN_REQUIRED",
            message: canary,
            request_id: "r-background-403",
          },
        }, { status: 403 });
      }),
      http.get("*/api/v1/org/invites", () => {
        listRequests += 1;
        return HttpResponse.json([], { headers: { "X-Total-Count": "0" } });
      }),
      http.post("*/api/v1/org/invites", () => {
        writeRequests += 1;
        return HttpResponse.json({});
      }),
      http.delete("*/api/v1/org/invites/*", () => {
        writeRequests += 1;
        return HttpResponse.json({});
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["org", "members"], "remove");
    client.setQueryData(["org", "transient"], "remove");
    client.setQueryData(["projects"], "keep-projects");
    client.setQueryData(["unrelated"], "keep-unrelated");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const { onForbidden } = renderInvites(client);
      expect(await screen.findByText("No invitations")).toBeVisible();
      expect(orgMeRequests).toBe(1);
      expect(listRequests).toBe(1);

      await userEvent.click(screen.getByRole("button", { name: "Create invitation" }));
      await userEvent.type(screen.getByRole("textbox", { name: "Username" }), "transient-user");

      focusManager.setFocused(false);
      focusManager.setFocused(true);

      await waitFor(() => expect(orgMeRequests).toBe(2));
      await waitFor(() => expect(onForbidden).toHaveBeenCalledTimes(1));
      expect(client.getQueryData(["org", "me"])).toBeUndefined();
      expect(client.getQueryData(["org", "members"])).toBeUndefined();
      expect(client.getQueryData(["org", "transient"])).toBeUndefined();
      expect(client.getQueryData(["projects"])).toBe("keep-projects");
      expect(client.getQueryData(["unrelated"])).toBe("keep-unrelated");
      expect(writeRequests).toBe(0);
      expect(screen.queryByRole("textbox", { name: "Username" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Confirm revoke" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain(canary);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(canary);
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain(canary);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it("converges create 403 through one organization-only cleanup", async () => {
    server.use(
      http.get("*/api/v1/org/me", () => HttpResponse.json(admin)),
      http.get("*/api/v1/org/invites", () =>
        HttpResponse.json([], { headers: { "X-Total-Count": "0" } }),
      ),
      http.post("*/api/v1/org/invites", () =>
        HttpResponse.json({ ok: false, error: { code: "ORG_ADMIN_REQUIRED", message: "CANARY", request_id: "r-1" } }, { status: 403 }),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["projects"], "keep");
    client.setQueryData(["org", "members"], "remove");
    const { onForbidden } = renderInvites(client);

    await userEvent.click(await screen.findByRole("button", { name: "Create invitation" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Username" }), "alice");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onForbidden).toHaveBeenCalledTimes(1));
    expect(client.getQueryData(["org", "members"])).toBeUndefined();
    expect(client.getQueryData(["projects"])).toBe("keep");
    expect(screen.queryByRole("textbox", { name: "Username" })).not.toBeInTheDocument();
  });

  it("converges revoke 403 through one organization-only cleanup", async () => {
    const row = {
      invite_id: "invite-1",
      target_masked: "a***e",
      status: "pending",
      expires_at: "2026-07-31T00:00:00Z",
    };
    server.use(
      http.get("*/api/v1/org/me", () => HttpResponse.json(admin)),
      http.get("*/api/v1/org/invites", () =>
        HttpResponse.json([row], { headers: { "X-Total-Count": "1" } }),
      ),
      http.delete("*/api/v1/org/invites/*", () =>
        HttpResponse.json({ ok: false, error: { code: "ORG_ADMIN_REQUIRED", message: "CANARY", request_id: "r-1" } }, { status: 403 }),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["projects"], "keep");
    client.setQueryData(["org", "members"], "remove");
    const { onForbidden } = renderInvites(client);

    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));

    await waitFor(() => expect(onForbidden).toHaveBeenCalledTimes(1));
    expect(client.getQueryData(["org", "members"])).toBeUndefined();
    expect(client.getQueryData(["projects"])).toBe("keep");
    expect(screen.queryByRole("button", { name: "Confirm revoke" })).not.toBeInTheDocument();
  });

  it.each([
    ["non-array items", { body: { items: [] }, total: "0" }],
    ["invalid total", { body: [], total: "NaN" }],
    ["unparseable date", { body: [{ invite_id: "i", target_masked: "a***e", status: "pending", expires_at: "not-a-date" }], total: "1" }],
    ["unknown field", { body: [{ invite_id: "i", target_masked: "a***e", status: "pending", expires_at: "2026-07-31T00:00:00Z", secret: "CANARY" }], total: "1" }],
  ])("fails closed for malformed list DTO: %s", async (_name, value) => {
    server.use(
      http.get("*/api/v1/org/me", () => HttpResponse.json(admin)),
      http.get("*/api/v1/org/invites", () =>
        HttpResponse.json(value.body, { headers: { "X-Total-Count": value.total } }),
      ),
    );
    renderInvites();

    expect(await screen.findByText("Organization request failed")).toBeVisible();
    expect(document.body.textContent).not.toContain("CANARY");
  });

  it("keeps a malformed invite list out of the query cache", async () => {
    const canary = "DTO-CANARY";
    let writeRequests = 0;
    server.use(
      http.get("*/api/v1/org/me", () => HttpResponse.json(admin)),
      http.get("*/api/v1/org/invites", () =>
        HttpResponse.json(
          [{
            invite_id: "invite-malformed",
            target_masked: "a***e",
            status: "pending",
            expires_at: "2026-07-31T00:00:00Z",
            secret: canary,
          }],
          { headers: { "X-Total-Count": "1" } },
        ),
      ),
      http.post("*/api/v1/org/invites", () => {
        writeRequests += 1;
        return HttpResponse.json({});
      }),
      http.delete("*/api/v1/org/invites/*", () => {
        writeRequests += 1;
        return HttpResponse.json({});
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      renderInvites(client);

      expect(await screen.findByText("Organization request failed")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Create invitation" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
      expect(writeRequests).toBe(0);

      const querySnapshot = client.getQueryCache().getAll().map((query) => ({
        queryKey: query.queryKey,
        data: query.state.data,
        error: query.state.error instanceof Error
          ? { name: query.state.error.name, message: query.state.error.message }
          : query.state.error,
      }));
      const publicErrors = client.getQueryCache().getAll().map((query) => String(query.state.error));
      const surfaces = [
        JSON.stringify(querySnapshot),
        JSON.stringify(client.getMutationCache().getAll()),
        JSON.stringify(publicErrors),
        JSON.stringify(consoleError.mock.calls),
        JSON.stringify(consoleWarn.mock.calls),
        JSON.stringify(localStorage),
        JSON.stringify(sessionStorage),
        document.body.textContent ?? "",
        document.body.innerHTML,
      ].join("\n");
      expect(surfaces).not.toContain(canary);
      expect(surfaces).not.toContain('"secret"');
      expect(surfaces).not.toContain("invite-malformed");
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it.each([
    ["0", []],
    [
      String(Number.MAX_SAFE_INTEGER),
      [{
        invite_id: "invite-safe-total",
        target_masked: "s***e",
        status: "pending",
        expires_at: "2026-07-31T00:00:00Z",
      }],
    ],
  ])("accepts safe integer X-Total-Count %s", async (total, body) => {
    server.use(
      http.get("*/api/v1/org/me", () => HttpResponse.json(admin)),
      http.get("*/api/v1/org/invites", () =>
        HttpResponse.json(body, { headers: { "X-Total-Count": total } }),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderInvites(client);

    if (body.length === 0) {
      expect(await screen.findByText("No invitations")).toBeVisible();
    } else {
      expect(await screen.findByText("s***e")).toBeVisible();
    }
    const inviteQuery = client.getQueryCache().getAll().find(
      (query) => query.queryKey[0] === "org" && query.queryKey[1] === "invites",
    );
    expect(inviteQuery?.state.status).toBe("success");
    expect(inviteQuery?.state.data).toEqual({
      items: body,
      total: Number(total),
    });
  });

  it.each([
    "9007199254740992",
    "9007199254740993",
    "9".repeat(400),
  ])("rejects unsafe X-Total-Count %s before query cache", async (total) => {
    const responseCanary = "unsafe-total-response-canary";
    const roundedUnsafeTotal = "9007199254740992";
    let createRequests = 0;
    let revokeRequests = 0;
    const body = [{
      invite_id: responseCanary,
      target_masked: "u***e",
      status: "pending",
      expires_at: "2026-07-31T00:00:00Z",
    }];
    server.use(
      http.get("*/api/v1/org/me", () => HttpResponse.json(admin)),
      http.get("*/api/v1/org/invites", () =>
        HttpResponse.json(body, { headers: { "X-Total-Count": total } }),
      ),
      http.post("*/api/v1/org/invites", () => {
        createRequests += 1;
        return HttpResponse.json({});
      }),
      http.delete("*/api/v1/org/invites/*", () => {
        revokeRequests += 1;
        return HttpResponse.json({});
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      renderInvites(client);

      expect(await screen.findByText("Organization request failed")).toBeVisible();
      expect(screen.queryByText("u***e")).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain(roundedUnsafeTotal);
      expect(createRequests).toBe(0);
      expect(revokeRequests).toBe(0);

      const inviteQuery = client.getQueryCache().getAll().find(
        (query) => query.queryKey[0] === "org" && query.queryKey[1] === "invites",
      );
      expect(inviteQuery?.state.status).toBe("error");
      expect(inviteQuery?.state.data).toBeUndefined();

      const querySnapshot = client.getQueryCache().getAll().map((query) => ({
        queryKey: query.queryKey,
        data: query.state.data,
        error: query.state.error instanceof Error
          ? { name: query.state.error.name, message: query.state.error.message }
          : query.state.error,
      }));
      const publicErrors = client.getQueryCache().getAll().map((query) => String(query.state.error));
      const surfaces = [
        JSON.stringify(querySnapshot),
        JSON.stringify(client.getMutationCache().getAll()),
        JSON.stringify(publicErrors),
        JSON.stringify(consoleError.mock.calls),
        JSON.stringify(consoleWarn.mock.calls),
        JSON.stringify(localStorage),
        JSON.stringify(sessionStorage),
        document.body.textContent ?? "",
        document.body.innerHTML,
      ].join("\n");
      expect(surfaces).not.toContain(responseCanary);
      expect(surfaces).not.toContain("u***e");
      expect(surfaces).not.toContain(roundedUnsafeTotal);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it("closes create writes and fails closed for a malformed create success DTO", async () => {
    server.use(
      http.get("*/api/v1/org/me", () => HttpResponse.json(admin)),
      http.get("*/api/v1/org/invites", () =>
        HttpResponse.json([], { headers: { "X-Total-Count": "0" } }),
      ),
      http.post("*/api/v1/org/invites", () => HttpResponse.json({
        invite: {
          invite_id: "invite-1",
          target_masked: "a***e",
          status: "pending",
          expires_at: "not-a-date",
          secret: "CANARY",
        },
        token: { raw: "CANARY" },
      }, { status: 201 })),
    );
    renderInvites();

    await userEvent.click(await screen.findByRole("button", { name: "Create invitation" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Username" }), "alice");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("Organization request failed")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Username" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("CANARY");
  });

  it("closes revoke writes and fails closed for a malformed revoke success DTO", async () => {
    const row = {
      invite_id: "invite-1",
      target_masked: "a***e",
      status: "pending",
      expires_at: "2026-07-31T00:00:00Z",
    };
    server.use(
      http.get("*/api/v1/org/me", () => HttpResponse.json(admin)),
      http.get("*/api/v1/org/invites", () =>
        HttpResponse.json([row], { headers: { "X-Total-Count": "1" } }),
      ),
      http.delete("*/api/v1/org/invites/*", () =>
        HttpResponse.json({ ...row, role: "org_admin", secret: "CANARY" }),
      ),
    );
    renderInvites();

    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));

    expect(await screen.findByText("Organization request failed")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm revoke" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("CANARY");
  });

  it("encodes revoke IDs and invalidates only invites and org-me", async () => {
    let revokePath = "";
    const row = {
      invite_id: "invite/with/slash",
      target_masked: "a***e",
      status: "pending",
      expires_at: "2026-07-31T00:00:00Z",
    };
    server.use(
      http.get("*/api/v1/org/me", () => HttpResponse.json(admin)),
      http.get("*/api/v1/org/invites", () =>
        HttpResponse.json([row], { headers: { "X-Total-Count": "1" } }),
      ),
      http.delete("*/api/v1/org/invites/*", ({ request }) => {
        revokePath = new URL(request.url).pathname;
        return HttpResponse.json({ ...row, status: "revoked" });
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["projects"], "keep");
    client.setQueryData(["org", "members"], "keep-members");
    const invalidations = vi.spyOn(client, "invalidateQueries");
    renderInvites(client);

    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));

    await waitFor(() => expect(revokePath).toContain("invite%2Fwith%2Fslash"));
    expect(invalidations).toHaveBeenCalledWith({ queryKey: ["org", "me"] });
    expect(invalidations).toHaveBeenCalledWith({ queryKey: ["org", "invites"] });
    expect(client.getQueryData(["projects"])).toBe("keep");
    expect(client.getQueryData(["org", "members"])).toBe("keep-members");
  });
});
