// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// mention 重编号（useReferenceMentionSync）的基线必须与引用列表同源：
// VideoNode 的 data prop 经 React Flow 内部转发，在「原子剥离 [FMV自动承接] +
// 删尾帧边」那一帧可能仍是旧 prompt，拿迟到的副本 remap 会把被剥掉的段落写回
// store（体感：连线没了但文字还在，再切换一次才消失）。这里锁两件事：
//   1. 行为：与 store 同源的基线在原子切换后不会复活旧文本，纯删边仍会正常重编号；
//   2. 接线：VideoNode 把 store 最新 prompt（而非 data prop 的 `prompt`）传给 sync。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, renderHook } from "@testing-library/react";
import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { beforeEach, describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { useReferenceMentionSync } from "@/features/canvas/nodes/useReferenceMentionSync";
import { useCanvasStore } from "@/stores/canvasStore";

/** 复刻 VideoNode 修复后的接线：prompt 与引用 ids 都直接订阅 canvasStore。 */
function harness(id: string) {
  return renderHook(() => {
    const prompt = useCanvasStore((state) => {
      const node = state.nodes.find((candidate) => candidate.id === id);
      return typeof node?.data.prompt === "string" ? (node.data.prompt as string) : "";
    });
    const ids = useCanvasStore(
      useShallow((state) =>
        state.edges
          .filter((edge) => edge.target === id)
          .map((edge) => edge.source)
          .filter((source) => state.nodes.some((node) => node.id === source && node.type === CANVAS_NODE_TYPES.imageGen)),
      ),
    );
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const apply = useCallback(
      (next: string) => updateNodeData(id, { prompt: next }),
      [id, updateNodeData],
    );
    useReferenceMentionSync(prompt, [{ prefix: "图片", ids }], apply);
    return { prompt };
  });
}

function promptOf(id: string): string {
  return String(useCanvasStore.getState().nodes.find((node) => node.id === id)?.data.prompt);
}

describe("prompt mention sync source (FMV independent cleanup race)", () => {
  beforeEach(() => {
    useCanvasStore.setState({ nodes: [], edges: [] });
  });

  it("does not resurrect the stripped continuity note when the store cleanup fires", () => {
    const store = useCanvasStore.getState();
    const character = store.addNode(CANVAS_NODE_TYPES.imageGen, { x: 0, y: 400 }, {
      displayName: "主角小林", referenceImageUrl: "/static/character.png",
    });
    const frame = store.addNode(CANVAS_NODE_TYPES.imageGen, { x: 0, y: 500 }, {
      displayName: "尾帧", referenceImageUrl: "/static/frame.png", videoFrameSource: "source-clip",
    });
    const clip = store.addNode(CANVAS_NODE_TYPES.video, { x: 360, y: 0 }, {
      storySegmentId: "segment-2", continuityMode: "auto",
      prompt: "继续动作\n[FMV自动承接]本镜头的首帧必须从 @图片2 开始。[/FMV自动承接]",
    });
    useCanvasStore.getState().addEdge(character, clip);
    useCanvasStore.getState().addEdgeWithData(frame, clip, { edgeKind: "workflow_continuity_tail_frame" });

    const { result } = harness(clip);
    expect(result.current.prompt).toContain("[FMV自动承接]");

    // 与线上一致的原子切换：store 同一次 set 里剥提示词 + 删尾帧边。
    act(() => {
      useCanvasStore.getState().updateNodeData(clip, { continuityMode: "independent", continuitySourceNodeId: "" });
    });

    expect(promptOf(clip)).toBe("继续动作");
    expect(useCanvasStore.getState().edges.some((edge) => edge.source === frame)).toBe(false);
  });

  it("still renumbers mentions on a plain edge detach (positive control)", () => {
    const store = useCanvasStore.getState();
    const extra = store.addNode(CANVAS_NODE_TYPES.imageGen, { x: 0, y: 400 }, {
      displayName: "手表", referenceImageUrl: "/static/watch.png",
    });
    const character = store.addNode(CANVAS_NODE_TYPES.imageGen, { x: 0, y: 500 }, {
      displayName: "主角小林", referenceImageUrl: "/static/character.png",
    });
    const clip = store.addNode(CANVAS_NODE_TYPES.video, { x: 360, y: 0 }, {
      prompt: "@图片2 是主角",
    });
    const edgeExtra = useCanvasStore.getState().addEdge(extra, clip) as string;
    useCanvasStore.getState().addEdge(character, clip);

    harness(clip);
    act(() => {
      useCanvasStore.getState().deleteEdge(edgeExtra);
    });

    // 手表被断开后小林从 图片2 变 图片1，正文 mention 应随同源基线重编号。
    expect(promptOf(clip)).toBe("@图片1 是主角");
  });

  it("VideoNode feeds the store-latest prompt into the mention sync", () => {
    const source = readFileSync(
      join(process.cwd(), "src/features/canvas/nodes/VideoNode.tsx"),
      "utf8",
    );
    const call = source.match(/useReferenceMentionSync\(\s*([A-Za-z0-9_]+)/)?.[1];
    // 基线不能是 ReactFlow data prop 的 `prompt`——那一帧它可能落后于 store。
    expect(call).toBe("storePromptForMentionSync");
    expect(source).toContain("state.nodes.find((candidate) => candidate.id === id)");
  });
});
