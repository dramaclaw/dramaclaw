import type { CanvasEdge, CanvasNode, CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import {
  buildCanvasNodeActionCatalog,
  type CanvasNodeActionCatalog,
  type CanvasNodeActionCatalogEntry,
} from "@/features/freezone/canvasNodeActionCatalog";

export type CanvasActionExecution =
  | "chat_command"
  | "manual_ui"
  | "requires_confirmation"
  | "frontend_node";

export type CanvasActionInput = {
  role: string;
  required: boolean;
  cardinality: "single" | "multi";
  node_types?: CanvasNodeType[];
  media_kinds?: string[];
  value_kinds?: string[];
  has_fields?: string[];
};

export type CanvasActionOutput = {
  role: string;
  media_type: string | null;
  node_kind: "candidate" | "action" | "text" | "asset" | "ui";
  pushable: boolean;
};

export type CanvasActionCapability = {
  id: string;
  display_name: string;
  execution: CanvasActionExecution;
  command_type?: string;
  node_type?: CanvasNodeType;
  inputs: CanvasActionInput[];
  outputs: CanvasActionOutput[];
  frontend_mapping?: Record<string, unknown>;
};

export type CanvasActionCatalog = {
  schema_version: "canvas_action_catalog.v1";
  frontend_command_catalog: CanvasActionCapability[];
  canvas_action_catalog: CanvasActionCapability[];
  node_action_catalogs: CanvasNodeActionCatalog[];
};

function commandCapability(
  entry: CanvasNodeActionCatalogEntry,
  node: CanvasNode,
): CanvasActionCapability {
  return {
    id: `ui.${entry.action}`,
    display_name: entry.action,
    execution: entry.execution,
    command_type: entry.command_type,
    node_type: node.type ?? undefined,
    inputs: [
      {
        role: "target_node",
        required: true,
        cardinality: "single",
        node_types: node.type ? [node.type] : undefined,
      },
    ],
    outputs: [
      {
        role: "ui_result",
        media_type: null,
        node_kind: "ui",
        pushable: false,
      },
    ],
    frontend_mapping: {
      ...entry.parameters,
      description: entry.description,
    },
  };
}

const IMAGE_NODE_TYPES: CanvasNodeType[] = [
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.exportImage,
];

const VIDEO_NODE_TYPES: CanvasNodeType[] = [
  CANVAS_NODE_TYPES.video,
  CANVAS_NODE_TYPES.upload,
];

const AUDIO_NODE_TYPES: CanvasNodeType[] = [
  CANVAS_NODE_TYPES.audio,
  CANVAS_NODE_TYPES.upload,
];

const TEXT_NODE_TYPES: CanvasNodeType[] = [
  CANVAS_NODE_TYPES.textAnnotation,
  CANVAS_NODE_TYPES.script,
];

const DIRECTOR_WORLD_NODE_TYPES: CanvasNodeType[] = [
  CANVAS_NODE_TYPES.threeDWorld,
];

function imageUiCapability(
  id: string,
  displayName: string,
  action: string,
  description?: string,
): CanvasActionCapability {
  const isDirectImageAction = action === "run_matting_tool" || action.startsWith("run_");
  return {
    id,
    display_name: displayName,
    execution: isDirectImageAction ? "frontend_node" : "manual_ui",
    command_type: "run_node_action",
    inputs: [
      {
        role: "source_image",
        required: true,
        cardinality: "single",
        node_types: IMAGE_NODE_TYPES,
        media_kinds: ["image"],
        has_fields: ["imageUrl"],
      },
    ],
    outputs: [
      {
        role: isDirectImageAction ? "result" : "ui_panel",
        media_type: isDirectImageAction ? "image" : null,
        node_kind: isDirectImageAction ? "candidate" : "ui",
        pushable: isDirectImageAction,
      },
    ],
    frontend_mapping: {
      action,
      description,
    },
  };
}

function videoUiCapability(
  id: string,
  displayName: string,
  action: string,
  options: {
    execution?: CanvasActionExecution;
    mediaType?: string | null;
    nodeKind?: CanvasActionOutput["node_kind"];
    pushable?: boolean;
  } = {},
): CanvasActionCapability {
  return {
    id,
    display_name: displayName,
    execution: options.execution ?? "manual_ui",
    command_type: "run_node_action",
    inputs: [
      {
        role: "source_video",
        required: true,
        cardinality: "single",
        node_types: VIDEO_NODE_TYPES,
        media_kinds: ["video"],
        has_fields: ["videoUrl"],
      },
    ],
    outputs: [
      {
        role: options.nodeKind === "candidate" ? "result" : "ui_panel",
        media_type: options.mediaType ?? null,
        node_kind: options.nodeKind ?? "ui",
        pushable: options.pushable ?? false,
      },
    ],
    frontend_mapping: {
      action,
    },
  };
}

export const BASE_CANVAS_ACTION_CAPABILITIES: CanvasActionCapability[] = [
  {
    id: "freezone.image.generate",
    display_name: "图片生成",
    execution: "frontend_node",
    node_type: CANVAS_NODE_TYPES.imageGen,
    inputs: [
      {
        role: "prompt",
        required: false,
        cardinality: "multi",
        value_kinds: ["text"],
        node_types: [CANVAS_NODE_TYPES.textAnnotation, CANVAS_NODE_TYPES.script],
      },
      {
        role: "reference_media",
        required: false,
        cardinality: "multi",
        media_kinds: ["image", "video", "audio"],
      },
    ],
    outputs: [
      {
        role: "result",
        media_type: "image",
        node_kind: "candidate",
        pushable: true,
      },
    ],
    frontend_mapping: {
      command_type: "create_node",
      create_node_type: CANVAS_NODE_TYPES.imageGen,
    },
  },
  {
    id: "freezone.video.generate",
    display_name: "视频生成",
    execution: "frontend_node",
    node_type: CANVAS_NODE_TYPES.video,
    inputs: [
      {
        role: "prompt",
        required: false,
        cardinality: "multi",
        value_kinds: ["text"],
        node_types: [CANVAS_NODE_TYPES.textAnnotation, CANVAS_NODE_TYPES.script],
      },
      {
        role: "reference_media",
        required: false,
        cardinality: "multi",
        media_kinds: ["image", "video", "audio"],
      },
    ],
    outputs: [
      {
        role: "result",
        media_type: "video",
        node_kind: "candidate",
        pushable: true,
      },
    ],
    frontend_mapping: {
      command_type: "create_node",
      create_node_type: CANVAS_NODE_TYPES.video,
      run_action: "generate_video",
      modes: [
        "textToVideo",
        "imageToVideo",
        "firstLastFrame",
        "imageReference",
        "allReference",
      ],
    },
  },
  {
    id: "freezone.audio.generate",
    display_name: "音频生成",
    execution: "frontend_node",
    node_type: CANVAS_NODE_TYPES.audio,
    inputs: [
      {
        role: "prompt",
        required: false,
        cardinality: "multi",
        value_kinds: ["text"],
        node_types: [CANVAS_NODE_TYPES.textAnnotation, CANVAS_NODE_TYPES.script],
      },
      {
        role: "voice_reference",
        required: false,
        cardinality: "single",
        media_kinds: ["audio"],
        node_types: AUDIO_NODE_TYPES,
      },
    ],
    outputs: [
      {
        role: "result",
        media_type: "audio",
        node_kind: "candidate",
        pushable: true,
      },
    ],
    frontend_mapping: {
      command_type: "create_node",
      create_node_type: CANVAS_NODE_TYPES.audio,
      run_action: "generate_audio",
      modes: ["speech", "music"],
      data_fields: {
        audioKind: "speech | music",
        speechMode: "clone（仅自定义声线；未选择时跳过）", // i18n-exempt -- agent schema description
        text: "string",
        emotionPrompt: "string",
        musicLengthMs: "number",
        forceInstrumental: "boolean",
        respectSectionsDurations: "boolean",
      },
    },
  },
  {
    id: "freezone.text.translate",
    display_name: "文本翻译",
    execution: "frontend_node",
    node_type: CANVAS_NODE_TYPES.textAnnotation,
    inputs: [
      {
        role: "source_text",
        required: true,
        cardinality: "single",
        value_kinds: ["text"],
        node_types: TEXT_NODE_TYPES,
      },
    ],
    outputs: [
      {
        role: "result",
        media_type: "text",
        node_kind: "text",
        pushable: false,
      },
    ],
    frontend_mapping: {
      command_type: "run_node_action",
      run_action: "translate_text",
      target_node_type: CANVAS_NODE_TYPES.textAnnotation,
      data_fields: {
        content: "string",
      },
    },
  },
  {
    id: "freezone.image.reverse_prompt",
    display_name: "图片反推提示词",
    execution: "frontend_node",
    node_type: CANVAS_NODE_TYPES.textAnnotation,
    inputs: [
      {
        role: "source_image",
        required: true,
        cardinality: "single",
        node_types: IMAGE_NODE_TYPES,
        media_kinds: ["image"],
        has_fields: ["imageUrl"],
      },
      {
        role: "instruction",
        required: false,
        cardinality: "single",
        value_kinds: ["text"],
        node_types: [CANVAS_NODE_TYPES.textAnnotation],
      },
    ],
    outputs: [
      {
        role: "result",
        media_type: "text",
        node_kind: "text",
        pushable: false,
      },
    ],
    frontend_mapping: {
      command_type: "create_node",
      create_node_type: CANVAS_NODE_TYPES.textAnnotation,
      run_action: "reverse_prompt",
      required_mode: "imageToPrompt",
      data_fields: {
        mode: "imageToPrompt",
        instruction: "string",
      },
    },
  },
  {
    id: "freezone.text.to_video",
    display_name: "文本生成视频",
    execution: "frontend_node",
    node_type: CANVAS_NODE_TYPES.textAnnotation,
    inputs: [
      {
        role: "prompt",
        required: true,
        cardinality: "single",
        value_kinds: ["text"],
        node_types: [CANVAS_NODE_TYPES.textAnnotation],
      },
    ],
    outputs: [
      {
        role: "result",
        media_type: "video",
        node_kind: "candidate",
        pushable: true,
      },
    ],
    frontend_mapping: {
      command_type: "create_node",
      create_node_type: CANVAS_NODE_TYPES.textAnnotation,
      downstream_node_type: CANVAS_NODE_TYPES.video,
      run_action: "generate_text_video",
      required_mode: "textToVideo",
      data_fields: {
        mode: "textToVideo",
        content: "string",
      },
    },
  },
  {
    id: "freezone.text.story_script",
    display_name: "故事脚本生成",
    execution: "frontend_node",
    node_type: CANVAS_NODE_TYPES.script,
    inputs: [
      {
        role: "prompt",
        required: false,
        cardinality: "single",
        value_kinds: ["text"],
        node_types: TEXT_NODE_TYPES,
      },
      {
        role: "reference_media",
        required: false,
        cardinality: "multi",
        media_kinds: ["image", "video"],
      },
    ],
    outputs: [
      {
        role: "result",
        media_type: "text",
        node_kind: "text",
        pushable: false,
      },
    ],
    frontend_mapping: {
      command_type: "create_node",
      create_node_type: CANVAS_NODE_TYPES.script,
      run_action: "generate_story_script",
      data_fields: {
        prompt: "string",
      },
    },
  },
  {
    id: "freezone.director_world.open",
    display_name: "打开导演世界",
    execution: "manual_ui",
    node_type: CANVAS_NODE_TYPES.threeDWorld,
    inputs: [
      {
        role: "target_world",
        required: true,
        cardinality: "single",
        node_types: DIRECTOR_WORLD_NODE_TYPES,
      },
    ],
    outputs: [
      {
        role: "ui_panel",
        media_type: null,
        node_kind: "ui",
        pushable: false,
      },
    ],
    frontend_mapping: {
      command_type: "run_node_action",
      run_action: "open_director_world",
      target_node_type: CANVAS_NODE_TYPES.threeDWorld,
    },
  },
  {
    id: "freezone.image.to_3gs",
    display_name: "图片转 3GS 世界",
    execution: "frontend_node",
    node_type: CANVAS_NODE_TYPES.threeDWorld,
    inputs: [
      {
        role: "source_image",
        required: true,
        cardinality: "single",
        node_types: IMAGE_NODE_TYPES,
        media_kinds: ["image"],
        has_fields: ["imageUrl"],
      },
      {
        role: "target_world",
        required: true,
        cardinality: "single",
        node_types: DIRECTOR_WORLD_NODE_TYPES,
      },
    ],
    outputs: [
      {
        role: "result",
        media_type: "model",
        node_kind: "asset",
        pushable: false,
      },
    ],
    frontend_mapping: {
      command_type: "run_node_action",
      run_action: "generate_3gs_world",
      target_node_type: CANVAS_NODE_TYPES.threeDWorld,
      source_kind_field: "plyKind",
      source_kind_options: ["master", "reverse", "pano"],
      note: "需要先把图片节点连接到 threeDWorldNode，再对 threeDWorldNode 运行 generate_3gs_world。",
    },
  },
  {
    id: "freezone.image.edit.reference",
    display_name: "参考图生图",
    execution: "frontend_node",
    node_type: CANVAS_NODE_TYPES.imageEdit,
    inputs: [
      {
        role: "source_image",
        required: true,
        cardinality: "single",
        node_types: IMAGE_NODE_TYPES,
        media_kinds: ["image"],
        has_fields: ["imageUrl"],
      },
      {
        role: "prompt",
        required: false,
        cardinality: "multi",
        value_kinds: ["text"],
        node_types: [CANVAS_NODE_TYPES.textAnnotation, CANVAS_NODE_TYPES.script],
      },
    ],
    outputs: [
      {
        role: "result",
        media_type: "image",
        node_kind: "candidate",
        pushable: true,
      },
    ],
    frontend_mapping: {
      command_type: "add_next_node",
      create_node_type: CANVAS_NODE_TYPES.imageEdit,
    },
  },
  imageUiCapability("ui.open_crop_tool", "裁剪", "open_crop_tool"),
  imageUiCapability("ui.download_image", "下载图片", "download_image"),
  imageUiCapability("ui.open_annotate_tool", "标注", "open_annotate_tool"),
  imageUiCapability("ui.open_split_storyboard_tool", "分格抽取", "open_split_storyboard_tool"),
  imageUiCapability(
    "ui.run_matting_tool",
    "抠图",
    "run_matting_tool",
    "抠图 / 去背景 / 移除背景 / 透明背景：对源图片执行前景抠图，生成透明背景 PNG 结果图。",
  ),
  imageUiCapability("ui.run_upscale_tool", "高清放大", "run_upscale_tool"),
  imageUiCapability("ui.open_redraw_tool", "重绘", "open_redraw_tool"),
  imageUiCapability("ui.open_erase_tool", "擦除", "open_erase_tool"),
  imageUiCapability("ui.run_outpaint_tool", "扩图", "run_outpaint_tool"),
  imageUiCapability(
    "ui.run_scene360_tool",
    "生成 360 全景",
    "run_scene360_tool",
    "全景 / 360 全景：提交图片节点的 360 全景生成，并创建全景结果图和 360 查看器节点。",
  ),
  imageUiCapability(
    "ui.open_multi_angle_tool",
    "多维度 / 多角度 / 多视图 / 多视角",
    "open_multi_angle_tool",
    "多维度 / 多角度 / 多视图 / 多视角：打开图片节点的多维度面板。",
  ),
  imageUiCapability("ui.open_light_tool", "打光", "open_light_tool"),
  imageUiCapability("ui.open_rotate_tool", "旋转", "open_rotate_tool"),
  imageUiCapability("ui.run_grid_multi_camera", "多机位九宫格", "run_grid_multi_camera"),
  imageUiCapability("ui.run_grid_plot_four", "剧情四宫格", "run_grid_plot_four"),
  imageUiCapability("ui.run_grid_face_three_view", "面部三视图", "run_grid_face_three_view"),
  imageUiCapability("ui.run_grid_product_three_view", "产品三视图", "run_grid_product_three_view"),
  imageUiCapability("ui.run_grid_serial_storyboard_25", "连续分镜 25 格", "run_grid_serial_storyboard_25"),
  imageUiCapability("ui.run_grid_cinematic_light_correction", "电影感光影修正", "run_grid_cinematic_light_correction"),
  imageUiCapability("ui.run_grid_character_three_view", "角色三视图", "run_grid_character_three_view"),
  imageUiCapability("ui.run_grid_scene_setting_sheet", "场景设定图", "run_grid_scene_setting_sheet"),
  imageUiCapability("ui.run_grid_frame_projection_3s_later", "推演 3 秒后画面", "run_grid_frame_projection_3s_later"),
  imageUiCapability("ui.run_grid_frame_projection_5s_earlier", "推演 5 秒前画面", "run_grid_frame_projection_5s_earlier"),
  videoUiCapability("ui.open_video_viewer", "视频查看", "open_video_viewer"),
  videoUiCapability("ui.open_video_clip_tool", "视频剪辑", "open_video_clip_tool"),
  videoUiCapability("ui.open_video_upscale_tool", "视频高清增强", "open_video_upscale_tool", {
    mediaType: "video",
    nodeKind: "candidate",
    pushable: true,
  }),
  videoUiCapability("ui.run_video_analyze_story", "视频故事分析", "run_video_analyze_story", {
    execution: "frontend_node",
    mediaType: "text",
    nodeKind: "text",
  }),
  videoUiCapability("ui.run_audio_separate", "音视频分离", "run_audio_separate", {
    execution: "frontend_node",
  }),
  videoUiCapability("ui.open_video_subtitle_erase_smart", "智能去字幕", "open_video_subtitle_erase_smart"),
  videoUiCapability("ui.open_video_subtitle_erase_box", "框选去字幕", "open_video_subtitle_erase_box"),
];

export function buildCanvasActionCatalog(nodes: CanvasNode[], edges: CanvasEdge[] = []): CanvasActionCatalog {
  const context = { nodes, edges };
  const nodeActionCatalogs = nodes.map((node) => buildCanvasNodeActionCatalog(node, context));
  const frontendCommands = nodes.flatMap((node) =>
    buildCanvasNodeActionCatalog(node, context).actions.map((entry) => commandCapability(entry, node)),
  );
  return {
    schema_version: "canvas_action_catalog.v1",
    frontend_command_catalog: frontendCommands,
    canvas_action_catalog: BASE_CANVAS_ACTION_CAPABILITIES,
    node_action_catalogs: nodeActionCatalogs,
  };
}

export { buildCanvasNodeActionCatalog };
export type { CanvasNodeActionCatalog, CanvasNodeActionCatalogEntry };
