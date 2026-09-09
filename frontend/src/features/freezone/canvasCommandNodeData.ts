import {
  CANVAS_NODE_TYPES,
  type BeatContextNodeData,
  type CanvasNodeData,
  type CanvasNodeType,
} from "@/features/canvas/domain/canvasNodes";

export const BEAT_CONTEXT_AGENT_EDITABLE_FIELDS = [
  "visual_description",
  "scene_ref",
  "time_of_day",
] as const;

export type BeatContextAgentEditableField = (typeof BEAT_CONTEXT_AGENT_EDITABLE_FIELDS)[number];

const BEAT_CONTEXT_AGENT_EDITABLE_FIELD_SET = new Set<string>(BEAT_CONTEXT_AGENT_EDITABLE_FIELDS);

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function firstStringField(
  data: Partial<CanvasNodeData>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = data[field];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function hasNonEmptyStringField(data: Partial<CanvasNodeData> | undefined, field: string): boolean {
  return typeof data?.[field] === "string" && String(data[field]).trim().length > 0;
}

function deleteFields(data: Partial<CanvasNodeData>, fields: readonly string[]): void {
  for (const field of fields) {
    delete data[field];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isBeatContextAgentEditableField(field: string): field is BeatContextAgentEditableField {
  return BEAT_CONTEXT_AGENT_EDITABLE_FIELD_SET.has(field);
}

export function isBeatContextAgentEditablePatch(data: Partial<CanvasNodeData> | undefined): boolean {
  const keys = Object.keys(data ?? {});
  return keys.length > 0 && keys.every(isBeatContextAgentEditableField);
}

export function normalizeBeatContextAgentPatch(
  currentData: BeatContextNodeData,
  patch: Partial<CanvasNodeData> | undefined,
): Partial<BeatContextNodeData> {
  const next: Partial<BeatContextNodeData> = {
    content: currentData.content,
    snapshot: {
      ...(currentData.snapshot ?? {}),
    },
    beat_edit_fields: {
      ...(currentData.beat_edit_fields ?? {}),
    },
    syncStatus: "stale",
    errorMessage: "",
  };
  const snapshot = next.snapshot ?? {};
  const editFields = next.beat_edit_fields ?? {};

  if (Object.prototype.hasOwnProperty.call(patch ?? {}, "visual_description")) {
    const visualDescription = stringOrEmpty((patch as { visual_description?: unknown }).visual_description);
    snapshot.visualDescription = visualDescription;
    editFields.visual_description = visualDescription;
    next.content = visualDescription;
  }

  if (Object.prototype.hasOwnProperty.call(patch ?? {}, "scene_ref")) {
    const sceneRef = isRecord((patch as { scene_ref?: unknown }).scene_ref)
      ? (patch as { scene_ref?: Record<string, unknown> }).scene_ref
      : null;
    const sceneId = stringOrEmpty(sceneRef?.scene_id);
    const sceneVariantId = stringOrEmpty(sceneRef?.variant_id);
    snapshot.sceneId = sceneId;
    snapshot.sceneVariantId = sceneVariantId;
    editFields.scene_id = sceneId;
    editFields.scene_variant_id = sceneVariantId;
  }

  if (Object.prototype.hasOwnProperty.call(patch ?? {}, "time_of_day")) {
    const timeOfDay = stringOrEmpty((patch as { time_of_day?: unknown }).time_of_day);
    snapshot.timeOfDay = timeOfDay;
    editFields.time_of_day = timeOfDay;
  }

  return {
    ...next,
    snapshot,
    beat_edit_fields: editFields,
  };
}

const TEXT_INPUT_ALIASES = ["prompt", "content", "text", "body", "description"] as const;
const PROMPT_INPUT_ALIASES = [
  "prompt",
  "content",
  "text",
  "body",
  "description",
  "video_prompt",
  "videoPrompt",
] as const;
const AUDIO_TEXT_ALIASES = [
  "text",
  "prompt",
  "content",
  "body",
  "description",
  "script",
  "narration",
] as const;

export function normalizeCanvasCommandNodeData(
  nodeType: CanvasNodeType | undefined,
  data: Partial<CanvasNodeData> | undefined,
): Partial<CanvasNodeData> {
  if (!data || !nodeType) return data ?? {};
  const next: Partial<CanvasNodeData> = { ...data };
  const displayName = firstNonEmptyString(next.displayName, next.label, next.title, next.name);
  if (displayName) {
    next.displayName = displayName;
    delete next.label;
    delete next.name;
  }

  switch (nodeType) {
    case CANVAS_NODE_TYPES.textAnnotation:
      if (!hasNonEmptyStringField(next, "content")) {
        const content = firstStringField(next, TEXT_INPUT_ALIASES);
        if (content !== undefined) {
          // 文本标注节点真实正文读 data.content；Agent 偶尔会按生成节点习惯写 prompt。
          next.content = content;
        }
      }
      deleteFields(next, ["prompt", "text", "body", "description"]);
      break;
    case CANVAS_NODE_TYPES.audio:
      if (!hasNonEmptyStringField(next, "text")) {
        const text = firstStringField(next, AUDIO_TEXT_ALIASES);
        if (text !== undefined) {
          // 音频节点的 TTS/音乐文本读 data.text，不读 prompt/content。
          next.text = text;
        }
      }
      // Audio generation resolves its provider from audioKind and the
      // frontend audio pipeline.  `model` belongs to image/video nodes and
      // is not editable on an audio node; discard it during normalization so
      // a workflow-wide model hint cannot make the whole command fail before
      // the approval card is shown.
      deleteFields(next, ["prompt", "content", "body", "description", "script", "narration", "model"]);
      break;
    case CANVAS_NODE_TYPES.beatContext:
      if (!hasNonEmptyStringField(next, "content")) {
        const content = firstStringField(next, TEXT_INPUT_ALIASES);
        if (content !== undefined) {
          // beat 上下文节点的可见/可消费文本落在 content。
          next.content = content;
        }
      }
      deleteFields(next, ["prompt", "text", "body", "description"]);
      break;
    case CANVAS_NODE_TYPES.script:
      if (!hasNonEmptyStringField(next, "prompt")) {
        const prompt = firstStringField(next, PROMPT_INPUT_ALIASES);
        // 脚本生成节点提交时读取 prompt；content 只是兼容展示字段。
        if (prompt !== undefined) next.prompt = prompt;
      }
      deleteFields(next, ["text", "body", "description", "video_prompt", "videoPrompt"]);
      break;
    case CANVAS_NODE_TYPES.imageGen:
    case CANVAS_NODE_TYPES.imageEdit:
    case CANVAS_NODE_TYPES.video:
    case CANVAS_NODE_TYPES.threeDWorld:
      if (!hasNonEmptyStringField(next, "prompt")) {
        const prompt = firstStringField(next, PROMPT_INPUT_ALIASES);
        if (prompt !== undefined) next.prompt = prompt;
      }
      deleteFields(next, ["content", "text", "body", "description", "video_prompt", "videoPrompt"]);
      break;
    case CANVAS_NODE_TYPES.videoCompose:
      deleteFields(next, ["prompt", "content", "text", "body", "description"]);
      break;
    case CANVAS_NODE_TYPES.group:
      deleteFields(next, ["prompt", "content", "text", "body", "description", "title"]);
      break;
    default:
      break;
  }

  return next;
}

/**
 * Apply defaults that belong specifically to assistant-created canvas nodes.
 *
 * Freezone speech nodes are custom-voice only. A node without a selected
 * reference remains valid, but its generation action is skipped.
 */
export function normalizeCanvasCommandCreateNodeData(
  nodeType: CanvasNodeType | undefined,
  data: Partial<CanvasNodeData> | undefined,
): Partial<CanvasNodeData> {
  const next = normalizeCanvasCommandNodeData(nodeType, data);
  if (nodeType !== CANVAS_NODE_TYPES.audio || next.audioKind === "music") {
    return next;
  }
  if (next.speechMode === undefined) {
    next.speechMode = "clone";
  }
  return next;
}
