import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode, type CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import {
  getCanvasNodePrimaryOutputRole,
  getCanvasNodeSemanticSpec,
  type CanvasNodeIoRole,
} from "@/features/freezone/canvasNodeSemantics";

export type CanvasLinkObjectType =
  | "TextNode"
  | "ImageNode"
  | "VideoNode"
  | "AudioNode"
  | "ScriptNode";

export type CanvasEdgeSemanticKind =
  | "context_for"
  | "prompt_for"
  | "dependency_for"
  | "media_input_for"
  | "derived_from"
  | "composition_input_for";

export type CanvasEdgeSemanticSpec = {
  kind: CanvasEdgeSemanticKind;
  shortDescription: string;
};

export type CanvasLinkTypeCatalogItem = {
  link_type: CanvasEdgeSemanticKind;
  category: "context" | "generation_input" | "derivation" | "composition";
  source_object_types: CanvasLinkObjectType[];
  target_object_types: CanvasLinkObjectType[];
  description: string;
  instruction: string;
};

export const CANVAS_LINK_TYPE_CATALOG: CanvasLinkTypeCatalogItem[] = [
  {
    link_type: "context_for",
    category: "context",
    source_object_types: ["TextNode", "ScriptNode"],
    target_object_types: ["TextNode", "ScriptNode"],
    description: "文本/剧本规划节点之间的背景、约束或说明关系，用于组织创作思路，不直接驱动媒体生成。",
    instruction: "Use only when a text/script/context node provides background or constraints to another text/script planning node. Never use context_for for image/video/audio generation targets; use prompt_for when text drives generation.",
  },
  {
    link_type: "prompt_for",
    category: "generation_input",
    source_object_types: ["TextNode"],
    target_object_types: ["ImageNode", "VideoNode", "AudioNode", "ScriptNode"],
    description: "上游文本/脚本是目标生成节点的直接提示词、文案、台词或任务输入。",
    instruction: "Use when upstream text is direct generation input, such as text-to-image, text-to-video, text-to-audio, script generation, or another direct textual instruction. A plain textAnnotationNode with no semanticOutputRole may be connected with prompt_for and will be treated as direct input text for that edge. If the source text is explicitly planning_text and is only a brief, plan, requirement note, or contextual documentation, keep it as planning_text and group it with the generator instead of connecting it directly, or create a separate input_text prompt node.",
  },
  {
    link_type: "dependency_for",
    category: "context",
    source_object_types: ["TextNode", "ImageNode", "VideoNode", "AudioNode", "ScriptNode"],
    target_object_types: ["TextNode", "ImageNode", "VideoNode", "AudioNode", "ScriptNode"],
    description: "上游节点只控制目标节点的执行顺序，目标节点不会消费其输出。",
    instruction: "Use only for execution ordering when the target must wait for the source but must not send the source output to a generation provider. Never use it for actual prompts, media references, or composition inputs.",
  },
  {
    link_type: "media_input_for",
    category: "generation_input",
    source_object_types: ["ImageNode", "VideoNode", "AudioNode"],
    target_object_types: ["TextNode", "ImageNode", "VideoNode", "AudioNode", "ScriptNode"],
    description: "上游图片/视频/音频作为目标节点的媒体输入或参考素材。",
    instruction: "Use for image/video/audio inputs or references consumed by the target node, including image-to-video, image editing, visual references, media analysis, audio separation, or direct media processing.",
  },
  {
    link_type: "derived_from",
    category: "derivation",
    source_object_types: ["ImageNode", "VideoNode", "AudioNode"],
    target_object_types: ["ImageNode", "VideoNode", "AudioNode"],
    description: "目标媒体是从上游媒体编辑、裁剪、高清、变体、导出或修复得到的结果。",
    instruction: "Use for produced derivative artifacts, not for a generator merely using a reference.",
  },
  {
    link_type: "composition_input_for",
    category: "composition",
    source_object_types: ["VideoNode", "AudioNode"],
    target_object_types: ["VideoNode"],
    description: "上游文本、图片、视频或音频片段进入目标合成/时间线节点，作为最终成片素材。",
    instruction: "Use primarily for inputs into videoComposeNode or other composition/timeline nodes.",
  },
];

const CANVAS_EDGE_SEMANTIC_KINDS = new Set<CanvasEdgeSemanticKind>(
  CANVAS_LINK_TYPE_CATALOG.map((item) => item.link_type),
);

const CANVAS_EDGE_SEMANTIC_KIND_ALIASES: Record<string, CanvasEdgeSemanticKind> = {
  visual_reference_for: "media_input_for",
  source_media_for: "media_input_for",
};

export function canvasLinkTypeCatalogText(): string {
  const principle =
    "Edges are data, semantic input, or explicit execution-order relationships, not visual association lines. Use dependency_for only when the target must wait without consuming the source output. Use the other edge types only when the target consumes the source as input, reference, context, or composition material. If nodes are merely related or part of the same workflow, use group_nodes or layout_nodes instead of create_edge.";
  return `${principle} ` + CANVAS_LINK_TYPE_CATALOG.map((item) =>
    `${item.link_type}: source=[${item.source_object_types.join(", ")}], target=[${item.target_object_types.join(", ")}], ${item.description} ${item.instruction}`,
  ).join(" | ");
}

export function canvasLinkTypeCatalogJson(): CanvasLinkTypeCatalogItem[] {
  return CANVAS_LINK_TYPE_CATALOG;
}

export function isCanvasEdgeSemanticKind(value: unknown): value is CanvasEdgeSemanticKind {
  return typeof value === "string" && CANVAS_EDGE_SEMANTIC_KINDS.has(value as CanvasEdgeSemanticKind);
}

export function normalizeCanvasEdgeSemanticKind(value: unknown): CanvasEdgeSemanticKind | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (CANVAS_EDGE_SEMANTIC_KINDS.has(trimmed as CanvasEdgeSemanticKind)) {
    return trimmed as CanvasEdgeSemanticKind;
  }
  return CANVAS_EDGE_SEMANTIC_KIND_ALIASES[trimmed] ?? null;
}

export function canvasEdgeSemanticKindValues(): CanvasEdgeSemanticKind[] {
  return CANVAS_LINK_TYPE_CATALOG.map((item) => item.link_type);
}

export function canvasNodeLinkObjectType(node: CanvasNode | undefined): CanvasLinkObjectType | null {
  if (!node) return null;
  return canvasNodeTypeLinkObjectType(node.type);
}

export function canvasNodeTypeLinkObjectType(nodeType: CanvasNodeType | null | undefined): CanvasLinkObjectType | null {
  if (!nodeType) return null;
  if (nodeType === CANVAS_NODE_TYPES.textAnnotation || nodeType === CANVAS_NODE_TYPES.beatContext) {
    return "TextNode";
  }
  if (nodeType === CANVAS_NODE_TYPES.script) return "ScriptNode";
  if (nodeType === CANVAS_NODE_TYPES.video || nodeType === CANVAS_NODE_TYPES.videoStory || nodeType === CANVAS_NODE_TYPES.videoCompose) {
    return "VideoNode";
  }
  if (nodeType === CANVAS_NODE_TYPES.audio) return "AudioNode";
  if (
    nodeType === CANVAS_NODE_TYPES.upload ||
    nodeType === CANVAS_NODE_TYPES.imageEdit ||
    nodeType === CANVAS_NODE_TYPES.imageGen ||
    nodeType === CANVAS_NODE_TYPES.exportImage ||
    nodeType === CANVAS_NODE_TYPES.storyboardSplit ||
    nodeType === CANVAS_NODE_TYPES.storyboardGen ||
    nodeType === CANVAS_NODE_TYPES.pano360Viewer ||
    nodeType === CANVAS_NODE_TYPES.threeDWorld ||
    nodeType === CANVAS_NODE_TYPES.skill
  ) {
    return "ImageNode";
  }
  return null;
}

export function allowedCanvasLinkTypesForNodes(
  sourceNode: CanvasNode | undefined,
  targetNode: CanvasNode | undefined,
): CanvasEdgeSemanticKind[] {
  const sourceType = canvasNodeLinkObjectType(sourceNode);
  const targetType = canvasNodeLinkObjectType(targetNode);
  if (!sourceType || !targetType) return CANVAS_LINK_TYPE_CATALOG.map((item) => item.link_type);
  return CANVAS_LINK_TYPE_CATALOG
    .filter((item) => item.source_object_types.includes(sourceType) && item.target_object_types.includes(targetType))
    .map((item) => item.link_type);
}

export function isCanvasLinkTypeAllowed(
  linkType: CanvasEdgeSemanticKind,
  sourceNode: CanvasNode | undefined,
  targetNode: CanvasNode | undefined,
): boolean {
  return allowedCanvasLinkTypesForNodes(sourceNode, targetNode).includes(linkType);
}

function sourceOutputRole(node: CanvasNode | undefined): CanvasNodeIoRole | null {
  return getCanvasNodePrimaryOutputRole({
    nodeType: node?.type,
    data: node?.data,
  });
}

function targetAccepts(node: CanvasNode | undefined, role: CanvasNodeIoRole): boolean {
  const accepted = getCanvasNodeSemanticSpec(node?.type)?.acceptedInputRoles ?? [];
  return accepted.includes(role);
}

function inferredBlankTextRoleForTarget(
  sourceNode: CanvasNode | undefined,
  targetNode: CanvasNode | undefined,
): CanvasNodeIoRole | null {
  if (sourceNode?.type !== CANVAS_NODE_TYPES.textAnnotation) return null;
  if (targetAccepts(targetNode, "input_text")) return "input_text";
  if (targetAccepts(targetNode, "context_text")) return "context_text";
  if (targetAccepts(targetNode, "planning_text")) return "planning_text";
  return null;
}

function isMediaRole(role: CanvasNodeIoRole | null): role is "image_output" | "audio_output" | "video_output" {
  return role === "image_output" || role === "audio_output" || role === "video_output";
}

function isDerivedMediaNode(node: CanvasNode | undefined): boolean {
  return (
    node?.type === CANVAS_NODE_TYPES.exportImage ||
    node?.type === CANVAS_NODE_TYPES.upload ||
    node?.type === CANVAS_NODE_TYPES.storyboardSplit ||
    node?.type === CANVAS_NODE_TYPES.videoStory
  );
}

function edgeRole(edge: CanvasEdge): string {
  const data = edge.data as { role?: unknown } | undefined;
  return typeof data?.role === "string" ? data.role.trim() : "";
}

export function deriveCanvasEdgeSemanticSpec({
  edge,
  sourceNode,
  targetNode,
}: {
  edge: CanvasEdge;
  sourceNode?: CanvasNode;
  targetNode?: CanvasNode;
}): CanvasEdgeSemanticSpec | null {
  if (!sourceNode || !targetNode) return null;

  const role = edgeRole(edge);
  const sourceRole = sourceOutputRole(sourceNode) ?? inferredBlankTextRoleForTarget(sourceNode, targetNode);

  if (
    (sourceRole === "planning_text" || sourceRole === "context_text") &&
    targetAccepts(targetNode, sourceRole) &&
    isCanvasLinkTypeAllowed("context_for", sourceNode, targetNode)
  ) {
    return {
      kind: "context_for",
      shortDescription: "text or script context organizes another text planning node",
    };
  }

  if (sourceRole === "input_text" && targetAccepts(targetNode, "input_text")) {
    return {
      kind: "prompt_for",
      shortDescription: "text prompt feeds downstream generation",
    };
  }

  if (targetNode.type === CANVAS_NODE_TYPES.videoCompose && isCanvasLinkTypeAllowed("composition_input_for", sourceNode, targetNode)) {
    return {
      kind: "composition_input_for",
      shortDescription: "media or script asset enters a video composition timeline",
    };
  }

  if (sourceRole === "image_output" && targetNode.type === CANVAS_NODE_TYPES.imageGen) {
    return {
      kind: "media_input_for",
      shortDescription: "image asset is media input for image generation",
    };
  }

  if (
    isMediaRole(sourceRole) &&
    (targetAccepts(targetNode, sourceRole) ||
      targetNode.type === CANVAS_NODE_TYPES.pano360Viewer ||
      targetNode.type === CANVAS_NODE_TYPES.threeDWorld)
  ) {
    return {
      kind: "media_input_for",
      shortDescription: role
        ? `media asset is source input role ${role}`
        : "media asset is source input for downstream processing",
    };
  }

  if (
    (isMediaRole(sourceRole) || sourceNode.type === CANVAS_NODE_TYPES.pano360Viewer) &&
    isDerivedMediaNode(targetNode)
  ) {
    return {
      kind: "derived_from",
      shortDescription: "target media node is derived from the source node",
    };
  }

  return null;
}
