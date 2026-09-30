import type { StructuredBlock } from "@/features/superchat/spec-extract";
import { extractCanvasChatCommandEnvelopes } from "@/features/freezone/canvasChatCommands";

export type CanvasCommandExecutionMode = "manual_confirm" | "auto_execute";

export function isCanvasChatCommandStructuredBlock(block: StructuredBlock): boolean {
  return extractCanvasChatCommandEnvelopes([block.value]).length > 0;
}

export function visibleStructuredBlocksForMessage(
  blocks: StructuredBlock[],
  options: {
    isFreezoneLayout: boolean;
    isUser: boolean;
    isTool: boolean;
  },
): StructuredBlock[] {
  if (!options.isFreezoneLayout || options.isUser || options.isTool) return blocks;
  return blocks.filter((block) => !isCanvasChatCommandStructuredBlock(block));
}

export function shouldApplyAssistantCanvasCommandFallback({
  executionMode,
  immediateCount,
  requiresApprovalCount,
  activeTurnId,
}: {
  executionMode: CanvasCommandExecutionMode;
  immediateCount: number;
  requiresApprovalCount: number;
  activeTurnId: string | null;
}): boolean {
  if (executionMode !== "manual_confirm") return true;
  if (immediateCount > 0) return true;
  return !(requiresApprovalCount > 0 && Boolean(activeTurnId));
}
