// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalRequest,
  ChatAttachment,
  ChatMessage,
  ChatScope,
  ClientFrame,
  ModelEntry,
  RelayInstanceInfo,
  ServerFrame,
  SessionControlCommand,
  SuperChatSettings,
} from "@/features/superchat/types";
import {
  buildLocalUserMessage,
  normalizeMessage,
} from "@/features/superchat/message";
import { hasStructuredContent } from "@/features/superchat/spec-extract";
import { api } from "@/lib/api";
import {
  isStaleByTtl,
  pruneLocalStorageByPrefix,
  registerStorageReclaimer,
  safeLocalStorageSet,
} from "@/lib/localStorageQuota";

const SETTINGS_KEY = "superchat:settings";
const EXECUTABLE_HIDDEN_TOOL_NAMES = new Set(["freezone_emit_canvas_command"]);
const MESSAGE_CACHE_PREFIX = "superchat:messages:v2:";
const MESSAGE_CACHE_LIMIT = 50;
// Refresh-recovery caches are best-effort; expire abandoned scopes so their
// blobs (one per conversation) can't accumulate forever and exhaust the quota.
const MESSAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_TURN_PREFIX = "superchat:active-turn:";
const ACTIVE_TURN_TTL_MS = 60 * 60 * 1000;

type ActiveTurnSnapshot = {
  turnId: string;
  startedAt: number;
};

type ChatNotificationResponse = {
  ok: boolean;
  data?: unknown;
};

function loadSettings(): SuperChatSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as Partial<SuperChatSettings>;
    return {
      showToolEvents: raw.showToolEvents ?? false,
      showStructuredSourceWhileStreaming: raw.showStructuredSourceWhileStreaming ?? true,
      uploadTarget: raw.uploadTarget === "local" ? "local" : "openclaw",
    };
  } catch {
    return {
      showToolEvents: false,
      showStructuredSourceWhileStreaming: true,
      uploadTarget: "openclaw",
    };
  }
}

function resolveChatWsUrl(): string {
  const explicit = import.meta.env.VITE_SUPERCHAT_WS_URL;
  if (explicit) return explicit;

  const url = new URL("/api/v1/chat/ws", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function scopeForProject(project?: string): ChatScope {
  const name = project?.trim();
  if (name) return { kind: "project", id: name };
  return { kind: "home", id: null };
}

function scopeSessionKey(scope: ChatScope): string {
  if (scope.kind === "project" && scope.id) return `supertale:project:${scope.id}:main`;
  return "supertale:home:main";
}

function messageCacheKey(scopeKey: string): string {
  return `${MESSAGE_CACHE_PREFIX}${scopeKey}`;
}

// `normalizeMessage` stores the whole source message under `raw`. Across a
// load→save round-trip the loaded (already-normalized) object becomes the new
// `raw`, so an un-stripped `raw` nests one level deeper every refresh and the
// cached blob grows without bound — defeating MESSAGE_CACHE_LIMIT (count-only).
// No consumer reads `raw.raw` (hasStructuredContent / extractSpecsFromRaw /
// the debug panel all read raw's top level), so drop the inner `raw` to cap
// nesting at depth 1.
function denestRaw(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  if (!("raw" in raw)) return raw;
  const { raw: _nested, ...rest } = raw as Record<string, unknown>;
  return rest;
}

// Slim a message down for the refresh-recovery cache: drop the inline
// attachment payload (base64 data URLs etc. — by far the largest field, and
// redundant since url/path/metadata are kept) and the nested `raw` chain.
export function sanitizeMessagesForCache(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const denestedRaw = denestRaw(message.raw);
    const attachments = message.attachments?.length
      ? message.attachments.map((attachment) => {
          if (attachment.content === undefined) return attachment;
          const { content: _content, ...rest } = attachment;
          return rest;
        })
      : message.attachments;
    if (denestedRaw === message.raw && attachments === message.attachments) {
      return message;
    }
    return { ...message, raw: denestedRaw, attachments };
  });
}

function loadCachedMessages(scopeKey: string): ChatMessage[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(messageCacheKey(scopeKey)) || "null",
    ) as unknown;
    // Accept both the legacy bare array and the timestamped wrapper.
    const raw = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { messages?: unknown })?.messages)
        ? (parsed as { messages: unknown[] }).messages
        : [];
    return raw
      .map((message) => normalizeMessage(message))
      .filter((message): message is ChatMessage => Boolean(message));
  } catch {
    return [];
  }
}

function saveCachedMessages(
  scopeKey: string,
  messages: ChatMessage[],
  now = Date.now(),
) {
  const payload = {
    updatedAt: now,
    messages: sanitizeMessagesForCache(messages.slice(-MESSAGE_CACHE_LIMIT)),
  };
  safeLocalStorageSet(messageCacheKey(scopeKey), JSON.stringify(payload));
}

// Reclaim message caches for conversations that haven't been touched within the
// TTL (and any legacy/malformed entries). Runs on mount and as a quota
// reclaimer so a backlog of old chats can't wedge other writes.
export function pruneOldMessageCaches(now = Date.now()): void {
  pruneLocalStorageByPrefix(MESSAGE_CACHE_PREFIX, (_key, raw) => {
    let updatedAt: number | null = null;
    try {
      const parsed = JSON.parse(raw) as { updatedAt?: unknown } | null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : null;
      }
    } catch {
      updatedAt = null; // malformed
    }
    // Legacy arrays / malformed / no-timestamp → reclaim. Surviving scopes
    // rewrite themselves in the timestamped format on their next save.
    return updatedAt == null || isStaleByTtl(updatedAt, now, MESSAGE_CACHE_TTL_MS);
  });
}

registerStorageReclaimer(() => {
  pruneOldMessageCaches();
});

function activeTurnKey(scopeKey: string): string {
  return `${ACTIVE_TURN_PREFIX}${scopeKey}`;
}

function loadActiveTurn(scopeKey: string): ActiveTurnSnapshot | null {
  try {
    const raw = JSON.parse(localStorage.getItem(activeTurnKey(scopeKey)) || "null") as Partial<ActiveTurnSnapshot> | null;
    if (!raw || typeof raw.turnId !== "string" || typeof raw.startedAt !== "number") return null;
    if (!raw.turnId.trim() || Date.now() - raw.startedAt > ACTIVE_TURN_TTL_MS) {
      localStorage.removeItem(activeTurnKey(scopeKey));
      return null;
    }
    return {
      turnId: raw.turnId,
      startedAt: raw.startedAt,
    };
  } catch {
    return null;
  }
}

function saveActiveTurn(scopeKey: string, turnId: string) {
  if (!turnId.trim()) return;
  safeLocalStorageSet(
    activeTurnKey(scopeKey),
    JSON.stringify({ turnId, startedAt: Date.now() } satisfies ActiveTurnSnapshot),
  );
}

function clearActiveTurn(scopeKey: string, turnId?: string | null) {
  try {
    const current = loadActiveTurn(scopeKey);
    if (turnId && current?.turnId && current.turnId !== turnId) return;
    localStorage.removeItem(activeTurnKey(scopeKey));
  } catch {
    // best-effort cleanup
  }
}

function activeTurnIsPending(messages: ChatMessage[], turnId: string | null | undefined): boolean {
  if (!turnId) return false;
  const hasUserMessage = messages.some(
    (message) => message.role === "user" && message.turnId === turnId,
  );
  if (!hasUserMessage) return false;

  return !messages.some(
    (message) =>
      message.role === "assistant"
      && message.turnId === turnId
      && (message.text.trim().length > 0 || hasStructuredContent(message.raw)),
  );
}

function loadPendingActiveTurn(scopeKey: string, messages: ChatMessage[]): ActiveTurnSnapshot | null {
  const activeTurn = loadActiveTurn(scopeKey);
  if (!activeTurn) return null;
  if (activeTurnIsPending(messages, activeTurn.turnId)) return activeTurn;
  clearActiveTurn(scopeKey, activeTurn.turnId);
  return null;
}

function currentTurnIsLive(
  turnId: string | null | undefined,
  messages: ChatMessage[],
): boolean {
  if (!turnId) return false;
  return activeTurnIsPending(messages, turnId);
}

function scopeMatches(a: ChatScope | undefined, b: ChatScope): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "home") return true;
  return (a.id ?? null) === (b.id ?? null);
}

function isChatScope(value: unknown): value is ChatScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  return (
    scope.kind === "home"
    || scope.kind === "project"
    || scope.kind === "asset"
    || scope.kind === "task"
  );
}

function mergeHistory(messages: unknown[]): ChatMessage[] {
  return messages
    .map((message) => normalizeMessage(message))
    .filter((message): message is ChatMessage => Boolean(message));
}

function normalizedText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function messageSignature(message: ChatMessage): string {
  return `${message.role}:${normalizedText(message.text)}`;
}

function assistantTextEquivalent(left: string, right: string): boolean {
  const leftText = normalizedText(left);
  const rightText = normalizedText(right);
  if (!leftText || !rightText) return false;
  return leftText === rightText || leftText.startsWith(rightText) || rightText.startsWith(leftText);
}

function hasEquivalentTextMessage(message: ChatMessage, history: ChatMessage[]): boolean {
  if (message.role !== "assistant") {
    const signature = messageSignature(message);
    return history.some((entry) => {
      if (messageSignature(entry) !== signature) return false;
      if (message.turnId && entry.turnId && message.turnId !== entry.turnId) return false;
      if (message.turnId && !entry.turnId && entry.timestamp < message.timestamp) return false;
      return true;
    });
  }
  return history.some(
    (entry) => {
      if (entry.role !== "assistant") return false;
      if (message.turnId && entry.turnId && message.turnId !== entry.turnId) return false;
      if (message.turnId && !entry.turnId && entry.timestamp < message.timestamp) return false;
      return assistantTextEquivalent(message.text, entry.text);
    },
  );
}

function messageSortRank(message: ChatMessage): number {
  if (message.role === "user") return 0;
  if (message.role === "tool") return 1;
  if (message.role === "assistant") return 2;
  return 3;
}

function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((left, right) => {
    if (left.turnId && right.turnId && left.turnId === right.turnId) {
      const rank = messageSortRank(left) - messageSortRank(right);
      if (rank !== 0) return rank;
    }
    return left.timestamp - right.timestamp;
  });
}

function hasSameTurnMessage(message: ChatMessage, history: ChatMessage[]): boolean {
  if (!message.turnId) return false;
  return history.some((entry) => entry.role === message.role && entry.turnId === message.turnId);
}

function hasEquivalentHistoryMessage(
  message: ChatMessage,
  history: ChatMessage[],
): boolean {
  if (history.some((entry) => entry.id === message.id)) return true;
  if (hasSameTurnMessage(message, history)) return true;
  return hasEquivalentTextMessage(message, history);
}

function hasCompletedTurnInHistory(
  message: ChatMessage,
  history: ChatMessage[],
  current: ChatMessage[],
): boolean {
  if (!message.turnId) return false;
  return turnCompletedInHistory(message.turnId, history, current);
}

function turnCompletedInHistory(
  turnId: string,
  history: ChatMessage[],
  current: ChatMessage[],
): boolean {
  const localUser = current.find(
    (entry) => entry.turnId === turnId && entry.role === "user",
  );
  if (!localUser) return false;

  const backendUser = history.find(
    (entry) =>
      entry.role === "user"
      && normalizedText(entry.text) === normalizedText(localUser.text)
      && entry.timestamp >= localUser.timestamp,
  );
  if (!backendUser) return false;

  return history.some(
    (entry) =>
      entry.role === "assistant"
      && entry.timestamp >= backendUser.timestamp
  );
}

export function mergeHistorySnapshot(
  current: ChatMessage[],
  history: ChatMessage[],
  protectedTurnId: string | null = null,
  preserveTransient = false,
): ChatMessage[] {
  if (current.length === 0) return history;
  if (history.length === 0) return current;
  if (!protectedTurnId && !preserveTransient) {
    return history;
  }

  const preserved = current.filter((message) => {
    const isProtectedTurn = Boolean(protectedTurnId && message.turnId === protectedTurnId);
    if (protectedTurnId && !isProtectedTurn) return false;
    if (message.role === "tool") {
      if (!preserveTransient && !isProtectedTurn) return false;
      return !hasEquivalentHistoryMessage(message, history);
    }
    if (hasCompletedTurnInHistory(message, history, current)) return false;
    return !hasEquivalentHistoryMessage(message, history);
  });

  const protectedLocalUser = protectedTurnId
    ? current.find((entry) => entry.turnId === protectedTurnId && entry.role === "user")
    : null;
  const protectedBackendUser = protectedLocalUser
    ? history.find(
      (entry) =>
        entry.role === "user"
        && normalizedText(entry.text) === normalizedText(protectedLocalUser.text)
        && entry.timestamp >= protectedLocalUser.timestamp,
    )
    : null;
  const protectedBackendAssistant = protectedBackendUser
    ? history.find(
      (entry) =>
        entry.role === "assistant"
        && entry.timestamp >= protectedBackendUser.timestamp,
    )
    : null;
  const protectedToolCount = preserved.filter((message) => message.role === "tool").length;
  let protectedToolIndex = 0;
  const stablePreserved = preserved.map((message) => {
    if (message.role !== "tool" || !protectedBackendUser) return message;
    protectedToolIndex += 1;
    const end = protectedBackendAssistant?.timestamp ?? protectedBackendUser.timestamp + protectedToolCount + 1;
    const gap = Math.max(0.001, end - protectedBackendUser.timestamp);
    return {
      ...message,
      timestamp: protectedBackendUser.timestamp + (gap * protectedToolIndex) / (protectedToolCount + 1),
    };
  });

  return sortMessages([...history, ...stablePreserved]);
}

function upsertAssistantMessage(
  messages: ChatMessage[],
  turnId: string,
  text: string,
): ChatMessage[] {
  const id = `assistant-${turnId}`;
  const existingIndex = messages.findIndex((message) => message.id === id);
  if (existingIndex >= 0) {
    return sortMessages(
      messages.map((message, index) =>
        index === existingIndex
          ? { ...message, text, timestamp: Date.now() }
          : message,
      ),
    );
  }
  return sortMessages([
    ...messages,
    {
      id,
      role: "assistant",
      text,
      turnId,
      timestamp: Date.now(),
    },
  ]);
}

function upsertServerAssistantMessage(
  messages: ChatMessage[],
  payload: unknown,
  turnId?: string,
): ChatMessage[] {
  const nextMessage = normalizeMessage(payload, "assistant");
  if (!nextMessage) return messages;
  const normalizedTurnId = nextMessage.turnId ?? (turnId?.trim() || undefined);
  const mergedMessage = normalizedTurnId ? { ...nextMessage, turnId: normalizedTurnId } : nextMessage;
  const existingIndex = messages.findIndex((message) => message.id === mergedMessage.id);
  const withoutTransient = normalizedTurnId
    ? messages.filter(
        (message, index) =>
          index === existingIndex ||
          !(message.role === "assistant" && message.turnId === normalizedTurnId),
      )
    : messages;
  if (existingIndex >= 0) {
    return sortMessages(
      withoutTransient.map((message) => (message.id === mergedMessage.id ? mergedMessage : message)),
    );
  }
  return sortMessages([...withoutTransient, mergedMessage]);
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const value = result as Record<string, unknown>;
  if (typeof value.text === "string") return value.text;
  return JSON.stringify(result, null, 2);
}

function buildToolMessage(kind: string, payload: unknown): ChatMessage {
  const data = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
  const label =
    typeof data.name === "string"
      ? data.name
      : typeof data.message === "string"
        ? data.message
        : kind;
  const body = "result" in data ? resultText(data.result) : JSON.stringify(payload, null, 2);
  return {
    id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "tool",
    text: body ? `${label}\n\n${body}` : label,
    turnId: typeof data.turn_id === "string" ? data.turn_id : undefined,
    timestamp: Date.now(),
    raw: payload,
  };
}

export function shouldPreserveToolMessage(payload: ServerFrame): boolean {
  const text =
    payload.type === "tool.result" && typeof payload.result === "string"
      ? payload.result
      : payload.type === "tool.result" &&
          payload.result &&
          typeof payload.result === "object" &&
          typeof (payload.result as Record<string, unknown>).text === "string"
        ? String((payload.result as Record<string, unknown>).text)
        : "";
  return (
    (payload.type === "tool.result" || payload.type === "tool.call") &&
    (
      (typeof payload.name === "string" && EXECUTABLE_HIDDEN_TOOL_NAMES.has(payload.name)) ||
      text.includes("canvas_chat_commands.v1") ||
      text.includes("canvas_command_emitted")
    )
  );
}

function upsertToolMessage(messages: ChatMessage[], kind: string, payload: unknown): ChatMessage[] {
  const nextMessage = buildToolMessage(kind, payload);
  if (!nextMessage.turnId) return sortMessages([...messages, nextMessage]);

  const existingIndex = messages.findIndex(
    (message) => message.role === "tool" && message.turnId === nextMessage.turnId,
  );
  if (existingIndex < 0) return sortMessages([...messages, nextMessage]);

  return sortMessages(
    messages.map((message, index) =>
      index === existingIndex
        ? {
          ...message,
          text: nextMessage.text,
          timestamp: nextMessage.timestamp,
          raw: nextMessage.raw,
        }
        : message,
    ),
  );
}

export function useSuperChat({
  project,
  displayName,
}: {
  project?: string;
  displayName: string;
}) {
  const desiredScope = useMemo(() => scopeForProject(project), [project]);
  const scopeKey = useMemo(() => scopeSessionKey(desiredScope), [desiredScope]);
  const initialScopeSnapshot = useMemo(() => {
    const cachedMessages = loadCachedMessages(scopeKey);
    const activeTurn = loadPendingActiveTurn(scopeKey, cachedMessages);
    return {
      cachedMessages,
      activeTurnId: activeTurn?.turnId ?? null,
    };
  }, [scopeKey]);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(() => initialScopeSnapshot.cachedMessages);
  const [historyReady, setHistoryReady] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [relayInstances, setRelayInstances] = useState<RelayInstanceInfo[]>([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>("");
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => new Set());
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set());
  const [settings, setSettingsState] = useState<SuperChatSettings>(() => loadSettings());
  const [busy, setBusy] = useState(() => Boolean(initialScopeSnapshot.activeTurnId));
  const [activeTurnId, setActiveTurnId] = useState<string | null>(initialScopeSnapshot.activeTurnId);
  const streamTextRef = useRef("");
  const messagesRef = useRef<ChatMessage[]>(initialScopeSnapshot.cachedMessages);
  const activeTurnIdRef = useRef<string | null>(initialScopeSnapshot.activeTurnId);
  const pendingClientTurnIdRef = useRef<string | null>(null);
  const recentlyCompletedTurnIdRef = useRef<string | null>(null);
  const cancelledTurnIdsRef = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const closedRef = useRef(false);
  const authRejectedRef = useRef(false);
  const connectionIdRef = useRef(0);

  const sendFrame = useCallback((frame: ClientFrame) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }, []);

  const requestHistory = useCallback(() => {
    sendFrame({ type: "scope.set", scope: desiredScope });
  }, [desiredScope, sendFrame]);

  const markTurnActive = useCallback((turnId: string | null) => {
    if (!turnId) return;
    activeTurnIdRef.current = turnId;
    setActiveTurnId(turnId);
    recentlyCompletedTurnIdRef.current = null;
    saveActiveTurn(scopeKey, turnId);
    setBusy(true);
  }, [scopeKey]);

  const markTurnInactive = useCallback((turnId?: string | null) => {
    clearActiveTurn(scopeKey, turnId);
    streamTextRef.current = "";
    activeTurnIdRef.current = null;
    setActiveTurnId(null);
    pendingClientTurnIdRef.current = null;
    recentlyCompletedTurnIdRef.current = turnId ?? null;
    setStreamText("");
    setBusy(false);
  }, [scopeKey]);

  const setSettings = useCallback((patch: Partial<SuperChatSettings>) => {
    setSettingsState((current) => {
      const next = { ...current, ...patch };
      safeLocalStorageSet(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const finalizeStream = useCallback(() => {
    const turnId = activeTurnIdRef.current ?? `turn-${Date.now()}`;
    if (cancelledTurnIdsRef.current.has(turnId)) {
      markTurnInactive(turnId);
      return;
    }
    setMessages((current) => {
      if (!streamTextRef.current.trim()) return current;
      return upsertAssistantMessage(current, turnId, streamTextRef.current);
    });
    markTurnInactive(turnId);
    // Post-done history refresh is intentionally disabled; final assistant
    // messages are now pushed through assistant.message.
  }, [markTurnInactive]);

  const handleFrame = useCallback((frame: ServerFrame) => {
    switch (frame.type) {
      case "scope.changed": {
        setConnected(true);
        setConnecting(false);
        setError(null);
        const frameScope = isChatScope(frame.scope) ? frame.scope : undefined;
        if (!scopeMatches(frameScope, desiredScope)) break;
        setHistoryReady(true);
        const history = mergeHistory(Array.isArray(frame.history) ? frame.history : []);
        const currentMessages = messagesRef.current;
        const protectedTurnId = activeTurnIdRef.current ?? recentlyCompletedTurnIdRef.current;
        setMessages((current) => {
          const preserveRemoteBusy = frame.busy === true && currentTurnIsLive(protectedTurnId, current);
          return mergeHistorySnapshot(current, history, protectedTurnId, preserveRemoteBusy);
        });
        const activeTurnId = activeTurnIdRef.current;
        if (frame.busy === true && currentTurnIsLive(activeTurnId, currentMessages)) {
          setBusy(true);
        } else if (activeTurnId) {
          if (turnCompletedInHistory(activeTurnId, history, currentMessages)) {
            markTurnInactive(activeTurnId);
          } else if (!currentTurnIsLive(activeTurnId, currentMessages)) {
            markTurnInactive(activeTurnId);
          } else {
            setBusy(true);
          }
        } else if (!activeTurnIdRef.current) {
          streamTextRef.current = "";
          recentlyCompletedTurnIdRef.current = null;
          setStreamText("");
          setBusy(false);
        }
        break;
      }
      case "chat.busy": {
        const message = typeof frame.message === "string" ? frame.message : null;
        if (message) setError(message);
        const turnId =
          activeTurnIdRef.current
          ?? pendingClientTurnIdRef.current
          ?? (typeof frame.turn_id === "string" && frame.turn_id.trim() ? frame.turn_id : null);
        if (turnId) {
          markTurnActive(turnId);
        } else {
          setBusy(true);
        }
        break;
      }
      case "chat.ping": {
        if (
          typeof frame.turn_id === "string"
          && cancelledTurnIdsRef.current.has(frame.turn_id)
        ) {
          break;
        }
        const turnId =
          activeTurnIdRef.current
          ?? pendingClientTurnIdRef.current
          ?? (typeof frame.turn_id === "string" && frame.turn_id.trim() ? frame.turn_id : null);
        if (turnId) {
          markTurnActive(turnId);
        } else {
          setBusy(true);
        }
        break;
      }
      case "thread.started":
        if (
          typeof frame.turn_id === "string"
          && cancelledTurnIdsRef.current.has(frame.turn_id)
        ) {
          break;
        }
        activeTurnIdRef.current = pendingClientTurnIdRef.current
          ?? (typeof frame.turn_id === "string" && frame.turn_id.trim() ? frame.turn_id : activeTurnIdRef.current);
        if (activeTurnIdRef.current) {
          markTurnActive(activeTurnIdRef.current);
        }
        recentlyCompletedTurnIdRef.current = null;
        break;
      case "assistant.delta": {
        const next = typeof frame.text === "string" ? frame.text : "";
        if (!next) break;
        if (
          typeof frame.turn_id === "string"
          && cancelledTurnIdsRef.current.has(frame.turn_id)
        ) {
          break;
        }
        setBusy(true);
        streamTextRef.current = frame.accumulated === false
          ? `${streamTextRef.current}${next}`
          : next;
        const turnId =
          pendingClientTurnIdRef.current
          ?? activeTurnIdRef.current
          ?? (typeof frame.turn_id === "string" && frame.turn_id.trim() ? frame.turn_id : null);
        if (turnId && streamTextRef.current.trim()) {
          markTurnActive(turnId);
          setMessages((current) => {
            const displayText = streamTextRef.current;
            if (!displayText.trim()) return current;
            return upsertAssistantMessage(current, turnId, displayText);
          });
        }
        setStreamText("");
        break;
      }
      case "assistant.message":
        setMessages((current) =>
          upsertServerAssistantMessage(
            current,
            frame.message,
            typeof frame.turn_id === "string" ? frame.turn_id : undefined,
          ),
        );
        break;
      case "tool.call":
        if (
          typeof frame.turn_id === "string"
          && cancelledTurnIdsRef.current.has(frame.turn_id)
        ) {
          break;
        }
        if (settings.showToolEvents || shouldPreserveToolMessage(frame)) {
          setMessages((current) => upsertToolMessage(current, frame.type, frame));
        }
        break;
      case "tool.result":
        if (
          typeof frame.turn_id === "string"
          && cancelledTurnIdsRef.current.has(frame.turn_id)
        ) {
          break;
        }
        if (typeof frame.turn_id === "string" && frame.turn_id.trim()) {
          markTurnActive(frame.turn_id);
        } else {
          setBusy(true);
        }
        if (settings.showToolEvents || shouldPreserveToolMessage(frame)) {
          setMessages((current) => upsertToolMessage(current, frame.type, frame));
        }
        break;
      case "chat.done":
        if (
          typeof frame.turn_id === "string"
          && cancelledTurnIdsRef.current.has(frame.turn_id)
        ) {
          cancelledTurnIdsRef.current.delete(frame.turn_id);
          markTurnInactive(frame.turn_id);
          break;
        }
        finalizeStream();
        break;
      case "project.created":
        setMessages((current) => [...current, buildToolMessage(frame.type, frame)]);
        break;
      case "error":
        setError(typeof frame.message === "string" ? frame.message : "Unknown chat error");
        if (typeof frame.message === "string" && frame.message.includes("当前用户已有 AI 对话正在处理中")) {
          setBusy(true);
          break;
        }
        if (frame.message === "unauthorized") {
          authRejectedRef.current = true;
          closedRef.current = true;
          wsRef.current?.close();
        }
        markTurnInactive(activeTurnIdRef.current ?? pendingClientTurnIdRef.current);
        setConnecting(false);
        break;
      default:
        break;
    }
  }, [desiredScope, finalizeStream, markTurnActive, markTurnInactive, settings.showToolEvents]);

  const connect = useCallback(() => {
    closedRef.current = false;
    authRejectedRef.current = false;
    const connectionId = connectionIdRef.current + 1;
    connectionIdRef.current = connectionId;
    setConnecting(true);
    setError(null);
    if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
    const previous = wsRef.current;
    if (previous) {
      previous.onopen = null;
      previous.onmessage = null;
      previous.onerror = null;
      previous.onclose = null;
      previous.close();
    }

    const ws = new WebSocket(resolveChatWsUrl());
    wsRef.current = ws;
    ws.onopen = () => {
      if (connectionIdRef.current !== connectionId || wsRef.current !== ws) return;
      sendFrame({ type: "scope.set", scope: desiredScope });
    };
    ws.onmessage = (event) => {
      if (connectionIdRef.current !== connectionId || wsRef.current !== ws) return;
      try {
        handleFrame(JSON.parse(String(event.data)) as ServerFrame);
      } catch {
        // Ignore malformed frames from development proxies.
      }
    };
    ws.onerror = () => {
      if (connectionIdRef.current !== connectionId || wsRef.current !== ws) return;
      setError("WebSocket connection failed");
      setConnecting(false);
    };
    ws.onclose = (event) => {
      if (connectionIdRef.current !== connectionId || wsRef.current !== ws) return;
      wsRef.current = null;
      setConnected(false);
      const hasActiveTurn = Boolean(activeTurnIdRef.current ?? pendingClientTurnIdRef.current);
      setConnecting(hasActiveTurn);
      if (hasActiveTurn) {
        setBusy(true);
      }
      if (
        !closedRef.current
        && !authRejectedRef.current
        && event.code !== 1008
      ) {
        setConnecting(true);
        reconnectRef.current = window.setTimeout(connect, 1200);
      }
    };
  }, [desiredScope, handleFrame, sendFrame]);

  const disconnect = useCallback(() => {
    closedRef.current = true;
    connectionIdRef.current += 1;
    if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
    const ws = wsRef.current;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
      wsRef.current = null;
    }
    setConnected(false);
    setConnecting(false);
  }, []);

  useEffect(() => {
    setRelayInstances([]);
    setSelectedInstanceId("");
    setModels([]);
    setActiveModel(null);
    setModelsLoading(false);
    setHistoryReady(false);
    streamTextRef.current = "";
    pendingClientTurnIdRef.current = null;
    recentlyCompletedTurnIdRef.current = null;
    setStreamText("");
    const cachedMessages = loadCachedMessages(scopeKey);
    setMessages(cachedMessages);
    messagesRef.current = cachedMessages;
    const activeTurn = loadPendingActiveTurn(scopeKey, cachedMessages);
    activeTurnIdRef.current = activeTurn?.turnId ?? null;
    setActiveTurnId(activeTurn?.turnId ?? null);
    setBusy(Boolean(activeTurn));
  }, [desiredScope, scopeKey]);

  // Sweep stale/legacy message caches once on mount so abandoned conversations
  // don't accumulate and eventually exhaust the localStorage quota.
  useEffect(() => {
    pruneOldMessageCaches();
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
    saveCachedMessages(scopeKey, messages);
  }, [messages, scopeKey]);

  useEffect(() => {
    const activeTurnId = activeTurnIdRef.current;
    if (!activeTurnId || busy || activeTurnIsPending(messages, activeTurnId)) return;
    clearActiveTurn(scopeKey, activeTurnId);
    activeTurnIdRef.current = null;
    setActiveTurnId(null);
    pendingClientTurnIdRef.current = null;
    setBusy(false);
  }, [busy, messages, scopeKey]);

  useEffect(() => {
    try {
      const pinned = JSON.parse(localStorage.getItem(`superchat:pinned:${scopeKey}`) || "[]");
      const deleted = JSON.parse(localStorage.getItem(`superchat:deleted:${scopeKey}`) || "[]");
      setPinnedIds(new Set(Array.isArray(pinned) ? pinned : []));
      setDeletedIds(new Set(Array.isArray(deleted) ? deleted : []));
    } catch {
      setPinnedIds(new Set());
      setDeletedIds(new Set());
    }
  }, [scopeKey]);

  useEffect(() => {
    const connectTimer = window.setTimeout(connect, 50);
    return () => {
      window.clearTimeout(connectTimer);
      disconnect();
    };
  }, [connect, disconnect]);

  const send = useCallback((text: string, attachments: ChatAttachment[] = [], transportText?: string) => {
    const trimmed = text.trim();
    if (!trimmed || !connected) return false;
    const outboundText = transportText?.trim() || trimmed;
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingClientTurnIdRef.current = turnId;
    markTurnActive(turnId);
    setMessages((current) => [...current, buildLocalUserMessage(trimmed, turnId, displayName, attachments)]);
    streamTextRef.current = "";
    setStreamText("");
    sendFrame({
      type: "chat.message",
      scope: desiredScope,
      text: outboundText,
      turn_id: turnId,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    return true;
  }, [connected, desiredScope, displayName, markTurnActive, sendFrame]);

  const appendNotification = useCallback(async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    try {
      const response = await api
        .post("api/v1/chat/notifications", {
          json: {
            scope: desiredScope,
            text: trimmed,
          },
        })
        .json<ChatNotificationResponse>();
      const message = normalizeMessage(response.data, "assistant");
      if (message) {
        setMessages((current) => sortMessages([...current, message]));
      }
      return true;
    } catch (error) {
      console.error("[superchat] append notification failed", error);
      const fallback = normalizeMessage(
        {
          id: `task-notification-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          content: trimmed,
          created_at: new Date().toISOString(),
        },
        "assistant",
      );
      if (fallback) {
        setMessages((current) => sortMessages([...current, fallback]));
      }
      return false;
    }
  }, [desiredScope]);

  const abort = useCallback(() => {
    const turnId = activeTurnIdRef.current ?? pendingClientTurnIdRef.current;
    if (turnId) {
      cancelledTurnIdsRef.current.add(turnId);
    }
    markTurnInactive(turnId);
    void api.post("api/v1/chat/cancel").catch(() => undefined);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(4000, "client abort");
    }
  }, [markTurnInactive]);

  const resolveApproval = useCallback((_approval: ApprovalRequest, _decision: "allow-once" | "allow-always" | "deny") => {
    setApprovals([]);
  }, []);

  const refreshRelayInstances = useCallback(() => {
    setRelayInstances([]);
  }, []);

  const selectRelayInstance = useCallback((_instanceId: string) => {
    setSelectedInstanceId("");
  }, []);

  const refreshModels = useCallback(() => {
    setModels([]);
    setActiveModel(null);
    setModelsLoading(false);
  }, []);

  const switchModel = useCallback((_modelId: string) => {
    setModelsLoading(false);
  }, []);

  const sessionControl = useCallback((_command: SessionControlCommand, _args?: string) => {
    // novelvideo's native chat endpoint does not expose external session-control commands.
  }, []);

  const persistMessageSet = useCallback((kind: "pinned" | "deleted", next: Set<string>) => {
    safeLocalStorageSet(`superchat:${kind}:${scopeKey}`, JSON.stringify([...next]));
  }, [scopeKey]);

  const togglePin = useCallback((id: string) => {
    setPinnedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistMessageSet("pinned", next);
      return next;
    });
  }, [persistMessageSet]);

  const deleteMessage = useCallback((id: string) => {
    setDeletedIds((current) => {
      const next = new Set(current);
      next.add(id);
      persistMessageSet("deleted", next);
      return next;
    });
    setPinnedIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      persistMessageSet("pinned", next);
      return next;
    });
  }, [persistMessageSet]);

  const clearPinned = useCallback(() => {
    const next = new Set<string>();
    setPinnedIds(next);
    persistMessageSet("pinned", next);
  }, [persistMessageSet]);

  return {
    abort,
    approvals,
    activeTurnId,
    busy,
    connected,
    connecting,
    error,
    activeModel,
    appendNotification,
    clearPinned,
    deleteMessage,
    deletedIds,
    historyReady,
    messages,
    models,
    modelsLoading,
    requestHistory,
    refreshModels,
    refreshRelayInstances,
    relayInstances,
    resolveApproval,
    selectRelayInstance,
    send,
    selectedInstanceId,
    sessionControl,
    setSettings,
    settings,
    pinnedIds,
    streamText,
    switchModel,
    togglePin,
  };
}
