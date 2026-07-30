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
  ] as const)("blocks CE %s before any org request, including focus", async (_name, modulePath, path) => {
    let orgRequests = 0;
    server.use(
      http.all("*/api/v1/org/*", () => {
        orgRequests += 1;
        return HttpResponse.json({});
      }),
    );
    routerState.pathname = path;
    const module =
      modulePath === "@/routes/_app/organization"
        ? await import("@/routes/_app/organization")
        : await import("@/routes/_app/organization.members");
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
          organization: { org_id: "org-1", name: "Acme", status: "active" },
          membership: { role: "org_member", membership_status: "active" },
          capabilities: { manage_members: false, manage_invites: false },
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
});
