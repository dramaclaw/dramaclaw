import { CANVAS_NODE_TYPES, type CanvasNodeType } from "@/features/canvas/domain/canvasNodes";

export type CanvasNodeSemanticRole =
  | "semantic_source"
  | "generator"
  | "composer"
  | "viewer"
  | "action"
  | "context"
  | "group";

export type CanvasNodeIoRole =
  | "planning_text"
  | "input_text"
  | "context_text"
  | "image_output"
  | "audio_output"
  | "video_output";

export type CanvasNodeSemanticSpec = {
  nodeType: CanvasNodeType;
  role: CanvasNodeSemanticRole;
  shortDescription: string;
  defaultUsage?: string;
  planningStart?: boolean;
  primaryOutputRole?: CanvasNodeIoRole | null;
  acceptedInputRoles?: CanvasNodeIoRole[];
};

export function isCanvasNodeIoRole(value: unknown): value is CanvasNodeIoRole {
  return (
    value === "planning_text" ||
    value === "input_text" ||
    value === "context_text" ||
    value === "image_output" ||
    value === "audio_output" ||
    value === "video_output"
  );
}

function dataIoRole(data: unknown): CanvasNodeIoRole | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as { semanticOutputRole?: unknown; ioRole?: unknown };
  if (isCanvasNodeIoRole(record.semanticOutputRole)) return record.semanticOutputRole;
  if (isCanvasNodeIoRole(record.ioRole)) return record.ioRole;
  return null;
}

const CANVAS_NODE_SEMANTICS: Partial<Record<CanvasNodeType, CanvasNodeSemanticSpec>> = {
  [CANVAS_NODE_TYPES.textAnnotation]: {
    nodeType: CANVAS_NODE_TYPES.textAnnotation,
    role: "semantic_source",
    shortDescription: "plain text, brief, copywriting, notes, settings, free-form scripts",
    defaultUsage: "Plain text container. Leave output role unset until an edge or workflow makes the text's purpose clear.",
    planningStart: true,
    primaryOutputRole: null,
    acceptedInputRoles: ["planning_text", "context_text"],
  },
  [CANVAS_NODE_TYPES.script]: {
    nodeType: CANVAS_NODE_TYPES.script,
    role: "semantic_source",
    shortDescription: "structured story-script generator or script table, not a plain text container",
    defaultUsage:
      "Use only when the user explicitly wants a structured script table or script-generation workflow.",
    primaryOutputRole: "planning_text",
    acceptedInputRoles: ["planning_text", "context_text", "input_text"],
  },
  [CANVAS_NODE_TYPES.imageGen]: {
    nodeType: CANVAS_NODE_TYPES.imageGen,
    role: "generator",
    shortDescription: "image generation node that turns prompt/references into image outputs",
    defaultUsage: "Use for creating or regenerating a still image asset.",
    primaryOutputRole: "image_output",
    acceptedInputRoles: ["input_text", "context_text"],
  },
  [CANVAS_NODE_TYPES.video]: {
    nodeType: CANVAS_NODE_TYPES.video,
    role: "generator",
    shortDescription: "single-shot video generation node",
    defaultUsage:
      "Use for text-to-video, image-to-video, first-last-frame, image-reference, or all-reference generation.",
    primaryOutputRole: "video_output",
    acceptedInputRoles: ["input_text", "context_text", "image_output"],
  },
  [CANVAS_NODE_TYPES.audio]: {
    nodeType: CANVAS_NODE_TYPES.audio,
    role: "generator",
    shortDescription: "audio generation node for speech, voice-over, music, or sound cues",
    defaultUsage:
      "Use for narration, dialogue voice-over, music, or audio references. Prefer upstream text/script/context nodes as the semantic source.",
    primaryOutputRole: "audio_output",
    acceptedInputRoles: ["input_text", "context_text"],
  },
  [CANVAS_NODE_TYPES.videoCompose]: {
    nodeType: CANVAS_NODE_TYPES.videoCompose,
    role: "composer",
    shortDescription: "timeline composition node for already-generated video/audio assets",
    defaultUsage:
      "Use only after real video/audio assets exist. Do not use as the default node for generating a new shot video.",
    primaryOutputRole: "video_output",
    acceptedInputRoles: ["video_output", "audio_output"],
  },
  [CANVAS_NODE_TYPES.beatContext]: {
    nodeType: CANVAS_NODE_TYPES.beatContext,
    role: "context",
    shortDescription: "shot or beat context node",
    defaultUsage: "Use as read-only scene/beat context rather than a free-form planning note.",
    primaryOutputRole: "context_text",
  },
  [CANVAS_NODE_TYPES.pano360Viewer]: {
    nodeType: CANVAS_NODE_TYPES.pano360Viewer,
    role: "viewer",
    shortDescription: "360 panorama viewer node",
    defaultUsage: "Use to inspect existing 360 panorama outputs; not a planning start node.",
  },
  [CANVAS_NODE_TYPES.threeDWorld]: {
    nodeType: CANVAS_NODE_TYPES.threeDWorld,
    role: "viewer",
    shortDescription: "3D/director-world preview node",
    defaultUsage: "Use to inspect or derive 3D/director-world outputs from upstream imagery.",
  },
  [CANVAS_NODE_TYPES.skill]: {
    nodeType: CANVAS_NODE_TYPES.skill,
    role: "action",
    shortDescription: "preset or workflow action node",
    defaultUsage: "Represents a runnable action/skill node rather than a free-form planning node.",
  },
  [CANVAS_NODE_TYPES.group]: {
    nodeType: CANVAS_NODE_TYPES.group,
    role: "group",
    shortDescription: "visual grouping node",
    defaultUsage: "Use for layout grouping only; it does not replace true dependency edges.",
  },
};

export function getCanvasNodeSemanticSpec(
  nodeType: CanvasNodeType | null | undefined,
): CanvasNodeSemanticSpec | null {
  if (!nodeType) return null;
  return CANVAS_NODE_SEMANTICS[nodeType] ?? null;
}

export function getCanvasNodePrimaryOutputRole(params: {
  nodeType: CanvasNodeType | null | undefined;
  data?: unknown;
}): CanvasNodeIoRole | null {
  return dataIoRole(params.data) ?? getCanvasNodeSemanticSpec(params.nodeType)?.primaryOutputRole ?? null;
}

export function buildCommonNodeTypeGuidance(): string {
  const ordered = [
    CANVAS_NODE_TYPES.textAnnotation,
    CANVAS_NODE_TYPES.script,
    CANVAS_NODE_TYPES.imageGen,
    CANVAS_NODE_TYPES.video,
    CANVAS_NODE_TYPES.audio,
    CANVAS_NODE_TYPES.videoCompose,
    CANVAS_NODE_TYPES.beatContext,
    CANVAS_NODE_TYPES.pano360Viewer,
    CANVAS_NODE_TYPES.threeDWorld,
  ] as const;
  const parts = ordered
    .map((nodeType) => {
      const spec = getCanvasNodeSemanticSpec(nodeType);
      if (!spec) return null;
      const ioParts = [
        spec.primaryOutputRole ? `outputs ${spec.primaryOutputRole}` : null,
        spec.acceptedInputRoles?.length
          ? `accepts ${spec.acceptedInputRoles.join("/")}`
          : null,
      ].filter((part): part is string => Boolean(part));
      return `${nodeType}=${spec.shortDescription}${ioParts.length ? ` (${ioParts.join(", ")})` : ""}`;
    })
    .filter((part): part is string => Boolean(part));
  return `Common node_type values: ${parts.join("; ")}.`;
}
