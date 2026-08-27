// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
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

// No `scope` key: what a backend that predates organization promotions sends,
// and what the merged list carries for a platform promotion whose scope the
// wire happens to omit. Either way it must render as a platform promotion.
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

const ORG_PROMOTION = { ...PROMOTION, id: "promo-org", name: "星辰专属折扣", scope: "org" };
const PLATFORM_PROMOTION = {
  ...PROMOTION,
  id: "promo-platform",
  name: "平台通用折扣",
  scope: "platform",
};

const ORG_BADGE = "组织促销";
const LOW_BALANCE_ANCHOR = "请联系组织管理员追加额度";

// The badge has to be attributed to a specific card, not just found somewhere
// on the page: "the org row is badged" and "the platform row is not" are two
// different claims and a whole-page textContent search cannot tell them apart.
function promotionCardText(container: HTMLElement, name: string): string {
  const title = [...container.querySelectorAll("div")].find(
    (node) => node.textContent?.trim() === name,
  );
  if (!title) throw new Error(`no promotion card titled ${name}`);
  return title.closest("div.rounded-md")?.textContent ?? "";
}

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

    expect(container.firstElementChild).toHaveClass(
      "fixed",
      "inset-0",
      "z-[60]",
      "w-full",
      "bg-black/35",
      "backdrop-blur-md",
    );
    expect(container.firstElementChild?.firstElementChild).toHaveClass(
      "mt-auto",
      "max-w-6xl",
    );
    expect(text).toContain("积分中心");
    expect(screen.getByRole("button", { name: "关闭" })).toHaveClass("size-7");
    expect(text).toContain("当前积分余额");
    expect(text).not.toContain("查看统一积分余额、消费结算、退款和当前可用促销。");
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

  // N3. Adding organization promotions must not change a single pixel of the
  // personal promotion surface: the section still renders, and no row on it
  // carries a source badge.
  it("renders promotions exactly as before, with no source badge", () => {
    queryState.summary = { ...PERSONAL_SUMMARY };
    queryState.promotions = [PROMOTION];

    const { container } = render(<CreditsPage />);
    const text = container.textContent ?? "";

    expect(queryState.promotionsEnabled).toBe(true);
    expect(text).toContain("当前可用促销");
    expect(text).toContain("最终优惠以具体功能、模型和业务区域的实时报价为准。");
    expect(text).toContain("首充双倍");
    expect(text).toContain("图片生成");
    expect(text).not.toContain(ORG_BADGE);
    expect(promotionCardText(container, "首充双倍")).not.toContain(ORG_BADGE);
  });

  // N7. The scope guard in `lowBalanceThresholdOf` is what keeps a stray
  // threshold on a personal payload from telling a personal user to go ask an
  // organization admin he does not have.
  it("ignores a low-balance threshold sent on a personal payload", () => {
    queryState.summary = { ...PERSONAL_SUMMARY, balance: 1, low_balance_threshold: 500 };

    const { container } = render(<CreditsPage />);

    expect(container.textContent ?? "").not.toContain(LOW_BALANCE_ANCHOR);
  });
});

describe("credits page — organization member", () => {
  it("labels the figures as the organization's allocation without repeating scope copy", () => {
    queryState.summary = { ...ORG_SUMMARY };

    const { container } = render(<CreditsPage />);
    const text = container.textContent ?? "";

    // "分配" is the load-bearing word: the figure is this member's share, not
    // the organization-wide pool. A chip reading plain "组织额度" let an org
    // admin take his own allocation for the whole organization's balance.
    expect(text).toContain("组织分配额度");
    expect(text).toContain("可用余额");
    expect(text).not.toContain("以下余额与明细来自组织");
    // The figure on screen is the org member account's, not a personal wallet.
    expect(text).toContain("5,000");
    expect(text).toContain("1,300");
    // The unlabelled personal-wallet description must be gone.
    expect(text).not.toContain("查看统一积分余额、消费结算、退款和当前可用促销。");
  });

  // M5 gave organizations promotions of their own (`org_credit_promotions`),
  // which retires the OI-7 narrowing that skipped the request entirely for org
  // members. The backend now merges the organization's own promotions with the
  // platform ones no org promotion overrides, so the page asks unconditionally
  // and renders the list verbatim — no client-side filtering or de-duplication.
  // The only distinction left in the UI is authorship.
  it("fetches promotions and badges only the organization's own", () => {
    queryState.summary = { ...ORG_SUMMARY };
    queryState.promotions = [ORG_PROMOTION, PLATFORM_PROMOTION];

    const { container } = render(<CreditsPage />);
    const text = container.textContent ?? "";

    expect(queryState.promotionsEnabled).toBe(true);
    expect(text).toContain("当前可用促销");
    expect(text).toContain("星辰专属折扣");
    expect(text).toContain("平台通用折扣");
    expect(promotionCardText(container, "星辰专属折扣")).toContain(ORG_BADGE);
    expect(promotionCardText(container, "平台通用折扣")).not.toContain(ORG_BADGE);
  });

  // N1. An absent `scope` is the wire shape of every backend that predates M5;
  // it must not be mistaken for an organization promotion.
  it("renders a promotion with no scope key as a platform promotion", () => {
    queryState.summary = { ...ORG_SUMMARY };
    queryState.promotions = [PROMOTION];

    const { container } = render(<CreditsPage />);

    expect(container.textContent ?? "").toContain("首充双倍");
    expect(promotionCardText(container, "首充双倍")).not.toContain(ORG_BADGE);
  });

  // N2. `promotionScopeOf` fails towards "platform" so that a scope value this
  // build has never seen can never claim the member's own organization
  // authored the discount.
  it("renders a promotion with an unrecognised scope as a platform promotion", () => {
    queryState.summary = { ...ORG_SUMMARY };
    queryState.promotions = [{ ...PROMOTION, name: "未来来源折扣", scope: "something_new" }];

    const { container } = render(<CreditsPage />);

    expect(promotionCardText(container, "未来来源折扣")).not.toContain(ORG_BADGE);
  });

  // N4. The threshold an org admin set on this member's allocation is the only
  // warning the member can act on — he cannot top the allocation up himself.
  it.each([
    ["below the threshold", 5000, 6000, "5,000", "6,000"],
    ["exactly at the threshold", 5000, 5000, "5,000", "5,000"],
  ])("warns when the balance is %s", (_case, balance, threshold, shownBalance, shownThreshold) => {
    queryState.summary = { ...ORG_SUMMARY, balance, low_balance_threshold: threshold };

    const { container } = render(<CreditsPage />);
    const text = container.textContent ?? "";

    expect(text).toContain(LOW_BALANCE_ANCHOR);
    expect(text).toContain(
      `可用余额 ${shownBalance} 已低于组织设置的提醒阈值 ${shownThreshold}，${LOW_BALANCE_ANCHOR}。`,
    );
  });

  // N5.
  it("stays quiet while the balance is above the threshold", () => {
    queryState.summary = { ...ORG_SUMMARY, balance: 5000, low_balance_threshold: 100 };

    const { container } = render(<CreditsPage />);

    expect(container.textContent ?? "").not.toContain(LOW_BALANCE_ANCHOR);
  });

  // N6. `0` is the backend's "no threshold configured". Comparing it naively
  // would fire the warning forever, because a balance is never below zero.
  it.each([
    ["zero", { low_balance_threshold: 0 }],
    ["null", { low_balance_threshold: null }],
    ["absent", {}],
  ])("treats a %s threshold as no threshold at all", (_case, override) => {
    queryState.summary = { ...ORG_SUMMARY, balance: 0, ...override };

    const { container } = render(<CreditsPage />);

    expect(container.textContent ?? "").not.toContain(LOW_BALANCE_ANCHOR);
  });

  it("keeps a dormant personal balance out of this focused transaction view", () => {
    queryState.summary = { ...ORG_SUMMARY, dormant_personal_balance: 1200 };

    const { container } = render(<CreditsPage />);
    const text = container.textContent ?? "";

    expect(text).not.toContain("个人积分余额（此处不可用）");
    expect(text).not.toContain("不会动用个人积分");
    expect(text).not.toContain("1,200");
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
