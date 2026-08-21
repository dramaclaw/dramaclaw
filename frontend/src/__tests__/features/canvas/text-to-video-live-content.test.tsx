// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DefaultGraphContentResolver } from "@/features/canvas/application/graphContentResolver";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { TextAnnotationNode } from "@/features/canvas/nodes/TextAnnotationNode";
import { useCanvasStore } from "@/stores/canvasStore";

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>(
    "@xyflow/react",
  );
  return {
    ...actual,
    Handle: () => <div />,
    useReactFlow: () => ({
      getNode: () => null,
      getInternalNode: () => null,
      setCenter: vi.fn(),
    }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/canvas/ui/NodeHeader", () => ({
  NODE_HEADER_FLOATING_POSITION_CLASS: "",
  NodeHeader: () => <div />,
}));

vi.mock("@/features/canvas/ui/NodeResizeHandle", () => ({
  NodeResizeHandle: () => <div />,
}));

vi.mock(
  "@/features/canvas/ui/ProviderModelPicker",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/features/canvas/ui/ProviderModelPicker")
    >();
    return {
      ...actual,
      ProviderModelPicker: () => <div />,
    };
  },
);

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: () => ({ data: null, error: null }),
}));

vi.mock("@/lib/model-task-access", () => ({
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
}));

vi.mock("@/features/canvas/application/useNodeGenerationTaskState", () => ({
  useNodeGenerationTaskState: () => ({ isGenerating: false }),
}));

describe("text-to-video live content", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "text-1",
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 0, y: 0 },
          data: {
            content: "",
            model: "test-model",
            isGenerating: false,
          },
        },
      ],
      [],
    );
  });

  function renderTextNode() {
    render(
      <TextAnnotationNode
        id="text-1"
        type={CANVAS_NODE_TYPES.textAnnotation}
        data={{ content: "", model: "test-model", isGenerating: false }}
        selected
        dragging={false}
        draggable
        selectable
        deletable
        zIndex={0}
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />,
    );
  }

  function createTextToVideoGroup() {
    renderTextNode();
    fireEvent.click(screen.getByText("node.textNode.modes.textToVideo"));
    return useCanvasStore
      .getState()
      .nodes.find((node) => node.type === CANVAS_NODE_TYPES.video);
  }

  it("creates a connected video node without copying a prompt snapshot", () => {
    const videoNode = createTextToVideoGroup();

    const state = useCanvasStore.getState();
    expect(videoNode).toBeDefined();
    expect(videoNode?.data.genMode).toBe("textToVideo");
    expect(videoNode?.data.prompt).toBe("");
    expect(
      state.edges.some(
        (edge) => edge.source === "text-1" && edge.target === videoNode?.id,
      ),
    ).toBe(true);
  });

  it("resolves the latest text through the edge instead of a copied snapshot", () => {
    const videoNode = createTextToVideoGroup();
    expect(videoNode).toBeDefined();

    const resolver = new DefaultGraphContentResolver();
    useCanvasStore.getState().updateNodeData("text-1", { content: "第一版故事" });
    let state = useCanvasStore.getState();
    let inputs = resolver.collectInputContents(
      videoNode!.id,
      state.nodes,
      state.edges,
    );
    expect(inputs.map((input) => input.text).filter(Boolean)).toEqual(["第一版故事"]);

    useCanvasStore.getState().updateNodeData("text-1", { content: "修改后的故事" });
    state = useCanvasStore.getState();
    inputs = resolver.collectInputContents(
      videoNode!.id,
      state.nodes,
      state.edges,
    );
    expect(inputs.map((input) => input.text).filter(Boolean)).toEqual(["修改后的故事"]);
    expect(videoNode?.data.prompt).toBe("");
  });
});
