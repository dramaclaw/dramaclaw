// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { returnObjects?: boolean }) => {
      if (key === "aiAssistant.waitingResponses" && options?.returnObjects) {
        return ["Understanding the request", "Reviewing the context"];
      }
      if (key === "aiAssistant.waitingLongResponse") return "Processing more context";
      if (key === "aiAssistant.waitingVeryLongResponse") return "Still waiting for a response";
      return key;
    },
  }),
}));

import { ComposerWaitingStatus } from "@/features/superchat/composer-waiting-status";

describe("ComposerWaitingStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("delays entry, keeps the activity wave running, then switches between persistent text slots", () => {
    const { container } = render(<ComposerWaitingStatus label="Waiting" visible />);

    expect(screen.queryByText("Understanding the request")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(350));
    const firstLabel = screen.getByText("Understanding the request");
    expect(firstLabel.parentElement).toHaveClass("opacity-0");

    act(() => vi.advanceTimersByTime(100));
    expect(firstLabel.parentElement).toHaveClass("opacity-100");
    expect(container.querySelectorAll('[class*="wave_2.2s"]')).toHaveLength(3);

    act(() => vi.advanceTimersByTime(3380));
    expect(screen.getAllByText("Reviewing the context")).toHaveLength(1);
    expect(screen.getByLabelText("Understanding the request")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(120));
    expect(container.querySelectorAll('[class*="wave_2.2s"]')).toHaveLength(3);
    expect(screen.getByText("Understanding the request")).toHaveClass("opacity-0");
    expect(screen.getByText("Reviewing the context")).toHaveClass("opacity-100", "delay-[60ms]");

    act(() => vi.advanceTimersByTime(440));
    expect(screen.getByLabelText("Reviewing the context")).toBeInTheDocument();
  });

  it("skips motion phases when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    render(<ComposerWaitingStatus label="Waiting" visible />);

    act(() => vi.advanceTimersByTime(350));

    expect(screen.getByLabelText("Understanding the request")).toBeInTheDocument();
    expect(screen.getByText("Understanding the request")).toHaveClass("opacity-100");
  });

  it("settles on the long-wait label without changing the wave speed", () => {
    const { container } = render(<ComposerWaitingStatus label="Waiting" visible />);

    act(() => vi.advanceTimersByTime(9950));

    expect(screen.getByLabelText("Processing more context")).toBeInTheDocument();
    expect(container.querySelectorAll('[class*="wave_2.2s"]')).toHaveLength(3);
  });

  it("acknowledges a very long wait without changing the wave speed", () => {
    const { container } = render(<ComposerWaitingStatus label="Waiting" visible />);

    act(() => vi.advanceTimersByTime(42510));

    expect(screen.getByLabelText("Still waiting for a response")).toBeInTheDocument();
    expect(container.querySelectorAll('[class*="wave_2.2s"]')).toHaveLength(3);
  });
});
