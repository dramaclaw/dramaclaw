// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export const DEFAULT_FREEZONE_AGENT_ID = "main";
export const DEFAULT_FREEZONE_AGENT_NAME = "新对话";

export type FreezoneCanvasAgent = {
  id: string;
  name: string;
  createdAt: number;
  lastActiveAt: number;
};

export type FreezoneCanvasAgentState = {
  agents: FreezoneCanvasAgent[];
  activeAgentId: string;
};

export type FreezoneCanvasAgentLoadResult = {
  state: FreezoneCanvasAgentState;
  hadStoredState: boolean;
};

export function shouldConnectFreezoneCanvasAgent({
  active,
  busy,
}: {
  active: boolean;
  busy: boolean;
}): boolean {
  return active || busy;
}

export function shouldKeepFreezoneChatPanelMounted({
  open,
  busy,
}: {
  open: boolean;
  busy: boolean;
}): boolean {
  return open || busy;
}

const STORAGE_PREFIX = "freezone:canvas-agents:v1:";
const GENERATED_AGENT_NAME_RE = /^(Agent(?: \d+)?|新对话)$/;
const MAX_AGENT_TITLE_LENGTH = 32;

function storageKey(projectId: string, canvasId: string): string {
  return `${STORAGE_PREFIX}${projectId}:${canvasId}`;
}

function defaultAgent(now = Date.now()): FreezoneCanvasAgent {
  return {
    id: DEFAULT_FREEZONE_AGENT_ID,
    name: DEFAULT_FREEZONE_AGENT_NAME,
    createdAt: now,
    lastActiveAt: now,
  };
}

function isGeneratedAgentName(name: string): boolean {
  return GENERATED_AGENT_NAME_RE.test(name.trim());
}

function titleFromUserMessage(text: string): string {
  const compact = text
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return DEFAULT_FREEZONE_AGENT_NAME;
  return compact.length > MAX_AGENT_TITLE_LENGTH
    ? `${compact.slice(0, MAX_AGENT_TITLE_LENGTH - 1)}…`
    : compact;
}

function createAgentId(agents: FreezoneCanvasAgent[], now: number): string {
  const baseId = `agent-${Math.max(0, Math.trunc(now))}`;
  if (!agents.some((agent) => agent.id === baseId)) return baseId;
  let index = 2;
  let id = `${baseId}-${index}`;
  while (agents.some((agent) => agent.id === id)) {
    index += 1;
    id = `${baseId}-${index}`;
  }
  return id;
}

function normalizeState(value: unknown, now = Date.now()): FreezoneCanvasAgentState {
  const fallback = defaultAgent(now);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { agents: [fallback], activeAgentId: fallback.id };
  }
  const record = value as Record<string, unknown>;
  const parsedAgents = Array.isArray(record.agents) ? record.agents : [];
  const agents = parsedAgents
    .map((item): FreezoneCanvasAgent | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const agent = item as Record<string, unknown>;
      const id = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : "";
      if (!id) return null;
      const name = typeof agent.name === "string" && agent.name.trim() ? agent.name.trim() : id;
      return {
        id,
        name,
        createdAt: typeof agent.createdAt === "number" ? agent.createdAt : now,
        lastActiveAt: typeof agent.lastActiveAt === "number" ? agent.lastActiveAt : now,
      };
    })
    .filter((agent): agent is FreezoneCanvasAgent => Boolean(agent));
  if (!agents.some((agent) => agent.id === DEFAULT_FREEZONE_AGENT_ID)) {
    agents.unshift(fallback);
  }
  const activeAgentId =
    typeof record.activeAgentId === "string"
    && agents.some((agent) => agent.id === record.activeAgentId)
      ? record.activeAgentId
      : DEFAULT_FREEZONE_AGENT_ID;
  return { agents, activeAgentId };
}

function readState(projectId: string, canvasId: string, now = Date.now()): FreezoneCanvasAgentState {
  try {
    return normalizeState(
      JSON.parse(window.localStorage.getItem(storageKey(projectId, canvasId)) || "null"),
      now,
    );
  } catch {
    return normalizeState(null, now);
  }
}

function isStorageQuotaError(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  return error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function removeOtherCanvasAgentStates(currentKey: string): void {
  try {
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith(STORAGE_PREFIX) && key !== currentKey)
      .forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function writeState(projectId: string, canvasId: string, state: FreezoneCanvasAgentState): void {
  const key = storageKey(projectId, canvasId);
  const value = JSON.stringify(state);
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    if (!isStorageQuotaError(error)) return;
    removeOtherCanvasAgentStates(key);
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Keep the in-memory state update even if persistence is still full.
    }
  }
}

export function loadFreezoneCanvasAgents(
  projectId: string,
  canvasId: string,
  now = Date.now(),
): FreezoneCanvasAgentState {
  return loadFreezoneCanvasAgentsWithSource(projectId, canvasId, now).state;
}

export function loadFreezoneCanvasAgentsWithSource(
  projectId: string,
  canvasId: string,
  now = Date.now(),
): FreezoneCanvasAgentLoadResult {
  const hadStoredState = (() => {
    try {
      return window.localStorage.getItem(storageKey(projectId, canvasId)) !== null;
    } catch {
      return false;
    }
  })();
  const state = readState(projectId, canvasId, now);
  writeState(projectId, canvasId, state);
  return { state, hadStoredState };
}

export function readFreezoneAgentIdFromUrl(): string | null {
  try {
    const value = new URLSearchParams(window.location.search).get("agent");
    const normalized = value?.trim() ?? "";
    return normalized ? normalized : null;
  } catch {
    return null;
  }
}

export function mergeFreezoneCanvasAgentsFromServer(
  projectId: string,
  canvasId: string,
  serverAgents: FreezoneCanvasAgent[],
  {
    preferServerActive,
    explicitAgentId = null,
  }: {
    preferServerActive: boolean;
    explicitAgentId?: string | null;
  },
): FreezoneCanvasAgentState {
  const state = readState(projectId, canvasId);
  const sanitizedServerAgents = serverAgents
    .filter((agent) => typeof agent.id === "string" && agent.id.trim())
    .map((agent) => ({
      id: agent.id.trim(),
      name: typeof agent.name === "string" && agent.name.trim() ? agent.name.trim() : agent.id.trim(),
      createdAt: Number.isFinite(agent.createdAt) ? agent.createdAt : Date.now(),
      lastActiveAt: Number.isFinite(agent.lastActiveAt) ? agent.lastActiveAt : Date.now(),
    }));
  const serverById = new Map(sanitizedServerAgents.map((agent) => [agent.id, agent]));
  const mergedAgents = state.agents.map((agent) => {
    const serverAgent = serverById.get(agent.id);
    if (!serverAgent) return agent;
    serverById.delete(agent.id);
    return {
      ...agent,
      name: isGeneratedAgentName(agent.name) ? serverAgent.name : agent.name,
      createdAt: Math.min(agent.createdAt, serverAgent.createdAt),
      lastActiveAt: Math.max(agent.lastActiveAt, serverAgent.lastActiveAt),
    };
  });
  mergedAgents.push(...serverById.values());

  const validIds = new Set(mergedAgents.map((agent) => agent.id));
  let activeAgentId = state.activeAgentId;
  if (explicitAgentId && validIds.has(explicitAgentId)) {
    activeAgentId = explicitAgentId;
  } else if (preferServerActive && sanitizedServerAgents.length > 0) {
    activeAgentId = sanitizedServerAgents[0].id;
  } else if (!validIds.has(activeAgentId)) {
    activeAgentId = DEFAULT_FREEZONE_AGENT_ID;
  }

  const next = {
    agents: mergedAgents,
    activeAgentId,
  };
  writeState(projectId, canvasId, next);
  return next;
}

export function addFreezoneCanvasAgent(
  projectId: string,
  canvasId: string,
  now = Date.now(),
): { state: FreezoneCanvasAgentState; agent: FreezoneCanvasAgent } {
  const state = readState(projectId, canvasId, now);
  const id = createAgentId(state.agents, now);
  const agent: FreezoneCanvasAgent = {
    id,
    name: DEFAULT_FREEZONE_AGENT_NAME,
    createdAt: now,
    lastActiveAt: now,
  };
  const next = {
    agents: [...state.agents, agent],
    activeAgentId: agent.id,
  };
  writeState(projectId, canvasId, next);
  return { state: next, agent };
}

export function selectFreezoneCanvasAgent(
  projectId: string,
  canvasId: string,
  agentId: string,
): FreezoneCanvasAgentState {
  const state = readState(projectId, canvasId);
  const activeAgentId = state.agents.some((agent) => agent.id === agentId)
    ? agentId
    : DEFAULT_FREEZONE_AGENT_ID;
  const next = {
    agents: state.agents,
    activeAgentId,
  };
  writeState(projectId, canvasId, next);
  return next;
}

export function updateFreezoneCanvasAgentFromUserMessage(
  projectId: string,
  canvasId: string,
  agentId: string,
  message: string,
  now = Date.now(),
): FreezoneCanvasAgentState {
  const state = readState(projectId, canvasId, now);
  const normalizedAgentId = state.agents.some((agent) => agent.id === agentId)
    ? agentId
    : DEFAULT_FREEZONE_AGENT_ID;
  const title = titleFromUserMessage(message);
  const next = {
    agents: state.agents.map((agent) => {
      if (agent.id !== normalizedAgentId) return agent;
      return {
        ...agent,
        name: isGeneratedAgentName(agent.name) ? title : agent.name,
        lastActiveAt: now,
      };
    }),
    activeAgentId: state.activeAgentId,
  };
  writeState(projectId, canvasId, next);
  return next;
}
