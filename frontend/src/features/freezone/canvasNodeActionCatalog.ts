import {
  CANVAS_NODE_TYPES,
  NODE_TOOL_TYPES,
  resolveNodeSourceImageUrl,
  type CanvasNode,
  type CanvasEdge,
  type CanvasNodeType,
} from "@/features/canvas/domain/canvasNodes";
import { getDownstreamSpawnTypes } from "@/features/canvas/domain/nodeRegistry";
import {
  isPresetManagedNode,
  isSystemManagedNodeData,
} from "@/features/canvas/domain/mainlineNodeFlags";
import { getFreezoneImageModelsSnapshot } from "@/features/canvas/hooks/useFreezoneImageModels";
import { getFreezoneVideoModelsSnapshot } from "@/features/canvas/hooks/useFreezoneVideoModels";
import type { ModelOption } from "@/features/canvas/ui/ProviderModelPicker";
import {
  VIDEO_UPSCALE_DENOISE_OPTIONS,
  VIDEO_UPSCALE_RESOLUTIONS,
  VIDEO_UPSCALE_RESOLUTION_LABEL,
} from "@/features/canvas/application/videoUpscale";
import { BEAT_CONTEXT_AGENT_EDITABLE_FIELDS } from "@/features/freezone/canvasCommandNodeData";
import { isCommitCandidateData } from "@/features/freezone/commit/commitEligibility";
import { resolveInputsForSkill } from "@/features/freezone/context/skillNodeInputs";
import type { SkillDefinition, SkillInputRole } from "@/features/freezone/context/skillRoles";
import { STANDARD_TIME_OF_DAY_OPTIONS } from "@/lib/time-of-day";

export type CanvasNodeActionExecution = "chat_command" | "requires_confirmation" | "manual_ui" | "frontend_node";

export type CanvasNodeActionCatalogEntry = {
  action: string;
  execution: CanvasNodeActionExecution;
  description: string;
  command_type?: string;
  can_run_now?: boolean;
  preconditions?: Array<Record<string, unknown>>;
  blocked_reasons?: string[];
  instruction?: string;
  parameters?: Record<string, unknown>;
  result_effect?: Record<string, unknown>;
};

export type CanvasEditableFieldSchema = {
  type: "string" | "enum" | "number" | "boolean" | "object";
  label?: string;
  options?: unknown[];
  option_labels?: Record<string, string>;
  source?: string;
  context_request?: Record<string, unknown>;
  loading?: boolean;
  fallback?: boolean;
  current_value?: unknown;
  description?: string;
};

export type CanvasNodeActionCatalog = {
  node_id: string;
  node_type: CanvasNodeType | null;
  skill_id?: string;
  downstream_spawn_types: CanvasNodeType[];
  editable_fields: string[];
  editable_schema: Record<string, CanvasEditableFieldSchema>;
  actions: CanvasNodeActionCatalogEntry[];
};

export type CanvasNodeActionCatalogContext = {
  nodes?: readonly CanvasNode[];
  edges?: readonly CanvasEdge[];
};

const IMAGE_TOOL_NODE_TYPES = new Set<CanvasNodeType>([
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.exportImage,
]);

const IMAGE_ACTION_SIZE_OPTIONS = ["1K", "2K", "4K"] as const;
const GENERATOR_PROMPT_DESCRIPTION =
  "If this node has upstream text connected with prompt_for, this prompt is combined with upstream prompt_for text during generation; avoid duplicating the same content in both places. Prefer putting long editable prompts in the upstream input_text node, and use this field only for short non-overlapping modifiers or leave it empty. If this node has upstream image references, use @图片1, @图片2, etc. in the prompt to bind specific top reference thumbnails by their left-to-right order. For multiple images, declare each referenced image's role instead of saying only \"use the references\".";
const GENERATE_IMAGE_ACTION_DESCRIPTION =
  "Submit this image generation node using its current prompt/references. Before running, ensure upstream image references that matter are explicitly bound in the prompt with @图片N and each reference role is clear. This runs the same frontend flow as pressing the node submit button.";
const GENERATE_VIDEO_ACTION_DESCRIPTION =
  "Submit this video node using its current prompt/references/generation mode. Before running, ensure upstream image references that matter are explicitly bound in the prompt with @图片N and each reference role is clear; this is especially important for imageReference, firstLastFrame, and allReference modes. This runs the same frontend flow as pressing the node submit button.";

function hasString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRecord(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return Boolean(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uniqueNonEmpty(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = stringOrNull(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function beatContextHasMainlineTarget(node: CanvasNode): boolean {
  if (node.type !== CANVAS_NODE_TYPES.beatContext) return false;
  const data = recordOrNull(node.data) ?? {};
  const beatContext = recordOrNull(data.beat_context);
  if (data.context_scope === "standalone" || beatContext?.source === "standalone") return false;
  if (
    typeof data.projectId === "string" &&
    data.projectId.trim().length > 0 &&
    typeof data.episode === "number" &&
    typeof data.beat === "number"
  ) {
    return true;
  }
  const mainlineContexts = Array.isArray(data.mainline_context)
    ? data.mainline_context.map(recordOrNull).filter(isRecord)
    : [];
  return mainlineContexts.some((item) => item.kind === "beat");
}

function nodeHasImageSource(node: CanvasNode): boolean {
  return Boolean(resolveNodeSourceImageUrl(node) || hasString((node.data as { previewImageUrl?: unknown }).previewImageUrl));
}

function imageModelParameterSchema(): CanvasEditableFieldSchema {
  const snapshot = getFreezoneImageModelsSnapshot();
  return {
    type: "enum",
    label: "模型",
    options: snapshot.models.map((model) => model.id),
    option_labels: modelOptionLabels(snapshot.models),
    source: "GET /api/v1/projects/{project}/freezone/image/models",
    loading: snapshot.isLoading,
    fallback: snapshot.isFallback,
    description: "可选。必须使用 options 里的模型 id；不填使用该动作默认模型，不要写口语名或后端 apiModel。",
  };
}

const UPSCALE_PARAMETER_SCHEMA = {
  scale_factor: {
    type: "number",
    label: "放大倍率",
    options: [2, 4, 6],
    description: "默认 2。",
  },
  image_size: {
    type: "enum",
    label: "画质",
    options: IMAGE_ACTION_SIZE_OPTIONS,
    description: "默认 2K。",
  },
  get model() {
    return imageModelParameterSchema();
  },
};

const OUTPAINT_PARAMETER_SCHEMA = {
  target_aspect_ratio: {
    type: "enum",
    label: "目标比例",
    options: ["original", "1:1", "4:3", "3:4", "16:9", "9:16"],
    description: "默认 original。",
  },
  num_images: {
    type: "number",
    label: "生成数量",
    options: [1, 2, 3, 4],
    description: "默认 1。",
  },
  image_size: {
    type: "enum",
    label: "画质",
    options: IMAGE_ACTION_SIZE_OPTIONS,
    description: "默认 2K。",
  },
  get model() {
    return imageModelParameterSchema();
  },
};

const VIDEO_UPSCALE_PARAMETER_SCHEMA = {
  resolution: {
    type: "enum",
    label: "分辨率",
    options: VIDEO_UPSCALE_RESOLUTIONS,
    option_labels: {
      "1080p": "1080P",
      "2k": "2K",
      "4k": "4K",
    },
    description: "默认 1080p。",
  },
  denoise: {
    type: "enum",
    label: "降噪",
    options: VIDEO_UPSCALE_DENOISE_OPTIONS,
    option_labels: {
      none: "不降噪",
      "1x": "1x",
      "2x": "2x",
    },
    description: "默认 1x。",
  },
};

function videoUpscaleEditableSchema(node: CanvasNode): Record<string, CanvasEditableFieldSchema> {
  const data = node.data as {
    upscaleResolution?: unknown;
    upscaleDenoise?: unknown;
  };
  return {
    displayName: { type: "string", label: "显示名称" },
    upscaleResolution: {
      type: "enum",
      label: "分辨率",
      options: VIDEO_UPSCALE_RESOLUTIONS,
      option_labels: VIDEO_UPSCALE_RESOLUTION_LABEL,
      current_value: typeof data.upscaleResolution === "string" ? data.upscaleResolution : "1080p",
      description: "视频高清处理面板里的目标分辨率；修改高清分辨率时更新 upscaleResolution。",
    },
    upscaleDenoise: {
      type: "enum",
      label: "降噪",
      options: VIDEO_UPSCALE_DENOISE_OPTIONS,
      option_labels: {
        none: "不降噪",
        "1x": "1x",
        "2x": "2x",
      },
      current_value: typeof data.upscaleDenoise === "string" ? data.upscaleDenoise : "1x",
      description: "视频高清处理面板里的降噪强度；修改降噪时更新 upscaleDenoise。",
    },
  };
}

function uploadPickerAcceptForNode(node: CanvasNode): string {
  const data = recordOrNull(node.data) ?? {};
  const slotTarget = recordOrNull(data.slot_target);
  if (data.imageOnly === true || slotTarget?.kind === "frame" || hasString(data.imageUrl)) {
    return "image/*";
  }
  return "image/*,video/*,audio/*";
}

// Mirrors the backend Freezone skill registry output node_type contract:
// SuperTale/src/novelvideo/freezone/skill_registry.py.
// The action catalog is synchronous, so it cannot await GET freezone/skills here.
const KNOWN_SKILL_OUTPUT_NODE_TYPES: Record<string, CanvasNodeType[]> = {
  "freezone.sketch_from_context": [CANVAS_NODE_TYPES.imageGen],
  "freezone.sketch_from_director_combined": [CANVAS_NODE_TYPES.imageGen],
  "freezone.frame_from_context": [CANVAS_NODE_TYPES.imageGen],
  "freezone.set_selected_background": [CANVAS_NODE_TYPES.imageGen],
  "freezone.set_director_combined": [CANVAS_NODE_TYPES.imageGen],
  "freezone.scene_360": [CANVAS_NODE_TYPES.imageGen],
  "agent.review_frame": [CANVAS_NODE_TYPES.textAnnotation],
};

function minimalInput(role: SkillInputRole, required: boolean): SkillDefinition["inputs"][number] {
  return {
    role,
    label: role,
    accepts: {},
    required,
    cardinality: role === "identity" || role === "prop" ? "multi" : "single",
  };
}

// Mirrors the backend Freezone skill registry required-input contract:
// SuperTale/src/novelvideo/freezone/skill_registry.py.
const KNOWN_SKILL_DEFINITIONS: Record<string, SkillDefinition> = {
  "freezone.sketch_from_context": {
    id: "freezone.sketch_from_context",
    provider: "freezone_mainline",
    display_name: "根据当前背景生成草图",
    description: "根据 Beat 上下文和当前背景生成主线草图候选。",
    inputs: [minimalInput("beat_context", true), minimalInput("background", true)],
    outputs: [],
  },
  "freezone.sketch_from_director_combined": {
    id: "freezone.sketch_from_director_combined",
    provider: "freezone_mainline",
    display_name: "从导演合成图生成草图",
    description: "从 Beat 上下文和导演合成图生成主线草图候选。",
    inputs: [minimalInput("beat_context", true), minimalInput("director_combined", true)],
    outputs: [],
  },
  "freezone.frame_from_context": {
    id: "freezone.frame_from_context",
    provider: "freezone_mainline",
    display_name: "从镜头上下文生成分镜",
    description: "根据 Beat 上下文、草图和参考素材生成主线分镜候选。",
    inputs: [
      minimalInput("beat_context", true),
      minimalInput("sketch", true),
      minimalInput("background", false),
      minimalInput("identity", false),
      minimalInput("prop", false),
    ],
    outputs: [],
  },
  "freezone.set_selected_background": {
    id: "freezone.set_selected_background",
    provider: "freezone_mainline",
    display_name: "设为当前背景",
    description: "将明确指定的图片设为当前 Beat 的背景。",
    inputs: [minimalInput("beat_context", true), minimalInput("source_image", true)],
    outputs: [],
  },
  "freezone.set_director_combined": {
    id: "freezone.set_director_combined",
    provider: "freezone_mainline",
    display_name: "设为导演合成图",
    description: "将明确指定的图片设为当前 Beat 的 3GS 导演合成图。",
    inputs: [minimalInput("beat_context", true), minimalInput("source_image", true)],
    outputs: [],
  },
  "freezone.scene_360": {
    id: "freezone.scene_360",
    provider: "freezone_mainline",
    display_name: "生成场景 360 全景",
    description: "根据场景主图生成 2:1 场景全景候选。",
    inputs: [
      minimalInput("scene", false),
      minimalInput("scene_master", true),
      minimalInput("scene_reverse_master", false),
    ],
    outputs: [],
  },
  "agent.review_frame": {
    id: "agent.review_frame",
    provider: "agent",
    display_name: "审核分镜",
    description: "根据 Beat 上下文审核分镜候选。",
    inputs: [minimalInput("beat_context", true), minimalInput("frame", true)],
    outputs: [],
  },
};

function skillOutputProxyNodeTypes(node: CanvasNode): CanvasNodeType[] {
  if (node.type !== CANVAS_NODE_TYPES.skill) return [];
  const skillId = stringOrNull((node.data as { skill_id?: unknown }).skill_id);
  return skillId ? KNOWN_SKILL_OUTPUT_NODE_TYPES[skillId] ?? [] : [];
}

const IMAGE_LIKE_SKILL_INPUT_ROLES = new Set<SkillInputRole>([
  "background",
  "director_combined",
  "frame",
  "scene",
  "scene_master",
  "scene_reverse_master",
  "sketch",
  "source_image",
]);

const SKILL_INPUT_ROLE_LABELS: Partial<Record<SkillInputRole, string>> = {
  background: "背景",
  director_combined: "导演合成图",
  frame: "分镜",
  scene: "场景",
  scene_master: "场景主图",
  scene_reverse_master: "场景反打图",
  sketch: "草图",
  source_image: "源图片",
};

function skillRunReadinessForCatalog(
  node: CanvasNode,
  context: CanvasNodeActionCatalogContext | undefined,
): {
  canRunNow: boolean;
  preconditions: Array<Record<string, unknown>>;
  blockedReasons: string[];
} | null {
  if (node.type !== CANVAS_NODE_TYPES.skill) return null;
  const skillId = stringOrNull((node.data as { skill_id?: unknown }).skill_id);
  const skill = skillId ? KNOWN_SKILL_DEFINITIONS[skillId] : undefined;
  if (!skill || !context?.nodes?.length || !context?.edges?.length) return null;
  const incomingEdges = context.edges.filter((edge) => edge.target === node.id);
  const nodesById = new Map(context.nodes.map((item) => [item.id, item] as const));
  const resolvedInputs = resolveInputsForSkill(skill, node, incomingEdges, nodesById);
  const preconditions: Array<Record<string, unknown>> = [];
  const blockedReasons: string[] = [];
  for (const input of skill.inputs) {
    if (!input.required) continue;
    const matched = resolvedInputs.filter((item) => item.role === input.role);
    if (matched.length === 0) {
      const reason = `必需输入 ${input.role} 未连接。`;
      blockedReasons.push(reason);
      preconditions.push({
        type: "required_input",
        role: input.role,
        status: "missing",
        message: reason,
      });
      continue;
    }
    if (input.role === "beat_context") {
      const ready = matched.some((item) => item.beat_context || item.mainline_context?.length);
      if (!ready) {
        const sourceIds = matched.map((item) => item.node_id);
        const reason = `必需输入 beat_context 未提供有效 Beat 上下文。`;
        blockedReasons.push(reason);
        preconditions.push({
          type: "required_upstream_context",
          role: input.role,
          node_ids: sourceIds,
          required_field: "beat_context",
          status: "missing",
          message: reason,
        });
      }
      continue;
    }
    if (IMAGE_LIKE_SKILL_INPUT_ROLES.has(input.role)) {
      const ready = matched.some((item) => item.image_url);
      if (!ready) {
        const sourceIds = matched.map((item) => item.node_id);
        const roleLabel = SKILL_INPUT_ROLE_LABELS[input.role] ?? input.role;
        const reason = `${input.role} 输入尚未就绪：上游${roleLabel}节点缺少 imageUrl。`;
        blockedReasons.push(reason);
        preconditions.push({
          type: "required_upstream_output",
          role: input.role,
          node_ids: sourceIds,
          required_field: "imageUrl",
          status: "missing",
          message: reason,
        });
      }
    }
  }
  return {
    canRunNow: blockedReasons.length === 0,
    preconditions,
    blockedReasons,
  };
}

function directorWorldGenerationImageUrl(node: CanvasNode): string | null {
  const data = node.data as { imageUrl?: unknown; referenceImageUrl?: unknown };
  if (node.type === CANVAS_NODE_TYPES.imageGen) {
    if (typeof data.imageUrl === "string" && data.imageUrl.length > 0) return data.imageUrl;
    if (typeof data.referenceImageUrl === "string" && data.referenceImageUrl.length > 0) return data.referenceImageUrl;
    return null;
  }
  if (
    node.type === CANVAS_NODE_TYPES.upload ||
    node.type === CANVAS_NODE_TYPES.imageEdit ||
    node.type === CANVAS_NODE_TYPES.exportImage ||
    node.type === CANVAS_NODE_TYPES.storyboardGen
  ) {
    return typeof data.imageUrl === "string" && data.imageUrl.length > 0 ? data.imageUrl : null;
  }
  return null;
}

function hasConnectedImageUpstream(
  node: CanvasNode,
  context: CanvasNodeActionCatalogContext | undefined,
): boolean {
  if (node.type !== CANVAS_NODE_TYPES.threeDWorld) return false;
  const nodes = context?.nodes;
  const edges = context?.edges;
  if (!nodes?.length || !edges?.length) return false;
  const nodeById = new Map(nodes.map((item) => [item.id, item] as const));
  return edges.some((edge) => {
    if (edge.target !== node.id) return false;
    const source = nodeById.get(edge.source);
    return Boolean(source && directorWorldGenerationImageUrl(source));
  });
}

const IMAGE_SIZE_OPTIONS = ["1K", "2K", "4K"] as const;
const IMAGE_QUALITY_OPTIONS = ["low", "medium", "high"] as const;
const IMAGE_ASPECT_RATIO_OPTIONS = [
  "auto",
  "1:1",
  "9:16",
  "16:9",
  "3:4",
  "4:3",
  "3:2",
  "2:3",
  "4:5",
  "5:4",
  "21:9",
] as const;
const IMAGE_COUNT_OPTIONS = [1, 2, 4] as const;
const VIDEO_ASPECT_RATIO_OPTIONS = [
  "auto",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
  "21:9",
] as const;
const VIDEO_QUALITY_OPTIONS = ["480P", "720P", "1080P"] as const;
const VIDEO_COUNT_OPTIONS = [1, 2, 4] as const;
const VIDEO_GEN_MODE_OPTIONS = [
  "textToVideo",
  "allReference",
  "imageToVideo",
  "firstLastFrame",
  "imageReference",
] as const;
const VIDEO_GEN_MODE_OPTION_LABELS: Record<(typeof VIDEO_GEN_MODE_OPTIONS)[number], string> = {
  textToVideo: "文生视频",
  allReference: "全能参考",
  imageToVideo: "图生视频",
  firstLastFrame: "首尾帧视频",
  imageReference: "图片参考视频",
};

function modelOptionLabels(models: ModelOption[]): Record<string, string> {
  return Object.fromEntries(models.map((model) => [model.id, model.label]));
}

function imageModelSchema(node: CanvasNode): CanvasEditableFieldSchema {
  const snapshot = getFreezoneImageModelsSnapshot();
  return {
    type: "enum",
    label: "模型",
    options: snapshot.models.map((model) => model.id),
    option_labels: modelOptionLabels(snapshot.models),
    source: "GET /api/v1/projects/{project}/freezone/image/models",
    loading: snapshot.isLoading,
    fallback: snapshot.isFallback,
    current_value: (node.data as { model?: unknown }).model ?? null,
    description: "图片模型必须使用 options 里的 model id；不要使用口语名或后端 apiModel，例如不要写 nanobanana。",
  };
}

function videoModelSchema(node: CanvasNode): CanvasEditableFieldSchema {
  const snapshot = getFreezoneVideoModelsSnapshot();
  return {
    type: "enum",
    label: "模型",
    options: snapshot.models.map((model) => model.id),
    option_labels: modelOptionLabels(snapshot.models),
    source: "GET /api/v1/projects/{project}/freezone/video/models",
    loading: snapshot.isLoading,
    fallback: snapshot.isFallback,
    current_value: (node.data as { model?: unknown }).model ?? null,
    description: "视频模型必须使用 options 里的 model id；不要使用口语名或后端 apiModel。",
  };
}

function videoAspectRatioSchema(node: CanvasNode): CanvasEditableFieldSchema {
  return {
    type: "enum",
    label: "视频比例",
    options: [...VIDEO_ASPECT_RATIO_OPTIONS],
    current_value: (node.data as { aspectRatio?: unknown }).aspectRatio ?? "auto",
    description: "视频节点底部参数里的比例；修改视频比例时更新 aspectRatio，不要改模型来间接实现。",
  };
}

function videoQualitySchema(node: CanvasNode): CanvasEditableFieldSchema {
  const snapshot = getFreezoneVideoModelsSnapshot();
  const currentModelId = (node.data as { model?: unknown }).model;
  const currentModel =
    typeof currentModelId === "string"
      ? snapshot.models.find((model) => model.id === currentModelId)
      : null;
  const options = (currentModel?.resolutionOptions ?? [])
    .map((value) => value.trim().toUpperCase())
    .filter((value): value is (typeof VIDEO_QUALITY_OPTIONS)[number] =>
      (VIDEO_QUALITY_OPTIONS as readonly string[]).includes(value),
    );
  const resolvedOptions = options.length > 0 ? options : [...VIDEO_QUALITY_OPTIONS];
  return {
    type: "enum",
    label: "清晰度",
    options: resolvedOptions,
    current_value: (node.data as { quality?: unknown }).quality ?? null,
    description: "视频节点底部参数里的清晰度；使用当前模型支持的分辨率选项，例如 480P/720P/1080P。",
  };
}

function videoDurationSchema(node: CanvasNode): CanvasEditableFieldSchema {
  const snapshot = getFreezoneVideoModelsSnapshot();
  const currentModelId = (node.data as { model?: unknown }).model;
  const currentModel =
    typeof currentModelId === "string"
      ? snapshot.models.find((model) => model.id === currentModelId)
      : null;
  const minDuration = Number.isFinite(currentModel?.minDuration)
    ? Number(currentModel?.minDuration)
    : null;
  const maxDuration = Number.isFinite(currentModel?.maxDuration)
    ? Number(currentModel?.maxDuration)
    : null;
  const durationHint = [minDuration, maxDuration].every((value) => typeof value === "number")
    ? `当前模型支持 ${minDuration}-${maxDuration} 秒。`
    : "当前模型的可用时长区间由前端节点约束。";
  return {
    type: "number",
    label: "时长秒数",
    current_value: (node.data as { durationSec?: unknown }).durationSec ?? null,
    description: `${durationHint} 修改时更新 durationSec。`,
  };
}

function videoGenModeSchema(node: CanvasNode): CanvasEditableFieldSchema {
  return {
    type: "enum",
    label: "视频生成模式",
    options: [...VIDEO_GEN_MODE_OPTIONS],
    option_labels: VIDEO_GEN_MODE_OPTION_LABELS,
    current_value: (node.data as { genMode?: unknown }).genMode ?? "textToVideo",
    description:
      "决定视频节点如何消费上游输入。textToVideo=只用当前提示词；imageToVideo=以图片作为主要输入；firstLastFrame=需要首帧和尾帧；allReference=可同时参考图片/视频/音频；imageReference=以图片作为参考约束。改视频模式时更新 genMode，不要把“模式”误改成 model。",
  };
}

function audioVoiceRefSchema(node: CanvasNode): CanvasEditableFieldSchema {
  const data = node.data as { voiceRef?: unknown };
  return {
    type: "object",
    label: "音色引用",
    source: "canvas_context_request.v1 audio_voice_options",
    context_request: {
      schema_version: "canvas_context_request.v1",
      requests: [{ type: "audio_voice_options", node_id: node.id }],
    },
    current_value: data.voiceRef ?? null,
    description:
      "音频节点在 speechMode=clone 时使用 voiceRef 对象选择音色，不使用 voiceId 字符串。更换音色前必须先返回 context_request 指定的 canvas_context_request.v1；拿到 options 后，把选项里的 data 原样用于 update_node_data，并同时设置 speechMode=clone。不要用 run_node_action 获取音色选项。",
  };
}

function beatContextEditableSchema(node: CanvasNode): Record<string, CanvasEditableFieldSchema> {
  const data = recordOrNull(node.data) ?? {};
  const snapshot = recordOrNull(data.snapshot) ?? {};
  const editFields = recordOrNull(data.beat_edit_fields) ?? {};
  const mainlineContexts = Array.isArray(data.mainline_context)
    ? data.mainline_context.map(recordOrNull).filter(isRecord)
    : [];
  const currentSceneId =
    stringOrNull(editFields.scene_id) ??
    stringOrNull(snapshot.sceneId) ??
    stringOrNull(data.sceneId) ??
    stringOrNull(mainlineContexts.find((item) => item.kind === "beat")?.sceneId) ??
    "";
  const currentVariantId =
    stringOrNull(editFields.scene_variant_id) ??
    stringOrNull(snapshot.sceneVariantId) ??
    stringOrNull(data.sceneVariantId) ??
    stringOrNull(mainlineContexts.find((item) => item.kind === "beat")?.sceneVariantId) ??
    "";
  const sceneOptions = uniqueNonEmpty([
    currentSceneId && currentVariantId ? `${currentSceneId}\u0000${currentVariantId}` : currentSceneId,
    ...mainlineContexts
      .filter((item) => item.kind === "scene" || item.kind === "beat")
      .map((item) => {
        const sceneId = stringOrNull(item.sceneId);
        const variantId = stringOrNull(item.sceneVariantId) ?? "";
        return sceneId && variantId ? `${sceneId}\u0000${variantId}` : sceneId;
      }),
  ]).map((key) => {
    const [sceneId, variantId = ""] = key.split("\u0000");
    return { scene_id: sceneId, variant_id: variantId };
  });
  const currentTimeOfDay =
    stringOrNull(editFields.time_of_day) ??
    stringOrNull(snapshot.timeOfDay) ??
    stringOrNull(data.timeOfDay) ??
    stringOrNull(mainlineContexts.find((item) => item.kind === "beat")?.timeOfDay) ??
    "";
  return {
    visual_description: {
      type: "string",
      label: "起始画面",
      current_value:
        stringOrNull(editFields.visual_description) ??
        stringOrNull(snapshot.visualDescription) ??
        stringOrNull(data.content) ??
        "",
      description: "镜头上下文节点的起始画面草稿。只修改画布本地草稿；如需写回主线，再运行 sync_beat_context_to_mainline。",
    },
    scene_ref: {
      type: "object",
      label: "场景",
      options: sceneOptions,
      current_value: { scene_id: currentSceneId, variant_id: currentVariantId },
      description: "镜头上下文节点的场景草稿，格式为 {scene_id, variant_id}。只允许修改这个字段，不要修改出场身份或出场道具。",
    },
    time_of_day: {
      type: "enum",
      label: "时间",
      options: ["", ...STANDARD_TIME_OF_DAY_OPTIONS],
      option_labels: { "": "未设置" },
      current_value: currentTimeOfDay,
      description: "镜头上下文节点的时间草稿。必须从枚举中选择；空字符串表示未设置。",
    },
  };
}

function editableSchemaForNode(node: CanvasNode): Record<string, CanvasEditableFieldSchema> {
  if (isPresetManagedNode(node) && node.type !== CANVAS_NODE_TYPES.beatContext) return {};
  switch (node.type) {
    case CANVAS_NODE_TYPES.textAnnotation:
      return {
        displayName: { type: "string", label: "显示名称" },
        title: { type: "string", label: "标题" },
        content: { type: "string", label: "内容" },
        text: { type: "string", label: "文本" },
        semanticOutputRole: {
          type: "enum",
          label: "语义输出角色",
          options: ["planning_text", "input_text", "context_text"],
          description:
            "How downstream nodes should interpret this text: planning_text for briefs, outlines, notes, or planning material; input_text for direct prompts or scripts consumed by generators; context_text for auxiliary background, constraints, style guides, or reference notes.",
        },
      };
    case CANVAS_NODE_TYPES.beatContext:
      return beatContextEditableSchema(node);
    case CANVAS_NODE_TYPES.imageGen:
      return {
        displayName: { type: "string", label: "显示名称" },
        prompt: { type: "string", label: "提示词", description: GENERATOR_PROMPT_DESCRIPTION },
        negativePrompt: { type: "string", label: "反向提示词" },
        model: imageModelSchema(node),
        size: {
          type: "enum",
          label: "分辨率",
          options: [...IMAGE_SIZE_OPTIONS],
          description: "图片节点底部参数里的分辨率；必须使用 1K/2K/4K，不要写 1024x1024。",
        },
        quality: {
          type: "enum",
          label: "画质",
          options: [...IMAGE_QUALITY_OPTIONS],
          description: "图片节点底部参数里的画质，仅对支持画质档位的模型生效。",
        },
        aspectRatio: {
          type: "enum",
          label: "比例",
          options: [...IMAGE_ASPECT_RATIO_OPTIONS],
          description: "图片节点底部参数里的比例；修改分辨率时不要顺手改比例。",
        },
        count: { type: "enum", label: "生成数量", options: [...IMAGE_COUNT_OPTIONS] },
      };
    case CANVAS_NODE_TYPES.imageEdit:
      return {
        displayName: { type: "string", label: "显示名称" },
        prompt: { type: "string", label: "提示词", description: GENERATOR_PROMPT_DESCRIPTION },
        negativePrompt: { type: "string", label: "反向提示词" },
        model: imageModelSchema(node),
        size: {
          type: "enum",
          label: "分辨率",
          options: [...IMAGE_SIZE_OPTIONS],
          description: "图片编辑节点的分辨率；必须使用 1K/2K/4K，不要写 1024x1024。",
        },
        quality: { type: "enum", label: "画质", options: [...IMAGE_QUALITY_OPTIONS] },
        requestAspectRatio: {
          type: "enum",
          label: "比例",
          options: [...IMAGE_ASPECT_RATIO_OPTIONS],
          description: "图片编辑节点使用 requestAspectRatio 保存目标比例。",
        },
        count: { type: "enum", label: "生成数量", options: [...IMAGE_COUNT_OPTIONS] },
      };
    case CANVAS_NODE_TYPES.video:
      if ((node.data as { isUpscaleNode?: unknown }).isUpscaleNode === true) {
        return videoUpscaleEditableSchema(node);
      }
      return {
        displayName: { type: "string", label: "显示名称" },
        prompt: { type: "string", label: "提示词", description: GENERATOR_PROMPT_DESCRIPTION },
        genMode: videoGenModeSchema(node),
        model: videoModelSchema(node),
        aspectRatio: videoAspectRatioSchema(node),
        quality: videoQualitySchema(node),
        durationSec: videoDurationSchema(node),
        generateAudio: {
          type: "boolean",
          label: "生成音频",
          current_value: (node.data as { generateAudio?: unknown }).generateAudio ?? false,
        },
        humanReview: {
          type: "boolean",
          label: "真人审核",
          current_value: (node.data as { humanReview?: unknown }).humanReview ?? false,
          description: "图生视频时在模型支持的情况下启用真人内容审核。",
        },
        count: {
          type: "enum",
          label: "生成数量",
          options: [...VIDEO_COUNT_OPTIONS],
          current_value: (node.data as { count?: unknown }).count ?? 1,
        },
      };
    case CANVAS_NODE_TYPES.audio:
      return {
        displayName: { type: "string", label: "显示名称" },
        audioKind: {
          type: "enum",
          label: "音频类型",
          options: ["speech", "music"],
          description: "speech 表示文本转语音；music 表示文字生成音乐。",
        },
        speechMode: {
          type: "enum",
          label: "语音模式",
          options: ["clone"],
          description:
            "仅 audioKind=speech 时生效。虾画只使用自定义声线；未选择有效 voiceRef 时跳过语音生成。",
        },
        text: { type: "string", label: "文本" },
        emotionPrompt: { type: "string", label: "情绪提示" },
        voiceRef: audioVoiceRefSchema(node),
        voiceLabel: {
          type: "string",
          label: "音色名称",
          description: "音色展示名，通常随 voiceRef 一起从 audio_voice_options 选项的 data 中写入。",
        },
        voiceLanguage: {
          type: "string",
          label: "语言",
          description: "音色语言标签，通常随 voiceRef 一起从 audio_voice_options 选项的 data 中写入。",
        },
        musicLengthMs: {
          type: "number",
          label: "音乐时长毫秒",
          description: "仅 audioKind=music 时生效；页面默认 30000ms。",
        },
        forceInstrumental: {
          type: "boolean",
          label: "纯音乐",
          description: "仅 audioKind=music 时生效；默认 true。",
        },
        respectSectionsDurations: {
          type: "boolean",
          label: "遵守段落时长",
          description: "仅 audioKind=music 时生效；默认 true。",
        },
      };
    case CANVAS_NODE_TYPES.script:
      return {
        displayName: { type: "string", label: "显示名称" },
        prompt: {
          type: "string",
          label: "生成提示词",
          description: "故事脚本生成节点的主要输入；普通自由格式文本请使用 textAnnotationNode.content。",
        },
        content: { type: "string", label: "内容" },
      };
    case CANVAS_NODE_TYPES.videoCompose:
      return {
        displayName: { type: "string", label: "显示名称" },
        title: { type: "string", label: "标题" },
      };
    case CANVAS_NODE_TYPES.threeDWorld:
      return {
        displayName: { type: "string", label: "显示名称" },
        prompt: {
          type: "string",
          label: "提示词",
          description: "3D 世界节点的备注/生成提示；当前 3GS 生成主要依赖上游图片。",
        },
        plyKind: {
          type: "enum",
          label: "3GS 来源类型",
          options: ["master", "reverse", "pano"],
          description: "master/reverse 生成单面 3GS；pano 表示上游是 360 全景图。",
        },
      };
    case CANVAS_NODE_TYPES.skill:
      return {
        displayName: { type: "string", label: "显示名称" },
        parameters: { type: "object", label: "参数" },
      };
    default:
      return { displayName: { type: "string", label: "显示名称" } };
  }
}

function editableFieldsForNode(node: CanvasNode): string[] {
  return Object.keys(editableSchemaForNode(node));
}

function canUpdateNodeDataViaChat(node: CanvasNode): boolean {
  if (node.type === CANVAS_NODE_TYPES.beatContext) return editableFieldsForNode(node).length > 0;
  return !isPresetManagedNode(node) && editableFieldsForNode(node).length > 0;
}

function addChatCommandActions(node: CanvasNode, actions: CanvasNodeActionCatalogEntry[]): void {
  if (
    node.type !== CANVAS_NODE_TYPES.videoCompose &&
    node.type !== CANVAS_NODE_TYPES.threeDWorld &&
    node.type !== CANVAS_NODE_TYPES.group
  ) {
    actions.push({
      action: "add_next_node",
      execution: "chat_command",
      command_type: "add_next_node",
      description:
        "Create and connect one downstream node from this source node. Use this when the source should be consumed by the new node as input, reference, context, or media. For image modification or variants, add an imageGenNode or imageEditNode downstream from the source image so the source image is used as the visual reference. Choose node_type from this catalog's downstream_spawn_types, then request node_create_schema for that node_type before filling data. Use create_node instead for standalone nodes.",
      parameters: {
        source_node_id: node.id,
        node_type_schema: {
          type: "enum",
          options_source: "downstream_spawn_types",
          description:
            "Required for add_next_node. Must be one value from this catalog's downstream_spawn_types.",
        },
        data_schema_source: {
          tool: "freezone_get_node_create_schema",
          request: {
            type: "node_create_schema",
            node_type: "<selected node_type>",
          },
        },
      },
    });
  }

  if (canUpdateNodeDataViaChat(node)) {
    actions.push({
      action: "update_node_data",
      execution: "chat_command",
      command_type: "update_node_data",
      description:
        node.type === CANVAS_NODE_TYPES.beatContext
          ? `更新镜头上下文节点草稿字段。只允许 data 包含 ${BEAT_CONTEXT_AGENT_EDITABLE_FIELDS.join(", ")}；出场身份和出场道具不开放给 agent 编辑。`
          : "Update editable data fields on this node. Reserved mainline/projection fields are ignored.",
      parameters: {
        node_id: node.id,
        data: "object",
      },
    });
  }

  if (!isSystemManagedNodeData(node.data)) {
    actions.push({
      action: "delete_node",
      execution: "requires_confirmation",
      command_type: "delete_nodes",
      description: "Delete this node. The UI asks the user to confirm before applying.",
      parameters: {
        node_ids: [node.id],
      },
    });
  }

  if (beatContextHasMainlineTarget(node)) {
    actions.push({
      action: "sync_beat_context_to_mainline",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "把当前镜头上下文节点草稿同步到主线。通常先 update_node_data 修改起始画面/场景/时间，再运行这个动作。",
      parameters: {
        node_id: node.id,
      },
    });
  }
}

function addImageToolActions(node: CanvasNode, actions: CanvasNodeActionCatalogEntry[]): void {
  if (!node.type || !IMAGE_TOOL_NODE_TYPES.has(node.type) || !nodeHasImageSource(node)) return;
  actions.push(
    {
      action: "download_image",
      execution: "frontend_node",
      command_type: "run_node_action",
      description:
        "Trigger a browser download for this image node's current media immediately. No extra toolbar confirmation, UI panel, node creation, or generation is needed.",
      parameters: { node_id: node.id },
    },
    {
      action: "open_crop_tool",
      execution: "manual_ui",
      command_type: "run_node_action",
      description: "Open the crop tool for this image node. Current chat can request this to open the UI; it does not directly run generation or export.",
      parameters: { node_id: node.id, tool_type: NODE_TOOL_TYPES.crop },
    },
    {
      action: "open_annotate_tool",
      execution: "manual_ui",
      command_type: "run_node_action",
      description: "Open the annotate tool for this image node. Current chat can request this to open the UI; it does not directly run generation or export.",
      parameters: { node_id: node.id, tool_type: NODE_TOOL_TYPES.annotate },
    },
    {
      action: "open_split_storyboard_tool",
      execution: "manual_ui",
      command_type: "run_node_action",
      description:
        "打开分格抽取面板，让用户手动设置行列/分隔线并执行抽取。This only opens the UI and does not directly generate a new storyboard image.",
      parameters: { node_id: node.id, tool_type: NODE_TOOL_TYPES.splitStoryboard },
    },
    {
      action: "run_matting_tool",
      execution: "frontend_node",
      command_type: "run_node_action",
      description:
        "抠图 / 去背景 / 移除背景 / 透明背景：Run foreground matting on this image node, create a transparent-background PNG, and add a downstream export image node.",
      parameters: { node_id: node.id },
    },
    {
      action: "run_upscale_tool",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Run image upscale from this image node. Creates a downstream upscale result node and writes the generated image there. Does not open UI.",
      parameters: {
        node_id: node.id,
        result_policy: "update_created_result_node",
        parameter_schema: UPSCALE_PARAMETER_SCHEMA,
        defaults: { scale_factor: 2, image_size: "2K" },
      },
    },
    {
      action: "open_redraw_tool",
      execution: "manual_ui",
      command_type: "run_node_action",
      description: "Open the redraw panel for this image node. Current chat can request this to open the UI; it does not directly run generation or export.",
      parameters: { node_id: node.id },
    },
    {
      action: "open_erase_tool",
      execution: "manual_ui",
      command_type: "run_node_action",
      description: "Open the erase panel for this image node. Current chat can request this to open the UI; it does not directly run generation or export.",
      parameters: { node_id: node.id },
    },
    {
      action: "run_outpaint_tool",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Run image outpaint from this image node. Creates a downstream export image node. Does not open UI.",
      parameters: {
        node_id: node.id,
        result_policy: "spawn_child",
        parameter_schema: OUTPAINT_PARAMETER_SCHEMA,
        defaults: { target_aspect_ratio: "original", num_images: 1, image_size: "2K" },
      },
    },
    {
      action: "run_scene360_tool",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "全景 / 360 全景：submit 360 panorama generation from this image node with default parameters. Creates an export image node and a 360 viewer node. Use this when the user asks to use the panorama feature.",
      parameters: {
        node_id: node.id,
        result_policy: "spawn_child",
        defaults: { aspect_ratio: "2:1", image_size: "2K" },
      },
    },
    {
      action: "open_multi_angle_tool",
      execution: "manual_ui",
      command_type: "run_node_action",
      description: "多维度 / 多角度 / 多视图 / 多视角：open the multi-angle panel for this image node. Current chat can request this to open the UI; it does not directly run generation or export.",
      parameters: { node_id: node.id },
    },
    {
      action: "open_light_tool",
      execution: "manual_ui",
      command_type: "run_node_action",
      description: "Open the lighting panel for this image node. Current chat can request this to open the UI; it does not directly run generation or export.",
      parameters: { node_id: node.id },
    },
    {
      action: "open_rotate_tool",
      execution: "manual_ui",
      command_type: "run_node_action",
      description: "Open the rotate panel for this image node. Current chat can request this to open the UI; it does not directly run generation or export.",
      parameters: { node_id: node.id },
    },
    {
      action: "run_grid_multi_camera",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Generate a multi-camera nine-grid image from this image node with default parameters. Does not open UI.",
      parameters: { node_id: node.id, grid_action: "multiCameraGrid", result_policy: "spawn_child" },
    },
    {
      action: "run_grid_plot_four",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Generate a story pitch four-grid image from this image node with default parameters. Does not open UI.",
      parameters: { node_id: node.id, grid_action: "plotFourGrid", result_policy: "spawn_child" },
    },
    {
      action: "run_grid_face_three_view",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Generate a face three-view image from this image node with default parameters. Does not open UI.",
      parameters: { node_id: node.id, grid_action: "faceThreeView", result_policy: "spawn_child" },
    },
    {
      action: "run_grid_product_three_view",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Generate a product three-view image from this image node with default parameters. Does not open UI.",
      parameters: { node_id: node.id, grid_action: "productThreeView", result_policy: "spawn_child" },
    },
    {
      action: "run_grid_serial_storyboard_25",
      execution: "frontend_node",
      command_type: "run_node_action",
      description:
        "Generate a new 25-frame serial storyboard image from this image node with default parameters. Does not open UI. 不是分格抽取；如果用户说“分格抽取/抽取分格/打开分格”，use open_split_storyboard_tool instead.",
      parameters: { node_id: node.id, grid_action: "serialStoryboard25", result_policy: "spawn_child" },
    },
    {
      action: "run_grid_cinematic_light_correction",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Generate a cinematic light correction from this image node with default parameters. Does not open UI.",
      parameters: { node_id: node.id, grid_action: "cinematicLightCorrection", result_policy: "spawn_child" },
    },
    {
      action: "run_grid_character_three_view",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Generate a character three-view image from this image node with default parameters. Does not open UI.",
      parameters: { node_id: node.id, grid_action: "characterThreeView", result_policy: "spawn_child" },
    },
    {
      action: "run_grid_scene_setting_sheet",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Generate a scene setting sheet from this image node with default parameters. Does not open UI.",
      parameters: { node_id: node.id, grid_action: "sceneSettingSheet", result_policy: "spawn_child" },
    },
    {
      action: "run_grid_frame_projection_3s_later",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Generate a frame projection 3 seconds later from this image node with default parameters. Does not open UI.",
      parameters: { node_id: node.id, grid_action: "frameProjection3sLater", result_policy: "spawn_child" },
    },
    {
      action: "run_grid_frame_projection_5s_earlier",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Generate a frame projection 5 seconds earlier from this image node with default parameters. Does not open UI.",
      parameters: { node_id: node.id, grid_action: "frameProjection5sEarlier", result_policy: "spawn_child" },
    },
  );
}

function addFrontendNodeActions(
  node: CanvasNode,
  actions: CanvasNodeActionCatalogEntry[],
  context?: CanvasNodeActionCatalogContext,
): void {
  if (node.type === CANVAS_NODE_TYPES.textAnnotation) {
    const mode = (node.data as { mode?: unknown }).mode;
    const workflowCatalog = (node.data as { workflowCatalog?: unknown }).workflowCatalog;
    const recipeId = workflowCatalog && typeof workflowCatalog === "object"
      ? (workflowCatalog as { recipeId?: unknown }).recipeId
      : null;
    actions.push({
      action: "translate_text",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Translate this text node content using the same frontend flow as the node translate button.",
      parameters: { node_id: node.id },
    });
    if (typeof recipeId === "string" && recipeId.trim()) {
      actions.push({
        action: "generate_text",
        execution: "frontend_node",
        command_type: "run_node_action",
        description: "Generate this workflow text node through its catalog Recipe.",
        parameters: { node_id: node.id },
      });
    }
    if (mode === "textToVideo") {
      actions.push({
        action: "generate_text_video",
        execution: "frontend_node",
        command_type: "run_node_action",
        description: "Submit this text-to-video text node and generate through its downstream video node.",
        parameters: { node_id: node.id },
      });
    }
    if (mode === "imageToPrompt") {
      actions.push({
        action: "reverse_prompt",
        execution: "frontend_node",
        command_type: "run_node_action",
        description: "Run image-to-prompt on this text node using its upstream image reference.",
        parameters: { node_id: node.id },
      });
    }
  }

  if (node.type === CANVAS_NODE_TYPES.upload) {
    actions.push({
      action: "open_upload_picker",
      execution: "manual_ui",
      command_type: "run_node_action",
      description:
        "打开该上传节点的本地文件选择器。用户选择文件后，前端复用上传节点原流程处理，并把选择/上传结果返回给 agent；agent 不能直接指定本地文件路径。",
      parameters: {
        node_id: node.id,
        accept: uploadPickerAcceptForNode(node),
      },
    });
  }

  if (node.type === CANVAS_NODE_TYPES.script) {
    actions.push({
      action: "generate_story_script",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Submit this script node and generate a structured story script table from its prompt and upstream references.",
      parameters: { node_id: node.id },
    });
  }

  if (node.type === CANVAS_NODE_TYPES.skill) {
    const skillId = stringOrNull((node.data as { skill_id?: unknown }).skill_id);
    const readiness = skillId ? skillRunReadinessForCatalog(node, context) : null;
    if (skillId && readiness) {
      actions.push({
        action: "run_skill",
        execution: "frontend_node",
        command_type: "run_node_action",
        can_run_now: readiness.canRunNow,
        preconditions: readiness.preconditions,
        blocked_reasons: readiness.blockedReasons,
        instruction: readiness.canRunNow
          ? "can_run_now=true，可以 emit run_node_action 执行此技能。"
          : "can_run_now=false 时不要 emit run_node_action；先完成 blocked_reasons 指向的上游输入后再重新请求 node_action_catalog 或 validate_canvas_commands。",
        description:
          "Run this skill node only after required upstream inputs are connected and completed. The frontend submits the skill and creates output nodes when results are ready.",
        parameters: {
          node_id: node.id,
          skill_id: skillId,
          result_policy: "spawn_outputs",
        },
      });
    }
  }

  if (node.type === CANVAS_NODE_TYPES.imageGen) {
    actions.push({
      action: "generate_image",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: GENERATE_IMAGE_ACTION_DESCRIPTION,
      parameters: { node_id: node.id },
    });
  }

  if (node.type === CANVAS_NODE_TYPES.video) {
    actions.push({
      action: "generate_video",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: GENERATE_VIDEO_ACTION_DESCRIPTION,
      parameters: { node_id: node.id },
    });
  }

  if (node.type === CANVAS_NODE_TYPES.audio) {
    actions.push({
      action: "translate_text",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Translate this audio node text using the same frontend flow as the node translate button.",
      parameters: { node_id: node.id },
    });
    actions.push({
      action: "generate_audio",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Submit this audio node using its current text/upstream text and audioKind. Speech uses only an explicitly selected custom/reference voice; when none is selected, skip this node without failing the remaining workflow. Music uses the text-to-music flow. If the node already has uploaded or generated audio, the new result replaces it.",
      parameters: { node_id: node.id },
    });
    if ((node.data as { audioKind?: unknown }).audioKind !== "music") {
      actions.push({
        action: "open_voice_picker",
        execution: "manual_ui",
        command_type: "run_node_action",
        description:
          "Open the custom voice picker only when the user explicitly asks to upload, clone, add, switch, or choose another voice. Never select the first available voice automatically and never call it merely because the canvas runs in auto-execute mode. Missing voice is handled by skipping speech generation. The voice picker is not persistent; call this action again every time the user explicitly asks to upload another voice. Frontend writes the selected voiceRef back to this node after the user chooses a voice.",
        parameters: {
          node_id: node.id,
          supports_upload: true,
          result_fields: ["voiceRef", "voiceLabel", "voiceLanguage"],
        },
      });
    }
  }

  if (node.type === CANVAS_NODE_TYPES.threeDWorld) {
    actions.push({
      action: "open_director_world",
      execution: "manual_ui",
      command_type: "run_node_action",
      description: "Open this 3D/Director World node. This uses the same frontend dialog as clicking the node's director-world entry.",
      parameters: { node_id: node.id },
    });
    if (hasConnectedImageUpstream(node, context)) {
      actions.push({
        action: "generate_3gs_world",
        execution: "frontend_node",
        command_type: "run_node_action",
        description:
          "Submit this 3D world node's single connected upstream image to image-to-3GS and update the world source. Use only when this node already has one image upstream with a usable image URL; text-to-3D is not connected.",
        parameters: { node_id: node.id },
      });
    }
  }

  if (node.type === CANVAS_NODE_TYPES.videoCompose) {
    actions.push({
      action: "auto_compose_video",
      execution: "frontend_node",
      command_type: "run_node_action",
      description:
        "Compose completed upstream video/audio nodes automatically. Reuse the saved timeline draft when present; otherwise order clips from the canvas and write the final video back to this compose node.",
      parameters: { node_id: node.id },
    });
    actions.push({
      action: "open_video_compose_modal",
      execution: "manual_ui",
      command_type: "run_node_action",
      description: "Open the video compose timeline editor for this node. After it opens, the user edits and exports manually in the modal.",
      parameters: { node_id: node.id },
    });
  }

  if (
    node.type === CANVAS_NODE_TYPES.pano360Viewer &&
    hasString((node.data as { imageUrl?: unknown }).imageUrl)
  ) {
    actions.push(
      {
        action: "capture_pano_current_view",
        execution: "frontend_node",
        command_type: "run_node_action",
        description: "Capture the current 360 viewer angle as a downstream image node. Uses the same frontend screenshot flow as the node toolbar.",
        parameters: { node_id: node.id },
      },
      {
        action: "capture_pano_2x2_views",
        execution: "frontend_node",
        command_type: "run_node_action",
        description: "Capture four major 360 directions into downstream image nodes. Uses the current front direction as the baseline.",
        parameters: { node_id: node.id },
      },
      {
        action: "capture_pano_4x3_views",
        execution: "frontend_node",
        command_type: "run_node_action",
        description: "Capture twelve 360 directions into downstream image nodes. Uses the current front direction as the baseline.",
        parameters: { node_id: node.id },
      },
      {
        action: "set_pano_current_view_as_background",
        execution: "frontend_node",
        command_type: "run_node_action",
        description: "Use the current 360 viewer angle as this beat's selected background. Only works on beat-scoped canvases.",
        parameters: { node_id: node.id },
      },
      {
        action: "reset_pano_view",
        execution: "frontend_node",
        command_type: "run_node_action",
        description: "Reset this 360 viewer's yaw and pitch to the default view. Does not create nodes.",
        parameters: { node_id: node.id },
      },
    );
  }
}

function downstreamSpawnTypesForNode(node: CanvasNode): CanvasNodeType[] {
  if (
    node.type === CANVAS_NODE_TYPES.videoCompose ||
    node.type === CANVAS_NODE_TYPES.threeDWorld ||
    node.type === CANVAS_NODE_TYPES.group
  ) {
    return [];
  }
  if (node.type === CANVAS_NODE_TYPES.skill) {
    const seen = new Set<CanvasNodeType>();
    const downstreamTypes: CanvasNodeType[] = [];
    for (const outputType of skillOutputProxyNodeTypes(node)) {
      if (seen.has(outputType)) continue;
      seen.add(outputType);
      downstreamTypes.push(outputType);
    }
    return downstreamTypes;
  }
  return getDownstreamSpawnTypes(node.type);
}

function addMediaActions(node: CanvasNode, actions: CanvasNodeActionCatalogEntry[]): void {
  if (node.type === CANVAS_NODE_TYPES.video && hasString((node.data as { videoUrl?: unknown }).videoUrl)) {
    actions.push({
      action: "open_video_viewer",
      execution: "manual_ui",
      command_type: "run_node_action",
      description: "Open the video viewer for this node. Current chat can request this to open the UI; it does not directly run generation or export.",
      parameters: { node_id: node.id },
    });
    actions.push({
      action: "download_video",
      execution: "frontend_node",
      command_type: "run_node_action",
      description:
        "Trigger a browser download for this video node's current media immediately. No extra toolbar confirmation, UI panel, node creation, or generation is needed.",
      parameters: { node_id: node.id },
    });
    actions.push({
      action: "open_video_clip_tool",
      execution: "manual_ui",
      command_type: "run_node_action",
      description: "Enter clip mode for this video node. The user can adjust the range and submit through the existing frontend clip UI.",
      parameters: { node_id: node.id },
    });
    actions.push({
      action: "open_video_upscale_tool",
      execution: "manual_ui",
      command_type: "run_node_action",
      description:
        "Open the toolbar HD/upscale flow for this video. This creates or selects a downstream video upscale node/panel; it does not use this source video node's editable parameters as upscale settings.",
      parameters: {
        node_id: node.id,
        parameter_schema: VIDEO_UPSCALE_PARAMETER_SCHEMA,
      },
      result_effect: {
        target: "downstream video upscale node",
        next_step:
          "After opening, inspect the selected/new upscale node with freezone_get_node_detail if editable HD settings are needed.",
      },
    });
    actions.push({
      action: "run_video_analyze_story",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Analyze this video story structure and create a downstream video story node, matching the toolbar analyze action.",
      parameters: { node_id: node.id },
    });
    actions.push({
      action: "run_audio_separate",
      execution: "frontend_node",
      command_type: "run_node_action",
      description: "Separate this video into an audio node and a silent video node, matching the toolbar audio/video separation action.",
      parameters: { node_id: node.id },
    });
    actions.push({
      action: "open_video_subtitle_erase_smart",
      execution: "manual_ui",
      command_type: "run_node_action",
      description: "Enter smart subtitle erase mode for this video node. The user confirms through the existing frontend erase UI.",
      parameters: { node_id: node.id, mode: "smart" },
    });
    actions.push({
      action: "open_video_subtitle_erase_box",
      execution: "manual_ui",
      command_type: "run_node_action",
      description: "Enter boxed subtitle erase mode for this video node. The user draws a box and confirms through the existing frontend erase UI.",
      parameters: { node_id: node.id, mode: "box" },
    });
  }

  if (node.type === CANVAS_NODE_TYPES.audio && hasString((node.data as { audioUrl?: unknown }).audioUrl)) {
    actions.push({
      action: "download_audio",
      execution: "frontend_node",
      command_type: "run_node_action",
      description:
        "Trigger a browser download for this audio node immediately. Optional format transcodes in the browser before saving. No extra toolbar confirmation, UI panel, node creation, or generation is needed.",
      parameters: {
        node_id: node.id,
        format_schema: {
          type: "enum",
          options: ["source", "mp3", "m4a", "wav"],
          default: "source",
        },
      },
    });
  }
}

function addCommitAction(node: CanvasNode, actions: CanvasNodeActionCatalogEntry[]): void {
  if (!isCommitCandidateData(node.data)) return;
  actions.push({
    action: "commit_node",
    execution: "requires_confirmation",
    command_type: "run_node_action",
    description: "Commit this node back to its mainline target slot. This requires explicit user confirmation.",
    parameters: { node_id: node.id },
  });
}

export function buildCanvasNodeActionCatalog(
  node: CanvasNode,
  context?: CanvasNodeActionCatalogContext,
): CanvasNodeActionCatalog {
  const actions: CanvasNodeActionCatalogEntry[] = [];
  addChatCommandActions(node, actions);
  addFrontendNodeActions(node, actions, context);
  addImageToolActions(node, actions);
  addMediaActions(node, actions);
  addCommitAction(node, actions);

  const skillId =
    node.type === CANVAS_NODE_TYPES.skill
      ? stringOrNull((node.data as { skill_id?: unknown }).skill_id)
      : null;

  return {
    node_id: node.id,
    node_type: node.type ?? null,
    ...(skillId ? { skill_id: skillId } : {}),
    downstream_spawn_types: downstreamSpawnTypesForNode(node),
    editable_fields: editableFieldsForNode(node),
    editable_schema: editableSchemaForNode(node),
    actions,
  };
}
