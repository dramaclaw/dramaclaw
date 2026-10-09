// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ChatScope } from "@/features/superchat/types";
import { safeLocalStorageSet } from "@/lib/localStorageQuota";

export type ProjectChatSurface = "director" | "freezone";

export const SUPERCHAT_MESSAGE_CACHE_PREFIX = "superchat:messages:v2:";
export const SUPERCHAT_ACTIVE_TURN_PREFIX = "superchat:active-turn:";

export function buildProjectChatScope(
  project?: string,
  surface: ProjectChatSurface = "director",
  canvasId?: string | null,
  agentId?: string | null,
): ChatScope {
  const name = project?.trim();
  if (name) {
    const normalizedCanvasId = canvasId?.trim() || null;
    const normalizedAgentId = surface === "freezone" ? (agentId?.trim() || "main") : null;
    return {
      kind: "project",
      id: name,
      surface,
      canvasId: surface === "freezone" ? normalizedCanvasId : null,
      ...(surface === "freezone" ? { agentId: normalizedAgentId } : {}),
    };
  }
  return { kind: "home", id: null };
}

export function superChatScopeSessionKey(scope: ChatScope): string {
  if (scope.kind === "project" && scope.id) {
    const surface = scope.surface || "director";
    const canvasSuffix = surface === "freezone" && scope.canvasId ? `:${scope.canvasId}` : "";
    const agentSuffix =
      surface === "freezone"
        ? `:agent:${scope.agentId?.trim() || "main"}`
        : "";
    return `supertale:project:${scope.id}:${surface}${canvasSuffix}${agentSuffix}`;
  }
  if (scope.kind === "freezone" && scope.id) return `supertale:freezone:${scope.id}:main`;
  return "supertale:home:main";
}

export function superChatMessageCacheKey(scopeKey: string): string {
  return `${SUPERCHAT_MESSAGE_CACHE_PREFIX}${scopeKey}`;
}

export function superChatActiveTurnKey(scopeKey: string): string {
  return `${SUPERCHAT_ACTIVE_TURN_PREFIX}${scopeKey}`;
}

export function initializeEmptyFreezoneAgentChat(
  projectId: string,
  canvasId: string,
  agentId: string,
  now = Date.now(),
): string {
  const scopeKey = superChatScopeSessionKey(
    buildProjectChatScope(projectId, "freezone", canvasId, agentId),
  );
  safeLocalStorageSet(superChatMessageCacheKey(scopeKey), JSON.stringify({
    updatedAt: now,
    messages: [],
  }));
  window.localStorage.removeItem(superChatActiveTurnKey(scopeKey));
  window.localStorage.removeItem(`superchat:pinned:${scopeKey}`);
  window.localStorage.removeItem(`superchat:deleted:${scopeKey}`);
  return scopeKey;
}

export const initializeEmptyFreezoneAgentChatForTest = initializeEmptyFreezoneAgentChat;
export const superChatMessageCacheKeyForTest = superChatMessageCacheKey;
export const superChatActiveTurnKeyForTest = superChatActiveTurnKey;
