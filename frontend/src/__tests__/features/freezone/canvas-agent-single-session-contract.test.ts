// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Freezone canvas Agent session UI", () => {
  it("keeps multi-session code but hides both creation actions", () => {
    const shell = readFileSync(
      resolve(process.cwd(), "src/features/freezone/FreezoneShell.tsx"),
      "utf8",
    );

    expect(shell).toContain("const FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED = false");
    expect(shell).toContain("新建 Agent");
    expect(shell).toContain("addFreezoneCanvasAgent");
    expect(shell).toContain("initializeEmptyFreezoneAgentChat");
    expect(shell).toContain("onAdd={handleAddAgent}");
    expect(shell).toContain("selectFreezoneCanvasAgent(projectId, canvasId, DEFAULT_FREEZONE_AGENT_ID)");
    expect(shell).toContain("const explicitAgentId = FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED");
    expect(shell).toContain("preferServerActive:");
    expect(shell).toContain('aria-label={agentHistoryOpen ? "收起历史 Agent" : "打开历史 Agent"}');
    expect(shell.match(/FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED &&/g)?.length).toBeGreaterThanOrEqual(5);
  });
});
