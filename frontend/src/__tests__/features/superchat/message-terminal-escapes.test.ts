import { describe, expect, it } from "vitest";

import { normalizeMessage, normalizeMessagePart } from "@/features/superchat/message";

const ESC = "\u001b";

describe("terminal colour codes in chat text", () => {
  it("drops them from a stored tool trace", () => {
    const message = normalizeMessage({
      id: "m1",
      role: "trace",
      content:
        `${ESC}[90m• Running MCP${ESC}[0m dramaclaw.freezone_create_node\n`
        + `${ESC}[90m[mcp:completed]${ESC}[0m dramaclaw.freezone_create_node`,
    });

    expect(message?.text).toBe(
      "• Running MCP dramaclaw.freezone_create_node\n"
      + "[mcp:completed] dramaclaw.freezone_create_node",
    );
  });

  it("drops them from an ordered text part", () => {
    const part = normalizeMessagePart({
      id: "p1",
      type: "text",
      text: `${ESC}[91m[exit 1]${ESC}[0m build failed`,
    });

    expect(part).toMatchObject({ type: "text", text: "[exit 1] build failed" });
  });

  it("leaves square brackets that are not colour codes alone", () => {
    const message = normalizeMessage({ id: "m2", role: "assistant", content: "数组 a[0m] 与 [90m]" });

    expect(message?.text).toBe("数组 a[0m] 与 [90m]");
  });
});
