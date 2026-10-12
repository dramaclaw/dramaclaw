// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import {
  initializeEmptyFreezoneAgentChatForTest,
  superChatActiveTurnKeyForTest,
  superChatMessageCacheKeyForTest,
} from "@/features/superchat/freezoneChatScopeCache";

describe("freezone chat scope cache", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("initializes a new agent with an empty message cache and no active turn", () => {
    const oldScopeKey = "supertale:project:project-a:freezone:canvas-a:agent:agent-old";
    window.localStorage.setItem(
      superChatMessageCacheKeyForTest(oldScopeKey),
      JSON.stringify({
        updatedAt: 1000,
        messages: [{ id: "old", role: "user", text: "旧消息", timestamp: 1000 }],
      }),
    );

    const newScopeKey = initializeEmptyFreezoneAgentChatForTest("project-a", "canvas-a", "agent-new", 2000);

    expect(newScopeKey).toBe("supertale:project:project-a:freezone:canvas-a:agent:agent-new");
    expect(JSON.parse(window.localStorage.getItem(superChatMessageCacheKeyForTest(newScopeKey)) || "null")).toEqual({
      updatedAt: 2000,
      messages: [],
    });
    expect(window.localStorage.getItem(superChatActiveTurnKeyForTest(newScopeKey))).toBeNull();
    expect(window.localStorage.getItem(superChatMessageCacheKeyForTest(oldScopeKey))).not.toBeNull();
  });
});
