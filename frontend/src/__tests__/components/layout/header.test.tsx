// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Header } from "@/components/layout/header";

const runtimeState = vi.hoisted(() => ({ authRequired: true, isCe: false }));
const authState = vi.hoisted(() => ({ username: "local", logout: vi.fn() }));
const resetUserSessionStateMock = vi.hoisted(() => vi.fn());

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

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
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
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
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
    authState.username = "local";
    authState.logout.mockReset();
    resetUserSessionStateMock.mockReset();
  });

  it("renders logout in the account panel when runtime requires auth", async () => {
    renderHeader();

    fireEvent.mouseEnter(screen.getByLabelText("Open account").parentElement!);

    expect(await screen.findByText("Log out")).toBeInTheDocument();
  });

  it("keeps the Liexiaoren archive entry visible on the project dashboard", () => {
    renderHeader();

    expect(screen.getByRole("button", { name: "打开猎魈档案" })).toBeInTheDocument();
  });

  it("opens the Liexiaoren archive only after an explicit user click", () => {
    renderHeader();

    window.dispatchEvent(new Event("liexiaoren:open-skin"));
    expect(screen.queryByRole("dialog", { name: "鲁班秘术猎魈人档案" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开猎魈档案" }));
    expect(screen.getByRole("dialog", { name: "鲁班秘术猎魈人档案" })).toBeInTheDocument();
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
