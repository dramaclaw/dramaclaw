// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";
import { OrganizationGatewayKey } from "@/components/organization/organization-gateway-key";

const labels: Record<string, string> = {
  "organization.gatewayKey.title": "Gateway key",
  "organization.gatewayKey.loading": "Loading gateway key",
  "organization.gatewayKey.returning": "Permissions changed",
  "organization.gatewayKey.retry": "Retry",
  "organization.gatewayKey.state.never_configured": "Never configured",
  "organization.gatewayKey.state.active": "Active",
  "organization.gatewayKey.state.no_active": "No active key",
  "organization.gatewayKey.state.validating": "Validating",
  "organization.gatewayKey.state.validation_failed": "Validation failed",
  "organization.gatewayKey.input": "Gateway key value",
  "organization.gatewayKey.bind": "Bind key",
  "organization.gatewayKey.replace": "Replace key",
  "organization.gatewayKey.unbind": "Unbind key",
  "organization.gatewayKey.confirm.bindTitle": "Confirm binding",
  "organization.gatewayKey.confirm.replaceTitle": "Confirm replacement",
  "organization.gatewayKey.confirm.unbindTitle": "Confirm unbind",
  "organization.gatewayKey.confirm.versionBoundary": "New tasks use the new version; admitted tasks keep the old version.",
  "organization.gatewayKey.confirm.noFallback": "There is no platform key fallback.",
  "organization.gatewayKey.confirm.cancel": "Cancel",
  "organization.gatewayKey.confirm.submit": "Confirm",
  "organization.gatewayKey.errors.generic": "Gateway key request failed",
  "organization.gatewayKey.errors.conflict": "Gateway key state changed",
  "organization.gatewayKey.errors.validation": "Gateway key validation failed",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => labels[key] ?? key }),
}));

const admin = {
  user: { user_id: "user-1", username: "alice", model_billing_entitlement: "platform" },
  organization: {
    org_id: "org-1",
    name: "Acme",
    status: "active",
    updated_at: "2026-08-02T00:00:00Z",
  },
  membership: {
    role: "org_admin",
    membership_status: "active",
    updated_at: "2026-08-02T00:00:00Z",
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

function renderGateway(client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
})) {
  const rendered = render(
    <QueryClientProvider client={client}>
      <OrganizationGatewayKey onForbidden={vi.fn()} />
    </QueryClientProvider>,
  );
  return { ...rendered, client };
}

function installOrgMe(body: Parameters<typeof HttpResponse.json>[0] = admin) {
  server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(body)));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  installOrgMe();
});

describe("organization gateway key", () => {
  it.each([
    ["never_configured", null, "Never configured", "Bind key"],
    ["active", 3, "Active", "Replace key"],
    ["no_active", 3, "No active key", "Bind key"],
  ])("renders server state %s", async (state, version, stateLabel, actionLabel) => {
    server.use(http.get("*/api/v1/org/gateway/key/status", () => HttpResponse.json({
      state,
      key_version: version,
      verified_at: state === "never_configured" ? null : "2026-08-02T00:00:00Z",
      updated_at: state === "never_configured" ? null : "2026-08-02T00:00:00Z",
    })));
    renderGateway();

    expect(await screen.findByText(stateLabel)).toBeVisible();
    expect(screen.getByRole("button", { name: actionLabel })).toBeVisible();
  });

  it.each([
    ["active without version", { state: "active", key_version: null }],
    ["never configured with version", { state: "never_configured", key_version: 3 }],
    ["no active without version", { state: "no_active", key_version: null }],
  ])("fails closed for malformed summary: %s", async (_name, gatewayKey) => {
    let statusGets = 0;
    let puts = 0;
    let deletes = 0;
    const deleteBodies: unknown[] = [];
    installOrgMe({ ...admin, gateway_key: gatewayKey });
    server.use(
      http.get("*/api/v1/org/gateway/key/status", () => {
        statusGets += 1;
        return HttpResponse.json({
          ...gatewayKey,
          verified_at: gatewayKey.state === "never_configured"
            ? null
            : "2026-08-02T00:00:00Z",
          updated_at: gatewayKey.state === "never_configured"
            ? null
            : "2026-08-02T00:00:00Z",
        });
      }),
      http.put("*/api/v1/org/gateway/key", () => {
        puts += 1;
        return HttpResponse.json({
          state: "active",
          key_version: 4,
          verified_at: "2026-08-02T00:00:00Z",
          updated_at: "2026-08-02T00:00:00Z",
        });
      }),
      http.delete("*/api/v1/org/gateway/key", async ({ request }) => {
        deletes += 1;
        deleteBodies.push(await request.json());
        return HttpResponse.json({
          state: "no_active",
          key_version: 3,
          verified_at: "2026-08-02T00:00:00Z",
          updated_at: "2026-08-02T00:00:00Z",
        });
      }),
    );
    const user = userEvent.setup();
    renderGateway();

    await waitFor(() => {
      expect(
        screen.queryByText("Permissions changed") ??
          screen.queryByLabelText("Gateway key value"),
      ).not.toBeNull();
    });
    const unbind = screen.queryByRole("button", { name: "Unbind key" });
    if (unbind) {
      await user.click(unbind);
      await user.click(screen.getByRole("button", { name: "Confirm" }));
    } else {
      const input = screen.queryByLabelText("Gateway key value");
      const bind = screen.queryByRole("button", { name: "Bind key" });
      if (input && bind) {
        await user.type(input, "BT10D-MALFORMED-SUMMARY-KEY-CANARY");
        await user.click(bind);
        await user.click(screen.getByRole("button", { name: "Confirm" }));
      }
    }
    fireEvent.keyDown(document.body, { key: "Enter" });

    await waitFor(() => {
      expect({ statusGets, puts, deletes, deleteBodies }).toEqual({
        statusGets: 0,
        puts: 0,
        deletes: 0,
        deleteBodies: [],
      });
    });
    expect(screen.queryByRole("button", { name: "Replace key" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unbind key" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bind key" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("BT10D-MALFORMED-SUMMARY-KEY-CANARY");
  });

  it("binds once with the current version and clears the raw key from every client sink", async () => {
    const rawKey = "BT10D-RAW-KEY-CANARY";
    let puts = 0;
    server.use(
      http.get("*/api/v1/org/gateway/key/status", () => HttpResponse.json({
        state: "never_configured", key_version: null, verified_at: null, updated_at: null,
      })),
      http.put("*/api/v1/org/gateway/key", async ({ request }) => {
        puts += 1;
        expect(request.headers.get("Idempotency-Key")).toBeTruthy();
        expect(await request.json()).toEqual({ gateway_key: rawKey, expected_key_version: null });
        await delay(50);
        return HttpResponse.json({
          state: "active", key_version: 1,
          verified_at: "2026-08-02T00:00:00Z", updated_at: "2026-08-02T00:00:00Z",
        });
      }),
    );
    const user = userEvent.setup();
    const { client } = renderGateway();
    const input = await screen.findByLabelText("Gateway key value");
    await user.type(input, `  ${rawKey}  `);
    await user.click(screen.getByRole("button", { name: "Bind key" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("Validating")).toBeVisible();
    expect(screen.getByRole("button", { name: "Bind key" })).toBeDisabled();
    await waitFor(() => expect(puts).toBe(1));
    await waitFor(() => expect(screen.queryByDisplayValue(/BT10D/)).not.toBeInTheDocument());
    expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain(rawKey);
    expect(JSON.stringify(client.getMutationCache().getAll())).not.toContain(rawKey);
    expect(JSON.stringify(localStorage)).not.toContain(rawKey);
    expect(JSON.stringify(sessionStorage)).not.toContain(rawKey);
    expect(document.body.textContent).not.toContain(rawKey);
  });

  it("does not replay a conflicting replacement and clears confirmation and key", async () => {
    const rawKey = "BT10D-CONFLICT-KEY-CANARY";
    let puts = 0;
    let gets = 0;
    server.use(
      http.get("*/api/v1/org/gateway/key/status", () => {
        gets += 1;
        return HttpResponse.json({
          state: "active", key_version: 3,
          verified_at: "2026-08-02T00:00:00Z", updated_at: "2026-08-02T00:00:00Z",
        });
      }),
      http.put("*/api/v1/org/gateway/key", () => {
        puts += 1;
        return HttpResponse.json({
          ok: false,
          error: { code: "ORG_CREDENTIAL_VERSION_MISMATCH", message: rawKey, request_id: "conflict-1" },
        }, { status: 409 });
      }),
    );
    const user = userEvent.setup();
    const { client } = renderGateway();
    await user.type(await screen.findByLabelText("Gateway key value"), rawKey);
    await user.click(screen.getByRole("button", { name: "Replace key" }));
    expect(screen.getByText(/New tasks use the new version/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("Gateway key state changed")).toBeVisible();
    await waitFor(() => expect(gets).toBeGreaterThanOrEqual(2));
    expect(puts).toBe(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(rawKey)).not.toBeInTheDocument();
    expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain(rawKey);
    expect(JSON.stringify(client.getMutationCache().getAll())).not.toContain(rawKey);
    expect(document.body.textContent).not.toContain(rawKey);
  });

  it("unbinds once with the snapshot version and explains the no-fallback boundary", async () => {
    let deletes = 0;
    server.use(
      http.get("*/api/v1/org/gateway/key/status", () => HttpResponse.json({
        state: "active", key_version: 7,
        verified_at: "2026-08-02T00:00:00Z", updated_at: "2026-08-02T00:00:00Z",
      })),
      http.delete("*/api/v1/org/gateway/key", async ({ request }) => {
        deletes += 1;
        expect(await request.json()).toEqual({ expected_key_version: 7 });
        return HttpResponse.json({
          state: "no_active", key_version: 7,
          verified_at: "2026-08-02T00:00:00Z", updated_at: "2026-08-02T00:01:00Z",
        });
      }),
    );
    const user = userEvent.setup();
    renderGateway();
    await user.click(await screen.findByRole("button", { name: "Unbind key" }));
    expect(screen.getByText(/New tasks use the new version/)).toBeVisible();
    expect(screen.getByText(/There is no platform key fallback/)).toBeVisible();
    await user.dblClick(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("No active key")).toBeVisible();
    expect(deletes).toBe(1);
  });

  it("clears the raw input on cancel, validation failure, and unmount", async () => {
    const rawKey = "BT10D-LIFECYCLE-KEY-CANARY";
    server.use(
      http.get("*/api/v1/org/gateway/key/status", () => HttpResponse.json({
        state: "active", key_version: 3,
        verified_at: "2026-08-02T00:00:00Z", updated_at: "2026-08-02T00:00:00Z",
      })),
      http.put("*/api/v1/org/gateway/key", () => HttpResponse.json({
        ok: false,
        error: { code: "ORG_KEY_VALIDATION_FAILED", message: rawKey, request_id: "validation-1" },
      }, { status: 422 })),
    );
    const user = userEvent.setup();
    const rendered = renderGateway();
    const input = await screen.findByLabelText("Gateway key value");
    await user.type(input, rawKey);
    await user.click(screen.getByRole("button", { name: "Replace key" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByDisplayValue(rawKey)).not.toBeInTheDocument();

    await user.type(input, rawKey);
    await user.click(screen.getByRole("button", { name: "Replace key" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Gateway key validation failed")).toBeVisible();
    expect(screen.queryByDisplayValue(rawKey)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(rawKey);

    fireEvent.change(input, { target: { value: rawKey } });
    rendered.unmount();
    expect(document.body.textContent).not.toContain(rawKey);
  });
});
