import { describe, expect, it } from "vitest";
import { claimExternalCanvasCommand } from "@/features/freezone/externalCanvasCommandDedupe";

describe("external canvas command delivery dedupe", () => {
  it("accepts only the first websocket/poll delivery of one external MCP bridge", () => {
    const seen = new Set<string>();
    const liveFrame = {
      type: "canvas.command" as const,
      turn_id: "turn-live",
      bridge_key: "bridge-1",
      envelope: {
        schema_version: "canvas_chat_commands.v1",
        external_mcp_command: true,
        commands: [{ type: "create_node" }],
      },
    };
    const polledFrame = {
      ...liveFrame,
      turn_id: "external-agent:bridge-1",
    };

    expect(claimExternalCanvasCommand(seen, liveFrame)).toMatchObject({
      externalMcpCommand: true,
      bridgeKey: "bridge-1",
      accepted: true,
    });
    expect(claimExternalCanvasCommand(seen, polledFrame, true)).toMatchObject({
      externalMcpCommand: true,
      bridgeKey: "bridge-1",
      accepted: false,
    });
  });

  it("lets the polling delivery win the same race exactly once", () => {
    const seen = new Set<string>();
    const frame = {
      type: "canvas.command" as const,
      turn_id: "external-agent:bridge-2",
      bridge_key: "bridge-2",
      envelope: { schema_version: "canvas_chat_commands.v1", commands: [] },
    };

    expect(claimExternalCanvasCommand(seen, frame, true).accepted).toBe(true);
    expect(claimExternalCanvasCommand(seen, frame, true).accepted).toBe(false);
  });

  it("does not dedupe Hermes commands without the external MCP marker", () => {
    const seen = new Set<string>();
    const frame = {
      type: "canvas.command" as const,
      turn_id: "turn-hermes",
      bridge_key: "hermes-bridge",
      envelope: { schema_version: "canvas_chat_commands.v1", commands: [] },
    };

    expect(claimExternalCanvasCommand(seen, frame)).toEqual({
      externalMcpCommand: false,
      bridgeKey: "hermes-bridge",
      accepted: true,
    });
    expect(claimExternalCanvasCommand(seen, frame).accepted).toBe(true);
    expect(seen).toEqual(new Set());
  });
});
