import type { CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import { WORKFLOW_AGENT_CREATABLE_NODE_TYPES } from "@/features/freezone/generated/workflowContract";

export const AGENT_CREATABLE_CANVAS_NODE_TYPES = [
  ...WORKFLOW_AGENT_CREATABLE_NODE_TYPES,
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
