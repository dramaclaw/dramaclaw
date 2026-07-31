// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";

const runtimeState = vi.hoisted(() => ({ isCe: true }));
const routeState = vi.hoisted(() => ({ token: "ROUTE-TOKEN-CANARY" }));

vi.mock("@/lib/runtime-config", () => ({ isCeRuntime: () => runtimeState.isCe }));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: unknown) => ({ options, useParams: () => routeState }),
    useNavigate: () => vi.fn(),
  };
});

function renderRoute(Component: React.ComponentType) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Component />
    </QueryClientProvider>,
  );
}

describe("invitation route runtime gating", () => {
  beforeEach(() => { runtimeState.isCe = true; });

  it.each([
    ["management", "@/routes/_app/organization.invites"],
    ["public acceptance", "@/routes/invite.$token"],
  ] as const)("blocks CE %s before all organization requests", async (_name, modulePath) => {
    let requests = 0;
    server.use(http.all("*/api/v1/org/*", () => {
      requests += 1;
      return HttpResponse.json({});
    }));
    const module = modulePath === "@/routes/_app/organization.invites"
      ? await import("@/routes/_app/organization.invites")
      : await import("@/routes/invite.$token");

    renderRoute(module.Route.options.component as React.ComponentType);

    expect(screen.getByText("organization.unavailable")).toBeVisible();
    expect(requests).toBe(0);
  });

  it("places the public route outside the authenticated layout and installs no-referrer", async () => {
    runtimeState.isCe = false;
    server.use(http.get("*/api/v1/org/invites/*/preview", () =>
      HttpResponse.json({ org_name: "Acme", target_masked: "a***e", status: "pending", expires_at: "2026-07-31T00:00:00Z" }),
    ));
    const { Route } = await import("@/routes/invite.$token");
    await Route.options.beforeLoad?.({} as never);
    renderRoute(Route.options.component as React.ComponentType);

    expect(await screen.findByText("Acme")).toBeVisible();
    expect(document.head.querySelector('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
  });
});
