// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { SlidingTabs, type SlidingTabItem } from "@/components/nav/sliding-tabs";

type TabValue = "script" | "shots" | "compose";

const items: SlidingTabItem<TabValue>[] = [
  { value: "script", label: "Script" },
  { value: "shots", label: "Shots" },
  { value: "compose", label: "Compose" },
];

function SlidingTabsHarness() {
  const [value, setValue] = useState<TabValue>("script");
  return (
    <SlidingTabs
      items={items}
      value={value}
      onValueChange={setValue}
      aria-label="Episode sections"
    />
  );
}

describe("SlidingTabs", () => {
  it("updates the active tab on click", () => {
    render(<SlidingTabsHarness />);

    const script = screen.getByRole("tab", { name: "Script" });
    const shots = screen.getByRole("tab", { name: "Shots" });

    expect(script).toHaveAttribute("aria-selected", "true");
    expect(shots).toHaveAttribute("aria-selected", "false");

    fireEvent.click(shots);
    expect(shots).toHaveAttribute("aria-selected", "true");
    expect(script).toHaveAttribute("aria-selected", "false");
  });

  it("optimistically updates the active tab before the controlled value changes", () => {
    const onValueChange = vi.fn();
    render(
      <SlidingTabs
        items={items}
        value="script"
        onValueChange={onValueChange}
        aria-label="Episode sections"
      />,
    );

    const shots = screen.getByRole("tab", { name: "Shots" });
    fireEvent.click(shots);

    expect(onValueChange).toHaveBeenCalledWith("shots");
    expect(shots).toHaveAttribute("aria-selected", "true");
  });

  it("follows controlled value changes from its parent", () => {
    const { rerender } = render(
      <SlidingTabs
        items={items}
        value="script"
        onValueChange={vi.fn()}
        aria-label="Episode sections"
      />,
    );

    rerender(
      <SlidingTabs
        items={items}
        value="compose"
        onValueChange={vi.fn()}
        aria-label="Episode sections"
      />,
    );

    expect(screen.getByRole("tab", { name: "Compose" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Script" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("marks only the newly activated icon for optional micro-motion", () => {
    render(
      <SlidingTabs
        items={items}
        value="script"
        onValueChange={vi.fn()}
        animateActiveIcon
        aria-label="Episode sections"
      />,
    );

    const script = screen.getByRole("tab", { name: "Script" });
    const shots = screen.getByRole("tab", { name: "Shots" });
    expect(script).toHaveAttribute("data-icon-animate", "false");

    fireEvent.click(shots);
    expect(shots).toHaveAttribute("data-icon-animate", "true");
    expect(script).toHaveAttribute("data-icon-animate", "false");
  });
});
