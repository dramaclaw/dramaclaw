// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMessage } from "@/features/superchat/message";
import { buildCanvasCommandToolResultPayloadForTest } from "@/features/freezone/canvasCommandToolResult";
import {
  SUPERCHAT_CANVAS_COMMAND_EVENT,
  approvalOptionIdForTest,
  canvasContextToolResultFrameForTest,
  dispatchCanvasCommandFrameForTest,
  mergeHistorySnapshot,
  normalizeMessageForScopeForTest,
  removeSkillStudioStatusForTurnForTest,
  pruneOldMessageCaches,
  resolveUiEventTurnIdForTest,
  sanitizeMessagesForCache,
  shouldRenderToolStatusPart,
  scopeForProjectForTest,
  scopeSessionKeyForTest,
  toolStatusPartForTest,
  updateAssistantUiEventsForTest,
  upsertRuntimePartInMessagesForTest,
  upsertAssistantMessageForTest,
  upsertAssistantUiEventForTest,
  upsertServerAssistantMessageForTest,
  useSuperChat,
} from "@/features/superchat/use-superchat";
import {
  CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
  CANVAS_NODE_REFERENCE_SCHEMA_VERSION,
  isCanvasNodeReferenceAttachment,
} from "@/features/freezone/chatNodeReferences";
import {
  buildAssistantClarificationResponseForTest,
  activeAssistantClarificationIsSkillStudioRevisionForTest,
  buildPersistedAssistantClarificationEventForTest,
  buildAssistantClarificationToolResultForTest,
  buildAssistantInteractionFlowItemsForTest,
  collapseRepeatedCanvasStatusFlowItemsForTest,
  collapseRepeatedCanvasStatusPartsForTest,
  amendCanvasApprovalWithImageParamsForTest,
  amendCanvasApprovalWithVideoParamsForTest,
  buildSkillStudioCatalogSaveItemsForTest,
  buildSkillStudioDraftCancelToolResultForTest,
  buildSkillStudioDraftRevisionToolResultForTest,
  buildSkillStudioDraftToolResultForTest,
  skillStudioDraftFieldLabelsForTest,
  buildSkillStudioFlowItemsForTest,
  buildSkillStudioQuestionTimelineItemsForTest,
  buildSkillStudioQuestionResponseForTest,
  buildSkillStudioQuestionToolResultForTest,
  assistantClarificationEventIdentityForTest,
  skillStudioDraftFooterTextForTest,
  skillStudioEventMatchesForTest,
  hydrateOrderedPartsWithUiEventsForTest,
  latestPendingAssistantClarificationEventForTest,
  latestPendingAssistantClarificationEventForActiveTurnForTest,
  latestPendingSkillStudioQuestionEventForTest,
  latestPendingSkillStudioQuestionEventForActiveTurnForTest,
  skillStudioQuestionEventIdentityForTest,
  messageIsWaitingForUserReplyForTest,
  messageHasSkillStudioUiEventForTest,
  shouldHideSkillStudioStatusOnlyMessageForTest,
  shouldShowComposerWaitingIndicator,
  skillStudioEvaluationDraftFieldsForTest,
  skillStudioEventsFromUiEventsForTest,
  visibleCanvasContextActivitiesForMessageForTest,
  visibleSkillStudioEventsForMessageForTest,
} from "@/features/superchat/superchat-panel";
import type { ChatMessage, ChatRole } from "@/features/superchat/types";

const MESSAGE_CACHE_PREFIX = "superchat:messages:v2:";
const DAY_MS = 24 * 60 * 60 * 1000;
const apiPostMock = vi.hoisted(() => vi.fn(() => Promise.resolve({})));

vi.mock("@/lib/api", () => ({
  api: {
    post: apiPostMock,
  },
}));

function message(
  id: string,
  role: ChatRole,
  text: string,
  timestamp: number,
  turnId?: string,
): ChatMessage {
  return { id, role, text, timestamp, turnId };
}

describe("mergeHistorySnapshot", () => {
  it("replaces local turn messages with matching backend history", () => {
    const current = [
      message("user-turn-1", "user", "你好", 10, "turn-1"),
      message("assistant-turn-1", "assistant", "你好，有什么可以帮你？", 20, "turn-1"),
    ];
    const history = [
      message("backend-user-1", "user", "你好", 30),
      message("backend-assistant-1", "assistant", "你好，有什么可以帮你？", 40),
    ];

    const merged = mergeHistorySnapshot(current, history, "turn-1");

    expect(merged.map((item) => item.id)).toEqual(["backend-user-1", "backend-assistant-1"]);
  });

  it("replaces a completed local turn when the final local delta is newer than backend history", () => {
    const current = [
      message("user-turn-1", "user", "你好", 100, "turn-1"),
      message("assistant-turn-1", "assistant", "你好，有什么可以帮你？", 300, "turn-1"),
    ];
    const history = [
      message("backend-user-1", "user", "你好", 150),
      message("backend-assistant-1", "assistant", "你好，有什么可以帮你？", 250),
    ];

    const merged = mergeHistorySnapshot(current, history, "turn-1");

    expect(merged.map((item) => item.id)).toEqual(["backend-user-1", "backend-assistant-1"]);
  });

  it("replaces a completed local turn even when local partial text differs", () => {
    const current = [
      message("user-turn-1", "user", "你好", 100, "turn-1"),
      message("assistant-turn-1", "assistant", "正在生成", 120, "turn-1"),
    ];
    const history = [
      message("backend-user-1", "user", "你好", 150),
      message("backend-assistant-1", "assistant", "你好！有什么我可以帮你的吗？", 250),
    ];

    const merged = mergeHistorySnapshot(current, history, "turn-1");

    expect(merged.map((item) => item.id)).toEqual(["backend-user-1", "backend-assistant-1"]);
  });

  it("keeps the protected in-flight turn when a stale snapshot has the same user text", () => {
    const current = [
      message("backend-user-1", "user", "你好", 10),
      message("backend-assistant-1", "assistant", "第一轮回复", 20),
      message("user-turn-2", "user", "你好", 30, "turn-2"),
      message("assistant-turn-2", "assistant", "正在生成", 40, "turn-2"),
    ];
    const staleHistory = [
      message("backend-user-1", "user", "你好", 10),
      message("backend-assistant-1", "assistant", "第一轮回复", 20),
    ];

    const merged = mergeHistorySnapshot(current, staleHistory, "turn-2");

    expect(merged.map((item) => item.id)).toEqual([
      "backend-user-1",
      "backend-assistant-1",
      "user-turn-2",
      "assistant-turn-2",
    ]);
  });

  it("keeps a protected assistant reply even when it resembles an earlier turn", () => {
    const current = [
      message("backend-user-1", "user", "你好", 10, "turn-1"),
      message("backend-assistant-1", "assistant", "你好，有什么可以帮你？", 20, "turn-1"),
      message("user-turn-2", "user", "你好", 30, "turn-2"),
      message("assistant-turn-2", "assistant", "你好，有什么可以帮你？", 40, "turn-2"),
    ];
    const staleHistory = [
      message("backend-user-1", "user", "你好", 10, "turn-1"),
      message("backend-assistant-1", "assistant", "你好，有什么可以帮你？", 20, "turn-1"),
    ];

    const merged = mergeHistorySnapshot(current, staleHistory, "turn-2");

    expect(merged.map((item) => item.id)).toEqual([
      "backend-user-1",
      "backend-assistant-1",
      "user-turn-2",
      "assistant-turn-2",
    ]);
  });

  it("does not collapse repeated completed turns from backend history", () => {
    const history = [
      message("backend-user-1", "user", "你好", 10),
      message("backend-assistant-1", "assistant", "回复", 20),
      message("backend-user-2", "user", "你好", 30),
      message("backend-assistant-2", "assistant", "回复", 40),
    ];

    const merged = mergeHistorySnapshot([], history);

    expect(merged.map((item) => item.id)).toEqual([
      "backend-user-1",
      "backend-assistant-1",
      "backend-user-2",
      "backend-assistant-2",
    ]);
  });

  it("drops unprotected local assistant leftovers when backend history arrives", () => {
    const current = [
      message("backend-user-1", "user", "第一句", 10),
      message("backend-assistant-1", "assistant", "第一轮回复", 20),
      message("assistant-stale", "assistant", "上次残留的回复", 30, "turn-stale"),
    ];
    const history = [
      message("backend-user-1", "user", "第一句", 10),
      message("backend-assistant-1", "assistant", "第一轮回复", 20),
    ];

    const merged = mergeHistorySnapshot(current, history);

    expect(merged.map((item) => item.id)).toEqual(["backend-user-1", "backend-assistant-1"]);
  });

  it("keeps locally submitted prompt state when history still has the pending card", () => {
    const current: ChatMessage[] = [
      message("backend-user-1", "user", "我想创建一个宣传海报 skill", 10, "turn-1"),
      {
        id: "assistant-turn-1",
        role: "assistant",
        text: "",
        timestamp: 30,
        turnId: "turn-1",
        uiEvents: [
          {
            type: "skill_studio.questions",
            bridge_key: "skill-key-1",
            skill_studio_session_id: "studio-1",
            questions: [],
            submitted: true,
            action: "submit",
            selections: { audience: { option_ids: ["locals"], custom_text: "" } },
          },
        ],
      },
    ];
    const history: ChatMessage[] = [
      message("backend-user-1", "user", "我想创建一个宣传海报 skill", 10, "turn-1"),
      {
        id: "backend-assistant-1",
        role: "assistant",
        text: "",
        timestamp: 20,
        turnId: "turn-1",
        uiEvents: [
          {
            type: "skill_studio.questions",
            bridge_key: "skill-key-1",
            skill_studio_session_id: "studio-1",
            questions: [],
          },
        ],
      },
    ];

    const merged = mergeHistorySnapshot(current, history, "turn-1");
    const assistant = merged.find((item) => item.role === "assistant");

    expect(assistant?.uiEvents?.[0]).toMatchObject({
      type: "skill_studio.questions",
      bridge_key: "skill-key-1",
      submitted: true,
      action: "submit",
      selections: { audience: { option_ids: ["locals"], custom_text: "" } },
    });
  });

  it("keeps locally edited draft state when history still has the original draft", () => {
    const current: ChatMessage[] = [
      message("backend-user-1", "user", "生成 skill 草稿", 10, "turn-1"),
      {
        id: "assistant-turn-1",
        role: "assistant",
        text: "",
        timestamp: 30,
        turnId: "turn-1",
        uiEvents: [
          {
            type: "skill_studio.draft",
            bridge_key: "draft-key-1",
            skill_studio_session_id: "studio-1",
            draft: {
              skill: { id: "edited-skill", description: "编辑后的草稿" },
              recipes: [],
            },
          },
        ],
      },
    ];
    const history: ChatMessage[] = [
      message("backend-user-1", "user", "生成 skill 草稿", 10, "turn-1"),
      {
        id: "backend-assistant-1",
        role: "assistant",
        text: "",
        timestamp: 20,
        turnId: "turn-1",
        uiEvents: [
          {
            type: "skill_studio.draft",
            bridge_key: "draft-key-1",
            skill_studio_session_id: "studio-1",
            skill: { id: "original-skill", description: "原始草稿" },
            recipes: [],
          },
        ],
      },
    ];

    const merged = mergeHistorySnapshot(current, history, "turn-1");
    const assistant = merged.find((item) => item.role === "assistant");

    expect(assistant?.uiEvents).toHaveLength(1);
    expect(assistant?.uiEvents?.[0]).toMatchObject({
      type: "skill_studio.draft",
      bridge_key: "draft-key-1",
      draft: {
        skill: { id: "edited-skill", description: "编辑后的草稿" },
      },
    });
  });
});

describe("assistant message ordered parts", () => {
  it("hydrates ordered draft parts with merged cancellation state without dropping draft content", () => {
    const parts = hydrateOrderedPartsWithUiEventsForTest(
      [
        {
          id: "skill_studio.draft:draft-key-1",
          type: "skill_studio",
          event: {
            type: "skill_studio.draft",
            bridge_key: "draft-key-1",
            skill_studio_session_id: "studio-1",
            draft: {
              skill: { id: "pixar-ip-brand-ad", description: "皮克斯广告" },
              recipes: [{ id: "character-design" }],
            },
          },
        },
      ],
      [
        {
          type: "skill_studio.draft",
          bridge_key: "draft-key-1",
          skill_studio_session_id: "studio-1",
          draft: {
            skill: { id: "pixar-ip-brand-ad", description: "皮克斯广告" },
            recipes: [{ id: "character-design" }],
          },
        },
        {
          type: "skill_studio.draft",
          bridge_key: "draft-key-1",
          skill_studio_session_id: "studio-1",
          cancelled: true,
        },
      ],
    );

    expect(parts?.[0]).toMatchObject({
      type: "skill_studio",
      event: {
        type: "skill_studio.draft",
        cancelled: true,
        draft: {
          skill: { id: "pixar-ip-brand-ad", description: "皮克斯广告" },
          recipes: [{ id: "character-design" }],
        },
      },
    });
  });

  it("keeps text and interaction cards in arrival order within one turn", () => {
    let messages: ChatMessage[] = [];

    messages = upsertAssistantMessageForTest(messages, "turn-ordered", "第一段文字");
    messages = upsertAssistantUiEventForTest(messages, "turn-ordered", {
      type: "skill_studio.questions",
      bridge_key: "questions-1",
      skill_studio_session_id: "studio-1",
      title: "方向确认",
      questions: [],
    });
    messages = upsertAssistantMessageForTest(messages, "turn-ordered", "第一段文字\n\n第二段文字");
    messages = upsertAssistantUiEventForTest(messages, "turn-ordered", {
      type: "skill_studio.draft",
      bridge_key: "draft-1",
      skill_studio_session_id: "studio-1",
      summary: "草稿",
      skill: { id: "skill-1" },
      recipes: [],
    });
    messages = upsertAssistantMessageForTest(
      messages,
      "turn-ordered",
      "第一段文字\n\n第二段文字\n\n第三段文字",
    );

    const assistant = messages.find((item) => item.turnId === "turn-ordered" && item.role === "assistant");
    expect(assistant?.parts?.map((part) => part.type)).toEqual([
      "text",
      "skill_studio",
      "text",
      "skill_studio",
      "text",
    ]);
    expect(assistant?.parts?.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      "第一段文字",
      "\n\n第二段文字",
      "\n\n第三段文字",
    ]);
  });

  it("keeps Skill Studio status in ordered parts after a submitted question card", () => {
    let messages: ChatMessage[] = [];

    messages = upsertAssistantUiEventForTest(messages, "turn-skill-status", {
      type: "skill_studio.questions",
      bridge_key: "questions-1",
      skill_studio_session_id: "studio-1",
      submitted: true,
      action: "submit",
      questions: [],
    });
    messages = upsertAssistantUiEventForTest(messages, "turn-skill-status", {
      type: "skill_studio.status",
      status: "draft_begin",
      message: "正在创建草稿结构...",
    });

    const assistant = messages.find((item) => item.turnId === "turn-skill-status" && item.role === "assistant");
    expect(assistant?.parts?.map((part) => part.type)).toEqual(["skill_studio", "skill_studio"]);
    expect(assistant?.parts?.map((part) => part.type === "text" ? part.text : (part.event as { type?: string }).type)).toEqual([
      "skill_studio.questions",
      "skill_studio.status",
    ]);
  });

  it("removes transient Skill Studio status from ordered parts when prose arrives", () => {
    let messages: ChatMessage[] = [];

    messages = upsertAssistantUiEventForTest(messages, "turn-skill-status", {
      type: "skill_studio.status",
      status: "draft_begin",
      message: "正在创建草稿结构...",
    });
    messages = upsertAssistantMessageForTest(messages, "turn-skill-status", "开始整理草稿");

    const assistant = messages.find((item) => item.turnId === "turn-skill-status" && item.role === "assistant");
    expect(assistant?.parts?.map((part) => part.type)).toEqual(["text"]);
    expect(assistant?.parts?.[0]).toMatchObject({ type: "text", text: "开始整理草稿" });
  });

  it("removes transient Skill Studio status when the final assistant message arrives", () => {
    let messages: ChatMessage[] = [];

    messages = upsertAssistantUiEventForTest(messages, "turn-skill-status", {
      type: "skill_studio.questions",
      bridge_key: "questions-1",
      skill_studio_session_id: "studio-1",
      submitted: true,
      action: "submit",
      questions: [],
    });
    messages = upsertAssistantUiEventForTest(messages, "turn-skill-status", {
      type: "skill_studio.status",
      status: "draft_recipe_ready",
      message: "已生成 Recipe 2 / 6",
    });
    messages = upsertServerAssistantMessageForTest(
      messages,
      {
        id: 3,
        role: "assistant",
        content: "草稿生成未完成，请继续补充调整方向。",
        turn_id: "turn-skill-status",
        created_at: "2026-07-15T08:51:44.199417+00:00",
      },
      "turn-skill-status",
    );

    const assistant = messages.find((item) => item.turnId === "turn-skill-status" && item.role === "assistant");
    expect(assistant?.text).toBe("草稿生成未完成，请继续补充调整方向。");
    expect(assistant?.parts?.map((part) => part.type)).toEqual(["skill_studio", "text"]);
    expect(assistant?.parts?.map((part) => part.type === "text" ? part.text : (part.event as { type?: string }).type)).toEqual([
      "skill_studio.questions",
      "草稿生成未完成，请继续补充调整方向。",
    ]);
    expect(assistant?.uiEvents?.map((event) => (event as { type?: string }).type)).toEqual([
      "skill_studio.questions",
    ]);
  });

  it("clears transient Skill Studio status when a turn completes without a final assistant payload", () => {
    let messages: ChatMessage[] = [];

    messages = upsertAssistantUiEventForTest(messages, "turn-skill-status", {
      type: "skill_studio.questions",
      bridge_key: "questions-1",
      skill_studio_session_id: "studio-1",
      submitted: true,
      action: "submit",
      questions: [],
    });
    messages = upsertAssistantUiEventForTest(messages, "turn-skill-status", {
      type: "skill_studio.status",
      status: "draft_recipe_ready",
      message: "已生成 Recipe 2 / 6",
    });

    const cleaned = removeSkillStudioStatusForTurnForTest(messages, "turn-skill-status");
    const assistant = cleaned.find((item) => item.turnId === "turn-skill-status" && item.role === "assistant");

    expect(assistant?.parts?.map((part) => part.type === "text" ? part.text : (part.event as { type?: string }).type)).toEqual([
      "skill_studio.questions",
    ]);
    expect(assistant?.uiEvents?.map((event) => (event as { type?: string }).type)).toEqual([
      "skill_studio.questions",
    ]);
  });

  it("hydrates ordered part events from the latest uiEvents without changing order", () => {
    const parts = hydrateOrderedPartsWithUiEventsForTest(
      [
        {
          id: "skill_studio.draft:draft-key-1",
          type: "skill_studio",
          event: {
            type: "skill_studio.draft",
            bridge_key: "draft-key-1",
            draft: { skill: { id: "public-welfare-short-film" }, recipes: [] },
          },
        },
        {
          id: "assistant.clarification.request:clarify-key-1",
          type: "clarification",
          event: {
            type: "assistant.clarification.request",
            bridge_key: "clarify-key-1",
            title: "修订方向",
          },
        },
      ],
      [
        {
          type: "skill_studio.draft",
          bridge_key: "draft-key-1",
          revision_pending: true,
          action: "start_revision",
        },
      ],
    );

    expect(parts?.map((part) => part.id)).toEqual([
      "skill_studio.draft:draft-key-1",
      "assistant.clarification.request:clarify-key-1",
    ]);
    expect((parts?.[0] as { event?: { revision_pending?: boolean } }).event?.revision_pending).toBe(true);
  });
});

describe("updateAssistantUiEvents", () => {
  it("updates matching ordered parts even when uiEvents are absent", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-turn-a",
        role: "assistant",
        text: "",
        turnId: "turn-a",
        timestamp: 1,
        parts: [
          {
            id: "clarification:bridge-a",
            type: "clarification",
            event: {
              type: "assistant.clarification.request",
              bridge_key: "bridge-a",
              submitted: false,
            },
          },
        ],
      },
    ];

    const updated = updateAssistantUiEventsForTest(
      messages,
      "turn-a",
      (event) =>
        Boolean(
          event
          && typeof event === "object"
          && (event as Record<string, unknown>).bridge_key === "bridge-a",
        ),
      (event) => ({ ...(event as Record<string, unknown>), submitted: true }),
    );

    expect(updated).not.toBe(messages);
    expect((updated[0].parts?.[0] as { event?: { submitted?: boolean } }).event?.submitted).toBe(true);
  });
});

describe("normalizeMessage", () => {
  it("strips internal DramaClaw context blocks from displayed text", () => {
    const normalized = normalizeMessage({
      id: "backend-user-1",
      role: "user",
      content: `上传了哪些文件了

[DRAMACLAW_UPLOADED_FILES]
dramaclaw_project_id: 01KT62KTBQCDR69WW889VHJR3N
file_1_filename: 她与她的江山.docx
[/DRAMACLAW_UPLOADED_FILES]`,
      created_at: "2026-06-03T09:00:00Z",
    });

    expect(normalized?.text).toBe("上传了哪些文件了");
  });

  it("strips internal SuperTale canvas command blocks from displayed text", () => {
    const normalized = normalizeMessage({
      id: "backend-user-2",
      role: "user",
      content: `你好

[SUPERTALE_CANVAS_CHAT_COMMANDS]
This Freezone chat can change the current canvas by returning a JSON block.
[/SUPERTALE_CANVAS_CHAT_COMMANDS]`,
      created_at: "2026-06-08T08:00:00Z",
    });

    expect(normalized?.text).toBe("你好");
  });

  it("maps internal empty Hermes replies to a user-facing message", () => {
    const normalized = normalizeMessage({
      id: "backend-assistant-empty",
      role: "assistant",
      content: "(hermes returned no content)",
      created_at: "2026-07-10T08:00:00Z",
    });

    expect(normalized?.text).toBe("这轮操作没有收到虾导的有效回复，请稍后重试。");
  });

  it("preserves backend ui events for persisted canvas feedback", () => {
    const uiEvents = [
      {
        type: "canvas_command_result",
        bridge_key: "bridge-a",
      },
    ];
    const normalized = normalizeMessage({
      id: "assistant-1",
      role: "assistant",
      content: "已完成",
      ui_events: uiEvents,
    });

    expect(normalized?.uiEvents).toBe(uiEvents);
  });

  it("keeps ordered canvas and tool parts from cache or server history", () => {
    const normalized = normalizeMessage({
      id: "assistant-1",
      role: "assistant",
      text: "",
      parts: [
        {
          id: "feedback-a",
          type: "canvas_feedback",
          event: { key: "feedback-a", applied: true },
        },
        {
          id: "tool-a",
          type: "tool_status",
          event: { role: "tool", text: "创建节点", raw: { type: "tool.result" } },
        },
      ],
    });

    expect(normalized?.parts?.map((part) => part.type)).toEqual(["canvas_feedback", "tool_status"]);
  });

  it("restores trailing assistant text when ordered history parts stop at an interaction card", () => {
    const normalized = normalizeMessage({
      id: "assistant-1",
      role: "assistant",
      content: "先确认方向。\n\n草稿已生成。\n\nSkill 已创建完成，可以继续使用。",
      parts: [
        {
          id: "text-1",
          type: "text",
          text: "先确认方向。\n\n",
        },
        {
          id: "draft-1",
          type: "skill_studio",
          event: {
            type: "skill_studio.draft",
            bridge_key: "draft-1",
          },
        },
      ],
    });

    expect(normalized?.parts?.map((part) => part.type)).toEqual(["text", "skill_studio", "text"]);
    expect(normalized?.parts?.[2]).toMatchObject({
      type: "text",
      text: "草稿已生成。\n\nSkill 已创建完成，可以继续使用。",
    });
  });

  it("restores assistant text when ordered history parts only contain interaction cards", () => {
    const normalized = normalizeMessage({
      id: "assistant-1",
      role: "assistant",
      content: "Skill 已保存成功，可以直接使用。",
      parts: [
        {
          id: "clarification-1",
          type: "clarification",
          event: {
            type: "assistant.clarification.request",
            bridge_key: "clarify-key-1",
            submitted: true,
          },
        },
        {
          id: "draft-1",
          type: "skill_studio",
          event: {
            type: "skill_studio.draft",
            bridge_key: "draft-key-1",
          },
        },
      ],
    });

    expect(normalized?.parts?.map((part) => part.type)).toEqual(["clarification", "skill_studio", "text"]);
    expect(normalized?.parts?.[2]).toMatchObject({
      type: "text",
      text: "Skill 已保存成功，可以直接使用。",
    });
  });

  it("hydrates ordered interaction parts from newer persisted ui events", () => {
    const normalized = normalizeMessage({
      id: "assistant-1",
      role: "assistant",
      content: "草稿已生成。",
      parts: [
        {
          id: "draft-1",
          type: "skill_studio",
          event: {
            type: "skill_studio.draft",
            bridge_key: "draft-key-1",
            submitted: false,
            draft: { skill: { id: "draft-skill" }, recipes: [] },
          },
        },
      ],
      ui_events: [
        {
          type: "skill_studio.draft",
          bridge_key: "draft-key-1",
          submitted: true,
          saved_to_catalog: true,
          saved_skill_ids: ["draft-skill"],
          saved_recipe_ids: ["draft-recipe"],
          draft: { skill: { id: "saved-skill" }, recipes: [] },
        },
      ],
    });

    expect(normalized?.parts?.[0]).toMatchObject({
      type: "skill_studio",
      event: {
        type: "skill_studio.draft",
        bridge_key: "draft-key-1",
        submitted: true,
        saved_to_catalog: true,
        saved_skill_ids: ["draft-skill"],
        draft: { skill: { id: "saved-skill" } },
      },
    });
  });
});

describe("normalizeMessageForScope", () => {
  const freezoneScope = scopeForProjectForTest("project-a", "freezone", "canvas-a", "agent-a");
  const directorScope = scopeForProjectForTest("project-a", "director");
  const canvasReferencePayload = {
    schema_version: CANVAS_NODE_REFERENCE_SCHEMA_VERSION,
    project: "project-a",
    canvas_id: "canvas-a",
    nodes: [
      {
        node_id: "node-text",
        node_type: "textAnnotationNode",
        label: "文本",
        text_field: "content",
        text_content: "你好",
        media_type: null,
        source_url: null,
        preview_url: null,
        slot_target: null,
        mainline_context: null,
        candidate_origin: null,
        position: { x: 0, y: 0 },
        action_catalog: { actions: [] },
      },
    ],
    edges: [],
  };
  const canvasReferenceMedia = {
    id: "canvas_node_reference:文本",
    kind: CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
    type: CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
    label: "文本",
    content: JSON.stringify(canvasReferencePayload),
  };

  it("hydrates cached Freezone canvas node references from raw media", () => {
    const normalized = normalizeMessageForScopeForTest(
      {
        id: "user-1",
        role: "user",
        text: "帮我连接到图片节点",
        attachments: [
          {
            id: "canvas_node_reference:文本",
            type: CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
            kind: CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
            label: "文本",
            fileName: "文本",
          },
        ],
        rawMedia: [canvasReferenceMedia],
      },
      "assistant",
      freezoneScope,
    );

    expect(normalized?.attachments).toHaveLength(1);
    expect(normalized?.attachments?.[0].content).toBe(JSON.stringify(canvasReferencePayload));
    expect(isCanvasNodeReferenceAttachment(normalized!.attachments![0])).toBe(true);
  });

  it("does not hydrate canvas node references for the director scope", () => {
    const normalized = normalizeMessageForScopeForTest(
      {
        id: "user-1",
        role: "user",
        text: "帮我连接到图片节点",
        attachments: [
          {
            id: "canvas_node_reference:文本",
            type: CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
            kind: CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
            label: "文本",
            fileName: "文本",
          },
        ],
        rawMedia: [canvasReferenceMedia],
      },
      "assistant",
      directorScope,
    );

    expect(normalized?.attachments).toEqual([]);
  });
});

describe("upsertServerAssistantMessage", () => {
  it("keeps live agent details visible when the final assistant message arrives", () => {
    const current = upsertRuntimePartInMessagesForTest([], "turn-agent", {
      id: "agent_thought:turn-agent",
      type: "agent_thought",
      event: { text: "正在检查素材" },
    });

    const merged = upsertServerAssistantMessageForTest(
      current,
      {
        id: 7,
        role: "assistant",
        content: "素材检查完成",
        turn_id: "turn-agent",
        created_at: "2026-07-19T00:00:00+00:00",
      },
      "turn-agent",
    );

    const assistant = merged.find((item) => item.role === "assistant");
    expect(assistant?.parts?.map((part) => part.type)).toEqual(["agent_thought", "text"]);
  });

  it("preserves transient ui events when the final assistant message arrives", () => {
    const uiEvent = {
      type: "skill_studio.questions",
      skill_studio_session_id: "skill_studio_01",
      questions: [],
    };
    const current: ChatMessage[] = [
      message("user-turn-1", "user", "创建 Skill", 10, "turn-1"),
      {
        id: "assistant-turn-1",
        role: "assistant",
        text: "",
        timestamp: 20,
        turnId: "turn-1",
        uiEvents: [uiEvent],
      },
    ];

    const merged = upsertServerAssistantMessageForTest(
      current,
      {
        id: 3,
        role: "assistant",
        content: "已进入问答环节",
        turn_id: "turn-1",
        created_at: "2026-07-08T03:47:06.538231+00:00",
      },
      "turn-1",
    );

    const assistant = merged.find((item) => item.role === "assistant");
    expect(assistant?.text).toBe("已进入问答环节");
    expect(assistant?.uiEvents).toEqual([uiEvent]);
  });

  it("merges same draft ui event when the final assistant message arrives", () => {
    const current: ChatMessage[] = [
      message("user-turn-1", "user", "创建 Skill", 10, "turn-1"),
      {
        id: "assistant-turn-1",
        role: "assistant",
        text: "",
        timestamp: 20,
        turnId: "turn-1",
        uiEvents: [
          {
            type: "skill_studio.draft",
            bridge_key: "draft-key-1",
            skill_studio_session_id: "studio-1",
            skill: { id: "original-skill" },
          },
          {
            type: "skill_studio.draft",
            bridge_key: "draft-key-1",
            skill_studio_session_id: "studio-1",
            draft: { skill: { id: "edited-skill" }, recipes: [] },
          },
        ],
      },
    ];

    const merged = upsertServerAssistantMessageForTest(
      current,
      {
        id: 3,
        role: "assistant",
        content: "继续处理",
        turn_id: "turn-1",
        created_at: "2026-07-08T03:47:06.538231+00:00",
      },
      "turn-1",
    );

    const assistant = merged.find((item) => item.role === "assistant");
    expect(assistant?.uiEvents).toHaveLength(1);
    expect(assistant?.uiEvents?.[0]).toMatchObject({
      type: "skill_studio.draft",
      bridge_key: "draft-key-1",
      draft: { skill: { id: "edited-skill" } },
    });
  });

  it("preserves transient clarification parts when the final assistant message has draft parts", () => {
    const current: ChatMessage[] = [
      message("user-turn-1", "user", "创建 Skill", 10, "turn-1"),
      {
        id: "assistant-turn-1",
        role: "assistant",
        text: "先确认方向。",
        timestamp: 20,
        turnId: "turn-1",
        parts: [
          { id: "text-1", type: "text", text: "先确认方向。" },
          {
            id: "assistant.clarification.request:clarify-key-1",
            type: "clarification",
            event: {
              type: "assistant.clarification.request",
              bridge_key: "clarify-key-1",
              clarification_id: "hometown-culture-poster-skill-setup",
              submitted: true,
              questions: [],
            },
          },
        ],
      },
    ];

    const merged = upsertServerAssistantMessageForTest(
      current,
      {
        id: 3,
        role: "assistant",
        content: "先确认方向。\n\n草稿已生成。",
        turn_id: "turn-1",
        created_at: "2026-07-08T03:47:06.538231+00:00",
        parts: [
          { id: "text-1", type: "text", text: "先确认方向。\n\n" },
          {
            id: "skill_studio.draft:draft-key-1",
            type: "skill_studio",
            event: {
              type: "skill_studio.draft",
              bridge_key: "draft-key-1",
              skill_studio_session_id: "studio-1",
              skill: { id: "home-culture" },
              recipes: [],
            },
          },
        ],
      },
      "turn-1",
    );

    const assistant = merged.find((item) => item.role === "assistant");
    expect(assistant?.parts?.map((part) => part.type)).toEqual(["clarification", "text", "skill_studio", "text"]);
    expect(assistant?.parts?.[0]).toMatchObject({
      type: "clarification",
      event: {
        type: "assistant.clarification.request",
        bridge_key: "clarify-key-1",
      },
    });
  });
});

describe("updateAssistantUiEvents", () => {
  it("persists submitted Skill Studio question selections on the assistant message", () => {
    const current: ChatMessage[] = [
      {
        id: "assistant-turn-1",
        role: "assistant",
        text: "",
        timestamp: 20,
        turnId: "turn-1",
        uiEvents: [
          {
            type: "skill_studio.questions",
            skill_studio_session_id: "skill_studio_01",
            questions: [],
          },
        ],
      },
    ];

    const next = updateAssistantUiEventsForTest(
      current,
      "turn-1",
      (event) =>
        Boolean(
          event
            && typeof event === "object"
            && (event as Record<string, unknown>).type === "skill_studio.questions",
        ),
      (event) => ({
        ...(event as Record<string, unknown>),
        submitted: true,
        action: "submit",
        selections: { audience: "young" },
      }),
    );

    expect(next[0]?.uiEvents?.[0]).toMatchObject({
      type: "skill_studio.questions",
      submitted: true,
      action: "submit",
      selections: { audience: "young" },
    });
  });
});

describe("Skill Studio question response", () => {
  it("uses the server turn id for incoming UI events before pending local turns", () => {
    expect(resolveUiEventTurnIdForTest("server-turn", "pending-turn", "active-turn")).toBe("server-turn");
    expect(resolveUiEventTurnIdForTest("  ", "pending-turn", "active-turn")).toBe("pending-turn");
    expect(resolveUiEventTurnIdForTest(null, null, "active-turn")).toBe("active-turn");
  });

  it("hides generic waiting status while a composer prompt is active", () => {
    expect(shouldShowComposerWaitingIndicator({
      busy: true,
      hasAssistantText: false,
      streamText: "",
      pendingCanvasCommandApprovalCount: 0,
      hasPendingVisibleUserMessage: true,
      hasThinkingCanvasContextActivity: false,
      hasActiveComposerPrompt: true,
    })).toBe(false);
  });

  it("keeps an existing assistant event message in its original timeline position", () => {
    const current = [
      message("assistant-turn-1", "assistant", "", 10, "turn-1"),
      message("user-turn-2", "user", "用户提交后的下一条消息", 20, "turn-2"),
    ];

    const next = upsertAssistantUiEventForTest(current, "turn-1", {
      type: "assistant.clarification.request",
      clarification_id: "clarify-1",
      submitted: true,
    });

    expect(next.map((item) => item.id)).toEqual(["assistant-turn-1", "user-turn-2"]);
    expect(next[0]?.timestamp).toBe(10);
    expect(next[0]?.uiEvents?.[0]).toMatchObject({
      type: "assistant.clarification.request",
      clarification_id: "clarify-1",
    });
  });

  it("marks an assistant message with pending questions as waiting for the user", () => {
    const pending = message("assistant-skill-question", "assistant", "", 100);
    pending.uiEvents = [
      {
        type: "skill_studio.questions",
        title: "创建宣传海报 Skill",
        questions: [
          {
            id: "audience",
            title: "目标受众是谁？",
            options: [{ id: "locals", label: "本地居民" }],
          },
        ],
      },
    ];

    const submitted = message("assistant-skill-question-done", "assistant", "", 100);
    submitted.uiEvents = [
      {
        type: "skill_studio.questions",
        submitted: true,
        title: "创建宣传海报 Skill",
        questions: [],
      },
    ];

    expect(messageIsWaitingForUserReplyForTest(pending)).toBe(true);
    expect(messageIsWaitingForUserReplyForTest(submitted)).toBe(false);
  });

  it("does not keep a stale clarification card active after a draft exists", () => {
    const stale = message("assistant-clarification-stale", "assistant", "(hermes timed out)", 100);
    stale.uiEvents = [
      {
        type: "assistant.clarification.request",
        bridge_key: "clarify-key-1",
        title: "家乡文化海报 Skill 设定",
        questions: [
          {
            id: "audience",
            title: "海报主要面向哪类人群？",
            options: [{ id: "tourist", label: "外地游客" }],
          },
        ],
      },
      {
        type: "skill_studio.draft",
        bridge_key: "draft-key-1",
        draft: {
          skill: { id: "home-culture-poster" },
          recipes: [],
        },
      },
    ];

    expect(messageIsWaitingForUserReplyForTest(stale)).toBe(false);
  });

  it("uses the latest pending clarification after a draft instead of an older stale one", () => {
    const assistant = message("assistant-clarification-sequence", "assistant", "", 100);
    assistant.turnId = "turn-sequence";
    assistant.uiEvents = [
      {
        type: "assistant.clarification.request",
        bridge_key: "clarify-old",
        title: "旧问题",
        questions: [{ id: "old_question", title: "旧问题", options: [{ id: "old", label: "旧" }] }],
      },
      {
        type: "skill_studio.draft",
        bridge_key: "draft-key",
        draft: { skill: { id: "public-service-video" }, recipes: [] },
      },
      {
        type: "assistant.clarification.request",
        bridge_key: "clarify-new",
        title: "新问题",
        questions: [{ id: "new_question", title: "新问题", options: [{ id: "new", label: "新" }] }],
      },
    ];

    expect(latestPendingAssistantClarificationEventForTest([assistant])?.bridge_key).toBe("clarify-new");
    expect(messageIsWaitingForUserReplyForTest(assistant)).toBe(true);
  });

  it("detects clarification cards that belong to a Skill Studio revision flow", () => {
    const assistant = message("assistant-revision-clarification", "assistant", "", 100);
    assistant.turnId = "turn-revision";
    assistant.uiEvents = [
      {
        type: "skill_studio.draft",
        bridge_key: "draft-key",
        revision_pending: true,
      },
      {
        type: "assistant.clarification.request",
        bridge_key: "clarify-revision",
        title: "修订方向",
        questions: [{ id: "focus", title: "先改哪里？", options: [{ id: "style", label: "风格" }] }],
      },
    ];

    expect(activeAssistantClarificationIsSkillStudioRevisionForTest(
      [assistant],
      {
        type: "assistant.clarification.request",
        bridge_key: "clarify-revision",
      },
    )).toBe(true);
    expect(activeAssistantClarificationIsSkillStudioRevisionForTest(
      [assistant],
      {
        type: "assistant.clarification.request",
        bridge_key: "other",
      },
    )).toBe(false);
  });

  it("uses the latest pending Skill Studio question in arrival order", () => {
    const assistant = message("assistant-skill-question-sequence", "assistant", "", 100);
    assistant.turnId = "turn-skill-sequence";
    assistant.uiEvents = [
      {
        type: "skill_studio.questions",
        bridge_key: "skill-question-old",
        questions: [{ id: "old_question", title: "旧问题", options: [{ id: "old", label: "旧" }] }],
      },
      {
        type: "skill_studio.questions",
        bridge_key: "skill-question-new",
        questions: [{ id: "new_question", title: "新问题", options: [{ id: "new", label: "新" }] }],
      },
    ];

    expect(latestPendingSkillStudioQuestionEventForTest([assistant])?.bridge_key).toBe("skill-question-new");
  });

  it("does not surface ended-turn pending clarification as the active composer prompt", () => {
    const endedAssistant = message("assistant-ended-clarification", "assistant", "", 100, "turn-ended");
    endedAssistant.uiEvents = [
      {
        type: "assistant.clarification.request",
        bridge_key: "clarify-ended",
        title: "历史问题",
        questions: [{ id: "history_question", title: "历史问题", options: [{ id: "old", label: "旧" }] }],
      },
    ];

    expect(latestPendingAssistantClarificationEventForActiveTurnForTest(
      [endedAssistant],
      { busy: false, activeTurnId: null },
    )).toBeNull();
    expect(latestPendingAssistantClarificationEventForActiveTurnForTest(
      [endedAssistant],
      { busy: true, activeTurnId: "turn-live" },
    )).toBeNull();
    expect(latestPendingAssistantClarificationEventForActiveTurnForTest(
      [endedAssistant],
      { busy: true, activeTurnId: "turn-ended" },
    )?.bridge_key).toBe("clarify-ended");
  });

  it("does not surface ended-turn pending Skill Studio questions as the active composer prompt", () => {
    const endedAssistant = message("assistant-ended-skill-question", "assistant", "", 100, "turn-ended");
    endedAssistant.uiEvents = [
      {
        type: "skill_studio.questions",
        bridge_key: "skill-question-ended",
        questions: [{ id: "history_question", title: "历史问题", options: [{ id: "old", label: "旧" }] }],
      },
    ];

    expect(latestPendingSkillStudioQuestionEventForActiveTurnForTest(
      [endedAssistant],
      { busy: false, activeTurnId: null },
    )).toBeNull();
    expect(latestPendingSkillStudioQuestionEventForActiveTurnForTest(
      [endedAssistant],
      { busy: true, activeTurnId: "turn-live" },
    )).toBeNull();
    expect(latestPendingSkillStudioQuestionEventForActiveTurnForTest(
      [endedAssistant],
      { busy: true, activeTurnId: "turn-ended" },
    )?.bridge_key).toBe("skill-question-ended");
  });

  it("uses bridge scoped identities for active composer question cards", () => {
    expect(assistantClarificationEventIdentityForTest({
      type: "assistant.clarification.request",
      bridge_key: "clarify-a",
      title: "同名问题",
    })).toBe("clarify-a");
    expect(assistantClarificationEventIdentityForTest({
      type: "assistant.clarification.request",
      bridge_key: "clarify-b",
      title: "同名问题",
    })).toBe("clarify-b");
    expect(skillStudioQuestionEventIdentityForTest({
      type: "skill_studio.questions",
      bridge_key: "skill-question-a",
      skill_studio_session_id: "studio-1",
      title: "同名问题",
    })).toBe("skill-question-a");
  });

  it("builds a chat message from selected card options", () => {
    const text = buildSkillStudioQuestionResponseForTest(
      {
        type: "skill_studio.questions",
        skill_studio_session_id: "skill_studio_01",
        title: "创建宣传海报 Skill",
        questions: [
          {
            id: "audience",
            title: "核心使用场景是什么？",
            options: [
              { id: "social", label: "用于社媒平台发布", description: "小红书/抖音等" },
            ],
          },
          {
            id: "style",
            title: "偏好的视觉风格是？",
            options: [
              { id: "ink", label: "水墨国风/新中式" },
              { id: "modern", label: "现代简约/信息图风" },
            ],
          },
        ],
      },
      { audience: "social", style: "modern" },
    );

    expect(text).toContain("Skill Studio 会话：skill_studio_01");
    expect(text).toContain("创建宣传海报 Skill");
    expect(text).toContain("核心使用场景是什么？：用于社媒平台发布（小红书/抖音等）");
    expect(text).toContain("偏好的视觉风格是？：现代简约/信息图风");
    expect(text).toContain("用户已完成选择，请结合当前上下文继续。");
    expect(text).not.toContain("继续生成 Skill / Recipe 草稿");
  });

  it("builds a persisted submitted assistant clarification event", () => {
    const event = {
      type: "assistant.clarification.request" as const,
      bridge_key: "clarify-key-1",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      anchor_text_prefix: "先确认方向",
      clarification_id: "home-culture-poster-skill-setup",
      title: "家乡文化海报 Skill 设置",
      description: "选完后生成草稿",
      questions: [
        {
          id: "poster_count",
          title: "海报数量",
          options: [{ id: "single", label: "单张主视觉海报" }],
        },
      ],
      allow_skip: true,
    };

    expect(buildPersistedAssistantClarificationEventForTest(event, {
      action: "submit",
      answers: { poster_count: "single" },
      clarificationStatus: "answered",
      skipped: false,
      usedRecommended: false,
      receivedAt: 123,
    })).toMatchObject({
      type: "assistant.clarification.request",
      bridge_key: "clarify-key-1",
      clarification_id: "home-culture-poster-skill-setup",
      received_at: 123,
      submitted: true,
      action: "submit",
      clarification_status: "answered",
      answers: { poster_count: "single" },
      skipped: false,
      used_recommended: false,
      questions: event.questions,
    });
  });

  it("keeps unanswered questions visible when partially submitted", () => {
    const text = buildSkillStudioQuestionResponseForTest(
      {
        type: "skill_studio.questions",
        skill_studio_session_id: "skill_studio_01",
        questions: [
          {
            id: "audience",
            title: "核心使用场景是什么？",
            options: [{ id: "social", label: "用于社媒平台发布" }],
          },
          {
            id: "style",
            title: "偏好的视觉风格是？",
            options: [{ id: "modern", label: "现代简约/信息图风" }],
          },
        ],
      },
      { audience: "social" },
    );

    expect(text).toContain("核心使用场景是什么？：用于社媒平台发布");
    expect(text).toContain("偏好的视觉风格是？：未选择");
  });

  it("describes multiple options and custom text in question answers", () => {
    const text = buildSkillStudioQuestionResponseForTest(
      {
        type: "skill_studio.questions",
        skill_studio_session_id: "skill_studio_multi",
        questions: [
          {
            id: "elements",
            title: "海报通常需要包含哪些内容元素？",
            selection_mode: "multiple",
            options: [
              { id: "intro", label: "家乡名称与简介" },
              { id: "feature", label: "特色图片/插画" },
              { id: "slogan", label: "宣传标语" },
            ],
          },
        ],
      },
      {
        elements: {
          option_ids: ["intro", "feature"],
          custom_text: "再加一个适合社媒传播的互动话题",
        },
      },
    );

    expect(text).toContain("海报通常需要包含哪些内容元素？：家乡名称与简介；特色图片/插画；补充：再加一个适合社媒传播的互动话题");
  });

  it("builds compact timeline items for submitted question cards", () => {
    const items = buildSkillStudioQuestionTimelineItemsForTest(
      [
        {
          id: "audience",
          title: "目标受众是谁？",
          options: [{ id: "travelers", label: "外地游客", description: "潜在旅行者" }],
        },
        {
          id: "elements",
          title: "希望突出哪些内容？",
          selection_mode: "multiple",
          options: [
            { id: "food", label: "地方美食" },
            { id: "heritage", label: "非遗文化" },
          ],
        },
        {
          id: "extra",
          title: "其他补充",
          options: [],
        },
      ],
      {
        audience: "travelers",
        elements: {
          option_ids: ["food", "heritage"],
          custom_text: "突出苏州桃花坞年画",
        },
      },
    );

    expect(items).toEqual([
      {
        key: "audience",
        title: "目标受众是谁？",
        summary: "外地游客（潜在旅行者）",
        answered: true,
      },
      {
        key: "elements",
        title: "希望突出哪些内容？",
        summary: "地方美食；非遗文化；补充：突出苏州桃花坞年画",
        answered: true,
      },
      {
        key: "extra",
        title: "其他补充",
        summary: "未选择",
        answered: false,
      },
    ]);
  });

  it("preserves submitted skip status in compact question cards", () => {
    const items = buildSkillStudioQuestionTimelineItemsForTest(
      [
        {
          id: "confirm",
          title: "草稿确认",
          options: [{ id: "needs_edit", label: "需要调整" }],
        },
      ],
      {},
      "skip",
    );

    expect(items).toEqual([
      {
        key: "confirm",
        title: "草稿确认",
        summary: "已跳过",
        answered: true,
      },
    ]);
  });

  it("builds a bridge tool result payload instead of a new chat message", () => {
    const payload = buildSkillStudioQuestionToolResultForTest(
      {
        type: "skill_studio.questions",
        bridge_key: "skill-key-1",
        project_id: "project-a",
        canvas_id: "canvas-a",
        agent_id: "agent-1",
        turn_id: "turn-a",
        skill_studio_session_id: "skill_studio_01",
        questions: [
          {
            id: "scope",
            title: "主要做什么？",
            options: [{ id: "planning", label: "策划" }],
          },
        ],
      },
      { scope: "planning" },
    );

    expect(payload).toMatchObject({
      bridge_key: "skill-key-1",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      tool_call_status: "completed",
      skill_studio_status: "answered",
      action: "submit",
      selections: { scope: "planning" },
      ok: true,
    });
    expect(payload.message).toContain("主要做什么？：策划");
  });

  it("summarizes canvas command failures without exposing protocol details to users", () => {
    const payload = buildCanvasCommandToolResultPayloadForTest({
      bridgeKey: "bridge-a",
      projectId: "project-a",
      canvasId: "canvas-a",
      result: {
        applied: 0,
        openedUiActions: 0,
        createdNodeIds: [],
        errors: [
          "envelopes[0].commands[0]: edge output role planning_text is not accepted by target imageGenNode for link_type prompt_for. Expected source role input_text.",
        ],
        commandResults: [
          {
            commandIndex: -1,
            type: "validate",
            status: "error",
            label: "校验画布命令",
            error:
              "edge output role planning_text is not accepted by target imageGenNode for link_type prompt_for. Expected source role input_text.",
          },
        ],
      },
    });

    expect(payload.user_message).toBe("当前文本需要先作为生成提示词连接到图片节点，我会按可执行的提示词来源来处理。");
    expect(payload.agent_hint).toContain("Do not mention");
    expect(payload.agent_hint).toContain("prompt_for");
    expect(payload.message).toBe(payload.user_message);
    expect(payload.errors.join("\n")).toContain("planning_text");
    expect(payload.user_message).not.toContain("planning_text");
    expect(payload.user_message).not.toContain("input_text");
    expect(payload.user_message).not.toContain("prompt_for");
  });

  it("keeps structured multiple-choice answers in bridge payload", () => {
    const payload = buildSkillStudioQuestionToolResultForTest(
      {
        type: "skill_studio.questions",
        bridge_key: "skill-key-2",
        questions: [
          {
            id: "content",
            title: "内容元素？",
            selection_mode: "multiple",
            options: [
              { id: "photo", label: "特色图片" },
              { id: "qr", label: "二维码/Logo" },
            ],
          },
        ],
      },
      {
        content: {
          option_ids: ["photo", "qr"],
          custom_text: "需要留一个主标题位置",
        },
      },
    );

    expect(payload.selections).toEqual({
      content: {
        option_ids: ["photo", "qr"],
        custom_text: "需要留一个主标题位置",
      },
    });
    expect(payload.message).toContain("内容元素？：特色图片；二维码/Logo；补充：需要留一个主标题位置");
  });
});

describe("Assistant clarification response", () => {
  it("builds a reusable clarification summary from selected answers", () => {
    const text = buildAssistantClarificationResponseForTest(
      {
        type: "assistant.clarification.request",
        clarification_id: "clarify_01",
        title: "向用户提问",
        questions: [
          {
            id: "skill_kind",
            title: "你想创建的 skill 是做什么的？",
            options: [
              { id: "workflow", label: "工作流自动化" },
              { id: "domain", label: "领域知识" },
            ],
          },
          {
            id: "scope",
            title: "这个 skill 的使用范围是？",
            options: [
              { id: "user", label: "用户级（推荐）" },
              { id: "project", label: "项目级" },
            ],
          },
        ],
      },
      {
        skill_kind: { option_ids: ["workflow"], custom_text: "用于海报生成" },
        scope: { option_ids: ["user"], custom_text: "" },
      },
    );

    expect(text).toContain("你想创建的 skill 是做什么的？\n工作流自动化；补充：用于海报生成");
    expect(text).toContain("这个 skill 的使用范围是？\n用户级（推荐）");
  });

  it("builds a generic bridge tool result payload", () => {
    const payload = buildAssistantClarificationToolResultForTest(
      {
        type: "assistant.clarification.request",
        bridge_key: "clarify-key-1",
        project_id: "project-a",
        canvas_id: "canvas-a",
        agent_id: "agent-1",
        turn_id: "turn-a",
        anchor_text_prefix: "我先问几个问题。",
        clarification_id: "clarify_01",
        questions: [
          {
            id: "skill_kind",
            title: "你想创建的 skill 是做什么的？",
            options: [{ id: "workflow", label: "工作流自动化" }],
          },
        ],
      },
      {
        skill_kind: { option_ids: ["workflow"], custom_text: "" },
      },
    );

    expect(payload).toMatchObject({
      bridge_key: "clarify-key-1",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      anchor_text_prefix: "我先问几个问题。",
      tool_call_status: "completed",
      clarification_status: "answered",
      action: "submit",
      answers: {
        skill_kind: { option_ids: ["workflow"], custom_text: "" },
      },
      ok: true,
    });
    expect(payload.message).toContain("你想创建的 skill 是做什么的？");
    expect(payload.message).not.toContain("一次只提出一个问题");
  });

  it("adds one-question guidance only for Skill Studio revision clarification results", () => {
    const payload = buildAssistantClarificationToolResultForTest(
      {
        type: "assistant.clarification.request",
        bridge_key: "clarify-key-revision",
        clarification_id: "revise_01",
        questions: [
          {
            id: "revision_focus",
            title: "你想先调整哪个方向？",
            options: [{ id: "style", label: "风格" }],
          },
        ],
      },
      {
        revision_focus: { option_ids: ["style"], custom_text: "" },
      },
      { skillStudioRevision: true },
    );

    expect(payload.message).toContain("Skill Studio 草稿修订流程");
    expect(payload.message).toContain("一次只提出一个问题");
  });
});

describe("Skill Studio status events", () => {
  it("marks assistant messages with a status event as Skill Studio UI", () => {
    expect(messageHasSkillStudioUiEventForTest({
      id: "assistant-turn-1",
      role: "assistant",
      text: "",
      timestamp: 10,
      turnId: "turn-1",
      uiEvents: [
        {
          type: "skill_studio.status",
          status: "routing",
          message: "正在进入 Skill Studio...",
        },
      ],
    })).toBe(true);
  });

  it("hides stale status once an interactive Skill Studio card is present", () => {
    expect(skillStudioEventsFromUiEventsForTest([
      {
        type: "skill_studio.status",
        status: "routing",
        message: "正在进入 Skill Studio...",
      },
      {
        type: "skill_studio.questions",
        skill_studio_session_id: "skill_studio_01",
        questions: [],
      },
    ]).map((event) => event.type)).toEqual(["skill_studio.questions"]);
  });

  it("shows real chunked progress after a submitted Skill Studio card", () => {
    expect(skillStudioEventsFromUiEventsForTest([
      {
        type: "skill_studio.questions",
        skill_studio_session_id: "skill_studio_01",
        submitted: true,
        questions: [],
      },
      {
        type: "skill_studio.status",
        status: "draft_begin",
        message: "正在创建草稿结构...",
      },
    ]).map((event) => event.type)).toEqual(["skill_studio.questions", "skill_studio.status"]);
  });

  it("keeps only the latest Skill Studio status update before the draft arrives", () => {
    const events = skillStudioEventsFromUiEventsForTest([
      {
        type: "skill_studio.status",
        status: "routing",
        message: "正在整理 Skill 方向...",
      },
      {
        type: "skill_studio.status",
        status: "drafting",
        message: "正在生成 Skill 草稿...",
      },
      {
        type: "skill_studio.status",
        status: "finalizing",
        message: "草稿较完整，正在补齐 Recipes 和校验项...",
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "skill_studio.status",
      status: "finalizing",
      message: "草稿较完整，正在补齐 Recipes 和校验项...",
    });
  });

  it("keeps real chunked draft progress ahead of later timer status", () => {
    const events = skillStudioEventsFromUiEventsForTest([
      {
        type: "skill_studio.status",
        status: "draft_recipe_ready",
        message: "已生成 Recipe 1 / 6",
      },
      {
        type: "skill_studio.status",
        status: "finalizing",
        message: "草稿较完整，正在补齐 Recipes 和校验项...",
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "skill_studio.status",
      status: "draft_recipe_ready",
      message: "已生成 Recipe 1 / 6",
    });
  });

  it("merges repeated Skill Studio question events into the latest state", () => {
    const events = skillStudioEventsFromUiEventsForTest([
      {
        type: "skill_studio.questions",
        bridge_key: "skill-key-1",
        skill_studio_session_id: "studio-1",
        questions: [],
      },
      {
        type: "skill_studio.questions",
        bridge_key: "skill-key-1",
        skill_studio_session_id: "studio-1",
        submitted: true,
        action: "submit",
        selections: { audience: "locals" },
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "skill_studio.questions",
      bridge_key: "skill-key-1",
      submitted: true,
      selections: { audience: "locals" },
    });
  });

  it("does not match different Skill Studio question cards only because they share a session", () => {
    const initialQuestion = {
      type: "skill_studio.questions" as const,
      bridge_key: "initial-question-key",
      skill_studio_session_id: "studio-1",
      questions: [],
    };
    const revisionQuestion = {
      type: "skill_studio.questions" as const,
      bridge_key: "revision-question-key",
      skill_studio_session_id: "studio-1",
      questions: [],
    };

    expect(skillStudioEventMatchesForTest(initialQuestion, revisionQuestion)).toBe(false);
    expect(skillStudioEventMatchesForTest(revisionQuestion, revisionQuestion)).toBe(true);
  });

  it("merges repeated Skill Studio draft events into the latest draft state", () => {
    const events = skillStudioEventsFromUiEventsForTest([
      {
        type: "skill_studio.draft",
        bridge_key: "draft-key-1",
        skill_studio_session_id: "studio-1",
        skill: { id: "original-skill" },
      },
      {
        type: "skill_studio.draft",
        bridge_key: "draft-key-1",
        skill_studio_session_id: "studio-1",
        draft: { skill: { id: "edited-skill" }, recipes: [] },
      },
      {
        type: "skill_studio.draft",
        bridge_key: "draft-key-1",
        skill_studio_session_id: "studio-1",
        submitted: true,
        draft: { skill: { id: "submitted-skill" }, recipes: [] },
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "skill_studio.draft",
      bridge_key: "draft-key-1",
      submitted: true,
      draft: { skill: { id: "submitted-skill" } },
    });
  });

  it("hides routing status once assistant prose has started", () => {
    expect(visibleSkillStudioEventsForMessageForTest({
      id: "assistant-turn-1",
      role: "assistant",
      text: "我正在查看可用 Skill。",
      timestamp: 10,
      turnId: "turn-1",
      uiEvents: [
        {
          type: "skill_studio.status",
          status: "routing",
          message: "正在进入 Skill Studio...",
        },
      ],
    }).map((event) => event.type)).toEqual([]);
  });

  it("hides routing status once an assistant clarification card is visible", () => {
    expect(visibleSkillStudioEventsForMessageForTest({
      id: "assistant-turn-1",
      role: "assistant",
      text: "",
      timestamp: 10,
      turnId: "turn-1",
      uiEvents: [
        {
          type: "skill_studio.status",
          status: "routing",
          message: "正在进入 Skill Studio...",
        },
        {
          type: "assistant.clarification.request",
          bridge_key: "clarify-key-1",
          title: "家乡文化短片 Skill 配置",
          submitted: true,
          action: "submit",
          questions: [],
          answers: {},
        },
      ],
    }).map((event) => event.type)).toEqual([]);
  });

  it("hides status-only Skill Studio messages once the same turn has a submitted card", () => {
    const statusOnly = message("assistant-status", "assistant", "", 10, "turn-1");
    statusOnly.uiEvents = [
      {
        type: "skill_studio.status",
        status: "routing",
        message: "正在进入 Skill Studio...",
      },
    ];

    expect(shouldHideSkillStudioStatusOnlyMessageForTest(statusOnly, new Set(["turn-1"]))).toBe(true);
    expect(shouldHideSkillStudioStatusOnlyMessageForTest(statusOnly, new Set(["turn-2"]))).toBe(false);
  });

  it("hides canvas context reads once a Skill Studio card is available", () => {
    const assistant = message("assistant-turn-1", "assistant", "", 10, "turn-1");
    assistant.uiEvents = [
      {
        type: "skill_studio.draft",
        skill_studio_session_id: "studio-1",
        draft: { skill: { id: "home-culture" }, recipes: [] },
      },
    ];

    const visible = visibleCanvasContextActivitiesForMessageForTest(assistant, [
      {
        key: "context:node-params",
        turnId: "turn-1",
        bridgeKey: "node-params",
        status: "done",
        labels: ["节点参数"],
        errors: [],
      },
      {
        key: "context:validate",
        turnId: "turn-1",
        bridgeKey: "validate",
        status: "done",
        labels: ["命令校验"],
        errors: [],
      },
    ]);

    expect(visible.map((activity) => activity.key)).toEqual(["context:validate"]);
  });
});

describe("Skill Studio draft response", () => {
  it("uses the same Chinese field names as the catalog edit pages", () => {
    expect(skillStudioDraftFieldLabelsForTest.skill).toMatchObject({
      keywords: "触发关键词",
      node_scopes: "节点类型",
      metaPlanningHints: "规划器提示词",
      promptStyleGuide: "风格指引",
      behaviorRules: "行为规则",
      passingScore: "通过分数线",
      domainRules: "领域规则",
      ratingBands: "评分档位",
      visualReviewItems: "视觉评审项",
      textReviewItems: "文案评审项",
    });
    expect(skillStudioDraftFieldLabelsForTest.recipe).toMatchObject({
      output_kind: "生成类型",
      action_keys: "操作类型",
      system_prompt: "System Prompt",
      must_have_items: "必需元素",
      planning_prompt: "规划器提示词",
      result_summary: "输出概述",
      requires_source_media: "依赖上游多模态输入",
      enabled: "启用",
      force_enhancement: "强制增强",
      skip_detail_check: "跳过细节检查",
    });
    const legacyRecipeKeys = [
      "required" + "_elements",
      "planner" + "_cue",
      "output" + "_summary",
      "needs" + "_multimodal_input",
    ];
    for (const legacyKey of legacyRecipeKeys) {
      expect(skillStudioDraftFieldLabelsForTest.recipe).not.toHaveProperty(legacyKey);
    }
  });

  it("maps canonical evaluation fields for draft display", () => {
    const fields = skillStudioEvaluationDraftFieldsForTest({
      quality_threshold: 7,
      domain_constraints: ["必须为竖版 9:16 比例"],
      rating_bands: [
        { score: 8, description: "风格统一且文化元素表达准确" },
      ],
      visual_review_items: [
        { name: "风格一致性", weight: 0.35, description: "是否符合国潮视觉风格" },
      ],
      text_review_items: [
        { name: "文案传播力", weight: 0.4, description: "标题是否有记忆点" },
      ],
      passingScore: 5,
      domainRules: ["旧字段不应显示"],
      scoreAnchors: [{ score: 10, description: "旧字段不应显示" }],
      visual: {
        dimensions: [{ name: "旧视觉字段", weight: 1, description: "不应显示" }],
      },
      text: {
        dimensions: [{ name: "旧文案字段", weight: 1, description: "不应显示" }],
      },
    });

    expect(fields).toEqual({
      qualityThreshold: 7,
      domainConstraints: ["必须为竖版 9:16 比例"],
      ratingBands: ["8：风格统一且文化元素表达准确"],
      visualReviewItems: ["风格一致性（0.35）：是否符合国潮视觉风格"],
      textReviewItems: ["文案传播力（0.4）：标题是否有记忆点"],
    });
  });

  it("builds a bridge tool result with the edited draft payload", () => {
    const event = {
      type: "skill_studio.draft" as const,
      bridge_key: "skill-key-2",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      skill_studio_session_id: "skill_studio_01",
      summary: "草稿摘要",
      skill: {
        id: "home-culture-poster",
        description: "家乡文化海报",
        category: "social",
        planning: {
          metaPlanningHints: "先识别地域符号",
        },
      },
      recipes: [
        {
          id: "home-culture-poster-image",
          name: "家乡文化海报出图",
          output_kind: "image",
          system_prompt: "生成海报",
          must_have_items: ["地域符号"],
        },
      ],
    };

    const payload = buildSkillStudioDraftToolResultForTest(event, {
      skill: event.skill,
      recipes: event.recipes,
      summary: event.summary,
    });

    expect(payload).toMatchObject({
      bridge_key: "skill-key-2",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      action: "confirm_add",
      skill_studio_status: "catalog_saved",
      saved_to_catalog: true,
      saved_skill_ids: ["home-culture-poster"],
      saved_recipe_ids: ["home-culture-poster-image"],
      draft: {
        skill: {
          id: "home-culture-poster",
          planning: {
            metaPlanningHints: "先识别地域符号",
          },
        },
        recipes: [
          {
            id: "home-culture-poster-image",
            must_have_items: ["地域符号"],
          },
        ],
      },
    });
    expect(payload.message).toContain("home-culture-poster");
    expect(payload.message).toContain("已保存为正式 Skill / Recipe");
  });

  it("builds a bridge tool result when the draft is cancelled", () => {
    const event = {
      type: "skill_studio.draft" as const,
      bridge_key: "skill-key-2",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      skill_studio_session_id: "skill_studio_01",
      draft: { skill: { id: "home-culture-poster" }, recipes: [] },
    };

    const payload = buildSkillStudioDraftCancelToolResultForTest(event);

    expect(payload).toMatchObject({
      bridge_key: "skill-key-2",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      action: "cancel",
      skill_studio_status: "catalog_cancelled",
      cancelled: true,
      saved_to_catalog: false,
      saved_skill_ids: [],
      saved_recipe_ids: [],
    });
    expect(payload.message).toContain("用户已取消 Skill Studio 草稿保存");
    expect(payload.message).toContain("本次草稿不会写入虾画配置");
    expect(payload.message).toContain("不要自动继续创建画布");
    expect(payload.message).not.toContain("继续回复");
  });

  it("builds a bridge tool result to start a Skill Studio draft revision session", () => {
    const event = {
      type: "skill_studio.draft" as const,
      bridge_key: "skill-key-3",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      skill_studio_session_id: "skill_studio_01",
      draft: { skill: { id: "home-culture-poster" }, recipes: [] },
    };
    const draft = {
      skill: {
        id: "home-culture-poster",
        description: "用户手动编辑后的草稿",
      },
      recipes: [],
      summary: "当前草稿",
    };

    const payload = buildSkillStudioDraftRevisionToolResultForTest(event, draft);

    expect(payload).toMatchObject({
      bridge_key: "skill-key-3",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      action: "start_revision",
      skill_studio_status: "revision_started",
      saved_to_catalog: false,
      draft,
    });
    expect(payload.message).toContain("启动 Skill Studio 草稿修改会话");
    expect(payload.message).toContain("基于当前完整草稿");
    expect(payload.message).toContain("用户已经明确表示需要调整");
    expect(payload.message).toContain("不要再询问是否需要调整");
    expect(payload.message).toContain("不要询问是否保存当前版本");
    expect(payload.message).toContain("save_now");
    expect(payload.message).toContain("一个问题一个问题");
    expect(payload.message).toContain("freezone_begin_agent_catalog_draft");
    expect(payload.message).toContain("freezone_finish_agent_catalog_draft");
    expect(payload.message).toContain("不要在单个 tool_call 里传完整 Skill / Recipe catalog");
    expect(payload.message).toContain("不要用普通文本总结修改结果");
  });

  it("shows the draft as AI adjusting while a revision session is pending", () => {
    expect(skillStudioDraftFooterTextForTest({
      submitted: false,
      cancelled: false,
      revisionPending: true,
    })).toBe("AI 调整中，请按后续问题补充修改方向");
  });

  it("normalizes the draft into catalog payloads before saving", () => {
    const items = buildSkillStudioCatalogSaveItemsForTest({
      skill: {
        id: "home-culture-poster",
        description: "家乡文化海报",
        category: "social",
        triggers: {
          keywords: ["家乡文化"],
          node_scopes: ["imageGeneration"],
        },
        planning: {
          metaPlanningHints: "先识别地域符号",
          promptStyleGuide: "水墨写意",
          behaviorRules: ["保持文化准确"],
          default_aspect_ratios: {
            imageGeneration: "9:16",
            textGeneration: "1:1",
            videoGeneration: "auto",
          },
        },
        evaluation: {
          scoreAnchors: [{ score: 8, description: "文化符号明确" }],
          passingScore: 7,
          domainRules: ["不得混用地域符号"],
          visual: {
            dimensions: [{ name: "文化识别度", weight: 0.6, description: "能看出地域特征" }],
          },
          text: {
            dimensions: [{ name: "文案清晰度", weight: 0.4, description: "文案简洁" }],
          },
        },
        workflow_templates: [
          {
            id: "home-culture-poster-flow",
            description: "生成家乡文化海报工作流",
            steps: [
              {
                id: "brief",
                step_number: 1,
                node_type: "textAnnotationNode",
                action_key: "home-culture-poster-brief",
              },
            ],
          },
        ],
      },
      recipes: [
        {
          id: "home-culture-poster-image",
          name: "家乡文化海报出图",
          output_kind: "image",
          action_keys: ["home-culture-poster-image"],
          system_prompt: "生成海报",
          must_have_items: ["地域符号"],
          planning_prompt: "根据地域符号生成海报",
          result_summary: "一张家乡文化海报",
          requires_source_media: true,
        },
      ],
    });

    expect(items).toEqual([
      expect.objectContaining({
        kind: "skills",
        payload: expect.objectContaining({
          id: "home-culture-poster",
          enabled: true,
          triggers: {
            keywords: ["家乡文化"],
            node_scopes: ["imageGeneration"],
          },
          planning: expect.objectContaining({
            planning_notes: "先识别地域符号",
            prompt_guide: "水墨写意",
            conduct_rules: ["保持文化准确"],
            default_aspect_ratios: {
              imageGeneration: "9:16",
            },
          }),
          evaluation: expect.objectContaining({
            quality_threshold: 7,
            domain_constraints: ["不得混用地域符号"],
            rating_bands: [{ score: 8, description: "文化符号明确" }],
            visual_review_items: [
              { name: "文化识别度", weight: 0.6, description: "能看出地域特征" },
            ],
            text_review_items: [
              { name: "文案清晰度", weight: 0.4, description: "文案简洁" },
            ],
          }),
          workflow_templates: [
            {
              id: "home-culture-poster-flow",
              description: "生成家乡文化海报工作流",
              steps: [
                {
                  id: "brief",
                  step_number: 1,
                  node_type: "textGeneration",
                  action_key: "home-culture-poster-brief",
                },
              ],
            },
          ],
        }),
      }),
      expect.objectContaining({
        kind: "recipes",
        payload: expect.objectContaining({
          id: "home-culture-poster-image",
          output_kind: "image",
          action_keys: ["home-culture-poster-image"],
          system_prompt: "生成海报",
          must_have_items: ["地域符号"],
          planning_prompt: "根据地域符号生成海报",
          result_summary: "一张家乡文化海报",
          requires_source_media: true,
        }),
      }),
    ]);
  });
});

describe("Canvas command approval image params", () => {
  it("updates image node data before running generate_image", () => {
    const approval = {
      id: "approval-a",
      key: "approval-a",
      messageId: "assistant-a",
      receivedAt: 1,
      commandCount: 1,
      plans: [],
      envelopes: [
        {
          schema_version: "canvas_chat_commands.v1" as const,
          commands: [
            { type: "run_node_action" as const, node_id: "image-a", action: "generate_image" },
          ],
        },
      ],
    };

    const amended = amendCanvasApprovalWithImageParamsForTest(approval as never, {
      nodeId: "image-a",
      model: "newapi_gpt_image2",
      aspectRatio: "9:16",
      size: "2K",
      quality: "high",
      count: 2,
    });

    expect(amended.envelopes[0].commands).toEqual([
      {
        type: "update_node_data",
        node_id: "image-a",
        data: {
          model: "newapi_gpt_image2",
          aspectRatio: "9:16",
          size: "2K",
          quality: "high",
          count: 2,
        },
      },
      { type: "run_node_action", node_id: "image-a", action: "generate_image" },
    ]);
  });
});

describe("Canvas command approval video params", () => {
  it("updates video node data before running generate_video", () => {
    const approval = {
      id: "approval-a",
      key: "approval-a",
      messageId: "assistant-a",
      receivedAt: 1,
      commandCount: 1,
      plans: [],
      envelopes: [
        {
          schema_version: "canvas_chat_commands.v1" as const,
          commands: [
            { type: "run_node_action" as const, node_id: "video-a", action: "generate_video" },
          ],
        },
      ],
    };

    const amended = amendCanvasApprovalWithVideoParamsForTest(approval as never, {
      nodeId: "video-a",
      model: "newapi_seedance-2.0",
      aspectRatio: "9:16",
      quality: "1080P",
      durationSec: 10,
      generateAudio: true,
      count: 2,
    });

    expect(amended.envelopes[0].commands).toEqual([
      {
        type: "update_node_data",
        node_id: "video-a",
        data: {
          model: "newapi_seedance-2.0",
          aspectRatio: "9:16",
          quality: "1080P",
          durationSec: 10,
          generateAudio: true,
          count: 2,
        },
      },
      { type: "run_node_action", node_id: "video-a", action: "generate_video" },
    ]);
  });
});

describe("Skill Studio flow ordering", () => {
  it("places submitted clarification summaries at their saved text anchor", () => {
    const items = buildAssistantInteractionFlowItemsForTest(
      "你要做的是 Skill 配置草稿。我先用几道关键选择题帮你定方向。\n\n方向已明确，正在生成草稿。",
      [
        {
          type: "skill_studio.draft",
          anchor_text_prefix: "你要做的是 Skill 配置草稿。我先用几道关键选择题帮你定方向。\n\n方向已明确，正在生成草稿。",
          skill_studio_session_id: "skill_studio_01",
          skill: { id: "home-culture-poster" },
          recipes: [],
        },
      ],
      [
        {
          type: "assistant.clarification.request",
          submitted: true,
          bridge_key: "clarification-key",
          anchor_text_prefix: "你要做的是 Skill 配置草稿。我先用几道关键选择题帮你定方向。\n\n",
          questions: [],
          answers: {},
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "clarification", "text", "skill_studio"]);
    expect(items[0]).toMatchObject({
      kind: "text",
      text: "你要做的是 Skill 配置草稿。我先用几道关键选择题帮你定方向。\n\n",
    });
  });

  it("keeps interaction cards before text when they arrived before streaming text", () => {
    const items = buildAssistantInteractionFlowItemsForTest(
      "我会根据你的选择继续生成草稿。",
      [],
      [
        {
          type: "assistant.clarification.request",
          submitted: true,
          bridge_key: "clarification-key",
          questions: [],
          answers: {},
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["clarification", "text"]);
    expect(items[1]).toMatchObject({ kind: "text", text: "我会根据你的选择继续生成草稿。" });
  });

  it("keeps a draft card at its arrival point when later text is appended after cancellation", () => {
    const firstText = "好的，明确了：我来生成完整的 Skill 配置草稿。";
    const continuation = "\n\n好的，已取消本次 Skill 草稿的保存，不会写入任何配置。";
    const items = buildAssistantInteractionFlowItemsForTest(
      `${firstText}${continuation}`,
      [
        {
          type: "skill_studio.draft",
          cancelled: true,
          received_at: 100,
          anchor_text_prefix: `${firstText}（正在提交草稿卡片）`,
          skill_studio_session_id: "skill_studio_01",
          skill: { id: "poster-skill" },
          recipes: [],
        },
      ],
      [],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "skill_studio", "text"]);
    expect(items[0]).toMatchObject({ kind: "text", text: firstText });
    expect(items[2]).toMatchObject({ kind: "text", text: continuation });
  });

  it("renders anchored cards at the text position where the event arrived", () => {
    const items = buildSkillStudioFlowItemsForTest(
      "先说明。\n后续文字。",
      [
        {
          type: "skill_studio.draft",
          anchor_text_prefix: "先说明。\n",
          skill_studio_session_id: "skill_studio_01",
          skill: { id: "poster-skill" },
          recipes: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "event", "text"]);
    expect(items[0]).toMatchObject({ kind: "text", text: "先说明。\n" });
    expect(items[2]).toMatchObject({ kind: "text", text: "后续文字。" });
  });

  it("keeps stale-anchor cards after continuation text when streaming restarts after a tool result", () => {
    const items = buildSkillStudioFlowItemsForTest(
      "已保存这个 Skill，接下来可以继续扩展。",
      [
        {
          type: "skill_studio.draft",
          anchor_text_prefix: "Here's the complete Skill and Recipe draft:",
          skill_studio_session_id: "skill_studio_01",
          skill: { id: "poster-skill" },
          recipes: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "event"]);
    expect(items[0]).toMatchObject({ kind: "text", text: "已保存这个 Skill，接下来可以继续扩展。" });
  });

  it("keeps submitted question cards after assistant narration when their saved anchor is stale", () => {
    const items = buildSkillStudioFlowItemsForTest(
      [
        "你要做一个「家乡文化海报」工作流 Skill——我先按 Skill Studio 的方式问几个关键选择，再据此起草完整 Skill/Recipe。",
        "这是 Skill Studio 配置，不是画布写入。先收几个方向信息，再生成完整 Skill/Recipe 草稿。",
        "已根据你的选择整理完整 Skill 草稿，正在提交可视化卡片供你确认与微调。",
      ].join("\n\n"),
      [
        {
          type: "skill_studio.questions",
          submitted: true,
          anchor_text_prefix: "我先进入 Skill Studio。",
          skill_studio_session_id: "skill_studio_01",
          selections: { audience: "local" },
          questions: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "event"]);
    expect(items[0]).toMatchObject({
      kind: "text",
      text: expect.stringContaining("你要做一个「家乡文化海报」工作流 Skill"),
    });
  });

  it("keeps submitted unanchored question cards after assistant text", () => {
    const items = buildSkillStudioFlowItemsForTest(
      "我会根据你的选择生成草稿。",
      [
        {
          type: "skill_studio.questions",
          submitted: true,
          skill_studio_session_id: "skill_studio_01",
          selections: { audience: "young" },
          questions: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "event"]);
  });

  it("keeps cancelled draft cards after text when no anchor is available", () => {
    const items = buildSkillStudioFlowItemsForTest(
      "已取消保存，我会继续按当前上下文回复。",
      [
        {
          type: "skill_studio.draft",
          cancelled: true,
          skill_studio_session_id: "skill_studio_01",
          skill: { id: "poster-skill" },
          recipes: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "event"]);
    expect(items[0]).toMatchObject({ kind: "text", text: "已取消保存，我会继续按当前上下文回复。" });
  });

  it("keeps cancelled draft cards at the saved anchor before continuation text", () => {
    const items = buildSkillStudioFlowItemsForTest(
      "已生成 Skill 草稿，正在提交卡片。\n已取消保存，我会继续按当前上下文回复。",
      [
        {
          type: "skill_studio.draft",
          cancelled: true,
          anchor_text_prefix: "已生成 Skill 草稿，正在提交卡片。\n",
          skill_studio_session_id: "skill_studio_01",
          skill: { id: "poster-skill" },
          recipes: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "event", "text"]);
    expect(items[0]).toMatchObject({ kind: "text", text: "已生成 Skill 草稿，正在提交卡片。\n" });
    expect(items[2]).toMatchObject({ kind: "text", text: "已取消保存，我会继续按当前上下文回复。" });
  });
});

describe("repeated canvas status collapsing", () => {
  it("collapses consecutive identical context flow items without crossing text", () => {
    const items = collapseRepeatedCanvasStatusFlowItemsForTest([
      {
        kind: "context",
        key: "context:1",
        activity: { key: "1", turnId: null, bridgeKey: null, status: "done", labels: ["节点详情"], errors: [] },
      },
      {
        kind: "context",
        key: "context:2",
        activity: { key: "2", turnId: null, bridgeKey: null, status: "done", labels: ["节点详情"], errors: [] },
      },
      { kind: "text", key: "text:1", text: "继续分析。" },
      {
        kind: "context",
        key: "context:3",
        activity: { key: "3", turnId: null, bridgeKey: null, status: "done", labels: ["节点详情"], errors: [] },
      },
      {
        kind: "context",
        key: "context:4",
        activity: { key: "4", turnId: null, bridgeKey: null, status: "done", labels: ["画布 Ontology"], errors: [] },
      },
    ]);

    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({
      kind: "context",
      activity: { labels: ["节点详情"], repeatCount: 2 },
    });
    expect(items[1]).toMatchObject({ kind: "text" });
    expect(items[2]).toMatchObject({
      kind: "context",
      activity: { labels: ["节点详情"] },
    });
    expect(items[3]).toMatchObject({
      kind: "context",
      activity: { labels: ["画布 Ontology"] },
    });
  });

  it("collapses consecutive identical canvas context ordered parts for history and streaming", () => {
    const parts = collapseRepeatedCanvasStatusPartsForTest([
      {
        id: "context-1",
        type: "canvas_context",
        event: { key: "1", turnId: null, bridgeKey: null, status: "done", labels: ["节点详情"], errors: [] },
      },
      {
        id: "context-2",
        type: "canvas_context",
        event: { key: "2", turnId: null, bridgeKey: null, status: "done", labels: ["节点详情"], errors: [] },
      },
      { id: "text-1", type: "text", text: "Let me continue." },
      {
        id: "context-3",
        type: "canvas_context",
        event: { key: "3", turnId: null, bridgeKey: null, status: "done", labels: ["节点详情"], errors: [] },
      },
    ]);

    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({
      type: "canvas_context",
      event: { labels: ["节点详情"], repeatCount: 2 },
    });
    expect(parts[1]).toMatchObject({ type: "text" });
    expect(parts[2]).toMatchObject({
      type: "canvas_context",
      event: { labels: ["节点详情"] },
    });
  });
});

describe("Freezone chat scope", () => {
  it("keeps different Freezone canvases in separate local session buckets", () => {
    const canvasA = scopeForProjectForTest("project-a", "freezone", "canvas-a");
    const canvasB = scopeForProjectForTest("project-a", "freezone", "canvas-b");

    expect(canvasA).toMatchObject({
      kind: "project",
      id: "project-a",
      surface: "freezone",
      canvasId: "canvas-a",
    });
    expect(scopeSessionKeyForTest(canvasA)).toBe(
      "supertale:project:project-a:freezone:canvas-a:agent:main",
    );
    expect(scopeSessionKeyForTest(canvasB)).toBe(
      "supertale:project:project-a:freezone:canvas-b:agent:main",
    );
  });

  it("keeps different Freezone agents on the same canvas in separate local session buckets", () => {
    const agentA = scopeForProjectForTest("project-a", "freezone", "canvas-a", "main");
    const agentB = scopeForProjectForTest("project-a", "freezone", "canvas-a", "agent-2");

    expect(agentA).toMatchObject({
      kind: "project",
      id: "project-a",
      surface: "freezone",
      canvasId: "canvas-a",
      agentId: "main",
    });
    expect(scopeSessionKeyForTest(agentA)).toBe(
      "supertale:project:project-a:freezone:canvas-a:agent:main",
    );
    expect(scopeSessionKeyForTest(agentB)).toBe(
      "supertale:project:project-a:freezone:canvas-a:agent:agent-2",
    );
  });

  it("does not let agent ids affect director chat scopes", () => {
    const director = scopeForProjectForTest("project-a", "director", null, "agent-2");

    expect(director).toEqual({
      kind: "project",
      id: "project-a",
      surface: "director",
      canvasId: null,
    });
    expect(scopeSessionKeyForTest(director)).toBe("supertale:project:project-a:director");
  });
});

describe("useSuperChat websocket lifecycle", () => {
  const OriginalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "WebSocket", {
      value: OriginalWebSocket,
      writable: true,
      configurable: true,
    });
  });

  it("does not open a websocket while the panel connection is disabled", () => {
    vi.useFakeTimers();
    const sockets: unknown[] = [];
    class TestWebSocket {
      static OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor() {
        sockets.push(this);
      }

      send() {}
      close() {}
    }
    Object.defineProperty(globalThis, "WebSocket", {
      value: TestWebSocket,
      writable: true,
      configurable: true,
    });

    renderHook(() =>
      useSuperChat({
        project: "project-a",
        displayName: "Tester",
        surface: "freezone",
        freezoneCanvasId: "canvas-a",
        freezoneAgentId: "agent-2",
        connectionEnabled: false,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(sockets).toHaveLength(0);
  });

  it("sends original user text separately from augmented transport text", async () => {
    const sentFrames: string[] = [];
    class TestWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor() {
        sockets.push(this);
      }

      send(frame: string) {
        sentFrames.push(frame);
      }

      close() {}
    }
    const sockets: TestWebSocket[] = [];
    Object.defineProperty(globalThis, "WebSocket", {
      value: TestWebSocket,
      writable: true,
      configurable: true,
    });

    const hook = renderHook(() =>
      useSuperChat({
        project: "project-a",
        displayName: "Tester",
        surface: "freezone",
        freezoneCanvasId: "canvas-a",
      }),
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    await act(async () => {
      sockets[0]?.onopen?.();
      sockets[0]?.onmessage?.({
        data: JSON.stringify({
          type: "scope.changed",
          scope: {
            kind: "project",
            id: "project-a",
            surface: "freezone",
            canvasId: "canvas-a",
          },
          history: [],
        }),
      } as MessageEvent);
    });
    await waitFor(() => expect(hook.result.current.connected).toBe(true));

    act(() => {
      hook.result.current.send(
        "查看下当前节点详情然后返回ok",
        [],
        "查看下当前节点详情然后返回ok\n\nnode_type: skillNode\navailable_actions: run_skill",
      );
    });

    const chatFrame = sentFrames
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .find((frame) => frame.type === "chat.message");

    expect(chatFrame).toEqual(expect.objectContaining({
      text: expect.stringContaining("node_type: skillNode"),
      user_text: "查看下当前节点详情然后返回ok",
    }));
  });

  it("persists merged assistant parts after the final assistant message arrives", async () => {
    apiPostMock.mockClear();
    class TestWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor() {
        sockets.push(this);
      }

      send() {}
      close() {}
    }
    const sockets: TestWebSocket[] = [];
    Object.defineProperty(globalThis, "WebSocket", {
      value: TestWebSocket,
      writable: true,
      configurable: true,
    });

    const hook = renderHook(() =>
      useSuperChat({
        project: "project-a",
        displayName: "Tester",
        surface: "freezone",
        freezoneCanvasId: "canvas-a",
        freezoneAgentId: "agent-2",
      }),
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    await waitFor(() => expect(socket.onmessage).toBeTypeOf("function"));
    await act(async () => {
      socket.onopen?.();
    });
    const scope = {
      kind: "project",
      id: "project-a",
      surface: "freezone",
      canvasId: "canvas-a",
      agentId: "agent-2",
    };

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: "assistant.clarification.event",
          scope,
          turn_id: "turn-1",
          bridge_key: "clarify-key-1",
          event: {
            type: "assistant.clarification.request",
            bridge_key: "clarify-key-1",
            clarification_id: "skill-setup",
            questions: [],
          },
        }),
      } as MessageEvent);
    });

    await waitFor(() => {
      expect(hook.result.current.messages.some((item) =>
        item.parts?.some((part) => part.type === "clarification"),
      )).toBe(true);
    });

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith("api/v1/chat/ui-events", expect.objectContaining({
        json: expect.objectContaining({
          turn_id: "turn-1",
          event: expect.objectContaining({
            type: "assistant.message_parts",
            parts: expect.arrayContaining([
              expect.objectContaining({ type: "clarification" }),
            ]),
          }),
        }),
      })),
    );
    apiPostMock.mockClear();

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: "assistant.message",
          scope,
          turn_id: "turn-1",
          message: {
            id: 9,
            role: "assistant",
            content: "草稿已生成。",
            turn_id: "turn-1",
            created_at: "2026-07-13T08:00:00+00:00",
            parts: [
              {
                id: "skill_studio.draft:draft-key-1",
                type: "skill_studio",
                event: {
                  type: "skill_studio.draft",
                  bridge_key: "draft-key-1",
                  skill_studio_session_id: "studio-1",
                  draft: { skill: { id: "hometown-skill" }, recipes: [] },
                },
              },
            ],
          },
        }),
      } as MessageEvent);
    });

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith("api/v1/chat/ui-events", expect.objectContaining({
        json: expect.objectContaining({
          turn_id: "turn-1",
          event: expect.objectContaining({
            type: "assistant.message_parts",
            parts: expect.arrayContaining([
              expect.objectContaining({ type: "clarification" }),
              expect.objectContaining({ type: "skill_studio" }),
              expect.objectContaining({ type: "text", text: "草稿已生成。" }),
            ]),
          }),
        }),
      })),
    );
  });

  it("persists updated draft part state after confirming a Skill Studio draft", async () => {
    apiPostMock.mockClear();
    class TestWebSocket {
      static OPEN = 1;
      readyState = 1;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor() {
        sockets.push(this);
      }

      send(value: string) {
        this.sent.push(value);
      }
      close() {}
    }
    const sockets: TestWebSocket[] = [];
    Object.defineProperty(globalThis, "WebSocket", {
      value: TestWebSocket,
      writable: true,
      configurable: true,
    });

    const hook = renderHook(() =>
      useSuperChat({
        project: "project-a",
        displayName: "Tester",
        surface: "freezone",
        freezoneCanvasId: "canvas-a",
        freezoneAgentId: "agent-2",
      }),
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    await waitFor(() => expect(socket.onmessage).toBeTypeOf("function"));
    await act(async () => {
      socket.onopen?.();
    });
    const scope = {
      kind: "project",
      id: "project-a",
      surface: "freezone",
      canvasId: "canvas-a",
      agentId: "agent-2",
    };

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: "assistant.message",
          scope,
          turn_id: "turn-1",
          message: {
            id: 10,
            role: "assistant",
            content: "草稿已生成。",
            turn_id: "turn-1",
            created_at: "2026-07-13T08:00:00+00:00",
            parts: [
              {
                id: "skill_studio.draft:draft-key-1",
                type: "skill_studio",
                event: {
                  type: "skill_studio.draft",
                  bridge_key: "draft-key-1",
                  skill_studio_session_id: "studio-1",
                  mode: "create",
                  draft: {
                    summary: "草稿",
                    skill: { id: "saved-skill" },
                    recipes: [{ id: "saved-recipe" }],
                    warnings: [],
                  },
                },
              },
            ],
          },
        }),
      } as MessageEvent);
    });

    await waitFor(() => {
      expect(hook.result.current.messages.some((message) =>
        message.parts?.some((part) => part.type === "skill_studio"),
      )).toBe(true);
    });
    apiPostMock.mockClear();

    act(() => {
      const draftPart = hook.result.current.messages
        .flatMap((message) => message.parts ?? [])
        .find((part) => part.type === "skill_studio");
      const draft = draftPart?.type === "skill_studio"
        ? draftPart.event as { type: "skill_studio.draft" }
        : null;
      hook.result.current.updateUiEvent(
        "turn-1",
        (candidate) =>
          Boolean(
            candidate
            && typeof candidate === "object"
            && (candidate as Record<string, unknown>).type === "skill_studio.draft"
            && (candidate as Record<string, unknown>).bridge_key === "draft-key-1",
          ),
        (candidate) => ({
          ...(candidate as Record<string, unknown>),
          submitted: true,
          saved_to_catalog: true,
          saved_skill_ids: ["saved-skill"],
          saved_recipe_ids: ["saved-recipe"],
          action: "confirm_add",
          draft: {
            summary: "草稿",
            skill: { id: "saved-skill" },
            recipes: [{ id: "saved-recipe" }],
            warnings: [],
          },
        }),
      );
      expect(draft?.type).toBe("skill_studio.draft");
    });

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith("api/v1/chat/ui-events", expect.objectContaining({
        json: expect.objectContaining({
          turn_id: "turn-1",
          event: expect.objectContaining({
            type: "assistant.message_parts",
            parts: expect.arrayContaining([
              expect.objectContaining({
                type: "skill_studio",
                event: expect.objectContaining({
                  type: "skill_studio.draft",
                  submitted: true,
                  saved_to_catalog: true,
                  saved_skill_ids: ["saved-skill"],
                  saved_recipe_ids: ["saved-recipe"],
                }),
              }),
              expect.objectContaining({ type: "text", text: "草稿已生成。" }),
            ]),
          }),
        }),
      })),
    );
  });
});

describe("canvas command bridge events", () => {
  it("passes the current assistant text as the canvas command anchor", () => {
    const received: unknown[] = [];
    const handleEvent = (event: Event) => {
      received.push((event as CustomEvent).detail);
    };
    window.addEventListener(SUPERCHAT_CANVAS_COMMAND_EVENT, handleEvent);

    try {
      dispatchCanvasCommandFrameForTest(
        {
          type: "canvas.command",
          turn_id: "turn-a",
          bridge_key: "bridge-a",
          canvas_id: "canvas-a",
          envelope: { schema_version: "canvas_chat_commands.v1", commands: [] },
        },
        "正在更新视频节点的内容...\n",
      );
    } finally {
      window.removeEventListener(SUPERCHAT_CANVAS_COMMAND_EVENT, handleEvent);
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      anchorTextPrefix: "正在更新视频节点的内容...\n",
      frame: {
        type: "canvas.command",
        bridge_key: "bridge-a",
      },
    });
  });
});

describe("tool status parts", () => {
  it("uses the ACP call id to update one tool lifecycle card", () => {
    const started = toolStatusPartForTest("agent.tool.started", {
      type: "agent.tool.started",
      turn_id: "turn-a",
      call_id: "call-1",
      name: "read_file",
      status: "pending",
    }, "turn-a");
    const completed = toolStatusPartForTest("agent.tool.updated", {
      type: "agent.tool.updated",
      turn_id: "turn-a",
      call_id: "call-1",
      name: "read_file",
      status: "completed",
    }, "turn-a");

    expect(started.id).toBe("tool_status:turn-a:call-1");
    expect(completed.id).toBe(started.id);

    const messages = upsertRuntimePartInMessagesForTest([], "turn-a", started);
    const updated = upsertRuntimePartInMessagesForTest(messages, "turn-a", completed);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.parts).toHaveLength(1);
    expect(updated[0]?.parts?.[0]).toEqual(completed);
  });

  it("keeps repeated calls to the same tool separate", () => {
    const first = toolStatusPartForTest("agent.tool.started", {
      type: "agent.tool.started",
      turn_id: "turn-a",
      call_id: "call-1",
      name: "read_file",
    }, "turn-a");
    const second = toolStatusPartForTest("agent.tool.started", {
      type: "agent.tool.started",
      turn_id: "turn-a",
      call_id: "call-2",
      name: "read_file",
    }, "turn-a");

    const messages = upsertRuntimePartInMessagesForTest(
      upsertRuntimePartInMessagesForTest([], "turn-a", first),
      "turn-a",
      second,
    );
    expect(messages[0]?.parts?.map((part) => part.id)).toEqual([
      "tool_status:turn-a:call-1",
      "tool_status:turn-a:call-2",
    ]);
  });

  it("does not render hidden canvas write tool calls as assistant status parts", () => {
    expect(shouldRenderToolStatusPart({
      type: "tool.call",
      turn_id: "turn-a",
      name: "freezone_create_node",
      arguments: { node_type: "imageGenNode" },
    })).toBe(false);
  });

  it("does not render direct hidden canvas write tool results as assistant status parts", () => {
    expect(shouldRenderToolStatusPart({
      type: "tool.result",
      turn_id: "turn-a",
      name: "freezone_create_node",
      result: "已创建节点",
    })).toBe(false);
  });

  it("does not render canvas command result payloads as assistant status parts", () => {
    expect(shouldRenderToolStatusPart({
      type: "tool.result",
      turn_id: "turn-a",
      name: "freezone_emit_canvas_command",
      result: JSON.stringify({
        envelope: { schema_version: "canvas_chat_commands.v1", commands: [] },
      }),
    })).toBe(false);
  });
});

describe("agent permission options", () => {
  const approval = {
    id: "permission-a",
    kind: "agent" as const,
    title: "运行命令",
    options: [
      { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
      { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
      { optionId: "allow_always", kind: "allow_always", name: "Allow always" },
      { optionId: "deny", kind: "reject_once", name: "Deny" },
    ],
  };

  it("does not confuse session access with permanent access", () => {
    expect(approvalOptionIdForTest(approval, "allow-always")).toBe("allow_always");
    expect(approvalOptionIdForTest(approval, { optionId: "allow_session" })).toBe("allow_session");
    expect(approvalOptionIdForTest(approval, { optionId: "unknown" })).toBe("");
  });
});

describe("canvas context bridge results", () => {
  it("preserves canvas_context_status in the websocket frame", () => {
    const frame = canvasContextToolResultFrameForTest({
      type: "canvas.context.result",
      turn_id: "turn-a",
      bridge_key: "bridge-a",
      project_id: "project-a",
      canvas_id: "canvas-a",
      tool_call_status: "completed",
      canvas_context_status: "resolved",
      ok: true,
      responses: [],
      errors: [],
      message: "ok",
    });

    expect(frame).toMatchObject({
      type: "canvas.context.result",
      canvas_context_status: "resolved",
    });
  });
});

describe("sanitizeMessagesForCache", () => {
  it("strips attachment inline content but keeps metadata and raw", () => {
    const original: ChatMessage = {
      id: "m1",
      role: "user",
      text: "见图",
      timestamp: 1,
      raw: { keep: "me" },
      attachments: [
        {
          fileName: "a.png",
          mimeType: "image/png",
          fileSize: 1234,
          url: "https://example/a.png",
          path: "/a.png",
          content: "data:image/png;base64,AAAA",
        },
      ],
    };

    const [sanitized] = sanitizeMessagesForCache([original]);

    expect(sanitized.attachments?.[0].content).toBeUndefined();
    expect(sanitized.attachments?.[0].fileName).toBe("a.png");
    expect(sanitized.attachments?.[0].url).toBe("https://example/a.png");
    expect(sanitized.raw).toEqual({ keep: "me" });
    // The original message must not be mutated.
    expect(original.attachments?.[0].content).toBe("data:image/png;base64,AAAA");
  });

  it("leaves messages without attachments or raw untouched", () => {
    const original: ChatMessage = { id: "m1", role: "user", text: "hi", timestamp: 1 };
    expect(sanitizeMessagesForCache([original])[0]).toBe(original);
  });

  it("does not persist transient agent runtime details in the recovery cache", () => {
    const original: ChatMessage = {
      id: "assistant-turn-a",
      role: "assistant",
      text: "完成",
      timestamp: 1,
      parts: [
        { id: "plan", type: "agent_plan", event: { entries: [] } },
        { id: "thought", type: "agent_thought", event: { text: "private reasoning" } },
        { id: "usage", type: "agent_usage", event: { usage: { used: 10 } } },
        {
          id: "tool",
          type: "tool_status",
          event: { raw: { output: { large: "payload" } } },
        },
      ],
    };

    const [sanitized] = sanitizeMessagesForCache([original]);

    expect(sanitized.parts?.map((part) => part.type)).toEqual(["agent_plan"]);
  });

  it("drops raw ACP tool payloads from the recovery cache", () => {
    const original: ChatMessage = {
      id: "agent-tool-call-1",
      role: "tool",
      text: "读取完成",
      timestamp: 1,
      raw: { output: { large: "payload" } },
    };

    const [sanitized] = sanitizeMessagesForCache([original]);

    expect(sanitized.raw).toBeUndefined();
    expect(sanitized.text).toBe("读取完成");
  });

  it("de-nests raw so it can't grow across load→save cycles", () => {
    // After one round-trip, normalizeMessage stores the prior normalized
    // message under raw — which itself carries a raw field. Caching must drop
    // that inner raw so depth never exceeds 1.
    const serverPayload = { content: "<ui-spec>{}</ui-spec>" };
    const roundTripped: ChatMessage = {
      id: "m1",
      role: "assistant",
      text: "hi",
      timestamp: 1,
      raw: { id: "m1", role: "assistant", text: "hi", raw: serverPayload },
    };

    const [sanitized] = sanitizeMessagesForCache([roundTripped]);
    const raw = sanitized.raw as Record<string, unknown>;

    expect("raw" in raw).toBe(false);
    expect(raw.text).toBe("hi");
    // Re-sanitizing stays flat (stable fixpoint, no unbounded growth).
    const reSanitized = sanitizeMessagesForCache([
      { ...sanitized, raw: { ...raw, raw: serverPayload } },
    ]);
    expect("raw" in (reSanitized[0].raw as Record<string, unknown>)).toBe(false);
  });
});

describe("pruneOldMessageCaches", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("removes expired, legacy, and malformed caches but keeps fresh ones", () => {
    const now = 10 * DAY_MS;
    localStorage.setItem(
      `${MESSAGE_CACHE_PREFIX}fresh`,
      JSON.stringify({ updatedAt: now - DAY_MS, messages: [] }),
    );
    localStorage.setItem(
      `${MESSAGE_CACHE_PREFIX}stale`,
      JSON.stringify({ updatedAt: now - 8 * DAY_MS, messages: [] }),
    );
    // Legacy bare-array format has no updatedAt → reclaimed.
    localStorage.setItem(`${MESSAGE_CACHE_PREFIX}legacy`, JSON.stringify([{ id: "x" }]));
    localStorage.setItem(`${MESSAGE_CACHE_PREFIX}broken`, "{not json");
    localStorage.setItem("unrelated:key", "keep-me");

    pruneOldMessageCaches(now);

    expect(localStorage.getItem(`${MESSAGE_CACHE_PREFIX}fresh`)).not.toBeNull();
    expect(localStorage.getItem(`${MESSAGE_CACHE_PREFIX}stale`)).toBeNull();
    expect(localStorage.getItem(`${MESSAGE_CACHE_PREFIX}legacy`)).toBeNull();
    expect(localStorage.getItem(`${MESSAGE_CACHE_PREFIX}broken`)).toBeNull();
    expect(localStorage.getItem("unrelated:key")).toBe("keep-me");
  });

  it("reclaims caches with a future timestamp (clock skew / corruption)", () => {
    const now = 10 * DAY_MS;
    localStorage.setItem(
      `${MESSAGE_CACHE_PREFIX}future`,
      JSON.stringify({ updatedAt: now + DAY_MS, messages: [] }),
    );
    pruneOldMessageCaches(now);
    expect(localStorage.getItem(`${MESSAGE_CACHE_PREFIX}future`)).toBeNull();
  });
});
