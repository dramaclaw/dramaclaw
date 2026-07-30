// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreditCostInline } from "@/components/credit-cost-inline";

const runtimeState = vi.hoisted(() => ({ isCeRuntime: false }));

vi.mock("@/lib/runtime-config", () => ({
  isCeRuntime: () => runtimeState.isCeRuntime,
}));

describe("CreditCostInline CE gating", () => {
  beforeEach(() => {
    runtimeState.isCeRuntime = false;
  });

  it("renders generation cost in EE runtime", () => {
    render(<CreditCostInline display="12" />);

    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("strikes the original cost when a promotion is active", () => {
    render(
      <CreditCostInline
        display="12→9"
        promotion={{
          name: "暑期优惠",
          discount_basis_points: 8000,
          ends_at: "2026-08-31T15:59:59+00:00",
        }}
      />,
    );

    expect(screen.getByText("12")).toHaveClass("line-through");
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.getByText("限时 8 折")).toHaveAttribute("title", "暑期优惠");
  });

  it("shows a generic promotion label when promotion metadata is unavailable", () => {
    render(<CreditCostInline display="8→6" />);

    expect(screen.getByText("促销中")).toBeInTheDocument();
  });

  it("renders nothing in CE runtime", () => {
    runtimeState.isCeRuntime = true;

    const { container } = render(<CreditCostInline display="12" />);

    expect(screen.queryByText("12")).not.toBeInTheDocument();
    expect(container.firstChild).toBeNull();
  });
});
