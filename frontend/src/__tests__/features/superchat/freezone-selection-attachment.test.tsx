import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildCanvasOntologyContext } from "@/features/canvas/ontology/canvasOntology";
import { SuperChatPanel } from "@/features/superchat/superchat-panel";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";
import {
  buildCanvasNodeReferenceAttachment,
  canvasNodeReferenceAttachmentNodes,
  isCanvasNodeReferenceAttachment,
} from "@/features/freezone/chatNodeReferences";
import type { ChatAttachment, ChatMessage } from "@/features/superchat/types";
import { useCanvasStore } from "@/stores/canvasStore";

const superChatMocks = vi.hoisted(() => ({
  send: vi.fn(async () => true),
  appendNotification: vi.fn(async () => undefined),
  messages: [] as ChatMessage[],
  busy: false,
  showToolEvents: false,
}));

const eventBusMocks = vi.hoisted(() => ({
  on: vi.fn(() => vi.fn()),
}));

const apiMocks = vi.hoisted(() => ({
  post: vi.fn(() => ({ catch: vi.fn() })),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      const translations: Record<string, string> = {
        "aiAssistant.placeholder": "写下灵感、剧情或任务，虾导来接住",
        "aiAssistant.freezonePlaceholder": "想画什么、改哪里，直接告诉虾画",
        "aiAssistant.canvasReferenceOnlyPrompt": "请基于当前选中的画布节点继续。",
        "aiAssistant.send": "发送",
        "aiAssistant.queuedCount": "待发送 {{count}} 条",
        "freezone.chat.currentSelection": "当前选中",
        "freezone.chat.usedThisTurn": "本轮会使用",
        "freezone.chat.canvasCommandsCancelled": "已取消画布操作",
      };
      return (translations[key] ?? key).replace("{{count}}", String(options?.count ?? ""));
    },
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ project: "project-a" }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@/task-center/event-bus-context", () => ({
  useEventBus: () => ({
    on: eventBusMocks.on,
  }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    post: apiMocks.post,
  },
}));

vi.mock("@/api/projects", () => ({
  listCharacters: vi.fn(async () => []),
  listFreezoneProjectAssets: vi.fn(async () => []),
}));

vi.mock("border-beam-vanilla", () => ({
  attachBorderBeam: () => ({ destroy: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("dramaclaw-spec-render", () => ({
  SpecRenderer: () => null,
  SpecRendererProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  VideoDetailModal: () => null,
}));

vi.mock("@/features/superchat/use-superchat", () => ({
  SUPERCHAT_CANVAS_COMMAND_EVENT: "superchat/canvas-command",
  SUPERCHAT_CANVAS_CONTEXT_REQUEST_EVENT: "superchat/canvas-context-request",
  useSuperChat: () => ({
    abort: vi.fn(),
    approvals: [],
    activeTurnId: null,
    busy: superChatMocks.busy,
    connected: true,
    connecting: false,
    error: null,
    activeModel: null,
    clearPinned: vi.fn(),
    deleteMessage: vi.fn(),
    deletedIds: new Set<string>(),
    historyHasMore: false,
    historyLoadingOlder: false,
    historyReady: true,
    loadOlderHistory: vi.fn(),
    messages: superChatMocks.messages,
    models: [],
    modelsLoading: false,
    requestHistory: vi.fn(),
    refreshModels: vi.fn(),
    refreshRelayInstances: vi.fn(),
    relayInstances: [],
    resolveApproval: vi.fn(),
    selectRelayInstance: vi.fn(),
    appendNotification: superChatMocks.appendNotification,
    send: superChatMocks.send,
    selectedInstanceId: "",
    sessionControl: vi.fn(),
    setSettings: vi.fn(),
    settings: {
      showToolEvents: superChatMocks.showToolEvents,
      showStructuredSourceWhileStreaming: false,
      uploadTarget: "openclaw",
    },
    pinnedIds: new Set<string>(),
    streamText: "",
    switchModel: vi.fn(),
    togglePin: vi.fn(),
    upsertAssistantMessagePart: vi.fn(),
    removeAssistantMessagePart: vi.fn(),
  }),
}));

describe("SuperChatPanel Freezone selection attachment state", () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => true),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    superChatMocks.send.mockClear();
    superChatMocks.appendNotification.mockClear();
    superChatMocks.messages = [];
    superChatMocks.busy = false;
    superChatMocks.showToolEvents = false;
    eventBusMocks.on.mockClear();
    apiMocks.post.mockClear();
    useCanvasStore.getState().setCanvasData([], []);
    useCanvasStore.getState().setSelectedNode(null);
  });

  it("uses the dedicated Xia Draw placeholder in freezone mode", () => {
    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.getByPlaceholderText("想画什么、改哪里，直接告诉虾画")).toBeInTheDocument();
  });

  it("renders Freezone-only header actions when provided", () => {
    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
        freezoneHeaderActions={<button type="button">历史 Agent</button>}
      />,
    );

    expect(screen.getByRole("button", { name: "历史 Agent" })).toBeInTheDocument();
  });

  it("does not append global task completion notifications in freezone mode", async () => {
    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(eventBusMocks.on).not.toHaveBeenCalledWith("*", expect.any(Function));
    expect(superChatMocks.appendNotification).not.toHaveBeenCalled();
  });

  it("does not show a selected canvas node as current-turn context after its attachment was consumed", () => {
    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[
          {
            nodeId: "image-node-1",
            nodeType: "imageNode",
            label: "图片节点",
          },
        ]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.queryByText("本轮会使用")).not.toBeInTheDocument();
    expect(screen.queryByText("图片节点")).not.toBeInTheDocument();
  });

  it("lets the user remove a selected canvas node from current-turn context", () => {
    const node = {
      id: "image-node-1",
      type: "imageNode",
      position: { x: 0, y: 0 },
      selected: true,
      data: {
        title: "图片节点",
      },
    } satisfies Partial<CanvasNode> as CanvasNode;

    useCanvasStore.getState().setCanvasData([node], []);
    useCanvasStore.getState().setSelectedNode(node.id);

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [node.id],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.getByText("本轮会使用")).toBeInTheDocument();

    const removeButton = screen.getByLabelText("移除画布引用");
    expect(removeButton).toHaveClass("opacity-0");
    expect(removeButton).toHaveClass("group-hover:opacity-100");

    fireEvent.click(removeButton);

    expect(screen.queryByText("本轮会使用")).not.toBeInTheDocument();
    expect(useCanvasStore.getState().nodes[0]?.selected).toBe(false);
    expect(useCanvasStore.getState().selectedNodeId).toBeNull();
  });

  it("lets the user remove all selected canvas nodes from current-turn context", () => {
    const nodes = [
      {
        id: "image-node-1",
        type: "imageNode",
        position: { x: 0, y: 0 },
        selected: true,
        data: { title: "图片节点 A" },
      },
      {
        id: "image-node-2",
        type: "imageNode",
        position: { x: 220, y: 0 },
        selected: true,
        data: { title: "图片节点 B" },
      },
    ] satisfies Partial<CanvasNode>[] as CanvasNode[];

    useCanvasStore.getState().setCanvasData(nodes, []);
    useCanvasStore.getState().setSelectedNode(nodes[0].id);

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: nodes.map((node) => node.id),
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.getByText("本轮会使用")).toBeInTheDocument();
    expect(screen.getByText("全部取消")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("取消全部画布引用"));

    expect(screen.queryByText("本轮会使用")).not.toBeInTheDocument();
    expect(useCanvasStore.getState().nodes.every((node) => !node.selected)).toBe(true);
    expect(useCanvasStore.getState().selectedNodeId).toBeNull();
  });

  it("does not duplicate canvas references between attachments and current selection", async () => {
    const node = {
      id: "image-node-1",
      type: "imageNode",
      position: { x: 0, y: 0 },
      selected: true,
      data: {
        displayName: "图片节点",
      },
    } satisfies Partial<CanvasNode> as CanvasNode;
    const attachment = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      [node],
      [],
      [node],
      { displayNodes: [node] },
    );
    expect(attachment).not.toBeNull();

    useCanvasStore.getState().setCanvasData([node], []);
    useCanvasStore.getState().setSelectedNode(node.id);

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([node], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [node.id],
        })}
        pendingAttachments={[attachment as ChatAttachment]}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getAllByRole("button", { name: /图片节点 · image-node-1/ })).toHaveLength(1);
    expect(screen.getAllByLabelText("移除画布引用")).toHaveLength(1);
    expect(screen.getByText("本轮会使用")).toBeInTheDocument();
  });

  it("sends selected canvas nodes as canvas reference attachments", async () => {
    const node = {
      id: "image-node-1",
      type: "imageNode",
      position: { x: 0, y: 0 },
      selected: true,
      data: {
        title: "图片节点",
        imageUrl: "https://example.test/image.png",
      },
    } satisfies Partial<CanvasNode> as CanvasNode;

    useCanvasStore.getState().setCanvasData([node], []);
    useCanvasStore.getState().setSelectedNode(node.id);

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([node], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [node.id],
        })}
        pendingAttachments={[]}
      />,
    );

    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => expect(superChatMocks.send).toHaveBeenCalledTimes(1));

    const [text, attachments, transportText] = superChatMocks.send.mock.calls[0] as unknown as [
      string,
      ChatAttachment[],
      string,
    ];
    expect(text).toBe("请基于当前选中的画布节点继续。");
    expect(attachments).toHaveLength(1);
    expect(isCanvasNodeReferenceAttachment(attachments[0])).toBe(true);
    expect(canvasNodeReferenceAttachmentNodes(attachments[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: node.id,
      }),
    ]));
    expect(transportText).toContain("[SUPERTALE_CANVAS_NODE_REFERENCES]");
    expect(useCanvasStore.getState().nodes[0]?.selected).toBe(false);
  });

  it("renders sent canvas references as node cards instead of ordinary attachment chips", () => {
    const node = {
      id: "image-node-1",
      type: "imageNode",
      position: { x: 0, y: 0 },
      selected: false,
      data: {
        imageUrl: "https://example.test/image.png",
      },
    } satisfies Partial<CanvasNode> as CanvasNode;
    const attachment = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      [node],
      [],
      [node],
      { displayNodes: [node] },
    );
    expect(attachment).not.toBeNull();
    superChatMocks.messages = [
      {
        id: "message-a",
        role: "user",
        text: "你好",
        displayName: "User",
        timestamp: Date.now(),
        attachments: [attachment as ChatAttachment],
      },
    ];
    useCanvasStore.getState().setCanvasData([node], []);

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([node], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.getByTitle(/image-node-1/)).toHaveClass("group/canvas-ref");
  });

  it("clears local queued messages when switching freezone canvas scope", () => {
    superChatMocks.busy = true;
    const { rerender } = render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    const input = screen.getByPlaceholderText("想画什么、改哪里，直接告诉虾画");
    fireEvent.change(input, { target: { value: "帮我加个视频节点" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("待发送 1 条")).toBeInTheDocument();

    rerender(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-b"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-b",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.queryByText("待发送 1 条")).not.toBeInTheDocument();
    expect(superChatMocks.send).not.toHaveBeenCalled();
  });

  it("does not submit when Enter confirms an IME composition candidate", () => {
    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    const input = screen.getByPlaceholderText("想画什么、改哪里，直接告诉虾画");
    fireEvent.change(input, { target: { value: "查看下当前画布summary 然后返回ok" } });
    fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
      keyCode: 229,
      nativeEvent: { isComposing: true, keyCode: 229 },
    });

    expect(superChatMocks.send).not.toHaveBeenCalled();
  });

  it("reveals user message actions below the bubble and copies with the legacy clipboard fallback", () => {
    superChatMocks.messages = [
      {
        id: "message-a",
        role: "user",
        text: "你好",
        displayName: "User",
        timestamp: Date.now(),
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    const copyButton = screen.getByLabelText("Copy");
    expect(copyButton.parentElement).toHaveClass("absolute");
    expect(copyButton.parentElement).toHaveClass("bottom-2");
    expect(copyButton.parentElement).toHaveClass("right-0");
    expect(copyButton.parentElement?.parentElement).toHaveClass("hover:pb-10");

    fireEvent.click(copyButton);

    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("resolves frontend canvas context requests and shows activity status", async () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "我来检查当前画布状态：",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("superchat/canvas-context-request", {
        detail: {
          bridge_key: "bridge-a",
          canvas_id: "canvas-a",
          turn_id: "turn-a",
          envelope: {
            schema_version: "canvas_context_request.v1",
            requests: [{ type: "canvas_ontology" }],
          },
        },
      }));
    });

    expect(await screen.findByText("正在读取画布 Ontology")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-context-tool-result", {
        detail: {
          type: "canvas.context.result",
          turn_id: "turn-a",
          bridge_key: "bridge-a",
          project_id: "project-a",
          canvas_id: "canvas-a",
          tool_call_status: "completed",
          canvas_context_status: "resolved",
          ok: true,
          responses: [{ type: "canvas_ontology", data: {} }],
          errors: [],
          message: "Frontend returned requested canvas context.",
        },
      }));
    });

    await waitFor(() => expect(screen.getByText("已读取画布 Ontology")).toBeInTheDocument());
  });

  it("persists and reports approved canvas command results", async () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "准备创建节点",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-context-activity", {
        detail: {
          type: "canvas.context.activity",
          turn_id: "turn-a",
          bridge_key: "validation-a",
          canvas_id: "canvas-a",
          status: "done",
          labels: ["命令校验"],
          errors: [],
          received_at: 1,
          surface_order: 1,
        },
      }));
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-a",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "create_node",
                  node_type: "imageGenNode",
                  data: { prompt: "test image" },
                },
              ],
            },
          ],
          receivedAt: Date.now(),
        },
      }));
    });

    expect(screen.getByText("待确认的画布操作")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("api/v1/chat/canvas-command-tool-result", expect.objectContaining({
        json: expect.objectContaining({
          bridge_key: "bridge-a",
          turn_id: "turn-a",
          canvas_id: "canvas-a",
          canvas_apply_status: "applied",
        }),
      })),
    );
    expect(apiMocks.post).toHaveBeenCalledWith("api/v1/chat/ui-events", expect.objectContaining({
      json: expect.objectContaining({
        turn_id: "turn-a",
        event: expect.objectContaining({
          type: "canvas_command_result",
          bridge_key: "bridge-a",
        }),
      }),
    }));
  });

  it("lets image generation approvals edit node image parameters before applying", async () => {
    const node = {
      id: "image-node-1",
      type: "imageGenNode",
      position: { x: 0, y: 0 },
      selected: false,
      data: {
        prompt: "test image",
        model: "existing-model",
        aspectRatio: "16:9",
        size: "1K",
        quality: "medium",
        count: 1,
      },
    } satisfies Partial<CanvasNode> as CanvasNode;
    useCanvasStore.getState().setCanvasData([node], []);
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "准备生成图片",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([node], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-image",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "run_node_action",
                  node_id: node.id,
                  action: "generate_image",
                },
              ],
            },
          ],
          receivedAt: Date.now(),
        },
      }));
    });

    expect(await screen.findByLabelText("图片模型")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("图片比例"), { target: { value: "9:16" } });
    fireEvent.change(screen.getByLabelText("图片分辨率"), { target: { value: "2K" } });
    fireEvent.change(screen.getByLabelText("图片画质"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("图片数量"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("api/v1/chat/ui-events", expect.objectContaining({
        json: expect.objectContaining({
          turn_id: "turn-a",
          event: expect.objectContaining({
            type: "canvas_command_result",
            bridge_key: "bridge-image",
            envelopes: [
              expect.objectContaining({
                commands: [
                  {
                    type: "update_node_data",
                    node_id: node.id,
                    data: {
                      model: "existing-model",
                      aspectRatio: "9:16",
                      size: "2K",
                      quality: "high",
                      count: 2,
                    },
                  },
                  {
                    type: "run_node_action",
                    node_id: node.id,
                    action: "generate_image",
                  },
                ],
              }),
            ],
          }),
        }),
      })),
    );
  });

  it("groups video generation parameters like the canvas video node", async () => {
    const node = {
      id: "video-node-1",
      type: "videoNode",
      position: { x: 0, y: 0 },
      selected: false,
      data: {
        prompt: "test video",
        model: "newapi_seedance-2.0",
        aspectRatio: "16:9",
        quality: "720P",
        durationSec: 5,
        generateAudio: false,
        count: 1,
      },
    } satisfies Partial<CanvasNode> as CanvasNode;
    useCanvasStore.getState().setCanvasData([node], []);
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "准备生成视频",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([node], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-video",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "run_node_action",
                  node_id: node.id,
                  action: "generate_video",
                },
              ],
            },
          ],
          receivedAt: Date.now(),
        },
      }));
    });

    expect(await screen.findByLabelText("视频模型")).toBeInTheDocument();
    expect(screen.queryByLabelText("视频比例")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("视频清晰度")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("视频时长")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("视频音频")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "视频参数：16:9 · 720P · 5s · 静音" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "视频参数：16:9 · 720P · 5s · 静音" }));
    fireEvent.click(screen.getByRole("button", { name: "9:16" }));
    fireEvent.click(screen.getByRole("button", { name: "1080P" }));
    fireEvent.change(screen.getByLabelText("视频时长"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("switch", { name: "生成音频" }));
    fireEvent.change(screen.getByLabelText("视频数量"), { target: { value: "2" } });

    expect(screen.getByRole("button", { name: "视频参数：9:16 · 1080P · 10s · 有声" })).toBeInTheDocument();
    expect(screen.getByLabelText("视频数量")).toHaveValue("2");
  });

  it("does not restore a persisted canvas command approval after it was confirmed", async () => {
    superChatMocks.messages = [
      {
        id: "user-a",
        role: "user",
        text: "加个视频节点",
        displayName: "User",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
        raw: {
          ui_events: [
            {
              id: 1,
              type: "canvas_command_approval",
              turn_id: "turn-a",
              schema_version: "canvas_command_approval.v1",
              canvas_id: "canvas-a",
              bridge_key: "bridge-a",
              envelopes: [
                {
                  schema_version: "canvas_chat_commands.v1",
                  canvas_id: "canvas-a",
                  commands: [
                    {
                      type: "create_node",
                      node_type: "videoNode",
                      data: { title: "视频输入" },
                    },
                  ],
                },
              ],
              received_at: 2,
            },
          ],
        },
      } as ChatMessage,
    ];

    const { rerender } = render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(await screen.findByText("待确认的画布操作")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    await waitFor(() => expect(screen.queryByText("待确认的画布操作")).not.toBeInTheDocument());

    superChatMocks.messages = [
      superChatMocks.messages[0],
      {
        id: "assistant-a",
        role: "assistant",
        text: "已为你添加一个视频节点。",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ] as ChatMessage[];

    rerender(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    await waitFor(() => expect(screen.queryByText("待确认的画布操作")).not.toBeInTheDocument());
    expect(screen.getByText("已为你添加一个视频节点。")).toBeInTheDocument();
  });

  it("shows a canvas command approval even when the agent has no visible message yet", async () => {
    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-context-activity", {
        detail: {
          type: "canvas.context.activity",
          turn_id: "turn-a",
          bridge_key: "validation-a",
          canvas_id: "canvas-a",
          status: "done",
          labels: ["命令校验"],
          errors: [],
          received_at: 1,
          surface_order: 1,
        },
      }));
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-a",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "create_node",
                  node_type: "videoNode",
                  data: {},
                },
              ],
            },
          ],
          receivedAt: 1,
        },
      }));
    });

    expect(await screen.findByText("已校验画布命令")).toBeInTheDocument();
    expect(await screen.findByText("待确认的画布操作")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认执行" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(screen.queryByText("待确认的画布操作")).not.toBeInTheDocument());
    expect(await screen.findByText("画布执行")).toBeInTheDocument();
  });

  it("renders canvas command approval once when the same turn has a tool card", async () => {
    superChatMocks.showToolEvents = true;
    superChatMocks.messages = [
      {
        id: "assistant-turn-a",
        role: "assistant",
        text: "我将执行画布操作。",
        timestamp: 1,
        turnId: "turn-a",
      },
      {
        id: "tool-turn-a",
        role: "tool",
        text: "freezone_emit_canvas_command",
        timestamp: 2,
        turnId: "turn-a",
        raw: {
          type: "tool.call",
          name: "freezone_emit_canvas_command",
          input: {
            canvas_id: "canvas-a",
            commands: [
              {
                type: "create_node",
                node_type: "imageGenNode",
                data: { prompt: "test image" },
              },
            ],
          },
        },
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-a",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "create_node",
                  node_type: "imageGenNode",
                  data: { prompt: "test image" },
                },
              ],
            },
          ],
          receivedAt: Date.now(),
        },
      }));
    });

    await waitFor(() => {
      expect(screen.getAllByText("待确认的画布操作")).toHaveLength(1);
    });
  });

  it("restores a persisted canvas command approval when no assistant message exists yet", async () => {
    superChatMocks.messages = [
      {
        id: "user-a",
        role: "user",
        text: "加个视频节点",
        displayName: "User",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
        raw: {
          ui_events: [
            {
              id: 1,
              type: "canvas_command_approval",
              turn_id: "turn-a",
              schema_version: "canvas_command_approval.v1",
              canvas_id: "canvas-a",
              bridge_key: "bridge-a",
              envelopes: [
                {
                  schema_version: "canvas_chat_commands.v1",
                  canvas_id: "canvas-a",
                  commands: [
                    {
                      type: "create_node",
                      node_type: "videoNode",
                      data: { title: "视频输入" },
                    },
                  ],
                },
              ],
              received_at: 2,
            },
          ],
        },
      } as ChatMessage,
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(await screen.findByText("待确认的画布操作")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认执行" })).toBeInTheDocument();
  });

  it("does not restore a persisted canvas command approval when a result already exists", async () => {
    superChatMocks.messages = [
      {
        id: "user-a",
        role: "user",
        text: "加个视频节点",
        displayName: "User",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
        raw: {
          ui_events: [
            {
              id: 1,
              type: "canvas_command_approval",
              turn_id: "turn-a",
              schema_version: "canvas_command_approval.v1",
              canvas_id: "canvas-a",
              bridge_key: "bridge-a",
              envelopes: [
                {
                  schema_version: "canvas_chat_commands.v1",
                  canvas_id: "canvas-a",
                  commands: [
                    {
                      type: "create_node",
                      node_type: "videoNode",
                      data: { title: "视频输入" },
                    },
                  ],
                },
              ],
              received_at: 2,
            },
            {
              id: 2,
              type: "canvas_command_result",
              turn_id: "turn-a",
              schema_version: "canvas_command_result.v1",
              canvas_id: "canvas-a",
              bridge_key: "bridge-a",
              result: {
                applied: 0,
                openedUiActions: 0,
                createdNodeIds: [],
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
              },
              received_at: 3,
              cancelled: true,
            },
          ],
        },
      } as ChatMessage,
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    await waitFor(() => expect(screen.queryByText("待确认的画布操作")).not.toBeInTheDocument());
  });

  it("reports and persists cancelled canvas command approvals", async () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "准备创建节点",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-a",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "create_node",
                  node_type: "imageGenNode",
                  data: { prompt: "test image" },
                },
              ],
            },
          ],
          receivedAt: Date.now(),
        },
      }));
    });

    expect(await screen.findByText("待确认的画布操作")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("api/v1/chat/canvas-command-tool-result", expect.objectContaining({
        json: expect.objectContaining({
          bridge_key: "bridge-a",
          turn_id: "turn-a",
          canvas_apply_status: "cancelled_by_user",
          cancelled: true,
          errors: ["已取消画布操作"],
        }),
      })),
    );
    expect(apiMocks.post).toHaveBeenCalledWith("api/v1/chat/ui-events", expect.objectContaining({
      json: expect.objectContaining({
        turn_id: "turn-a",
        event: expect.objectContaining({
          type: "canvas_command_result",
          bridge_key: "bridge-a",
          cancelled: true,
        }),
      }),
    }));
  });

  it("automatically cancels canvas command approvals after the countdown", async () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "准备创建节点",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-a",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "create_node",
                  node_type: "imageGenNode",
                  data: { prompt: "test image" },
                },
              ],
            },
          ],
          receivedAt: Date.now() - 31_000,
        },
      }));
    });

    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("api/v1/chat/canvas-command-tool-result", expect.objectContaining({
        json: expect.objectContaining({
          bridge_key: "bridge-a",
          turn_id: "turn-a",
          canvas_apply_status: "cancelled_by_user",
          cancelled: true,
          errors: ["画布操作等待超时，已自动取消"],
        }),
      })),
    );
    expect(apiMocks.post).toHaveBeenCalledWith("api/v1/chat/ui-events", expect.objectContaining({
      json: expect.objectContaining({
        turn_id: "turn-a",
        event: expect.objectContaining({
          type: "canvas_command_result",
          bridge_key: "bridge-a",
          cancelled: true,
          cancel_reason: "timeout",
        }),
      }),
    }));
  });

  it("shows a countdown before canvas approval buttons", async () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "准备创建节点",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-a",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "create_node",
                  node_type: "imageGenNode",
                  data: { prompt: "test image" },
                },
              ],
            },
          ],
          receivedAt: Date.now(),
        },
      }));
    });

    expect(await screen.findByText("待确认的画布操作")).toBeInTheDocument();
    expect(screen.getByText(/s 后自动取消/)).toBeInTheDocument();
  });

  it("shows a cancelled feedback when a stale canvas approval remains in message parts", () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "视频生成请求超时了，前端尚未返回结果。",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
        parts: [
          {
            id: "part-text",
            type: "text",
            text: "视频生成请求超时了，前端尚未返回结果。",
          },
          {
            id: "canvas_approval:bridge:bridge-a:turn:turn-a",
            type: "canvas_approval",
            event: {
              id: "bridge:bridge-a:turn:turn-a",
              key: "bridge:bridge-a:turn:turn-a",
              messageId: "assistant-a",
              turnId: "turn-a",
              bridgeKey: "bridge-a",
              agentId: null,
              receivedAt: Date.now() - 31_000,
              autoExpires: true,
              expiresAt: Date.now() - 1_000,
              commandCount: 1,
              envelopes: [
                {
                  schema_version: "canvas_chat_commands.v1",
                  commands: [
                    {
                      type: "run_node_action",
                      node_id: "video-node-a",
                      action: "generate_video",
                    },
                  ],
                },
              ],
              plans: [
                {
                  type: "run_node_action",
                  label: "生成视频",
                  primary: "video-node-a",
                  details: [],
                  nodeId: "video-node-a",
                  action: "generate_video",
                },
              ],
            },
          },
        ],
      } as ChatMessage,
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.getByText("视频生成请求超时了，前端尚未返回结果。")).toBeInTheDocument();
    expect(screen.queryByText("待确认的画布操作")).not.toBeInTheDocument();
    expect(screen.getByText("画布操作已取消")).toBeInTheDocument();
  });

  it("renders Freezone tool calls as activity cards", async () => {
    superChatMocks.showToolEvents = true;
    superChatMocks.messages = [
      {
        id: "tool-a",
        role: "tool",
        text: "freezone_create_node",
        displayName: "Tool",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
        raw: {
          type: "tool.call",
          name: "freezone_create_node",
          input: { project_id: "project-a", canvas_id: "canvas-a" },
        },
      } as ChatMessage,
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(await screen.findByText("创建节点")).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument();
    expect(screen.getByText("项目：project-a")).toBeInTheDocument();
  });

  it("hides protocol narration when a canvas command approval is shown", async () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "canvas_chat_commands.v1\n{\"commands\":[]}",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-a",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "create_node",
                  node_type: "imageGenNode",
                  data: { prompt: "test image" },
                },
              ],
            },
          ],
          receivedAt: Date.now(),
        },
      }));
    });

    expect(await screen.findByText("待确认的画布操作")).toBeInTheDocument();
    expect(screen.queryByText(/canvas_chat_commands\.v1/)).not.toBeInTheDocument();
  });
});
