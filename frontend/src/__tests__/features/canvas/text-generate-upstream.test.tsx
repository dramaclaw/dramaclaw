// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { submitFreezoneTextGenerate } from "@/api/ops";
import {
  CANVAS_NODE_TYPES,
  isTextAnnotationNode,
  type CanvasNode,
  type TextNodeMode,
} from "@/features/canvas/domain/canvasNodes";
import { TextAnnotationNode } from "@/features/canvas/nodes/TextAnnotationNode";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { useCanvasStore } from "@/stores/canvasStore";

vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xyflow/react")>()),
  Handle: () => <div />,
  useReactFlow: () => ({
    getNode: () => null,
    getInternalNode: () => null,
    setCenter: vi.fn(),
  }),
}));
vi.mock("@/features/canvas/ui/NodeHeader", () => ({
  NODE_HEADER_FLOATING_POSITION_CLASS: "",
  NodeHeader: () => <div />,
}));
vi.mock("@/features/canvas/ui/NodeResizeHandle", () => ({ NodeResizeHandle: () => <div /> }));
vi.mock("@/features/canvas/ui/ProviderModelPicker", () => ({
  DEFAULT_SHARED_MODEL_ID: "test-model",
  ProviderModelPicker: () => <div />,
}));
vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: vi.fn(() => ({ data: null, error: null })),
}));
vi.mock("@/lib/model-task-access", () => ({
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
}));
vi.mock("@/features/canvas/application/useNodeGenerationTaskState", () => ({
  useNodeGenerationTaskState: () => ({ isGenerating: false }),
}));
vi.mock("@/api/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/ops")>()),
  submitFreezoneTextGenerate: vi.fn(),
  fetchFreezoneTextGenerateResult: vi.fn(async () => ({
    generated_text: "续写后的正文",
    model: "test-model",
  })),
}));
vi.mock("@/api/tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/tasks")>()),
  awaitTaskCompletion: vi.fn(async () => ({})),
}));
vi.mock("@/lib/url-params", () => ({
  readUrl: () => ({ project: "project-1", canvas: "canvas-1" }),
}));

function TargetNode() {
  const node = useCanvasStore((state) =>
    state.nodes.find((candidate) => candidate.id === "target"),
  );
  if (!node || !isTextAnnotationNode(node)) throw new Error("Missing target text node");
  return (
    <TextAnnotationNode
      id={node.id}
      type={node.type}
      data={node.data}
      selected
      dragging={false}
      draggable
      selectable
      deletable
      zIndex={0}
      isConnectable
      positionAbsoluteX={0}
      positionAbsoluteY={0}
    />
  );
}

function seed(mode: TextNodeMode = "writing", upstream = "上游正文") {
  useCanvasStore.getState().setCanvasData(
    [
      {
        id: "source",
        type: CANVAS_NODE_TYPES.textAnnotation,
        position: { x: 0, y: 0 },
        data: { content: upstream },
      },
      {
        id: "target",
        type: CANVAS_NODE_TYPES.textAnnotation,
        position: { x: 500, y: 0 },
        data: { mode, content: "下游旧正文", instruction: " 根据上游续写 " },
      },
    ],
    [{ id: "source-target", source: "source", target: "target" }],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(toast, "error").mockReturnValue("test-toast");
  vi.mocked(submitFreezoneTextGenerate).mockResolvedValue({
    job_id: "job-1",
    task_key: "task-1",
    task_type: "freezone_text_generate",
  });
});

describe("TextAnnotationNode upstream text generation", () => {
  it.each<TextNodeMode>(["writing", "textToVideo"])(
    "%s submits upstream content with the instruction and replaces only its own content",
    async (mode) => {
      seed(mode);
      render(<TargetNode />);
      expect(useGenerationCreditCost).toHaveBeenLastCalledWith("feature", "freezone.text_generate", {
        surface: "canvas",
        quantity: 10,
        params: { operation: "text_generate", billable_chars: 10, pricing_quantity: 10 },
      });
      fireEvent.click(screen.getByTitle("AI 生成文本"));
      await waitFor(() => expect(submitFreezoneTextGenerate).toHaveBeenCalledWith("project-1", {
        prompt: "上游正文\n\n根据上游续写", canvasId: "canvas-1", nodeId: "target",
      }));
      await waitFor(() => {
        const target = useCanvasStore.getState().nodes.find((node) => node.id === "target");
        expect(target?.data).toMatchObject({
          content: "续写后的正文",
          instruction: " 根据上游续写 ",
        });
      });
      expect(useCanvasStore.getState().nodes.find((node) => node.id === "source")?.data.content).toBe("上游正文");
    },
  );

  it.each(["disconnected", "blank"])("%s upstream keeps the instruction-only prompt", async (kind) => {
    seed("writing", kind === "blank" ? "  \n " : "上游正文");
    if (kind === "disconnected") {
      const state = useCanvasStore.getState();
      state.setCanvasData(state.nodes, []);
    }
    render(<TargetNode />);
    fireEvent.click(screen.getByTitle("AI 生成文本"));
    await waitFor(() => expect(submitFreezoneTextGenerate).toHaveBeenCalledWith("project-1", {
      prompt: "根据上游续写", canvasId: "canvas-1", nodeId: "target",
    }));
  });

  it("joins direct upstream bodies in edge order and skips execution dependencies", async () => {
    seed();
    const state = useCanvasStore.getState();
    const textNode = (id: string, content: string): CanvasNode => ({
      id, type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content },
    });
    state.setCanvasData(
      [
        ...state.nodes,
        textNode("second", " 第二段 "),
        textNode("dependency", "不应读入的执行依赖"),
        textNode("ancestor", "不应递归读入的正文"),
      ],
      [
        { id: "second-target", source: "second", target: "target" },
        ...state.edges,
        {
          id: "dependency-target",
          source: "dependency",
          target: "target",
          data: { link_type: "dependency_for" },
        },
        { id: "ancestor-source", source: "ancestor", target: "source" },
      ],
    );
    render(<TargetNode />);
    fireEvent.click(screen.getByTitle("AI 生成文本"));
    await waitFor(() => expect(submitFreezoneTextGenerate).toHaveBeenCalledWith("project-1", {
      prompt: "第二段\n\n上游正文\n\n根据上游续写", canvasId: "canvas-1", nodeId: "target",
    }));
  });

  it("uses the updated upstream body on the next generation", async () => {
    seed();
    render(<TargetNode />);
    fireEvent.click(screen.getByTitle("AI 生成文本"));
    await waitFor(() => {
      const target = useCanvasStore.getState().nodes.find((node) => node.id === "target");
      expect(target?.data.content).toBe("续写后的正文");
    });
    act(() => useCanvasStore.getState().updateNodeData("source", { content: "修改后的上游正文" }));
    fireEvent.click(screen.getByTitle("AI 生成文本"));
    await waitFor(() => expect(submitFreezoneTextGenerate).toHaveBeenLastCalledWith("project-1", {
      prompt: "修改后的上游正文\n\n根据上游续写", canvasId: "canvas-1", nodeId: "target",
    }));
  });

  it("requires an instruction even when upstream text exists", () => {
    seed();
    useCanvasStore.getState().updateNodeData("target", { instruction: "  " });
    render(<TargetNode />);
    expect(screen.getByTitle("AI 生成文本")).toBeDisabled();
    expect(submitFreezoneTextGenerate).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes.find((node) => node.id === "target")?.data.content).toBe("下游旧正文");
  });

  it("rejects an oversized combined prompt without truncating the source or submitting", () => {
    seed("writing", "😀".repeat(19999));
    useCanvasStore.getState().updateNodeData("target", { instruction: "继续" });
    render(<TargetNode />);
    fireEvent.click(screen.getByTitle("AI 生成文本"));
    expect(toast.error).toHaveBeenCalledWith("创作要求与上游正文合计超过 20000 字，请缩短内容后重试。");
    expect(submitFreezoneTextGenerate).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes.find((node) => node.id === "target")?.data.content).toBe("下游旧正文");
    expect(useCanvasStore.getState().nodes.find((node) => node.id === "source")?.data.content).toBe("😀".repeat(19999));
  });

  it("accepts exactly 20000 Unicode codepoints without treating surrogate pairs as extra characters", async () => {
    seed("writing", "😀".repeat(19996));
    useCanvasStore.getState().updateNodeData("target", { instruction: "继续" });
    render(<TargetNode />);
    fireEvent.click(screen.getByTitle("AI 生成文本"));
    await waitFor(() => expect(submitFreezoneTextGenerate).toHaveBeenCalledWith("project-1", {
      prompt: "😀".repeat(19996) + "\n\n继续", canvasId: "canvas-1", nodeId: "target",
    }));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
