// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PikoMapTransition,
  PIKO_MAP_TRANSITION_TIMING,
} from "./PikoMapTransition";

function setReducedMotion(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  setReducedMotion(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("<PikoMapTransition />", () => {
  it("covers loading, reveals the title when ready, then leaves the map", () => {
    const onComplete = vi.fn();
    const { container, rerender } = render(
      <PikoMapTransition
        mapId="welcome-courtyard"
        loadState="loading"
        onComplete={onComplete}
      />,
    );

    const transition = screen.getByRole("status");
    expect(transition).toHaveAttribute("data-phase", "covered");
    expect(transition).toHaveClass("fixed", "inset-0", "backdrop-blur-md");
    expect(transition).toHaveClass("bg-[#17281e]/80");
    expect(container.querySelector("img")).toHaveClass(
      "max-h-[24vh]",
      "lg:w-[min(33.6vw,33.6rem)]",
    );

    rerender(
      <PikoMapTransition
        mapId="welcome-courtyard"
        loadState="ready"
        onComplete={onComplete}
      />,
    );
    expect(screen.getByRole("status")).toHaveAttribute("data-phase", "showing");

    act(() => vi.advanceTimersByTime(PIKO_MAP_TRANSITION_TIMING.holdMs));
    expect(screen.getByRole("status")).toHaveAttribute("data-phase", "revealing");

    act(() => vi.advanceTimersByTime(PIKO_MAP_TRANSITION_TIMING.exitMs));
    expect(screen.queryByRole("status")).toBeNull();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("does not trap the map error behind the black cover", () => {
    const onComplete = vi.fn();
    render(
      <PikoMapTransition
        mapId="welcome-courtyard"
        loadState="error"
        onComplete={onComplete}
      />,
    );

    expect(screen.queryByRole("status")).toBeNull();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("uses a short static hold when reduced motion is requested", () => {
    setReducedMotion(true);
    const onComplete = vi.fn();
    render(
      <PikoMapTransition
        mapId="welcome-courtyard"
        loadState="ready"
        onComplete={onComplete}
      />,
    );

    expect(screen.getByRole("status")).toHaveAttribute("data-phase", "showing");
    act(() =>
      vi.advanceTimersByTime(PIKO_MAP_TRANSITION_TIMING.reducedMotionHoldMs),
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
