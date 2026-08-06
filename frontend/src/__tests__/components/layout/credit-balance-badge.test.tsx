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
  //
  // The label must also say *allocated*: this figure is the member's own share,
  // handed to him by the org, not the organization-wide pool. Naming it
  // "组织额度余额" told an org admin he was looking at the whole org's money.
  it("names the allocation the organization made to this member", () => {
    summaryState.scope = "org_member";

    renderBadge();

    expect(screen.getByText("组织分配给你的额度")).toBeInTheDocument();
    expect(screen.getByText("可用余额")).toBeInTheDocument();
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
