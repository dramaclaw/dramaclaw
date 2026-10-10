// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addFreezoneCanvasAgent,
  DEFAULT_FREEZONE_AGENT_ID,
  loadFreezoneCanvasAgents,
  loadFreezoneCanvasAgentsWithSource,
  mergeFreezoneCanvasAgentsFromServer,
  selectFreezoneCanvasAgent,
  shouldConnectFreezoneCanvasAgent,
  shouldKeepFreezoneChatPanelMounted,
  updateFreezoneCanvasAgentFromUserMessage,
} from "@/features/freezone/canvasAgents";

function installLocalStorage(value: Storage): () => void {
  const originalWindowStorage = window.localStorage;
  const originalGlobalStorage = globalThis.localStorage;
  Object.defineProperty(window, "localStorage", { value, writable: true, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value, writable: true, configurable: true });
  return () => {
    Object.defineProperty(window, "localStorage", {
      value: originalWindowStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: originalGlobalStorage,
      writable: true,
      configurable: true,
    });
  };
}

describe("Freezone canvas agents", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("creates a default main agent for a canvas", () => {
    const loaded = loadFreezoneCanvasAgentsWithSource("project-a", "canvas-a", 1000);
    const state = loaded.state;

    expect(loaded.hadStoredState).toBe(false);
    expect(state.activeAgentId).toBe(DEFAULT_FREEZONE_AGENT_ID);
    expect(state.agents).toEqual([
      {
        id: DEFAULT_FREEZONE_AGENT_ID,
        name: "新对话",
        createdAt: 1000,
        lastActiveAt: 1000,
      },
    ]);
    expect(loadFreezoneCanvasAgentsWithSource("project-a", "canvas-a", 2000).hadStoredState).toBe(true);
  });

  it("adds new conversations without changing another canvas", () => {
    const first = addFreezoneCanvasAgent("project-a", "canvas-a", 2000);
    const second = addFreezoneCanvasAgent("project-a", "canvas-a", 3000);
    const otherCanvas = loadFreezoneCanvasAgents("project-a", "canvas-b", 4000);

    expect(first.agent).toMatchObject({ id: "agent-2000", name: "新对话" });
    expect(second.agent).toMatchObject({ id: "agent-3000", name: "新对话" });
    expect(second.state.activeAgentId).toBe("agent-3000");
    expect(second.state.agents.map((agent) => agent.id)).toEqual([
      "main",
      "agent-2000",
      "agent-3000",
    ]);
    expect(otherCanvas.agents.map((agent) => agent.id)).toEqual(["main"]);
  });

  it("keeps new conversation ids unique when two are created in the same millisecond", () => {
    const first = addFreezoneCanvasAgent("project-a", "canvas-a", 2000);
    const second = addFreezoneCanvasAgent("project-a", "canvas-a", 2000);

    expect(first.agent.id).toBe("agent-2000");
    expect(second.agent.id).toBe("agent-2000-2");
    expect(second.state.agents.map((agent) => agent.id)).toEqual([
      "main",
      "agent-2000",
      "agent-2000-2",
    ]);
  });

  it("keeps adding a conversation when local storage is full", () => {
    const setItem = vi.fn(() => {
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    });
    const restoreLocalStorage = installLocalStorage({
      length: 0,
      clear: vi.fn(),
      getItem: vi.fn(() => null),
      key: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem,
    });

    try {
      const result = addFreezoneCanvasAgent("project-a", "canvas-a", 2000);

      expect(result.agent).toMatchObject({ id: "agent-2000", name: "新对话" });
      expect(result.state.activeAgentId).toBe("agent-2000");
      expect(result.state.agents.map((agent) => agent.id)).toEqual(["main", "agent-2000"]);
      expect(setItem).toHaveBeenCalled();
    } finally {
      restoreLocalStorage();
    }
  });

  it("persists the active agent per canvas without reordering recency", () => {
    loadFreezoneCanvasAgents("project-a", "canvas-a", 1000);
    addFreezoneCanvasAgent("project-a", "canvas-a", 2000);
    const selected = selectFreezoneCanvasAgent("project-a", "canvas-a", "main");

    expect(selected.activeAgentId).toBe("main");
    expect(selected.agents.find((agent) => agent.id === "main")?.lastActiveAt).toBe(1000);
    expect(loadFreezoneCanvasAgents("project-a", "canvas-a", 4000).activeAgentId).toBe("main");
  });

  it("titles a conversation from its first user message only", () => {
    loadFreezoneCanvasAgents("project-a", "canvas-a", 1000);

    const titled = updateFreezoneCanvasAgentFromUserMessage(
      "project-a",
      "canvas-a",
      "main",
      "我想做个广告短片",
      2000,
    );
    const afterFollowUp = updateFreezoneCanvasAgentFromUserMessage(
      "project-a",
      "canvas-a",
      "main",
      "再加一个音乐节点",
      3000,
    );

    expect(titled.agents.find((agent) => agent.id === "main")).toMatchObject({
      name: "我想做个广告短片",
      lastActiveAt: 2000,
    });
    expect(afterFollowUp.agents.find((agent) => agent.id === "main")).toMatchObject({
      name: "我想做个广告短片",
      lastActiveAt: 3000,
    });
  });

  it("keeps creation timestamps stable when conversations receive new messages", () => {
    loadFreezoneCanvasAgents("project-a", "canvas-a", 1000);
    addFreezoneCanvasAgent("project-a", "canvas-a", 2000);
    addFreezoneCanvasAgent("project-a", "canvas-a", 3000);

    const afterOldConversationMessage = updateFreezoneCanvasAgentFromUserMessage(
      "project-a",
      "canvas-a",
      "main",
      "你好",
      4000,
    );

    expect(afterOldConversationMessage.agents.map((agent) => [agent.id, agent.createdAt])).toEqual([
      ["main", 1000],
      ["agent-2000", 2000],
      ["agent-3000", 3000],
    ]);
    expect(afterOldConversationMessage.agents.find((agent) => agent.id === "main")?.lastActiveAt).toBe(4000);
  });

  it("keeps websocket connections only for active or busy agents", () => {
    expect(shouldConnectFreezoneCanvasAgent({ active: true, busy: false })).toBe(true);
    expect(shouldConnectFreezoneCanvasAgent({ active: false, busy: true })).toBe(true);
    expect(shouldConnectFreezoneCanvasAgent({ active: false, busy: false })).toBe(false);
  });

  it("keeps the chat panel mounted while an agent is busy", () => {
    expect(shouldKeepFreezoneChatPanelMounted({ open: true, busy: false })).toBe(true);
    expect(shouldKeepFreezoneChatPanelMounted({ open: false, busy: true })).toBe(true);
    expect(shouldKeepFreezoneChatPanelMounted({ open: false, busy: false })).toBe(false);
  });

  it("restores the latest server agent when local selection is missing", () => {
    loadFreezoneCanvasAgents("project-a", "canvas-a", 1000);

    const restored = mergeFreezoneCanvasAgentsFromServer(
      "project-a",
      "canvas-a",
      [
        { id: "agent-2", name: "服务端最近会话", createdAt: 2000, lastActiveAt: 5000 },
        { id: "main", name: "服务端主会话", createdAt: 1000, lastActiveAt: 3000 },
      ],
      { preferServerActive: true },
    );

    expect(restored.activeAgentId).toBe("agent-2");
    expect(restored.agents.map((agent) => agent.id)).toEqual(["main", "agent-2"]);
    expect(restored.agents.find((agent) => agent.id === "agent-2")?.name).toBe("服务端最近会话");
  });

  it("keeps a stored local selection over the latest server agent", () => {
    loadFreezoneCanvasAgents("project-a", "canvas-a", 1000);
    addFreezoneCanvasAgent("project-a", "canvas-a", 2000);
    selectFreezoneCanvasAgent("project-a", "canvas-a", "main");

    const restored = mergeFreezoneCanvasAgentsFromServer(
      "project-a",
      "canvas-a",
      [
        { id: "agent-2", name: "服务端最近会话", createdAt: 2000, lastActiveAt: 5000 },
      ],
      { preferServerActive: false },
    );

    expect(restored.activeAgentId).toBe("main");
    expect(restored.agents.find((agent) => agent.id === "agent-2")?.lastActiveAt).toBe(5000);
  });
});
