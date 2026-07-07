// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreditBalanceBadge } from "@/components/layout/credit-balance-badge";

const authState = vi.hoisted(() => ({ username: "alice" as string | null }));
const currentUserState = vi.hoisted(() => ({
  isError: false,
  isLoading: false,
  balance: 1234 as number | undefined,
}));
const runtimeState = vi.hoisted(() => ({ isCeRuntime: false }));

vi.mock("@/lib/runtime-config", () => ({
  isCeRuntime: () => runtimeState.isCeRuntime,
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (
    selector: (state: { username: string | null; role: string | null }) => unknown,
  ) =>
    selector({
      username: authState.username,
      role: authState.username ? "viewer" : null,
    }),
}));

vi.mock("@/lib/queries/auth", () => ({
  useCurrentUser: (enabled: boolean) => ({
    data:
      enabled && currentUserState.balance !== undefined
        ? {
            data: {
              username: authState.username,
              role: "viewer",
              credit_balance: currentUserState.balance,
            },
          }
        : undefined,
    isError: currentUserState.isError,
    isLoading: currentUserState.isLoading,
  }),
}));

// The badge now uses the shadcn/base-ui Tooltip; mock it so the content always
// renders (base-ui only mounts the portal on hover). Mirrors the header test.
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "credits.balance": "当前积分余额",
        "credits.short": "积分",
      })[key] ?? key,
  }),
}));

function renderBadge() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CreditBalanceBadge />
    </QueryClientProvider>,
  );
}

describe("CreditBalanceBadge", () => {
  beforeEach(() => {
    authState.username = "alice";
    currentUserState.isError = false;
    currentUserState.isLoading = false;
    currentUserState.balance = 1234;
    runtimeState.isCeRuntime = false;
  });

  it("renders the current credit balance", async () => {
    renderBadge();

    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("当前积分余额: 1,234")).toBeInTheDocument();
  });

  it("renders nothing when logged out", () => {
    authState.username = null;

    const { container } = renderBadge();

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing in CE runtime", () => {
    runtimeState.isCeRuntime = true;

    const { container } = renderBadge();

    expect(container.firstChild).toBeNull();
  });
});
