// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "@/__mocks__/msw/server";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import type { AudioNodeData } from "@/features/canvas/domain/canvasNodes";
import { AudioOperationsPanel } from "@/features/canvas/nodes/AudioOperationsPanel";
import { useCanvasStore } from "@/stores/canvasStore";

function renderPanel(data: Partial<AudioNodeData>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  useCanvasStore.getState().setCanvasData(
    [
      {
        id: "audio-1",
        type: CANVAS_NODE_TYPES.audio,
        position: { x: 0, y: 0 },
        data: { audioUrl: null, ...data },
      },
    ],
    [],
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <AudioOperationsPanel
        nodeId="audio-1"
        data={{ audioUrl: null, ...data }}
      />
    </QueryClientProvider>,
  );
}

// The submit button now also honours the org admission gate (`/org/me`).
// Without a snapshot the gate fails closed and every submit assertion below
// would be measuring the gate rather than the panel.
const allowedOrgMe = {
  user: { user_id: "u1", username: "alice", model_billing_entitlement: "platform" },
  organization: null,
  membership: null,
  capabilities: {
    manage_members: false,
    manage_invites: false,
    manage_gateway_key: false,
    start_model_tasks: true,
  },
  gateway_key: { state: "never_configured", key_version: null },
  denial_reason: null,
};

describe("AudioOperationsPanel music advanced settings", () => {
  beforeEach(() => {
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(allowedOrgMe)));
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("opens the 高级设置 panel with the music-length dropdown (Tooltip/UiSelect import is runtime-safe)", () => {
    renderPanel({ audioKind: "music" });

    // 默认收起，时长下拉不在文档中
    expect(screen.queryByText("音乐时长")).toBeNull();

    // 点「高级设置」展开——若 Tooltip 在运行时为 undefined 会在此渲染抛错
    fireEvent.click(screen.getByTitle("高级设置"));

    expect(screen.getByText("音乐时长")).toBeTruthy();
    // UiSelect 渲染预设标签（默认 30 秒，触发器+选项可能各出现一次）
    expect(screen.getAllByText("30秒").length).toBeGreaterThan(0);
  });

  it("does not show the 高级设置 button for speech (clone) audio nodes", () => {
    renderPanel({ audioKind: "speech" });
    expect(screen.queryByTitle("高级设置")).toBeNull();
    // 语音模式保留「音色设置」
    expect(screen.getByTitle("音色设置")).toBeTruthy();
  });

  // 回归：音频节点引用了非空文本节点时，应允许提交——但不把内容灌进生成器文本框。
  it("enables submit when a non-empty upstream text node is referenced, without filling the textarea", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "text-1",
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 0, y: 0 },
          data: { content: "我的音乐描述文本", mode: "writing" },
        },
        {
          id: "audio-1",
          type: CANVAS_NODE_TYPES.audio,
          position: { x: 300, y: 0 },
          data: { audioUrl: null, audioKind: "music" },
        },
      ],
      [],
    );
    useCanvasStore.getState().addEdge("text-1", "audio-1");

    // data 从 store 取，保证 updateNodeData 后面板能拿到回填结果（模拟 AudioNode 的订阅）。
    function Harness() {
      const data = useCanvasStore(
        (s) => s.nodes.find((n) => n.id === "audio-1")?.data,
      ) as AudioNodeData;
      return <AudioOperationsPanel nodeId="audio-1" data={data} />;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );

    // 不把上游内容灌进生成器文本框（保持空/占位）
    expect(screen.queryByDisplayValue("我的音乐描述文本")).toBeNull();
    // 但因引用了非空文本，生成按钮可用
    // 门控在 /org/me 落地前失败关闭，所以要等快照到位再断言。
    await waitFor(() =>
      expect((screen.getByTitle("生成") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  // 回归：语音(speech)模式同样不回显上游文本到输入框，仅在提交时拼接进 prompt。
  it("speech mode also does not echo upstream text into the textarea but still allows submit", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "text-1",
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 0, y: 0 },
          data: { content: "我的语音合成文本", mode: "writing" },
        },
        {
          id: "audio-1",
          type: CANVAS_NODE_TYPES.audio,
          position: { x: 300, y: 0 },
          data: {
            audioUrl: null,
            audioKind: "speech",
            speechMode: "clone",
            voiceAvailable: true,
            voiceRef: { scope: "user_custom", voiceId: "voice-1" },
          },
        },
      ],
      [],
    );
    useCanvasStore.getState().addEdge("text-1", "audio-1");

    function Harness() {
      const data = useCanvasStore(
        (s) => s.nodes.find((n) => n.id === "audio-1")?.data,
      ) as AudioNodeData;
      return <AudioOperationsPanel nodeId="audio-1" data={data} />;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );

    // 上游文本不回显进输入框
    expect(screen.queryByDisplayValue("我的语音合成文本")).toBeNull();
    // 引用了非空文本即可提交（提交时由 effectivePrompt 拼接上游+本地）
    // 门控在 /org/me 落地前失败关闭，所以要等快照到位再断言。
    await waitFor(() =>
      expect((screen.getByTitle("生成") as HTMLButtonElement).disabled).toBe(false),
    );
  });

});
