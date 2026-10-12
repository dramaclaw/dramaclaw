// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Agent 的 sceneEdit 落地：编辑器开着这个节点就进 store，关着就只算出要写回节点的补丁。
import { beforeEach, describe, expect, it } from "vitest";

import {
  landNodeAgentSceneEdit,
  nodeAgentSceneDigest,
  planNodeAgentSceneEdit,
} from "@/features/previz/agentSceneEdit";
import { createDefaultScene } from "@/features/previz/domain/scene";
import { usePrevizStore } from "@/features/previz/store";

const wall = { kind: "prop", shape: "cube", name: "墙", position: [2, 0, 0], scale: [4, 2, 0.2] };

describe("agent scene edit on a previz node", () => {
  beforeEach(() => {
    usePrevizStore.getState().loadScene(createDefaultScene(), null);
  });

  it("builds the patch from node data when the editor is closed, and round-trips through it", () => {
    const patch = landNodeAgentSceneEdit("node-a", { scene: null }, { add: [wall] });

    expect(patch.summary).toMatchObject({ objectCount: 1 });
    expect(usePrevizStore.getState().scene.objects).toEqual([]);
    expect(nodeAgentSceneDigest("node-a", patch as Record<string, unknown>)?.objects).toMatchObject([
      { kind: "prop", name: "墙", shape: "cube" },
    ]);
  });

  it("goes through the editor store when the editor has this node open", () => {
    usePrevizStore.getState().loadScene(createDefaultScene(), "node-a");
    // 节点数据是旧的：真相在 store 里。
    const first = landNodeAgentSceneEdit("node-a", { scene: null }, { add: [wall] });
    const id = usePrevizStore.getState().scene.objects[0].id;
    usePrevizStore.setState({ selectedObjectId: id });

    expect(first.summary).toMatchObject({ objectCount: 1 });
    expect(usePrevizStore.getState().dirty).toBe(false);

    landNodeAgentSceneEdit("node-a", { scene: null }, { remove: [id] });

    expect(usePrevizStore.getState().scene.objects).toEqual([]);
    expect(usePrevizStore.getState().selectedObjectId).toBeNull();
  });

  it("lands timeline edits in the open editor and keeps its session state pointing at real things", () => {
    usePrevizStore.getState().loadScene(createDefaultScene(), "node-a");
    landNodeAgentSceneEdit("node-a", { scene: null }, {
      add: [{ kind: "character", ref: "hero", position: [0, 0, 0] }],
      timeline: { durationFrames: 300, paths: [{ objectId: "hero", points: [[0, 0, 0], [2, 0, 0]] }] },
    });
    const clipId = usePrevizStore.getState().scene.timeline.tracks[0].clips[0].id;
    usePrevizStore.setState({ selectedClipId: clipId, timelineFrame: 280 });

    landNodeAgentSceneEdit("node-a", { scene: null }, {
      timeline: { removeClips: [clipId], durationFrames: 120 },
    });

    const state = usePrevizStore.getState();
    expect(state.scene.timeline.tracks[0].clips).toEqual([]);
    expect(state.selectedClipId).toBeNull();
    expect(state.timelineFrame).toBe(120);
  });

  it("plans without writing, and throws instead of landing a rejected edit", () => {
    usePrevizStore.getState().loadScene(createDefaultScene(), "node-a");
    const bad = { add: [{ ...wall, shape: "teapot" }] };

    expect(planNodeAgentSceneEdit("node-a", { scene: null }, { add: [wall] }).ok).toBe(true);
    expect(usePrevizStore.getState().scene.objects).toEqual([]);
    expect(() => landNodeAgentSceneEdit("node-a", { scene: null }, bad)).toThrow("shape");
    expect(usePrevizStore.getState().scene.objects).toEqual([]);
  });
});
