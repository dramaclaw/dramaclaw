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

vi.mock("@/features/canvas/ui/ProviderModelPicker", () => ({
  DEFAULT_SHARED_MODEL_ID: "test-model",
  ProviderModelPicker: () => <div />,
}));

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: () => ({ data: null, error: null }),
}));

vi.mock("@/features/canvas/application/useNodeGenerationTaskState", () => ({
  useNodeGenerationTaskState: () => ({ isGenerating: false }),
}));

describe("TextAnnotationNode clone-audio content", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "text-1",
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 0, y: 0 },
          data: {
            mode: "textToMusic",
            content: "原朗读文本",
            instruction: "AI 创作提示词",
          },
        },
        {
          id: "audio-1",
          type: CANVAS_NODE_TYPES.audio,
          position: { x: 500, y: 0 },
          data: { audioKind: "speech", audioUrl: null },
        },
      ],
      [
        {
          id: "text-to-audio",
          source: "text-1",
          target: "audio-1",
        },
      ],
    );
  });

  it("writes panel input to content and exposes it to the downstream audio node", () => {
    render(
      <TextAnnotationNode
        id="text-1"
        type={CANVAS_NODE_TYPES.textAnnotation}
        data={{
          mode: "textToMusic",
          content: "原朗读文本",
          instruction: "AI 创作提示词",
        }}
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

    fireEvent.change(screen.getByDisplayValue("原朗读文本"), {
      target: { value: "新的朗读文本" },
    });

    const state = useCanvasStore.getState();
    const textNode = state.nodes.find((node) => node.id === "text-1");
    expect(textNode?.data.content).toBe("新的朗读文本");
    expect(textNode?.data.instruction).toBe("AI 创作提示词");

    const inputs = new DefaultGraphContentResolver().collectInputContents(
      "audio-1",
      state.nodes,
      state.edges,
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.text).toBe("新的朗读文本");
  });
});
