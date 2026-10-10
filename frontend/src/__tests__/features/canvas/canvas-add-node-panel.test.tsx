// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { canvasEventBus } from "@/features/canvas/application/canvasServices";
import { CanvasAddNodePanel } from "@/features/canvas/ui/CanvasAddNodePanel";

const translations: Record<string, string> = {
  "node.menu.sectionAddNode": "添加节点",
  "node.menu.sectionAddResource": "添加资源",
  "node.menu.sectionSkillNode": "技能节点",
  "node.menu.uploadImage": "上传资源",
  "node.menu.image": "图片",
  "node.menu.aiImageGeneration": "AI 图片",
  "node.menu.storyboard": "分格抽取结果",
  "node.menu.storyboardGen": "多版本宫格",
  "node.menu.beatContext": "镜头上下文",
  "node.menu.textAnnotation": "文本",
  "node.menu.video": "视频",
  "node.menu.audio": "音频",
  "node.menu.videoStory": "视频故事",
  "node.menu.videoCompose": "视频合成",
  "node.menu.script": "脚本",
  "node.menu.interactiveStory": "互动影游",
  "node.menu.interactiveAd": "互动广告",
  "node.menu.pano360Viewer": "360° 全景",
  "node.menu.threeDWorld": "3D 世界",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

describe("CanvasAddNodePanel", () => {
  it.each([
    ["互动影游", "interactive-story"],
    ["互动广告", "interactive-ad"],
  ])("dispatches %s without creating a standalone node", async (label, actionId) => {
    const onSelectNode = vi.fn();
    const onClose = vi.fn();
    const listener = vi.fn();
    const unsubscribe = canvasEventBus.subscribe("freezone/start-creation", listener);
    try {
      render(<CanvasAddNodePanel skillItems={[]} onSelectNode={onSelectNode} onSelectSkill={vi.fn()} onClose={onClose} />);
      await userEvent.setup().click(screen.getByRole("button", { name: label }));
      expect(listener).toHaveBeenCalledExactlyOnceWith({ actionId });
      expect(onClose).toHaveBeenCalledOnce();
      expect(onSelectNode).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("shows standalone shot context in the quick add panel", async () => {
    const user = userEvent.setup();
    const onSelectNode = vi.fn();
    const onClose = vi.fn();

    render(
      <CanvasAddNodePanel skillItems={[]} onSelectNode={onSelectNode} onSelectSkill={vi.fn()} onClose={onClose} />,
    );

    await user.click(screen.getByRole("button", { name: /镜头上下文/ }));

    expect(onSelectNode).toHaveBeenCalledWith(CANVAS_NODE_TYPES.beatContext);
    expect(onClose).toHaveBeenCalled();
  });
});
