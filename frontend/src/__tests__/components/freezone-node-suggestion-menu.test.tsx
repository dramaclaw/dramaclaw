// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FreezoneNodeSuggestionMenu } from "@/features/superchat/FreezoneNodeSuggestionMenu";
import type { FreezoneNodeSuggestion } from "@/features/superchat/freezone-node-suggestions";

function makeItems(n: number): FreezoneNodeSuggestion[] {
  return Array.from({ length: n }, (_, i) => ({
    nodeId: `node-${i}`,
    column: "image" as const,
    title: `节点 ${i}`,
    thumbnailUrl: null,
    mediaUrl: null,
    keyElementCategory: null,
  }));
}

const noop = () => {};

beforeEach(() => {
  // jsdom 未实现 scrollIntoView；组件挂载会调用它。
  Element.prototype.scrollIntoView = vi.fn();
});

describe("<FreezoneNodeSuggestionMenu />", () => {
  it("renders only visibleCount rows", () => {
    render(
      <FreezoneNodeSuggestionMenu
        items={makeItems(50)}
        visibleCount={20}
        activeIndex={0}
        onActiveIndexChange={noop}
        onSelect={noop}
        onReachEnd={noop}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(20);
  });

  it("calls onSelect with the nodeId and title on click", () => {
    const onSelect = vi.fn();
    render(
      <FreezoneNodeSuggestionMenu
        items={makeItems(3)}
        visibleCount={20}
        activeIndex={0}
        onActiveIndexChange={noop}
        onSelect={onSelect}
        onReachEnd={noop}
      />,
    );
    fireEvent.click(screen.getByText("节点 1"));
    expect(onSelect).toHaveBeenCalledWith("node-1", "节点 1");
  });

  it("calls onReachEnd when scrolled near bottom and more items remain", () => {
    const onReachEnd = vi.fn();
    const { container } = render(
      <FreezoneNodeSuggestionMenu
        items={makeItems(50)}
        visibleCount={20}
        activeIndex={0}
        onActiveIndexChange={noop}
        onSelect={noop}
        onReachEnd={onReachEnd}
      />,
    );
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", { value: 400, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(scroller, "scrollTop", { value: 200, configurable: true });
    fireEvent.scroll(scroller);
    expect(onReachEnd).toHaveBeenCalled();
  });

  it("shows an empty state when there are no items", () => {
    render(
      <FreezoneNodeSuggestionMenu
        items={[]}
        visibleCount={20}
        activeIndex={0}
        onActiveIndexChange={noop}
        onSelect={noop}
        onReachEnd={noop}
      />,
    );
    expect(screen.getByText("没有匹配的节点")).toBeInTheDocument();
  });

  it("renders an <img> with the thumbnail src when thumbnailUrl is set", () => {
    const items: FreezoneNodeSuggestion[] = [
      { nodeId: "node-thumb", column: "image", title: "有缩略图", thumbnailUrl: "https://x/thumb.jpg", mediaUrl: null, keyElementCategory: null },
    ];
    const { container } = render(
      <FreezoneNodeSuggestionMenu
        items={items}
        visibleCount={20}
        activeIndex={0}
        onActiveIndexChange={noop}
        onSelect={noop}
        onReachEnd={noop}
      />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://x/thumb.jpg");
    expect(img?.getAttribute("alt")).toBe("");
  });

  it("marks the button at activeIndex as active", () => {
    render(
      <FreezoneNodeSuggestionMenu
        items={makeItems(3)}
        visibleCount={20}
        activeIndex={1}
        onActiveIndexChange={noop}
        onSelect={noop}
        onReachEnd={noop}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons[1].className).toContain("bg-white/[0.06]");
  });

  it("calls onActiveIndexChange with the hovered index", () => {
    const onActiveIndexChange = vi.fn();
    render(
      <FreezoneNodeSuggestionMenu
        items={makeItems(3)}
        visibleCount={20}
        activeIndex={0}
        onActiveIndexChange={onActiveIndexChange}
        onSelect={noop}
        onReachEnd={noop}
      />,
    );
    fireEvent.mouseEnter(screen.getByText("节点 2"));
    expect(onActiveIndexChange).toHaveBeenCalledWith(2);
  });
});
