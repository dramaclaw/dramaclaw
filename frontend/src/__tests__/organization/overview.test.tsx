// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";
import { OrganizationOverview } from "@/components/organization/organization-overview";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const labels: Record<string, string> = {
  "organization.title": "Organization",
  "organization.loading": "Loading organization",
  "organization.retry": "Retry",
  "organization.errors.generic": "Organization request failed",
  "organization.empty.title": "No current organization",
  "organization.readOnly.title": "Read-only access",
  "organization.actions.manageMembers": "Manage members",
  "organization.actions.manageInvites": "Manage invitations",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => labels[key] ?? key,
    i18n: { language: "en" },
  }),
}));

const activeAdmin = {
  user: {
    user_id: "user-1",
    username: "alice",
    model_billing_entitlement: "platform",
  },
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

function renderOverview() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <OrganizationOverview />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  document.documentElement.lang = "en";
});

describe("organization overview", () => {
  it("shows EE organization facts and only capability-authorized management", async () => {
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(activeAdmin)));
    renderOverview();

    expect(await screen.findByText("Acme")).toBeVisible();
    expect(screen.getByText("alice")).toBeVisible();
    expect(screen.getByRole("link", { name: "Manage members" })).toHaveAttribute(
      "href",
      "/organization/members",
    );
    expect(screen.getByRole("link", { name: "Manage invitations" })).toHaveAttribute(
      "href",
      "/organization/invites",
    );
    expect(document.body.textContent).not.toMatch(/key|billing|credit/i);
  });

  it.each([
    {
      name: "capability deny",
      body: {
        ...activeAdmin,
        capabilities: { manage_members: false, manage_invites: false },
      },
    },
    {
      name: "ordinary member",
      body: {
        ...activeAdmin,
        membership: { ...activeAdmin.membership, role: "org_member" },
        capabilities: { manage_members: false, manage_invites: false },
      },
    },
    {
      name: "inactive membership",
      body: {
        ...activeAdmin,
        membership: { ...activeAdmin.membership, membership_status: "suspended" },
      },
    },
    {
      name: "incomplete DTO",
      body: { ...activeAdmin, user: null },
    },
  ])("fails closed for $name", async ({ body }) => {
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(body)));
    renderOverview();

    expect(await screen.findByText("Acme")).toBeVisible();
    expect(screen.getByText("Read-only access")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Manage members" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manage invitations" })).not.toBeInTheDocument();
  });

  it("shows a safe no-organization state even if capabilities are true", async () => {
    server.use(
      http.get("*/api/v1/org/me", () =>
        HttpResponse.json({
          ...activeAdmin,
          organization: null,
          membership: null,
        }),
      ),
    );
    renderOverview();

    expect(await screen.findByText("No current organization")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Manage members" })).not.toBeInTheDocument();
  });

  it("does not expose backend error canaries", async () => {
    server.use(
      http.get("*/api/v1/org/me", () =>
        HttpResponse.json(
          {
            ok: false,
            error: {
              code: "ORG_REQUEST_FAILED",
              message: "SQL DSN token password canary",
              request_id: "request-1",
            },
          },
          { status: 500 },
        ),
      ),
    );
    renderOverview();

    expect(await screen.findByRole("button", { name: "Retry" })).toBeVisible();
    expect(document.body.textContent).not.toContain("SQL DSN token password canary");
  });
});
