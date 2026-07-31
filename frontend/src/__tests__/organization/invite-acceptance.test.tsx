// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";
import { InviteAcceptance } from "@/components/organization/invite-acceptance";

const labels: Record<string, string> = {
  "invite.loading": "Loading invitation",
  "invite.title": "Invitation",
  "invite.existing": "Use existing account",
  "invite.create": "Create account",
  "invite.username": "Username",
  "invite.password": "Password",
  "invite.accept": "Accept invitation",
  "invite.login": "Go to login",
  "invite.successExisting": "Invitation accepted",
  "invite.successCreate": "Account created. Sign in to continue.",
  "invite.errors.unavailable": "This invitation is unavailable.",
  "invite.errors.used": "This invitation was already used.",
  "invite.errors.mismatch": "This invitation cannot be accepted by this account.",
  "invite.errors.rateLimited": "Too many attempts. Try again later.",
  "invite.errors.generic": "This invitation cannot be processed.",
  "organization.retry": "Retry",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => labels[key] ?? key }),
}));

const preview = {
  org_name: "Acme",
  target_masked: "a***e",
  status: "pending",
  expires_at: "2026-07-31T00:00:00Z",
};

function renderAcceptance(token = "PATH-TOKEN-CANARY") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onExistingAccepted = vi.fn();
  const view = (nextToken: string) => (
    <QueryClientProvider client={client}>
      <InviteAcceptance token={nextToken} onExistingAccepted={onExistingAccepted} />
    </QueryClientProvider>
  );
  const result = render(view(token));
  return {
    client,
    onExistingAccepted,
    rerenderToken: (nextToken: string) => result.rerender(view(nextToken)),
    ...result,
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("public invitation acceptance", () => {
  it("previews from the encoded path token without storing token in query key or storage", async () => {
    const token = "token/with space";
    let requestUrl = "";
    server.use(http.get("*/api/v1/org/invites/*/preview", ({ request }) => {
      requestUrl = request.url;
      return HttpResponse.json(preview);
    }));
    const { client } = renderAcceptance(token);

    expect(await screen.findByText("Acme")).toBeVisible();
    expect(requestUrl).toContain(encodeURIComponent(token));
    expect(client.getQueryCache().findAll({ queryKey: ["org", "invites", "preview"] })).toHaveLength(0);
    expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain(token);
    expect(JSON.stringify(localStorage)).not.toContain(token);
    expect(JSON.stringify(sessionStorage)).not.toContain(token);
    expect(document.body.innerHTML).not.toContain(token);
  });

  it("clears preview A immediately and ignores its late result after the token changes to B", async () => {
    let resolveA!: () => void;
    const releaseA = new Promise<void>((resolve) => { resolveA = resolve; });
    server.use(http.get("*/api/v1/org/invites/*/preview", async ({ request }) => {
      if (request.url.includes("TOKEN-A")) {
        await releaseA;
        return HttpResponse.json({ ...preview, org_name: "Organization A" });
      }
      return HttpResponse.json({ ...preview, org_name: "Organization B" });
    }));
    const result = renderAcceptance("TOKEN-A");

    result.rerenderToken("TOKEN-B");
    expect(screen.getByRole("status", { name: "Loading invitation" })).toBeVisible();
    expect(screen.queryByText("Organization A")).not.toBeInTheDocument();
    expect(await screen.findByText("Organization B")).toBeVisible();

    resolveA();
    await waitFor(() => expect(screen.queryByText("Organization A")).not.toBeInTheDocument());
  });

  it.each([
    [404, "ORG_INVITE_UNAVAILABLE", "This invitation is unavailable."],
    [409, "ORG_INVITE_ALREADY_USED", "This invitation was already used."],
    [403, "ORG_INVITE_TARGET_MISMATCH", "This invitation cannot be accepted by this account."],
    [429, "ORG_RATE_LIMITED", "Too many attempts. Try again later."],
    [500, "UNKNOWN_SQL_DSN_BEARER_TOKEN", "This invitation cannot be processed."],
  ])("renders a safe terminal for %s %s", async (status, code, message) => {
    server.use(http.get("*/api/v1/org/invites/*/preview", () =>
      HttpResponse.json({ ok: false, error: { code, message: "password cookie SQL DSN Bearer CANARY", request_id: "r-1" } }, { status }),
    ));
    renderAcceptance();

    expect(await screen.findByText(message)).toBeVisible();
    expect(document.body.textContent).not.toContain("password cookie SQL DSN Bearer CANARY");
  });

  it("submits existing mode with no client-selected identity and uses the fixed organization destination", async () => {
    let body: unknown;
    server.use(
      http.get("*/api/v1/org/invites/*/preview", () => HttpResponse.json(preview)),
      http.post("*/api/v1/org/invites/*/accept", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          user_id: "user-1",
          org_id: "org-1",
          role: "org_member",
          membership_status: "active",
          model_billing_entitlement: "platform",
        });
      }),
    );
    const { onExistingAccepted } = renderAcceptance();

    await userEvent.click(await screen.findByRole("button", { name: "Use existing account" }));
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    await waitFor(() => expect(onExistingAccepted).toHaveBeenCalledWith("/organization"));
    expect(body).toEqual({ mode: "existing" });
  });

  it.each([422, 429, 500])("clears create password immediately and after a %s failure", async (status) => {
    server.use(
      http.get("*/api/v1/org/invites/*/preview", () => HttpResponse.json(preview)),
      http.post("*/api/v1/org/invites/*/accept", () =>
        HttpResponse.json({ ok: false, error: { code: status === 429 ? "ORG_RATE_LIMITED" : "ORG_REQUEST_INVALID", message: "PASSWORD-CANARY", request_id: "r-1" } }, { status }),
      ),
    );
    const { client } = renderAcceptance();

    await userEvent.click(await screen.findByRole("button", { name: "Create account" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Username" }), "alice");
    const password = screen.getByLabelText("Password");
    await userEvent.type(password, "PASSWORD-CANARY");
    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect(password).toHaveValue("");
    await screen.findByRole("alert");
    expect(document.body.textContent).not.toContain("PASSWORD-CANARY");
    expect(JSON.stringify(client.getMutationCache().getAll())).not.toContain("PASSWORD-CANARY");
    expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain("PASSWORD-CANARY");
    expect(JSON.stringify(localStorage)).not.toContain("PASSWORD-CANARY");
    expect(JSON.stringify(sessionStorage)).not.toContain("PASSWORD-CANARY");
  });

  it("clears password on mode switch and unmount", async () => {
    server.use(http.get("*/api/v1/org/invites/*/preview", () => HttpResponse.json(preview)));
    const result = renderAcceptance();

    await userEvent.click(await screen.findByRole("button", { name: "Create account" }));
    await userEvent.type(screen.getByLabelText("Password"), "PASSWORD-CANARY");
    await userEvent.click(screen.getByRole("button", { name: "Use existing account" }));
    expect(document.body.textContent).not.toContain("PASSWORD-CANARY");
    result.unmount();
    expect(document.body.textContent).not.toContain("PASSWORD-CANARY");
  });

  it("shows a fixed login entry after create success without forging a session", async () => {
    server.use(
      http.get("*/api/v1/org/invites/*/preview", () => HttpResponse.json(preview)),
      http.post("*/api/v1/org/invites/*/accept", () => HttpResponse.json({
        user_id: "user-2",
        org_id: "org-1",
        role: "org_member",
        membership_status: "active",
        model_billing_entitlement: "org_sponsored",
      })),
    );
    renderAcceptance();

    await userEvent.click(await screen.findByRole("button", { name: "Create account" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Username" }), "alice");
    await userEvent.type(screen.getByLabelText("Password"), "safe-password");
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByText("Account created. Sign in to continue.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Go to login" })).toHaveAttribute("href", "/login");
    expect(document.body.innerHTML).not.toMatch(/return|callback|https?:\/\//i);
  });

  it("uses a new key and immutable body for each user submission after a request settles", async () => {
    const keys: string[] = [];
    const bodies: unknown[] = [];
    let attempts = 0;
    server.use(
      http.get("*/api/v1/org/invites/*/preview", () => HttpResponse.json(preview)),
      http.post("*/api/v1/org/invites/*/accept", async ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key") ?? "");
        bodies.push(await request.json());
        attempts += 1;
        if (attempts === 1) return HttpResponse.error();
        return HttpResponse.json({ user_id: "u", org_id: "o", role: "org_member", membership_status: "active", model_billing_entitlement: "platform" });
      }),
    );
    renderAcceptance();
    await userEvent.click(await screen.findByRole("button", { name: "Create account" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Username" }), "alice");
    await userEvent.type(screen.getByLabelText("Password"), "password-one");
    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    await screen.findByRole("alert");
    expect(keys).toHaveLength(1);

    await userEvent.clear(screen.getByRole("textbox", { name: "Username" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Username" }), "bob");
    await userEvent.type(screen.getByLabelText("Password"), "password-two");
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByText("Account created. Sign in to continue.")).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(bodies).toEqual([
      { mode: "create", username: "alice", password: "password-one" },
      { mode: "create", username: "bob", password: "password-two" },
    ]);
  });

  it.each([
    ["unknown preview field", { ...preview, raw_token: "CANARY" }],
    ["invalid preview date", { ...preview, expires_at: "not-a-date" }],
    ["invalid preview role", { ...preview, role: "org_admin" }],
    ["invalid preview type", { ...preview, target_masked: 42 }],
  ])("fails closed for malformed preview DTO: %s", async (_name, value) => {
    server.use(http.get("*/api/v1/org/invites/*/preview", () => HttpResponse.json(value)));
    renderAcceptance();

    expect(await screen.findByText("This invitation cannot be processed.")).toBeVisible();
    expect(document.body.textContent).not.toContain("CANARY");
  });

  it.each([
    ["unknown accept field", { user_id: "u", org_id: "o", role: "org_member", membership_status: "active", model_billing_entitlement: "platform", token: "CANARY" }],
    ["invalid accept role", { user_id: "u", org_id: "o", role: "org_admin", membership_status: "active", model_billing_entitlement: "platform" }],
    ["invalid membership", { user_id: "u", org_id: "o", role: "org_member", membership_status: "pending", model_billing_entitlement: "platform" }],
    ["invalid entitlement", { user_id: "u", org_id: "o", role: "org_member", membership_status: "active", model_billing_entitlement: "root" }],
  ])("fails closed for malformed accept DTO: %s", async (_name, value) => {
    server.use(
      http.get("*/api/v1/org/invites/*/preview", () => HttpResponse.json(preview)),
      http.post("*/api/v1/org/invites/*/accept", () => HttpResponse.json(value)),
    );
    const { onExistingAccepted } = renderAcceptance();

    await userEvent.click(await screen.findByRole("button", { name: "Use existing account" }));
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByText("This invitation cannot be processed.")).toBeVisible();
    expect(onExistingAccepted).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("CANARY");
  });

  it("enters the same terminal state for a non-JSON accept 200", async () => {
    server.use(
      http.get("*/api/v1/org/invites/*/preview", () => HttpResponse.json(preview)),
      http.post("*/api/v1/org/invites/*/accept", () =>
        new HttpResponse("CANARY", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    renderAcceptance();

    await userEvent.click(await screen.findByRole("button", { name: "Use existing account" }));
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByText("This invitation cannot be processed.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("CANARY");
  });
});
