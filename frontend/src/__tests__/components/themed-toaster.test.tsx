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
  Toaster: ({
    offset,
    position,
    toastOptions,
  }: {
    offset: { top: number };
    position: string;
    toastOptions?: { classNames?: { description?: string } };
  }) => (
    <div
      data-testid="toaster"
      data-offset={offset.top}
      data-position={position}
      data-description-class={toastOptions?.classNames?.description}
    />
  ),
}));

import { ThemedToaster } from "@/components/themed-toaster";

describe("ThemedToaster", () => {
  beforeEach(() => {
    routeState.pathname = "/";
  });

  it.each([
    ["/", "60"],
    ["/projects/demo/freezone", "102"],
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
    expect(screen.getByTestId("toaster")).toHaveAttribute("data-position", "top-left");
  });

  it("keeps line breaks in toast descriptions", () => {
    render(<ThemedToaster />);
    expect(screen.getByTestId("toaster")).toHaveAttribute(
      "data-description-class",
      expect.stringContaining("whitespace-pre-line"),
    );
  });
});
