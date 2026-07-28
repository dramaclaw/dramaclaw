// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasQuickActionBar } from "@/features/canvas/ui/CanvasQuickActionBar";
import { useCanvasToolStore } from "@/features/canvas/ui/canvasToolStore";

const translations: Record<string, string> = {
  "canvas.quickbar.addNode": "添加节点",
  "canvas.quickbar.history": "历史资产",
  "canvas.quickbar.shortcuts": "快捷键",
  "canvas.quickbar.help": "帮助",
  "canvas.quickbar.viewManual": "查看手册",
  "canvas.toolbar.toolMove": "移动",
  "canvas.toolbar.toolHand": "抓手工具",
  "canvas.toolbar.toolGroupLabel": "画布指针工具",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => translations[key] ?? key }),
}));

// 这三个面板只有点开对应入口才渲染，但 import 链会把 three.js / 画布 store 一起拖进
// jsdom。这里只测工具菜单，直接替身掉。
vi.mock("@/features/canvas/ui/CanvasAddNodePanel", () => ({
  CanvasAddNodePanel: () => <div data-testid="add-node-panel" />,
}));
vi.mock("@/features/canvas/ui/CanvasShortcutsPanel", () => ({
  CanvasShortcutsPanel: () => <div data-testid="shortcuts-panel" />,
}));
vi.mock("@/features/canvas/ui/CanvasHistoryAssetsModal", () => ({
  CanvasHistoryAssetsModal: () => <div data-testid="history-modal" />,
}));

function renderBar() {
  render(
    <CanvasQuickActionBar
      skillItems={[]}
      onAddNode={vi.fn()}
      onAddSkill={vi.fn()}
      onUseAsset={vi.fn()}
      onDeleteNode={vi.fn()}
    />,
  );
  return screen.getByRole("button", { name: "画布指针工具" });
}

describe("画布底部工具栏 — 移动 / 抓手工具", () => {
  beforeEach(() => {
    useCanvasToolStore.setState({ tool: "move" });
  });

  it("默认是移动工具", () => {
    expect(useCanvasToolStore.getState().tool).toBe("move");
  });

  it("点开工具按钮弹出两行菜单，选抓手把画布切到抓手模式并收起菜单", async () => {
    const user = userEvent.setup();
    const toolButton = renderBar();

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(toolButton);
    const menu = screen.getByRole("menu", { name: "画布指针工具" });
    expect(menu).toBeInTheDocument();

    const move = screen.getByRole("menuitemradio", { name: /移动/ });
    const hand = screen.getByRole("menuitemradio", { name: /抓手工具/ });
    expect(move).toHaveAttribute("aria-checked", "true");
    expect(hand).toHaveAttribute("aria-checked", "false");

    await user.click(hand);
    expect(useCanvasToolStore.getState().tool).toBe("hand");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("菜单里能切回移动工具", async () => {
    const user = userEvent.setup();
    useCanvasToolStore.setState({ tool: "hand" });
    const toolButton = renderBar();

    await user.click(toolButton);
    await user.click(screen.getByRole("menuitemradio", { name: /移动/ }));
    expect(useCanvasToolStore.getState().tool).toBe("move");
  });

  // 菜单收起后，按钮本身是「现在是不是抓手」的唯一提示。
  it("抓手模式下按钮的悬浮提示报抓手和它的快捷键", async () => {
    const user = userEvent.setup();
    const toolButton = renderBar();

    expect(screen.getByText("移动 V")).toBeInTheDocument();

    await user.click(toolButton);
    await user.click(screen.getByRole("menuitemradio", { name: /抓手工具/ }));

    expect(screen.getByText("抓手工具 H")).toBeInTheDocument();
    expect(screen.queryByText("移动 V")).not.toBeInTheDocument();
  });
});
