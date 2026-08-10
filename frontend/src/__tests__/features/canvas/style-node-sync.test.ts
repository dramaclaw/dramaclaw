// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  advanceStyleNodeSync,
  resolveStyleNodePlacement,
  resolveStyleNodeSyncAction,
  STYLE_NODE_GAP,
  INITIAL_STYLE_NODE_SYNC_STATE,
  type StyleNodeSnapshot,
  type StyleNodeSyncAction,
  type StyleNodeSyncState,
} from "@/features/canvas/application/styleNodeSync";

describe("resolveStyleNodeSyncAction", () => {
  describe("首次同步（lastSyncedTemplateId 为 undefined）", () => {
    it("选了风格但画布上没有风格节点时补建一个", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "golden_age",
          styleNode: null,
          lastSyncedTemplateId: undefined,
          everObservedStyleNode: false,
        }),
      ).toEqual({ kind: "create", templateId: "golden_age" });
    });

    it("存量画布已经带着匹配的风格节点时什么都不做", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "golden_age",
          styleNode: { id: "n1", templateId: "golden_age" },
          lastSyncedTemplateId: undefined,
          everObservedStyleNode: false,
        }),
      ).toEqual({ kind: "none" });
    });

    it("没选风格时不建节点", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: null,
          styleNode: null,
          lastSyncedTemplateId: undefined,
          everObservedStyleNode: false,
        }),
      ).toEqual({ kind: "none" });
    });
  });

  describe("选择发生变化", () => {
    it("从无到有时建节点", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "golden_age",
          styleNode: null,
          lastSyncedTemplateId: null,
          everObservedStyleNode: false,
        }),
      ).toEqual({ kind: "create", templateId: "golden_age" });
    });

    it("换风格时改写已有节点，而不是再建一个", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "cyberpunk",
          styleNode: { id: "n1", templateId: "golden_age" },
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: true,
        }),
      ).toEqual({ kind: "update", nodeId: "n1", templateId: "cyberpunk" });
    });

    it("清除风格时删掉上游节点", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: null,
          styleNode: { id: "n1", templateId: "golden_age" },
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: true,
        }),
      ).toEqual({ kind: "remove", nodeId: "n1" });
    });

    it("清除风格但节点已经不在时不重复删", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: null,
          styleNode: null,
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: true,
        }),
      ).toEqual({ kind: "none" });
    });
  });

  describe("选择没变", () => {
    it("刚建完节点、store 还没回流时不能误判成「用户删了」", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "golden_age",
          styleNode: null,
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: false,
        }),
      ).toEqual({ kind: "none" });
    });

    it("用户手动删掉风格节点后反向清掉图片节点的风格", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "golden_age",
          styleNode: null,
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: true,
        }),
      ).toEqual({ kind: "clear-selection" });
    });

    it("节点还在且一致时是稳态", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "golden_age",
          styleNode: { id: "n1", templateId: "golden_age" },
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: true,
        }),
      ).toEqual({ kind: "none" });
    });

    it("节点数据与选择不一致时把节点拉回来", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "golden_age",
          styleNode: { id: "n1", templateId: null },
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: true,
        }),
      ).toEqual({ kind: "update", nodeId: "n1", templateId: "golden_age" });
    });
  });
});

/**
 * 把一串「帧」喂给状态机，收集每帧的动作 —— 组件里那个 effect 每次重跑就是一帧，
 * 而记账状态跨帧留在 ref 里。时序坑只有连着跑才暴露得出来。
 */
function runFrames(
  frames: ReadonlyArray<{
    selectedTemplateId: string | null;
    styleNode: StyleNodeSnapshot | null;
  }>,
): { actions: StyleNodeSyncAction[]; state: StyleNodeSyncState } {
  let state = INITIAL_STYLE_NODE_SYNC_STATE;
  const actions: StyleNodeSyncAction[] = [];
  for (const frame of frames) {
    const result = advanceStyleNodeSync(state, frame);
    state = result.state;
    actions.push(result.action);
  }
  return { actions, state };
}

describe("advanceStyleNodeSync", () => {
  it("建完节点后、store 回流前的那几帧不会把刚选的风格清掉", () => {
    const { actions } = runFrames([
      // 用户在图墙里选了风格。
      { selectedTemplateId: "golden_age", styleNode: null },
      // addNode 已经发出去，但这一帧上游还看不见它。
      { selectedTemplateId: "golden_age", styleNode: null },
      { selectedTemplateId: "golden_age", styleNode: null },
      // 回流了。
      {
        selectedTemplateId: "golden_age",
        styleNode: { id: "n1", templateId: "golden_age" },
      },
    ]);

    expect(actions).toEqual([
      { kind: "create", templateId: "golden_age" },
      { kind: "none" },
      { kind: "none" },
      { kind: "none" },
    ]);
  });

  it("节点真的被用户删掉时才反向清空选择，且只清一次", () => {
    const { actions } = runFrames([
      { selectedTemplateId: "golden_age", styleNode: null },
      {
        selectedTemplateId: "golden_age",
        styleNode: { id: "n1", templateId: "golden_age" },
      },
      // 用户在画布上删了风格节点。
      { selectedTemplateId: "golden_age", styleNode: null },
      // 清空后的下一帧：选择已经是 null。
      { selectedTemplateId: null, styleNode: null },
      { selectedTemplateId: null, styleNode: null },
    ]);

    expect(actions).toEqual([
      { kind: "create", templateId: "golden_age" },
      { kind: "none" },
      { kind: "clear-selection" },
      { kind: "none" },
      { kind: "none" },
    ]);
  });

  it("清除风格只删一次节点，回流延迟不会重复删", () => {
    const { actions } = runFrames([
      { selectedTemplateId: "golden_age", styleNode: null },
      {
        selectedTemplateId: "golden_age",
        styleNode: { id: "n1", templateId: "golden_age" },
      },
      // 用户点了「清除风格」。
      {
        selectedTemplateId: null,
        styleNode: { id: "n1", templateId: "golden_age" },
      },
      // deleteNode 发出去了，这一帧上游还带着它。
      {
        selectedTemplateId: null,
        styleNode: { id: "n1", templateId: "golden_age" },
      },
      { selectedTemplateId: null, styleNode: null },
    ]);

    expect(actions).toEqual([
      { kind: "create", templateId: "golden_age" },
      { kind: "none" },
      { kind: "remove", nodeId: "n1" },
      { kind: "none" },
      { kind: "none" },
    ]);
  });

  it("删掉节点后重新选风格是补建，不会误判成用户删节点", () => {
    const { actions } = runFrames([
      { selectedTemplateId: "golden_age", styleNode: null },
      {
        selectedTemplateId: "golden_age",
        styleNode: { id: "n1", templateId: "golden_age" },
      },
      { selectedTemplateId: null, styleNode: { id: "n1", templateId: "golden_age" } },
      { selectedTemplateId: null, styleNode: null },
      // 再选一个。
      { selectedTemplateId: "cyberpunk", styleNode: null },
      { selectedTemplateId: "cyberpunk", styleNode: null },
    ]);

    expect(actions.slice(4)).toEqual([
      { kind: "create", templateId: "cyberpunk" },
      { kind: "none" },
    ]);
  });

  it("换风格复用同一个节点", () => {
    const { actions } = runFrames([
      {
        selectedTemplateId: "golden_age",
        styleNode: { id: "n1", templateId: "golden_age" },
      },
      {
        selectedTemplateId: "cyberpunk",
        styleNode: { id: "n1", templateId: "golden_age" },
      },
      {
        selectedTemplateId: "cyberpunk",
        styleNode: { id: "n1", templateId: "cyberpunk" },
      },
    ]);

    expect(actions).toEqual([
      { kind: "none" },
      { kind: "update", nodeId: "n1", templateId: "cyberpunk" },
      { kind: "none" },
    ]);
  });

  it("存量画布：有 styleTemplateId 却没有风格节点时首帧补建", () => {
    const { actions } = runFrames([
      { selectedTemplateId: "golden_age", styleNode: null },
    ]);

    expect(actions).toEqual([{ kind: "create", templateId: "golden_age" }]);
  });

  it("没选风格的空节点不会凭空建出风格节点", () => {
    const { actions } = runFrames([
      { selectedTemplateId: null, styleNode: null },
      { selectedTemplateId: null, styleNode: null },
    ]);

    expect(actions).toEqual([{ kind: "none" }, { kind: "none" }]);
  });
});

describe("resolveStyleNodePlacement", () => {
  it("摆在图片节点正左方并留出间距", () => {
    expect(
      resolveStyleNodePlacement({
        imageNodePosition: { x: 1000, y: 200 },
        imageNodeHeight: 360,
        styleNodeWidth: 220,
        styleNodeHeight: 124,
      }),
    ).toEqual({ x: 1000 - 220 - STYLE_NODE_GAP, y: 200 + (360 - 124) / 2 });
  });

  it("图片节点比风格节点矮时也居中，不贴顶", () => {
    // 折叠态的图片节点可能比风格卡片还矮，这时 y 应该往上偏而不是被夹成 0。
    expect(
      resolveStyleNodePlacement({
        imageNodePosition: { x: 0, y: 0 },
        imageNodeHeight: 64,
        styleNodeWidth: 220,
        styleNodeHeight: 124,
      }),
    ).toEqual({ x: -220 - STYLE_NODE_GAP, y: -30 });
  });

  it("负坐标画布上不丢精度", () => {
    expect(
      resolveStyleNodePlacement({
        imageNodePosition: { x: -840.5, y: -120 },
        imageNodeHeight: 361,
        styleNodeWidth: 220,
        styleNodeHeight: 124,
      }),
    ).toEqual({ x: -840.5 - 220 - STYLE_NODE_GAP, y: -120 + 118.5 });
  });
});
