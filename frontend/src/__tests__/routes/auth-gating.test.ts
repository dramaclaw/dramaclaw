// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { createElement, Fragment, type ComponentProps, type ComponentType, type PropsWithChildren } from "react";

const runtimeState = vi.hoisted(() => ({ authRequired: true }));
const navigateMock = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({
  username: null as string | null,
  getCurrentUser: vi.fn<() => Promise<unknown>>(),
  validateSession: vi.fn<() => Promise<boolean>>(),
  reset: vi.fn(),
}));
const clusterState = vi.hoisted(() => ({ mode: "none" as "none" | "multi-region" }));
const regionState = vi.hoisted(() => ({ cookie: "region-a" as string | null }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  Outlet: () => createElement("div", { "data-testid": "outlet" }),
  redirect: (options: unknown) => ({ options }),
  useNavigate: () => navigateMock,
  useParams: () => ({}),
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/" } }),
}));

vi.mock("@/lib/runtime-config", () => ({
  authRequired: () => runtimeState.authRequired,
}));

const useAuthStoreMock = Object.assign(
  (selector: (state: typeof authState) => unknown) => selector(authState),
  { getState: () => authState },
);

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: useAuthStoreMock,
}));

vi.mock("@/components/layout/header", () => ({ Header: () => null }));
vi.mock("@/hooks/use-reduced-motion", () => ({ useReducedMotion: () => true }));
vi.mock("@/stores/app-store", () => ({
  useAppStore: {
    getState: () => ({ clampDimensionsToViewport: vi.fn() }),
  },
}));
vi.mock("@/lib/queries/projects", () => ({
  useAllProjectSummaries: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/lib/project-route", () => ({
  canonicalProjectRouteParam: (project: string) => project,
}));
vi.mock("@/stores/region-store", () => ({
  useRegionStore: {
    getState: () => ({ sanitizeAgainstConfig: vi.fn() }),
  },
}));
vi.mock("@/lib/region-tab-sync", () => ({ initRegionTabSync: vi.fn() }));
vi.mock("@/lib/observability", () => ({ initObservability: vi.fn() }));
vi.mock("@/task-center/provider", () => ({
  TaskCenterProvider: ({ children }: PropsWithChildren) => createElement(Fragment, null, children),
}));
vi.mock("@/components/task-center/status-bar", () => ({ TaskStatusBar: () => null }));
vi.mock("@/components/task-center/panel", () => ({ TaskPanel: () => null }));
vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: ComponentProps<"div">) => createElement("div", props, children),
  },
}));

vi.mock("@/lib/cluster-config", () => ({
  clusterConfig: clusterState,
}));

vi.mock("@/lib/region-cookie", () => ({
  getRegionCookie: () => regionState.cookie,
}));

function expectRedirect(error: unknown, to: string) {
  expect((error as { options?: { to?: string; replace?: boolean } }).options).toMatchObject({
    to,
    replace: true,
  });
}

describe("runtime auth gating", () => {
  beforeEach(() => {
    vi.resetModules();
    runtimeState.authRequired = true;
    authState.username = null;
    authState.getCurrentUser.mockReset();
    authState.validateSession.mockReset();
    authState.reset.mockReset();
    navigateMock.mockReset();
    clusterState.mode = "none";
    regionState.cookie = "region-a";
  });

  it("login beforeLoad redirects CE/no-auth runtime to the app without probing auth", async () => {
    runtimeState.authRequired = false;
    authState.getCurrentUser.mockResolvedValue(false);
    const { Route } = await import("@/routes/login");

    try {
      await Route.options.beforeLoad?.({} as never);
      throw new Error("expected redirect");
    } catch (error) {
      expectRedirect(error, "/");
    }
    expect(authState.getCurrentUser).not.toHaveBeenCalled();
  });

  it("login beforeLoad keeps multi-region runtime on login when region cookie is missing", async () => {
    runtimeState.authRequired = false;
    clusterState.mode = "multi-region";
    regionState.cookie = null;
    const { Route } = await import("@/routes/login");

    await expect(Route.options.beforeLoad?.({} as never)).resolves.toBeUndefined();
    expect(authState.reset).toHaveBeenCalledTimes(1);
    expect(authState.getCurrentUser).not.toHaveBeenCalled();
  });

  it("login beforeLoad keeps EE/auth-required runtime on login when unauthenticated", async () => {
    runtimeState.authRequired = true;
    const { Route } = await import("@/routes/login");

    await expect(Route.options.beforeLoad?.({} as never)).resolves.toBeUndefined();
  });

  it("_app missing-username mount guard validates CE/no-auth runtime instead of redirecting", async () => {
    runtimeState.authRequired = false;
    authState.validateSession.mockResolvedValue(true);
    const { Route } = await import("@/routes/_app");
    const Component = Route.options.component as ComponentType;

    render(createElement(Component));

    await waitFor(() => expect(authState.validateSession).toHaveBeenCalledTimes(1));
    expect(navigateMock).not.toHaveBeenCalledWith({ to: "/login" });
  });

  it("_app missing-username mount guard redirects EE/auth-required runtime", async () => {
    runtimeState.authRequired = true;
    const { Route } = await import("@/routes/_app");
    const Component = Route.options.component as ComponentType;

    render(createElement(Component));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/login" }));
    expect(authState.validateSession).not.toHaveBeenCalled();
  });
});
