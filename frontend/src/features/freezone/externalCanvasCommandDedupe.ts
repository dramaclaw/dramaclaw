import type { ServerFrame } from "@/features/superchat/types";

type ExternalCanvasCommandClaim = {
  externalMcpCommand: boolean;
  bridgeKey: string | null;
  accepted: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Realtime websocket delivery and reconnect polling can observe the same pending
 * external-MCP bridge file. Claim its bridge key in one synchronous place so
 * only the first delivery reaches the approval flow. Hermes frames do not carry
 * the external marker and intentionally bypass this guard.
 */
export function claimExternalCanvasCommand(
  seenBridgeKeys: Set<string>,
  frame: ServerFrame,
  explicitlyExternal = false,
): ExternalCanvasCommandClaim {
  const frameRecord = record(frame);
  const envelope = record(frameRecord?.envelope);
  const externalMcpCommand =
    explicitlyExternal ||
    frameRecord?.external_mcp_command === true ||
    frameRecord?.externalMcpCommand === true ||
    envelope?.external_mcp_command === true ||
    envelope?.externalMcpCommand === true;
  const bridgeKey =
    typeof frameRecord?.bridge_key === "string"
      ? frameRecord.bridge_key
      : typeof frameRecord?.bridgeKey === "string"
        ? frameRecord.bridgeKey
        : null;

  if (!externalMcpCommand || !bridgeKey) {
    return { externalMcpCommand, bridgeKey, accepted: true };
  }
  if (seenBridgeKeys.has(bridgeKey)) {
    return { externalMcpCommand, bridgeKey, accepted: false };
  }
  seenBridgeKeys.add(bridgeKey);
  return { externalMcpCommand, bridgeKey, accepted: true };
}
