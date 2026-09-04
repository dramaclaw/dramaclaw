// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { BeatContextNode } from "@/features/canvas/nodes/BeatContextNode";
import type { BeatContextNodeData } from "@/features/canvas/domain/canvasNodes";
import { buildBeatContextNodeRefreshPatch } from "@/features/freezone/context/beatContextSnapshot";
import { setFreezoneCanvasMetadata } from "@/features/freezone/canvasMetadataContext";
import { useCanvasStore } from "@/stores/canvasStore";

const updateBeat = vi.fn().mockResolvedValue({ ok: true, data: null });
const listFreezoneBeatContext = vi.fn();
const createCanvasFromPreset = vi.fn();
const getFreezoneCanvas = vi.fn();

vi.mock("@xyflow/react", async () => {
  const actual =
    await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    Handle: ({ id, type }: { id?: string; type?: string }) => (
      <div data-testid={`handle-${type ?? "unknown"}-${id ?? "default"}`} />
    ),
  };
});

vi.mock("@/api/projects", () => ({
  listFreezoneBeatContext: (...args: unknown[]) =>
    listFreezoneBeatContext(...args),
  updateBeat: (...args: unknown[]) => updateBeat(...args),
}));

vi.mock("@/api/canvas", () => ({
  createCanvasFromPreset: (...args: unknown[]) =>
    createCanvasFromPreset(...args),
  getFreezoneCanvas: (...args: unknown[]) => getFreezoneCanvas(...args),
}));

vi.mock("@/features/canvas/ui/NodeResizeHandle", () => ({
  NodeResizeHandle: () => <div data-testid="resize-handle" />,
}));

vi.mock("@/features/canvas/ui/NodeHeader", () => ({
  NODE_HEADER_FLOATING_POSITION_CLASS: "",
  NodeHeader: ({ titleText }: { titleText: string }) => <div>{titleText}</div>,
}));

vi.mock("@/lib/queries/episodes", () => ({
  useEpisodeDetail: () => ({
    data: {
      ok: true,
      data: {
        number: 1,
        title: "EP1",
        identity_ids: ["面馆男青年_青年时期", "面馆女青年_青年时期"],
        scene_menu: [{ scene_id: "兰州拉面馆" }],
        prop_menu: [{ prop_id: "账单" }, { prop_id: "红色凳子" }],
      },
    },
  }),
  useEpisodeBeats: () => ({
    data: {
      ok: true,
      data: [
        {
          beat_number: 3,
          narration_segment: "",
          visual_description: "",
          scene_ref: { scene_id: "兰州拉面馆" },
          time_of_day: "夜晚",
          detected_identities: [],
          detected_props: [],
        },
      ],
    },
  }),
}));

async function chooseUiSelectOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  optionName: string,
) {
  await user.click(screen.getByRole("button", { name: label }));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

function makeData(
  overrides: Partial<BeatContextNodeData> = {},
): BeatContextNodeData {
  return {
    displayName: "EP1 / Beat 3",
    projectId: "demo",
    episode: 1,
    beat: 3,
    content: "全景镜头，兰州拉面馆内。",
    snapshot: {
      visualDescription: "全景镜头，兰州拉面馆内。",
      sceneId: "兰州拉面馆",
      timeOfDay: "",
      detectedIdentities: [],
      detectedProps: [],
      selectedBackgroundExists: false,
      currentSketchExists: false,
      currentFrameExists: false,
    },
    mainline_context: [
      {
        kind: "beat",
        projectId: "demo",
        episode: 1,
        beat: 3,
      },
    ],
    syncStatus: "fresh",
    ...overrides,
  };
}

function renderNode(data: BeatContextNodeData = makeData()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BeatContextNode
        id="context_beat"
        type="beatContextNode"
        data={data}
        selected={false}
        dragging={false}
        draggable={true}
        selectable={true}
        deletable={true}
        zIndex={0}
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  updateBeat.mockClear();
  createCanvasFromPreset.mockReset();
  getFreezoneCanvas.mockReset();
  setFreezoneCanvasMetadata(null);
  listFreezoneBeatContext.mockReset();
  listFreezoneBeatContext.mockResolvedValue({
    episodes: [
      {
        episode: 1,
        beats: [
          {
            episode: 1,
            beat: 3,
            label: "EP1 / Beat 3",
            visual_description: "全景镜头，兰州拉面馆内。",
            narration_segment: "",
            scene_id: "兰州拉面馆",
            time_of_day: "夜晚",
            detected_identities: [],
            detected_props: [],
            sketch_colors: {},
            prop_marker_colors: {},
            assets: [],
          },
        ],
      },
    ],
  });
  createCanvasFromPreset.mockResolvedValue({
    canvas_id: "default",
    reused: false,
    url: "/freezone/?canvas=default",
  });
  getFreezoneCanvas.mockResolvedValue({
    nodes: [],
    edges: [],
    metadata: null,
  });
  useCanvasStore.getState().setCanvasData([], []);
});

function localeValue(locale: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, part) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[part];
  }, locale);
}

describe("BeatContextNode", () => {
  it("defines i18n labels for shot context standalone UI in zh and en", () => {
    const zh = JSON.parse(
      readFileSync("public/locales/zh/translation.json", "utf-8"),
    );
    const en = JSON.parse(
      readFileSync("public/locales/en/translation.json", "utf-8"),
    );
    const keys = [
      "node.beatContextNode.standaloneTitle",
      "node.beatContextNode.fields.visual",
      "node.beatContextNode.fields.props",
      "node.beatContextNode.status.standaloneLocalOnly",
      "node.beatContextNode.palette.propColors",
    ];
    for (const key of keys) {
      expect(localeValue(zh, key)).toEqual(expect.any(String));
      expect(localeValue(en, key)).toEqual(expect.any(String));
    }
    expect(localeValue(zh, "node.menu.beatContext")).toBe("镜头上下文");
    expect(localeValue(zh, "node.beatContextNode.heading")).toBe("镜头上下文");
    expect(localeValue(zh, "node.beatContextNode.standaloneTitle")).toBe("自定义镜头上下文");
    expect(localeValue(en, "viewer.threeD.beatOverlay.title")).toBe("Shot overlay");
  });

  it("preserves local time of day when sync response omits the field", () => {
    const patch = buildBeatContextNodeRefreshPatch(
      "demo",
      {
        episode: 1,
        beat: 3,
        label: "EP1 / Beat 3",
        visual_description: "全景镜头，兰州拉面馆内。",
        narration_segment: "",
        scene_id: "兰州拉面馆",
        detected_identities: [],
        detected_props: [],
        sketch_colors: {},
        prop_marker_colors: {},
        assets: [],
      },
      makeData({
        snapshot: {
          ...makeData().snapshot,
          timeOfDay: "夜晚",
        },
        beat_edit_fields: {
          time_of_day: "夜晚",
        },
      }),
    );

    expect(patch.snapshot?.timeOfDay).toBe("夜晚");
    expect(patch.beat_edit_fields?.time_of_day).toBe("夜晚");
  });

  it("renders selectable identity and prop chips instead of CSV inputs", () => {
    renderNode();

    expect(screen.getByText("出场身份")).toBeInTheDocument();
    expect(screen.getByText("出场道具")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /面馆男青年_青年时期/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /账单/ })).toBeInTheDocument();
  });

  it("shows assigned identity and prop colors on selectable chips", () => {
    renderNode(
      makeData({
        snapshot: {
          ...makeData().snapshot,
          sketchColors: {
            面馆男青年_青年时期: "#FF00FF MAGENTA",
          },
          propMarkerColors: {
            账单: "#5D4037 BROWN",
          },
        },
      }),
    );

    expect(
      screen.getByTestId("beat-context-color-identity-面馆男青年_青年时期"),
    ).toHaveStyle({
      backgroundColor: "#FF00FF",
    });
    expect(screen.getByTestId("beat-context-color-prop-账单")).toHaveStyle({
      backgroundColor: "#5D4037",
    });
  });
  it("renders standalone context as local-only without mainline sync", () => {
    renderNode(
      makeData({
        context_scope: "standalone",
        projectId: undefined,
        episode: undefined,
        beat: undefined,
        mainline_context: undefined,
        syncStatus: "fresh",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "自定义镜头上下文",
          visual_description: "雨夜里，女主站在便利店门口回头。",
          narration_segment: "",
          scene_id: "便利店门口",
          detected_identities: [],
          detected_props: [],
          sketch_colors: {},
          prop_marker_colors: {},
        },
      }),
    );

    expect(screen.getByText("自定义镜头上下文")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "同步到主线" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("EP? / Beat ?")).not.toBeInTheDocument();
    expect(screen.queryByText("EP1 / Beat 3")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("场景")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("时间")).not.toBeInTheDocument();
  });

  it("treats beat nodes with mainline_context as mainline even if default standalone fields leaked in", () => {
    renderNode(
      makeData({
        context_scope: "standalone",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "自定义镜头上下文",
          visual_description: "",
          narration_segment: "",
          detected_identities: [],
          detected_props: [],
          sketch_colors: {},
          prop_marker_colors: {},
        },
      }),
    );

    expect(screen.getAllByText("EP1 / Beat 3").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("场景")).toBeInTheDocument();
    expect(screen.getByLabelText("时间")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "同步到主线" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("上下文已同步；技能会使用当前节点。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("自定义上下文；仅当前画布使用。"),
    ).not.toBeInTheDocument();
  });

  it("inserts standalone mention templates and derives identity and prop chips", () => {
    renderNode(
      makeData({
        displayName: "镜头上下文",
        context_scope: "standalone",
        projectId: undefined,
        episode: undefined,
        beat: undefined,
        mainline_context: undefined,
        syncStatus: "fresh",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "自定义镜头上下文",
          visual_description: "",
          narration_segment: "",
          detected_identities: [],
          detected_props: [],
          sketch_colors: {},
          prop_marker_colors: {},
        },
        snapshot: {},
      }),
    );

    const visual = screen.getByPlaceholderText("未设置;点击输入起始画面描述");
    fireEvent.change(visual, { target: { value: "@", selectionStart: 1 } });

    const identityTemplate = screen.getByText("人物").closest("button");
    expect(identityTemplate).not.toBeNull();
    fireEvent.click(identityTemplate!);

    expect(screen.getByDisplayValue("{{}}")).toBeInTheDocument();

    fireEvent.change(visual, {
      target: {
        value: "{{女主}} 拿起 @",
        selectionStart: "{{女主}} 拿起 @".length,
      },
    });

    const propTemplate = screen.getByText("道具").closest("button");
    expect(propTemplate).not.toBeNull();
    fireEvent.click(propTemplate!);

    expect(screen.getByDisplayValue("{{女主}} 拿起 [[]]")).toBeInTheDocument();
    fireEvent.change(visual, {
      target: {
        value: "{{女主}} 拿起 [[雨伞]]",
        selectionStart: "{{女主}} 拿起 [[雨伞]]".length,
      },
    });
    fireEvent.blur(visual);

    expect(
      screen.getByDisplayValue("{{女主}} 拿起 [[雨伞]]"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /女主/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /雨伞/ })).toBeInTheDocument();
    expect(updateBeat).not.toHaveBeenCalled();
  });

  it("removes standalone prop chips when prop markers are removed from visual text", async () => {
    renderNode(
      makeData({
        displayName: "镜头上下文",
        context_scope: "standalone",
        projectId: undefined,
        episode: undefined,
        beat: undefined,
        mainline_context: undefined,
        syncStatus: "fresh",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "自定义镜头上下文",
          visual_description: "{{Kris}} 拿着一把 [[雨伞]] 和 [[黑色西装]]",
          narration_segment: "",
          detected_identities: ["Kris"],
          detected_props: ["雨伞", "黑色西装"],
          sketch_colors: {},
          prop_marker_colors: {},
        },
        snapshot: {},
      }),
    );

    const visual = screen.getByDisplayValue(
      "{{Kris}} 拿着一把 [[雨伞]] 和 [[黑色西装]]",
    );
    expect(screen.getByRole("button", { name: /雨伞/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /黑色西装/ }),
    ).toBeInTheDocument();

    fireEvent.change(visual, {
      target: {
        value: "{{Kris}} 拿着一把 [[雨伞]]",
        selectionStart: "{{Kris}} 拿着一把 [[雨伞]]".length,
      },
    });
    fireEvent.blur(visual);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /雨伞/ })).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /黑色西装/ }),
      ).not.toBeInTheDocument();
    });
    expect(updateBeat).not.toHaveBeenCalled();
  });

  it("keeps standalone identity options when their chips are toggled off", async () => {
    const user = userEvent.setup();
    renderNode(
      makeData({
        displayName: "镜头上下文",
        context_scope: "standalone",
        projectId: undefined,
        episode: undefined,
        beat: undefined,
        mainline_context: undefined,
        syncStatus: "fresh",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "自定义镜头上下文",
          visual_description: "{{女主}} 拿起 [[雨伞]]",
          narration_segment: "",
          detected_identities: ["女主"],
          detected_props: ["雨伞"],
          sketch_colors: { "女主": "#FF00FF" },
          prop_marker_colors: {},
        },
        snapshot: {},
      }),
    );

    const identityChip = screen.getByRole("button", { name: /女主/ });
    expect(identityChip).toHaveAttribute("aria-pressed", "true");
    await user.click(identityChip);

    const toggledChip = screen.getByRole("button", { name: /女主/ });
    expect(toggledChip).toBeInTheDocument();
    expect(toggledChip).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByDisplayValue("{{女主}} 拿起 [[雨伞]]"),
    ).toBeInTheDocument();
    expect(updateBeat).not.toHaveBeenCalled();
  });

  it("does not restore a toggled-off standalone identity when the visual draft is saved", async () => {
    const user = userEvent.setup();
    renderNode(
      makeData({
        displayName: "镜头上下文",
        context_scope: "standalone",
        projectId: undefined,
        episode: undefined,
        beat: undefined,
        mainline_context: undefined,
        syncStatus: "fresh",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "自定义镜头上下文",
          visual_description: "{{女主}} 拿起 [[雨伞]]",
          narration_segment: "",
          detected_identities: ["女主"],
          detected_props: ["雨伞"],
          sketch_colors: { "女主": "#FF00FF" },
          prop_marker_colors: {},
        },
        snapshot: {},
      }),
    );

    await user.click(screen.getByRole("button", { name: /女主/ }));
    expect(screen.getByRole("button", { name: /女主/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    fireEvent.blur(screen.getByDisplayValue("{{女主}} 拿起 [[雨伞]]"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /女主/ })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
  });

  it("shows standalone identity options from visual markers even when not selected", () => {
    renderNode(
      makeData({
        displayName: "镜头上下文",
        context_scope: "standalone",
        projectId: undefined,
        episode: undefined,
        beat: undefined,
        mainline_context: undefined,
        syncStatus: "fresh",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "自定义镜头上下文",
          visual_description: "{{女主}} 拿起 [[雨伞]]",
          narration_segment: "",
          detected_identities: [],
          detected_props: [],
          sketch_colors: {},
          prop_marker_colors: {},
        },
        snapshot: {},
      }),
    );

    expect(screen.getByRole("button", { name: /女主/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: /雨伞/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "无角色出场" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "无道具出场" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("selects the empty standalone identity and prop sentinels when visual markers are absent", async () => {
    const user = userEvent.setup();
    renderNode(
      makeData({
        displayName: "镜头上下文",
        context_scope: "standalone",
        projectId: undefined,
        episode: undefined,
        beat: undefined,
        mainline_context: undefined,
        syncStatus: "fresh",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "自定义镜头上下文",
          visual_description: "{{女主}} 拿起 [[雨伞]]",
          narration_segment: "",
          detected_identities: ["女主"],
          detected_props: ["雨伞"],
          sketch_colors: {},
          prop_marker_colors: {},
        },
        snapshot: {},
      }),
    );

    const visual = screen.getByDisplayValue("{{女主}} 拿起 [[雨伞]]");
    await user.clear(visual);
    await user.type(visual, "空镜头");
    fireEvent.blur(visual);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "无角色出场" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "无道具出场" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  });

  it("allows standalone identity and prop colors to be edited from the round palette", async () => {
    const user = userEvent.setup();
    renderNode(
      makeData({
        displayName: "镜头上下文",
        context_scope: "standalone",
        projectId: undefined,
        episode: undefined,
        beat: undefined,
        mainline_context: undefined,
        syncStatus: "fresh",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "自定义镜头上下文",
          visual_description: "{{女主}} 拿起 [[雨伞]]",
          narration_segment: "",
          detected_identities: ["女主"],
          detected_props: ["雨伞"],
          sketch_colors: {},
          prop_marker_colors: {},
        },
        snapshot: {},
      }),
    );

    expect(
      document.querySelector('input[type=\"color\"]'),
    ).not.toBeInTheDocument();
    const identityColor = screen.getByLabelText("身份颜色 女主");
    const propColor = screen.getByLabelText("道具颜色 雨伞");

    await user.click(identityColor);
    const actorCyan = screen.getByRole("button", { name: "人物颜色 #00FFFF" });
    expect(actorCyan.closest(".max-h-56.overflow-auto")).toBeNull();
    await user.click(actorCyan);
    expect(identityColor).toHaveStyle({ backgroundColor: "#00FFFF" });

    await user.click(propColor);
    await user.click(screen.getByRole("button", { name: "道具颜色 #B71C1C" }));
    expect(propColor).toHaveStyle({ backgroundColor: "#B71C1C" });

    expect(updateBeat).not.toHaveBeenCalled();
  });

  it("does not restore stale persisted syncing status as an active refresh", () => {
    renderNode(makeData({ syncStatus: "syncing" }));

    expect(screen.queryByText("正在同步到主线...")).not.toBeInTheDocument();
    expect(
      screen.getByText("上下文已同步；技能会使用当前节点。"),
    ).toBeInTheDocument();
  });

  it("inserts identity and prop tokens into the local beat context draft", async () => {
    const user = userEvent.setup();
    renderNode();

    const visual = screen.getByDisplayValue("全景镜头，兰州拉面馆内。");
    await user.clear(visual);
    await user.type(visual, "角色 @");
    const identityMention = (
      await screen.findByText("{{面馆男青年_青年时期}}")
    ).closest("button");
    expect(identityMention).not.toBeNull();

    await user.click(identityMention!);

    expect(updateBeat).not.toHaveBeenCalled();
    expect(
      screen.getByDisplayValue("角色 {{面馆男青年_青年时期}}"),
    ).toBeInTheDocument();

    const updatedVisual =
      screen.getByDisplayValue("角色 {{面馆男青年_青年时期}}");
    await user.clear(updatedVisual);
    await user.type(updatedVisual, "道具 @");
    const propMention = (await screen.findByText("[[账单]]")).closest("button");
    expect(propMention).not.toBeNull();
    await user.click(propMention!);

    expect(updateBeat).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("道具 [[账单]]")).toBeInTheDocument();
  });

  it("updates scene and time as local draft fields", async () => {
    const user = userEvent.setup();
    renderNode(
      makeData({
        snapshot: { ...makeData().snapshot, sceneId: "", timeOfDay: "" },
      }),
    );

    await chooseUiSelectOption(user, "场景", "兰州拉面馆");
    expect(updateBeat).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "场景" })).toHaveTextContent("兰州拉面馆");

    await chooseUiSelectOption(user, "时间", "夜晚");
    expect(updateBeat).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "时间" })).toHaveTextContent("夜晚");
  });

  it("preserves scene variant when syncing local beat edits", async () => {
    const user = userEvent.setup();
    const data = makeData({
      snapshot: {
        ...makeData().snapshot,
        sceneId: "兰州拉面馆",
        sceneVariantId: "雨夜",
      },
      beat_edit_fields: {
        scene_id: "兰州拉面馆",
        scene_variant_id: "雨夜",
      },
    });
    renderNode(data);

    await user.click(screen.getByRole("button", { name: "同步到主线" }));

    await waitFor(() => {
      expect(updateBeat).toHaveBeenCalledWith(
        "demo",
        1,
        3,
        expect.objectContaining({
          scene_ref: { scene_id: "兰州拉面馆", variant_id: "雨夜" },
        }),
      );
    });
  });

  it("links selected identities to the frame skill after sync without page refresh", async () => {
    const user = userEvent.setup();
    const data = makeData();
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "context_beat",
          type: CANVAS_NODE_TYPES.beatContext,
          position: { x: 0, y: 0 },
          data,
        },
        {
          id: "identity_ref",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: -300, y: 0 },
          data: {
            displayName: "面馆男青年_青年时期",
            mainline_context: [
              {
                kind: "identity",
                identityId: "面馆男青年_青年时期",
                role: "character_identity",
              },
            ],
          },
        },
        {
          id: "skill_frame",
          type: CANVAS_NODE_TYPES.skill,
          position: { x: 300, y: 0 },
          data: {
            displayName: "Frame from context",
            skill_id: "freezone.frame_from_context",
          },
        },
      ],
      [
        {
          id: "edge_context_to_skill_frame",
          source: "context_beat",
          target: "skill_frame",
          sourceHandle: "source",
          targetHandle: "beat_context",
          type: "disconnectableEdge",
          data: {
            edgeKind: "role_binding",
            role: "beat_context",
            propagates: true,
          },
        },
      ],
    );
    listFreezoneBeatContext.mockResolvedValueOnce({
      episodes: [
        {
          episode: 1,
          beats: [
            {
              episode: 1,
              beat: 3,
              label: "EP1 / Beat 3",
              visual_description: "全景镜头，兰州拉面馆内。",
              narration_segment: "",
              scene_id: "兰州拉面馆",
              time_of_day: "夜晚",
              detected_identities: ["面馆男青年_青年时期"],
              detected_props: [],
              sketch_colors: {},
              prop_marker_colors: {},
              assets: [],
            },
          ],
        },
      ],
    });

    renderNode(data);
    await user.click(
      screen.getByRole("button", { name: /面馆男青年_青年时期/ }),
    );

    await waitFor(() => {
      expect(
        useCanvasStore.getState().edges.some((edge) => {
          const edgeData = edge.data as
            | {
                role?: string;
                autoBeatContextProjection?: boolean;
                reference_target?: { identity_id?: string };
              }
            | undefined;
          return (
            edge.source === "identity_ref" &&
            edge.target === "skill_frame" &&
            edge.targetHandle === "identity:面馆男青年_青年时期" &&
            edgeData?.role === "identity" &&
            edgeData.reference_target?.identity_id === "面馆男青年_青年时期" &&
            edgeData.autoBeatContextProjection === true
          );
        }),
      ).toBe(true);
    });
  });

  it("saves identity selection locally and restores the backend preset only after manual sync", async () => {
    const user = userEvent.setup();
    setFreezoneCanvasMetadata({
      preset: {
        scope: "beat",
        episode: 1,
        beat: 3,
        primary_slot: "render",
      },
    });
    const data = makeData();
    getFreezoneCanvas.mockResolvedValueOnce({
      nodes: [],
      edges: [],
      metadata: null,
      revision: "before-restore",
    });
    getFreezoneCanvas.mockResolvedValueOnce({
      nodes: [
        {
          id: "context_beat",
          type: CANVAS_NODE_TYPES.beatContext,
          position: { x: 0, y: 0 },
          data,
        },
        {
          id: "real_identity_ref",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 120, y: 120 },
          data: {
            displayName: "面馆女青年_青年时期",
            preset_managed: true,
            mainline_context: [
              {
                kind: "identity",
                projectId: "demo",
                identityId: "面馆女青年_青年时期",
                role: "character_identity",
              },
            ],
          },
        },
      ],
      edges: [],
      metadata: {
        preset: {
          scope: "beat",
          episode: 1,
          beat: 3,
          primary_slot: "render",
        },
      },
    });
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "context_beat",
          type: CANVAS_NODE_TYPES.beatContext,
          position: { x: 0, y: 0 },
          data,
        },
        {
          id: "local_upload",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 800, y: 200 },
          data: {
            displayName: "我的临时节点",
            imageUrl: "/local.png",
            aspectRatio: "1:1",
            user_spawned: true,
          },
        },
        {
          id: "bad_projection",
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 100, y: 100 },
          data: { displayName: "错误投影", autoBeatContextProjection: true },
        },
      ],
      [],
    );

    renderNode(data);
    await user.click(
      screen.getByRole("button", { name: /面馆女青年_青年时期/ }),
    );

    expect(updateBeat).not.toHaveBeenCalled();
    expect(createCanvasFromPreset).not.toHaveBeenCalled();
    expect(screen.queryByText("正在同步到主线...")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "同步到主线" }));

    await waitFor(() => {
      const state = useCanvasStore.getState();
      expect(updateBeat).toHaveBeenCalledWith(
        "demo",
        1,
        3,
        expect.objectContaining({
          detected_identities: ["面馆女青年_青年时期"],
        }),
      );
      expect(createCanvasFromPreset).toHaveBeenCalledWith(
        "demo",
        expect.objectContaining({
          scope: "beat",
          episode: 1,
          beat: 3,
          canvas_id: "default",
          overwrite_existing: true,
        }),
      );
      expect(state.nodes.some((node) => node.id === "real_identity_ref")).toBe(
        true,
      );
      expect(state.nodes.some((node) => node.id === "local_upload")).toBe(true);
      expect(state.nodes.some((node) => node.id === "bad_projection")).toBe(
        false,
      );
    });
  });
});
