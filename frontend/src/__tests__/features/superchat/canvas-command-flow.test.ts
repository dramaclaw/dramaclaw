import { describe, expect, it } from "vitest";

import {
  assistantCompletionPrefix,
  buildCanvasCommandFlowItemsForTest,
  canvasCommandFeedbackVisualToneForTest,
  canvasCommandFeedbackIsValidationOnlyForTest,
  canvasContextActivityVisualToneForTest,
  isGenerationSuccessSummaryText,
  mergeCanvasContextActivitiesForTest,
  mergeCanvasCommandFeedbacksForTest,
  mergePendingCanvasCommandApprovalForTest,
  orderExternalMcpCanvasPartsForTest,
  resolveCanvasCommandFeedbackMessageIdForTest,
} from "@/features/superchat/superchat-panel";
import { looksLikeCanvasExecutionNarration } from "@/features/superchat/canvas-execution-narration";
import { upsertAssistantMessageForTest } from "@/features/superchat/use-superchat";

describe("assistant success summary", () => {
  it("recognizes only the standalone generation success summary", () => {
    expect(isGenerationSuccessSummaryText("生成成功，无失败。")).toBe(true);
    expect(isGenerationSuccessSummaryText("生成成功, 无失败")).toBe(true);
    expect(isGenerationSuccessSummaryText("图片生成成功，下一步生成视频。")).toBe(false);
  });

  it("classifies natural DramaClaw completion replies without requiring a checkmark", () => {
    expect(assistantCompletionPrefix("第3集身份规划已完成。本集身份全部复用。"))
      .toBe("第3集身份规划已完成。");
    expect(assistantCompletionPrefix("第 3 集剧本生成完成。下一步生成草图。"))
      .toBe("第 3 集剧本生成完成。");
    expect(assistantCompletionPrefix("第1集成片合成完成。展示成片："))
      .toBe("第1集成片合成完成。");
    expect(assistantCompletionPrefix("✅ 规划身份 · ep3 已完成。你可以继续下一步。"))
      .toBe("✅ 规划身份 · ep3 已完成。");
  });

  it("does not classify negative completion status as completed", () => {
    expect(assistantCompletionPrefix("第3集身份规划尚未完成。请稍后查看。"))
      .toBeNull();
    expect(assistantCompletionPrefix("当前任务没有生成完成。"))
      .toBeNull();
  });
});

describe("canvas command flow placement", () => {
  it("places Codex MCP validation and approval before the final reply by event order", () => {
    const parts = orderExternalMcpCanvasPartsForTest([
      {
        id: "thought-1",
        type: "agent_thought",
        seq: 1,
        event: { status: "completed", text: "调用画布工具" },
      },
      { id: "text-1", type: "text", text: "图片节点已创建。" },
      {
        id: "approval-1",
        type: "canvas_approval",
        event: { externalMcpCommand: true, surfaceOrder: 102 },
      },
      {
        id: "validation-1",
        type: "canvas_context",
        event: { externalMcpCommand: true, surfaceOrder: 101 },
      },
    ]);

    expect(parts.map((part) => part.id)).toEqual([
      "thought-1",
      "validation-1",
      "approval-1",
      "text-1",
    ]);
  });

  it("does not reorder the original Hermes canvas parts", () => {
    const parts = [
      { id: "text-1", type: "text" as const, text: "Hermes 回复" },
      { id: "approval-1", type: "canvas_approval" as const, event: { surfaceOrder: 102 } },
      { id: "validation-1", type: "canvas_context" as const, event: { surfaceOrder: 101 } },
    ];

    expect(orderExternalMcpCanvasPartsForTest(parts).map((part) => part.id)).toEqual([
      "text-1",
      "approval-1",
      "validation-1",
    ]);
  });

  it("orders Skill Studio cards with later canvas approvals in the same message", () => {
    const items = buildCanvasCommandFlowItemsForTest(
      "我会先创建 Skill 草稿，然后再创建一个示例节点。",
      [
        {
          id: "approval-1",
          key: "approval-1",
          messageId: "assistant-turn-a",
          turnId: "turn-a",
          bridgeKey: "bridge-1",
          receivedAt: 1,
          envelopes: [],
          commandCount: 1,
          plans: [
            {
              index: 0,
              type: "create_node",
              label: "创建图片节点",
              details: [],
            },
          ],
          anchorTextPrefix: "我会先创建 Skill 草稿，然后再创建一个示例节点。",
          surfaceOrder: 10,
        },
      ],
      [],
      [],
      [
        {
          type: "skill_studio.questions",
          submitted: true,
          skill_studio_session_id: "skill-studio-a",
          questions: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "skill_studio", "approval"]);
  });

  it("keeps stale-anchor Skill Studio draft cards after historical continuation text", () => {
    const items = buildCanvasCommandFlowItemsForTest(
      "已为「家乡文化海报」完成 Skill Studio 全流程。",
      [],
      [],
      [],
      [
        {
          type: "skill_studio.questions",
          anchor_text_prefix: "我先为你整理几个关键问题。",
          skill_studio_session_id: "skill-studio-a",
          questions: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "skill_studio"]);
    expect(items[0]).toMatchObject({
      kind: "text",
      text: "已为「家乡文化海报」完成 Skill Studio 全流程。",
    });
  });

  it("keeps currently anchored Skill Studio cards after their preceding text", () => {
    const items = buildCanvasCommandFlowItemsForTest(
      "我先为你整理几个关键问题。",
      [],
      [],
      [],
      [
        {
          type: "skill_studio.questions",
          anchor_text_prefix: "我先为你整理几个关键问题。",
          skill_studio_session_id: "skill-studio-a",
          questions: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "skill_studio"]);
  });

  it("keeps user-facing assistant text visible when it only mentions a canvas tool name", () => {
    expect(looksLikeCanvasExecutionNarration(
      "如需进一步操作，可以通过 freezone_run_node_action 调用配置动作。",
    )).toBe(false);
  });

  it("keeps an event after the final assistant text when its saved anchor is missing", () => {
    const items = buildCanvasCommandFlowItemsForTest(
      "前置说明\n最终回复",
      [],
      [
        {
          key: "bridge:layout",
          applied: 1,
          openedUiActions: 0,
          errors: [],
          commandResults: [
            {
              commandIndex: 0,
              type: "layout_nodes",
              status: "success",
              label: "整理布局",
            },
          ],
          anchorTextPrefix: "前置说明\n过程里还没进入最终回复",
          surfaceOrder: 10,
        },
      ],
      [],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "feedback"]);
    expect(items[0]).toMatchObject({ kind: "text", text: "前置说明\n最终回复" });
  });

  it("prefers persisted feedback anchors over duplicate in-memory feedback anchors", () => {
    const persisted = {
      key: "bridge:layout",
      applied: 1,
      openedUiActions: 0,
      errors: [],
      commandResults: [
        {
          commandIndex: 0,
          type: "layout_nodes",
          status: "success",
          label: "整理布局",
        },
      ],
      anchorTextPrefix: "正文前半段\n",
      surfaceOrder: 20,
    };
    const inMemory = {
      ...persisted,
      anchorTextPrefix: "过程中的临时文本",
      surfaceOrder: 10,
    };

    const items = buildCanvasCommandFlowItemsForTest(
      "正文前半段\n正文后半段",
      [],
      mergeCanvasCommandFeedbacksForTest([persisted], [inMemory]),
      [],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "feedback", "text"]);
    expect(items[0]).toMatchObject({ kind: "text", text: "正文前半段\n" });
  });

  it("places unanchored canvas read activity before the assistant reply", () => {
    const items = buildCanvasCommandFlowItemsForTest(
      "你好！当前 Freezone 画布为空（0 个节点，0 条连线）。",
      [],
      [],
      [
        {
          key: "context:summary",
          turnId: "turn-a",
          bridgeKey: "summary",
          status: "done",
          labels: ["画布摘要"],
          errors: [],
          surfaceOrder: 10,
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["context", "text"]);
    expect(items[1]).toMatchObject({
      kind: "text",
      text: "你好！当前 Freezone 画布为空（0 个节点，0 条连线）。",
    });
  });

  it("places unanchored execution feedback before assistant success text", () => {
    const items = buildCanvasCommandFlowItemsForTest(
      "已为你添加一个视频节点。\n\n已创建成功，ID 为 node-a。",
      [],
      [
        {
          key: "bridge:create-video",
          applied: 1,
          openedUiActions: 0,
          errors: [],
          commandResults: [
            {
              commandIndex: 0,
              type: "create_node",
              status: "success",
              label: "创建节点",
              createdNodeId: "node-a",
            },
          ],
          surfaceOrder: 10,
        },
      ],
      [],
    );

    expect(items.map((item) => item.kind)).toEqual(["feedback", "text"]);
    expect(items[1]).toMatchObject({
      kind: "text",
      text: "已为你添加一个视频节点。\n\n已创建成功，ID 为 node-a。",
    });
  });

  it("places unanchored cancelled feedback before assistant cancellation text", () => {
    const items = buildCanvasCommandFlowItemsForTest(
      "生成请求提交超时，可能是画布连接暂时中断。请在画布上直接点击该节点的生成按钮重试，或稍后再让我帮你提交。",
      [],
      [
        {
          key: "bridge:timeout",
          applied: 0,
          openedUiActions: 0,
          errors: ["画布操作等待超时，已自动取消"],
          commandResults: [
            {
              commandIndex: -1,
              type: "validate",
              status: "error",
              label: "已取消",
              error: "画布操作等待超时，已自动取消",
            },
          ],
          cancelled: true,
          cancelReason: "timeout",
          surfaceOrder: 10,
        },
      ],
      [],
    );

    expect(items.map((item) => item.kind)).toEqual(["feedback", "text"]);
    expect(items[0]).toMatchObject({
      kind: "feedback",
      feedback: { key: "bridge:timeout" },
    });
  });

  it("targets the current assistant turn when command feedback arrives before text", () => {
    const messageId = resolveCanvasCommandFeedbackMessageIdForTest({
      messages: [
        {
          id: "assistant-old",
          role: "assistant",
          text: "上一轮回复",
          turnId: "turn-old",
          timestamp: 1,
        },
      ],
      turnId: "turn-new",
      latestAssistantMessageId: "assistant-old",
      receivedAt: 2,
    });

    expect(messageId).toBe("assistant-turn-new");
  });

  it("keeps existing canvas feedback when later assistant text arrives", () => {
    const messages = upsertAssistantMessageForTest(
      [
        {
          id: "assistant-turn-a",
          role: "assistant",
          text: "",
          turnId: "turn-a",
          timestamp: 1,
          parts: [
            {
              id: "canvas_feedback:bridge-a",
              type: "canvas_feedback",
              event: {
                key: "bridge-a",
                errors: ["节点动作完成但未产出 imageUrl。"],
                commandResults: [],
              },
            },
          ],
        },
      ],
      "turn-a",
      "任务执行失败：当前状态为 failed。",
    );

    const assistant = messages.find((message) => message.id === "assistant-turn-a");

    expect(assistant?.parts?.map((part) => part.type)).toEqual(["canvas_feedback", "text"]);
    expect(assistant?.parts?.[0]).toMatchObject({
      type: "canvas_feedback",
      event: { errors: ["节点动作完成但未产出 imageUrl。"] },
    });
  });

  it("does not treat a cancelled canvas command as validation-only feedback", () => {
    expect(canvasCommandFeedbackIsValidationOnlyForTest({
      key: "bridge:cancelled",
      applied: 0,
      openedUiActions: 0,
      errors: ["已取消画布操作"],
      commandResults: [
        {
          commandIndex: -1,
          type: "validate",
          status: "error",
          label: "已取消",
          error: "已取消画布操作",
        },
      ],
    })).toBe(false);
  });

  it("renders validation-only failures as muted agent attempts while preserving execution failures as destructive", () => {
    expect(canvasContextActivityVisualToneForTest({
      key: "context:validation",
      turnId: "turn-a",
      bridgeKey: "validation",
      status: "failed",
      labels: ["命令校验"],
      errors: ["命令校验失败"],
    })).toBe("muted");

    expect(canvasCommandFeedbackVisualToneForTest({
      key: "bridge:validation",
      applied: 0,
      openedUiActions: 0,
      errors: ["画布命令无效"],
      commandResults: [
        {
          commandIndex: -1,
          type: "validate",
          status: "error",
          label: "画布命令无效",
          error: "画布命令无效",
        },
      ],
    })).toBe("muted");

    expect(canvasCommandFeedbackVisualToneForTest({
      key: "bridge:cancelled",
      applied: 0,
      openedUiActions: 0,
      errors: ["已取消画布操作"],
      commandResults: [
        {
          commandIndex: -1,
          type: "validate",
          status: "error",
          label: "已取消",
          error: "已取消画布操作",
        },
      ],
      cancelled: true,
      cancelReason: "user",
    })).toBe("muted");

    expect(canvasCommandFeedbackVisualToneForTest({
      key: "bridge:timeout",
      applied: 0,
      openedUiActions: 0,
      errors: ["画布操作等待超时，已自动取消"],
      commandResults: [
        {
          commandIndex: -1,
          type: "validate",
          status: "error",
          label: "已取消",
          error: "画布操作等待超时，已自动取消",
        },
      ],
      cancelled: true,
      cancelReason: "timeout",
    })).toBe("warning");

    expect(canvasCommandFeedbackVisualToneForTest({
      key: "bridge:execution",
      applied: 0,
      openedUiActions: 0,
      errors: ["生成失败"],
      commandResults: [
        {
          commandIndex: 0,
          type: "run_node_action",
          status: "error",
          label: "生成图片",
          error: "生成失败",
        },
      ],
    })).toBe("destructive");
  });

  it("dedupes the same pending approval when one event resolves the turn later", () => {
    const envelopes = [
      {
        schema_version: "canvas_chat_commands.v1",
        commands: [
          {
            type: "create_node",
            client_id: "kf4",
            node_type: "imageGenNode",
            data: { prompt: "frame" },
          },
        ],
      },
    ];
    const first = {
      id: "canvas-command-approval:tool-canvas-command:1:bridge:bridge-a",
      key: "bridge:bridge-a",
      messageId: "tool-canvas-command:1",
      turnId: null,
      bridgeKey: "bridge-a",
      anchorTextPrefix: null,
      surfaceOrder: 1,
      envelopes,
      commandCount: 1,
      plans: [],
    };
    const second = {
      ...first,
      id: "canvas-command-approval:assistant-turn-a:bridge:bridge-a:turn:turn-a",
      key: "bridge:bridge-a:turn:turn-a",
      messageId: "assistant-turn-a",
      turnId: "turn-a",
      surfaceOrder: 2,
    };

    const merged = mergePendingCanvasCommandApprovalForTest(
      mergePendingCanvasCommandApprovalForTest([], first as any),
      second as any,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: first.id,
      key: second.key,
      messageId: second.messageId,
      turnId: "turn-a",
    });
  });

  it("keeps the websocket turn when a reconnect poll repeats the same bridge command", () => {
    const live = {
      id: "canvas-command-approval:assistant-turn-a:bridge:bridge-a",
      key: "bridge:bridge-a",
      messageId: "assistant-turn-a",
      turnId: "turn-a",
      bridgeKey: "bridge-a",
      anchorTextPrefix: null,
      surfaceOrder: 1,
      envelopes: [],
      commandCount: 1,
      plans: [],
    };
    const polled = {
      ...live,
      messageId: "assistant-external-agent:bridge-a",
      turnId: "external-agent:bridge-a",
      surfaceOrder: 2,
    };

    const merged = mergePendingCanvasCommandApprovalForTest(
      mergePendingCanvasCommandApprovalForTest([], live as any),
      polled as any,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].turnId).toBe("turn-a");
  });

  it("merges persisted and live canvas context activities without losing the live anchor", () => {
    const merged = mergeCanvasContextActivitiesForTest(
      [
        {
          key: "context:node-detail",
          turnId: "turn-a",
          bridgeKey: "node-detail",
          status: "done",
          labels: ["节点参数"],
          errors: [],
          anchorTextPrefix: null,
          surfaceOrder: 30,
        },
      ],
      [
        {
          key: "context:node-detail",
          turnId: "turn-a",
          bridgeKey: "node-detail",
          status: "done",
          labels: ["节点参数"],
          errors: [],
          anchorTextPrefix: "验证通过，现在创建节点和连接：\n",
          surfaceOrder: 10,
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      anchorTextPrefix: "验证通过，现在创建节点和连接：\n",
      surfaceOrder: 10,
    });
  });

  it("places validation and execution cards before assistant text that describes their result", () => {
    const text = [
      "好的！我来帮你创建一个家乡文化海报的工作流。",
      "",
      "验证通过，创建节点并连接：",
      "",
      "已经在画布上创建好了海报工作流。",
    ].join("\n");

    const items = buildCanvasCommandFlowItemsForTest(
      text,
      [],
      [
        {
          key: "bridge:command",
          applied: 4,
          openedUiActions: 0,
          errors: [],
          commandResults: [
            {
              commandIndex: 0,
              type: "create_node",
              status: "success",
              label: "创建节点",
            },
          ],
          anchorTextPrefix: text,
          surfaceOrder: 40,
        },
      ],
      [
        {
          key: "context:validation",
          turnId: "turn-a",
          bridgeKey: "validation",
          status: "done",
          labels: ["命令校验"],
          errors: [],
          anchorTextPrefix: text,
          surfaceOrder: 30,
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual([
      "text",
      "context",
      "text",
      "feedback",
      "text",
    ]);
    expect(items[0]).toMatchObject({
      kind: "text",
      text: "好的！我来帮你创建一个家乡文化海报的工作流。\n\n",
    });
    expect(items[2]).toMatchObject({
      kind: "text",
      text: "验证通过，创建节点并连接：\n\n",
    });
  });

  it("keeps canvas cards in stream order when the final assistant text normalizes blank lines", () => {
    const text = [
      "我需要为您创建一个图片节点。在Freezone画布中，图片节点对应的是 `imageNode` 类型。",
      "",
      "让我先查看一下图片节点的创建schema，以确保使用正确的字段：",
      "",
      "我看到图片节点的创建schema中，`imageNode`类型需要提供一些必要的字段。根据schema，我需要创建一个`imageNode`，并设置显示名称等基本信息。",
      "",
      "让我为您创建一个图片节点：",
      "",
      "图片节点已成功创建！我为您创建了一个名为\"图片节点\"的图片节点。",
    ].join("\n");
    const streamingAnchor = [
      "我需要为您创建一个图片节点。在Freezone画布中，图片节点对应的是 `imageNode` 类型。",
      "",
      "让我先查看一下图片节点的创建schema，以确保使用正确的字段：",
      "",
      "",
      "我看到图片节点的创建schema中，`imageNode`类型需要提供一些必要的字段。根据schema，我需要创建一个`imageNode`，并设置显示名称等基本信息。",
      "",
      "让我为您创建一个图片节点：",
      "",
    ].join("\n");

    const items = buildCanvasCommandFlowItemsForTest(
      text,
      [],
      [
        {
          key: "bridge:create",
          applied: 1,
          openedUiActions: 0,
          errors: [],
          commandResults: [
            {
              commandIndex: 0,
              type: "create_node",
              status: "success",
              label: "创建节点",
            },
          ],
          anchorTextPrefix: streamingAnchor,
          surfaceOrder: 30,
        },
      ],
      [
        {
          key: "context:node-create-schema",
          turnId: "turn-a",
          bridgeKey: "node-create-schema",
          status: "done",
          labels: ["节点参数"],
          errors: [],
          anchorTextPrefix: null,
          surfaceOrder: 10,
        },
        {
          key: "context:validation",
          turnId: "turn-a",
          bridgeKey: "validation",
          status: "done",
          labels: ["命令校验"],
          errors: [],
          anchorTextPrefix: streamingAnchor,
          surfaceOrder: 20,
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual([
      "text",
      "context",
      "text",
      "context",
      "feedback",
      "text",
    ]);
    expect(items[1]).toMatchObject({
      kind: "context",
      activity: { bridgeKey: "node-create-schema" },
    });
    expect(items[3]).toMatchObject({
      kind: "context",
      activity: { bridgeKey: "validation" },
    });
    expect(items[4]).toMatchObject({
      kind: "feedback",
      feedback: { key: "bridge:create" },
    });
    expect(items[5]).toMatchObject({
      kind: "text",
      text: expect.stringContaining("图片节点已成功创建"),
    });
  });

  it("does not anchor execution cards inside the assistant request sentence", () => {
    const text = [
      "我需要在 Freezone 画布上创建一个新的图片节点。让我使用正确的工具来完成这个任务。",
      "",
      "我已经成功在Freezone画布上创建了一个新的图片节点。该节点的ID为 `dbc24486-07e7-4d55-9376-920a7f9a8254`。",
      "",
      "这个图片节点现在可以在画布上看到，您可以进一步编辑它的属性、添加图像或与其他节点建立连接。",
    ].join("\n");
    const anchorTextPrefix = [
      "我需要在 Freezone 画布上创建一个新的图片节点。让我使用正确的工具来完成这个任务。",
      "",
    ].join("\n");

    const items = buildCanvasCommandFlowItemsForTest(
      text,
      [],
      [
        {
          key: "bridge:create",
          applied: 1,
          openedUiActions: 0,
          errors: [],
          commandResults: [
            {
              commandIndex: 0,
              type: "create_node",
              status: "success",
              label: "创建节点",
            },
          ],
          anchorTextPrefix,
          surfaceOrder: 10,
        },
      ],
      [],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "feedback", "text"]);
    expect(items[0]).toMatchObject({
      kind: "text",
      text: anchorTextPrefix,
    });
    expect(items[2]).toMatchObject({
      kind: "text",
      text: expect.stringContaining("我已经成功在Freezone画布上创建"),
    });
  });

  it("keeps read-context cards next to the assistant text that requested them", () => {
    const text = [
      "我将帮你润色当前视频节点的提示词。首先，我需要获取该节点的详细信息，以便了解其完整内容和可编辑字段。",
      "",
      "现在我已经获取了视频节点的详细信息。当前的提示词是“猫吃鱼”。",
      "",
      "让我为这个提示词提供几个润色选项，从基础增强到专业级：",
    ].join("\n");

    const items = buildCanvasCommandFlowItemsForTest(
      text,
      [],
      [],
      [
        {
          key: "context:node-detail",
          turnId: "turn-a",
          bridgeKey: "node-detail",
          status: "done",
          labels: ["节点详情"],
          errors: [],
          anchorTextPrefix: null,
          surfaceOrder: 10,
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "context", "text"]);
    expect(items[0]).toMatchObject({
      kind: "text",
      text: "我将帮你润色当前视频节点的提示词。首先，我需要获取该节点的详细信息，以便了解其完整内容和可编辑字段。\n\n",
    });
    expect(items[2]).toMatchObject({
      kind: "text",
      text: "现在我已经获取了视频节点的详细信息。当前的提示词是“猫吃鱼”。\n\n让我为这个提示词提供几个润色选项，从基础增强到专业级：",
    });
  });
});
