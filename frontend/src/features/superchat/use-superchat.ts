// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatAttachment,
  ChatMessage,
  ChatMessagePart,
  ChatRole,
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
import {
  buildProjectChatScope,
  SUPERCHAT_MESSAGE_CACHE_PREFIX,
  superChatActiveTurnKey,
  superChatMessageCacheKey,
  superChatScopeSessionKey,
  type ProjectChatSurface,
} from "@/features/superchat/freezoneChatScopeCache";
import { hasStructuredContent } from "@/features/superchat/spec-extract";
import {
  FREEZONE_CANVAS_COMMAND_TOOL_RESULT_EVENT,
  type CanvasCommandToolResultPayload,
} from "@/features/freezone/canvasCommandToolResult";
import {
  FREEZONE_CANVAS_CONTEXT_TOOL_RESULT_EVENT,
  type CanvasContextToolResultPayload,
} from "@/features/freezone/canvasContextToolResult";
import { FREEZONE_CANVAS_WRITE_TOOL_NAME_SET } from "@/features/freezone/canvasCommandTools";
import { CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE } from "@/features/freezone/chatNodeReferences";
import { api } from "@/lib/api";
import {
  isStaleByTtl,
  pruneLocalStorageByPrefix,
  registerStorageReclaimer,
  safeLocalStorageSet,
} from "@/lib/localStorageQuota";

const SETTINGS_KEY = "superchat:settings";
const EXECUTABLE_HIDDEN_TOOL_NAMES = FREEZONE_CANVAS_WRITE_TOOL_NAME_SET;
const INTERNAL_HIDDEN_TOOL_STATUS_NAMES = new Set<string>([
  "freezone_get_audio_voice_options",
  "freezone_get_canvas_action_catalog",
  "freezone_get_canvas_command_catalog",
  "freezone_get_canvas_ontology",
  "freezone_get_link_type_catalog",
  "freezone_get_mainline_projection_assets",
  "freezone_begin_agent_catalog_draft",
  "freezone_finish_agent_catalog_draft",
  "freezone_get_neighbor_graph",
  "freezone_get_node_action_catalog",
  "freezone_get_node_create_schema",
  "freezone_get_node_detail",
  "freezone_get_selection",
  "freezone_get_slot_candidates",
  "freezone_put_agent_catalog_recipe",
  "freezone_put_agent_catalog_skill",
  "freezone_request_user_clarification",
  "freezone_summarize_canvas",
  "freezone_validate_canvas_commands",
  "tool_describe",
  "tool describe",
  "tool-describe",
  "Tool Describe",
  "ToolDescribe",
  "tool_search",
  "tool search",
  "tool-search",
  "Tool Search",
  "ToolSearch",
]);

function normalizeToolStatusName(name: string): string {
  return name.trim().replace(/[\s_-]+/gu, " ").toLowerCase();
}

function isInternalHiddenToolStatusName(name: string): boolean {
  if (INTERNAL_HIDDEN_TOOL_STATUS_NAMES.has(name)) return true;
  const normalized = normalizeToolStatusName(name);
  return normalized === "tool search" || normalized === "tool describe";
}
export const SUPERCHAT_CANVAS_COMMAND_EVENT = "superchat/canvas-command";
export const SUPERCHAT_CANVAS_CONTEXT_REQUEST_EVENT = "superchat/canvas-context-request";
const MESSAGE_CACHE_PREFIX = SUPERCHAT_MESSAGE_CACHE_PREFIX;
const MESSAGE_CACHE_LIMIT = 50;
// Refresh-recovery caches are best-effort; expire abandoned scopes so their
// blobs (one per conversation) can't accumulate forever and exhaust the quota.
const MESSAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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

// Development-only transport diagnostics. Never log prompt text, attachments,
// cookies, or gateway credentials; these events are enough to locate a stalled
// turn between the browser, WebSocket, API, and Hermes.
const SUPERCHAT_DEBUG = import.meta.env.DEV;
function superchatDebug(event: string, details?: Record<string, unknown>) {
  if (SUPERCHAT_DEBUG) console.info(`[superchat] ${event}`, details ?? "");
}

function scopeForProject(
  project?: string,
  surface: ProjectChatSurface = "director",
  canvasId?: string | null,
  agentId?: string | null,
): ChatScope {
  return buildProjectChatScope(project, surface, canvasId, agentId);
}

function scopeSessionKey(scope: ChatScope): string {
  return superChatScopeSessionKey(scope);
}

export const scopeForProjectForTest = scopeForProject;
export const scopeSessionKeyForTest = scopeSessionKey;

function messageCacheKey(scopeKey: string): string {
  return superChatMessageCacheKey(scopeKey);
}

function frameScope(frame: ServerFrame): ChatScope | null {
  const scopedFrame = frame as { scope?: unknown };
  return isChatScope(scopedFrame.scope) ? scopedFrame.scope : null;
}

function frameScopeSessionKey(frame: ServerFrame): string | null {
  const scope = frameScope(frame);
  return scope ? scopeSessionKey(scope) : null;
}

function frameMatchesCurrentScope(frame: ServerFrame, currentScope: ChatScope): boolean {
  const scope = frameScope(frame);
  return !scope || scopeMatches(scope, currentScope);
}

function updateCachedMessagesForScope(
  scopeKey: string,
  updater: (messages: ChatMessage[]) => ChatMessage[],
): void {
  saveCachedMessages(scopeKey, updater(loadCachedMessages(scopeKey)));
}

function dedupeMessagesById(messages: ChatMessage[]): ChatMessage[] {
  const unique: ChatMessage[] = [];
  const indexById = new Map<string, number>();
  for (const message of messages) {
    const existingIndex = indexById.get(message.id);
    if (existingIndex === undefined) {
      indexById.set(message.id, unique.length);
      unique.push(message);
    } else {
      unique[existingIndex] = message;
    }
  }
  return unique;
}

export const dedupeMessagesByIdForTest = dedupeMessagesById;

function isFreezoneScope(scope?: ChatScope | null): boolean {
  if (!scope) return false;
  return scope.kind === "freezone" || (scope.kind === "project" && scope.surface === "freezone");
}

function isFreezoneScopeKey(scopeKey: string): boolean {
  return scopeKey.startsWith("supertale:freezone:") || scopeKey.includes(":freezone");
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isFreezoneCanvasReferenceAttachmentLike(value: unknown): value is Record<string, unknown> {
  const record = recordValue(value);
  if (!record) return false;
  return (
    record.type === CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE ||
    record.kind === CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE
  );
}

function normalizeFreezoneCanvasReferenceAttachment(value: unknown): ChatAttachment | null {
  if (!isFreezoneCanvasReferenceAttachmentLike(value)) return null;
  const id = stringValue(value.id);
  const label = stringValue(value.label) ?? stringValue(value.fileName);
  const content = stringValue(value.content) ?? stringValue(value.url);
  const path = stringValue(value.path);
  const url = stringValue(value.url);
  const fileName = stringValue(value.fileName) ?? label;
  return {
    id: id ?? `${CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE}:${label ?? path ?? url ?? "node"}`,
    type: CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
    kind: CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
    mimeType: stringValue(value.mimeType),
    fileName,
    content,
    url,
    path,
    label,
  };
}

function collectFreezoneCanvasReferenceAttachments(source: unknown, depth = 0): ChatAttachment[] {
  const record = recordValue(source);
  if (!record || depth > 2) return [];
  const references: ChatAttachment[] = [];
  for (const field of ["attachments", "media", "rawAttachments", "rawMedia"] as const) {
    const items = record[field];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const attachment = normalizeFreezoneCanvasReferenceAttachment(item);
      if (attachment) references.push(attachment);
    }
  }
  if (record.raw) {
    references.push(...collectFreezoneCanvasReferenceAttachments(record.raw, depth + 1));
  }
  return references;
}

function freezoneAttachmentKeys(attachment: ChatAttachment): string[] {
  return [
    attachment.id,
    attachment.label,
    attachment.fileName,
    attachment.path,
    attachment.url,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function sameFreezoneCanvasReference(left: ChatAttachment, right: ChatAttachment): boolean {
  const leftKeys = new Set(freezoneAttachmentKeys(left));
  return freezoneAttachmentKeys(right).some((key) => leftKeys.has(key));
}

function hydrateFreezoneCanvasReferences(message: ChatMessage, source: unknown): ChatMessage {
  const references = collectFreezoneCanvasReferenceAttachments(source).reduce<ChatAttachment[]>(
    (items, reference) => {
      const existingIndex = items.findIndex((item) => sameFreezoneCanvasReference(item, reference));
      if (existingIndex < 0) return [...items, reference];
      if (!items[existingIndex]?.content && reference.content) {
        const next = [...items];
        next[existingIndex] = reference;
        return next;
      }
      return items;
    },
    [],
  );
  if (references.length === 0) return message;

  const existing = message.attachments ?? [];
  const canvasExisting = existing.filter(isFreezoneCanvasReferenceAttachmentLike);
  const nonCanvasAttachments = existing.filter(
    (attachment) =>
      !isFreezoneCanvasReferenceAttachmentLike(attachment) &&
      !references.some((reference) => sameFreezoneCanvasReference(attachment, reference)),
  );
  const hydratedCanvas = canvasExisting.map((attachment) => {
    if (attachment.content) return attachment;
    const replacement = references.find((reference) => sameFreezoneCanvasReference(attachment, reference));
    return replacement ?? attachment;
  });
  const appendedReferences = references.filter(
    (reference) =>
      !hydratedCanvas.some((attachment) => sameFreezoneCanvasReference(attachment, reference)),
  );
  const attachments = [...nonCanvasAttachments, ...hydratedCanvas, ...appendedReferences];
  return { ...message, attachments };
}

function normalizeMessageForScope(
  message: unknown,
  fallbackRole: ChatRole = "assistant",
  scope?: ChatScope | null,
): ChatMessage | null {
  const normalized = normalizeMessage(message, fallbackRole);
  if (!normalized || !isFreezoneScope(scope)) return normalized;
  return hydrateFreezoneCanvasReferences(normalized, message);
}

export const normalizeMessageForScopeForTest = normalizeMessageForScope;

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
type MessageCacheSanitizeOptions = {
  preserveFreezoneCanvasReferences?: boolean;
};

export function sanitizeMessagesForCache(
  messages: ChatMessage[],
  options: MessageCacheSanitizeOptions = {},
): ChatMessage[] {
  return messages.map((message) => {
    const denestedRaw = message.role === "tool" && message.id.startsWith("agent-tool-")
      ? undefined
      : denestRaw(message.raw);
    const attachments = message.attachments?.length
      ? message.attachments.map((attachment) => {
          if (attachment.content === undefined) return attachment;
          if (
            options.preserveFreezoneCanvasReferences &&
            isFreezoneCanvasReferenceAttachmentLike(attachment)
          ) {
            return attachment;
          }
          const { content: _content, ...rest } = attachment;
          return rest;
        })
      : message.attachments;
    const sanitizedParts = message.parts;
    if (
      denestedRaw === message.raw
      && attachments === message.attachments
      && sanitizedParts === message.parts
    ) {
      return message;
    }
    return { ...message, raw: denestedRaw, attachments, parts: sanitizedParts };
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
    return dedupeMessagesById(
      raw
        .map((message) =>
          normalizeMessageForScope(
            message,
            "assistant",
            isFreezoneScopeKey(scopeKey) ? { kind: "freezone", id: scopeKey } : null,
          ),
        )
        .filter((message): message is ChatMessage => Boolean(message)),
    );
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
    messages: sanitizeMessagesForCache(dedupeMessagesById(messages).slice(-MESSAGE_CACHE_LIMIT), {
      preserveFreezoneCanvasReferences: isFreezoneScopeKey(scopeKey),
    }),
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
  return superChatActiveTurnKey(scopeKey);
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

export function shouldKeepActiveTurnAfterScopeSync(
  serverBusy: unknown,
  turnId: string | null | undefined,
  messages: ChatMessage[],
): boolean {
  return serverBusy === true && currentTurnIsLive(turnId, messages);
}

function scopeMatches(a: ChatScope | undefined, b: ChatScope): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "home") return true;
  if (a.kind === "project" && b.kind === "project") {
    return (
      (a.id ?? null) === (b.id ?? null)
      && (a.surface ?? "director") === (b.surface ?? "director")
      && ((a.surface ?? "director") !== "freezone" || (a.canvasId ?? null) === (b.canvasId ?? null))
      && ((a.surface ?? "director") !== "freezone" || (a.agentId ?? "main") === (b.agentId ?? "main"))
    );
  }
  return (a.id ?? null) === (b.id ?? null);
}

function isChatScope(value: unknown): value is ChatScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  return (
    scope.kind === "home"
    || scope.kind === "project"
    || scope.kind === "freezone"
    || scope.kind === "asset"
    || scope.kind === "task"
  );
}

function mergeHistory(messages: unknown[], scope?: ChatScope | null): ChatMessage[] {
  return dedupeMessagesById(
    messages
      .map((message) => normalizeMessageForScope(message, "assistant", scope))
      .filter((message): message is ChatMessage => Boolean(message)),
  );
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

function recordString(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : null;
}

function uiEventMergeKey(event: unknown): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const value = event as Record<string, unknown>;
  const type = recordString(value, "type");
  if (!type) return null;
  if (type === "skill_studio.status") return type;
  const stableId =
    recordString(value, "bridge_key")
    ?? recordString(value, "skill_studio_session_id")
    ?? recordString(value, "clarification_id");
  if (!stableId) return null;
  return `${type}:${stableId}`;
}

function mergeUiEventLists(base: unknown[] | undefined, overlay: unknown[] | undefined): unknown[] | undefined {
  const events: unknown[] = [];
  for (const event of [...(base ?? []), ...(overlay ?? [])]) {
    const key = uiEventMergeKey(event);
    if (!key) {
      const serialized = JSON.stringify(event);
      if (!events.some((candidate) => JSON.stringify(candidate) === serialized)) events.push(event);
      continue;
    }
    const existingIndex = events.findIndex((candidate) => uiEventMergeKey(candidate) === key);
    if (existingIndex >= 0) {
      events[existingIndex] = {
        ...(events[existingIndex] as Record<string, unknown>),
        ...(event as Record<string, unknown>),
      };
    } else {
      events.push(event);
    }
  }
  return events.length > 0 ? events : undefined;
}

function appendTextPart(parts: ChatMessagePart[] | undefined, text: string): ChatMessagePart[] | undefined {
  if (!text) return parts;
  const nextParts = [...(parts ?? [])];
  const last = nextParts[nextParts.length - 1];
  if (last?.type === "text") {
    nextParts[nextParts.length - 1] = { ...last, text: `${last.text}${text}` };
  } else {
    nextParts.push({ id: `text-${nextParts.length + 1}`, type: "text", text });
  }
  return nextParts;
}

function textFromParts(parts: ChatMessagePart[]): string {
  return parts
    .filter((part): part is Extract<ChatMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function assistantPartsWithFinalText(
  parts: ChatMessagePart[],
  finalText?: string,
): ChatMessagePart[] {
  const text = typeof finalText === "string" ? finalText : "";
  if (!text.trim()) return parts;
  const existingText = textFromParts(parts);
  if (!existingText) {
    return appendTextPart(parts, text) ?? parts;
  }
  if (text === existingText) return parts;
  if (text.startsWith(existingText)) {
    return appendTextPart(parts, text.slice(existingText.length)) ?? parts;
  }
  return parts;
}

function assistantPartsWithText(
  parts: ChatMessagePart[] | undefined,
  previousText: string,
  nextText: string,
): ChatMessagePart[] | undefined {
  if (!nextText) return parts;
  const baseParts = removeSkillStudioStatusParts(parts, { keepRealProgress: true });
  if (previousText && nextText.startsWith(previousText)) {
    return appendTextPart(baseParts, nextText.slice(previousText.length));
  }
  if (nextText === previousText) return parts;
  const nonTextParts = baseParts?.filter((part) => part.type !== "text") ?? [];
  if (nonTextParts.length > 0) {
    return appendTextPart(nonTextParts, nextText);
  }
  return [{ id: "text-1", type: "text", text: nextText }];
}

function assistantPartsForPersistence(
  parts: ChatMessagePart[] | undefined,
  text: string | undefined,
): ChatMessagePart[] | undefined {
  if (!parts?.length) return parts;
  if (!text || parts.some((part) => part.type === "text")) return parts;
  if (!parts.some((part) => part.type !== "text")) return parts;
  return [...parts, { id: `text-${parts.length + 1}`, type: "text", text }];
}

type AssistantEventPartType = Exclude<ChatMessagePart["type"], "text">;

function eventPartType(event: unknown): AssistantEventPartType | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const type = (event as Record<string, unknown>).type;
  if (typeof type !== "string") return null;
  if (type.startsWith("skill_studio.")) return "skill_studio";
  if (type.startsWith("assistant.clarification.")) return "clarification";
  return null;
}

function isSkillStudioStatusEvent(event: unknown): boolean {
  return Boolean(
    event
    && typeof event === "object"
    && !Array.isArray(event)
    && (event as Record<string, unknown>).type === "skill_studio.status",
  );
}

function isRealSkillStudioProgressStatusEvent(event: unknown): boolean {
  if (!isSkillStudioStatusEvent(event)) return false;
  const status = (event as Record<string, unknown>).status;
  return status === "draft_begin"
    || status === "draft_skill_ready"
    || status === "draft_recipe_ready";
}

function removeSkillStudioStatusParts(
  parts: ChatMessagePart[] | undefined,
  options: { keepRealProgress?: boolean } = {},
): ChatMessagePart[] | undefined {
  if (!parts?.length) return parts;
  const nextParts = parts.filter((part) => {
    if (part.type !== "skill_studio" || !isSkillStudioStatusEvent(part.event)) return true;
    return options.keepRealProgress === true && isRealSkillStudioProgressStatusEvent(part.event);
  });
  return nextParts.length === parts.length ? parts : nextParts;
}

function removeTransientSkillStudioStatusUiEvents(events: unknown[] | undefined): unknown[] | undefined {
  if (!events?.length) return events;
  const nextEvents = events.filter((event) =>
    !isSkillStudioStatusEvent(event) || isRealSkillStudioProgressStatusEvent(event),
  );
  return nextEvents.length === events.length ? events : nextEvents.length > 0 ? nextEvents : undefined;
}

function assistantPartsWithUiEvent(
  parts: ChatMessagePart[] | undefined,
  event: unknown,
): ChatMessagePart[] | undefined {
  const type = eventPartType(event);
  if (!type) return parts;
  const key = uiEventMergeKey(event);
  const nextParts = [...(isSkillStudioStatusEvent(event) ? parts ?? [] : removeSkillStudioStatusParts(parts) ?? [])];
  const existingIndex = key
    ? nextParts.findIndex((part) => part.type !== "text" && uiEventMergeKey(part.event) === key)
    : -1;
  if (existingIndex >= 0) {
    const existing = nextParts[existingIndex];
    if (existing.type !== "text") {
      nextParts[existingIndex] = { ...existing, event };
    }
    return nextParts;
  }
  nextParts.push({ id: key ?? `${type}-${nextParts.length + 1}`, type, event });
  return nextParts;
}

function nextAssistantPartSeq(parts: ChatMessagePart[] | undefined): number {
  return (parts ?? []).reduce(
    (max, part) => Math.max(max, typeof part.seq === "number" ? part.seq : 0),
    0,
  ) + 1;
}

function assistantPartsWithSequencedUiEvent(
  parts: ChatMessagePart[] | undefined,
  event: unknown,
): ChatMessagePart[] | undefined {
  const type = eventPartType(event);
  if (!type) return parts;
  const key = uiEventMergeKey(event);
  const nextParts = [...(isSkillStudioStatusEvent(event) ? parts ?? [] : removeSkillStudioStatusParts(parts) ?? [])];
  const existingIndex = key
    ? nextParts.findIndex((part) => part.type !== "text" && uiEventMergeKey(part.event) === key)
    : -1;
  if (existingIndex >= 0) {
    const existing = nextParts[existingIndex];
    if (existing.type !== "text") {
      nextParts[existingIndex] = { ...existing, event, seq: existing.seq };
    }
    return nextParts;
  }
  nextParts.push({
    id: key ?? `${type}-${nextParts.length + 1}`,
    type,
    event,
    seq: nextAssistantPartSeq(nextParts),
  });
  return nextParts;
}

function assistantPartsWithPart(
  parts: ChatMessagePart[] | undefined,
  part: ChatMessagePart,
): ChatMessagePart[] {
  const nextParts = [...(parts ?? [])];
  const existingIndex = nextParts.findIndex((item) => item.id === part.id);
  if (existingIndex >= 0) {
    const existing = nextParts[existingIndex];
    nextParts[existingIndex] = {
      ...part,
      seq: part.seq ?? existing.seq,
    };
    return nextParts;
  }
  nextParts.push(part);
  return nextParts;
}

function assistantPartsWithoutPart(
  parts: ChatMessagePart[] | undefined,
  partId: string,
): ChatMessagePart[] | undefined {
  if (!parts?.length) return parts;
  const nextParts = parts.filter((part) => part.id !== partId);
  return nextParts.length > 0 ? nextParts : undefined;
}

function stableUiEventMergeKey(part: ChatMessagePart): string {
  if (part.type === "text") return part.id;
  return uiEventMergeKey(part.event) ?? part.id;
}

function mergeAssistantMessageParts(
  transientParts: ChatMessagePart[],
  finalParts: ChatMessagePart[] | undefined,
  finalText?: string,
): ChatMessagePart[] | undefined {
  const stableTransientParts = removeSkillStudioStatusParts(transientParts, { keepRealProgress: true }) ?? [];
  const stableFinalParts = removeSkillStudioStatusParts(finalParts, { keepRealProgress: true });
  if (!stableFinalParts?.length) {
    if (stableTransientParts.length === 0) return undefined;
    return assistantPartsWithFinalText(stableTransientParts, finalText);
  }
  if (stableTransientParts.length === 0) return stableFinalParts;
  const finalKeys = new Set(
    stableFinalParts
      .filter((part) => part.type !== "text")
      .map(stableUiEventMergeKey),
  );
  const transientKeys = new Set(
    stableTransientParts
      .filter((part) => part.type !== "text")
      .map(stableUiEventMergeKey),
  );
  const hasOrderedTransientParts = stableTransientParts.some((part) =>
    part.type === "text" || typeof part.seq === "number",
  );
  if (hasOrderedTransientParts) {
    const missingFinalParts = stableFinalParts.filter((part) => {
      if (part.type === "text") return false;
      return !transientKeys.has(stableUiEventMergeKey(part));
    });
    return assistantPartsWithFinalText([...stableTransientParts, ...missingFinalParts], finalText);
  }
  const missingTransientParts = stableTransientParts.filter((part) => {
    if (part.type === "text") return false;
    return !finalKeys.has(stableUiEventMergeKey(part));
  });
  if (missingTransientParts.length === 0) return stableFinalParts;
  return [...stableFinalParts, ...missingTransientParts];
}

function isRecoverableUiEventState(event: unknown): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const value = event as Record<string, unknown>;
  if (value.submitted === true || value.cancelled === true) return true;
  return value.type === "skill_studio.draft"
    && Boolean(value.draft && typeof value.draft === "object" && !Array.isArray(value.draft));
}

function mergeRecoverableUiEventsFromCurrent(history: ChatMessage[], current: ChatMessage[]): ChatMessage[] {
  const recoverableByTurn = new Map<string, unknown[]>();
  for (const message of current) {
    if (message.role !== "assistant" || !message.turnId || !message.uiEvents?.length) continue;
    const recoverableEvents = message.uiEvents.filter(isRecoverableUiEventState);
    if (recoverableEvents.length === 0) continue;
    recoverableByTurn.set(message.turnId, [
      ...(recoverableByTurn.get(message.turnId) ?? []),
      ...recoverableEvents,
    ]);
  }
  if (recoverableByTurn.size === 0) return history;
  return history.map((message) => {
    if (message.role !== "assistant" || !message.turnId) return message;
    const recoverableEvents = recoverableByTurn.get(message.turnId);
    if (!recoverableEvents?.length) return message;
    const uiEvents = mergeUiEventLists(message.uiEvents, recoverableEvents);
    return uiEvents ? { ...message, uiEvents } : message;
  });
}

export function mergeHistorySnapshot(
  current: ChatMessage[],
  history: ChatMessage[],
  protectedTurnId: string | null = null,
  preserveTransient = false,
): ChatMessage[] {
  const uniqueCurrent = dedupeMessagesById(current);
  const uniqueHistory = dedupeMessagesById(history);
  const historyWithRecoverableUiEvents = mergeRecoverableUiEventsFromCurrent(
    uniqueHistory,
    uniqueCurrent,
  );
  if (uniqueCurrent.length === 0) return historyWithRecoverableUiEvents;
  if (uniqueHistory.length === 0) return uniqueCurrent;
  if (!protectedTurnId && !preserveTransient) {
    return historyWithRecoverableUiEvents;
  }

  const preserved = uniqueCurrent.filter((message) => {
    const isProtectedTurn = Boolean(protectedTurnId && message.turnId === protectedTurnId);
    if (protectedTurnId && !isProtectedTurn) return false;
    if (message.role === "tool") {
      if (!preserveTransient && !isProtectedTurn) return false;
      return !hasEquivalentHistoryMessage(message, historyWithRecoverableUiEvents);
    }
    if (hasCompletedTurnInHistory(message, historyWithRecoverableUiEvents, uniqueCurrent)) {
      return false;
    }
    return !hasEquivalentHistoryMessage(message, historyWithRecoverableUiEvents);
  });

  const protectedLocalUser = protectedTurnId
    ? uniqueCurrent.find((entry) => entry.turnId === protectedTurnId && entry.role === "user")
    : null;
  const protectedBackendUser = protectedLocalUser
    ? historyWithRecoverableUiEvents.find(
      (entry) =>
        entry.role === "user"
        && normalizedText(entry.text) === normalizedText(protectedLocalUser.text)
        && entry.timestamp >= protectedLocalUser.timestamp,
    )
    : null;
  const protectedBackendAssistant = protectedBackendUser
    ? historyWithRecoverableUiEvents.find(
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

  return dedupeMessagesById(
    sortMessages([...historyWithRecoverableUiEvents, ...stablePreserved]),
  );
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
          ? {
              ...message,
              text,
              parts: assistantPartsWithText(message.parts, message.text, text),
              timestamp: Date.now(),
            }
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
      parts: assistantPartsWithText(undefined, "", text),
      turnId,
      timestamp: Date.now(),
    },
  ]);
}

export const upsertAssistantMessageForTest = upsertAssistantMessage;

function upsertAssistantUiEvent(
  messages: ChatMessage[],
  turnId: string,
  event: unknown,
): ChatMessage[] {
  const receivedAt = Date.now();
  const eventWithReceivedAt = event && typeof event === "object" && !Array.isArray(event)
    ? {
        ...(event as Record<string, unknown>),
        received_at:
          typeof (event as Record<string, unknown>).received_at === "number"
            ? (event as Record<string, unknown>).received_at
            : receivedAt,
      }
    : event;
  const id = `assistant-${turnId}`;
  const existingIndex = messages.findIndex((message) => message.id === id);
  if (existingIndex >= 0) {
    return sortMessages(
      messages.map((message, index) => {
        if (index !== existingIndex) return message;
        const uiEvents = [...(message.uiEvents ?? []), eventWithReceivedAt];
        return {
          ...message,
          text: message.text || "",
          parts: assistantPartsWithSequencedUiEvent(message.parts, eventWithReceivedAt),
          uiEvents,
        };
      }),
    );
  }
  const partType = eventPartType(eventWithReceivedAt);
  const parts = partType
    ? [{ id: uiEventMergeKey(eventWithReceivedAt) ?? `${partType}-1`, type: partType, event: eventWithReceivedAt, seq: 1 }]
    : assistantPartsWithUiEvent(undefined, eventWithReceivedAt);
  return sortMessages([
    ...messages,
    {
      id,
      role: "assistant",
      text: "",
      parts,
      turnId,
      uiEvents: [eventWithReceivedAt],
      timestamp: Date.now(),
    },
  ]);
}

export const upsertAssistantUiEventForTest = upsertAssistantUiEvent;

function resolveUiEventTurnId(
  frameTurnId: unknown,
  pendingTurnId: string | null,
  activeTurnId: string | null,
): string | null {
  if (typeof frameTurnId === "string" && frameTurnId.trim()) {
    return frameTurnId;
  }
  return pendingTurnId ?? activeTurnId;
}

export const resolveUiEventTurnIdForTest = resolveUiEventTurnId;

function updateAssistantUiEvents(
  messages: ChatMessage[],
  turnId: string,
  shouldUpdate: (event: unknown) => boolean,
  updateEvent: (event: unknown) => unknown,
): ChatMessage[] {
  let changed = false;
  const nextMessages = messages.map((message) => {
    if (message.role !== "assistant" || message.turnId !== turnId) {
      return message;
    }
    const uiEvents = message.uiEvents?.map((event) => {
      if (!shouldUpdate(event)) return event;
      changed = true;
      return updateEvent(event);
    });
    const parts = message.parts?.map((part) => {
      if (part.type === "text" || !shouldUpdate(part.event)) return part;
      changed = true;
      return { ...part, event: updateEvent(part.event) };
    });
    return { ...message, ...(uiEvents ? { uiEvents } : {}), ...(parts ? { parts } : {}) };
  });
  return changed ? nextMessages : messages;
}

export const updateAssistantUiEventsForTest = updateAssistantUiEvents;

function upsertServerAssistantMessage(
  messages: ChatMessage[],
  payload: unknown,
  turnId?: string,
  scope?: ChatScope | null,
): ChatMessage[] {
  const nextMessage = normalizeMessageForScope(payload, "assistant", scope);
  if (!nextMessage) return messages;
  const normalizedTurnId = nextMessage.turnId ?? (turnId?.trim() || undefined);
  const transientUiEvents = normalizedTurnId
    ? messages
      .filter((message) => message.role === "assistant" && message.turnId === normalizedTurnId)
      .flatMap((message) => message.uiEvents ?? [])
    : [];
  const transientParts = normalizedTurnId
    ? messages
      .filter((message) => message.role === "assistant" && message.turnId === normalizedTurnId)
      .flatMap((message) => message.parts ?? [])
    : [];
  const dedupedUiEvents = removeTransientSkillStudioStatusUiEvents(
    mergeUiEventLists(transientUiEvents, nextMessage.uiEvents),
  );
  const mergedParts = assistantPartsForPersistence(
    mergeAssistantMessageParts(transientParts, nextMessage.parts, nextMessage.text),
    nextMessage.text,
  );
  const mergedMessage = {
    ...nextMessage,
    ...(normalizedTurnId ? { turnId: normalizedTurnId } : {}),
    ...(mergedParts ? { parts: mergedParts } : {}),
    ...(dedupedUiEvents && dedupedUiEvents.length > 0 ? { uiEvents: dedupedUiEvents } : {}),
  };
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

export const upsertServerAssistantMessageForTest = upsertServerAssistantMessage;

function removeSkillStudioStatusForTurn(
  messages: ChatMessage[],
  turnId: string,
): ChatMessage[] {
  if (!turnId.trim()) return messages;
  let changed = false;
  const nextMessages = messages.flatMap((message): ChatMessage[] => {
    if (message.role !== "assistant" || message.turnId !== turnId) return [message];
    const parts = removeSkillStudioStatusParts(message.parts, { keepRealProgress: true });
    const uiEvents = removeTransientSkillStudioStatusUiEvents(message.uiEvents);
    if (parts === message.parts && uiEvents === message.uiEvents) return [message];
    changed = true;
    const nextMessage = {
      ...message,
      ...(parts ? { parts } : { parts: undefined }),
      ...(uiEvents ? { uiEvents } : { uiEvents: undefined }),
    };
    if (!nextMessage.text.trim() && !nextMessage.parts?.length && !nextMessage.uiEvents?.length) {
      return [];
    }
    return [nextMessage];
  });
  return changed ? sortMessages(nextMessages) : messages;
}

export const removeSkillStudioStatusForTurnForTest = removeSkillStudioStatusForTurn;

function removeAllSkillStudioStatusForTurn(
  messages: ChatMessage[],
  turnId: string,
): ChatMessage[] {
  if (!turnId.trim()) return messages;
  let changed = false;
  const nextMessages = messages.flatMap((message): ChatMessage[] => {
    if (message.role !== "assistant" || message.turnId !== turnId) return [message];
    const parts = removeSkillStudioStatusParts(message.parts);
    const uiEvents = message.uiEvents?.filter((event) => !isSkillStudioStatusEvent(event));
    if (parts === message.parts && uiEvents?.length === message.uiEvents?.length) return [message];
    changed = true;
    const nextMessage = {
      ...message,
      ...(parts ? { parts } : { parts: undefined }),
      ...(uiEvents && uiEvents.length > 0 ? { uiEvents } : { uiEvents: undefined }),
    };
    if (!nextMessage.text.trim() && !nextMessage.parts?.length && !nextMessage.uiEvents?.length) {
      return [];
    }
    return [nextMessage];
  });
  return changed ? sortMessages(nextMessages) : messages;
}

type PendingSkillStudioDraftChunks = {
  turnId?: string | null;
  sessionId: string;
  mode?: string;
  summary?: string;
  expectedRecipeCount?: number;
  skill?: Record<string, unknown>;
  recipes: Map<number, Record<string, unknown>>;
};

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function updatePendingSkillStudioDraftChunksFromToolFrame(
  chunksBySession: Map<string, PendingSkillStudioDraftChunks>,
  frame: ServerFrame,
): void {
  if (frame.type !== "agent.tool.updated" || frame.status !== "completed") return;
  const name = typeof frame.name === "string" ? frame.name : "";
  const input = frame.input && typeof frame.input === "object" && !Array.isArray(frame.input)
    ? frame.input as Record<string, unknown>
    : null;
  if (!input) return;
  const sessionId = typeof input.skill_studio_session_id === "string" && input.skill_studio_session_id.trim()
    ? input.skill_studio_session_id
    : "";
  if (!sessionId) return;
  if (name === "freezone_finish_agent_catalog_draft") {
    chunksBySession.delete(sessionId);
    return;
  }
  if (
    name !== "freezone_put_agent_catalog_draft_outline"
    && name !== "freezone_begin_agent_catalog_draft"
    && name !== "freezone_put_agent_catalog_skill"
    && name !== "freezone_put_agent_catalog_recipe"
  ) {
    return;
  }
  const existing = chunksBySession.get(sessionId) ?? {
    sessionId,
    recipes: new Map<number, Record<string, unknown>>(),
  };
  existing.turnId = typeof frame.turn_id === "string" && frame.turn_id.trim() ? frame.turn_id : existing.turnId;
  if (typeof input.mode === "string" && input.mode.trim()) existing.mode = input.mode;
  if (typeof input.summary === "string" && input.summary.trim()) existing.summary = input.summary;
  const expected = numberFromUnknown(input.expected_recipe_count);
  if (expected != null) existing.expectedRecipeCount = expected;
  if (name === "freezone_put_agent_catalog_draft_outline") {
    const outlineExpected = numberFromUnknown(input.expected_recipe_count);
    if (outlineExpected != null) existing.expectedRecipeCount = outlineExpected;
  }
  if (
    name === "freezone_put_agent_catalog_skill"
    && input.skill
    && typeof input.skill === "object"
    && !Array.isArray(input.skill)
  ) {
    existing.skill = input.skill as Record<string, unknown>;
  }
  if (
    name === "freezone_put_agent_catalog_recipe"
    && input.recipe
    && typeof input.recipe === "object"
    && !Array.isArray(input.recipe)
  ) {
    const index = numberFromUnknown(input.index) ?? existing.recipes.size;
    existing.recipes.set(index, input.recipe as Record<string, unknown>);
  }
  chunksBySession.set(sessionId, existing);
}

function hasSkillStudioDraftForTurn(messages: ChatMessage[], turnId: string): boolean {
  return messages.some((message) =>
    message.role === "assistant"
    && message.turnId === turnId
    && (message.uiEvents ?? []).some((event) =>
      Boolean(event && typeof event === "object" && (event as Record<string, unknown>).type === "skill_studio.draft"),
    ),
  );
}

function incompleteSkillStudioDraftEvent(chunks: PendingSkillStudioDraftChunks): Record<string, unknown> {
  const recipes = [...chunks.recipes.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, recipe]) => recipe);
  const expected = Math.max(0, chunks.expectedRecipeCount ?? recipes.length);
  const missingRecipeCount = Math.max(0, expected - recipes.length);
  const warnings = [
    "Agent 已提交了一部分内容，但本轮对话已结束，草稿还不能保存。",
    chunks.skill ? "已生成 Skill 基础配置。" : "缺少 Skill 基础配置。",
    expected > 0
      ? `Recipe 已生成 ${recipes.length} / ${expected}，缺少 ${missingRecipeCount} 个。`
      : recipes.length > 0
        ? `Recipe 已生成 ${recipes.length} 个。`
        : "本轮未提交新 Recipe。",
    "缺少最终草稿整理。",
  ];
  return {
    type: "skill_studio.draft",
    bridge_key: `incomplete:${chunks.sessionId}`,
    skill_studio_session_id: chunks.sessionId,
    mode: chunks.mode ?? "create",
    summary: chunks.summary || "Skill 草稿未完成",
    skill: chunks.skill ?? {},
    recipes,
    warnings,
    incomplete: true,
    read_only: true,
    missing_items: [
      ...(chunks.skill ? [] : ["Skill 基础配置"]),
      ...(missingRecipeCount > 0 ? [`Recipe ${recipes.length + 1} / ${expected}`] : []),
      "最终草稿整理",
    ],
    completed_items: [
      ...(chunks.skill ? ["Skill 基础配置"] : []),
      ...(recipes.length > 0 ? [`Recipe ${recipes.length} / ${expected || recipes.length}`] : []),
    ],
  };
}

function revealIncompleteSkillStudioDraftForTurn(
  messages: ChatMessage[],
  turnId: string,
  chunksBySession: Map<string, PendingSkillStudioDraftChunks>,
): ChatMessage[] {
  if (!turnId.trim() || hasSkillStudioDraftForTurn(messages, turnId)) {
    return removeSkillStudioStatusForTurn(messages, turnId);
  }
  const chunks = [...chunksBySession.values()].find((item) => item.turnId === turnId);
  if (!chunks || (!chunks.skill && chunks.recipes.size === 0)) {
    return removeSkillStudioStatusForTurn(messages, turnId);
  }
  const withDraft = upsertAssistantUiEvent(messages, turnId, incompleteSkillStudioDraftEvent(chunks));
  chunksBySession.delete(chunks.sessionId);
  return removeAllSkillStudioStatusForTurn(withDraft, turnId);
}

export const revealIncompleteSkillStudioDraftForTurnForTest = revealIncompleteSkillStudioDraftForTurn;
export const updatePendingSkillStudioDraftChunksFromToolFrameForTest = updatePendingSkillStudioDraftChunksFromToolFrame;

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
  const body =
    typeof data.text === "string"
      ? data.text
      : "output" in data
        ? resultText(data.output)
        : "result" in data
          ? resultText(data.result)
          : JSON.stringify(payload, null, 2);
  const callId = typeof data.call_id === "string" && data.call_id.trim()
    ? data.call_id.trim()
    : null;
  return {
    id: callId
      ? `agent-tool-${callId}`
      : `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

export function shouldRenderToolStatusPart(payload: ServerFrame): boolean {
  if (!shouldPreserveToolMessage(payload)) return false;
  if (payload.type === "tool.call") {
    return false;
  }
  if ("name" in payload && typeof payload.name === "string" && EXECUTABLE_HIDDEN_TOOL_NAMES.has(payload.name)) {
    return false;
  }
  const text =
    payload.type === "tool.result" && typeof payload.result === "string"
      ? payload.result
      : payload.type === "tool.result" &&
          payload.result &&
          typeof payload.result === "object" &&
          typeof (payload.result as Record<string, unknown>).text === "string"
        ? String((payload.result as Record<string, unknown>).text)
        : "";
  return !(
    text.includes("canvas_chat_commands.v1") ||
    text.includes("canvas_command_emitted")
  );
}

export function shouldRenderAgentToolStatusPart(payload: ServerFrame): boolean {
  if (!("name" in payload) || typeof payload.name !== "string") return true;
  if (EXECUTABLE_HIDDEN_TOOL_NAMES.has(payload.name)) return false;
  if (isInternalHiddenToolStatusName(payload.name)) return false;
  return true;
}

function upsertToolMessage(messages: ChatMessage[], kind: string, payload: unknown): ChatMessage[] {
  const nextMessage = buildToolMessage(kind, payload);
  if (!nextMessage.turnId) return sortMessages([...messages, nextMessage]);

  const existingIndex = messages.findIndex(
    (message) => message.role === "tool" && (
      message.id === nextMessage.id
      || (!nextMessage.id.startsWith("agent-tool-") && message.turnId === nextMessage.turnId)
    ),
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

function toolStatusPartId(kind: string, payload: ServerFrame, turnId: string): string {
  const callId = "call_id" in payload && typeof payload.call_id === "string"
    ? payload.call_id.trim()
    : "";
  if (callId) return `tool_status:${turnId}:${callId}`;
  const name = "name" in payload && typeof payload.name === "string" ? payload.name : kind;
  return `tool_status:${turnId}:${kind}:${name}`;
}

function toolStatusPart(kind: string, payload: ServerFrame, turnId: string): ChatMessagePart {
  return {
    id: toolStatusPartId(kind, payload, turnId),
    type: "tool_status",
    event: buildToolMessage(kind, payload),
  };
}

function agentPlanPart(payload: ServerFrame, turnId: string): ChatMessagePart {
  return {
    id: `agent_plan:${turnId}`,
    type: "agent_plan",
    event: payload,
  };
}

function agentThoughtPart(payload: Record<string, unknown>, turnId: string, partId?: string): ChatMessagePart {
  return {
    id: partId ?? `agent_thought:${turnId}`,
    type: "agent_thought",
    event: payload,
  };
}

function agentUsagePart(payload: ServerFrame, turnId: string): ChatMessagePart {
  return {
    id: `agent_usage:${turnId}`,
    type: "agent_usage",
    event: payload,
  };
}

function upsertRuntimePartInMessages(
  messages: ChatMessage[],
  turnId: string,
  part: ChatMessagePart,
): ChatMessage[] {
  const existingIndex = messages.findIndex(
    (message) => message.role === "assistant" && message.turnId === turnId,
  );
  if (existingIndex >= 0) {
    return sortMessages(messages.map((message, index) =>
      index === existingIndex
        ? {
          ...message,
          parts: assistantPartsWithPart(message.parts, part),
          timestamp: Date.now(),
        }
        : message,
    ));
  }
  return sortMessages([
    ...messages,
    {
      id: `assistant-${turnId}`,
      role: "assistant",
      text: "",
      parts: [part],
      turnId,
      timestamp: Date.now(),
    },
  ]);
}

export const toolStatusPartForTest = toolStatusPart;
export const upsertRuntimePartInMessagesForTest = upsertRuntimePartInMessages;

function approvalOptionId(
  approval: ApprovalRequest,
  decision: ApprovalDecision,
): string {
  const explicitlySelectedId = typeof decision === "object" ? decision.optionId.trim() : "";
  const options = approval.options ?? [];
  const optionIdFor = (option: (typeof options)[number]) => option.optionId ?? option.option_id ?? "";
  if (typeof decision === "object") {
    return options.some((option) => optionIdFor(option) === explicitlySelectedId)
      ? explicitlySelectedId
      : "";
  }
  const preferredIds = decision === "allow-once"
    ? ["allow_once", "allow-once"]
    : decision === "allow-always"
      ? ["allow_always", "allow-always"]
      : decision === "deny"
        ? ["deny", "reject_once", "reject-once", "deny_always", "reject_always", "reject-always"]
        : [];
  const preferredKinds = decision === "allow-once"
    ? ["allow_once", "allow-once"]
    : decision === "allow-always"
      ? ["allow_always", "allow-always", "allow_session", "allow-session"]
      : decision === "deny"
        ? ["reject_once", "reject-once", "deny", "reject_always", "reject-always"]
        : [];
  const selected = options.find((option) => preferredIds.includes(optionIdFor(option)))
    ?? options.find((option) => preferredKinds.includes(String(option.kind ?? "")))
    ?? (decision === "deny"
      ? options.find((option) => /reject|deny/i.test(String(option.kind ?? option.name ?? "")))
      : options.find((option) => /allow/i.test(String(option.kind ?? option.name ?? ""))));
  return selected ? optionIdFor(selected) : "";
}

export const approvalOptionIdForTest = approvalOptionId;

function dispatchCanvasCommandFrame(payload: ServerFrame, anchorTextPrefix?: string | null): void {
  if (typeof window === "undefined" || payload.type !== "canvas.command") return;
  window.dispatchEvent(new CustomEvent(SUPERCHAT_CANVAS_COMMAND_EVENT, {
    detail: {
      frame: payload,
      anchorTextPrefix: anchorTextPrefix ?? null,
      receivedAt: Date.now(),
    },
  }));
}

export const dispatchCanvasCommandFrameForTest = dispatchCanvasCommandFrame;

function canvasContextToolResultFrame(detail: CanvasContextToolResultPayload): ClientFrame | null {
  if (!detail || detail.type !== "canvas.context.result" || !detail.bridge_key) return null;
  const {
    type: _type,
    received_at: _receivedAt,
    anchor_text_prefix: _anchorTextPrefix,
    ...frame
  } = detail;
  return { type: "canvas.context.result", ...frame };
}

export const canvasContextToolResultFrameForTest = canvasContextToolResultFrame;

function shouldCloseThoughtForSkillStudioEvent(event: unknown): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) return true;
  return (event as Record<string, unknown>).type !== "skill_studio.status";
}

const FREEZONE_CANVAS_CONTEXT_TOOL_REQUEST_TYPES: Record<string, string> = {
  freezone_get_canvas_ontology: "canvas_ontology",
  freezone_summarize_canvas: "canvas_summary",
  freezone_get_canvas_action_catalog: "canvas_action_catalog",
  freezone_get_canvas_command_catalog: "canvas_command_catalog",
  freezone_get_link_type_catalog: "link_type_catalog",
  freezone_get_selection: "selection_detail",
  freezone_get_node_detail: "node_detail",
  freezone_get_neighbor_graph: "neighbor_graph",
  freezone_get_node_action_catalog: "node_action_catalog",
  freezone_get_node_create_schema: "node_create_schema",
  freezone_get_audio_voice_options: "audio_voice_options",
  freezone_get_slot_candidates: "slot_candidates",
  freezone_get_mainline_projection_assets: "mainline_projection_assets",
  freezone_validate_canvas_commands: "validate_canvas_commands",
};

function collectToolInputRecords(values: unknown[], output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    output.push(record);
    for (const key of ["input", "raw", "rawInput", "raw_input", "arguments", "args", "payload"]) {
      collectToolInputRecords([record[key]], output);
    }
  }
  return output;
}

function firstStringValue(records: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function firstNumberValue(records: Record<string, unknown>[], keys: string[]): number | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return undefined;
}

function firstValue(records: Record<string, unknown>[], keys: string[]): unknown {
  for (const record of records) {
    for (const key of keys) {
      if (key in record) return record[key];
    }
  }
  return undefined;
}

function firstStringArrayValue(records: Record<string, unknown>[], keys: string[]): string[] | undefined {
  const value = firstValue(records, keys);
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return strings.length > 0 ? strings : undefined;
}

function canvasContextRequestFromToolCall(payload: ServerFrame): {
  envelope: {
    schema_version: "canvas_context_request.v1";
    requests: Array<Record<string, unknown>>;
  };
  canvasId?: string | null;
} | null {
  if (
    payload.type !== "tool.call"
    && payload.type !== "agent.tool.started"
  ) return null;
  if (typeof payload.name !== "string") return null;
  const requestType = FREEZONE_CANVAS_CONTEXT_TOOL_REQUEST_TYPES[payload.name];
  if (!requestType) return null;

  const records = collectToolInputRecords([payload.input, payload.raw]);
  const request: Record<string, unknown> = { type: requestType };
  const canvasId = firstStringValue(records, ["canvas_id", "canvasId"]);

  if (
    requestType === "node_detail" ||
    requestType === "neighbor_graph" ||
    requestType === "node_action_catalog" ||
    requestType === "audio_voice_options"
  ) {
    const nodeId = firstStringValue(records, ["node_id", "nodeId"]);
    if (nodeId) request.node_id = nodeId;
  }
  if (requestType === "neighbor_graph") {
    const depth = firstNumberValue(records, ["depth"]);
    if (depth !== undefined) request.depth = depth;
  }
  if (requestType === "node_create_schema") {
    const nodeType = firstStringValue(records, ["node_type", "nodeType"]);
    if (nodeType) request.node_type = nodeType;
  }
  if (requestType === "slot_candidates") {
    const slotKind = firstStringValue(records, ["slot_kind", "slotKind"]);
    if (slotKind) request.slot_kind = slotKind;
  }
  if (requestType === "mainline_projection_assets") {
    const assetKinds = firstStringArrayValue(records, ["asset_kinds", "assetKinds"]);
    const assetKind = firstStringValue(records, ["asset_kind", "assetKind"]);
    const query = firstStringValue(records, ["query", "q"]);
    const limit = firstNumberValue(records, ["limit"]);
    if (assetKinds) request.asset_kinds = assetKinds;
    else if (assetKind) request.asset_kinds = [assetKind];
    if (query) request.query = query;
    if (limit !== undefined) request.limit = limit;
  }
  if (requestType === "validate_canvas_commands") {
    const payloadValue =
      firstValue(records, ["payload", "body", "envelope"]) ??
      (Array.isArray(firstValue(records, ["commands"]))
        ? { commands: firstValue(records, ["commands"]) }
        : undefined);
    if (payloadValue !== undefined) request.payload = payloadValue;
  }

  return {
    canvasId,
    envelope: {
      schema_version: "canvas_context_request.v1",
      requests: [request],
    },
  };
}

function dispatchCanvasContextRequestFrame(payload: ServerFrame): void {
  if (typeof window === "undefined") return;
  if (payload.type === "canvas.context.request") {
    window.dispatchEvent(new CustomEvent(SUPERCHAT_CANVAS_CONTEXT_REQUEST_EVENT, { detail: payload }));
    return;
  }
  const contextRequest = canvasContextRequestFromToolCall(payload);
  if (!contextRequest) return;
  window.dispatchEvent(new CustomEvent(SUPERCHAT_CANVAS_CONTEXT_REQUEST_EVENT, {
    detail: {
      ...payload,
      canvas_id: contextRequest.canvasId ?? null,
      envelope: contextRequest.envelope,
    },
  }));
}

export function useSuperChat({
  project,
  displayName,
  surface = "director",
  canvasId,
  freezoneCanvasId,
  freezoneAgentId,
  connectionEnabled = true,
}: {
  project?: string;
  displayName: string;
  surface?: ProjectChatSurface;
  canvasId?: string | null;
  freezoneCanvasId?: string | null;
  freezoneAgentId?: string | null;
  connectionEnabled?: boolean;
}) {
  const normalizedFreezoneCanvasId = canvasId ?? freezoneCanvasId ?? null;
  const desiredScope = useMemo(
    () => scopeForProject(project, surface, normalizedFreezoneCanvasId, freezoneAgentId),
    [freezoneAgentId, normalizedFreezoneCanvasId, project, surface],
  );
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
  const activeThoughtPartByTurnRef = useRef<Map<string, string>>(new Map());
  const thoughtTextByPartRef = useRef<Map<string, string>>(new Map());
  const thoughtSegmentCountByTurnRef = useRef<Map<string, number>>(new Map());
  const messagesRef = useRef<ChatMessage[]>(initialScopeSnapshot.cachedMessages);
  const activeTurnIdRef = useRef<string | null>(initialScopeSnapshot.activeTurnId);
  const pendingClientTurnIdRef = useRef<string | null>(null);
  const recentlyCompletedTurnIdRef = useRef<string | null>(null);
  const cancelledTurnIdsRef = useRef<Set<string>>(new Set());
  const runtimePartSeqByIdRef = useRef<Map<string, number>>(new Map());
  const runtimePartSeqCounterRef = useRef(0);
  const pendingSkillStudioDraftChunksRef = useRef<Map<string, PendingSkillStudioDraftChunks>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const closedRef = useRef(false);
  const authRejectedRef = useRef(false);
  const connectionIdRef = useRef(0);
  const desiredScopeRef = useRef(desiredScope);
  const handleFrameRef = useRef<(frame: ServerFrame) => void>(() => {});
  const cacheScopeKeyRef = useRef(scopeKey);
  const skipNextCacheSaveRef = useRef(false);

  const sendFrame = useCallback((frame: ClientFrame) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
      superchatDebug("send", {
        type: frame.type,
        turn_id: "turn_id" in frame ? frame.turn_id : undefined,
      });
      return true;
    }
    superchatDebug("send_skipped_socket_not_open", {
      type: frame.type,
      readyState: ws?.readyState ?? null,
    });
    return false;
  }, []);

  const requestHistory = useCallback(() => {
    sendFrame({ type: "scope.set", scope: desiredScopeRef.current });
  }, [sendFrame]);

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

  useEffect(() => {
    const shouldHandleFreezoneAgentResult = (agentId?: string | null) => {
      const currentScope = desiredScopeRef.current;
      if (currentScope.kind !== "project" || currentScope.surface !== "freezone") return true;
      return (agentId || "main") === (currentScope.agentId || "main");
    };
    const handleCanvasCommandToolResult = (event: Event) => {
      const detail = (event as CustomEvent<CanvasCommandToolResultPayload>).detail;
      if (!detail || detail.type !== "canvas.command.result" || !detail.bridge_key) return;
      if (!shouldHandleFreezoneAgentResult(detail.agent_id)) return;
      const { type: _type, received_at: _receivedAt, anchor_text_prefix: _anchorTextPrefix, ...frame } = detail;
      sendFrame({ type: "canvas.command.result", ...frame });
    };
    const handleCanvasContextToolResult = (event: Event) => {
      const detail = (event as CustomEvent<CanvasContextToolResultPayload>).detail;
      if (!shouldHandleFreezoneAgentResult(detail?.agent_id)) return;
      const frame = canvasContextToolResultFrame(detail);
      if (!frame) return;
      sendFrame(frame);
    };
    window.addEventListener(FREEZONE_CANVAS_COMMAND_TOOL_RESULT_EVENT, handleCanvasCommandToolResult);
    window.addEventListener(FREEZONE_CANVAS_CONTEXT_TOOL_RESULT_EVENT, handleCanvasContextToolResult);
    return () => {
      window.removeEventListener(FREEZONE_CANVAS_COMMAND_TOOL_RESULT_EVENT, handleCanvasCommandToolResult);
      window.removeEventListener(FREEZONE_CANVAS_CONTEXT_TOOL_RESULT_EVENT, handleCanvasContextToolResult);
    };
  }, [sendFrame]);

  const setSettings = useCallback((patch: Partial<SuperChatSettings>) => {
    setSettingsState((current) => {
      const next = { ...current, ...patch };
      safeLocalStorageSet(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const persistAssistantMessageParts = useCallback((
    turnId: string,
    parts: ChatMessagePart[] | undefined,
    text?: string,
  ) => {
    const persistableParts = assistantPartsForPersistence(parts, text);
    if (!persistableParts?.some((part) => part.type !== "text")) return;
    void api.post("api/v1/chat/ui-events", {
      json: {
        scope: desiredScopeRef.current,
        turn_id: turnId,
      event: {
        type: "assistant.message_parts",
        parts: persistableParts,
      },
      },
    }).catch(() => undefined);
  }, []);

  const upsertAssistantMessagePart = useCallback((
    target: { messageId?: string | null; turnId?: string | null },
    part: ChatMessagePart,
  ) => {
    setMessages((current) => {
      const existingIndex = current.findIndex((message) =>
        message.role === "assistant"
        && (
          (target.messageId && message.id === target.messageId)
          || (target.turnId && message.turnId === target.turnId)
        ),
      );
      if (existingIndex >= 0) {
        let persistedTurnId: string | undefined;
        const next = sortMessages(current.map((message, index) => {
          if (index !== existingIndex) return message;
          const parts = assistantPartsWithPart(message.parts, part);
          persistedTurnId = message.turnId;
          return { ...message, parts, text: message.text || "", timestamp: Date.now() };
        }));
        if (persistedTurnId) {
          const persistedMessage = next.find((message) => message.role === "assistant" && message.turnId === persistedTurnId);
          persistAssistantMessageParts(
            persistedTurnId,
            persistedMessage?.parts,
            persistedMessage?.text,
          );
        }
        saveCachedMessages(scopeKey, next);
        return next;
      }
      if (!target.turnId) return current;
      const parts = assistantPartsWithPart(undefined, part);
      persistAssistantMessageParts(target.turnId, parts);
      const next = sortMessages([
        ...current,
        {
          id: target.messageId || `assistant-${target.turnId}`,
          role: "assistant",
          text: "",
          parts,
          turnId: target.turnId,
          timestamp: Date.now(),
        },
      ]);
      saveCachedMessages(scopeKey, next);
      return next;
    });
  }, [persistAssistantMessageParts, scopeKey]);

  const removeAssistantMessagePart = useCallback((
    target: { messageId?: string | null; turnId?: string | null },
    partId: string,
  ) => {
    setMessages((current) => {
      let persistedTurnId: string | undefined;
      const next = current.map((message) => {
        if (
          message.role !== "assistant"
          || !(
            (target.messageId && message.id === target.messageId)
            || (target.turnId && message.turnId === target.turnId)
          )
        ) {
          return message;
        }
        const parts = assistantPartsWithoutPart(message.parts, partId);
        persistedTurnId = message.turnId;
        return { ...message, ...(parts ? { parts } : { parts: undefined }) };
      });
      if (persistedTurnId) {
        const persistedMessage = next.find((message) => message.role === "assistant" && message.turnId === persistedTurnId);
        persistAssistantMessageParts(
          persistedTurnId,
          persistedMessage?.parts,
          persistedMessage?.text,
        );
      }
      saveCachedMessages(scopeKey, next);
      return next;
    });
  }, [persistAssistantMessageParts, scopeKey]);

  const replaceAssistantMessagePart = useCallback((
    target: { messageId?: string | null; turnId?: string | null },
    partId: string,
    replacement: ChatMessagePart,
  ) => {
    setMessages((current) => {
      const existingIndex = current.findIndex((message) =>
        message.role === "assistant"
        && (
          (target.messageId && message.id === target.messageId)
          || (target.turnId && message.turnId === target.turnId)
        ),
      );
      if (existingIndex < 0) {
        if (!target.turnId) return current;
        const parts = assistantPartsWithPart(undefined, replacement);
        persistAssistantMessageParts(target.turnId, parts);
        const next = sortMessages([
          ...current,
          {
            id: target.messageId || `assistant-${target.turnId}`,
            role: "assistant" as const,
            text: "",
            parts,
            turnId: target.turnId,
            timestamp: Date.now(),
          },
        ]);
        saveCachedMessages(scopeKey, next);
        return next;
      }

      let persistedTurnId: string | undefined;
      const next = sortMessages(current.map((message, index) => {
        if (index !== existingIndex) return message;
        const withoutPrevious = assistantPartsWithoutPart(message.parts, partId);
        const parts = assistantPartsWithPart(withoutPrevious, replacement);
        persistedTurnId = message.turnId;
        return { ...message, parts, text: message.text || "", timestamp: Date.now() };
      }));
      if (persistedTurnId) {
        const persistedMessage = next.find(
          (message) => message.role === "assistant" && message.turnId === persistedTurnId,
        );
        persistAssistantMessageParts(
          persistedTurnId,
          persistedMessage?.parts,
          persistedMessage?.text,
        );
      }
      saveCachedMessages(scopeKey, next);
      return next;
    });
  }, [persistAssistantMessageParts, scopeKey]);

  const finalizeStream = useCallback(() => {
    const turnId = activeTurnIdRef.current ?? `turn-${Date.now()}`;
    if (cancelledTurnIdsRef.current.has(turnId)) {
      markTurnInactive(turnId);
      return;
    }
    setMessages((current) => {
      if (!streamTextRef.current.trim()) return current;
      const next = upsertAssistantMessage(current, turnId, streamTextRef.current);
      const persistedMessage = next.find((message) => message.role === "assistant" && message.turnId === turnId);
      persistAssistantMessageParts(
        turnId,
        persistedMessage?.parts,
        persistedMessage?.text,
      );
      return next;
    });
    markTurnInactive(turnId);
    // Post-done history refresh is intentionally disabled; final assistant
    // messages are now pushed through assistant.message.
  }, [markTurnInactive, persistAssistantMessageParts]);

  const handleFrame = useCallback((frame: ServerFrame) => {
    const placeRuntimePart = (turnId: string, part: ChatMessagePart) => {
      const existingSeq = runtimePartSeqByIdRef.current.get(part.id);
      const seq = existingSeq ?? runtimePartSeqCounterRef.current + 1;
      if (existingSeq === undefined) {
        runtimePartSeqCounterRef.current = seq;
        runtimePartSeqByIdRef.current.set(part.id, seq);
      }
      const orderedPart = { ...part, seq };
      if (!frameMatchesCurrentScope(frame, desiredScopeRef.current)) {
        const remoteScopeKey = frameScopeSessionKey(frame);
        if (remoteScopeKey) {
          saveActiveTurn(remoteScopeKey, turnId);
          updateCachedMessagesForScope(remoteScopeKey, (current) =>
            upsertRuntimePartInMessages(current, turnId, orderedPart),
          );
        }
        return;
      }
      markTurnActive(turnId);
      upsertAssistantMessagePart({ turnId }, orderedPart);
    };
    const thoughtTurnKey = (turnId: string) => `${frameScopeSessionKey(frame) ?? scopeKey}:${turnId}`;
    const closeActiveThoughtPart = (turnId: string) => {
      const turnKey = thoughtTurnKey(turnId);
      const partId = activeThoughtPartByTurnRef.current.get(turnKey);
      if (!partId) return;
      const text = thoughtTextByPartRef.current.get(partId) ?? "";
      activeThoughtPartByTurnRef.current.delete(turnKey);
      if (!text.trim()) return;
      placeRuntimePart(
        turnId,
        agentThoughtPart({
          type: "agent.thought.delta",
          scope: frameScope(frame) ?? desiredScopeRef.current,
          turn_id: turnId,
          text,
          status: "completed",
        }, turnId, partId),
      );
    };

    switch (frame.type) {
      case "scope.changed": {
        setConnected(true);
        setConnecting(false);
        setError(null);
        const frameScope = isChatScope(frame.scope) ? frame.scope : undefined;
        if (!scopeMatches(frameScope, desiredScopeRef.current)) break;
        setHistoryReady(true);
        const history = mergeHistory(
          Array.isArray(frame.history) ? frame.history : [],
          frameScope ?? desiredScopeRef.current,
        );
        const currentMessages = messagesRef.current;
        const protectedTurnId = activeTurnIdRef.current ?? recentlyCompletedTurnIdRef.current;
        setMessages((current) => {
          const preserveRemoteBusy = frame.busy === true && currentTurnIsLive(protectedTurnId, current);
          const merged = mergeHistorySnapshot(current, history, protectedTurnId, preserveRemoteBusy);
          saveCachedMessages(scopeKey, merged);
          return merged;
        });
        const activeTurnId = activeTurnIdRef.current;
        if (shouldKeepActiveTurnAfterScopeSync(frame.busy, activeTurnId, currentMessages)) {
          setBusy(true);
        } else if (activeTurnId) {
          // scope.changed is the server-authoritative recovery snapshot. If
          // the server no longer owns a live turn, clear any cached local
          // activeTurn instead of reviving a permanently busy composer.
          markTurnInactive(activeTurnId);
        } else if (!activeTurnIdRef.current) {
          streamTextRef.current = "";
          recentlyCompletedTurnIdRef.current = null;
          setStreamText("");
          setBusy(false);
        }
        break;
      }
      case "chat.busy": {
        if (!frameMatchesCurrentScope(frame, desiredScopeRef.current)) {
          const remoteScopeKey = frameScopeSessionKey(frame);
          if (remoteScopeKey && typeof frame.turn_id === "string" && frame.turn_id.trim()) {
            saveActiveTurn(remoteScopeKey, frame.turn_id);
          }
          break;
        }
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
        if (!frameMatchesCurrentScope(frame, desiredScopeRef.current)) {
          const remoteScopeKey = frameScopeSessionKey(frame);
          if (remoteScopeKey && typeof frame.turn_id === "string" && frame.turn_id.trim()) {
            saveActiveTurn(remoteScopeKey, frame.turn_id);
          }
          break;
        }
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
        if (!frameMatchesCurrentScope(frame, desiredScopeRef.current)) {
          const remoteScopeKey = frameScopeSessionKey(frame);
          const turnId = typeof frame.turn_id === "string" && frame.turn_id.trim() ? frame.turn_id : null;
          if (remoteScopeKey && turnId) saveActiveTurn(remoteScopeKey, turnId);
          break;
        }
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
        if (!frameMatchesCurrentScope(frame, desiredScopeRef.current)) {
          const remoteScopeKey = frameScopeSessionKey(frame);
          const turnId = typeof frame.turn_id === "string" && frame.turn_id.trim() ? frame.turn_id : null;
          const next = typeof frame.text === "string" ? frame.text : "";
          if (remoteScopeKey && turnId && next.trim()) {
            closeActiveThoughtPart(turnId);
            updateCachedMessagesForScope(remoteScopeKey, (current) =>
              upsertAssistantMessage(current, turnId, next),
            );
            saveActiveTurn(remoteScopeKey, turnId);
          }
          break;
        }
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
          closeActiveThoughtPart(turnId);
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
      case "assistant.message": {
        const messageScope = frameScope(frame) ?? desiredScopeRef.current;
        if (!frameMatchesCurrentScope(frame, desiredScopeRef.current)) {
          const remoteScopeKey = frameScopeSessionKey(frame);
          const turnId = typeof frame.turn_id === "string" ? frame.turn_id : undefined;
          if (remoteScopeKey) {
            if (turnId) closeActiveThoughtPart(turnId);
            updateCachedMessagesForScope(remoteScopeKey, (current) =>
              upsertServerAssistantMessage(current, frame.message, turnId, messageScope),
            );
            if (turnId) clearActiveTurn(remoteScopeKey, turnId);
          }
          break;
        }
        const incomingTurnId = typeof frame.turn_id === "string" ? frame.turn_id : undefined;
        if (incomingTurnId) closeActiveThoughtPart(incomingTurnId);
        setMessages((current) => {
          const turnId = incomingTurnId;
          const next = upsertServerAssistantMessage(
            current,
            frame.message,
            turnId,
            messageScope,
          );
          const persistedTurnId =
            turnId
            ?? normalizeMessageForScope(frame.message, "assistant", messageScope)?.turnId;
          if (persistedTurnId && messageScope.surface === "freezone") {
            const persistedMessage = next.find((message) => message.role === "assistant" && message.turnId === persistedTurnId);
            persistAssistantMessageParts(
              persistedTurnId,
              persistedMessage?.parts,
              persistedMessage?.text,
            );
          }
          return next;
        });
        break;
      }
      case "director.auto.status": {
        if (!frameMatchesCurrentScope(frame, desiredScopeRef.current)) break;
        window.dispatchEvent(new CustomEvent("director-auto-status", {
          detail: {
            status: frame.status,
            episode: frame.episode,
            runId: frame.run_id,
            message: frame.message,
            terminalTaskId: frame.terminal_task_id,
            voicePolicy: frame.voice_policy,
          },
        }));
        break;
      }
      case "agent.thought.delta": {
        const turnId = typeof frame.turn_id === "string" && frame.turn_id.trim()
          ? frame.turn_id
          : activeTurnIdRef.current;
        const next = typeof frame.text === "string" ? frame.text : "";
        if (!turnId || !next) break;
        const turnKey = thoughtTurnKey(turnId);
        let partId = activeThoughtPartByTurnRef.current.get(turnKey);
        if (!partId) {
          const segmentIndex = (thoughtSegmentCountByTurnRef.current.get(turnKey) ?? 0) + 1;
          thoughtSegmentCountByTurnRef.current.set(turnKey, segmentIndex);
          partId = `agent_thought:${turnId}:${segmentIndex}`;
          activeThoughtPartByTurnRef.current.set(turnKey, partId);
        }
        const accumulated = `${thoughtTextByPartRef.current.get(partId) ?? ""}${next}`;
        thoughtTextByPartRef.current.set(partId, accumulated);
        placeRuntimePart(
          turnId,
          agentThoughtPart({ ...frame, text: accumulated, status: "running" }, turnId, partId),
        );
        break;
      }
      case "agent.plan.update": {
        const turnId = typeof frame.turn_id === "string" && frame.turn_id.trim()
          ? frame.turn_id
          : activeTurnIdRef.current;
        if (!turnId) break;
        closeActiveThoughtPart(turnId);
        placeRuntimePart(turnId, agentPlanPart(frame, turnId));
        break;
      }
      case "agent.usage.update": {
        const turnId = typeof frame.turn_id === "string" && frame.turn_id.trim()
          ? frame.turn_id
          : activeTurnIdRef.current;
        if (!turnId) break;
        closeActiveThoughtPart(turnId);
        placeRuntimePart(turnId, agentUsagePart(frame, turnId));
        break;
      }
      case "agent.permission.requested": {
        const requestId = typeof frame.request_id === "string" || typeof frame.request_id === "number"
          ? frame.request_id
          : undefined;
        if (requestId === undefined) break;
        const requestScope = frameScope(frame) ?? desiredScopeRef.current;
        const toolCall = recordValue(frame.tool_call) ?? {};
        const rawInput = recordValue(toolCall.rawInput) ?? recordValue(toolCall.input);
        const command = typeof toolCall.rawInput === "string"
          ? toolCall.rawInput
          : typeof toolCall.input === "string"
            ? toolCall.input
            : typeof rawInput?.command === "string"
              ? rawInput.command
              : undefined;
        const description = typeof toolCall.description === "string"
          ? toolCall.description
          : typeof rawInput?.description === "string"
            ? rawInput.description
            : undefined;
        const approvalId = `agent-permission:${scopeSessionKey(requestScope)}:${String(requestId)}`;
        const approval: ApprovalRequest = {
          id: approvalId,
          kind: "agent",
          title: typeof frame.text === "string" && frame.text.trim()
            ? frame.text
            : typeof toolCall.title === "string" && toolCall.title.trim()
              ? toolCall.title
              : "需要操作授权",
          command,
          description,
          requestId,
          turnId: typeof frame.turn_id === "string" ? frame.turn_id : undefined,
          scope: requestScope,
          options: Array.isArray(frame.options) ? frame.options : [],
          expiresAtMs: Date.now() + 60_000,
        };
        setApprovals((current) => [
          ...current.filter((item) => item.id !== approvalId),
          approval,
        ]);
        break;
      }
      case "agent.tool.started":
      case "agent.tool.updated": {
        const turnId = typeof frame.turn_id === "string" && frame.turn_id.trim()
          ? frame.turn_id
          : activeTurnIdRef.current;
        if (!turnId || cancelledTurnIdsRef.current.has(turnId)) break;
        updatePendingSkillStudioDraftChunksFromToolFrame(pendingSkillStudioDraftChunksRef.current, frame);
        if (frame.type === "agent.tool.started") {
          dispatchCanvasContextRequestFrame(frame);
        }
        if (settings.showToolEvents) {
          if (frameMatchesCurrentScope(frame, desiredScopeRef.current)) {
            setMessages((current) => upsertToolMessage(current, frame.type, frame));
          } else {
            const remoteScopeKey = frameScopeSessionKey(frame);
            if (remoteScopeKey) {
              updateCachedMessagesForScope(remoteScopeKey, (current) =>
                upsertToolMessage(current, frame.type, frame),
              );
            }
          }
        }
        if (shouldRenderAgentToolStatusPart(frame)) {
          closeActiveThoughtPart(turnId);
          placeRuntimePart(turnId, toolStatusPart(frame.type, frame, turnId));
        }
        break;
      }
      case "tool.call":
        if (
          typeof frame.turn_id === "string"
          && cancelledTurnIdsRef.current.has(frame.turn_id)
        ) {
          break;
        }
        dispatchCanvasContextRequestFrame(frame);
        if (settings.showToolEvents || shouldPreserveToolMessage(frame)) {
          setMessages((current) => upsertToolMessage(current, frame.type, frame));
        }
        if (shouldRenderToolStatusPart(frame) && typeof frame.turn_id === "string" && frame.turn_id.trim()) {
          closeActiveThoughtPart(frame.turn_id);
          placeRuntimePart(frame.turn_id, toolStatusPart(frame.type, frame, frame.turn_id));
        }
        break;
      case "tool.result":
        if (!frameMatchesCurrentScope(frame, desiredScopeRef.current)) {
          const remoteScopeKey = frameScopeSessionKey(frame);
          if (remoteScopeKey && typeof frame.turn_id === "string" && frame.turn_id.trim()) {
            saveActiveTurn(remoteScopeKey, frame.turn_id);
            if (settings.showToolEvents || shouldPreserveToolMessage(frame)) {
              updateCachedMessagesForScope(remoteScopeKey, (current) =>
                upsertToolMessage(current, frame.type, frame),
              );
            }
          }
          break;
        }
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
        if (shouldRenderToolStatusPart(frame) && typeof frame.turn_id === "string" && frame.turn_id.trim()) {
          closeActiveThoughtPart(frame.turn_id);
          placeRuntimePart(frame.turn_id, toolStatusPart(frame.type, frame, frame.turn_id));
        }
        break;
      case "canvas.command":
        if (typeof frame.turn_id === "string" && frame.turn_id.trim()) {
          closeActiveThoughtPart(frame.turn_id);
        }
        dispatchCanvasCommandFrame(frame, streamTextRef.current.trim() ? streamTextRef.current : null);
        break;
      case "canvas.context.request":
        if (typeof frame.turn_id === "string" && frame.turn_id.trim()) {
          closeActiveThoughtPart(frame.turn_id);
        }
        dispatchCanvasContextRequestFrame(frame);
        break;
      case "skill_studio.event": {
        if (!frameMatchesCurrentScope(frame, desiredScopeRef.current)) break;
        const turnId = resolveUiEventTurnId(
          frame.turn_id,
          pendingClientTurnIdRef.current,
          activeTurnIdRef.current,
        );
        if (!turnId || frame.event == null) break;
        if (shouldCloseThoughtForSkillStudioEvent(frame.event)) {
          closeActiveThoughtPart(turnId);
        }
        markTurnActive(turnId);
        const event = frame.event && typeof frame.event === "object" && !Array.isArray(frame.event)
          ? {
              ...(frame.event as Record<string, unknown>),
              bridge_key: typeof frame.bridge_key === "string" ? frame.bridge_key : undefined,
              project_id: typeof frame.project_id === "string" ? frame.project_id : undefined,
              canvas_id: typeof frame.canvas_id === "string" ? frame.canvas_id : undefined,
              agent_id: typeof frame.agent_id === "string" ? frame.agent_id : undefined,
              anchor_text_prefix: streamTextRef.current.trim() ? streamTextRef.current : undefined,
              turn_id: turnId,
            }
          : frame.event;
        setMessages((current) => {
          const next = upsertAssistantUiEvent(current, turnId, event);
          const persistedMessage = next.find((message) => message.role === "assistant" && message.turnId === turnId);
          persistAssistantMessageParts(
            turnId,
            persistedMessage?.parts,
            persistedMessage?.text,
          );
          return next;
        });
        break;
      }
      case "assistant.clarification.event": {
        if (!frameMatchesCurrentScope(frame, desiredScopeRef.current)) break;
        const turnId = resolveUiEventTurnId(
          frame.turn_id,
          pendingClientTurnIdRef.current,
          activeTurnIdRef.current,
        );
        if (!turnId || frame.event == null) break;
        closeActiveThoughtPart(turnId);
        markTurnActive(turnId);
        const event = frame.event && typeof frame.event === "object" && !Array.isArray(frame.event)
          ? {
              ...(frame.event as Record<string, unknown>),
              bridge_key: typeof frame.bridge_key === "string" ? frame.bridge_key : undefined,
              project_id: typeof frame.project_id === "string" ? frame.project_id : undefined,
              canvas_id: typeof frame.canvas_id === "string" ? frame.canvas_id : undefined,
              agent_id: typeof frame.agent_id === "string" ? frame.agent_id : undefined,
              anchor_text_prefix: streamTextRef.current.trim() ? streamTextRef.current : undefined,
              turn_id: turnId,
            }
          : frame.event;
        setMessages((current) => {
          const next = upsertAssistantUiEvent(current, turnId, event);
          const persistedMessage = next.find((message) => message.role === "assistant" && message.turnId === turnId);
          persistAssistantMessageParts(
            turnId,
            persistedMessage?.parts,
            persistedMessage?.text,
          );
          return next;
        });
        break;
      }
      case "skill_studio.status": {
        if (!frameMatchesCurrentScope(frame, desiredScopeRef.current)) break;
        const turnId = resolveUiEventTurnId(
          frame.turn_id,
          pendingClientTurnIdRef.current,
          activeTurnIdRef.current,
        );
        if (!turnId) break;
        markTurnActive(turnId);
        setMessages((current) =>
          upsertAssistantUiEvent(current, turnId, {
            type: "skill_studio.status",
            status: typeof frame.status === "string" ? frame.status : "routing",
            message: typeof frame.message === "string" ? frame.message : "正在整理 Skill 方向...",
            turn_id: turnId,
          }),
        );
        break;
      }
      case "chat.done": {
        const completedTurnId =
          typeof frame.turn_id === "string" && frame.turn_id.trim() ? frame.turn_id : null;
        if (completedTurnId) {
          setApprovals((current) => current.filter((approval) => approval.turnId !== completedTurnId));
        }
        if (!frameMatchesCurrentScope(frame, desiredScopeRef.current)) {
          const remoteScopeKey = frameScopeSessionKey(frame);
          const turnId = typeof frame.turn_id === "string" ? frame.turn_id : null;
          if (remoteScopeKey) clearActiveTurn(remoteScopeKey, turnId);
          break;
        }
        if (
          typeof frame.turn_id === "string"
          && cancelledTurnIdsRef.current.has(frame.turn_id)
        ) {
          cancelledTurnIdsRef.current.delete(frame.turn_id);
          markTurnInactive(frame.turn_id);
          break;
        }
        if (completedTurnId) {
          const eventScopeKey = frameScopeSessionKey(frame) ?? scopeKey;
          closeActiveThoughtPart(completedTurnId);
          thoughtSegmentCountByTurnRef.current.delete(`${eventScopeKey}:${completedTurnId}`);
          for (const partId of [...thoughtTextByPartRef.current.keys()]) {
            if (partId.startsWith(`agent_thought:${completedTurnId}:`)) {
              thoughtTextByPartRef.current.delete(partId);
            }
          }
        }
        finalizeStream();
        if (frame.message != null) {
          const messageScope = frameScope(frame) ?? desiredScopeRef.current;
          setMessages((current) =>
            upsertServerAssistantMessage(
              current,
              frame.message,
              completedTurnId ?? undefined,
              messageScope,
            ),
          );
        }
        if (completedTurnId) {
          setMessages((current) => {
            const next = revealIncompleteSkillStudioDraftForTurn(
              current,
              completedTurnId,
              pendingSkillStudioDraftChunksRef.current,
            );
            const persistedMessage = next.find((message) =>
              message.role === "assistant" && message.turnId === completedTurnId,
            );
            persistAssistantMessageParts(
              completedTurnId,
              persistedMessage?.parts,
              persistedMessage?.text,
            );
            return next;
          });
        }
        // Reconcile once with server-authoritative history after completion.
        // This closes the small race where the persisted final reply is complete
        // but the last accumulated websocket frame was not rendered locally.
        requestHistory();
        break;
      }
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
  }, [
    finalizeStream,
    markTurnActive,
    markTurnInactive,
    persistAssistantMessageParts,
    requestHistory,
    scopeKey,
    settings.showToolEvents,
    upsertAssistantMessagePart,
  ]);

  useEffect(() => {
    handleFrameRef.current = handleFrame;
  }, [handleFrame]);

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
    superchatDebug("connecting", { url: resolveChatWsUrl() });
    ws.onopen = () => {
      if (connectionIdRef.current !== connectionId || wsRef.current !== ws) return;
      superchatDebug("open");
      sendFrame({ type: "scope.set", scope: desiredScopeRef.current });
    };
    ws.onmessage = (event) => {
      if (connectionIdRef.current !== connectionId || wsRef.current !== ws) return;
      try {
        const frame = JSON.parse(String(event.data)) as ServerFrame;
        superchatDebug("receive", {
          type: typeof frame === "object" && frame !== null && "type" in frame
            ? frame.type
            : "unknown",
          turn_id: typeof frame === "object" && frame !== null && "turn_id" in frame
            ? frame.turn_id
            : undefined,
        });
        handleFrameRef.current(frame);
      } catch {
        superchatDebug("receive_invalid_json");
        // Ignore malformed frames from development proxies.
      }
    };
    ws.onerror = () => {
      if (connectionIdRef.current !== connectionId || wsRef.current !== ws) return;
      superchatDebug("error");
      setError("WebSocket connection failed");
      setConnecting(false);
    };
    ws.onclose = (event) => {
      if (connectionIdRef.current !== connectionId || wsRef.current !== ws) return;
      superchatDebug("close", { code: event.code, reason: event.reason });
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
  }, [sendFrame]);

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
    desiredScopeRef.current = desiredScope;
    if (cacheScopeKeyRef.current !== scopeKey) {
      cacheScopeKeyRef.current = scopeKey;
      skipNextCacheSaveRef.current = true;
    }
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

  useEffect(() => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    setConnecting(true);
    setHistoryReady(false);
    sendFrame({ type: "scope.set", scope: desiredScope });
  }, [desiredScope, sendFrame]);

  // Sweep stale/legacy message caches once on mount so abandoned conversations
  // don't accumulate and eventually exhaust the localStorage quota.
  useEffect(() => {
    pruneOldMessageCaches();
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
    if (cacheScopeKeyRef.current !== scopeKey) return;
    if (skipNextCacheSaveRef.current) {
      skipNextCacheSaveRef.current = false;
      return;
    }
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
    if (!connectionEnabled) {
      disconnect();
      return;
    }
    const connectTimer = window.setTimeout(connect, 50);
    return () => {
      window.clearTimeout(connectTimer);
      disconnect();
    };
  }, [connect, connectionEnabled, disconnect]);

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
      user_text: trimmed,
      turn_id: turnId,
      attachments: attachments.length > 0 ? attachments : undefined,
      surface: surface === "freezone" ? "freezone" : undefined,
      context:
        surface === "freezone" && normalizedFreezoneCanvasId
          ? { freezone_canvas_id: normalizedFreezoneCanvasId }
          : undefined,
    });
    return true;
  }, [connected, desiredScope, displayName, markTurnActive, normalizedFreezoneCanvasId, sendFrame, surface]);

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
      const message = normalizeMessageForScope(response.data, "assistant", desiredScope);
      if (message) {
        setMessages((current) => sortMessages([...current, message]));
      }
      return true;
    } catch (error) {
      console.error("[superchat] append notification failed", error);
      const fallback = normalizeMessageForScope(
        {
          id: `task-notification-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          content: trimmed,
          created_at: new Date().toISOString(),
        },
        "assistant",
        desiredScope,
      );
      if (fallback) {
        setMessages((current) => sortMessages([...current, fallback]));
      }
      return false;
    }
  }, [desiredScope]);

  const submitSkillStudioResult = useCallback((payload: Omit<Extract<ClientFrame, { type: "skill_studio.result" }>, "type">) => {
    console.info("[superchat] send skill_studio.result", {
      turn_id: payload.turn_id,
      bridge_key: payload.bridge_key,
      action: payload.action,
      skill_studio_status: payload.skill_studio_status,
      tool_call_status: payload.tool_call_status,
      ok: payload.ok,
      saved_to_catalog: payload.saved_to_catalog,
      saved_skill_ids: payload.saved_skill_ids,
      saved_recipe_ids: payload.saved_recipe_ids,
      client_debug: payload.client_debug,
    });
    return sendFrame({ type: "skill_studio.result", ...payload });
  }, [sendFrame]);

  const submitAssistantClarificationResult = useCallback((payload: Omit<Extract<ClientFrame, { type: "assistant.clarification.result" }>, "type">) => {
    return sendFrame({ type: "assistant.clarification.result", ...payload });
  }, [sendFrame]);

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

  const resolveApproval = useCallback((approval: ApprovalRequest, decision: ApprovalDecision) => {
    if (approval.kind !== "agent" || approval.requestId === undefined) {
      setApprovals((current) => current.filter((item) => item.id !== approval.id));
      return;
    }
    const optionId = approvalOptionId(approval, decision);
    if (!optionId) {
      setError("Agent 没有提供可用的授权选项");
      return;
    }
    void api.post("api/v1/chat/permission-result", {
      json: {
        scope: approval.scope ?? desiredScopeRef.current,
        request_id: approval.requestId,
        option_id: optionId,
      },
    }).then(() => {
      setApprovals((current) => current.filter((item) => item.id !== approval.id));
    }).catch(() => {
      setError("授权请求已失效，请让虾导重新执行该操作");
    });
  }, []);

  useEffect(() => {
    const nextExpiry = approvals.reduce<number | null>((earliest, approval) => {
      if (!approval.expiresAtMs) return earliest;
      return earliest === null ? approval.expiresAtMs : Math.min(earliest, approval.expiresAtMs);
    }, null);
    if (nextExpiry === null) return;
    const timeout = window.setTimeout(() => {
      const now = Date.now();
      setApprovals((current) => current.filter(
        (approval) => !approval.expiresAtMs || approval.expiresAtMs > now,
      ));
    }, Math.max(0, nextExpiry - Date.now()) + 25);
    return () => window.clearTimeout(timeout);
  }, [approvals]);

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

  const updateUiEvent = useCallback((
    turnId: string,
    shouldUpdate: (event: unknown) => boolean,
    updateEvent: (event: unknown) => unknown,
  ) => {
    setMessages((current) => {
      const next = updateAssistantUiEvents(current, turnId, shouldUpdate, updateEvent);
      if (next !== current) {
        const persistedMessage = next.find((message) => message.role === "assistant" && message.turnId === turnId);
        persistAssistantMessageParts(
          turnId,
          persistedMessage?.parts,
          persistedMessage?.text,
        );
      }
      return next;
    });
  }, [persistAssistantMessageParts]);

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
    approvals: approvals.filter(
      (approval) => !approval.scope || scopeMatches(approval.scope, desiredScope),
    ),
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
    submitAssistantClarificationResult,
    submitSkillStudioResult,
    upsertAssistantMessagePart,
    removeAssistantMessagePart,
    replaceAssistantMessagePart,
    pinnedIds,
    streamText,
    switchModel,
    togglePin,
    updateUiEvent,
  };
}
