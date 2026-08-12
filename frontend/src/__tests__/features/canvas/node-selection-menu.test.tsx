// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { getDownstreamSpawnTypes } from "@/features/canvas/domain/nodeRegistry";
import { NodeSelectionMenu } from "@/features/canvas/NodeSelectionMenu";

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
  "node.menu.pano360Viewer": "360° 全景",
  "node.menu.threeDWorld": "3D 世界",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

describe("NodeSelectionMenu", () => {
  it("shows standalone shot context in the add-node menu", () => {
    render(
      <NodeSelectionMenu
        position={{ x: 12, y: 16 }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("镜头上下文")).toBeInTheDocument();
  });

  it("offers 逐帧拉片 when dragging a line out of a video node", () => {
    // 「引用该节点生成」的条目是手写的，白名单放行了但这里漏写条目的类型会被静默
    // 吞掉 —— 从真实的下游候选喂进去，漏项就在这里红。
    const allowedTypes = getDownstreamSpawnTypes(CANVAS_NODE_TYPES.video);
    expect(allowedTypes).toContain(CANVAS_NODE_TYPES.videoBreakdown);

    render(
      <NodeSelectionMenu
        position={{ x: 12, y: 16 }}
        allowedTypes={allowedTypes}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("引用该节点生成")).toBeInTheDocument();
    expect(screen.getByText("逐帧拉片")).toBeInTheDocument();
  });
});
