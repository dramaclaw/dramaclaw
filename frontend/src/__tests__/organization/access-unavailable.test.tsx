// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";
import { AccessUnavailable } from "@/components/organization/access-unavailable";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

const labels: Record<string, string> = {
  "organization.access.title": "Access unavailable",
  "organization.access.loading": "Loading access",
  "organization.access.retry": "Retry access",
  "organization.access.back": "Back to projects",
  "organization.access.reasons.MODEL_ACCESS_DENIED": "Model access is disabled",
  "organization.access.reasons.ORG_CREDENTIAL_MISSING": "No organization key",
  "organization.access.reasons.ORG_CREDENTIAL_DISABLED": "Organization key unavailable",
  "organization.access.reasons.ORG_MEMBERSHIP_INACTIVE": "Membership inactive",
  "organization.access.reasons.ORG_SUSPENDED": "Organization suspended",
  "organization.access.reasons.ORG_CREDENTIAL_GATEWAY_MISMATCH":
    "Gateway mismatch, ask an admin to rebind",
  "organization.access.reasons.ORG_AUTHZ_STALE": "Access changed",
  "organization.access.reasons.generic": "Access is currently unavailable",
  "organization.access.available": "Model tasks available",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => labels[key] ?? key }),
}));

const denied = {
  user: { user_id: "u1", username: "alice", model_billing_entitlement: "platform" },
  organization: {
    org_id: "o1",
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
    start_model_tasks: false,
  },
  gateway_key: { state: "never_configured", key_version: null },
  denial_reason: "ORG_CREDENTIAL_MISSING",
};

function renderPage(client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <AccessUnavailable />
      </QueryClientProvider>,
    ),
  };
}

describe("access unavailable", () => {
  beforeEach(() => focusManager.setFocused(true));

  it("shows only the stable server reason and never raw details", async () => {
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(denied)));
    renderPage();

    expect(await screen.findByText("No organization key")).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to projects" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(document.body.textContent).not.toMatch(/credential_id|provider|raw key/i);
    expect(screen.queryByText(/view existing|export existing/i)).not.toBeInTheDocument();
  });

  // A key bound against another gateway has a specific remedy (an admin has to
  // rebind it), so it must not fall through to the generic copy the way a value
  // this build has never heard of does.
  it("names a gateway mismatch instead of falling back to the generic reason", async () => {
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json({
      ...denied,
      gateway_key: { state: "gateway_mismatch", key_version: 3 },
      denial_reason: "ORG_CREDENTIAL_GATEWAY_MISMATCH",
    })));
    renderPage();

    expect(await screen.findByText("Gateway mismatch, ask an admin to rebind")).toBeVisible();
    expect(screen.queryByText("Access is currently unavailable")).not.toBeInTheDocument();
  });

  it("renders the generic message without exposing an unknown denial reason", async () => {
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json({
      ...denied,
      capabilities: { ...denied.capabilities, start_model_tasks: true },
      denial_reason: "UPSTREAM-SECRET-DENIAL",
    })));
    const { client } = renderPage();

    expect(await screen.findByText("Access is currently unavailable")).toBeVisible();
    expect(document.body.textContent).not.toContain("UPSTREAM-SECRET-DENIAL");
    expect(JSON.stringify(client.getQueryCache().getAll()))
      .not.toContain("UPSTREAM-SECRET-DENIAL");
  });

  it("recovers on focus from a denied snapshot without replaying writes", async () => {
    let requests = 0;
    server.use(http.get("*/api/v1/org/me", () => {
      requests += 1;
      return HttpResponse.json(requests === 1 ? denied : {
        ...denied,
        capabilities: { ...denied.capabilities, start_model_tasks: true },
        gateway_key: { state: "active", key_version: 4 },
        denial_reason: null,
      });
    }));
    renderPage();

    expect(await screen.findByText("No organization key")).toBeVisible();
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    expect(await screen.findByText("Model tasks available")).toBeVisible();
    expect(requests).toBe(2);
  });

  it("renders a safe retry for malformed or sensitive failures", async () => {
    let requests = 0;
    server.use(http.get("*/api/v1/org/me", () => {
      requests += 1;
      if (requests === 1) {
        return HttpResponse.json({
          ...denied,
          capabilities: { ...denied.capabilities, start_model_tasks: "RAW-KEY-CANARY" },
        });
      }
      return HttpResponse.json(denied);
    }));
    renderPage();

    const retry = await screen.findByRole("button", { name: "Retry access" });
    expect(document.body.textContent).not.toContain("RAW-KEY-CANARY");
    fireEvent.click(retry);
    await waitFor(() => expect(requests).toBe(2));
    expect(await screen.findByText("No organization key")).toBeVisible();
  });
});
