// SPDX-License-Identifier: Elastic-2.0
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  SubscriptionPlan,
  SubscriptionPlanGroup,
} from "@/lib/queries/subscriptions";
import { groupSubscriptionPlans } from "@/lib/queries/subscriptions";
import { SubscriptionCatalog } from "@/components/credits/SubscriptionCatalog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: Record<string, unknown>) =>
      options?.price ? `${key}: ${options.price}` : key,
  }),
}));

function plan(
  id: string,
  credits: number,
  months: 1 | 3 | 12,
  amount: number,
): SubscriptionPlan {
  return {
    plan_id: id,
    version: 2,
    name: "PRO",
    description: "For creators",
    group_id: "pro",
    billing_months: months,
    credits_per_month: credits,
    grant_mode: "monthly",
    terms_url: "https://app.example.test/terms",
    offers: [
      {
        payment_method: "wxpay",
        amount_minor: amount,
        first_amount_minor: null,
        currency: "CNY",
      },
    ],
  };
}
function groups(): SubscriptionPlanGroup[] {
  return [
    {
      group_id: "pro",
      name: "PRO",
      description: "For creators",
      badge: "Popular",
      sort_order: 1,
      options: [
        plan("pro-small-month", 3000, 1, 3000),
        plan("pro-large-month", 6000, 1, 6000),
        plan("pro-small-year", 3000, 12, 36000),
        plan("pro-large-year", 6000, 12, 72000),
      ],
    },
  ];
}

describe("subscription pricing cards", () => {
  it("provides independent sliders for each configured local demo group and selects the displayed price and plan", () => {
    const catalog: SubscriptionPlanGroup[] = [
      {
        group_id: "basic",
        name: "BASIC",
        months: 1,
        credits: 3000,
        amount: 2900,
      },
      { group_id: "pro", name: "PRO", months: 3, credits: 5000, amount: 7900 },
      {
        group_id: "max",
        name: "MAX",
        months: 12,
        credits: 8000,
        amount: 19900,
      },
    ].map((group, index) => ({
      group_id: group.group_id,
      name: group.name,
      description: "",
      badge: "",
      sort_order: index,
      options: [1, 2, 4].map((scale) =>
        plan(
          `${group.group_id}-${scale}`,
          group.credits * scale,
          group.months as 1 | 3 | 12,
          group.amount * scale,
        ),
      ),
    }));
    const select = vi.fn();
    render(
      <SubscriptionCatalog
        groups={catalog}
        disabled={false}
        onSelect={select}
      />,
    );
    expect(screen.getAllByRole("slider")).toHaveLength(3);
    for (const [index, group] of catalog.entries()) {
      const card = within(screen.getByRole("article", { name: group.name }));
      const optionIndex = index === 1 ? 1 : 2;
      const chosen = group.options[optionIndex];
      fireEvent.change(card.getByRole("slider"), {
        target: { value: String(optionIndex) },
      });
      const price = new Intl.NumberFormat("en", {
        style: "currency",
        currency: "CNY",
        minimumFractionDigits: 0,
      }).format(chosen.offers[0].amount_minor / 100);
      expect(
        card.getByText(
          `subscriptions.billingTotal.${chosen.billing_months}: ${price}`,
        ),
      ).toBeInTheDocument();
      expect(card.getByRole("slider")).toHaveValue(String(optionIndex));
      fireEvent.click(
        card.getByRole("button", { name: "subscriptions.subscribe" }),
      );
      expect(select).toHaveBeenLastCalledWith(chosen);
    }
    fireEvent.click(
      screen.getByRole("tab", { name: "subscriptions.billingPeriodLabels.1" }),
    );
    expect(screen.getByRole("slider")).toHaveValue("2");
    fireEvent.click(
      screen.getByRole("tab", { name: "subscriptions.allPeriods" }),
    );
    expect(
      screen
        .getAllByRole("slider")
        .map((slider) => (slider as HTMLInputElement).value),
    ).toEqual(["2", "1", "2"]);
  });

  it("renders one dynamic card and sends the exact plan after tier and period changes", () => {
    const select = vi.fn();
    const catalog = groups();
    render(
      <SubscriptionCatalog
        groups={catalog}
        disabled={false}
        onSelect={select}
      />,
    );
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText("Popular")).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", {
        name: "subscriptions.billingPeriodLabels.3",
      }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "1" } });
    fireEvent.click(
      screen.getByRole("tab", { name: "subscriptions.billingPeriodLabels.12" }),
    );
    expect(
      screen.getByText("subscriptions.billingTotal.12: CN¥720"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "subscriptions.subscribe" }),
    );
    expect(select).toHaveBeenLastCalledWith(catalog[0].options[3]);
    fireEvent.click(
      screen.getByRole("tab", { name: "subscriptions.billingPeriodLabels.1" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "subscriptions.subscribe" }),
    );
    expect(select).toHaveBeenLastCalledWith(catalog[0].options[1]);
    expect(screen.queryByText(/OFF|renewAfterIntro/)).not.toBeInTheDocument();
  });

  it("hides cards without the selected period instead of rendering empty offers", () => {
    const catalog = groups();
    catalog.push({
      group_id: "basic",
      name: "BASIC",
      description: "",
      badge: "",
      sort_order: 0,
      options: [
        {
          ...plan("basic-month", 1500, 1, 1500),
          name: "BASIC",
          group_id: "basic",
        },
      ],
    });
    const select = vi.fn();
    render(
      <SubscriptionCatalog
        groups={catalog}
        disabled={false}
        onSelect={select}
      />,
    );
    fireEvent.click(
      screen.getByRole("tab", { name: "subscriptions.billingPeriodLabels.12" }),
    );
    expect(
      screen.queryByRole("article", { name: "BASIC" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("subscriptions.periodUnavailable"),
    ).not.toBeInTheDocument();
    expect(select).not.toHaveBeenCalled();
  });

  it("updates the selected amount when tiers differ between billing periods", () => {
    const catalog = groups();
    catalog[0].options = [
      catalog[0].options[0],
      catalog[0].options[1],
      catalog[0].options[2],
    ];
    const select = vi.fn();
    render(
      <SubscriptionCatalog
        groups={catalog}
        disabled={false}
        onSelect={select}
      />,
    );
    fireEvent.change(screen.getByRole("slider"), { target: { value: "1" } });
    fireEvent.click(
      screen.getByRole("tab", { name: "subscriptions.billingPeriodLabels.12" }),
    );
    expect(
      screen.getByText("subscriptions.billingTotal.12: CN¥360"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(select).toHaveBeenCalledWith(catalog[0].options[2]);
  });

  it.each([true, false])(
    "disables checkout for existing subscriptions or unavailable channels (%s)",
    (blocked) => {
      const catalog = groups();
      if (!blocked)
        catalog[0].options.forEach((p) =>
          p.offers.forEach((o) => (o.available = false)),
        );
      render(
        <SubscriptionCatalog
          groups={catalog}
          disabled={blocked}
          onSelect={vi.fn()}
        />,
      );
      expect(screen.getByRole("button")).toBeDisabled();
    },
  );

  it("shows every actual offer for legacy groups with disjoint billing periods", () => {
    const catalog = [
      {
        group_id: "basic",
        name: "BASIC",
        description: "",
        badge: "",
        sort_order: 0,
        options: [plan("basic-month", 1500, 1, 2900)],
      },
      {
        group_id: "pro",
        name: "PRO",
        description: "",
        badge: "",
        sort_order: 1,
        options: [plan("pro-quarter", 6000, 3, 18000)],
      },
      {
        group_id: "max",
        name: "MAX",
        description: "",
        badge: "",
        sort_order: 2,
        options: [plan("max-year", 12000, 12, 72000)],
      },
    ];
    const select = vi.fn();
    render(
      <SubscriptionCatalog
        groups={catalog}
        disabled={false}
        onSelect={select}
      />,
    );
    expect(
      screen.getByRole("tab", { name: "subscriptions.allPeriods" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(
      screen.queryByText("subscriptions.periodUnavailable"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("subscriptions.billingTotal.1: CN¥29"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("subscriptions.billingTotal.3: CN¥180"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("subscriptions.billingTotal.12: CN¥720"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getAllByRole("button", { name: "subscriptions.subscribe" })[1],
    );
    expect(select).toHaveBeenLastCalledWith(catalog[1].options[0]);
    fireEvent.click(
      screen.getByRole("tab", { name: "subscriptions.billingPeriodLabels.12" }),
    );
    expect(screen.getAllByRole("article")).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "subscriptions.subscribe" }),
    );
    expect(select).toHaveBeenLastCalledWith(catalog[2].options[0]);
  });

  it("shows monthly credits and the complete paid period credits for upfront delivery", () => {
    const catalog = groups();
    catalog[0].options = [
      { ...plan("annual", 1500, 12, 18000), grant_mode: "upfront" },
    ];
    render(
      <SubscriptionCatalog
        groups={catalog}
        disabled={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("1,500")).toBeInTheDocument();
    expect(screen.getByText("18,000")).toBeInTheDocument();
    expect(
      screen.getByText("subscriptions.grantModeShort.upfront"),
    ).toBeInTheDocument();
  });

  it("falls back to separate cards for legacy plans and respects configured group order", () => {
    const options = groups()[0].options;
    const grouped = groupSubscriptionPlans([
      { ...options[0], group_id: null, sort_order: 2 },
      { ...options[1], group_id: null, sort_order: 1 },
    ]);
    expect(grouped.map((g) => g.group_id)).toEqual([
      "pro-large-month",
      "pro-small-month",
    ]);
  });
});
