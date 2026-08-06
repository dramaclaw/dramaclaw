// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreditSummary } from "@/lib/queries/credits";

// The credit page is EE-only and reads `credits/me/*`. OI-7: an organization
// member's tasks are charged to his org member account, so the page has to
// show that account and say so. A personal account must render exactly what
// it rendered before this change.

const queryState = vi.hoisted(() => ({
  summary: undefined as Record<string, unknown> | undefined,
  promotions: [] as Record<string, unknown>[],
  promotionsEnabled: undefined as boolean | undefined,
  transactions: [] as Record<string, unknown>[],
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  redirect: (options: unknown) => options,
  useNavigate: () => vi.fn(),
}));

// base-ui's Select portals a popup and needs layout APIs jsdom doesn't give;
// the filter controls are not what this test is about.
vi.mock("@/components/ui/select", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    Select: Passthrough,
    SelectContent: () => null,
    SelectItem: Passthrough,
    SelectTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    SelectValue: () => null,
  };
});

vi.mock("@/lib/queries/credits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/credits")>();
  return {
    ...actual,
    useCreditSummary: () => ({
      data: queryState.summary ? { data: queryState.summary } : undefined,
      isError: false,
      refetch: vi.fn(),
    }),
    useCreditPromotions: (enabled = true) => {
      queryState.promotionsEnabled = enabled;
      return { data: { data: { items: queryState.promotions } } };
    },
    useCreditFilterOptions: () => ({
      data: { data: { projects: [], features: [], models: [] } },
    }),
    useCreditTransactions: () => ({
      data: {
        data: {
          items: queryState.transactions,
          page: 1,
          page_size: 20,
          total: queryState.transactions.length,
        },
      },
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
  };
});

// Render against the real shipped Chinese copy so "no organization wording"
// is asserted on the strings users actually see.
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

const { CreditsPage } = await import("@/routes/_app/credits");

const PERSONAL_SUMMARY: CreditSummary = {
  balance: 92,
  earned: 150,
  spent: 60,
  refunded: 10,
  pending: 0,
  promotion_count: 2,
  updated_at: null,
  scope: "personal",
  organization: null,
  dormant_personal_balance: null,
};

const ORG_SUMMARY: CreditSummary = {
  balance: 5000,
  earned: 5000,
  spent: 1300,
  refunded: 40,
  pending: 0,
  promotion_count: 0,
  updated_at: null,
  scope: "org_member",
  organization: { org_id: "org-1", name: "星辰文化" },
  dormant_personal_balance: null,
};

const PROMOTION = {
  id: "promo-1",
  name: "首充双倍",
  target_type: "feature",
  target_label: "图片生成",
  billing_domain: "mainline",
  discount_basis_points: 5000,
  starts_at: null,
  ends_at: null,
};

const TRANSACTION = {
  id: "tx-1",
  occurred_at: "2026-08-01T10:00:00Z",
  category: "spent",
  status: "confirmed",
  delta: -12,
  balance_after: 4988,
  project_id: "p-1",
  project_name: "示例项目",
  resource_kind: "image",
  feature_key: "image.generate",
  feature_label: "图片生成",
  model: "seedream",
  original_cost: 12,
  charged_cost: 12,
  promotion: {},
};

beforeEach(() => {
  queryState.summary = undefined;
  queryState.promotions = [PROMOTION];
  queryState.promotionsEnabled = undefined;
  queryState.transactions = [TRANSACTION];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("credits page — personal account", () => {
  it("says nothing about organizations", () => {
    queryState.summary = { ...PERSONAL_SUMMARY };

    const { container } = render(<CreditsPage />);
    const text = container.textContent ?? "";

    expect(text).toContain("积分中心");
    expect(text).toContain("查看统一积分余额、消费结算、退款和当前可用促销。");
    expect(text).toContain("当前积分余额");
    expect(text).not.toContain("组织");
    expect(text).not.toContain("组织额度");
    expect(text).not.toContain("个人积分余额（此处不可用）");
    // Promotions keep working exactly as before for a personal account.
    expect(queryState.promotionsEnabled).toBe(true);
    expect(text).toContain("首充双倍");
  });

  it("renders identically for a payload from a backend that predates the scope contract", () => {
    queryState.summary = { ...PERSONAL_SUMMARY };
    const scoped = (render(<CreditsPage />).container.textContent ?? "").trim();

    const legacy = { ...PERSONAL_SUMMARY } as Record<string, unknown>;
    delete legacy.scope;
    delete legacy.organization;
    delete legacy.dormant_personal_balance;
    queryState.summary = legacy;
    const unscoped = (render(<CreditsPage />).container.textContent ?? "").trim();

    expect(unscoped).toBe(scoped);
    expect(unscoped).not.toContain("组织");
  });
});

describe("credits page — organization member", () => {
  it("labels the figures as the organization's allocation and names the organization", () => {
    queryState.summary = { ...ORG_SUMMARY };

    const { container } = render(<CreditsPage />);
    const text = container.textContent ?? "";

    // "分配" is the load-bearing word: the figure is this member's share, not
    // the organization-wide pool. A chip reading plain "组织额度" let an org
    // admin take his own allocation for the whole organization's balance.
    expect(text).toContain("组织分配额度");
    expect(text).toContain("可用余额");
    expect(text).toContain(
      "以下余额与明细来自组织「星辰文化」为你分配的组织额度，你的任务消耗从该额度扣除。",
    );
    // The figure on screen is the org member account's, not a personal wallet.
    expect(text).toContain("5,000");
    expect(text).toContain("1,300");
    // The unlabelled personal-wallet description must be gone.
    expect(text).not.toContain("查看统一积分余额、消费结算、退款和当前可用促销。");
  });

  it("does not fetch or advertise promotions", () => {
    queryState.summary = { ...ORG_SUMMARY };

    const { container } = render(<CreditsPage />);
    const text = container.textContent ?? "";

    expect(queryState.promotionsEnabled).toBe(false);
    expect(text).not.toContain("当前可用促销");
    expect(text).not.toContain("首充双倍");
  });

  it("shows a non-zero dormant personal balance and marks it unusable here", () => {
    queryState.summary = { ...ORG_SUMMARY, dormant_personal_balance: 1200 };

    const { container } = render(<CreditsPage />);
    const text = container.textContent ?? "";

    expect(text).toContain("个人积分余额（此处不可用）");
    expect(text).toContain(
      "这笔积分仍保留在你的个人账户中。当前账号按组织额度结算，不会动用个人积分。",
    );
    expect(text).toContain("1,200");
    // It is reported beside the balance, never folded into it.
    expect(text).toContain("5,000");
  });

  it("renders nothing about a personal balance when the backend sends null", () => {
    queryState.summary = { ...ORG_SUMMARY, dormant_personal_balance: null };

    const { container } = render(<CreditsPage />);
    const text = container.textContent ?? "";

    expect(text).not.toContain("个人积分余额");
    expect(text).not.toContain("此处不可用");
    expect(text).not.toContain("不会动用个人积分");
  });
});
