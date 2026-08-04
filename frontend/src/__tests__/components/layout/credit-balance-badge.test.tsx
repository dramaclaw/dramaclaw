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
const summaryState = vi.hoisted(() => ({
  balance: 1234,
  earned: 2000,
  spent: 800,
  refunded: 34,
  pending: 0,
  promotion_count: 2,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

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

vi.mock("@/lib/queries/credits", () => ({
  useCreditSummary: () => ({
    data: { data: summaryState },
    isStale: false,
    refetch: vi.fn(),
  }),
}));

// Base UI portals only mount while open; keep the panel visible in this unit test.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: React.PropsWithChildren) => <>{children}</>,
  PopoverTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  PopoverContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "credits.balance": "当前积分余额",
        "credits.short": "积分",
        "credits.openPanel": "打开积分面板",
        "credits.personalAccount": "个人积分账户",
        "credits.details": "查看明细",
        "credits.earned": "已获得",
        "credits.spent": "已消费",
        "credits.refunded": "已退款",
        "credits.promotions": "可用促销",
        "credits.promotionCount": "当前有 2 项可能适用的优惠",
        "credits.viewTransactions": "查看积分明细",
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

    expect(screen.getAllByText("1,234")).toHaveLength(2);
    expect(screen.getByText("个人积分账户")).toBeInTheDocument();
    expect(screen.getByText("当前有 2 项可能适用的优惠")).toBeInTheDocument();
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
