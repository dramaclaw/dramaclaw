import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFreezoneWorkflowRun,
  updateFreezoneWorkflowRun,
} from "@/api/canvas";
import { getProjectTaskLimits } from "@/api/tasks";
import { ApiError } from "@/api/client";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { canvasEventBus } from "@/features/canvas/application/canvasServices";
import { subscribeNodeAction } from "@/features/canvas/application/nodeActionResult";
import { buildCanvasOntologyContext } from "@/features/canvas/ontology/canvasOntology";
import {
  applyCanvasChatCommands,
  applyCanvasChatCommandsAsync,
  type CanvasCommandApprovalEventDetail,
  canvasCommandEnvelopeMatchesCanvas,
  CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
  emitCanvasCommandApproval,
  extractCanvasChatCommandEnvelopes,
  FREEZONE_CANVAS_COMMAND_APPROVAL_EVENT,
  partitionCanvasChatCommandEnvelopes,
  subscribeCanvasCommandApprovals,
} from "@/features/freezone/canvasChatCommands";
import {
  buildCanvasChatCommandContext,
  buildCanvasContextRequestResponses,
  buildCanvasContextRequestResponse,
  buildCanvasNodeReferenceAttachment,
  buildCanvasNodeReferenceContext,
  canvasNodeReferenceAttachmentNodes,
  extractCanvasContextRequestEnvelopes,
  mergeCanvasNodeReferenceAttachments,
  pruneCanvasNodeReferenceAttachments,
  removeCanvasNodeFromReferenceAttachment,
  shouldIncludeCanvasSummary,
} from "@/features/freezone/chatNodeReferences";
import { buildCanvasNodeActionCatalog } from "@/features/freezone/canvasNodeActionCatalog";
import { openPresetProjectionInMyCanvas } from "@/features/freezone/openPresetProjection";
import { personalCanvasIdForUsername } from "@/features/freezone/projections";
import {
  canvasCommandApprovalKeyForTest,
  canvasCommandCandidateValues,
  canvasCommandFeedbackKeyForTest,
  resolveCanvasCommandApprovalMessageIdForTest,
  shouldShowComposerWaitingStatus,
  shouldShowComposerWaitingIndicator,
  shouldSubmitComposerEnter,
} from "@/features/superchat/superchat-panel";
import { useAuthStore } from "@/stores/auth-store";
import { useCanvasStore } from "@/stores/canvasStore";

const uploadFreezoneImage = vi.hoisted(() => vi.fn());
const captureVideoFrameBlob = vi.hoisted(() => vi.fn());

vi.mock("@/api/ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/ops")>();
  return {
    ...actual,
    uploadFreezoneImage,
    fetchFreezoneAudioReferences: vi.fn(async () => ({
      available: [
        {
          scope: "user_custom",
          voice_id: "voice-a",
          label: "温柔女声",
          language: "zh-CN",
          gender: "female",
        },
      ],
    })),
  };
});

vi.mock("@/features/canvas/application/videoFrameBlob", () => ({
  captureVideoFrameBlob,
}));

vi.mock("@/api/canvas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/canvas")>();
  return {
    ...actual,
    createFreezoneWorkflowRun: vi.fn(async () => ({ run_id: "run-test" })),
    updateFreezoneWorkflowRun: vi.fn(async () => ({ run_id: "run-test" })),
  };
});

vi.mock("@/api/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tasks")>();
  return {
    ...actual,
    getProjectTaskLimits: vi.fn(),
  };
});

vi.mock("@/features/freezone/openPresetProjection", () => ({
  openPresetProjectionInMyCanvas: vi.fn(async () => "user_canvas"),
}));

describe("canvas chat commands", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
    useAuthStore.setState({ username: null, role: null });
    vi.mocked(openPresetProjectionInMyCanvas).mockClear();
    uploadFreezoneImage.mockReset();
    uploadFreezoneImage.mockResolvedValue({ url: "/static/project/tail-frame.png" });
    captureVideoFrameBlob.mockReset();
    captureVideoFrameBlob.mockResolvedValue(new Blob(["tail"], { type: "image/png" }));
    vi.mocked(createFreezoneWorkflowRun).mockClear();
    vi.mocked(updateFreezoneWorkflowRun).mockClear();
    vi.mocked(getProjectTaskLimits).mockReset();
    vi.mocked(getProjectTaskLimits).mockResolvedValue({
      default: {
        limit: 12,
        active: 0,
        remaining: 12,
        user_limit: 3,
        user_active: 0,
        user_remaining: 3,
      },
      video: {
        limit: 4,
        active: 0,
        remaining: 4,
        user_limit: 3,
        user_active: 0,
        user_remaining: 3,
      },
      world: {
        limit: 2,
        active: 0,
        remaining: 2,
        user_limit: 1,
        user_active: 0,
        user_remaining: 1,
      },
      ffmpeg: {
        limit: 2,
        active: 0,
        remaining: 2,
        user_limit: 1,
        user_active: 0,
        user_remaining: 1,
      },
    });
  });

  it("dispatches approval events even when an in-memory subscriber handles them", () => {
    const domEvents: unknown[] = [];
    const handleDomEvent = (event: Event) => {
      domEvents.push((event as CustomEvent).detail);
    };
    window.addEventListener(
      FREEZONE_CANVAS_COMMAND_APPROVAL_EVENT,
      handleDomEvent,
    );
    const unsubscribe = subscribeCanvasCommandApprovals(() => true);

    try {
      const detail: CanvasCommandApprovalEventDetail = {
        canvasId: "canvas-a",
        turnId: "turn-a",
        bridgeKey: "bridge-a",
        envelopes: [
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action" as const,
                node_id: "image-a",
                action: "generate_image",
              },
            ],
          },
        ],
      };

      emitCanvasCommandApproval(detail);

      expect(domEvents).toEqual([detail]);
    } finally {
      unsubscribe();
      window.removeEventListener(
        FREEZONE_CANVAS_COMMAND_APPROVAL_EVENT,
        handleDomEvent,
      );
    }
  });

  it("anchors current-turn canvas approvals to the streaming assistant bubble before old assistant messages", () => {
    const messageId = resolveCanvasCommandApprovalMessageIdForTest({
      messages: [
        {
          id: "assistant-old",
          role: "assistant",
          text: "上一轮回复",
          timestamp: 1,
          turnId: "turn-old",
        },
      ] as any,
      turnId: "turn-new",
      latestAssistantMessageId: "assistant-old",
      receivedAt: 123,
    });

    expect(messageId).toBe("assistant-turn-new");
  });

  it("keeps reused canvas command bridge keys scoped by turn", () => {
    const envelopes = [
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "run_node_action" as const,
            node_id: "image-a",
            action: "generate_image",
          },
        ],
      },
    ];

    expect(
      canvasCommandApprovalKeyForTest("bridge-a", "turn-a", envelopes),
    ).toBe("bridge:bridge-a");
    expect(
      canvasCommandApprovalKeyForTest("bridge-a", "turn-b", envelopes),
    ).toBe("bridge:bridge-a");
    expect(canvasCommandFeedbackKeyForTest("bridge-a", "turn-a")).toBe(
      "bridge:bridge-a",
    );
    expect(canvasCommandFeedbackKeyForTest("bridge-a", "turn-b")).toBe(
      "bridge:bridge-a",
    );
  });

  it("does not submit the composer while an IME is composing text", () => {
    expect(
      shouldSubmitComposerEnter({
        key: "Enter",
        shiftKey: false,
        defaultPrevented: false,
        nativeEvent: { isComposing: true },
      }),
    ).toBe(false);
    expect(
      shouldSubmitComposerEnter({
        key: "Enter",
        shiftKey: false,
        defaultPrevented: false,
        nativeEvent: { keyCode: 229 },
      }),
    ).toBe(false);
    expect(
      shouldSubmitComposerEnter({
        key: "Enter",
        shiftKey: false,
        defaultPrevented: false,
        nativeEvent: {},
      }),
    ).toBe(true);
  });

  it("hides the bottom waiting indicator when the assistant bubble already shows thinking", () => {
    expect(
      shouldShowComposerWaitingIndicator({
        busy: true,
        hasAssistantText: false,
        streamText: "",
        pendingCanvasCommandApprovalCount: 0,
        hasPendingVisibleUserMessage: true,
        hasThinkingCanvasContextActivity: true,
      }),
    ).toBe(false);
    expect(
      shouldShowComposerWaitingIndicator({
        busy: true,
        hasAssistantText: false,
        streamText: "",
        pendingCanvasCommandApprovalCount: 0,
        hasPendingVisibleUserMessage: true,
        hasThinkingCanvasContextActivity: false,
      }),
    ).toBe(true);
  });

  it("keeps the composer waiting indicator visible while the assistant is replying", () => {
    expect(
      shouldShowComposerWaitingIndicator({
        busy: true,
        hasAssistantText: true,
        streamText: "正在处理",
        pendingCanvasCommandApprovalCount: 0,
        hasPendingVisibleUserMessage: true,
        hasThinkingCanvasContextActivity: false,
      }),
    ).toBe(true);
  });

  it("renders the composer waiting status in Freezone", () => {
    expect(shouldShowComposerWaitingStatus(true, "freezone")).toBe(true);
    expect(shouldShowComposerWaitingStatus(true, "default")).toBe(true);
    expect(shouldShowComposerWaitingStatus(false, "default")).toBe(false);
  });

  it("creates, chains, connects, and updates nodes from assistant command envelopes", () => {
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            client_id: "first",
            node_type: CANVAS_NODE_TYPES.textAnnotation,
            position: { x: 10, y: 20 },
            data: {
              title: "Start",
              semanticOutputRole: "input_text",
              preset_managed: true,
            },
          },
          {
            type: "add_next_node",
            source_node_id: "first",
            client_id: "second",
            node_type: CANVAS_NODE_TYPES.imageGen,
            data: { prompt: "A night harbor" },
          },
          {
            type: "update_node_data",
            node_id: "first",
            patch: {
              title: "Updated",
              label: "Updated Label",
              mainline_context: { should: "be stripped" },
            },
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();
    const first = state.nodes.find((node) => node.data.title === "Updated");
    const second = state.nodes.find(
      (node) => node.type === CANVAS_NODE_TYPES.imageGen,
    );

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(3);
    expect(result.createdNodeIds).toHaveLength(2);
    expect(state.selectedNodeId).toBe(first?.id);
    expect(state.pendingFocusNodeId).toBe(first?.id);
    expect(first?.selected).toBe(true);
    expect(second?.selected).toBeFalsy();
    expect(first?.position).toEqual({ x: 10, y: 20 });
    expect(first?.data.displayName).toBe("Updated Label");
    expect(first?.data).not.toHaveProperty("label");
    expect(first?.data).not.toHaveProperty("preset_managed");
    expect(first?.data).not.toHaveProperty("mainline_context");
    expect(second?.data).toMatchObject({ prompt: "A night harbor" });
    expect(state.edges).toEqual([
      expect.objectContaining({
        source: first?.id,
        target: second?.id,
      }),
    ]);
  });

  it("does not apply the same workflow instance twice", () => {
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            client_id: "brief",
            node_type: CANVAS_NODE_TYPES.textAnnotation,
            data: {
              displayName: "广告需求",
              workflowInstanceId: "workflow-draft-a",
              workflowPlanNodeId: "brief",
            },
          },
          {
            type: "create_node",
            client_id: "image",
            node_type: CANVAS_NODE_TYPES.imageGen,
            data: {
              displayName: "广告画面",
              workflowInstanceId: "workflow-draft-a",
              workflowPlanNodeId: "image",
            },
          },
          {
            type: "create_edge",
            source: "brief",
            target: "image",
            link_type: "prompt_for",
          },
        ],
      },
    ]);

    const first = applyCanvasChatCommands(envelopes);
    const second = applyCanvasChatCommands(envelopes);

    expect(first.errors).toEqual([]);
    expect(first.createdNodeIds).toHaveLength(3);
    expect(second.errors).toEqual([]);
    expect(second.createdNodeIds).toEqual([]);
    expect(useCanvasStore.getState().nodes).toHaveLength(3);
    expect(useCanvasStore.getState().edges).toHaveLength(1);
    expect(second.commandResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "success",
          output: {
            skipped: true,
            reason: "workflow_instance_already_applied",
          },
        }),
      ]),
    );
  });

  it("does not create internal or derived node types from assistant create commands", () => {
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            node_type: CANVAS_NODE_TYPES.storyboardSplit,
            data: { displayName: "不应该创建" },
          },
          {
            type: "create_node",
            node_type: CANVAS_NODE_TYPES.group,
            data: { displayName: "空组" },
          },
          {
            type: "create_node",
            node_type: CANVAS_NODE_TYPES.skill,
            data: { displayName: "允许的技能节点" },
          },
          {
            type: "create_node",
            node_type: CANVAS_NODE_TYPES.textAnnotation,
            data: { displayName: "允许的文本", content: "保留" },
          },
        ],
      },
    ]);

    expect(envelopes[0]?.commands).toHaveLength(2);

    const result = applyCanvasChatCommands(envelopes);
    const nodes = useCanvasStore.getState().nodes;

    expect(result.applied).toBe(2);
    expect(nodes).toHaveLength(2);
    expect(nodes.map((node) => node.type)).toEqual([
      CANVAS_NODE_TYPES.skill,
      CANVAS_NODE_TYPES.textAnnotation,
    ]);
  });

  it("rejects invented image model ids before creating image nodes", () => {
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            node_type: CANVAS_NODE_TYPES.imageGen,
            data: {
              displayName: "图片节点",
              prompt: "国风水墨海报",
              model: "flux-pro-1.1",
            },
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);

    expect(result.applied).toBe(0);
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
    expect(result.errors.join("\n")).toContain(
      "field model value \"flux-pro-1.1\" is not a valid option",
    );
    expect(result.errors.join("\n")).toContain(
      "freezone_get_node_create_schema",
    );
  });

  it("inherits mainline fields when add_next_node derives from a slot-targeted source", () => {
    const sourceId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        imageUrl: "/static/mainline/identity.png",
        slot_target: {
          kind: "identity",
          character: "林小满",
          identity_id: "业主时期",
        },
        mainline_context: [
          {
            kind: "identity",
            role: "character_identity",
            label: "林小满_业主时期",
          },
        ],
        committed_slot_url: "/static/mainline/identity.png",
      },
    );
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "add_next_node",
            source_node_id: sourceId,
            client_id: "brown_hair",
            node_type: CANVAS_NODE_TYPES.imageGen,
            data: { prompt: "hair color changed to brown" },
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const created = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === result.createdNodeIds[0]);

    expect(result.errors).toEqual([]);
    expect(created?.data).toMatchObject({
      prompt: "hair color changed to brown",
      user_spawned: true,
      slot_target: {
        kind: "identity",
        character: "林小满",
        identity_id: "业主时期",
      },
      mainline_context: [
        {
          kind: "identity",
          role: "character_identity",
          label: "林小满_业主时期",
        },
      ],
      committed_slot_url: "/static/mainline/identity.png",
    });
  });

  it("normalizes assistant field aliases before updating existing nodes", () => {
    const textId = useCanvasStore
      .getState()
      .addNode(
        CANVAS_NODE_TYPES.textAnnotation,
        { x: 0, y: 0 },
        { content: "old text" },
      );
    const audioId = useCanvasStore
      .getState()
      .addNode(
        CANVAS_NODE_TYPES.audio,
        { x: 420, y: 0 },
        { text: "old audio" },
      );
    const imageId = useCanvasStore
      .getState()
      .addNode(
        CANVAS_NODE_TYPES.imageGen,
        { x: 840, y: 0 },
        { prompt: "old image" },
      );
    const videoId = useCanvasStore
      .getState()
      .addNode(
        CANVAS_NODE_TYPES.video,
        { x: 1260, y: 0 },
        { prompt: "old video" },
      );
    const composeId = useCanvasStore
      .getState()
      .addNode(
        CANVAS_NODE_TYPES.videoCompose,
        { x: 1680, y: 0 },
        { title: "old compose" },
      );

    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "update_node_data",
            node_id: textId,
            data: { prompt: "new text", label: "Text label" },
          },
          {
            type: "update_node_data",
            node_id: audioId,
            data: { prompt: "new audio", model: "suno_music" },
          },
          {
            type: "update_node_data",
            node_id: imageId,
            data: { content: "new image prompt" },
          },
          {
            type: "update_node_data",
            node_id: videoId,
            data: { video_prompt: "new video prompt" },
          },
          {
            type: "update_node_data",
            node_id: composeId,
            data: {
              prompt: "ignored compose prompt",
              title: "new compose title",
            },
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();
    const text = state.nodes.find((node) => node.id === textId);
    const audio = state.nodes.find((node) => node.id === audioId);
    const image = state.nodes.find((node) => node.id === imageId);
    const video = state.nodes.find((node) => node.id === videoId);
    const compose = state.nodes.find((node) => node.id === composeId);

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(5);
    expect(text?.data).toMatchObject({
      content: "new text",
      displayName: "Text label",
    });
    expect(text?.data).not.toHaveProperty("prompt");
    expect(audio?.data).toMatchObject({ text: "new audio" });
    expect(audio?.data).not.toHaveProperty("prompt");
    expect(image?.data).toMatchObject({ prompt: "new image prompt" });
    expect(image?.data).not.toHaveProperty("content");
    expect(video?.data).toMatchObject({ prompt: "new video prompt" });
    expect(video?.data).not.toHaveProperty("video_prompt");
    expect(compose?.data).toMatchObject({ title: "new compose title" });
    expect(compose?.data).not.toHaveProperty("prompt");
  });

  it("defaults assistant-created speech nodes to custom voice mode without auto selection", () => {
    const sourceId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      { content: "旁白脚本" },
    );
    const existingAudioId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 0, y: 320 },
      { text: "旧旁白", speechMode: "clone", voiceRef: { scope: "project_narrator" } },
    );

    const result = applyCanvasChatCommands([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            client_id: "preset-audio",
            node_type: CANVAS_NODE_TYPES.audio,
            data: { text: "系统旁白" },
          },
          {
            type: "add_next_node",
            source_node_id: sourceId,
            client_id: "clone-audio",
            node_type: CANVAS_NODE_TYPES.audio,
            data: {
              text: "指定声线旁白",
              speechMode: "clone",
              voiceRef: { scope: "project_narrator" },
            },
          },
          {
            type: "update_node_data",
            node_id: existingAudioId,
            data: { text: "更新后的旁白" },
          },
        ],
      },
    ]);

    const state = useCanvasStore.getState();
    const presetAudio = state.nodes.find((node) => node.id === result.createdNodeIds[0]);
    const cloneAudio = state.nodes.find((node) => node.id === result.createdNodeIds[1]);
    const existingAudio = state.nodes.find((node) => node.id === existingAudioId);

    expect(result.errors).toEqual([]);
    expect(presetAudio?.data).toMatchObject({ speechMode: "clone" });
    expect(presetAudio?.data).not.toHaveProperty("voiceRef");
    expect(cloneAudio?.data).toMatchObject({
      speechMode: "clone",
      voiceRef: { scope: "project_narrator" },
    });
    expect(cloneAudio?.data).not.toHaveProperty("presetModel");
    expect(cloneAudio?.data).not.toHaveProperty("presetVoice");
    expect(existingAudio?.data).toMatchObject({
      text: "更新后的旁白",
      speechMode: "clone",
      voiceRef: { scope: "project_narrator" },
    });
    expect(existingAudio?.data).not.toHaveProperty("presetModel");
    expect(existingAudio?.data).not.toHaveProperty("presetVoice");
  });

  it("accepts frontend-approved speech voice metadata before generation", () => {
    const audioId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 0, y: 0 },
      { audioKind: "speech", text: "系统旁白", speechMode: "preset" },
    );

    const result = applyCanvasChatCommands([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "update_node_data",
            node_id: audioId,
            data: {
              speechMode: "preset",
              voicePolicyConfirmed: true,
              presetModel: "edge-tts",
              presetVoice: "Serena",
              voiceAvailable: true,
            },
          },
        ],
      },
    ]);

    expect(result.errors).toEqual([]);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === audioId)?.data).toMatchObject({
      speechMode: "preset",
      voicePolicyConfirmed: true,
      presetModel: "edge-tts",
      presetVoice: "Serena",
      voiceAvailable: true,
    });
  });

  it("ignores legacy role on add_next_node auto connections", () => {
    const sourceId = useCanvasStore
      .getState()
      .addNode(
        CANVAS_NODE_TYPES.textAnnotation,
        { x: 0, y: 0 },
        { content: "prompt" },
      );
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "add_next_node",
            source_node_id: sourceId,
            node_type: CANVAS_NODE_TYPES.imageGen,
            role: "prompt",
            data: { prompt: "A night harbor" },
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const edge = useCanvasStore.getState().edges[0];

    expect(result.errors).toEqual([]);
    expect(edge?.source).toBe(sourceId);
    expect(edge?.data ?? {}).not.toHaveProperty("role");
    expect(edge?.data ?? {}).not.toHaveProperty("edgeKind");
  });

  it("reports a single node command error when its action handler throws", async () => {
    const videoId = useCanvasStore
      .getState()
      .addNode(
        CANVAS_NODE_TYPES.video,
        { x: 0, y: 0 },
        { prompt: "A city walk" },
      );
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      () => {
        throw new Error("handler exploded");
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync([
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "run_node_action",
              node_id: videoId,
              action: "generate_video",
            },
          ],
        },
      ]);

      expect(result.commandResults).toEqual([
        expect.objectContaining({
          type: "run_node_action",
          status: "error",
          action: "generate_video",
          error: expect.stringContaining("handler exploded"),
        }),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("allows skill nodes to run their skill through run_node_action", async () => {
    const store = useCanvasStore.getState();
    const beatId = store.addNode(
      CANVAS_NODE_TYPES.beatContext,
      { x: -480, y: 0 },
      {
        displayName: "镜头上下文",
        beat_context: { episode: 1, beat: 2 },
      },
    );
    const backgroundId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: -240, y: 0 },
      {
        displayName: "背景",
        imageUrl: "/static/background.png",
      },
    );
    const skillId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.skill,
      { x: 0, y: 0 },
      {
        displayName: "根据当前背景生成草图",
        skill_id: "freezone.sketch_from_context",
      },
    );
    store.addEdgeWithData(
      beatId,
      skillId,
      { role: "beat_context" },
      { targetHandle: "beat_context" },
    );
    store.addEdgeWithData(
      backgroundId,
      skillId,
      { role: "background" },
      { targetHandle: "background" },
    );
    const attachment = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      useCanvasStore.getState().nodes.filter((node) => node.id === skillId),
      useCanvasStore.getState().edges,
      useCanvasStore.getState().nodes,
    );
    if (!attachment) throw new Error("test attachment was not created");
    const referenceContext = buildCanvasNodeReferenceContext([attachment]);

    expect(referenceContext).toContain('"action":"run_skill"');
    expect(referenceContext).toContain('"command_type":"run_node_action"');
    expect(referenceContext).toContain('"skill_id":"freezone.sketch_from_context"');

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        canvasEventBus.publish("freezone/node-action-accepted", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: "generate_image",
        });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
          output: { submitted: true },
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync([
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "run_node_action",
              node_id: skillId,
              action: "run_skill",
            },
          ],
        },
      ]);

      expect(result.errors).toEqual([]);
      expect(events).toEqual([{ nodeId: skillId, action: "run_skill" }]);
      expect(result.commandResults).toEqual([
        expect.objectContaining({
          type: "run_node_action",
          status: "success",
          action: "run_skill",
          output: expect.objectContaining({ submitted: true }),
        }),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("treats submitted image generation as handed off instead of missing image output", async () => {
    const imageNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "猫吃鱼",
      },
    );
    const events: Array<{
      nodeId: string;
      action: string;
      executionMode?: string;
    }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({
          nodeId: payload.nodeId,
          action: payload.action,
          executionMode: payload.executionMode,
        });
        if (!payload.requestId) return;
        canvasEventBus.publish("freezone/node-action-accepted", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
        });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
          output: { submitted: true, task_key: "task-image-1" },
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync([
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "run_node_action",
              node_id: imageNodeId,
              action: "generate_image",
            },
          ],
        },
      ]);

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        {
          nodeId: imageNodeId,
          action: "generate_image",
          executionMode: "single",
        },
      ]);
      expect(result.commandResults).toEqual([
        expect.objectContaining({
          type: "run_node_action",
          status: "success",
          action: "generate_image",
          output: expect.objectContaining({
            submitted: true,
            task_key: "task-image-1",
          }),
        }),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("waits for slow image task submission after the node accepts generation", async () => {
    const imageNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "猫吃鱼",
      },
    );
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        if (payload.nodeId !== imageNodeId || payload.action !== "generate_image")
          return;
        if (!payload.requestId) return;
        const requestId = payload.requestId;
        canvasEventBus.publish("freezone/node-action-accepted", {
          requestId,
          nodeId: payload.nodeId,
          action: "generate_image",
        });
        setTimeout(() => {
          useCanvasStore.getState().updateNodeData(imageNodeId, {
            generationTaskKey: "task-image-slow-submit",
            generationTaskJobId: "job-image-slow-submit",
          });
          canvasEventBus.publish("freezone/node-action-result", {
            requestId,
            nodeId: payload.nodeId,
            action: "generate_image",
            status: "success",
            output: {
              submitted: true,
              task_key: "task-image-slow-submit",
              job_id: "job-image-slow-submit",
            },
          });
        }, 3100);
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        [
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: imageNodeId,
                action: "generate_image",
              },
            ],
          },
        ],
        { actionTimeoutMs: 5000 },
      );

      expect(result.errors).toEqual([]);
      expect(result.commandResults).toEqual([
        expect.objectContaining({
          type: "run_node_action",
          status: "success",
          action: "generate_image",
          output: expect.objectContaining({
            submitted: true,
            task_key: "task-image-slow-submit",
          }),
        }),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("treats accepted single video generation with a task handle as handed off", async () => {
    const videoNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.video,
      { x: 0, y: 0 },
      {
        prompt: "猫吃鱼",
      },
    );
    const events: Array<{
      nodeId: string;
      action: string;
      executionMode?: string;
    }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({
          nodeId: payload.nodeId,
          action: payload.action,
          executionMode: payload.executionMode,
        });
        if (!payload.requestId) return;
        useCanvasStore.getState().updateNodeData(videoNodeId, {
          generationTaskKey: "freezone_video:task-video-1",
          generationTaskJobId: "job-video-1",
        });
        canvasEventBus.publish("freezone/node-action-accepted", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        [
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: videoNodeId,
                action: "generate_video",
              },
            ],
          },
        ],
        { actionTimeoutMs: 50 },
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        {
          nodeId: videoNodeId,
          action: "generate_video",
          executionMode: "single",
        },
      ]);
      expect(result.commandResults).toEqual([
        expect.objectContaining({
          type: "run_node_action",
          status: "success",
          action: "generate_video",
          output: expect.objectContaining({
            submitted: true,
          }),
        }),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("delivers pending image generation when the target node subscribes after dispatch", async () => {
    const imageNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "猫吃鱼",
      },
    );
    const events: Array<{ nodeId: string; action: string }> = [];
    let unsubscribe: (() => void) | null = null;

    const resultPromise = applyCanvasChatCommandsAsync(
      [
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "run_node_action",
              node_id: imageNodeId,
              action: "generate_image",
            },
          ],
        },
      ],
      { actionAcceptTimeoutMs: 500 },
    );

    await vi.waitFor(() => {
      expect(useCanvasStore.getState().pendingFocusNodeId).toBe(imageNodeId);
    });

    unsubscribe = subscribeNodeAction((payload) => {
      if (payload.nodeId !== imageNodeId || payload.action !== "generate_image")
        return;
      events.push({ nodeId: payload.nodeId, action: payload.action });
      if (!payload.requestId) return;
      canvasEventBus.publish("freezone/node-action-accepted", {
        requestId: payload.requestId,
        nodeId: payload.nodeId,
        action: payload.action,
      });
      canvasEventBus.publish("freezone/node-action-result", {
        requestId: payload.requestId,
        nodeId: payload.nodeId,
        action: payload.action,
        status: "success",
        output: { submitted: true, task_key: "task-image-delayed" },
      });
    });

    try {
      const result = await resultPromise;

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: imageNodeId, action: "generate_image" },
      ]);
      expect(result.commandResults).toEqual([
        expect.objectContaining({
          type: "run_node_action",
          status: "success",
          action: "generate_image",
          output: expect.objectContaining({
            submitted: true,
            task_key: "task-image-delayed",
          }),
        }),
      ]);
    } finally {
      unsubscribe?.();
    }
  });

  it("mounts an off-screen generation target when another node is already subscribed", async () => {
    const imageNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "离屏目标节点",
      },
    );
    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribeOtherNode = subscribeNodeAction(() => undefined);
    let unsubscribeTarget: (() => void) | null = null;

    const resultPromise = applyCanvasChatCommandsAsync(
      [
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "run_node_action",
              node_id: imageNodeId,
              action: "generate_image",
            },
          ],
        },
      ],
      { actionAcceptTimeoutMs: 1_000 },
    );

    await vi.waitFor(() => {
      expect(useCanvasStore.getState().pendingFocusNodeId).toBe(imageNodeId);
    });

    unsubscribeTarget = subscribeNodeAction((payload) => {
      if (payload.nodeId !== imageNodeId || payload.action !== "generate_image")
        return;
      events.push({ nodeId: payload.nodeId, action: payload.action });
      if (!payload.requestId) return;
      canvasEventBus.publish("freezone/node-action-accepted", {
        requestId: payload.requestId,
        nodeId: payload.nodeId,
        action: payload.action,
      });
      canvasEventBus.publish("freezone/node-action-result", {
        requestId: payload.requestId,
        nodeId: payload.nodeId,
        action: payload.action,
        status: "success",
        output: { submitted: true, task_key: "task-image-offscreen" },
      });
    });

    try {
      const result = await resultPromise;

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: imageNodeId, action: "generate_image" },
      ]);
      expect(result.commandResults).toEqual([
        expect.objectContaining({
          type: "run_node_action",
          status: "success",
          action: "generate_image",
          output: expect.objectContaining({
            submitted: true,
            task_key: "task-image-offscreen",
          }),
        }),
      ]);
    } finally {
      unsubscribeTarget?.();
      unsubscribeOtherNode();
    }
  });

  it("treats generation actions that open a user-required UI as handed off instead of missing output", async () => {
    const audioId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 0, y: 0 },
      {
        audioKind: "speech",
        text: "需要先选择音色",
        audioUrl: null,
      },
    );
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        if (!payload.requestId) return;
        canvasEventBus.publish("freezone/node-action-accepted", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
        });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
          output: {
            openedUiAction: true,
            requires_user_action: true,
            reason: "missing_voice",
            agent_instruction:
              "等待用户在已打开的音色选择器中上传或选择音色，不要继续查询 audio_voice_options。",
          },
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync([
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "run_node_action",
              node_id: audioId,
              action: "generate_audio",
            },
          ],
        },
      ]);

      expect(result.errors).toEqual([]);
      expect(result.openedUiActions).toBe(1);
      expect(
        useCanvasStore.getState().nodes.find((node) => node.id === audioId)
          ?.data,
      ).toMatchObject({
        isGenerating: false,
        generationStartedAt: null,
      });
      expect(result.commandResults).toEqual([
        expect.objectContaining({
          type: "run_node_action",
          status: "success",
          action: "generate_audio",
          output: expect.objectContaining({
            openedUiAction: true,
            requires_user_action: true,
            reason: "missing_voice",
          }),
        }),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("treats missing custom voice as an intentional workflow skip", async () => {
    const audioId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 0, y: 0 },
      { audioKind: "speech", speechMode: "clone", text: "旁白", audioUrl: null },
    );
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        if (!payload.requestId) return;
        canvasEventBus.publish("freezone/node-action-accepted", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
        });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
          output: { skipped: true, reason: "missing_custom_voice" },
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync([{
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [{
          type: "run_node_action",
          node_id: audioId,
          action: "generate_audio",
        }],
      }]);

      expect(result.errors).toEqual([]);
      expect(result.commandResults).toEqual([
        expect.objectContaining({
          type: "run_node_action",
          status: "success",
          output: { skipped: true, reason: "missing_custom_voice" },
        }),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("groups workflow nodes created in the same command envelope", () => {
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            client_id: "script",
            node_type: CANVAS_NODE_TYPES.textAnnotation,
            position: { x: 10, y: 20 },
            data: { content: "剧本内容", semanticOutputRole: "input_text" },
          },
          {
            type: "add_next_node",
            source_node_id: "script",
            client_id: "video",
            node_type: CANVAS_NODE_TYPES.video,
            data: { prompt: "生成视频" },
          },
          {
            type: "add_next_node",
            source_node_id: "script",
            client_id: "audio",
            node_type: CANVAS_NODE_TYPES.audio,
            data: { text: "旁白" },
          },
          {
            type: "group_nodes",
            node_ids: ["script", "video", "audio"],
            label: "剧本视频工作流",
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();
    const group = state.nodes.find(
      (node) => node.type === CANVAS_NODE_TYPES.group,
    );
    const members = state.nodes.filter((node) => node.parentId === group?.id);

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(4);
    expect(group?.data.displayName).toBe("剧本视频工作流");
    expect(members).toHaveLength(3);
    expect(members.map((node) => node.type).sort()).toEqual(
      [
        CANVAS_NODE_TYPES.audio,
        CANVAS_NODE_TYPES.textAnnotation,
        CANVAS_NODE_TYPES.video,
      ].sort(),
    );
  });

  it("auto-groups multiple downstream workflow nodes when the command omits group_nodes", () => {
    const sourceId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      {
        content: "剧本内容",
        semanticOutputRole: "input_text",
      },
    );
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "add_next_node",
            source_node_id: sourceId,
            client_id: "video",
            node_type: CANVAS_NODE_TYPES.video,
            data: { prompt: "生成视频" },
          },
          {
            type: "add_next_node",
            source_node_id: sourceId,
            client_id: "audio",
            node_type: CANVAS_NODE_TYPES.audio,
            data: { text: "旁白" },
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();
    const group = state.nodes.find(
      (node) => node.type === CANVAS_NODE_TYPES.group,
    );
    const members = state.nodes.filter((node) => node.parentId === group?.id);

    expect(result.errors).toEqual([]);
    expect(group?.data.displayName).toBe("工作流组");
    expect(members).toHaveLength(3);
    expect(
      result.commandResults.some((step) => step.type === "group_nodes"),
    ).toBe(true);
  });

  it("auto-groups workflow-like create batches when the command omits group_nodes", () => {
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            client_id: "brief",
            node_type: CANVAS_NODE_TYPES.textAnnotation,
            data: { content: "广告 Brief" },
          },
          {
            type: "create_node",
            client_id: "image",
            node_type: CANVAS_NODE_TYPES.imageGen,
            data: { prompt: "生成关键视觉" },
          },
          {
            type: "create_node",
            client_id: "video",
            node_type: CANVAS_NODE_TYPES.video,
            data: { prompt: "生成广告视频" },
          },
          {
            type: "create_node",
            client_id: "compose",
            node_type: CANVAS_NODE_TYPES.videoCompose,
            data: { prompt: "合成成片" },
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();
    const group = state.nodes.find((node) => node.type === CANVAS_NODE_TYPES.group);
    const members = state.nodes.filter((node) => node.parentId === group?.id);

    expect(result.errors).toEqual([]);
    expect(group?.data.displayName).toBe("工作流组");
    expect(members).toHaveLength(4);
    expect(result.commandResults.some((step) => step.type === "group_nodes")).toBe(true);
  });

  it("does not infer connections from grouped nodes", () => {
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            client_id: "script",
            node_type: CANVAS_NODE_TYPES.textAnnotation,
            position: { x: 0, y: 0 },
            data: { content: "剧情脚本", semanticOutputRole: "input_text" },
          },
          {
            type: "create_node",
            client_id: "image",
            node_type: CANVAS_NODE_TYPES.imageGen,
            position: { x: 320, y: 0 },
            data: { prompt: "生成关键视觉" },
          },
          {
            type: "create_node",
            client_id: "video",
            node_type: CANVAS_NODE_TYPES.video,
            position: { x: 640, y: 0 },
            data: { prompt: "生成视频" },
          },
          {
            type: "create_node",
            client_id: "audio",
            node_type: CANVAS_NODE_TYPES.audio,
            position: { x: 320, y: 280 },
            data: { text: "旁白" },
          },
          {
            type: "group_nodes",
            node_ids: ["script", "image", "video", "audio"],
            label: "视频工作流",
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();
    expect(result.errors).toEqual([]);
    expect(
      result.commandResults.some((step) => step.type === "create_edge"),
    ).toBe(false);
    expect(state.edges).toEqual([]);
  });

  it("maps auto client aliases to same-envelope created workflow nodes", () => {
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            node_type: CANVAS_NODE_TYPES.textAnnotation,
            position: { x: 0, y: 0 },
            data: { content: "剧情脚本", semanticOutputRole: "input_text" },
          },
          {
            type: "create_node",
            node_type: CANVAS_NODE_TYPES.imageGen,
            position: { x: 320, y: 0 },
            data: { prompt: "生成首帧" },
          },
          {
            type: "create_node",
            node_type: CANVAS_NODE_TYPES.audio,
            position: { x: 320, y: 260 },
            data: { text: "旁白" },
          },
          {
            type: "create_node",
            node_type: CANVAS_NODE_TYPES.video,
            position: { x: 640, y: 0 },
            data: { prompt: "生成视频" },
          },
          {
            type: "create_edge",
            source: "auto:0",
            target: "auto:1",
            link_type: "prompt_for",
          },
          {
            type: "create_edge",
            source: "auto:0",
            target: "auto:2",
            link_type: "prompt_for",
          },
          {
            type: "create_edge",
            source: "auto:1",
            target: "auto:3",
            link_type: "media_input_for",
          },
          {
            type: "create_edge",
            source: "auto:2",
            target: "auto:3",
            link_type: "media_input_for",
          },
          {
            type: "group_nodes",
            node_ids: ["auto:0", "auto:1", "auto:2", "auto:3"],
            label: "短剧视频工作流",
          },
          {
            type: "select_nodes",
            node_ids: ["auto:0", "auto:1", "auto:2", "auto:3"],
            focus: true,
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();
    const script = state.nodes.find((node) => node.data.content === "剧情脚本");
    const image = state.nodes.find(
      (node) => node.type === CANVAS_NODE_TYPES.imageGen,
    );
    const audio = state.nodes.find(
      (node) => node.type === CANVAS_NODE_TYPES.audio,
    );
    const video = state.nodes.find(
      (node) => node.type === CANVAS_NODE_TYPES.video,
    );

    expect(result.errors).toEqual([]);
    expect(result.applied).toBeGreaterThanOrEqual(9);
    expect(state.edges).toEqual([
      expect.objectContaining({ source: script?.id, target: image?.id }),
      expect.objectContaining({ source: script?.id, target: audio?.id }),
      expect.objectContaining({ source: image?.id, target: video?.id }),
      expect.objectContaining({ source: audio?.id, target: video?.id }),
    ]);
    expect(
      state.nodes.find((node) => node.type === CANVAS_NODE_TYPES.group)?.data
        .displayName,
    ).toBe("短剧视频工作流");
  });

  it("normalizes free-form text fields for text-like node types", () => {
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            client_id: "text-brief",
            node_type: CANVAS_NODE_TYPES.textAnnotation,
            data: { prompt: "普通文本内容" },
          },
          {
            type: "create_node",
            client_id: "script-brief",
            node_type: CANVAS_NODE_TYPES.script,
            data: { content: "广告脚本生成要求" },
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();
    const textNode = state.nodes.find(
      (node) => node.type === CANVAS_NODE_TYPES.textAnnotation,
    );
    const scriptNode = state.nodes.find(
      (node) => node.type === CANVAS_NODE_TYPES.script,
    );

    expect(result.errors).toEqual([]);
    // 聊天指令建节点不带 displayName，走 addNode 的标题自动发号（「文本1」）——
    // 与画布上手动新建的节点同一套命名，避免同类型节点重名。
    expect(textNode?.data).toMatchObject({
      displayName: "文本1",
      content: "普通文本内容",
    });
    expect(scriptNode?.data).toMatchObject({ prompt: "广告脚本生成要求" });
  });

  it("maps text annotation title to displayName for canvas rendering", () => {
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            node_type: CANVAS_NODE_TYPES.textAnnotation,
            data: {
              title: "公益短片主题",
              content: "留守儿童：爱的守望者",
              text: "聚焦中国农村留守儿童群体，展现他们的情感需求、成长挑战与希望之光。",
            },
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const textNode = useCanvasStore
      .getState()
      .nodes.find((node) => node.type === CANVAS_NODE_TYPES.textAnnotation);

    expect(result.errors).toEqual([]);
    expect(textNode?.data).toMatchObject({
      title: "公益短片主题",
      displayName: "公益短片主题",
      content: "留守儿童：爱的守望者",
    });
  });

  it("maps text annotation update title to displayName for canvas rendering", () => {
    const textId = useCanvasStore
      .getState()
      .addNode(
        CANVAS_NODE_TYPES.textAnnotation,
        { x: 0, y: 0 },
        { content: "旧内容" },
      );
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "update_node_data",
            node_id: textId,
            data: {
              title: "新标题",
              content: "新内容",
            },
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const textNode = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === textId);

    expect(result.errors).toEqual([]);
    expect(textNode?.data).toMatchObject({
      title: "新标题",
      displayName: "新标题",
      content: "新内容",
    });
  });

  it("normalizes editable alias fields before applying text node updates", () => {
    const textId = useCanvasStore
      .getState()
      .addNode(
        CANVAS_NODE_TYPES.textAnnotation,
        { x: 0, y: 0 },
        { title: "旧标题", content: "旧内容" },
      );
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "update_node_data",
            node_id: textId,
            data: {
              displayName: "新标题",
              prompt: "新内容",
            },
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const textNode = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === textId);

    expect(result.applied).toBe(1);
    expect(result.errors).toEqual([]);
    expect(textNode?.data).toMatchObject({
      title: "旧标题",
      displayName: "新标题",
      content: "新内容",
    });
    expect(textNode?.data).not.toHaveProperty("prompt");
  });

  it("rejects incompatible direct downstream node types", () => {
    const imageId = useCanvasStore
      .getState()
      .addNode(
        CANVAS_NODE_TYPES.imageGen,
        { x: 0, y: 0 },
        { prompt: "广告视觉素材" },
      );
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "add_next_node",
            source_node_id: imageId,
            node_type: CANVAS_NODE_TYPES.audio,
            data: { audioKind: "music", text: "轻快广告背景音乐" },
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();

    expect(result.applied).toBe(0);
    expect(result.createdNodeIds).toEqual([]);
    expect(result.errors[0]).toContain(
      "node_type audioNode is not allowed downstream of imageGenNode",
    );
    expect(result.errors[0]).toContain("Request neighbor_graph");
    expect(state.nodes).toHaveLength(1);
    expect(state.edges).toHaveLength(0);
  });

  it("does not expose video compose as default downstream for text-like nodes", () => {
    const store = useCanvasStore.getState();
    const textId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      { content: "广告脚本" },
    );
    const scriptId = store.addNode(
      CANVAS_NODE_TYPES.script,
      { x: 320, y: 0 },
      { prompt: "故事脚本" },
    );
    const textNode = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === textId);
    const scriptNode = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === scriptId);
    if (!textNode || !scriptNode)
      throw new Error("test nodes were not created");

    expect(
      buildCanvasNodeActionCatalog(textNode).downstream_spawn_types,
    ).not.toContain(CANVAS_NODE_TYPES.videoCompose);
    expect(
      buildCanvasNodeActionCatalog(scriptNode).downstream_spawn_types,
    ).not.toContain(CANVAS_NODE_TYPES.videoCompose);
  });

  it("drops create_edge commands without link_type before applying", () => {
    const store = useCanvasStore.getState();
    const scriptId = store.addNode(CANVAS_NODE_TYPES.script, { x: 320, y: 0 });
    const audioId = store.addNode(CANVAS_NODE_TYPES.audio, { x: 640, y: 0 });
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            client_id: "workflow-group",
            node_type: CANVAS_NODE_TYPES.textAnnotation,
          },
          {
            type: "create_edge",
            source: "workflow-group",
            target: scriptId,
          },
          {
            type: "create_edge",
            source: "workflow-group",
            target: audioId,
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);

    expect(result.errors).toEqual([]);
    expect(result.createdNodeIds).toHaveLength(1);
    expect(useCanvasStore.getState().edges).toHaveLength(0);
    expect(
      result.commandResults.filter((step) => step.type === "create_edge"),
    ).toHaveLength(0);
  });

  it("dedupes canvas node references by canvas id and node id", () => {
    const store = useCanvasStore.getState();
    const firstId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      { title: "A" },
    );
    const secondId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 320, y: 0 },
      { title: "B" },
    );
    const edgeId = store.addEdge(firstId, secondId);
    const nodes = useCanvasStore.getState().nodes;
    const edges = useCanvasStore.getState().edges;
    const first = nodes.find((node) => node.id === firstId);
    const second = nodes.find((node) => node.id === secondId);
    if (!first || !second) throw new Error("test nodes were not created");

    const single = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      [first],
      edges,
    );
    const group = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      [first, second],
      edges,
    );
    if (!single || !group) throw new Error("test attachments were not created");

    const merged = mergeCanvasNodeReferenceAttachments([single, group, group]);
    const payload = JSON.parse(merged[0]?.content || "{}") as {
      nodes?: Array<{ node_id: string }>;
      edges?: Array<{ edge_id: string }>;
    };

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("canvas-ref:canvas-a");
    expect(merged[0]?.label).toBe("2 canvas nodes");
    expect(payload.nodes?.map((node) => node.node_id)).toEqual([
      firstId,
      secondId,
    ]);
    expect(payload.edges?.map((edge) => edge.edge_id)).toEqual(
      edgeId ? [edgeId] : [],
    );
  });

  it("can display only a selected group while sending compact child summaries to the model", () => {
    const store = useCanvasStore.getState();
    const firstId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      { displayName: "产品资料" },
    );
    const secondId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 320, y: 0 },
      { displayName: "广告关键画面" },
    );
    const edgeId = store.addEdge(firstId, secondId);
    const groupId = store.groupNodes([firstId, secondId], {
      label: "电商广告工作流",
    });
    if (!edgeId || !groupId) throw new Error("test graph was not created");
    const nodes = useCanvasStore.getState().nodes;
    const edges = useCanvasStore.getState().edges;
    const group = nodes.find((node) => node.id === groupId);
    if (!group) throw new Error("test group was not created");

    const attachment = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      nodes,
      edges,
      nodes,
      { displayNodes: [group] },
    );
    if (!attachment) throw new Error("test attachment was not created");

    const displayedNodes = canvasNodeReferenceAttachmentNodes(attachment);
    const context = buildCanvasNodeReferenceContext([attachment]);
    const payload = JSON.parse(attachment.content || "{}") as {
      display_nodes?: Array<{ node_id: string }>;
      nodes?: Array<{ node_id: string }>;
    };

    expect(displayedNodes.map((node) => node.nodeId)).toEqual([groupId]);
    expect(payload.display_nodes?.map((node) => node.node_id)).toEqual([
      groupId,
    ]);
    expect(new Set(payload.nodes?.map((node) => node.node_id))).toEqual(
      new Set([firstId, secondId, groupId]),
    );
    expect(context).toContain(firstId);
    expect(context).toContain(secondId);
    expect(context).toContain(groupId);
    expect(context).toContain("reference_1_group_children_count: 2");
    expect(context).toContain("reference_1_child_type_counts_json");
    expect(context).toContain("action_summary_json");
    expect(context).not.toContain("action_catalog_json");
    expect(context).not.toContain("editable_schema");
    expect(context).toContain(`reference_1_edge_1_id: ${edgeId}`);
  });

  it("prunes stale canvas node references after nodes are deleted", () => {
    const store = useCanvasStore.getState();
    const firstId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      { title: "A" },
    );
    const secondId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 320, y: 0 },
      { title: "B" },
    );
    const edgeId = store.addEdge(firstId, secondId);
    if (!edgeId) throw new Error("test edge was not created");
    const attachment = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      useCanvasStore.getState().nodes,
      useCanvasStore.getState().edges,
    );
    if (!attachment) throw new Error("test attachment was not created");

    useCanvasStore.getState().deleteNode(firstId);
    const existingIds = new Set(
      useCanvasStore.getState().nodes.map((node) => node.id),
    );
    const pruned = pruneCanvasNodeReferenceAttachments(
      [attachment],
      existingIds,
    );
    const payload = JSON.parse(pruned[0]?.content || "{}") as {
      nodes?: Array<{ node_id: string }>;
      edges?: Array<{ edge_id: string }>;
    };

    expect(pruned).toHaveLength(1);
    expect(payload.nodes?.map((node) => node.node_id)).toEqual([secondId]);
    expect(payload.edges).toEqual([]);
  });

  it("removes one node from a grouped canvas node reference", () => {
    const store = useCanvasStore.getState();
    const firstId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      { title: "A" },
    );
    const secondId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 320, y: 0 },
      { title: "B" },
    );
    const edgeId = store.addEdge(firstId, secondId);
    if (!edgeId) throw new Error("test edge was not created");
    const attachment = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      useCanvasStore.getState().nodes,
      useCanvasStore.getState().edges,
    );
    if (!attachment) throw new Error("test attachment was not created");

    const updated = removeCanvasNodeFromReferenceAttachment(
      attachment,
      firstId,
    );
    const payload = JSON.parse(updated?.content || "{}") as {
      nodes?: Array<{ node_id: string }>;
      edges?: Array<{ edge_id: string }>;
    };

    expect(updated?.label).toBeTruthy();
    expect(payload.nodes?.map((node) => node.node_id)).toEqual([secondId]);
    expect(payload.edges).toEqual([]);
  });

  it("partitions node creation and destructive commands for explicit approval", () => {
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            node_type: CANVAS_NODE_TYPES.textAnnotation,
            data: { title: "Safe" },
          },
          {
            type: "delete_nodes",
            node_ids: ["node-a"],
          },
          {
            type: "delete_edges",
            pairs: [{ source: "node-a", target: "node-b" }],
          },
          {
            type: "layout_nodes",
            node_ids: ["a", "b", "c", "d"],
            mode: "grid",
          },
        ],
      },
    ]);

    const partitioned = partitionCanvasChatCommandEnvelopes(envelopes);

    expect(partitioned.immediate).toHaveLength(0);
    expect(partitioned.requiresApproval).toHaveLength(1);
    expect(
      partitioned.requiresApproval[0]?.commands.map((command) => command.type),
    ).toEqual(["create_node", "delete_nodes", "delete_edges", "layout_nodes"]);
  });

  it("moves existing and newly created nodes to exact coordinates", () => {
    const existingId = useCanvasStore
      .getState()
      .addNode(
        CANVAS_NODE_TYPES.textAnnotation,
        { x: 0, y: 0 },
        { title: "Existing" },
      );
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            client_id: "new-node",
            node_type: CANVAS_NODE_TYPES.imageGen,
            position: { x: 10, y: 10 },
          },
          {
            type: "move_nodes",
            positions: {
              [existingId]: { x: 300, y: 120 },
              "new-node": { x: 620, y: 120 },
            },
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();
    const existing = state.nodes.find((node) => node.id === existingId);
    const createdId = result.createdNodeIds[0];
    const created = state.nodes.find((node) => node.id === createdId);

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(2);
    expect(existing?.position).toEqual({ x: 300, y: 120 });
    expect(created?.position).toEqual({ x: 620, y: 120 });
  });

  it("accepts client id aliases when moving a newly created node", () => {
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            id: "new_image_node_1",
            node_type: CANVAS_NODE_TYPES.imageGen,
            position: { x: 0, y: 0 },
            data: { prompt: "猫吃鱼" },
          },
          {
            type: "move_nodes",
            positions: {
              new_image_node_1: { x: 600, y: 400 },
            },
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const createdId = result.createdNodeIds[0];
    const created = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === createdId);

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(2);
    expect(created?.position).toEqual({ x: 600, y: 400 });
    expect(created?.data).toMatchObject({ prompt: "猫吃鱼" });
  });

  it("infers a same-envelope client_id when the next command has one unknown node ref", () => {
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            node_type: CANVAS_NODE_TYPES.imageGen,
            data: { prompt: "猫吃鱼" },
          },
          {
            type: "select_nodes",
            node_ids: ["new_node"],
            focus: true,
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(2);
    expect(result.createdNodeIds).toHaveLength(1);
    expect(state.selectedNodeId).toBe(result.createdNodeIds[0]);
  });

  it("lays out nodes in command node_ids order instead of initial coordinate order", () => {
    const store = useCanvasStore.getState();
    const firstId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 400, y: 200 },
      { title: "产品/素材输入" },
    );
    const secondId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      { title: "Hook 与卖点" },
    );
    const thirdId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 200, y: 80 },
      { title: "广告关键画面" },
    );

    const result = applyCanvasChatCommands(
      extractCanvasChatCommandEnvelopes([
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "layout_nodes",
              node_ids: [firstId, secondId, thirdId],
              mode: "horizontal",
            },
          ],
        },
      ]),
    );

    expect(result.errors).toEqual([]);
    const positions = new Map(
      useCanvasStore.getState().nodes.map((node) => [node.id, node.position]),
    );
    expect(positions.get(firstId)?.x).toBeLessThan(
      positions.get(secondId)?.x ?? 0,
    );
    expect(positions.get(secondId)?.x).toBeLessThan(
      positions.get(thirdId)?.x ?? 0,
    );
    expect(positions.get(firstId)?.y).toBe(0);
    expect(positions.get(secondId)?.y).toBe(0);
    expect(positions.get(thirdId)?.y).toBe(0);
  });

  it("uses the Hermes-compatible 2×2 grid for a grouped workflow", () => {
    const store = useCanvasStore.getState();
    store.setCanvasData(
      [
        { id: "a", position: { x: 0, y: 0 } },
        { id: "b", position: { x: 400, y: 0 } },
        { id: "c", position: { x: 0, y: 300 } },
        { id: "d", position: { x: 400, y: 300 } },
      ].map((node) => ({
        ...node,
        type: CANVAS_NODE_TYPES.imageEdit,
        width: 200,
        height: 150,
        style: { width: 200, height: 150 },
        data: { imageUrl: `${node.id}.png` },
      })),
      [
        { id: "a-b", source: "a", target: "b" },
        { id: "b-c", source: "b", target: "c" },
        { id: "c-d", source: "c", target: "d" },
      ],
    );
    const groupId = store.groupNodes(["a", "b", "c", "d"]);
    expect(groupId).not.toBeNull();

    const result = applyCanvasChatCommands(
      extractCanvasChatCommandEnvelopes([
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "layout_nodes",
              node_ids: ["a", "b", "c", "d"],
              mode: "grid",
            },
          ],
        },
      ]),
    );

    expect(result.errors).toEqual([]);
    const positions = new Map(
      useCanvasStore.getState().nodes.map((node) => [node.id, node.position]),
    );
    const [a, b, c, d] = ["a", "b", "c", "d"].map(
      (nodeId) => positions.get(nodeId)!,
    );
    expect(a).toEqual({ x: 20, y: 34 });
    expect(b).toEqual({ x: 252, y: 34 });
    expect(c).toEqual({ x: 20, y: 216 });
    expect(d).toEqual({ x: 252, y: 216 });
  });

  it("uses the exact legacy Hermes grid geometry for external MCP workflows", () => {
    useCanvasStore.getState().setCanvasData(
      [
        { id: "a", position: { x: 0, y: 0 } },
        { id: "b", position: { x: 400, y: 0 } },
        { id: "c", position: { x: 0, y: 300 } },
        { id: "d", position: { x: 400, y: 300 } },
      ].map((node) => ({
        ...node,
        type: CANVAS_NODE_TYPES.imageEdit,
        width: 200,
        height: 150,
        style: { width: 200, height: 150 },
        data: { imageUrl: `${node.id}.png` },
      })),
      [],
    );

    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        external_mcp_command: true,
        commands: [
          {
            type: "group_nodes",
            node_ids: ["d", "b", "a", "c"],
            label: "Codex 工作流",
          },
          {
            type: "layout_nodes",
            node_ids: ["d", "b", "a", "c"],
            mode: "grid",
          },
        ],
      },
    ]);
    expect(envelopes[0]?.external_mcp_command).toBe(true);
    const partition = partitionCanvasChatCommandEnvelopes(envelopes);
    expect(partition.immediate[0]?.external_mcp_command).toBe(true);
    expect(partition.requiresApproval[0]?.external_mcp_command).toBe(true);

    const result = applyCanvasChatCommands(envelopes);

    expect(result.errors).toEqual([]);
    const nodes = useCanvasStore.getState().nodes;
    const positions = new Map(nodes.map((node) => [node.id, node.position]));
    expect(positions.get("d")).toEqual({ x: 60, y: 80 });
    expect(positions.get("b")).toEqual({ x: 580, y: 80 });
    expect(positions.get("a")).toEqual({ x: 60, y: 440 });
    expect(positions.get("c")).toEqual({ x: 580, y: 440 });

    const group = nodes.find((node) => node.type === CANVAS_NODE_TYPES.group);
    expect(group?.style?.width).toBe(720);
    expect(group?.style?.height).toBe(610);
  });

  it("treats an immediate unknown select_nodes id as an implicit client id for a created node", () => {
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            node_type: CANVAS_NODE_TYPES.imageGen,
            data: { prompt: "猫吃鱼" },
          },
          {
            type: "select_nodes",
            node_ids: ["new_node"],
            focus: true,
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(2);
    expect(result.createdNodeIds).toHaveLength(1);
    expect(state.selectedNodeId).toBe(result.createdNodeIds[0]);
  });

  it("accepts array-style move_nodes payloads from command tools", () => {
    const nodeId = useCanvasStore
      .getState()
      .addNode(
        CANVAS_NODE_TYPES.textAnnotation,
        { x: 0, y: 0 },
        { title: "Move me" },
      );
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "move_nodes",
            positions: [
              {
                node_id: nodeId,
                x: -500,
                y: 240,
              },
            ],
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const node = useCanvasStore
      .getState()
      .nodes.find((item) => item.id === nodeId);

    expect(result.errors).toEqual([]);
    expect(node?.position).toEqual({ x: -500, y: 240 });
  });

  it("moves nodes by relative dx dy offsets", () => {
    const nodeId = useCanvasStore
      .getState()
      .addNode(
        CANVAS_NODE_TYPES.textAnnotation,
        { x: 300, y: 80 },
        { title: "Move left" },
      );
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "move_nodes",
            node_ids: [nodeId],
            dx: -100,
            dy: 0,
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const node = useCanvasStore
      .getState()
      .nodes.find((item) => item.id === nodeId);

    expect(result.errors).toEqual([]);
    expect(node?.position).toEqual({ x: 200, y: 80 });
  });

  it("disconnects nodes by deleting edges with source target pairs", () => {
    const store = useCanvasStore.getState();
    const sourceId = store.addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 });
    const targetId = store.addNode(CANVAS_NODE_TYPES.textAnnotation, {
      x: 320,
      y: 0,
    });
    const edgeId = store.addEdge(sourceId, targetId);
    if (!edgeId) throw new Error("test edge was not created");

    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "delete_edges",
            pairs: [{ source: sourceId, target: targetId }],
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(1);
    expect(state.nodes.map((node) => node.id)).toEqual([sourceId, targetId]);
    expect(state.edges).toEqual([]);
  });

  it("rejects connection commands that target the same node", () => {
    const store = useCanvasStore.getState();
    const nodeId = store.addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 });

    const connectResult = applyCanvasChatCommands(
      extractCanvasChatCommandEnvelopes([
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "create_edge",
              source: nodeId,
              target: nodeId,
              link_type: "media_input_for",
            },
          ],
        },
      ]),
    );
    const disconnectResult = applyCanvasChatCommands(
      extractCanvasChatCommandEnvelopes([
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "delete_edges",
              pairs: [{ source: nodeId, target: nodeId }],
            },
          ],
        },
      ]),
    );

    expect(connectResult.applied).toBe(0);
    expect(connectResult.errors[0]).toContain("two different nodes");
    expect(disconnectResult.applied).toBe(0);
    expect(disconnectResult.errors[0]).toContain("two different nodes");
    expect(useCanvasStore.getState().edges).toEqual([]);
  });

  it("deletes multiple selected nodes instead of only deleting their edge", () => {
    const store = useCanvasStore.getState();
    const firstId = store.addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 });
    const secondId = store.addNode(CANVAS_NODE_TYPES.textAnnotation, {
      x: 320,
      y: 0,
    });
    const edgeId = store.addEdge(firstId, secondId);
    if (!edgeId) throw new Error("test edge was not created");

    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "delete_nodes",
            node_ids: [firstId, secondId],
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(1);
    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
  });

  it("rejects partial direct deletion of mainline projection nodes", () => {
    const projectionGroupId =
      "projection_asset_scene_master__projection_group_asset_scene_master";
    const projectionNodeId = "projection_asset_scene_master__skill_scene_360";
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: projectionGroupId,
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 0, y: 0 },
          data: {
            preset_managed: true,
            projection_key: "asset:scene:master",
            title: "主线场景",
          },
        },
        {
          id: projectionNodeId,
          type: CANVAS_NODE_TYPES.skill,
          position: { x: 360, y: 0 },
          parentId: projectionGroupId,
          data: {
            preset_managed: true,
            projection_key: "asset:scene:master",
            label: "场景生成",
          },
        },
      ],
      [],
    );

    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "delete_nodes",
            node_ids: [projectionNodeId],
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(
      `node is mainline projection managed and cannot be deleted directly: ${projectionNodeId}`,
    );
    expect(state.nodes.map((node) => node.id)).toEqual([
      projectionGroupId,
      projectionNodeId,
    ]);
  });

  it("routes whole projection group deletion through projection remove", () => {
    const projectionKey = "asset:scene:master";
    const projectionGroupId =
      "projection_asset_scene_master__projection_group_asset_scene_master";
    const projectionNodeId = "projection_asset_scene_master__skill_scene_360";
    const removedProjectionKeys: string[] = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/projection-remove",
      ({ projectionKey }) => {
        removedProjectionKeys.push(projectionKey);
      },
    );
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: projectionGroupId,
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 0, y: 0 },
          data: {
            preset_managed: true,
            projection_key: projectionKey,
            title: "主线场景",
          },
        },
        {
          id: projectionNodeId,
          type: CANVAS_NODE_TYPES.skill,
          position: { x: 360, y: 0 },
          parentId: projectionGroupId,
          data: {
            preset_managed: true,
            projection_key: projectionKey,
            label: "场景生成",
          },
        },
      ],
      [],
    );

    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "delete_nodes",
            node_ids: [projectionGroupId, projectionNodeId],
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();
    unsubscribe();

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(1);
    expect(removedProjectionKeys).toEqual([projectionKey]);
    expect(state.nodes.map((node) => node.id)).toEqual([
      projectionGroupId,
      projectionNodeId,
    ]);
  });

  it("treats edge ids in delete_nodes as edge deletion for legacy model output", () => {
    const store = useCanvasStore.getState();
    const sourceId = store.addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 });
    const targetId = store.addNode(CANVAS_NODE_TYPES.textAnnotation, {
      x: 320,
      y: 0,
    });
    const edgeId = store.addEdge(sourceId, targetId);
    if (!edgeId) throw new Error("test edge was not created");

    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "delete_nodes",
            node_ids: [edgeId],
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(1);
    expect(state.nodes.map((node) => node.id)).toEqual([sourceId, targetId]);
    expect(state.edges).toEqual([]);
  });

  it("extracts canvas commands from Hermes tool result envelopes", () => {
    const candidates = canvasCommandCandidateValues({
      id: "tool-1",
      role: "tool",
      text: "freezone_emit_canvas_command",
      timestamp: Date.now(),
      raw: {
        type: "tool.result",
        name: "freezone_emit_canvas_command",
        result: {
          ok: true,
          envelope: {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            canvas_id: "canvas-a",
            commands: [
              {
                type: "create_edge",
                source: "node-a",
                target: "node-b",
                link_type: "media_input_for",
              },
            ],
          },
        },
      },
    });

    const envelopes = extractCanvasChatCommandEnvelopes(candidates);

    expect(envelopes).toHaveLength(1);
    expect(canvasCommandEnvelopeMatchesCanvas(envelopes[0]!, "canvas-a")).toBe(
      true,
    );
    expect(canvasCommandEnvelopeMatchesCanvas(envelopes[0]!, "canvas-b")).toBe(
      false,
    );
    expect(envelopes[0]?.commands[0]).toEqual({
      type: "create_edge",
      source: "node-a",
      target: "node-b",
      link_type: "media_input_for",
    });
  });

  it("normalizes legacy media edge aliases in parsed canvas commands", () => {
    const candidates = canvasCommandCandidateValues({
      id: "tool-legacy-edge",
      role: "tool",
      text: "freezone_emit_canvas_command",
      timestamp: Date.now(),
      raw: {
        type: "tool.result",
        name: "freezone_emit_canvas_command",
        result: {
          ok: true,
          envelope: {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            canvas_id: "canvas-a",
            commands: [
              {
                type: "create_edge",
                source: "node-a",
                target: "node-b",
                link_type: "visual_reference_for",
              },
            ],
          },
        },
      },
    });

    const envelopes = extractCanvasChatCommandEnvelopes(candidates);

    expect(envelopes[0]?.commands[0]).toEqual({
      type: "create_edge",
      source: "node-a",
      target: "node-b",
      link_type: "media_input_for",
    });
  });

  it("extracts canvas commands from typed Freezone write tool results", () => {
    const candidates = canvasCommandCandidateValues({
      id: "tool-create-edge",
      role: "tool",
      text: "freezone_create_edge",
      timestamp: Date.now(),
      raw: {
        type: "tool.result",
        name: "freezone_create_edge",
        result: {
          ok: true,
          envelope: {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            canvas_id: "canvas-a",
            commands: [
              {
                type: "create_edge",
                source: "node-a",
                target: "node-b",
                link_type: "prompt_for",
              },
            ],
          },
        },
      },
    });

    const envelopes = extractCanvasChatCommandEnvelopes(candidates);

    expect(envelopes).toHaveLength(1);
    expect(canvasCommandEnvelopeMatchesCanvas(envelopes[0]!, "canvas-a")).toBe(
      true,
    );
    expect(envelopes[0]?.commands[0]).toEqual({
      type: "create_edge",
      source: "node-a",
      target: "node-b",
      link_type: "prompt_for",
    });
  });

  it("rejects create_edge commands without a link_type", () => {
    const candidates = canvasCommandCandidateValues({
      id: "tool-missing-link_type",
      role: "tool",
      text: "freezone_emit_canvas_command",
      timestamp: Date.now(),
      raw: {
        type: "tool.result",
        name: "freezone_emit_canvas_command",
        result: {
          ok: true,
          envelope: {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            canvas_id: "canvas-a",
            commands: [
              {
                type: "create_edge",
                source: "node-a",
                target: "node-b",
              },
            ],
          },
        },
      },
    });

    expect(extractCanvasChatCommandEnvelopes(candidates)).toEqual([]);
  });

  it("extracts canvas context requests from a specific Hermes context tool", () => {
    const candidates = canvasCommandCandidateValues({
      id: "tool-context-request",
      role: "tool",
      text: "freezone_get_slot_candidates",
      timestamp: Date.now(),
      raw: {
        type: "tool.call",
        name: "freezone_get_slot_candidates",
        rawInput: {
          schema_version: "canvas_context_request.v1",
          requests: [
            {
              type: "slot_candidates",
              slot_kind: "image",
            },
          ],
        },
      },
    });

    const envelopes = extractCanvasContextRequestEnvelopes(candidates);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.requests).toEqual([
      {
        type: "slot_candidates",
        slot_kind: "image",
      },
    ]);
    expect(extractCanvasChatCommandEnvelopes(candidates)).toEqual([]);
  });

  it("builds compact mainline projection asset candidates only when requested", async () => {
    const responses = await buildCanvasContextRequestResponses({
      project: "project-1",
      canvasId: "canvas-a",
      nodes: [],
      edges: [],
      ontologyContext: null,
      envelopes: [
        {
          schema_version: "canvas_context_request.v1",
          requests: [
            {
              type: "mainline_projection_assets",
              asset_kinds: ["prop", "identity"],
              query: "耳机",
              limit: 5,
            },
          ],
        },
      ],
      loadMainlineProjectionAssets: async () => [
        {
          id: "prop-headphone",
          tab: "props",
          kind: "prop",
          role: "prop_reference",
          label: "铁三角监听耳机 / reference",
          sublabel: "object",
          url: "/static/prop.png",
          exists: true,
          meta: { prop_id: "铁三角监听耳机", huge_prompt: "must not leak" },
        },
        {
          id: "identity-meng",
          tab: "characters",
          kind: "identity",
          role: "character_identity",
          label: "孟遥 / 青年时期",
          url: "/static/meng.png",
          exists: true,
          meta: { character: "孟遥", identity_id: "孟遥_青年时期" },
        },
      ],
    });

    expect(responses).toEqual([
      {
        type: "mainline_projection_assets",
        asset_kinds: ["prop", "identity"],
        query: "耳机",
        data: [
          {
            asset_kind: "prop",
            label: "铁三角监听耳机 / reference",
            sublabel: "object",
            media_type: null,
            exists: true,
            projection_request: {
              scope: "asset",
              asset_kind: "prop",
              asset_id: "铁三角监听耳机",
            },
          },
        ],
        instruction: expect.stringContaining(
          "freezone_open_mainline_projection",
        ),
      },
    ]);
  });

  it("includes character projection candidates from current canvas metadata references", async () => {
    const responses = await buildCanvasContextRequestResponses({
      project: "project-1",
      canvasId: "canvas-a",
      nodes: [],
      edges: [],
      ontologyContext: null,
      envelopes: [
        {
          schema_version: "canvas_context_request.v1",
          requests: [
            {
              type: "mainline_projection_assets",
              asset_kinds: ["character"],
            },
          ],
        },
      ],
      canvasMetadata: {
        references: [
          {
            kind: "identity",
            role: "character_identity",
            label: "孟遥 / 青年时期",
            url: "/static/meng.png",
            exists: true,
            meta: { character: "孟遥", identity_id: "孟遥_青年时期" },
          },
        ],
      },
      loadMainlineProjectionAssets: async () => [],
    });

    expect(responses).toEqual([
      {
        type: "mainline_projection_assets",
        asset_kinds: ["character"],
        query: null,
        data: [
          {
            asset_kind: "character",
            label: "孟遥 / 青年时期",
            sublabel: null,
            media_type: null,
            exists: true,
            projection_request: {
              scope: "asset",
              asset_kind: "character",
              character: "孟遥",
            },
          },
        ],
        instruction: expect.stringContaining(
          "freezone_open_mainline_projection",
        ),
      },
    ]);
  });

  it("includes character projection candidates even when the character has no portrait image", async () => {
    const responses = await buildCanvasContextRequestResponses({
      project: "project-1",
      canvasId: "canvas-a",
      nodes: [],
      edges: [],
      ontologyContext: null,
      envelopes: [
        {
          schema_version: "canvas_context_request.v1",
          requests: [
            {
              type: "mainline_projection_assets",
              asset_kinds: ["character"],
            },
          ],
        },
      ],
      loadMainlineProjectionAssets: async () => [
        {
          id: "character-chenmo",
          tab: "characters",
          kind: "character",
          role: "character_profile",
          label: "陈默",
          sublabel: "主角",
          url: null,
          exists: true,
          media_type: "text",
          meta: { character: "陈默" },
        },
      ],
    });

    expect(responses).toEqual([
      {
        type: "mainline_projection_assets",
        asset_kinds: ["character"],
        query: null,
        data: [
          {
            asset_kind: "character",
            label: "陈默",
            sublabel: "主角",
            media_type: "text",
            exists: true,
            projection_request: {
              scope: "asset",
              asset_kind: "character",
              character: "陈默",
            },
          },
        ],
        instruction: expect.stringContaining(
          "freezone_open_mainline_projection",
        ),
      },
    ]);
  });

  it("includes character projection candidates from current canvas nodes", async () => {
    const store = useCanvasStore.getState();
    const identityNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        displayName: "陈默青年身份",
        imageUrl: "/static/identity.png",
        mainline_context: [
          {
            kind: "identity",
            projectId: "project-1",
            character: "陈默",
            identityId: "陈默_青年时期",
            label: "陈默 / 青年时期",
          },
        ],
      },
    );
    const portraitNodeId = store.addNode(
      CANVAS_NODE_TYPES.upload,
      { x: 360, y: 0 },
      {
        displayName: "陈默头像",
        imageUrl: "/static/portrait.png",
        slot_target: {
          kind: "portrait",
          character: "陈默",
        },
      },
    );
    const nodes = useCanvasStore
      .getState()
      .nodes.filter(
        (node) => node.id === identityNodeId || node.id === portraitNodeId,
      );

    const responses = await buildCanvasContextRequestResponses({
      project: "project-1",
      canvasId: "canvas-a",
      nodes,
      edges: [],
      ontologyContext: null,
      envelopes: [
        {
          schema_version: "canvas_context_request.v1",
          requests: [
            {
              type: "mainline_projection_assets",
              asset_kinds: ["character"],
            },
          ],
        },
      ],
      loadMainlineProjectionAssets: async () => [],
    });

    expect(responses).toEqual([
      {
        type: "mainline_projection_assets",
        asset_kinds: ["character"],
        query: null,
        data: [
          {
            asset_kind: "character",
            label: "陈默 / 青年时期",
            sublabel: identityNodeId,
            media_type: "image",
            exists: true,
            projection_request: {
              scope: "asset",
              asset_kind: "character",
              character: "陈默",
            },
          },
        ],
        instruction: expect.stringContaining(
          "freezone_open_mainline_projection",
        ),
      },
    ]);
  });

  it("extracts canvas commands from stringified Hermes tool results", () => {
    const candidates = canvasCommandCandidateValues({
      id: "tool-string-result",
      role: "tool",
      text: "freezone_emit_canvas_command",
      timestamp: Date.now(),
      raw: {
        type: "tool.result",
        name: "freezone_emit_canvas_command",
        result: JSON.stringify({
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "move_nodes",
              positions: {
                "node-a": { x: -100, y: 20 },
              },
            },
          ],
        }),
      },
    });

    const envelopes = extractCanvasChatCommandEnvelopes(candidates);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.commands[0]).toEqual({
      type: "move_nodes",
      positions: {
        "node-a": { x: -100, y: 20 },
      },
    });
  });

  it("extracts canvas commands from websocket tool result text wrappers", () => {
    const candidates = canvasCommandCandidateValues({
      id: "tool-text-result",
      role: "tool",
      text: "agent.tool",
      timestamp: Date.now(),
      raw: {
        type: "tool.result",
        name: "agent.tool",
        result: {
          text: JSON.stringify({
            ok: true,
            status: "canvas_command_emitted",
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "move_nodes",
                node_ids: ["node-a"],
                dx: -100,
                dy: 0,
              },
            ],
          }),
        },
      },
    });

    const envelopes = extractCanvasChatCommandEnvelopes(candidates);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.commands[0]).toEqual({
      type: "move_nodes",
      positions: undefined,
      deltas: {
        "node-a": { x: -100, y: 0 },
      },
    });
  });

  it("extracts canvas commands from prefixed fenced tool result text", () => {
    const candidates = canvasCommandCandidateValues({
      id: "tool-fenced-result",
      role: "tool",
      text: "agent.tool",
      timestamp: Date.now(),
      raw: {
        type: "tool.result",
        name: "agent.tool",
        result: {
          text: `已生成画布命令：

\`\`\`json
{
  "ok": true,
  "status": "canvas_command_emitted",
  "schema_version": "${CANVAS_CHAT_COMMANDS_SCHEMA_VERSION}",
  "commands": [
    { "type": "move_nodes", "node_ids": ["node-a"], "dx": -100, "dy": 0 }
  ]
}
\`\`\``,
        },
      },
    });

    const envelopes = extractCanvasChatCommandEnvelopes(candidates);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.commands[0]).toEqual({
      type: "move_nodes",
      positions: undefined,
      deltas: {
        "node-a": { x: -100, y: 0 },
      },
    });
  });

  it("ignores canvas-like tool envelopes from non-emitter tools", () => {
    const candidates = canvasCommandCandidateValues({
      id: "tool-2",
      role: "tool",
      text: "freezone_get_canvas_ontology",
      timestamp: Date.now(),
      raw: {
        type: "tool.result",
        name: "freezone_get_canvas_ontology",
        result: {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "create_edge",
              source: "node-a",
              target: "node-b",
              link_type: "media_input_for",
            },
          ],
        },
      },
    });

    expect(extractCanvasChatCommandEnvelopes(candidates)).toEqual([]);
  });

  it("selects existing and newly created nodes from assistant commands", () => {
    const existingId = useCanvasStore
      .getState()
      .addNode(
        CANVAS_NODE_TYPES.textAnnotation,
        { x: 0, y: 0 },
        { title: "Existing" },
      );
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            client_id: "created",
            node_type: CANVAS_NODE_TYPES.imageGen,
            position: { x: 10, y: 10 },
          },
          {
            type: "select_nodes",
            node_ids: [existingId, "created"],
            focus: true,
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    const state = useCanvasStore.getState();
    const createdId = result.createdNodeIds[0];
    const selectedIds = state.nodes
      .filter((node) => node.selected)
      .map((node) => node.id);

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(2);
    expect(selectedIds).toEqual([existingId, createdId]);
    expect(state.selectedNodeId).toBeNull();
    expect(state.pendingFocusNodeId).toBe(existingId);
  });

  it("describes node action capabilities for model context", () => {
    const nodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        title: "Generated image",
        imageUrl: "/static/project/image.png",
        prompt: "A city at dusk",
      },
    );
    const node = useCanvasStore
      .getState()
      .nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("test node was not created");

    const catalog = buildCanvasNodeActionCatalog(node);
    const attachment = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      [node],
    );
    if (!attachment) throw new Error("test attachment was not created");
    const context = buildCanvasNodeReferenceContext([attachment]);

    expect(catalog.editable_fields).toContain("prompt");
    expect(catalog.actions.map((action) => action.action)).toContain(
      "update_node_data",
    );
    expect(catalog.actions.map((action) => action.action)).toContain(
      "generate_image",
    );
    expect(catalog.actions.map((action) => action.action)).toContain(
      "run_upscale_tool",
    );
    expect(catalog.actions.map((action) => action.action)).toContain(
      "run_matting_tool",
    );
    const mattingAction = catalog.actions.find(
      (action) => action.action === "run_matting_tool",
    );
    expect(mattingAction?.description).toContain("抠图");
    expect(mattingAction?.description).toContain("去背景");
    expect(mattingAction?.description).toContain("透明背景");
    expect(catalog.actions.map((action) => action.action)).toContain(
      "open_split_storyboard_tool",
    );
    expect(catalog.actions.map((action) => action.action)).toContain(
      "run_grid_product_three_view",
    );
    const addNextAction = catalog.actions.find(
      (action) => action.action === "add_next_node",
    );
    expect(addNextAction?.parameters).toMatchObject({
      source_node_id: nodeId,
      node_type_schema: {
        type: "enum",
        options_source: "downstream_spawn_types",
      },
      data_schema_source: {
        tool: "freezone_get_node_create_schema",
      },
    });
    expect(addNextAction?.parameters).not.toHaveProperty("allowed_node_types");
    expect(addNextAction?.parameters).not.toHaveProperty("node_type");
    expect(addNextAction?.parameters).not.toHaveProperty("connect");
    const upscaleAction = catalog.actions.find(
      (action) => action.action === "run_upscale_tool",
    );
    const outpaintAction = catalog.actions.find(
      (action) => action.action === "run_outpaint_tool",
    );
    expect(upscaleAction?.parameters?.parameter_schema).toMatchObject({
      model: {
        type: "enum",
        options: expect.arrayContaining(["newapi_gpt_image2"]),
      },
    });
    expect(outpaintAction?.parameters?.parameter_schema).toMatchObject({
      model: {
        type: "enum",
        options: expect.arrayContaining(["newapi_gpt_image2"]),
      },
    });
    expect(context).toContain("action_summary_json");
    expect(context).toContain(
      "Keep user-visible replies concise and non-technical",
    );
    expect(context).not.toContain("action_catalog_json");
    expect(context).not.toContain("dynamic_fields");
    expect(context).toContain("position_json");
    expect(context).not.toContain("semantic_role:");
    expect(context).not.toContain("semantic_description:");
    expect(context).not.toContain("semantic_primary_output_role:");
    expect(context).not.toContain("semantic_accepted_input_roles:");
    expect(context).toContain("action_summary_json");
    expect(context).toContain("freezone_get_node_action_catalog");
    expect(context).not.toContain("connect to true");
  });

  it("limits frame upload picker actions to image files", () => {
    const nodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.upload,
      { x: 0, y: 0 },
      {
        displayName: "当前分镜",
        imageUrl: "/static/project/frame.png",
        slot_target: { kind: "frame", episode: 1, beat: 2 },
      },
    );
    const node = useCanvasStore
      .getState()
      .nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("test node was not created");

    const catalog = buildCanvasNodeActionCatalog(node);
    const uploadAction = catalog.actions.find(
      (action) => action.action === "open_upload_picker",
    );

    expect(uploadAction?.parameters?.accept).toBe("image/*");
  });

  it("keeps mixed upload picker accept for non-image upload placeholders", () => {
    const nodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.upload,
      { x: 0, y: 0 },
      {
        displayName: "上传素材",
        previewImageUrl: "/static/project/video-cover.png",
      },
    );
    const node = useCanvasStore
      .getState()
      .nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("test node was not created");

    const catalog = buildCanvasNodeActionCatalog(node);
    const uploadAction = catalog.actions.find(
      (action) => action.action === "open_upload_picker",
    );

    expect(uploadAction?.parameters?.accept).toBe("image/*,video/*,audio/*");
  });

  it("exposes executable BeatContextNode draft edits without changing normal canvas actions", async () => {
    const node = {
      id: "context-beat",
      type: CANVAS_NODE_TYPES.beatContext,
      position: { x: 0, y: 0 },
      data: {
        preset_managed: true,
        projectId: "project-a",
        episode: 1,
        beat: 2,
        content: "{{陈默_青年时期}} 搬进幸福新开的小区。",
        snapshot: {
          visualDescription: "{{陈默_青年时期}} 搬进幸福新开的小区。",
          sceneId: "幸福小区",
          sceneVariantId: "清晨",
          timeOfDay: "清晨",
          detectedIdentities: ["陈默_青年时期"],
          detectedProps: ["业主守则"],
        },
        mainline_context: [
          {
            kind: "beat",
            projectId: "project-a",
            episode: 1,
            beat: 2,
            sceneId: "幸福小区",
            sceneVariantId: "清晨",
            timeOfDay: "清晨",
          },
          {
            kind: "scene",
            projectId: "project-a",
            sceneId: "幸福小区",
            sceneVariantId: "清晨",
            label: "幸福小区_清晨",
          },
        ],
      },
    } as const;
    const attachment = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      [node],
    );
    if (!attachment) throw new Error("test attachment was not created");
    const payload = JSON.parse(attachment.content || "null");
    const agentCatalog = payload.nodes[0].action_catalog;
    const coreCatalog = buildCanvasNodeActionCatalog(node);

    expect(agentCatalog.editable_fields).toEqual([
      "visual_description",
      "scene_ref",
      "time_of_day",
    ]);
    expect(agentCatalog.editable_schema.visual_description.current_value).toBe(
      "{{陈默_青年时期}} 搬进幸福新开的小区。",
    );
    expect(agentCatalog.editable_schema.scene_ref).toMatchObject({
      type: "object",
      current_value: { scene_id: "幸福小区", variant_id: "清晨" },
      options: expect.arrayContaining([
        { scene_id: "幸福小区", variant_id: "清晨" },
      ]),
    });
    expect(agentCatalog.editable_schema.time_of_day).toMatchObject({
      type: "enum",
      current_value: "清晨",
      options: expect.arrayContaining(["", "清晨"]),
      option_labels: { "": "未设置" },
    });
    expect(agentCatalog.actions).toContainEqual(
      expect.objectContaining({
        action: "update_node_data",
        execution: "chat_command",
        command_type: "update_node_data",
        parameters: {
          node_id: "context-beat",
          data: "object",
        },
      }),
    );
    expect(agentCatalog.actions).toContainEqual(
      expect.objectContaining({
        action: "sync_beat_context_to_mainline",
        execution: "frontend_node",
        command_type: "run_node_action",
        parameters: { node_id: "context-beat" },
      }),
    );
    expect(
      agentCatalog.actions.find(
        (action: { action: string }) => action.action === "update_node_data",
      )?.description,
    ).toContain("出场身份和出场道具不开放给 agent 编辑");
    expect(agentCatalog.instruction).toContain(
      "修改这些字段时使用 update_node_data",
    );
    expect(agentCatalog.instruction).toContain("sync_beat_context_to_mainline");
    expect(
      agentCatalog.actions.map((action: { action: string }) => action.action),
    ).not.toContain("add_next_node");
    expect(coreCatalog.actions.map((action) => action.action)).toContain(
      "add_next_node",
    );
    expect(coreCatalog.actions.map((action) => action.action)).toContain(
      "update_node_data",
    );
    expect(
      buildCanvasNodeActionCatalog({
        ...node,
        data: {
          ...node.data,
          mainline_context: undefined,
        },
      }).actions.map((action) => action.action),
    ).toContain("sync_beat_context_to_mainline");

    const envelopes = extractCanvasContextRequestEnvelopes([
      {
        schema_version: "canvas_context_request.v1",
        requests: [{ type: "node_action_catalog", node_id: node.id }],
      },
    ]);
    const response = await buildCanvasContextRequestResponse({
      project: "project-a",
      canvasId: "canvas-a",
      nodes: [node],
      edges: [],
      ontologyContext: null,
      selectedNodeIds: [],
      envelopes,
    });

    expect(response).not.toContain('"editable_fields"');
    expect(response).not.toContain('"editable_schema"');
    expect(response).toContain("sync_beat_context_to_mainline");
    expect(response).toContain("For node editable parameters");

    useCanvasStore.getState().setCanvasData([node], []);
    const result = applyCanvasChatCommands(
      extractCanvasChatCommandEnvelopes([
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "update_node_data",
              node_id: node.id,
              data: {
                visual_description: "{{陈默_青年时期}} 傍晚走进幸福小区。",
                scene_ref: { scene_id: "幸福小区", variant_id: "傍晚" },
                time_of_day: "傍晚",
              },
            },
          ],
        },
      ]),
    );
    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(1);
    const updated = useCanvasStore
      .getState()
      .nodes.find((item) => item.id === node.id);
    expect(updated?.data.content).toBe("{{陈默_青年时期}} 傍晚走进幸福小区。");
    expect(updated?.data.snapshot).toMatchObject({
      visualDescription: "{{陈默_青年时期}} 傍晚走进幸福小区。",
      sceneId: "幸福小区",
      sceneVariantId: "傍晚",
      timeOfDay: "傍晚",
      detectedIdentities: ["陈默_青年时期"],
      detectedProps: ["业主守则"],
    });
    expect(updated?.data.beat_edit_fields).toMatchObject({
      visual_description: "{{陈默_青年时期}} 傍晚走进幸福小区。",
      scene_id: "幸福小区",
      scene_variant_id: "傍晚",
      time_of_day: "傍晚",
    });
    expect(updated?.data.syncStatus).toBe("stale");

    const blocked = applyCanvasChatCommands(
      extractCanvasChatCommandEnvelopes([
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "update_node_data",
              node_id: node.id,
              data: {
                detected_identities: ["不该改"],
              },
            },
          ],
        },
      ]),
    );
    expect(blocked.applied).toBe(0);
    expect(blocked.errors.join("\n")).toContain("node is preset managed");
  });

  it("includes referenced node text preview for assistant context", () => {
    const store = useCanvasStore.getState();
    const textId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      {
        content: "女主低声说：今晚必须离开。",
      },
    );
    const imageId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 320, y: 0 },
      {
        prompt: "A tense neon alley, cinematic rain",
      },
    );
    const nodes = useCanvasStore
      .getState()
      .nodes.filter((node) => node.id === textId || node.id === imageId);
    const attachment = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      nodes,
    );
    if (!attachment) throw new Error("test attachment was not created");

    const payload = JSON.parse(attachment.content || "{}") as {
      nodes?: Array<{
        node_id: string;
        text_field: string | null;
        text_content: string | null;
      }>;
    };
    const context = buildCanvasNodeReferenceContext([attachment]);

    expect(
      payload.nodes?.find((node) => node.node_id === textId)?.text_field,
    ).toBe("content");
    expect(
      payload.nodes?.find((node) => node.node_id === textId)?.text_content,
    ).toBe("女主低声说：今晚必须离开。");
    expect(
      payload.nodes?.find((node) => node.node_id === imageId)?.text_field,
    ).toBe("prompt");
    expect(
      payload.nodes?.find((node) => node.node_id === imageId)?.text_content,
    ).toBe("A tense neon alley, cinematic rain");
    expect(context).toContain(`reference_1_node_1_text_field: content`);
    expect(context).toContain(
      `reference_1_node_1_text_preview: ${JSON.stringify("女主低声说：今晚必须离开。")}`,
    );
    expect(context).toContain(`reference_1_node_2_text_field: prompt`);
    expect(context).toContain(
      `reference_1_node_2_text_preview: ${JSON.stringify("A tense neon alley, cinematic rain")}`,
    );
  });

  it("keeps canvas routing lightweight and includes summary for ordinary Freezone turns", () => {
    const store = useCanvasStore.getState();
    const nodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        displayName: "图片节点",
        imageUrl: "/static/project/image.png",
      },
    );
    const context = buildCanvasOntologyContext(store.nodes, store.edges, {
      canvasId: "canvas-a",
      selectedNodeIds: [nodeId],
    });

    const routingOnly = buildCanvasChatCommandContext(context);
    const withSummary = buildCanvasChatCommandContext(context, {
      includeCanvasSummary: true,
    });

    expect(routingOnly).toContain("[SUPERTALE_CANVAS_ROUTING]");
    expect(routingOnly).not.toContain("canvas_ontology_context.v1");
    expect(routingOnly).not.toContain("canvas_ontology_summary.v1");
    expect(routingOnly).toContain("[SUPERTALE_CANVAS_CHAT_COMMANDS]");
    expect(routingOnly).toContain("FREEZONE_CANVAS_ASSISTANT contract");
    expect(routingOnly).toContain("read-only grounding");
    expect(routingOnly).toContain("Request only the missing catalog");
    expect(routingOnly).not.toContain("freezone_validate_canvas_commands");
    expect(routingOnly).not.toContain("videoComposeNode");
    expect(routingOnly.length).toBeLessThan(700);
    expect(routingOnly).not.toContain("link_type catalog:");
    expect(routingOnly).not.toContain(
      "If more detail is needed, emit canvas_context_request.v1",
    );
    expect(withSummary).toContain("[SUPERTALE_CANVAS_ONTOLOGY_SUMMARY]");
    expect(withSummary).toContain("canvas_ontology_summary.v1");
    expect(shouldIncludeCanvasSummary("基于当前画布搭一个流程")).toBe(true);
    expect(shouldIncludeCanvasSummary("加一个图片节点")).toBe(true);
    expect(shouldIncludeCanvasSummary("我想做个公益短片没思路")).toBe(true);
  });

  it("keeps text node references free of legacy semantic guidance", () => {
    const nodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      {
        title: "公益创意",
        content: "一支温暖的公益广告创意",
      },
    );
    const node = useCanvasStore
      .getState()
      .nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("test node was not created");

    const attachment = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      [node],
    );
    if (!attachment) throw new Error("test attachment was not created");
    const context = buildCanvasNodeReferenceContext([attachment]);

    expect(context).not.toContain("semantic_role:");
    expect(context).not.toContain("semantic_planning_start:");
    expect(context).not.toContain("semantic_primary_output_role:");
    expect(context).toContain("action_summary_json");
    expect(context).not.toContain("action_catalog_json");
    expect(context).not.toContain("editable_schema");
  });

  it("keeps text node semantic output role inside structured action catalog only", () => {
    const nodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      {
        displayName: "图片生成输入",
        content: "直接用于生成图片的完整提示词",
        semanticOutputRole: "input_text",
      },
    );
    const node = useCanvasStore
      .getState()
      .nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("test node was not created");

    const attachment = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      [node],
    );
    if (!attachment) throw new Error("test attachment was not created");
    const context = buildCanvasNodeReferenceContext([attachment]);

    expect(context).not.toContain("semantic_primary_output_role:");
    expect(context).toContain("action_summary_json");
    expect(context).not.toContain("action_catalog_json");
  });

  it("builds on-demand canvas context responses", async () => {
    const store = useCanvasStore.getState();
    const imageId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        displayName: "图片节点",
        imageUrl: "/static/project/image.png",
        prompt: "A city at dusk",
      },
    );
    const videoId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        displayName: "视频",
      },
    );
    const edgeId = store.addEdge(imageId, videoId);
    if (!edgeId) throw new Error("test edge was not created");
    const nodes = useCanvasStore.getState().nodes;
    const edges = useCanvasStore.getState().edges;
    const ontology = buildCanvasOntologyContext(nodes, edges, {
      canvasId: "canvas-a",
      selectedNodeIds: [imageId],
    });
    const envelopes = extractCanvasContextRequestEnvelopes([
      {
        schema_version: "canvas_context_request.v1",
        requests: [
          { type: "canvas_ontology" },
          { type: "canvas_summary" },
          { type: "canvas_action_catalog" },
          { type: "canvas_command_catalog" },
          { type: "node_detail", node_id: imageId },
          { type: "neighbor_graph", node_id: imageId, depth: 1 },
          { type: "node_action_catalog", node_id: imageId },
          {
            type: "action_catalog_by_id",
            action_id: "freezone.image.generate",
          },
          {
            type: "validate_canvas_commands",
            payload: {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "create_edge",
                  source: imageId,
                  target: videoId,
                  link_type: "media_input_for",
                },
              ],
            },
          },
        ],
      },
    ]);

    const response = await buildCanvasContextRequestResponse({
      project: "project-a",
      canvasId: "canvas-a",
      nodes,
      edges,
      ontologyContext: ontology,
      selectedNodeIds: [imageId],
      envelopes,
    });

    expect(response).toContain("canvas_context_response.v1");
    expect(response).toContain("canvas_ontology_context.v1");
    expect(response).toContain("canvas_ontology_summary.v1");
    expect(response).toContain("canvas_action_catalog.v1");
    expect(response).toContain("canvas_command_catalog.v1");
    expect(response).toContain("freezone_emit_canvas_command");
    expect(response).toContain("freezone_create_edge");
    expect(response).toContain(
      "freezone_get_link_type_catalog before creating an edge",
    );
    expect(response).toContain("Do not guess from natural language");
    expect(response).toContain(imageId);
    expect(response).toContain(videoId);
    expect(response).toContain("node_action_catalog");
    expect(response).toContain("freezone.image.generate");
    expect(response).toContain("canvas_command_validation.v1");
    expect(response).toContain('"ok":true');

    const responsePayload = JSON.parse(response?.split("\n")[2] ?? "{}") as {
      responses?: Array<{
        type?: string;
        data?: {
          nodes?: Array<{
            action_catalog?: unknown;
            action_summary?: unknown;
            parameters?: Record<string, unknown>;
            text_content?: unknown;
            text_preview?: unknown;
          }>;
          display_nodes?: unknown[];
          actions?: Array<{ action?: string }>;
          instruction?: string;
          editable_schema?: unknown;
        };
      }>;
    };
    const nodeDetail = responsePayload.responses?.find(
      (item) => item.type === "node_detail",
    );
    expect(nodeDetail?.data?.nodes).toHaveLength(1);
    expect(nodeDetail?.data?.nodes?.[0]?.action_summary).toBeTruthy();
    expect(nodeDetail?.data?.nodes?.[0]?.parameters?.prompt).toMatchObject({
      label: "提示词",
      type: "string",
      current_value: "A city at dusk",
    });
    expect(nodeDetail?.data?.nodes?.[0]?.action_catalog).toBeUndefined();
    expect(nodeDetail?.data?.nodes?.[0]?.text_content).toBeUndefined();
    expect(nodeDetail?.data?.nodes?.[0]?.text_preview).toBe("A city at dusk");
    expect(nodeDetail?.data?.instruction).toContain(
      "Node parameters are not toolbar/action/tool parameters",
    );
    expect(nodeDetail?.data).not.toHaveProperty("display_nodes");

    const nodeActionCatalog = responsePayload.responses?.find(
      (item) => item.type === "node_action_catalog",
    );
    expect(nodeActionCatalog?.data?.editable_schema).toBeUndefined();
    expect(nodeActionCatalog?.data?.actions?.length).toBeGreaterThan(1);
  });

  it("returns only one requested action detail when node_action_catalog includes action", async () => {
    const imageId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        displayName: "角色图",
        imageUrl: "/static/project/character.png",
        prompt: "A bright character portrait",
      },
    );
    const envelopes = extractCanvasContextRequestEnvelopes([
      {
        schema_version: "canvas_context_request.v1",
        requests: [
          {
            type: "node_action_catalog",
            node_id: imageId,
            action: "run_matting_tool",
          },
        ],
      },
    ]);

    const response = await buildCanvasContextRequestResponse({
      project: "project-a",
      canvasId: "canvas-a",
      nodes: useCanvasStore.getState().nodes,
      edges: [],
      ontologyContext: null,
      selectedNodeIds: [],
      envelopes,
    });
    const responsePayload = JSON.parse(response?.split("\n")[2] ?? "{}") as {
      responses?: Array<{
        type?: string;
        data?: {
          actions?: Array<{ action?: string }>;
          editable_schema?: unknown;
        };
      }>;
    };
    const nodeActionCatalog = responsePayload.responses?.find(
      (item) => item.type === "node_action_catalog",
    );

    expect(nodeActionCatalog?.data?.actions).toEqual([
      expect.objectContaining({ action: "run_matting_tool" }),
    ]);
    expect(nodeActionCatalog?.data?.editable_schema).toBeUndefined();
  });

  it("returns requested video upscale action detail without source node parameters", async () => {
    const videoId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.video,
      { x: 0, y: 0 },
      {
        displayName: "镜头视频",
        videoUrl: "/static/project/shot.mp4",
        quality: "720P",
        durationSec: 5,
      },
    );
    const envelopes = extractCanvasContextRequestEnvelopes([
      {
        schema_version: "canvas_context_request.v1",
        requests: [
          {
            type: "node_action_catalog",
            node_id: videoId,
            action: "open_video_upscale_tool",
          },
        ],
      },
    ]);

    const response = await buildCanvasContextRequestResponse({
      project: "project-a",
      canvasId: "canvas-a",
      nodes: useCanvasStore.getState().nodes,
      edges: [],
      ontologyContext: null,
      selectedNodeIds: [],
      envelopes,
    });
    const responsePayload = JSON.parse(response?.split("\n")[2] ?? "{}") as {
      responses?: Array<{
        type?: string;
        data?: {
          actions?: Array<{
            action?: string;
            parameters?: Record<string, unknown>;
            result_effect?: Record<string, unknown>;
          }>;
          instruction?: string;
          editable_schema?: unknown;
        };
      }>;
    };
    const nodeActionCatalog = responsePayload.responses?.find(
      (item) => item.type === "node_action_catalog",
    );

    expect(nodeActionCatalog?.data?.actions).toEqual([
      expect.objectContaining({
        action: "open_video_upscale_tool",
        parameters: expect.objectContaining({
          parameter_schema: expect.objectContaining({
            resolution: expect.objectContaining({
              options: ["1080p", "2k", "4k"],
            }),
            denoise: expect.objectContaining({
              options: ["none", "1x", "2x"],
            }),
          }),
        }),
        result_effect: expect.objectContaining({
          target: "downstream video upscale node",
        }),
      }),
    ]);
    expect(nodeActionCatalog?.data?.editable_schema).toBeUndefined();
    expect(nodeActionCatalog?.data?.instruction).toContain(
      "do not answer from the source node parameters",
    );
  });

  it("returns video upscale node parameters instead of normal video generation parameters", async () => {
    const sourceVideoId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.video,
      { x: 0, y: 0 },
      {
        displayName: "源视频",
        videoUrl: "/static/project/source.mp4",
      },
    );
    const upscaleId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        displayName: "高清（1080P）",
        isUpscaleNode: true,
        upscaleSourceUrl: "/static/project/source.mp4",
        upscaleResolution: "1080p",
        upscaleDenoise: "1x",
        videoUrl: null,
        quality: "720P",
        durationSec: 5,
      },
    );
    useCanvasStore.getState().addEdge(sourceVideoId, upscaleId);
    const envelopes = extractCanvasContextRequestEnvelopes([
      {
        schema_version: "canvas_context_request.v1",
        requests: [{ type: "node_detail", node_id: upscaleId }],
      },
    ]);

    const response = await buildCanvasContextRequestResponse({
      project: "project-a",
      canvasId: "canvas-a",
      nodes: useCanvasStore.getState().nodes,
      edges: useCanvasStore.getState().edges,
      ontologyContext: null,
      selectedNodeIds: [],
      envelopes,
    });
    const responsePayload = JSON.parse(response?.split("\n")[2] ?? "{}") as {
      responses?: Array<{
        type?: string;
        data?: {
          nodes?: Array<{
            parameters?: Record<string, { current_value?: unknown; options?: unknown[] }>;
          }>;
        };
      }>;
    };
    const nodeDetail = responsePayload.responses?.find(
      (item) => item.type === "node_detail",
    );
    const parameters = nodeDetail?.data?.nodes?.[0]?.parameters ?? {};

    expect(parameters.upscaleResolution).toMatchObject({
      label: "分辨率",
      current_value: "1080p",
      options: ["1080p", "2k", "4k"],
    });
    expect(parameters.upscaleDenoise).toMatchObject({
      label: "降噪",
      current_value: "1x",
      options: ["none", "1x", "2x"],
    });
    expect(parameters.model).toBeUndefined();
    expect(parameters.quality).toBeUndefined();
    expect(parameters.durationSec).toBeUndefined();
    expect(parameters.generateAudio).toBeUndefined();
  });

  it("returns ordered reference media in node detail for generator prompts", async () => {
    const store = useCanvasStore.getState();
    const storyboardId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        displayName: "6镜分镜草图",
        imageUrl: "/static/project/storyboard.png",
        previewImageUrl: "/static/project/storyboard-thumb.png",
      },
    );
    const characterId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 240 },
      {
        displayName: "IP角色立绘",
        imageUrl: "/static/project/character.png",
      },
    );
    const videoId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        displayName: "镜头2-拍朋友",
        prompt: "生成视频",
        referenceOrder: [characterId, storyboardId],
      },
    );
    store.addEdge(storyboardId, videoId);
    store.addEdge(characterId, videoId);
    const envelopes = extractCanvasContextRequestEnvelopes([
      {
        schema_version: "canvas_context_request.v1",
        requests: [{ type: "node_detail", node_id: videoId }],
      },
    ]);

    const response = await buildCanvasContextRequestResponse({
      project: "project-a",
      canvasId: "canvas-a",
      nodes: useCanvasStore.getState().nodes,
      edges: useCanvasStore.getState().edges,
      ontologyContext: null,
      envelopes,
    });
    const responsePayload = JSON.parse(response?.split("\n")[2] ?? "{}") as {
      responses?: Array<{
        type?: string;
        data?: {
          nodes?: Array<{
            node_id?: string;
            reference_media?: Array<{
              mention?: string;
              node_id?: string;
              label?: string;
              media_type?: string;
              source_url?: string;
              preview_url?: string;
              link_type?: string;
            }>;
          }>;
          instruction?: string;
        };
      }>;
    };
    const nodeDetail = responsePayload.responses?.find(
      (item) => item.type === "node_detail",
    );
    const videoDetail = nodeDetail?.data?.nodes?.find(
      (node) => node.node_id === videoId,
    );

    expect(videoDetail?.reference_media).toEqual([
      expect.objectContaining({
        mention: "@图片1",
        node_id: characterId,
        label: "IP角色立绘",
        media_type: "image",
        source_url: "/static/project/character.png",
        link_type: "media_input_for",
      }),
      expect.objectContaining({
        mention: "@图片2",
        node_id: storyboardId,
        label: "6镜分镜草图",
        media_type: "image",
        source_url: "/static/project/storyboard.png",
        preview_url: "/static/project/storyboard-thumb.png",
        link_type: "media_input_for",
      }),
    ]);
    expect(nodeDetail?.data?.instruction).toContain("@图片1");
  });

  it("hides mainline projection commands outside the current user's personal canvas", async () => {
    useAuthStore.setState({ username: "admin", role: "admin" });
    const envelopes = extractCanvasContextRequestEnvelopes([
      {
        schema_version: "canvas_context_request.v1",
        requests: [{ type: "canvas_command_catalog" }],
      },
    ]);

    const response = await buildCanvasContextRequestResponse({
      project: "project-a",
      canvasId: "default",
      nodes: [],
      edges: [],
      ontologyContext: null,
      envelopes,
    });

    expect(response).toContain("canvas_command_catalog.v1");
    expect(response).not.toContain("open_mainline_projection");
    expect(response).not.toContain("freezone_open_mainline_projection");
  });

  it("keeps mainline projection commands on the current user's personal canvas", async () => {
    useAuthStore.setState({ username: "admin", role: "admin" });
    const envelopes = extractCanvasContextRequestEnvelopes([
      {
        schema_version: "canvas_context_request.v1",
        requests: [{ type: "canvas_command_catalog" }],
      },
    ]);

    const response = await buildCanvasContextRequestResponse({
      project: "project-a",
      canvasId: personalCanvasIdForUsername("admin"),
      nodes: [],
      edges: [],
      ontologyContext: null,
      envelopes,
    });

    expect(response).toContain("open_mainline_projection");
    expect(response).toContain("freezone_open_mainline_projection");
  });

  it("keeps creatable node types scoped to create commands while preserving group command access", async () => {
    const envelopes = extractCanvasContextRequestEnvelopes([
      {
        schema_version: "canvas_context_request.v1",
        requests: [{ type: "canvas_command_catalog" }],
      },
    ]);

    const response = await buildCanvasContextRequestResponse({
      project: "project-a",
      canvasId: "canvas-a",
      nodes: [],
      edges: [],
      ontologyContext: null,
      envelopes,
    });
    const responsePayload = JSON.parse(response?.split("\n")[2] ?? "{}") as {
      responses?: Array<{
        type?: string;
        data?: {
          commands?: Array<{
            type?: string;
          allowed_node_types?: string[];
          field_notes?: {
            node_type?: string;
            data?: string;
          };
          image_node_example?: { data?: Record<string, unknown> };
        }>;
      };
      }>;
    };
    const catalog = responsePayload.responses?.find(
      (item) => item.type === "canvas_command_catalog",
    )?.data;
    const createCommand = catalog?.commands?.find(
      (command) => command.type === "create_node",
    );
    const groupCommand = catalog?.commands?.find(
      (command) => command.type === "group_nodes",
    );

    expect(catalog).not.toHaveProperty("agent_creatable_node_types");
    expect(createCommand?.allowed_node_types).toContain(
      CANVAS_NODE_TYPES.textAnnotation,
    );
    expect(createCommand?.allowed_node_types).toContain(
      CANVAS_NODE_TYPES.imageGen,
    );
    expect(createCommand?.allowed_node_types).toContain(
      CANVAS_NODE_TYPES.skill,
    );
    expect(createCommand?.allowed_node_types).not.toContain(
      CANVAS_NODE_TYPES.storyboardSplit,
    );
    expect(createCommand?.allowed_node_types).not.toContain(
      CANVAS_NODE_TYPES.storyboardGen,
    );
    expect(createCommand?.allowed_node_types).not.toContain(
      CANVAS_NODE_TYPES.group,
    );
    expect(createCommand?.field_notes?.node_type).toContain("imageGenNode");
    expect(createCommand?.field_notes?.node_type).not.toContain("imageNode");
    expect(createCommand?.field_notes?.node_type).not.toContain(
      "exportImageNode",
    );
    expect(createCommand?.field_notes?.data).toContain(
      "freezone_get_node_create_schema",
    );
    expect(createCommand?.image_node_example?.data).not.toHaveProperty(
      "model",
    );
    expect(groupCommand).toBeTruthy();
  });

  it("does not return create schemas for internal or derived node types", async () => {
    const envelopes = extractCanvasContextRequestEnvelopes([
      {
        schema_version: "canvas_context_request.v1",
        requests: [
          {
            type: "node_create_schema",
            node_type: CANVAS_NODE_TYPES.storyboardSplit,
          },
          { type: "node_create_schema", node_type: CANVAS_NODE_TYPES.group },
          {
            type: "node_create_schema",
            node_type: CANVAS_NODE_TYPES.textAnnotation,
          },
        ],
      },
    ]);

    const response = await buildCanvasContextRequestResponse({
      project: "project-a",
      canvasId: "canvas-a",
      nodes: useCanvasStore.getState().nodes,
      edges: useCanvasStore.getState().edges,
      ontologyContext: null,
      selectedNodeIds: [],
      envelopes,
    });
    const responsePayload = JSON.parse(response?.split("\n")[2] ?? "{}") as {
      responses?: Array<{
        type?: string;
        node_type?: string;
        data?: unknown;
      }>;
    };

    const schemaResponses = responsePayload.responses?.filter(
      (item) => item.type === "node_create_schema",
    );
    expect(
      schemaResponses?.find(
        (item) => item.node_type === CANVAS_NODE_TYPES.storyboardSplit,
      )?.data,
    ).toBeNull();
    expect(
      schemaResponses?.find((item) => item.node_type === CANVAS_NODE_TYPES.group)
        ?.data,
    ).toBeNull();
    expect(
      schemaResponses?.find(
        (item) => item.node_type === CANVAS_NODE_TYPES.textAnnotation,
      )?.data,
    ).toBeTruthy();
  });

  it("returns group node detail with direct children instead of an empty shell", async () => {
    const store = useCanvasStore.getState();
    const longPrompt = `系统生成提示词 ${"很长的内部提示。".repeat(80)}`;
    const textId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      {
        displayName: "镜头上下文",
        content: "主角走进小区。",
      },
    );
    const imageId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 320, y: 0 },
      {
        displayName: "首帧",
        prompt: longPrompt,
      },
    );
    const edgeId = store.addEdge(textId, imageId);
    const groupId = store.groupNodes([textId, imageId], { label: "EP1/B2" });
    if (!edgeId || !groupId) throw new Error("test group was not created");
    const nodes = useCanvasStore.getState().nodes;
    const edges = useCanvasStore.getState().edges;
    const envelopes = extractCanvasContextRequestEnvelopes([
      {
        schema_version: "canvas_context_request.v1",
        requests: [{ type: "node_detail", node_id: groupId }],
      },
    ]);

    const response = await buildCanvasContextRequestResponse({
      project: "project-a",
      canvasId: "canvas-a",
      nodes,
      edges,
      ontologyContext: null,
      envelopes,
    });
    const responsePayload = JSON.parse(response?.split("\n")[2] ?? "{}") as {
      responses?: Array<{
        type?: string;
        data?: {
          nodes?: Array<{
            node_id?: string;
            action_catalog?: unknown;
            action_summary?: {
              downstream_spawn_types?: unknown[];
              actions?: Array<{ action?: string }>;
            };
            parameters?: Record<
              string,
              { current_value?: unknown } & Record<string, unknown>
            >;
            text_content?: unknown;
            text_preview?: string;
          }>;
          edges?: Array<{ edge_id?: string }>;
          display_nodes?: unknown[];
        };
      }>;
    };
    const nodeDetail = responsePayload.responses?.find(
      (item) => item.type === "node_detail",
    );
    const detailNodes = nodeDetail?.data?.nodes ?? [];

    expect(detailNodes.map((node) => node.node_id)).toEqual(
      expect.arrayContaining([groupId, textId, imageId]),
    );
    expect(nodeDetail?.data?.edges?.map((edge) => edge.edge_id)).toEqual(
      edgeId ? [edgeId] : [],
    );
    const groupDetail = detailNodes.find((node) => node.node_id === groupId);
    const imageDetail = detailNodes.find((node) => node.node_id === imageId);
    expect(groupDetail?.action_summary?.downstream_spawn_types).toEqual([]);
    expect(groupDetail?.action_summary?.actions).not.toContainEqual(
      expect.objectContaining({ action: "add_next_node" }),
    );
    expect(detailNodes.some((node) => Boolean(node.action_catalog))).toBe(
      false,
    );
    expect(detailNodes.some((node) => Boolean(node.text_content))).toBe(false);
    expect(imageDetail?.text_preview).toContain("系统生成提示词");
    expect(imageDetail?.parameters?.prompt?.current_value).toBe(
      imageDetail?.text_preview,
    );
    expect(response).not.toContain(longPrompt);
    expect(nodeDetail?.data).not.toHaveProperty("display_nodes");
  });

  it("returns audio voice options for requested audio nodes", async () => {
    const store = useCanvasStore.getState();
    const audioId = store.addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 0, y: 0 },
      {
        displayName: "广告配音",
        audioKind: "speech",
        text: "广告词",
      },
    );
    const envelopes = extractCanvasContextRequestEnvelopes([
      {
        schema_version: "canvas_context_request.v1",
        requests: [{ type: "audio_voice_options", node_id: audioId }],
      },
    ]);

    const response = await buildCanvasContextRequestResponse({
      project: "project-a",
      canvasId: "canvas-a",
      nodes: useCanvasStore.getState().nodes,
      edges: useCanvasStore.getState().edges,
      ontologyContext: null,
      selectedNodeIds: [audioId],
      envelopes,
    });

    expect(response).toContain("audio_voice_options");
    expect(response).toContain("voice-a");
    expect(response).toContain("voiceRef");
    expect(response).toContain("voiceLanguage");
  });

  it("returns structured dynamic fields in node create schema responses", async () => {
    const envelopes = extractCanvasContextRequestEnvelopes([
      {
        schema_version: "canvas_context_request.v1",
        requests: [
          {
            type: "node_create_schema",
            node_type: CANVAS_NODE_TYPES.textAnnotation,
          },
          { type: "node_create_schema", node_type: CANVAS_NODE_TYPES.audio },
          { type: "node_create_schema", node_type: CANVAS_NODE_TYPES.video },
        ],
      },
    ]);

    const response = await buildCanvasContextRequestResponse({
      project: "project-a",
      canvasId: "canvas-a",
      nodes: useCanvasStore.getState().nodes,
      edges: useCanvasStore.getState().edges,
      ontologyContext: null,
      selectedNodeIds: [],
      envelopes,
    });

    expect(response).toContain("node_create_schema");
    expect(response).toContain("dynamic_or_enum_fields");
    expect(response).toContain('"field":"voiceRef"');
    expect(response).toContain('"field":"genMode"');
    expect(response).toContain('"field":"model"');
    expect(response).toContain('"semanticOutputRole"');
    expect(response).toContain(
      '"options":["planning_text","input_text","context_text"]',
    );
    expect(response).toContain(
      "How downstream nodes should interpret this text",
    );
    expect(response).not.toContain("dynamic_fields");
  });

  it("normalizes director world node create schema aliases", async () => {
    const envelopes = extractCanvasContextRequestEnvelopes([
      {
        schema_version: "canvas_context_request.v1",
        requests: [
          { type: "node_create_schema", node_type: "directorWorldNode" },
        ],
      },
    ]);

    const response = await buildCanvasContextRequestResponse({
      project: "project-a",
      canvasId: "canvas-a",
      nodes: useCanvasStore.getState().nodes,
      edges: useCanvasStore.getState().edges,
      ontologyContext: null,
      selectedNodeIds: [],
      envelopes,
    });

    expect(response).toContain('"node_type":"threeDWorldNode"');
    expect(response).toContain('"plyKind"');
  });

  it("includes referenced edges in canvas node reference context", () => {
    const store = useCanvasStore.getState();
    const sourceId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      {
        title: "角色设定",
        content: "一位温柔坚定的公益主角",
      },
    );
    const targetId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 320, y: 0 },
      {
        prompt: "公益主角形象图",
      },
    );
    const edgeId = store.addEdge(sourceId, targetId);
    if (!edgeId) throw new Error("test edge was not created");
    const attachment = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      useCanvasStore.getState().nodes,
      useCanvasStore.getState().edges,
    );
    if (!attachment) throw new Error("test attachment was not created");

    const context = buildCanvasNodeReferenceContext([attachment]);

    expect(context).toContain(`reference_1_edge_1_id: ${edgeId}`);
    expect(context).toContain(`reference_1_edge_1_source: ${sourceId}`);
    expect(context).toContain(`reference_1_edge_1_target: ${targetId}`);
    expect(context).toContain("reference_1_edge_1_link_type: prompt_for");
    expect(context).toContain("Referenced edges are only for unlink");
  });

  it("persists agent-declared edge semantics and exposes them in node reference context", () => {
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "create_node",
            client_id: "role_text",
            node_type: CANVAS_NODE_TYPES.textAnnotation,
            data: {
              displayName: "林奶奶角色设定",
              prompt: "慈祥、温和、南方老奶奶",
              semanticOutputRole: "input_text",
            },
          },
          {
            type: "create_node",
            client_id: "portrait",
            node_type: CANVAS_NODE_TYPES.imageGen,
            data: {
              displayName: "林奶奶肖像",
              prompt: "南方老奶奶肖像",
            },
          },
          {
            type: "create_edge",
            source: "role_text",
            target: "portrait",
            link_type: "prompt_for",
          },
        ],
      },
    ]);

    const result = applyCanvasChatCommands(envelopes);
    expect(result.errors).toEqual([]);

    const attachment = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      useCanvasStore.getState().nodes,
      useCanvasStore.getState().edges,
    );
    if (!attachment) throw new Error("test attachment was not created");

    const context = buildCanvasNodeReferenceContext([attachment]);

    expect(context).toContain("reference_1_edge_1_link_type: prompt_for");
  });

  it("runs available low-risk node UI actions through the canvas event bus", () => {
    const nodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        imageUrl: "/static/project/image.png",
        prompt: "A city at dusk",
      },
    );
    const events: Array<{
      nodeId: string;
      action: string;
      executionMode?: string;
    }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push(payload);
      },
    );

    try {
      const envelopes = extractCanvasChatCommandEnvelopes([
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "run_node_action",
              node_id: nodeId,
              action: "run_upscale_tool",
            },
          ],
        },
      ]);

      const result = applyCanvasChatCommands(envelopes);

      expect(result.errors).toEqual([]);
      expect(result.applied).toBe(0);
      expect(result.openedUiActions).toBe(1);
      expect(events).toEqual([
        { nodeId, action: "run_upscale_tool", executionMode: "single" },
      ]);
      expect(useCanvasStore.getState().selectedNodeId).toBe(nodeId);
      expect(useCanvasStore.getState().pendingFocusNodeId).toBe(nodeId);
    } finally {
      unsubscribe();
    }
  });

  it("opens a mainline projection through the same frontend path as the toolbar button", async () => {
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        project_id: "project-a",
        canvas_id: "default",
        commands: [
          {
            type: "open_mainline_projection",
            request: {
              scope: "beat",
              episode: 2,
              beat: 5,
              primary_slot: "frame",
            },
          },
        ],
      },
    ]);

    expect(envelopes).toHaveLength(1);
    const partition = partitionCanvasChatCommandEnvelopes(envelopes);
    expect(partition.immediate).toHaveLength(0);
    expect(partition.requiresApproval).toHaveLength(1);

    const result = await applyCanvasChatCommandsAsync(envelopes, {
      canvasId: "default",
    });

    expect(result.errors).toEqual([]);
    expect(result.openedUiActions).toBe(1);
    expect(openPresetProjectionInMyCanvas).toHaveBeenCalledWith("project-a", {
      scope: "beat",
      episode: 2,
      beat: 5,
      primary_slot: "frame",
    });
    expect(result.commandResults).toEqual([
      expect.objectContaining({
        type: "open_mainline_projection",
        status: "success",
        label: "打开主线虾画",
        output: expect.objectContaining({
          opened: true,
          canvas_id: "user_canvas",
        }),
      }),
    ]);
  });

  it("passes node action parameters through the canvas event bus", () => {
    const nodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        imageUrl: "/static/project/image.png",
        prompt: "A city at dusk",
      },
    );
    const events: Array<{
      nodeId: string;
      action: string;
      executionMode?: string;
      parameters?: Record<string, unknown>;
    }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push(payload);
      },
    );

    try {
      const envelopes = extractCanvasChatCommandEnvelopes([
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "run_node_action",
              node_id: nodeId,
              action: "run_upscale_tool",
              parameters: {
                scale_factor: 4,
                image_size: "4K",
                model: "newapi_gpt_image2",
              },
            },
          ],
        },
      ]);

      const result = applyCanvasChatCommands(envelopes);

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        {
          nodeId,
          action: "run_upscale_tool",
          executionMode: "single",
          parameters: {
            scale_factor: 4,
            image_size: "4K",
            model: "newapi_gpt_image2",
          },
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("runs the audio voice picker through the canvas event bus", async () => {
    const audioNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 0, y: 0 },
      {
        audioKind: "speech",
        text: "广告词",
      },
    );
    const events: Array<{
      nodeId: string;
      action: string;
      executionMode?: string;
    }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push(payload);
      },
    );

    try {
      const result = applyCanvasChatCommands(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: audioNodeId,
                action: "open_voice_picker",
              },
            ],
          },
        ]),
      );

      expect(result.errors).toEqual([]);
      expect(result.openedUiActions).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual([
        {
          nodeId: audioNodeId,
          action: "open_voice_picker",
          executionMode: "single",
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("runs frontend node generation actions through the canvas event bus", () => {
    const imageNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "猫吃鱼",
        imageUrl: "/static/cat.png",
      },
    );
    const audioNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 300, y: 0 },
      {
        text: "猫吃鱼",
        audioKind: "speech",
      },
    );
    const textNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 600, y: 0 },
      {
        content: "一段需要翻译的文案",
      },
    );
    const scriptNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.script,
      { x: 900, y: 0 },
      {
        prompt: "生成一个广告短片脚本",
      },
    );
    const worldNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.threeDWorld,
      { x: 1200, y: 0 },
      {
        displayName: "导演世界",
      },
    );
    useCanvasStore.getState().addEdge(imageNodeId, worldNodeId);
    const events: Array<{
      nodeId: string;
      action: string;
      executionMode?: string;
    }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push(payload);
      },
    );

    try {
      const envelopes = extractCanvasChatCommandEnvelopes([
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "run_node_action",
              node_id: imageNodeId,
              action: "generate_image",
            },
            {
              type: "run_node_action",
              node_id: audioNodeId,
              action: "generate_audio",
            },
            {
              type: "run_node_action",
              node_id: audioNodeId,
              action: "translate_text",
            },
            {
              type: "run_node_action",
              node_id: textNodeId,
              action: "translate_text",
            },
            {
              type: "run_node_action",
              node_id: scriptNodeId,
              action: "generate_story_script",
            },
            {
              type: "run_node_action",
              node_id: worldNodeId,
              action: "open_director_world",
            },
            {
              type: "run_node_action",
              node_id: worldNodeId,
              action: "generate_3gs_world",
            },
          ],
        },
      ]);

      const result = applyCanvasChatCommands(envelopes);

      expect(result.errors).toEqual([]);
      expect(result.applied).toBe(0);
      expect(result.openedUiActions).toBe(7);
      expect(events).toEqual([
        {
          nodeId: imageNodeId,
          action: "generate_image",
          executionMode: "single",
        },
        {
          nodeId: audioNodeId,
          action: "generate_audio",
          executionMode: "single",
        },
        {
          nodeId: audioNodeId,
          action: "translate_text",
          executionMode: "single",
        },
        {
          nodeId: textNodeId,
          action: "translate_text",
          executionMode: "single",
        },
        {
          nodeId: scriptNodeId,
          action: "generate_story_script",
          executionMode: "single",
        },
        {
          nodeId: worldNodeId,
          action: "open_director_world",
          executionMode: "single",
        },
        {
          nodeId: worldNodeId,
          action: "generate_3gs_world",
          executionMode: "single",
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("queues node generation actions by canvas edge dependencies", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "猫吃鱼",
      },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "猫吃鱼视频",
      },
    );
    store.addEdge(imageNodeId, videoNodeId);
    const events: Array<{
      nodeId: string;
      action: string;
      executionMode?: string;
    }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({
          nodeId: payload.nodeId,
          action: payload.action,
          executionMode: payload.executionMode,
        });
        if (!payload.requestId) return;
        if (payload.nodeId === imageNodeId) {
          useCanvasStore
            .getState()
            .updateNodeData(imageNodeId, {
              imageUrl: "/static/project/image.png",
            });
        }
        if (payload.nodeId === videoNodeId) {
          expect(
            useCanvasStore
              .getState()
              .nodes.find((node) => node.id === imageNodeId)?.data.imageUrl,
          ).toBe("/static/project/image.png");
          useCanvasStore
            .getState()
            .updateNodeData(videoNodeId, {
              videoUrl: "/static/project/video.mp4",
            });
        }
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: imageNodeId,
                action: "generate_image",
              },
              {
                type: "run_node_action",
                node_id: videoNodeId,
                action: "generate_video",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(result.openedUiActions).toBe(2);
      expect(events).toEqual([
        {
          nodeId: imageNodeId,
          action: "generate_image",
          executionMode: "single",
        },
        {
          nodeId: videoNodeId,
          action: "generate_video",
          executionMode: "single",
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("accepts generic output url from queued generation actions", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "商品主图",
      },
    );

    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        if (!payload.requestId) return;
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
          output: { url: "/static/project/image.png" },
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: imageNodeId,
                action: "generate_image",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(result.commandResults).toEqual([
        expect.objectContaining({
          status: "success",
          nodeId: imageNodeId,
          action: "generate_image",
          output: { url: "/static/project/image.png" },
        }),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("accepts queued generation actions that persist an async task handle", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "商品主图",
      },
    );

    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        if (!payload.requestId) return;
        useCanvasStore
          .getState()
          .updateNodeData(payload.nodeId, {
            // Real generation nodes claim this lock only after receiving the action.
            isGenerating: true,
            generationTaskKey: "freezone_gen:job-a",
            generationTaskType: "freezone_gen",
          });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: imageNodeId,
                action: "generate_image",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(result.commandResults).toEqual([
        expect.objectContaining({
          status: "success",
          nodeId: imageNodeId,
          action: "generate_image",
        }),
      ]);
      expect(useCanvasStore.getState().nodes.find((node) => node.id === imageNodeId)?.data).toMatchObject({
        isGenerating: true,
        generationTaskKey: "freezone_gen:job-a",
      });
    } finally {
      unsubscribe();
    }
  });

  it("does not auto-run upstream generation dependencies for a single node action", async () => {
    const store = useCanvasStore.getState();
    const upstreamImageGenId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "未生成的上游图片",
      },
    );
    const targetImageId = store.addNode(
      CANVAS_NODE_TYPES.exportImage,
      { x: 360, y: 0 },
      {
        imageUrl: "/static/project/current-image.png",
        previewImageUrl: "/static/project/current-image.png",
      },
    );
    store.addEdge(upstreamImageGenId, targetImageId);

    const events: Array<{
      nodeId: string;
      action: string;
      executionMode?: string;
    }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({
          nodeId: payload.nodeId,
          action: payload.action,
          executionMode: payload.executionMode,
        });
        if (!payload.requestId) return;
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: targetImageId,
                action: "run_matting_tool",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(result.errors).toEqual([]);
      expect(result.applied).toBe(0);
      expect(result.openedUiActions).toBe(1);
      expect(events).toEqual([
        {
          nodeId: targetImageId,
          action: "run_matting_tool",
          executionMode: "single",
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("defers current media node action dispatch until after selection can mount node handlers", async () => {
    const targetImageId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.exportImage,
      { x: 0, y: 0 },
      {
        imageUrl: "/static/project/current-image.png",
        previewImageUrl: "/static/project/current-image.png",
      },
    );
    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe("freezone/run-node-action", (payload) => {
      events.push({
        nodeId: payload.nodeId,
        action: payload.action,
      });
    });

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: targetImageId,
                action: "run_matting_tool",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([]);

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events).toEqual([
        {
          nodeId: targetImageId,
          action: "run_matting_tool",
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("submits grid node actions without queueing a canvas operation", async () => {
    const targetImageId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.exportImage,
      { x: 0, y: 0 },
      {
        imageUrl: "/static/project/current-image.png",
        previewImageUrl: "/static/project/current-image.png",
      },
    );
    const events: Array<{ nodeId: string; action: string; hasRequestId: boolean }> = [];
    const unsubscribe = canvasEventBus.subscribe("freezone/run-node-action", (payload) => {
      events.push({
        nodeId: payload.nodeId,
        action: payload.action,
        hasRequestId: Boolean(payload.requestId),
      });
    });

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: targetImageId,
                action: "run_grid_multi_camera",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(result.errors).toEqual([]);
      expect(result.applied).toBe(0);
      expect(result.openedUiActions).toBe(1);
      expect(useCanvasStore.getState().pendingFocusNodeId).not.toBe(targetImageId);
      expect(events).toEqual([
        {
          nodeId: targetImageId,
          action: "run_grid_multi_camera",
          hasRequestId: false,
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("submits outpaint node actions as result-spawning canvas work", async () => {
    const targetImageId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.exportImage,
      { x: 0, y: 0 },
      {
        imageUrl: "/static/project/current-image.png",
        previewImageUrl: "/static/project/current-image.png",
      },
    );
    const events: Array<{ nodeId: string; action: string; hasRequestId: boolean }> = [];
    const unsubscribe = canvasEventBus.subscribe("freezone/run-node-action", (payload) => {
      events.push({
        nodeId: payload.nodeId,
        action: payload.action,
        hasRequestId: Boolean(payload.requestId),
      });
    });

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: targetImageId,
                action: "run_outpaint_tool",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(result.errors).toEqual([]);
      expect(result.applied).toBe(0);
      expect(result.openedUiActions).toBe(1);
      expect(useCanvasStore.getState().pendingFocusNodeId).not.toBe(targetImageId);
      expect(events).toEqual([
        {
          nodeId: targetImageId,
          action: "run_outpaint_tool",
          hasRequestId: false,
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("submits upscale node actions through the selected source node context", async () => {
    const targetImageId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.exportImage,
      { x: 0, y: 0 },
      {
        imageUrl: "/static/project/current-image.png",
        previewImageUrl: "/static/project/current-image.png",
      },
    );
    const events: Array<{ nodeId: string; action: string; hasRequestId: boolean }> = [];
    const unsubscribe = canvasEventBus.subscribe("freezone/run-node-action", (payload) => {
      events.push({
        nodeId: payload.nodeId,
        action: payload.action,
        hasRequestId: Boolean(payload.requestId),
      });
    });

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: targetImageId,
                action: "run_upscale_tool",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(result.errors).toEqual([]);
      expect(result.applied).toBe(0);
      expect(result.openedUiActions).toBe(1);
      expect(useCanvasStore.getState().pendingFocusNodeId).toBe(targetImageId);
      expect(events).toEqual([
        {
          nodeId: targetImageId,
          action: "run_upscale_tool",
          hasRequestId: false,
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("does not auto-run upstream generation before capturing an existing pano view", async () => {
    const store = useCanvasStore.getState();
    const upstreamImageGenId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "未生成的上游全景来源",
      },
    );
    const panoNodeId = store.addNode(
      CANVAS_NODE_TYPES.pano360Viewer,
      { x: 360, y: 0 },
      {
        displayName: "360 全景查看器",
        imageUrl: "/static/project/existing-pano.png",
        previewImageUrl: "/static/project/existing-pano.png",
      },
    );
    store.addEdge(upstreamImageGenId, panoNodeId);

    const events: Array<{
      nodeId: string;
      action: string;
      executionMode?: string;
    }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({
          nodeId: payload.nodeId,
          action: payload.action,
          executionMode: payload.executionMode,
        });
        if (!payload.requestId) return;
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: panoNodeId,
                action: "capture_pano_current_view",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        {
          nodeId: panoNodeId,
          action: "capture_pano_current_view",
          executionMode: "single",
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("reorders queued node actions when the assistant lists downstream first", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "猫吃鱼",
      },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "猫吃鱼视频",
      },
    );
    store.addEdge(imageNodeId, videoNodeId);
    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        useCanvasStore.getState().updateNodeData(payload.nodeId, {
          ...(payload.action === "generate_image"
            ? { imageUrl: "/static/project/image.png" }
            : {}),
          ...(payload.action === "generate_video"
            ? { videoUrl: "/static/project/video.mp4" }
            : {}),
        });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: videoNodeId,
                action: "generate_video",
              },
              {
                type: "run_node_action",
                node_id: imageNodeId,
                action: "generate_image",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(events).toEqual([
        { nodeId: imageNodeId, action: "generate_image" },
        { nodeId: videoNodeId, action: "generate_video" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("skips downstream queued actions when an upstream generation fails", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "猫吃鱼",
      },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "猫吃鱼视频",
      },
    );
    store.addEdge(imageNodeId, videoNodeId);
    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "error",
          error: "图片生成失败",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: imageNodeId,
                action: "generate_image",
              },
              {
                type: "run_node_action",
                node_id: videoNodeId,
                action: "generate_video",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(events).toEqual([
        { nodeId: imageNodeId, action: "generate_image" },
      ]);
      expect(result.errors).toContain("图片生成失败");
      expect(
        result.errors.some((error) => error.includes("跳过 generate_video")),
      ).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("continues downstream when a timed-out upstream already has a valid result", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      { prompt: "商品主图" },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      { prompt: "商品视频" },
    );
    store.addEdge(imageNodeId, videoNodeId);
    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        if (payload.nodeId === imageNodeId) {
          store.updateNodeData(imageNodeId, {
            imageUrl: "/static/project/late-image.png",
          });
          canvasEventBus.publish("freezone/node-action-result", {
            requestId: payload.requestId,
            nodeId: payload.nodeId,
            action: payload.action,
            status: "error",
            error: "节点动作执行超时",
          });
          return;
        }
        store.updateNodeData(videoNodeId, {
          videoUrl: "/static/project/video.mp4",
        });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [{
            type: "run_workflow",
            node_ids: [imageNodeId],
            direction: "downstream",
          }],
        }]),
        {
          projectId: "project-a",
          canvasId: "canvas-a",
          actionTimeoutMs: 100,
        },
      );

      expect(events).toEqual([
        { nodeId: imageNodeId, action: "generate_image" },
        { nodeId: videoNodeId, action: "generate_video" },
      ]);
      expect(result.errors).toEqual([]);
      expect(updateFreezoneWorkflowRun).toHaveBeenCalledWith(
        "project-a",
        "canvas-a",
        "run-test",
        expect.objectContaining({
          action_updates: [expect.objectContaining({
            node_id: imageNodeId,
            status: "completed",
          })],
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it("retries transient upstream failures before reporting the final result", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      { prompt: "商品主图" },
    );
    let attempts = 0;
    const unsubscribe = canvasEventBus.subscribe("freezone/run-node-action", (payload) => {
      if (!payload.requestId) return;
      attempts += 1;
      if (attempts < 3) {
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "error",
          error: "HTTP 503 upstream unavailable",
        });
        return;
      }
      store.updateNodeData(payload.nodeId, { imageUrl: "/static/project/image.png" });
      canvasEventBus.publish("freezone/node-action-result", {
        requestId: payload.requestId,
        nodeId: payload.nodeId,
        action: payload.action,
        status: "success",
      });
    });

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [{ type: "run_workflow", node_ids: [imageNodeId] }],
        }]),
        {
          projectId: "project-a",
          canvasId: "canvas-a",
          actionTimeoutMs: 100,
          actionRetryDelayMs: 1,
        },
      );

      expect(attempts).toBe(3);
      expect(result.errors).toEqual([]);
      expect(updateFreezoneWorkflowRun).toHaveBeenCalledWith(
        "project-a",
        "canvas-a",
        "run-test",
        expect.objectContaining({
          action_updates: [expect.objectContaining({
            node_id: imageNodeId,
            status: "completed",
            retry_count: 2,
          })],
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it("stops downstream actions after the workflow graph changes", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      { prompt: "商品主图" },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      { prompt: "商品视频" },
    );
    store.addEdge(imageNodeId, videoNodeId);
    const events: string[] = [];
    const unsubscribe = canvasEventBus.subscribe("freezone/run-node-action", (payload) => {
      events.push(payload.nodeId);
      if (!payload.requestId) return;
      store.updateNodeData(payload.nodeId, { imageUrl: "/static/project/image.png" });
      store.deleteNode(videoNodeId);
      canvasEventBus.publish("freezone/node-action-result", {
        requestId: payload.requestId,
        nodeId: payload.nodeId,
        action: payload.action,
        status: "success",
      });
    });

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            { type: "run_node_action", node_id: imageNodeId, action: "generate_image" },
            { type: "run_node_action", node_id: videoNodeId, action: "generate_video" },
          ],
        }]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(events).toEqual([imageNodeId]);
      expect(result.errors).toContain(
        "画布节点或连线已发生变化，已停止执行旧工作流的后续节点。",
      );
    } finally {
      unsubscribe();
    }
  });

  it("rejects queued node actions when canvas edges contain a cycle", async () => {
    const store = useCanvasStore.getState();
    const firstImageId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "第一张",
      },
    );
    const secondImageId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 360, y: 0 },
      {
        prompt: "第二张",
      },
    );
    useCanvasStore.getState().setCanvasData(useCanvasStore.getState().nodes, [
      { id: "edge-a", source: firstImageId, target: secondImageId },
      { id: "edge-b", source: secondImageId, target: firstImageId },
    ]);
    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: firstImageId,
                action: "generate_image",
              },
              {
                type: "run_node_action",
                node_id: secondImageId,
                action: "generate_image",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(events).toEqual([]);
      expect(result.errors[0]).toContain("环形依赖");
      expect(result.commandResults).toHaveLength(2);
      expect(
        result.commandResults.every((step) => step.status === "error"),
      ).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("keeps queued independent node actions in assistant command order", async () => {
    const store = useCanvasStore.getState();
    const firstImageId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "第一张",
      },
    );
    const secondImageId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 360, y: 0 },
      {
        prompt: "第二张",
      },
    );
    const events: string[] = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push(payload.nodeId);
        if (!payload.requestId) return;
        useCanvasStore
          .getState()
          .updateNodeData(payload.nodeId, {
            imageUrl: `/static/${payload.nodeId}.png`,
          });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: secondImageId,
                action: "generate_image",
              },
              {
                type: "run_node_action",
                node_id: firstImageId,
                action: "generate_image",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(events).toEqual([secondImageId, firstImageId]);
    } finally {
      unsubscribe();
    }
  });

  it("queues workflow actions beyond the three-task concurrency limit", async () => {
    const store = useCanvasStore.getState();
    const nodeIds = Array.from({ length: 5 }, (_, index) => store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: index * 240, y: 0 },
      { prompt: `商品图 ${index + 1}` },
    ));
    const events: Array<{ nodeId: string; requestId?: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, requestId: payload.requestId });
      },
    );
    const completeAction = (event: { nodeId: string; requestId?: string }) => {
      if (!event.requestId) throw new Error("expected image request id");
      useCanvasStore.getState().updateNodeData(event.nodeId, {
        imageUrl: `/static/${event.nodeId}.png`,
      });
      canvasEventBus.publish("freezone/node-action-result", {
        requestId: event.requestId,
        nodeId: event.nodeId,
        action: "generate_image",
        status: "success",
      });
    };

    try {
      const resultPromise = applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: nodeIds.map((nodeId) => ({
            type: "run_node_action" as const,
            node_id: nodeId,
            action: "generate_image",
          })),
        }]),
        { canvasId: "canvas-a", actionTimeoutMs: 1_000 },
      );

      await vi.waitFor(() => expect(events).toHaveLength(3));
      await Promise.resolve();
      expect(events.map(({ nodeId }) => nodeId)).toEqual(nodeIds.slice(0, 3));

      completeAction(events[0]);
      await vi.waitFor(() => expect(events).toHaveLength(4));
      expect(events[3].nodeId).toBe(nodeIds[3]);

      completeAction(events[1]);
      await vi.waitFor(() => expect(events).toHaveLength(5));
      expect(events[4].nodeId).toBe(nodeIds[4]);

      for (const event of events.slice(2)) completeAction(event);
      const result = await resultPromise;
      expect(result.errors).toEqual([]);
      expect(result.commandResults).toHaveLength(5);
    } finally {
      unsubscribe();
    }
  });

  it("does not claim the node generation lock before the node accepts a workflow action", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      { prompt: "商品主图" },
    );
    let generatingAtDispatch: unknown;
    let workflowRunningAtDispatch: unknown;
    const unsubscribe = canvasEventBus.subscribe("freezone/run-node-action", (payload) => {
      if (payload.nodeId !== imageNodeId || !payload.requestId) return;
      const nodeData = useCanvasStore.getState().nodes.find(
        (node) => node.id === imageNodeId,
      )?.data;
      generatingAtDispatch = nodeData?.isGenerating;
      workflowRunningAtDispatch = nodeData?.workflowActionRunning;
      useCanvasStore.getState().updateNodeData(imageNodeId, {
        imageUrl: "/static/product.png",
      });
      canvasEventBus.publish("freezone/node-action-accepted", {
        requestId: payload.requestId,
        nodeId: payload.nodeId,
        action: payload.action,
      });
      canvasEventBus.publish("freezone/node-action-result", {
        requestId: payload.requestId,
        nodeId: payload.nodeId,
        action: payload.action,
        status: "success",
      });
    });

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [{
            type: "run_node_action",
            node_id: imageNodeId,
            action: "generate_image",
          }],
        }]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(generatingAtDispatch).not.toBe(true);
      expect(workflowRunningAtDispatch).toBe(true);
      expect(useCanvasStore.getState().nodes.find(
        (node) => node.id === imageNodeId,
      )?.data.workflowActionRunning).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it("runs up to three independent video actions in parallel", async () => {
    const store = useCanvasStore.getState();
    const nodeIds = Array.from({ length: 4 }, (_, index) => store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: index * 360, y: 0 },
      { prompt: `广告镜头 ${index + 1}` },
    ));
    const events: Array<{ nodeId: string; requestId?: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => events.push({ nodeId: payload.nodeId, requestId: payload.requestId }),
    );
    const completeAction = (event: { nodeId: string; requestId?: string }) => {
      if (!event.requestId) throw new Error("expected video request id");
      useCanvasStore.getState().updateNodeData(event.nodeId, {
        videoUrl: `/static/${event.nodeId}.mp4`,
      });
      canvasEventBus.publish("freezone/node-action-result", {
        requestId: event.requestId,
        nodeId: event.nodeId,
        action: "generate_video",
        status: "success",
      });
    };

    try {
      const resultPromise = applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: nodeIds.map((nodeId) => ({
            type: "run_node_action" as const,
            node_id: nodeId,
            action: "generate_video",
          })),
        }]),
        { canvasId: "canvas-a", actionTimeoutMs: 1_000 },
      );

      await vi.waitFor(() => expect(events).toHaveLength(3));
      await Promise.resolve();
      expect(events.map(({ nodeId }) => nodeId)).toEqual(nodeIds.slice(0, 3));

      completeAction(events[0]);
      await vi.waitFor(() => expect(events).toHaveLength(4));
      expect(events[3].nodeId).toBe(nodeIds[3]);
      for (const event of events.slice(1)) completeAction(event);

      const result = await resultPromise;
      expect(result.errors).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("uses the backend video capacity when it is lower than the frontend limit", async () => {
    vi.mocked(getProjectTaskLimits).mockResolvedValue({
      default: {
        limit: 12,
        active: 0,
        remaining: 12,
        user_limit: 3,
        user_active: 0,
        user_remaining: 3,
      },
      video: {
        limit: 4,
        active: 0,
        remaining: 4,
        user_limit: 1,
        user_active: 0,
        user_remaining: 1,
      },
      world: {
        limit: 2,
        active: 0,
        remaining: 2,
        user_limit: 1,
        user_active: 0,
        user_remaining: 1,
      },
      ffmpeg: {
        limit: 2,
        active: 0,
        remaining: 2,
        user_limit: 1,
        user_active: 0,
        user_remaining: 1,
      },
    });
    const store = useCanvasStore.getState();
    const nodeIds = Array.from({ length: 3 }, (_, index) => store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: index * 360, y: 0 },
      { prompt: `广告镜头 ${index + 1}` },
    ));
    const events: Array<{ nodeId: string; requestId?: string }> = [];
    const unsubscribe = canvasEventBus.subscribe("freezone/run-node-action", (payload) => {
      events.push({ nodeId: payload.nodeId, requestId: payload.requestId });
    });
    const completeAction = (event: { nodeId: string; requestId?: string }) => {
      if (!event.requestId) throw new Error("expected video request id");
      useCanvasStore.getState().updateNodeData(event.nodeId, {
        videoUrl: `/static/${event.nodeId}.mp4`,
      });
      canvasEventBus.publish("freezone/node-action-result", {
        requestId: event.requestId,
        nodeId: event.nodeId,
        action: "generate_video",
        status: "success",
      });
    };

    try {
      const resultPromise = applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: nodeIds.map((nodeId) => ({
            type: "run_node_action" as const,
            node_id: nodeId,
            action: "generate_video",
          })),
        }]),
        {
          projectId: "project-a",
          canvasId: "canvas-a",
          actionTimeoutMs: 1_000,
        },
      );

      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events[0].nodeId).toBe(nodeIds[0]);

      completeAction(events[0]);
      await vi.waitFor(() => expect(events).toHaveLength(2));
      expect(events[1].nodeId).toBe(nodeIds[1]);

      completeAction(events[1]);
      await vi.waitFor(() => expect(events).toHaveLength(3));
      expect(events[2].nodeId).toBe(nodeIds[2]);
      completeAction(events[2]);

      const result = await resultPromise;
      expect(result.errors).toEqual([]);
      expect(getProjectTaskLimits).toHaveBeenCalledWith("project-a");
    } finally {
      unsubscribe();
    }
  });

  it("runs independent workflow branches in parallel and waits before downstream video", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "角色首帧",
      },
    );
    const audioNodeId = store.addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 0, y: 240 },
      {
        text: "旁白台词",
      },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "根据首帧和旁白生成视频",
      },
    );
    store.addEdge(imageNodeId, videoNodeId);
    store.addEdge(audioNodeId, videoNodeId);

    const events: Array<{
      nodeId: string;
      action: string;
      executionMode?: string;
      requestId?: string;
    }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({
          nodeId: payload.nodeId,
          action: payload.action,
          executionMode: payload.executionMode,
          requestId: payload.requestId,
        });
        if (payload.nodeId !== videoNodeId || !payload.requestId) return;
        useCanvasStore
          .getState()
          .updateNodeData(videoNodeId, {
            videoUrl: "/static/project/video.mp4",
          });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const resultPromise = applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: imageNodeId,
                action: "generate_image",
              },
              {
                type: "run_node_action",
                node_id: audioNodeId,
                action: "generate_audio",
              },
              {
                type: "run_node_action",
                node_id: videoNodeId,
                action: "generate_video",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      await vi.waitFor(() => expect(events).toHaveLength(2));
      expect(events.map((event) => event.nodeId)).toEqual([
        imageNodeId,
        audioNodeId,
      ]);

      const imageRequestId = events.find(
        (event) => event.nodeId === imageNodeId,
      )?.requestId;
      if (!imageRequestId) throw new Error("expected image request id");
      useCanvasStore
        .getState()
        .updateNodeData(imageNodeId, { imageUrl: "/static/project/image.png" });
      canvasEventBus.publish("freezone/node-action-result", {
        requestId: imageRequestId,
        nodeId: imageNodeId,
        action: "generate_image",
        status: "success",
      });
      await Promise.resolve();
      expect(events).toHaveLength(2);

      const audioRequestId = events.find(
        (event) => event.nodeId === audioNodeId,
      )?.requestId;
      if (!audioRequestId) throw new Error("expected audio request id");
      useCanvasStore
        .getState()
        .updateNodeData(audioNodeId, { audioUrl: "/static/project/audio.wav" });
      canvasEventBus.publish("freezone/node-action-result", {
        requestId: audioRequestId,
        nodeId: audioNodeId,
        action: "generate_audio",
        status: "success",
      });

      await vi.waitFor(() => expect(events).toHaveLength(3));
      expect(events[2]).toMatchObject({
        nodeId: videoNodeId,
        action: "generate_video",
      });
      const result = await resultPromise;
      expect(result.errors).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("captures the upstream video tail frame before running a dependent video", async () => {
    const store = useCanvasStore.getState();
    const firstVideoId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 0, y: 0 },
      {
        prompt: "镜头 1",
        durationMs: 8000,
      },
    );
    const secondVideoId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "镜头 2",
      },
    );
    store.addEdgeWithData(firstVideoId, secondVideoId, {
      link_type: "dependency_for",
    });

    const events: Array<{ nodeId: string; action: string; requestId?: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({
          nodeId: payload.nodeId,
          action: payload.action,
          requestId: payload.requestId,
        });
        if (!payload.requestId) return;
        if (payload.nodeId === firstVideoId) {
          useCanvasStore.getState().updateNodeData(firstVideoId, {
            videoUrl: "/static/project/shot-1.mp4",
          });
        }
        if (payload.nodeId === secondVideoId) {
          const state = useCanvasStore.getState();
          const tailFrame = state.nodes.find((node) =>
            node.type === CANVAS_NODE_TYPES.exportImage &&
            (node.data as Record<string, unknown>).displayName === "上一镜尾帧"
          );
          expect(tailFrame?.data).toMatchObject({
            imageUrl: "/static/project/tail-frame.png",
            workflowContinuityFrame: {
              sourceVideoNodeId: firstVideoId,
              targetVideoNodeId: secondVideoId,
            },
          });
          expect(state.edges).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                source: tailFrame?.id,
                target: secondVideoId,
                data: expect.objectContaining({ link_type: "media_input_for" }),
              }),
            ]),
          );
          expect(
            (state.nodes.find((node) => node.id === secondVideoId)?.data as Record<string, unknown>)
              .prompt,
          ).toContain("上一镜尾帧已作为图片参考接入");
          useCanvasStore.getState().updateNodeData(secondVideoId, {
            videoUrl: "/static/project/shot-2.mp4",
          });
        }
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: firstVideoId,
                action: "generate_video",
              },
              {
                type: "run_node_action",
                node_id: secondVideoId,
                action: "generate_video",
              },
            ],
          },
        ]),
        { projectId: "project-a", canvasId: "canvas-a", actionTimeoutMs: 500 },
      );

      expect(result.errors).toEqual([]);
      expect(events.map((event) => event.nodeId)).toEqual([firstVideoId, secondVideoId]);
      expect(captureVideoFrameBlob).toHaveBeenCalledWith("/static/project/shot-1.mp4", 7.95);
      expect(uploadFreezoneImage).toHaveBeenCalledWith(
        "project-a",
        expect.any(File),
        expect.stringMatching(/^frame-/),
      );
    } finally {
      unsubscribe();
    }
  });

  it("waits through non-generating intermediate nodes when following workflow edges", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "商品主图",
      },
    );
    const textNodeId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 360, y: 0 },
      {
        content: "基于图片的补充说明",
      },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 720, y: 0 },
      {
        prompt: "商品视频",
      },
    );
    store.addEdge(imageNodeId, textNodeId);
    store.addEdge(textNodeId, videoNodeId);

    const events: Array<{
      nodeId: string;
      action: string;
      executionMode?: string;
      requestId?: string;
    }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({
          nodeId: payload.nodeId,
          action: payload.action,
          executionMode: payload.executionMode,
          requestId: payload.requestId,
        });
        if (payload.nodeId !== videoNodeId || !payload.requestId) return;
        expect(
          useCanvasStore
            .getState()
            .nodes.find((node) => node.id === imageNodeId)?.data.imageUrl,
        ).toBe("/static/project/image.png");
        useCanvasStore
          .getState()
          .updateNodeData(videoNodeId, {
            videoUrl: "/static/project/video.mp4",
          });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: videoNodeId,
          action: "generate_video",
          status: "success",
        });
      },
    );

    try {
      const resultPromise = applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: videoNodeId,
                action: "generate_video",
              },
              {
                type: "run_node_action",
                node_id: imageNodeId,
                action: "generate_image",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events[0]).toMatchObject({
        nodeId: imageNodeId,
        action: "generate_image",
      });
      const imageRequestId = events[0]?.requestId;
      if (!imageRequestId) throw new Error("expected image request id");
      useCanvasStore
        .getState()
        .updateNodeData(imageNodeId, { imageUrl: "/static/project/image.png" });
      canvasEventBus.publish("freezone/node-action-result", {
        requestId: imageRequestId,
        nodeId: imageNodeId,
        action: "generate_image",
        status: "success",
      });

      await vi.waitFor(() => expect(events).toHaveLength(2));
      expect(events[1]).toMatchObject({
        nodeId: videoNodeId,
        action: "generate_video",
      });
      const result = await resultPromise;
      expect(result.errors).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("waits briefly for generated media fields after node action success", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "商品主图",
      },
    );
    const events: Array<{
      nodeId: string;
      action: string;
      requestId?: string;
    }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({
          nodeId: payload.nodeId,
          action: payload.action,
          requestId: payload.requestId,
        });
        if (!payload.requestId) return;
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
        setTimeout(() => {
          useCanvasStore.getState().updateNodeData(imageNodeId, {
            imageUrl: "/static/project/generated.png",
          });
        }, 20);
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: imageNodeId,
                action: "generate_image",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(result.commandResults[0]).toMatchObject({
        type: "run_node_action",
        status: "success",
        nodeId: imageNodeId,
        action: "generate_image",
      });
      expect(events).toEqual([
        expect.objectContaining({
          nodeId: imageNodeId,
          action: "generate_image",
        }),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("reports the node generation error instead of a missing-output fallback", async () => {
    const textNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      {
        content: "待生成内容",
        workflowCatalog: { recipeId: "video-creative-outline" },
      },
    );
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        if (!payload.requestId) return;
        useCanvasStore.getState().updateNodeData(textNodeId, {
          generationError: "上游文本模型请求超时",
        });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync([
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "run_node_action",
              node_id: textNodeId,
              action: "generate_text",
            },
          ],
        },
      ]);

      expect(result.errors).toEqual(["上游文本模型请求超时"]);
      expect(result.commandResults[0]).toMatchObject({
        type: "run_node_action",
        status: "error",
        nodeId: textNodeId,
        action: "generate_text",
        error: "上游文本模型请求超时",
      });
    } finally {
      unsubscribe();
    }
  });

  it("waits for a single Recipe text action when no async task was handed off", async () => {
    const textNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      {
        content: "待生成内容",
        workflowCatalog: { recipeId: "video-creative-outline" },
      },
    );
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        if (!payload.requestId) return;
        canvasEventBus.publish("freezone/node-action-accepted", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
        });
        setTimeout(() => {
          const content = "# 视频创意大纲";
          useCanvasStore.getState().updateNodeData(textNodeId, {
            content,
            workflowTextGenerated: true,
          });
          canvasEventBus.publish("freezone/node-action-result", {
            requestId: payload.requestId!,
            nodeId: payload.nodeId,
            action: payload.action,
            status: "success",
            output: { content },
          });
        }, 30);
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        [{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [{
            type: "run_node_action",
            node_id: textNodeId,
            action: "generate_text",
          }],
        }],
        {
          actionTimeoutMs: 200,
          actionResultFieldTimeoutMs: 10,
        },
      );

      expect(result.errors).toEqual([]);
      expect(result.commandResults[0]).toMatchObject({
        type: "run_node_action",
        status: "success",
        nodeId: textNodeId,
        action: "generate_text",
        output: { content: "# 视频创意大纲" },
      });
    } finally {
      unsubscribe();
    }
  });

  it.each([
    {
      nodeType: CANVAS_NODE_TYPES.video,
      action: "generate_video",
      delayedData: { videoUrl: "/static/project/generated.mp4" },
    },
    {
      nodeType: CANVAS_NODE_TYPES.audio,
      action: "generate_audio",
      delayedData: { audioUrl: "/static/project/generated.mp3" },
    },
    {
      nodeType: CANVAS_NODE_TYPES.script,
      action: "generate_story_script",
      delayedData: { scriptResult: { rows: [{ narration: "成片脚本" }] } },
    },
    {
      nodeType: CANVAS_NODE_TYPES.threeDWorld,
      action: "generate_3gs_world",
      delayedData: { plyUrl: "/static/project/world.ply" },
    },
  ])(
    "waits briefly for delayed $action output fields",
    async ({ nodeType, action, delayedData }) => {
      const store = useCanvasStore.getState();
      const nodeId = store.addNode(
        nodeType,
        { x: 0, y: 0 },
        {
          prompt: "生成内容",
          text: "生成内容",
        },
      );
      if (action === "generate_3gs_world") {
        const imageNodeId = store.addNode(
          CANVAS_NODE_TYPES.imageGen,
          { x: -360, y: 0 },
          {
            imageUrl: "/static/project/source.png",
          },
        );
        store.addEdge(imageNodeId, nodeId);
      }
      const unsubscribe = canvasEventBus.subscribe(
        "freezone/run-node-action",
        (payload) => {
          if (!payload.requestId) return;
          canvasEventBus.publish("freezone/node-action-result", {
            requestId: payload.requestId,
            nodeId: payload.nodeId,
            action: payload.action,
            status: "success",
          });
          setTimeout(() => {
            useCanvasStore.getState().updateNodeData(nodeId, delayedData);
          }, 20);
        },
      );

      try {
        const result = await applyCanvasChatCommandsAsync(
          extractCanvasChatCommandEnvelopes([
            {
              schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
              commands: [{ type: "run_node_action", node_id: nodeId, action }],
            },
          ]),
          { canvasId: "canvas-a", actionTimeoutMs: 100 },
        );

        expect(result.errors).toEqual([]);
        expect(result.commandResults[0]).toMatchObject({
          type: "run_node_action",
          status: "success",
          nodeId,
          action,
        });
      } finally {
        unsubscribe();
      }
    },
  );

  it("runs same-level image and video nodes in parallel when they only share a completed text source", async () => {
    const store = useCanvasStore.getState();
    const textNodeId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      {
        content: "广告脚本",
      },
    );
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 360, y: 0 },
      {
        prompt: "商品主图",
      },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 720, y: 0 },
      {
        prompt: "商品视频",
      },
    );
    store.addEdge(textNodeId, imageNodeId);
    store.addEdge(textNodeId, videoNodeId);

    const events: Array<{
      nodeId: string;
      action: string;
      executionMode?: string;
      requestId?: string;
    }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({
          nodeId: payload.nodeId,
          action: payload.action,
          executionMode: payload.executionMode,
          requestId: payload.requestId,
        });
      },
    );

    try {
      const resultPromise = applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: imageNodeId,
                action: "generate_image",
              },
              {
                type: "run_node_action",
                node_id: videoNodeId,
                action: "generate_video",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      await vi.waitFor(() => expect(events).toHaveLength(2));
      expect(events.map((event) => event.nodeId).sort()).toEqual(
        [imageNodeId, videoNodeId].sort(),
      );

      const imageRequestId = events.find(
        (event) => event.nodeId === imageNodeId,
      )?.requestId;
      if (!imageRequestId) throw new Error("expected image request id");
      useCanvasStore
        .getState()
        .updateNodeData(imageNodeId, { imageUrl: "/static/project/image.png" });
      canvasEventBus.publish("freezone/node-action-result", {
        requestId: imageRequestId,
        nodeId: imageNodeId,
        action: "generate_image",
        status: "success",
      });

      const videoRequestId = events.find(
        (event) => event.nodeId === videoNodeId,
      )?.requestId;
      if (!videoRequestId) throw new Error("expected video request id");
      useCanvasStore
        .getState()
        .updateNodeData(videoNodeId, { videoUrl: "/static/project/video.mp4" });
      canvasEventBus.publish("freezone/node-action-result", {
        requestId: videoRequestId,
        nodeId: videoNodeId,
        action: "generate_video",
        status: "success",
      });

      const result = await resultPromise;
      expect(result.errors).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("skips already completed nodes when running a workflow group", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "商品主图",
        imageUrl: "/static/project/existing-image.png",
      },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "商品视频",
      },
    );
    store.addEdge(imageNodeId, videoNodeId);
    const groupId = store.groupNodes([imageNodeId, videoNodeId], {
      label: "商品视频工作流",
    });
    if (!groupId) throw new Error("expected workflow group");

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        useCanvasStore
          .getState()
          .updateNodeData(payload.nodeId, {
            videoUrl: "/static/project/video.mp4",
          });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [{ type: "run_workflow", node_ids: [groupId] }],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: videoNodeId, action: "generate_video" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("ignores a duplicate workflow start while the same canvas run is active", async () => {
    const imageNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      { prompt: "雨夜首帧" },
    );
    const events: Array<{ nodeId: string; action: string; requestId?: string }> = [];
    const unsubscribe = canvasEventBus.subscribe("freezone/run-node-action", (payload) => {
      events.push(payload);
    });
    const envelope = extractCanvasChatCommandEnvelopes([{
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [{ type: "run_workflow", node_ids: [imageNodeId] }],
    }]);

    try {
      const firstRun = applyCanvasChatCommandsAsync(envelope, {
        canvasId: "canvas-duplicate-run",
        actionTimeoutMs: 1_000,
      });
      await vi.waitFor(() => expect(events).toHaveLength(1));

      const duplicateResult = await applyCanvasChatCommandsAsync(envelope, {
        canvasId: "canvas-duplicate-run",
        actionTimeoutMs: 1_000,
      });

      expect(events).toHaveLength(1);
      expect(duplicateResult.errors).toEqual([]);
      expect(duplicateResult.commandResults).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "run_workflow",
          status: "success",
          output: expect.objectContaining({ reason: "workflow_already_running" }),
        }),
      ]));

      const requestId = events[0]?.requestId;
      if (!requestId) throw new Error("expected workflow request id");
      useCanvasStore.getState().updateNodeData(imageNodeId, {
        imageUrl: "/static/project/rainy-night.png",
      });
      canvasEventBus.publish("freezone/node-action-result", {
        requestId,
        nodeId: imageNodeId,
        action: "generate_image",
        status: "success",
      });
      await firstRun;
    } finally {
      unsubscribe();
    }
  });

  it("serializes distinct workflow runs on the same canvas instead of discarding them", async () => {
    const firstNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      { prompt: "第一条工作流" },
    );
    const secondNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 360, y: 0 },
      { prompt: "第二条工作流" },
    );
    const events: Array<{ nodeId: string; action: string; requestId?: string }> = [];
    const unsubscribe = canvasEventBus.subscribe("freezone/run-node-action", (payload) => {
      events.push(payload);
    });

    try {
      const firstRun = applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [{ type: "run_workflow", node_ids: [firstNodeId] }],
        }]),
        { canvasId: "canvas-distinct-runs", actionTimeoutMs: 1_000 },
      );
      await vi.waitFor(() => expect(events).toHaveLength(1));

      const secondRun = applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [{ type: "run_workflow", node_ids: [secondNodeId] }],
        }]),
        { canvasId: "canvas-distinct-runs", actionTimeoutMs: 1_000 },
      );
      await Promise.resolve();
      expect(events).toHaveLength(1);

      const firstRequestId = events[0]?.requestId;
      if (!firstRequestId) throw new Error("expected first workflow request id");
      useCanvasStore.getState().updateNodeData(firstNodeId, {
        imageUrl: "/static/project/first.png",
      });
      canvasEventBus.publish("freezone/node-action-result", {
        requestId: firstRequestId,
        nodeId: firstNodeId,
        action: "generate_image",
        status: "success",
      });
      await firstRun;
      await vi.waitFor(() => expect(events).toHaveLength(2));

      const secondRequestId = events[1]?.requestId;
      if (!secondRequestId) throw new Error("expected second workflow request id");
      useCanvasStore.getState().updateNodeData(secondNodeId, {
        imageUrl: "/static/project/second.png",
      });
      canvasEventBus.publish("freezone/node-action-result", {
        requestId: secondRequestId,
        nodeId: secondNodeId,
        action: "generate_image",
        status: "success",
      });
      const secondResult = await secondRun;

      expect(events.map((event) => event.nodeId)).toEqual([firstNodeId, secondNodeId]);
      expect(secondResult.errors).toEqual([]);
      expect(secondResult.commandResults).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          output: expect.objectContaining({ reason: "workflow_already_running" }),
        }),
      ]));
    } finally {
      unsubscribe();
    }
  });

  it("rechecks completed outputs when a workflow reaches the action queue", async () => {
    const imageNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      { prompt: "排队中的首帧" },
    );
    const events: Array<{ nodeId: string; action: string; requestId?: string }> = [];
    const unsubscribe = canvasEventBus.subscribe("freezone/run-node-action", (payload) => {
      events.push(payload);
    });

    try {
      const directRun = applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [{
            type: "run_node_action",
            node_id: imageNodeId,
            action: "generate_image",
          }],
        }]),
        { canvasId: "canvas-late-skip", actionTimeoutMs: 1_000 },
      );
      await vi.waitFor(() => expect(events).toHaveLength(1));

      const queuedWorkflow = applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [{ type: "run_workflow", node_ids: [imageNodeId] }],
        }]),
        { canvasId: "canvas-late-skip", actionTimeoutMs: 1_000 },
      );

      const requestId = events[0]?.requestId;
      if (!requestId) throw new Error("expected direct action request id");
      useCanvasStore.getState().updateNodeData(imageNodeId, {
        imageUrl: "/static/project/completed-while-queued.png",
      });
      canvasEventBus.publish("freezone/node-action-result", {
        requestId,
        nodeId: imageNodeId,
        action: "generate_image",
        status: "success",
      });

      await directRun;
      const workflowResult = await queuedWorkflow;
      expect(events).toHaveLength(1);
      expect(workflowResult.errors).toEqual([]);
      expect(workflowResult.commandResults).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "run_node_action",
          status: "success",
          output: expect.objectContaining({ reason: "workflow_action_already_completed" }),
        }),
      ]));
    } finally {
      unsubscribe();
    }
  });

  it("runs the parent workflow when targeting its disconnected user input node", async () => {
    const store = useCanvasStore.getState();
    const inputNodeId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      {
        content: "用户需求",
        workflowCatalogRole: "user_input",
      },
    );
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 360, y: 0 },
      { prompt: "商品主图" },
    );
    const groupId = store.groupNodes([inputNodeId, imageNodeId], {
      label: "商品图工作流",
    });
    if (!groupId) throw new Error("expected workflow group");

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        store.updateNodeData(imageNodeId, { imageUrl: "/static/project/image.png" });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [{ type: "run_workflow", node_ids: [inputNodeId] }],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: imageNodeId, action: "generate_image" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("skips legacy Recipe-backed user requirement nodes when running a workflow", async () => {
    const store = useCanvasStore.getState();
    const inputNodeId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      {
        content: "用户已经提供的剧本事实",
        workflowCatalog: {
          recipeId: "general-text",
          stepId: "user_requirement",
        },
      },
    );
    const scriptNodeId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 360, y: 0 },
      {
        content: "生成8 Beat剧本",
        workflowCatalog: {
          recipeId: "general-text",
          stepId: "episode_script",
        },
      },
    );
    store.addEdge(inputNodeId, scriptNodeId);
    const groupId = store.groupNodes([inputNodeId, scriptNodeId], {
      label: "短剧工作流",
    });
    if (!groupId) throw new Error("expected workflow group");

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        store.updateNodeData(payload.nodeId, {
          content: "已生成的8 Beat剧本",
        });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
          output: { content: "已生成的8 Beat剧本" },
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [{ type: "run_workflow", node_ids: [inputNodeId] }],
        }]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([{ nodeId: scriptNodeId, action: "generate_text" }]);
    } finally {
      unsubscribe();
    }
  });

  it("persists workflow run progress without changing node execution", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      { prompt: "商品主图" },
    );
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        if (!payload.requestId) return;
        store.updateNodeData(payload.nodeId, { imageUrl: "/static/project/image.png" });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [{ type: "run_workflow", node_ids: [imageNodeId] }],
          },
        ]),
        {
          projectId: "project-a",
          canvasId: "canvas-a",
          actionTimeoutMs: 100,
        },
      );

      expect(result.errors).toEqual([]);
      expect(createFreezoneWorkflowRun).toHaveBeenCalledWith(
        "project-a",
        "canvas-a",
        [{ node_id: imageNodeId, action: "generate_image" }],
        expect.stringMatching(/^canvas-run:/),
        expect.stringMatching(/^canvas-runner:/),
      );
      expect(updateFreezoneWorkflowRun).toHaveBeenLastCalledWith(
        "project-a",
        "canvas-a",
        "run-test",
        expect.objectContaining({
          status: "completed",
          runner_id: expect.stringMatching(/^canvas-runner:/),
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it("does not start node actions when another runner owns the canvas lease", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      { prompt: "商品主图" },
    );
    const events: string[] = [];
    const unsubscribe = canvasEventBus.subscribe("freezone/run-node-action", (payload) => {
      events.push(payload.nodeId);
    });
    vi.mocked(createFreezoneWorkflowRun).mockRejectedValueOnce(
      new ApiError("another workflow runner is active on this canvas", 409),
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [{ type: "run_workflow", node_ids: [imageNodeId] }],
        }]),
        { projectId: "project-a", canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual(["当前画布已有工作流正在执行，请等待其完成后再试。"]);
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("associates a submitted generation task with its workflow action", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      { prompt: "商品主图" },
    );
    const unsubscribe = canvasEventBus.subscribe("freezone/run-node-action", (payload) => {
      if (!payload.requestId) return;
      canvasEventBus.publish("freezone/node-action-accepted", {
        requestId: payload.requestId,
        nodeId: payload.nodeId,
        action: payload.action,
      });
      store.updateNodeData(payload.nodeId, {
        isGenerating: true,
        generationTaskKey: "image_generation:node-one",
        generationTaskType: "image_generation",
        generationTaskJobId: "job-one",
      });
      window.setTimeout(() => {
        store.updateNodeData(payload.nodeId, {
          isGenerating: false,
          imageUrl: "/static/project/image.png",
        });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId!,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      }, 10);
    });

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [{ type: "run_workflow", node_ids: [imageNodeId] }],
        }]),
        { projectId: "project-a", canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(updateFreezoneWorkflowRun).toHaveBeenCalledWith(
        "project-a",
        "canvas-a",
        "run-test",
        expect.objectContaining({
          action_updates: [expect.objectContaining({
            node_id: imageNodeId,
            task_key: "image_generation:node-one",
            task_type: "image_generation",
            job_id: "job-one",
          })],
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it("finishes an action when the canvas result appears after its result event is lost", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      { prompt: "商品主图" },
    );
    const unsubscribe = canvasEventBus.subscribe("freezone/run-node-action", (payload) => {
      if (!payload.requestId) return;
      canvasEventBus.publish("freezone/node-action-accepted", {
        requestId: payload.requestId,
        nodeId: payload.nodeId,
        action: payload.action,
      });
      window.setTimeout(() => {
        store.updateNodeData(payload.nodeId, {
          isGenerating: false,
          imageUrl: "/static/project/recovered-image.png",
        });
        // Deliberately omit freezone/node-action-result. The visible canvas
        // result must be sufficient for the workflow runner to continue.
      }, 10);
    });

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [{ type: "run_workflow", node_ids: [imageNodeId] }],
        }]),
        { projectId: "project-a", canvasId: "canvas-a", actionTimeoutMs: 500 },
      );

      expect(result.errors).toEqual([]);
      expect(result.commandResults).toContainEqual(expect.objectContaining({
        nodeId: imageNodeId,
        action: "generate_image",
        status: "success",
      }));
      expect(updateFreezoneWorkflowRun).toHaveBeenLastCalledWith(
        "project-a",
        "canvas-a",
        "run-test",
        expect.objectContaining({ status: "completed" }),
      );
    } finally {
      unsubscribe();
    }
  });

  it("deduplicates node actions when a node action and workflow overlap", async () => {
    const store = useCanvasStore.getState();
    const textNodeId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      {
        content: "商品主图提示词",
      },
    );
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 360, y: 0 },
      {
        prompt: "商品主图",
      },
    );
    store.addEdge(textNodeId, imageNodeId);
    const groupId = store.groupNodes([textNodeId, imageNodeId], {
      label: "商品图片工作流",
    });
    if (!groupId) throw new Error("expected workflow group");

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        useCanvasStore
          .getState()
          .updateNodeData(payload.nodeId, {
            imageUrl: "/static/project/image.png",
          });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: imageNodeId,
                action: "generate_image",
              },
              { type: "run_workflow", node_ids: [groupId] },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: imageNodeId, action: "generate_image" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("reruns an explicit generation node action even when the node already has content", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "商品主图",
        imageUrl: "/static/project/existing-image.png",
      },
    );

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        useCanvasStore
          .getState()
          .updateNodeData(payload.nodeId, {
            imageUrl: "/static/project/regenerated-image.png",
          });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: imageNodeId,
                action: "generate_image",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: imageNodeId, action: "generate_image" },
      ]);
      expect(result.commandResults).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "节点已有内容，未重新生成",
          }),
        ]),
      );
    } finally {
      unsubscribe();
    }
  });

  it("regenerates a completed generation node when regeneration is explicit", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "商品主图",
        imageUrl: "/static/project/existing-image.png",
      },
    );

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        useCanvasStore
          .getState()
          .updateNodeData(payload.nodeId, {
            imageUrl: "/static/project/regenerated-image.png",
          });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: imageNodeId,
                action: "generate_image",
                parameters: { regenerate: true },
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: imageNodeId, action: "generate_image" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("invalidates and reruns only the affected downstream branch", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "主分支商品图",
        imageUrl: "/static/project/old-main.png",
      },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "主分支视频",
        videoUrl: "/static/project/old-main.mp4",
      },
    );
    const unrelatedImageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 360 },
      {
        prompt: "旁路商品图",
        imageUrl: "/static/project/old-side.png",
      },
    );
    const unrelatedVideoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 360 },
      {
        prompt: "旁路视频",
        videoUrl: "/static/project/old-side.mp4",
      },
    );
    store.addEdge(imageNodeId, videoNodeId);
    store.addEdge(unrelatedImageNodeId, unrelatedVideoNodeId);

    const events: Array<{ nodeId: string; action: string }> = [];
    let invalidationSnapshot: Record<string, unknown> | null = null;
    const unsubscribe = canvasEventBus.subscribe("freezone/run-node-action", (payload) => {
      events.push({ nodeId: payload.nodeId, action: payload.action });
      if (!invalidationSnapshot) {
        invalidationSnapshot = Object.fromEntries(
          useCanvasStore.getState().nodes.map((node) => [
            node.id,
            (node.data as Record<string, unknown>).workflowResultStale,
          ]),
        );
      }
      if (!payload.requestId) return;
      store.updateNodeData(
        payload.nodeId,
        payload.action === "generate_image"
          ? { imageUrl: "/static/project/new-main.png" }
          : { videoUrl: "/static/project/new-main.mp4" },
      );
      canvasEventBus.publish("freezone/node-action-result", {
        requestId: payload.requestId,
        nodeId: payload.nodeId,
        action: payload.action,
        status: "success",
      });
    });

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [{
            type: "run_workflow",
            node_ids: [imageNodeId],
            direction: "downstream",
            regenerate: true,
          }],
        }]),
        {
          projectId: "project-a",
          canvasId: "canvas-a",
          actionTimeoutMs: 100,
        },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: imageNodeId, action: "generate_image" },
        { nodeId: videoNodeId, action: "generate_video" },
      ]);
      expect(invalidationSnapshot).toMatchObject({
        [imageNodeId]: true,
        [videoNodeId]: true,
      });
      expect(invalidationSnapshot).not.toMatchObject({
        [unrelatedImageNodeId]: true,
        [unrelatedVideoNodeId]: true,
      });
      const latestById = new Map(
        useCanvasStore.getState().nodes.map((node) => [node.id, node.data]),
      );
      expect(latestById.get(imageNodeId)).toMatchObject({ workflowResultStale: false });
      expect(latestById.get(videoNodeId)).toMatchObject({ workflowResultStale: false });
      expect(latestById.get(unrelatedImageNodeId)).not.toMatchObject({
        workflowResultStale: true,
      });
      expect(latestById.get(unrelatedVideoNodeId)).not.toMatchObject({
        workflowResultStale: true,
      });
    } finally {
      unsubscribe();
    }
  });

  it("marks only existing results on the edited node and its downstream as stale", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "旧提示词",
        imageUrl: "/static/project/old-main.png",
      },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "主分支视频",
        videoUrl: "/static/project/old-main.mp4",
      },
    );
    const unrelatedNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 360 },
      {
        prompt: "旁路",
        imageUrl: "/static/project/side.png",
      },
    );
    store.addEdge(imageNodeId, videoNodeId);

    const result = await applyCanvasChatCommandsAsync(
      extractCanvasChatCommandEnvelopes([{
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [{
          type: "update_node_data",
          node_id: imageNodeId,
          data: { prompt: "新提示词" },
        }],
      }]),
      { projectId: "project-a", canvasId: "canvas-a" },
    );

    expect(result.errors).toEqual([]);
    const latestById = new Map(
      useCanvasStore.getState().nodes.map((node) => [node.id, node.data]),
    );
    expect(latestById.get(imageNodeId)).toMatchObject({
      workflowResultStale: true,
      workflowInvalidationReason: "node_input_changed",
    });
    expect(latestById.get(videoNodeId)).toMatchObject({
      workflowResultStale: true,
      workflowInvalidationReason: "upstream_input_changed",
    });
    expect(latestById.get(unrelatedNodeId)).not.toMatchObject({
      workflowResultStale: true,
    });
  });

  it("runs upstream workflow actions when run_workflow targets a terminal compose node", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "商品主图",
      },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "商品视频",
      },
    );
    const audioNodeId = store.addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 360, y: 260 },
      {
        text: "商品口播",
      },
    );
    const composeNodeId = store.addNode(
      CANVAS_NODE_TYPES.videoCompose,
      { x: 720, y: 0 },
      {
        title: "成片合成",
      },
    );
    store.addEdge(imageNodeId, videoNodeId);
    store.addEdge(videoNodeId, composeNodeId);
    store.addEdge(audioNodeId, composeNodeId);

    const events: Array<{
      nodeId: string;
      action: string;
      executionMode?: string;
      requestId?: string;
    }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({
          nodeId: payload.nodeId,
          action: payload.action,
          executionMode: payload.executionMode,
          requestId: payload.requestId,
        });
        if (!payload.requestId) return;
        if (payload.nodeId === imageNodeId) {
          useCanvasStore
            .getState()
            .updateNodeData(imageNodeId, {
              imageUrl: "/static/project/image.png",
            });
        }
        if (payload.nodeId === audioNodeId) {
          useCanvasStore
            .getState()
            .updateNodeData(audioNodeId, {
              audioUrl: "/static/project/audio.wav",
            });
        }
        if (payload.nodeId === videoNodeId) {
          expect(
            useCanvasStore
              .getState()
              .nodes.find((node) => node.id === imageNodeId)?.data.imageUrl,
          ).toBe("/static/project/image.png");
          useCanvasStore
            .getState()
            .updateNodeData(videoNodeId, {
              videoUrl: "/static/project/video.mp4",
            });
        }
        if (payload.nodeId === composeNodeId) {
          useCanvasStore.getState().updateNodeData(composeNodeId, {
            resultVideoUrl: "/static/project/final.mp4",
          });
        }
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
          output: payload.nodeId === composeNodeId
            ? { videoUrl: "/static/project/final.mp4" }
            : undefined,
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [{ type: "run_workflow", node_ids: [composeNodeId] }],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events.map((event) => event.nodeId)).toEqual([
        imageNodeId,
        audioNodeId,
        videoNodeId,
        composeNodeId,
      ]);
      expect(events.map((event) => event.executionMode)).toEqual([
        "workflow",
        "workflow",
        "workflow",
        "workflow",
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("runs downstream workflow actions when run_workflow targets a source text node", async () => {
    const store = useCanvasStore.getState();
    const sourceNodeId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      {
        content: "产品资料",
      },
    );
    const scriptNodeId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 360, y: 0 },
      {
        content: "广告脚本",
      },
    );
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 720, y: 0 },
      {
        prompt: "商品主图",
      },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 1080, y: 0 },
      {
        prompt: "商品视频",
      },
    );
    store.addEdge(sourceNodeId, scriptNodeId);
    store.addEdge(scriptNodeId, imageNodeId);
    store.addEdge(imageNodeId, videoNodeId);

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        if (payload.nodeId === imageNodeId) {
          useCanvasStore
            .getState()
            .updateNodeData(imageNodeId, {
              imageUrl: "/static/project/image.png",
            });
        }
        if (payload.nodeId === videoNodeId) {
          expect(
            useCanvasStore
              .getState()
              .nodes.find((node) => node.id === imageNodeId)?.data.imageUrl,
          ).toBe("/static/project/image.png");
          useCanvasStore
            .getState()
            .updateNodeData(videoNodeId, {
              videoUrl: "/static/project/video.mp4",
            });
        }
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [{ type: "run_workflow", node_ids: [sourceNodeId] }],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: imageNodeId, action: "generate_image" },
        { nodeId: videoNodeId, action: "generate_video" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("runs incomplete upstream workflow actions before direct downstream generation", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "商品主图",
      },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "商品视频",
      },
    );
    store.addEdge(imageNodeId, videoNodeId);

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        if (payload.nodeId === imageNodeId) {
          useCanvasStore
            .getState()
            .updateNodeData(imageNodeId, {
              imageUrl: "/static/project/image.png",
            });
        }
        if (payload.nodeId === videoNodeId) {
          expect(
            useCanvasStore
              .getState()
              .nodes.find((node) => node.id === imageNodeId)?.data.imageUrl,
          ).toBe("/static/project/image.png");
          useCanvasStore
            .getState()
            .updateNodeData(videoNodeId, {
              videoUrl: "/static/project/video.mp4",
            });
        }
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: videoNodeId,
                action: "generate_video",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: imageNodeId, action: "generate_image" },
        { nodeId: videoNodeId, action: "generate_video" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("runs incomplete upstream workflow actions before direct non-generation node actions", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "商品主图",
      },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "商品视频",
      },
    );
    const audioNodeId = store.addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 360, y: 260 },
      {
        text: "商品口播",
      },
    );
    const composeNodeId = store.addNode(
      CANVAS_NODE_TYPES.videoCompose,
      { x: 720, y: 0 },
      {
        title: "成片合成",
      },
    );
    store.addEdge(imageNodeId, videoNodeId);
    store.addEdge(videoNodeId, composeNodeId);
    store.addEdge(audioNodeId, composeNodeId);

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        if (payload.nodeId === imageNodeId) {
          useCanvasStore
            .getState()
            .updateNodeData(imageNodeId, {
              imageUrl: "/static/project/image.png",
            });
        }
        if (payload.nodeId === audioNodeId) {
          useCanvasStore
            .getState()
            .updateNodeData(audioNodeId, {
              audioUrl: "/static/project/audio.wav",
            });
        }
        if (payload.nodeId === videoNodeId) {
          expect(
            useCanvasStore
              .getState()
              .nodes.find((node) => node.id === imageNodeId)?.data.imageUrl,
          ).toBe("/static/project/image.png");
          useCanvasStore
            .getState()
            .updateNodeData(videoNodeId, {
              videoUrl: "/static/project/video.mp4",
            });
        }
        if (payload.nodeId === composeNodeId) {
          expect(
            useCanvasStore
              .getState()
              .nodes.find((node) => node.id === videoNodeId)?.data.videoUrl,
          ).toBe("/static/project/video.mp4");
          expect(
            useCanvasStore
              .getState()
              .nodes.find((node) => node.id === audioNodeId)?.data.audioUrl,
          ).toBe("/static/project/audio.wav");
        }
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: composeNodeId,
                action: "open_video_compose_modal",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: imageNodeId, action: "generate_image" },
        { nodeId: audioNodeId, action: "generate_audio" },
        { nodeId: videoNodeId, action: "generate_video" },
        { nodeId: composeNodeId, action: "open_video_compose_modal" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("opens video compose directly when minimum upstream media is already complete", async () => {
    const store = useCanvasStore.getState();
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "商品视频",
        videoUrl: "/static/project/video.mp4",
      },
    );
    const audioNodeId = store.addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 360, y: 260 },
      {
        text: "商品口播",
        audioUrl: "/static/project/audio.wav",
      },
    );
    const extraAudioNodeId = store.addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 360, y: 520 },
      {
        text: "未使用的备用口播",
      },
    );
    const composeNodeId = store.addNode(
      CANVAS_NODE_TYPES.videoCompose,
      { x: 720, y: 0 },
      {
        title: "成片合成",
      },
    );
    store.addEdge(videoNodeId, composeNodeId);
    store.addEdge(audioNodeId, composeNodeId);
    store.addEdge(extraAudioNodeId, composeNodeId);

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: composeNodeId,
                action: "open_video_compose_modal",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: composeNodeId, action: "open_video_compose_modal" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("does not hang when video compose open action does not report a node action result", async () => {
    const store = useCanvasStore.getState();
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "商品视频",
        videoUrl: "/static/project/video.mp4",
      },
    );
    const audioNodeId = store.addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 360, y: 260 },
      {
        text: "商品口播",
        audioUrl: "/static/project/audio.wav",
      },
    );
    const composeNodeId = store.addNode(
      CANVAS_NODE_TYPES.videoCompose,
      { x: 720, y: 0 },
      {
        title: "成片合成",
      },
    );
    store.addEdge(videoNodeId, composeNodeId);
    store.addEdge(audioNodeId, composeNodeId);

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_node_action",
                node_id: composeNodeId,
                action: "open_video_compose_modal",
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(result.openedUiActions).toBe(1);
      expect(events).toEqual([
        { nodeId: composeNodeId, action: "open_video_compose_modal" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("run_workflow automatically composes without regenerating extra upstream audio", async () => {
    const store = useCanvasStore.getState();
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "商品视频",
        videoUrl: "/static/project/video.mp4",
      },
    );
    const audioNodeId = store.addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 360, y: 260 },
      {
        text: "商品口播",
        audioUrl: "/static/project/audio.wav",
      },
    );
    const extraAudioNodeId = store.addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 360, y: 520 },
      {
        text: "不应重新生成的备用口播",
      },
    );
    const composeNodeId = store.addNode(
      CANVAS_NODE_TYPES.videoCompose,
      { x: 720, y: 0 },
      {
        title: "成片合成",
      },
    );
    store.addEdge(videoNodeId, composeNodeId);
    store.addEdge(audioNodeId, composeNodeId);
    store.addEdge(extraAudioNodeId, composeNodeId);

    const groupId = store.groupNodes(
      [videoNodeId, audioNodeId, extraAudioNodeId, composeNodeId],
      {
        label: "成片工作流",
      },
    );
    if (!groupId) throw new Error("expected workflow group");

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        useCanvasStore.getState().updateNodeData(composeNodeId, {
          resultVideoUrl: "/static/project/final.mp4",
        });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
          output: { videoUrl: "/static/project/final.mp4" },
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [{ type: "run_workflow", node_ids: [groupId] }],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: composeNodeId, action: "auto_compose_video" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("skips a legacy final-compose video generator and runs the real compose node", async () => {
    const store = useCanvasStore.getState();
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "商品镜头",
        videoUrl: "/static/project/video.mp4",
      },
    );
    const audioNodeId = store.addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 360, y: 260 },
      {
        text: "商品口播",
        audioUrl: "/static/project/audio.wav",
      },
    );
    const legacyComposeGeneratorId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 720, y: 0 },
      {
        displayName: "最终合成",
        prompt: "合成全部镜头",
        genMode: "allReference",
        workflowCatalog: { stepId: "final-compose" },
      },
    );
    const composeNodeId = store.addNode(
      CANVAS_NODE_TYPES.videoCompose,
      { x: 1080, y: 0 },
      {
        title: "成片合成",
      },
    );
    store.addEdge(videoNodeId, legacyComposeGeneratorId);
    store.addEdge(videoNodeId, composeNodeId);
    store.addEdge(audioNodeId, composeNodeId);
    store.addEdge(legacyComposeGeneratorId, composeNodeId);

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId || payload.nodeId !== composeNodeId) return;
        useCanvasStore.getState().updateNodeData(composeNodeId, {
          resultVideoUrl: "/static/project/final.mp4",
        });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
          output: { videoUrl: "/static/project/final.mp4" },
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [{
              type: "run_workflow",
              node_ids: [legacyComposeGeneratorId],
              direction: "connected",
            }],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: composeNodeId, action: "auto_compose_video" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("runs explicitly requested missing audio before an already satisfiable compose node", async () => {
    const store = useCanvasStore.getState();
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "商品视频",
        videoUrl: "/static/project/video.mp4",
      },
    );
    const existingAudioNodeId = store.addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 360, y: 260 },
      {
        text: "已有口播",
        audioUrl: "/static/project/existing-audio.wav",
      },
    );
    const missingAudioNodeId = store.addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 360, y: 520 },
      {
        text: "需要生成的旁白",
      },
    );
    const composeNodeId = store.addNode(
      CANVAS_NODE_TYPES.videoCompose,
      { x: 720, y: 0 },
      {
        title: "成片合成",
      },
    );
    store.addEdge(videoNodeId, composeNodeId);
    store.addEdge(existingAudioNodeId, composeNodeId);
    store.addEdge(missingAudioNodeId, composeNodeId);

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        if (payload.nodeId === missingAudioNodeId) {
          useCanvasStore.getState().updateNodeData(missingAudioNodeId, {
            audioUrl: "/static/project/generated-audio.wav",
          });
          canvasEventBus.publish("freezone/node-action-result", {
            requestId: payload.requestId,
            nodeId: payload.nodeId,
            action: payload.action,
            status: "success",
            output: { audioUrl: "/static/project/generated-audio.wav" },
          });
          return;
        }
        useCanvasStore.getState().updateNodeData(composeNodeId, {
          resultVideoUrl: "/static/project/final.mp4",
        });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
          output: { videoUrl: "/static/project/final.mp4" },
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [{
              type: "run_workflow",
              node_ids: [missingAudioNodeId],
              direction: "connected",
            }],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: missingAudioNodeId, action: "generate_audio" },
        { nodeId: composeNodeId, action: "auto_compose_video" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("run_workflow on an upstream group automatically runs downstream compose", async () => {
    const store = useCanvasStore.getState();
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "商品视频",
        videoUrl: "/static/project/video.mp4",
      },
    );
    const audioNodeId = store.addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 360, y: 260 },
      {
        text: "商品口播",
        audioUrl: "/static/project/audio.wav",
      },
    );
    const extraAudioNodeId = store.addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 360, y: 520 },
      {
        text: "不应重新生成的备用口播",
      },
    );
    const groupId = store.groupNodes(
      [videoNodeId, audioNodeId, extraAudioNodeId],
      {
        label: "成片前置组",
      },
    );
    if (!groupId) throw new Error("expected workflow group");
    const composeNodeId = store.addNode(
      CANVAS_NODE_TYPES.videoCompose,
      { x: 720, y: 0 },
      {
        title: "成片合成",
      },
    );
    store.addEdge(videoNodeId, composeNodeId);
    store.addEdge(audioNodeId, composeNodeId);
    store.addEdge(extraAudioNodeId, composeNodeId);

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        useCanvasStore.getState().updateNodeData(composeNodeId, {
          resultVideoUrl: "/static/project/final.mp4",
        });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
          output: { videoUrl: "/static/project/final.mp4" },
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [{ type: "run_workflow", node_ids: [groupId] }],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: composeNodeId, action: "auto_compose_video" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("run_workflow on a group does not count unselected outside audio for video compose", async () => {
    const store = useCanvasStore.getState();
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "商品视频",
        videoUrl: "/static/project/video.mp4",
      },
    );
    const outsideAudioNodeId = store.addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 360, y: 260 },
      {
        text: "组外口播",
        audioUrl: "/static/project/outside-audio.wav",
      },
    );
    const textNodeId = store.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 },
      {
        content: "组选中的说明文本",
      },
    );
    const groupId = store.groupNodes([textNodeId, videoNodeId], {
      label: "只选中的视频组",
    });
    if (!groupId) throw new Error("expected workflow group");
    const composeNodeId = store.addNode(
      CANVAS_NODE_TYPES.videoCompose,
      { x: 720, y: 0 },
      {
        title: "成片合成",
      },
    );
    store.addEdge(videoNodeId, composeNodeId);
    store.addEdge(outsideAudioNodeId, composeNodeId);

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [{ type: "run_workflow", node_ids: [groupId] }],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([]);
      expect(
        result.commandResults.some((step) => step.label === "工作流已完成，未重新生成"),
      ).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("treats a fully completed workflow group as a no-op success", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "商品主图",
        imageUrl: "/static/project/existing-image.png",
      },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "商品视频",
        videoUrl: "/static/project/existing-video.mp4",
      },
    );
    store.addEdge(imageNodeId, videoNodeId);
    const groupId = store.groupNodes([imageNodeId, videoNodeId], {
      label: "商品视频工作流",
    });
    if (!groupId) throw new Error("expected workflow group");

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [{ type: "run_workflow", node_ids: [groupId] }],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([]);
      expect(
        result.commandResults.some((step) => step.label === "工作流已完成，未重新生成"),
      ).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("regenerates a completed workflow group when regeneration is explicit", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "商品主图",
        imageUrl: "/static/project/existing-image.png",
      },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "商品视频",
        videoUrl: "/static/project/existing-video.mp4",
      },
    );
    store.addEdge(imageNodeId, videoNodeId);
    const groupId = store.groupNodes([imageNodeId, videoNodeId], {
      label: "商品视频工作流",
    });
    if (!groupId) throw new Error("expected workflow group");

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        useCanvasStore
          .getState()
          .updateNodeData(payload.nodeId, {
            ...(payload.action === "generate_image"
              ? { imageUrl: "/static/project/regenerated-image.png" }
              : {}),
            ...(payload.action === "generate_video"
              ? { videoUrl: "/static/project/regenerated-video.mp4" }
              : {}),
          });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [{ type: "run_workflow", node_ids: [groupId], regenerate: true }],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: imageNodeId, action: "generate_image" },
        { nodeId: videoNodeId, action: "generate_video" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("runs a referenced workflow group by expanding nodes and following canvas edge order", async () => {
    const store = useCanvasStore.getState();
    const imageNodeId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "女主站在雨夜街头",
      },
    );
    const videoNodeId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 360, y: 0 },
      {
        prompt: "雨夜街头镜头推进",
      },
    );
    store.addEdge(imageNodeId, videoNodeId);
    const groupId = store.groupNodes([imageNodeId, videoNodeId], {
      label: "短剧工作流",
    });
    if (!groupId) throw new Error("expected workflow group to be created");

    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push({ nodeId: payload.nodeId, action: payload.action });
        if (!payload.requestId) return;
        useCanvasStore.getState().updateNodeData(payload.nodeId, {
          ...(payload.action === "generate_image"
            ? { imageUrl: "/static/project/image.png" }
            : {}),
          ...(payload.action === "generate_video"
            ? { videoUrl: "/static/project/video.mp4" }
            : {}),
        });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [
              {
                type: "run_workflow",
                node_ids: [groupId],
              },
            ],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([
        { nodeId: imageNodeId, action: "generate_image" },
        { nodeId: videoNodeId, action: "generate_video" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("runs selected workflow nodes when run_workflow uses selection scope", async () => {
    const store = useCanvasStore.getState();
    const firstImageId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        prompt: "第一张",
      },
    );
    const secondImageId = store.addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 360, y: 0 },
      {
        prompt: "第二张",
      },
    );
    store.onNodesChange([
      { id: firstImageId, type: "select", selected: true },
      { id: secondImageId, type: "select", selected: true },
    ]);

    const events: string[] = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push(payload.nodeId);
        if (!payload.requestId) return;
        useCanvasStore
          .getState()
          .updateNodeData(payload.nodeId, {
            imageUrl: `/static/${payload.nodeId}.png`,
          });
        canvasEventBus.publish("freezone/node-action-result", {
          requestId: payload.requestId,
          nodeId: payload.nodeId,
          action: payload.action,
          status: "success",
        });
      },
    );

    try {
      const result = await applyCanvasChatCommandsAsync(
        extractCanvasChatCommandEnvelopes([
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [{ type: "run_workflow", scope: "selection" }],
          },
        ]),
        { canvasId: "canvas-a", actionTimeoutMs: 100 },
      );

      expect(result.errors).toEqual([]);
      expect(events).toEqual([firstImageId, secondImageId]);
    } finally {
      unsubscribe();
    }
  });

  it("runs image toolbar actions through the canvas event bus", async () => {
    const nodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        imageUrl: "/static/project/image.png",
        prompt: "猫吃鱼",
      },
    );
    const events: Array<{ nodeId: string; action: string }> = [];
    const unsubscribe = canvasEventBus.subscribe(
      "freezone/run-node-action",
      (payload) => {
        events.push(payload);
      },
    );

    try {
      const envelopes = extractCanvasChatCommandEnvelopes([
        {
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          commands: [
            {
              type: "run_node_action",
              node_id: nodeId,
              action: "run_grid_product_three_view",
            },
            {
              type: "run_node_action",
              node_id: nodeId,
              action: "open_split_storyboard_tool",
            },
          ],
        },
      ]);

      const result = applyCanvasChatCommands(envelopes);

      expect(result.errors).toEqual([]);
      expect(result.openedUiActions).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual([
        {
          nodeId,
          action: "run_grid_product_three_view",
          executionMode: "single",
        },
        {
          nodeId,
          action: "open_split_storyboard_tool",
          executionMode: "single",
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("provides standalone canvas command context without node references", () => {
    const context = buildCanvasChatCommandContext();

    expect(context).toContain("[SUPERTALE_CANVAS_CHAT_COMMANDS]");
    expect(context).toContain("FREEZONE_CANVAS_ASSISTANT contract");
    expect(context).toContain("read-only grounding");
    expect(context).toContain("Request only the missing catalog");
    expect(context).not.toContain("return ONLY a fenced JSON block");
    expect(context).not.toContain("Otherwise write the JSON envelope directly");
    expect(context).not.toContain(
      'return a JSON block with schema_version="canvas_chat_commands.v1"',
    );
    expect(context).not.toContain("freezone_get_link_type_catalog");
    expect(context).not.toContain("freezone_validate_canvas_commands");
    expect(context.length).toBeLessThan(700);
    expect(context).not.toContain("videoComposeNode");
  });

  it("parses audio download as a runnable node action", () => {
    const nodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.audio,
      { x: 0, y: 0 },
      {
        audioUrl: "/static/project/audio.wav",
      },
    );
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "run_node_action",
            node_id: nodeId,
            action: "download_audio",
          },
        ],
      },
    ]);

    expect(envelopes).toEqual([
      expect.objectContaining({
        commands: [
          expect.objectContaining({
            type: "run_node_action",
            node_id: nodeId,
            action: "download_audio",
          }),
        ],
      }),
    ]);
  });

  it("parses image download as a runnable node action", () => {
    const nodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageGen,
      { x: 0, y: 0 },
      {
        imageUrl: "/static/project/image.png",
      },
    );
    const envelopes = extractCanvasChatCommandEnvelopes([
      {
        schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
        commands: [
          {
            type: "run_node_action",
            node_id: nodeId,
            action: "download_image",
          },
        ],
      },
    ]);

    expect(envelopes).toEqual([
      expect.objectContaining({
        commands: [
          expect.objectContaining({
            type: "run_node_action",
            node_id: nodeId,
            action: "download_image",
          }),
        ],
      }),
    ]);
  });
});
