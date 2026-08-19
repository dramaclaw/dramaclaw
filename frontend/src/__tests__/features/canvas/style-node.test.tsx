// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FreezoneStyleTemplate } from "@/api/ops";
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from "@/features/canvas/domain/canvasNodes";
import { StyleNode } from "@/features/canvas/nodes/StyleNode";
import { useCanvasStore } from "@/stores/canvasStore";

const TEMPLATES: FreezoneStyleTemplate[] = [
  {
    id: "golden_age",
    label: "黄金时代",
    category: "年代",
    cover: "golden_age/cover.webp",
    samples: ["golden_age/female.webp"],
    style_prompt: "黄金时代的提示词",
  },
  {
    id: "cyberpunk",
    label: "赛博朋克",
    category: "科幻",
    cover: "cyberpunk/cover.webp",
    samples: ["cyberpunk/female.webp"],
    style_prompt: "赛博朋克的提示词",
  },
];

vi.mock("@xyflow/react", async () => {
  const actual =
    await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    Handle: ({ id, type }: { id?: string; type?: string }) => (
      <div data-testid={`handle-${type ?? "unknown"}-${id ?? "default"}`} />
    ),
  };
});

vi.mock("@/features/canvas/ui/NodeHeader", () => ({
  NODE_HEADER_FLOATING_POSITION_CLASS: "",
  NodeHeader: ({ titleText }: { titleText: string }) => <div>{titleText}</div>,
}));

vi.mock("@/features/canvas/hooks/useFreezoneStyleTemplates", () => ({
  useFreezoneStyleTemplates: () => ({
    templates: TEMPLATES,
    assetBase: "",
    isLoading: false,
    error: null,
    retry: () => {},
  }),
}));

function seedCanvas(options: { withImageNode: boolean; templateId: string | null }) {
  const nodes: CanvasNode[] = [
    {
      id: "style_1",
      type: CANVAS_NODE_TYPES.style,
      position: { x: 0, y: 0 },
      data: { styleTemplateId: options.templateId },
    } as CanvasNode,
  ];
  const edges: CanvasEdge[] = [];
  if (options.withImageNode) {
    nodes.push({
      id: "image_1",
      type: CANVAS_NODE_TYPES.imageGen,
      position: { x: 400, y: 0 },
      data: { styleTemplateId: options.templateId, prompt: "" },
    } as CanvasNode);
    edges.push({
      id: "e-style_1-image_1",
      source: "style_1",
      target: "image_1",
    } as CanvasEdge);
  }
  useCanvasStore.getState().setCanvasData(nodes, edges);
}

function renderStyleNode(templateId: string | null) {
  const node = useCanvasStore.getState().nodes.find((item) => item.id === "style_1");
  return render(
    <StyleNode
      id="style_1"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {...({ type: CANVAS_NODE_TYPES.style, dragging: false, zIndex: 0 } as any)}
      data={(node?.data as { styleTemplateId: string | null }) ?? { styleTemplateId: templateId }}
    />,
  );
}

describe("StyleNode", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("卡片只放封面，风格名走节点标题", () => {
    seedCanvas({ withImageNode: true, templateId: "golden_age" });
    renderStyleNode("golden_age");

    expect(screen.getByAltText("黄金时代")).toHaveAttribute(
      "src",
      "/style-gallery/golden_age/cover.webp",
    );
    // 标题带上分类，换风格时跟着变；卡片里不再有第二处风格名。
    expect(screen.getByText("风格 · 年代 · 黄金时代")).toBeInTheDocument();
    expect(screen.queryByText("黄金时代")).not.toBeInTheDocument();
  });

  it("用户改过名字后标题不被风格覆盖", () => {
    seedCanvas({ withImageNode: true, templateId: "golden_age" });
    render(
      <StyleNode
        id="style_1"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {...({ type: CANVAS_NODE_TYPES.style, dragging: false, zIndex: 0 } as any)}
        data={{ styleTemplateId: "golden_age", displayName: "主视觉风格" }}
      />,
    );

    expect(screen.getByText("主视觉风格")).toBeInTheDocument();
  });

  it("writes the picked style to the downstream image node, not to itself", async () => {
    const user = userEvent.setup();
    seedCanvas({ withImageNode: true, templateId: "golden_age" });
    renderStyleNode("golden_age");

    await user.click(screen.getByRole("button", { name: "风格 黄金时代" }));
    await user.click(screen.getByRole("button", { name: "使用赛博朋克" }));

    const nodes = useCanvasStore.getState().nodes;
    // 真源是图片节点；风格节点自己的数据由图片节点那边的对账拉齐，这里不自写。
    expect(
      (nodes.find((node) => node.id === "image_1")?.data as { styleTemplateId?: string })
        ?.styleTemplateId,
    ).toBe("cyberpunk");
    expect(
      (nodes.find((node) => node.id === "style_1")?.data as { styleTemplateId?: string })
        ?.styleTemplateId,
    ).toBe("golden_age");
  });

  it("clearing the style in the gallery clears the downstream image node", async () => {
    const user = userEvent.setup();
    seedCanvas({ withImageNode: true, templateId: "golden_age" });
    renderStyleNode("golden_age");

    await user.click(screen.getByRole("button", { name: "风格 黄金时代" }));
    await user.click(screen.getByRole("button", { name: "清除风格" }));

    expect(
      (
        useCanvasStore
          .getState()
          .nodes.find((node) => node.id === "image_1")?.data as {
          styleTemplateId?: string | null;
        }
      )?.styleTemplateId,
    ).toBeNull();
  });

  it("右上角的按钮能打开图墙", async () => {
    const user = userEvent.setup();
    seedCanvas({ withImageNode: true, templateId: "golden_age" });
    renderStyleNode("golden_age");

    await user.click(screen.getByRole("button", { name: "更换风格" }));

    expect(
      screen.getByRole("button", { name: "查看赛博朋克详情" }),
    ).toBeInTheDocument();
  });

  it("stays inert when no image node consumes it", async () => {
    const user = userEvent.setup();
    seedCanvas({ withImageNode: false, templateId: "golden_age" });
    renderStyleNode("golden_age");

    expect(screen.getByText("未连接图片节点")).toBeInTheDocument();
    // 写不到任何地方，入口按钮也不该露出来。
    expect(screen.queryByRole("button", { name: "更换风格" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "风格 黄金时代" }));
    // 图墙不该打开 —— 没有下游图片节点时改风格写不到任何地方。
    expect(
      screen.queryByRole("button", { name: "查看赛博朋克详情" }),
    ).not.toBeInTheDocument();
  });
});
