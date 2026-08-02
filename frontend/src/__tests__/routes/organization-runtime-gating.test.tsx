// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";

const runtimeState = vi.hoisted(() => ({ isCe: true }));
const routerState = vi.hoisted(() => ({ pathname: "/organization" }));

vi.mock("@/lib/runtime-config", () => ({
  isCeRuntime: () => runtimeState.isCe,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: unknown) => ({
      options,
      useSearch: () => ({}),
    }),
    Link: ({
      children,
      to,
      ...props
    }: React.ComponentProps<"a"> & { to: string }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
    Outlet: () => <div data-testid="organization-outlet" />,
    useNavigate: () => vi.fn(),
    useRouterState: ({
      select,
    }: {
      select: (state: { location: { pathname: string } }) => unknown;
    }) => select({ location: { pathname: routerState.pathname } }),
  };
});

function renderRoute(Component: React.ComponentType) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false, refetchOnWindowFocus: false },
          },
        })
      }
    >
      <Component />
    </QueryClientProvider>,
  );
}

describe("organization route runtime gating", () => {
  beforeEach(() => {
    runtimeState.isCe = true;
    routerState.pathname = "/organization";
  });

  it.each([
    ["overview", "@/routes/_app/organization", "/organization"],
    ["members", "@/routes/_app/organization.members", "/organization/members"],
    ["gateway key", "@/routes/_app/organization.gateway-key", "/organization/gateway-key"],
    ["access unavailable", "@/routes/_app/access-unavailable", "/access-unavailable"],
  ] as const)("blocks CE %s before any org request, including focus", async (_name, modulePath, path) => {
    let orgRequests = 0;
    server.use(
      http.all("*/api/v1/org/*", () => {
        orgRequests += 1;
        return HttpResponse.json({});
      }),
    );
    routerState.pathname = path;
    const module = modulePath === "@/routes/_app/organization"
      ? await import("@/routes/_app/organization")
      : modulePath === "@/routes/_app/organization.members"
        ? await import("@/routes/_app/organization.members")
        : modulePath === "@/routes/_app/organization.gateway-key"
          ? await import("@/routes/_app/organization.gateway-key")
          : await import("@/routes/_app/access-unavailable");
    const Component = module.Route.options.component as React.ComponentType;

    renderRoute(Component);

    expect(screen.getByText("organization.unavailable")).toBeVisible();
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    expect(orgRequests).toBe(0);
  });

  it("refetches the EE overview org query on focus", async () => {
    runtimeState.isCe = false;
    let orgRequests = 0;
    server.use(
      http.get("*/api/v1/org/me", () => {
        orgRequests += 1;
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
        });
      }),
    );
    const { Route } = await import("@/routes/_app/organization");

    renderRoute(Route.options.component as React.ComponentType);

    expect(await screen.findByText("Acme")).toBeVisible();
    expect(orgRequests).toBe(1);

    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await vi.waitFor(() => expect(orgRequests).toBe(2));
  });

  it("blocks an EE member before the gateway status request is created", async () => {
    runtimeState.isCe = false;
    routerState.pathname = "/organization/gateway-key";
    let orgMeRequests = 0;
    let gatewayRequests = 0;
    server.use(
      http.get("*/api/v1/org/me", () => {
        orgMeRequests += 1;
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
        });
      }),
      http.all("*/api/v1/org/gateway/key*", () => {
        gatewayRequests += 1;
        return HttpResponse.json({});
      }),
    );
    const { Route } = await import("@/routes/_app/organization.gateway-key");

    renderRoute(Route.options.component as React.ComponentType);

    expect(await screen.findByText("organization.gatewayKey.returning")).toBeVisible();
    expect(orgMeRequests).toBe(1);
    expect(gatewayRequests).toBe(0);
  });
});
