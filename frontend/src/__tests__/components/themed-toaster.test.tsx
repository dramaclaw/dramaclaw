// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeState = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: routeState.pathname } }),
}));

vi.mock("sonner", () => ({
  Toaster: ({ offset }: { offset: number }) => (
    <div data-testid="toaster" data-offset={offset} />
  ),
}));

import { ThemedToaster } from "@/components/themed-toaster";

describe("ThemedToaster", () => {
  beforeEach(() => {
    routeState.pathname = "/";
  });

  it.each([
    ["/", "60"],
    ["/projects/demo/freezone", "60"],
    ["/projects/demo/characters", "102"],
    ["/login", "24"],
    ["/watch/demo", "24"],
  ])("uses the safe top offset for %s", (pathname, expectedOffset) => {
    routeState.pathname = pathname;
    render(<ThemedToaster />);
    expect(screen.getByTestId("toaster")).toHaveAttribute(
      "data-offset",
      expectedOffset,
    );
  });
});
