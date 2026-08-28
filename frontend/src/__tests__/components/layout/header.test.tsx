// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cloneElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Header } from "@/components/layout/header";

const runtimeState = vi.hoisted(() => ({ authRequired: true, isCe: false }));
const authState = vi.hoisted(() => ({ username: "local", logout: vi.fn() }));
const resetUserSessionStateMock = vi.hoisted(() => vi.fn());
const brandingState = vi.hoisted(() => ({
  enabled: null as boolean | null,
  data: undefined as undefined | {
    schema_version: 1;
    organization: { org_id: string; name: string };
    branding: { logo_url: string; updated_at: string };
  },
}));

vi.mock("@/lib/reset-region-state", () => ({
  resetUserSessionState: resetUserSessionStateMock,
}));

vi.mock("@/lib/runtime-config", () => ({
  authRequired: () => runtimeState.authRequired,
  isCeRuntime: () => runtimeState.isCe,
}));

vi.mock("@/lib/queries/model-gateway", () => ({
  useModelGatewayConfig: () => ({ data: undefined }),
}));

vi.mock("@/lib/queries/org-branding", () => ({
  useOrgBranding: (enabled: boolean) => {
    brandingState.enabled = enabled;
    return { data: brandingState.data };
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: React.ComponentProps<"a"> & { to?: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: "/" } }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "app.logoHomeTooltip": "Home",
        "header.account.open": "Open account",
        "header.notifications": "Announcement Center",
        "header.account.changeAvatar": "Change avatar",
        "header.account.selectLanguage": "Select language",
        "header.account.languageChinese": "Chinese",
        "header.account.languageEnglish": "English",
        "auth.logout": "Log out",
      })[key] ?? key,
    i18n: {
      language: "en",
      resolvedLanguage: "en",
      changeLanguage: vi.fn(),
    },
  }),
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: () => authState,
}));

vi.mock("@/stores/app-store", () => ({
  useAppStore: () => vi.fn(),
}));

vi.mock("@/components/layout/credit-balance-badge", () => ({
  CreditBalanceBadge: () => <div data-testid="credit-balance" />,
}));

vi.mock("@/components/task-center/header-entry", () => ({
  HeaderEntry: () => <button type="button">Tasks</button>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({
    children,
    render,
  }: React.PropsWithChildren<{ render?: React.ReactElement }>) =>
    render ? cloneElement(render, {}, children) : <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuGroup: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuLabel: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

function renderHeader() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Header />
    </QueryClientProvider>,
  );
}

describe("Header runtime gating", () => {
  beforeEach(() => {
    runtimeState.authRequired = true;
    runtimeState.isCe = false;
    authState.username = "local";
    authState.logout.mockReset();
    resetUserSessionStateMock.mockReset();
    brandingState.enabled = null;
    brandingState.data = undefined;
  });

  it("reads branding only for an authenticated EE session and renders it in the home link", () => {
    brandingState.data = {
      schema_version: 1,
      organization: { org_id: "org-1", name: "Claymore" },
      branding: {
        logo_url: "/assets/org-brand/org-1/logo",
        updated_at: "2026-08-21T10:00:00Z",
      },
    };

    renderHeader();

    expect(brandingState.enabled).toBe(true);
    expect(screen.getByRole("link", { name: "Home — Claymore" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Claymore" })).not.toBeInTheDocument();

    fireEvent.error(screen.getByTestId("organization-brand").querySelector("img")!);
    expect(screen.queryByTestId("organization-brand")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Home — Claymore" })).toBeInTheDocument();
  });

  it("disables branding in CE", () => {
    runtimeState.isCe = true;
    renderHeader();
    expect(brandingState.enabled).toBe(false);
  });

  it("renders logout in the account panel when runtime requires auth", async () => {
    renderHeader();

    fireEvent.mouseEnter(screen.getByLabelText("Open account").parentElement!);

    expect(await screen.findByText("Log out")).toBeInTheDocument();
  });

  it("moves the announcement entry from the header actions into the account panel", async () => {
    renderHeader();

    expect(screen.queryByRole("button", { name: "Announcement Center" })).not.toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByLabelText("Open account").parentElement!);

    expect(
      await screen.findByRole("button", { name: "Announcement Center" }),
    ).toBeInTheDocument();
  });

  it("hides logout when runtime does not require auth while keeping the local identity", async () => {
    runtimeState.authRequired = false;

    renderHeader();

    fireEvent.mouseEnter(screen.getByLabelText("Open account").parentElement!);

    await waitFor(() => {
      expect(screen.getByText("local")).toBeInTheDocument();
    });
    expect(screen.queryByText("Log out")).not.toBeInTheDocument();
  });

  it("purges user-scoped caches after logout so the next account can't see stale data", async () => {
    // 回归用例：手动退出是 SPA 内部跳转，不清 QueryClient 的话换账号登录后
    // projectSummaries 还在 staleTime 内，新账号会看到上一个账号的项目列表。
    authState.logout.mockResolvedValue(undefined);

    renderHeader();

    fireEvent.mouseEnter(screen.getByLabelText("Open account").parentElement!);
    fireEvent.click(await screen.findByText("Log out"));

    await waitFor(() => {
      expect(resetUserSessionStateMock).toHaveBeenCalled();
    });
    expect(authState.logout).toHaveBeenCalled();
  });

});
