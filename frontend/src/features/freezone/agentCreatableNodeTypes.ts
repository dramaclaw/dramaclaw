import {
  CANVAS_NODE_TYPES,
  type CanvasNodeType,
} from "@/features/canvas/domain/canvasNodes";

export const AGENT_CREATABLE_CANVAS_NODE_TYPES = [
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.beatContext,
  CANVAS_NODE_TYPES.textAnnotation,
  CANVAS_NODE_TYPES.video,
  CANVAS_NODE_TYPES.audio,
  CANVAS_NODE_TYPES.videoCompose,
  CANVAS_NODE_TYPES.script,
  CANVAS_NODE_TYPES.pano360Viewer,
  CANVAS_NODE_TYPES.threeDWorld,
  CANVAS_NODE_TYPES.skill,
] as const satisfies readonly CanvasNodeType[];

const AGENT_CREATABLE_CANVAS_NODE_TYPE_SET = new Set<string>(
  AGENT_CREATABLE_CANVAS_NODE_TYPES,
);

export function isAgentCreatableCanvasNodeType(
  value: unknown,
): value is (typeof AGENT_CREATABLE_CANVAS_NODE_TYPES)[number] {
  return (
    typeof value === "string" &&
    AGENT_CREATABLE_CANVAS_NODE_TYPE_SET.has(value)
  );
}
