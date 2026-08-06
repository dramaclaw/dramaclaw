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
  scope: undefined as string | undefined,
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

// `creditScopeOf` is deliberately the real implementation: it is the one
// deciding which wallet this popover claims to be showing, so stubbing it would
// make the org-scope assertions below prove nothing.
vi.mock("@/lib/queries/credits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries/credits")>()),
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
        "credits.orgAccount": "组织额度账户",
        "credits.orgBalance": "组织额度余额",
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
    summaryState.scope = undefined;
  });

  it("renders the current credit balance", async () => {
    renderBadge();

    expect(screen.getAllByText("1,234")).toHaveLength(2);
    expect(screen.getByText("个人积分账户")).toBeInTheDocument();
    expect(screen.getByText("当前有 2 项可能适用的优惠")).toBeInTheDocument();
  });

  // OI-7: the figures always came from whichever account the backend resolved,
  // but the heading was hardcoded to "个人积分账户" — so an org member read his
  // organization's balance under the name of his personal wallet.
  it("names the organization account when the summary is org-scoped", () => {
    summaryState.scope = "org_member";

    renderBadge();

    expect(screen.getByText("组织额度账户")).toBeInTheDocument();
    expect(screen.getByText("组织额度余额")).toBeInTheDocument();
    expect(screen.queryByText("个人积分账户")).not.toBeInTheDocument();
    expect(screen.queryByText("当前积分余额")).not.toBeInTheDocument();
  });

  // A backend that predates the scope contract omits the key entirely, and an
  // unknown value must not be read as an organization.
  it("keeps the personal framing for an absent or unrecognised scope", () => {
    for (const scope of [undefined, "personal", "something_new"]) {
      summaryState.scope = scope;

      const { unmount } = renderBadge();

      expect(screen.getByText("个人积分账户")).toBeInTheDocument();
      expect(screen.queryByText("组织额度账户")).not.toBeInTheDocument();
      unmount();
    }
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
