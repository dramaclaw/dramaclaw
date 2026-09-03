// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreditBalanceBadge } from "@/components/layout/credit-balance-badge";

const authState = vi.hoisted(() => ({ username: "alice" as string | null }));
const currentUserState = vi.hoisted(() => ({
  isError: false,
  isLoading: false,
  balance: 1234 as number | undefined,
}));
const runtimeState = vi.hoisted(() => ({ isCeRuntime: false }));
const productSurfaceState = vi.hoisted(() => ({ paymentAvailable: false }));
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

vi.mock("@/lib/queries/product-surfaces", () => ({
  useProductSurfaces: () => ({
    data: {
      data: {
        items: [
          {
            surface_code: "payment",
            label: "积分充值",
            available: productSurfaceState.paymentAvailable,
            unavailable_message: "积分充值暂未开放",
          },
        ],
      },
    },
  }),
  surfaceAccess: (
    data: { data: { items: Array<{ surface_code: string }> } } | undefined,
    surfaceCode: string,
  ) => data?.data.items.find((item) => item.surface_code === surfaceCode),
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

vi.mock("@/components/credits/CreditCenterDialog", () => ({
  CreditCenterDialog: ({
    open,
    initialTab,
  }: {
    open: boolean;
    initialTab?: string;
    paymentAvailable: boolean;
  }) => (open ? <div role="dialog">积分中心弹窗:{initialTab}</div> : null),
}));

// The real dictionary, not a hand-copied one: which wallet this popover claims
// to be showing lives entirely in the copy, so a test carrying its own strings
// would keep passing while the shipped labels said something else.
vi.mock("react-i18next", async () => {
  const { readFileSync } = await import("node:fs");
  const dictionary = JSON.parse(
    readFileSync("public/locales/zh/translation.json", "utf8"),
  ) as Record<string, unknown>;
  const translate = (key: string, vars?: Record<string, unknown>) => {
    const raw = key
      .split(".")
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === "object"
            ? (node as Record<string, unknown>)[part]
            : undefined,
        dictionary,
      );
    if (typeof raw !== "string") return key;
    return raw.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
      String(vars?.[name] ?? ""),
    );
  };
  return {
    useTranslation: () => ({
      t: translate,
      i18n: { resolvedLanguage: "zh", language: "zh" },
    }),
  };
});

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
    sessionStorage.clear();
    authState.username = "alice";
    currentUserState.isError = false;
    currentUserState.isLoading = false;
    currentUserState.balance = 1234;
    runtimeState.isCeRuntime = false;
    productSurfaceState.paymentAvailable = false;
    summaryState.scope = undefined;
  });

  it("renders the current credit balance", async () => {
    renderBadge();

    expect(screen.getAllByText("1,234")).toHaveLength(2);
    expect(screen.getByText("可用积分余额")).toBeInTheDocument();
    expect(screen.getByText("当前有 2 项可能适用的优惠")).toBeInTheDocument();
  });

  it("hides recharge while keeping details and the lightweight summary cards", () => {
    renderBadge();

    expect(screen.queryByRole("button", { name: "充值积分" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看明细" })).toHaveClass(
      "focus-visible:ring-0",
    );
    expect(screen.getByText("可用积分余额")).toHaveClass("text-xs");
    expect(screen.queryByText("查看积分明细")).not.toBeInTheDocument();
    for (const label of ["已获得", "已消费", "已退款"]) {
      expect(screen.getByText(label).parentElement).toHaveClass("rounded-sm", "bg-white/[0.075]");
      expect(screen.getByText(label).parentElement).not.toHaveClass("border");
    }
  });

  it("opens the usage dashboard from the details entry", () => {
    renderBadge();

    fireEvent.click(screen.getByRole("button", { name: "查看明细" }));

    expect(screen.getByRole("dialog")).toHaveTextContent("积分中心弹窗:usage");
  });

  it("opens custom recharge from the recharge entry", () => {
    productSurfaceState.paymentAvailable = true;
    renderBadge();

    fireEvent.click(screen.getByRole("button", { name: "充值积分" }));

    expect(screen.getByRole("dialog")).toHaveTextContent("积分中心弹窗:custom");
  });

  it("opens billing history after returning from payment", () => {
    productSurfaceState.paymentAvailable = true;
    sessionStorage.setItem("dramaclaw-open-credit-center", "1");
    sessionStorage.setItem("dramaclaw-credit-center-tab", "orders");

    renderBadge();

    expect(screen.getByRole("dialog")).toHaveTextContent("积分中心弹窗:orders");
    expect(sessionStorage.getItem("dramaclaw-open-credit-center")).toBeNull();
    expect(sessionStorage.getItem("dramaclaw-credit-center-tab")).toBeNull();
  });

  it("uses the same available-balance title for an organization allocation", () => {
    summaryState.scope = "org_member";

    renderBadge();

    expect(screen.getByText("可用积分余额")).toBeInTheDocument();
    expect(screen.queryByText("组织分配给你的额度")).not.toBeInTheDocument();
    expect(screen.queryByText("可用余额")).not.toBeInTheDocument();
    expect(screen.queryByText("个人积分账户")).not.toBeInTheDocument();
  });

  // A backend that predates the scope contract omits the key entirely, and an
  // unknown value must not be read as an organization.
  it("keeps the available-balance title for an absent or unrecognised scope", () => {
    for (const scope of [undefined, "personal", "something_new"]) {
      summaryState.scope = scope;

      const { unmount } = renderBadge();

      expect(screen.getByText("可用积分余额")).toBeInTheDocument();
      expect(screen.queryByText("组织分配给你的额度")).not.toBeInTheDocument();
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
