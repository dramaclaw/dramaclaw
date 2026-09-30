// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ChatAttachment, ChatMessage, ChatMessagePart, ChatRole } from "@/features/superchat/types";
import { hasStructuredContent } from "@/features/superchat/spec-extract";

const INTERNAL_CONTEXT_BLOCK_RE =
  /\n?\[((?:DRAMACLAW|SUPERTALE)_[A-Z0-9_]+)\][\s\S]*?\[\/\1\]\n?/g;
const EMPTY_AGENT_REPLY_TEXT = "这轮操作没有收到虾导的有效回复，请稍后重试。";
const EMPTY_AGENT_REPLY_PLACEHOLDERS = new Set([
  "(hermes returned no content)",
  "(agent returned no content)",
]);
const HIDDEN_TOOL_STATUS_NAMES = new Set<string>([
  "freezone_add_next_node",
  "freezone_confirm_workflow_draft",
  "freezone_create_edge",
  "freezone_create_node",
  "freezone_delete_edges",
  "freezone_delete_nodes",
  "freezone_emit_canvas_command",
  "freezone_get_audio_voice_options",
  "freezone_get_canvas_action_catalog",
  "freezone_get_canvas_command_catalog",
  "freezone_get_canvas_ontology",
  "freezone_get_link_type_catalog",
  "freezone_get_mainline_projection_assets",
  "freezone_get_neighbor_graph",
  "freezone_get_node_action_catalog",
  "freezone_get_node_create_schema",
  "freezone_get_node_detail",
  "freezone_get_selection",
  "freezone_get_slot_candidates",
  "freezone_group_nodes",
  "freezone_layout_nodes",
  "freezone_move_nodes",
  "freezone_open_mainline_projection",
  "freezone_run_node_action",
  "freezone_select_nodes",
  "freezone_summarize_canvas",
  "freezone_update_node_data",
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

function isHiddenToolStatusName(name: string): boolean {
  if (HIDDEN_TOOL_STATUS_NAMES.has(name)) return true;
  const normalized = normalizeToolStatusName(name);
  return normalized === "tool search" || normalized === "tool describe";
}

function stripInternalContextBlocks(text: string): string {
  return text.replace(INTERNAL_CONTEXT_BLOCK_RE, "\n").trim();
}

function normalizeDisplayText(text: string): string {
  const trimmed = text.trim();
  return EMPTY_AGENT_REPLY_PLACEHOLDERS.has(trimmed) ? EMPTY_AGENT_REPLY_TEXT : text;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      const value = block as Record<string, unknown>;
      if (typeof value.text === "string") return value.text;
      if (typeof value.content === "string") return value.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function extractMessageText(message: unknown): string {
  if (typeof message === "string") return normalizeDisplayText(stripInternalContextBlocks(message));
  if (!message || typeof message !== "object") return "";
  const value = message as Record<string, unknown>;
  if (typeof value.text === "string") return normalizeDisplayText(stripInternalContextBlocks(value.text));
  if (typeof value.message === "string") return normalizeDisplayText(stripInternalContextBlocks(value.message));
  if (typeof value.content === "string") return normalizeDisplayText(stripInternalContextBlocks(value.content));
  return normalizeDisplayText(stripInternalContextBlocks(textFromContent(value.content)));
}

function normalizeRole(role: unknown): ChatRole {
  if (role === "user") return "user";
  if (role === "system") return "system";
  if (role === "tool" || role === "tool_result" || role === "toolResult" || role === "trace") return "tool";
  return "assistant";
}

function normalizeId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeTimestamp(value: Record<string, unknown>): number {
  if (typeof value.timestamp === "number") return value.timestamp;
  if (typeof value.created_at === "string") {
    const parsed = Date.parse(value.created_at);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof value.createdAt === "string") {
    const parsed = Date.parse(value.createdAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function normalizeTurnId(value: Record<string, unknown>): string | undefined {
  return normalizeId(value.turn_id) ?? normalizeId(value.turnId) ?? undefined;
}

function normalizeUiEvents(value: Record<string, unknown>): unknown[] | undefined {
  const events = Array.isArray(value.ui_events)
    ? value.ui_events
    : Array.isArray(value.uiEvents)
      ? value.uiEvents
      : undefined;
  return events && events.length > 0 ? events : undefined;
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
  const stableId =
    recordString(value, "bridge_key")
    ?? recordString(value, "skill_studio_session_id")
    ?? recordString(value, "clarification_id");
  return stableId ? `${type}:${stableId}` : null;
}

function hydrateMessagePartEvents(
  parts: ChatMessagePart[] | undefined,
  uiEvents: unknown[] | undefined,
): ChatMessagePart[] | undefined {
  if (!parts?.length || !uiEvents?.length) return parts;
  const eventByKey = new Map<string, unknown>();
  for (const event of uiEvents) {
    const key = uiEventMergeKey(event);
    if (key) eventByKey.set(key, event);
  }
  if (eventByKey.size === 0) return parts;
  let changed = false;
  const nextParts = parts.map((part) => {
    if (part.type === "text") return part;
    const key = uiEventMergeKey(part.event);
    const event = key ? eventByKey.get(key) : undefined;
    if (!event) return part;
    changed = true;
    return { ...part, event };
  });
  return changed ? nextParts : parts;
}

function normalizeMessageParts(value: Record<string, unknown>): ChatMessagePart[] | undefined {
  const rawParts = Array.isArray(value.parts)
    ? value.parts
    : Array.isArray(value.message_parts)
      ? value.message_parts
      : undefined;
  if (!rawParts) return undefined;
  const parts = rawParts.flatMap((part, index): ChatMessagePart[] => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const raw = part as Record<string, unknown>;
    const type = raw.type;
    const id = normalizeId(raw.id) ?? `part-${index}`;
    const seq = typeof raw.seq === "number" && Number.isFinite(raw.seq) ? raw.seq : undefined;
    if (type === "tool_status" && isHiddenCanvasWriteToolStatusPart(raw.event)) return [];
    if (type === "text") {
      const text = typeof raw.text === "string" ? raw.text : "";
      return text ? [{ id, type: "text", text, ...(seq == null ? {} : { seq }) }] : [];
    }
    if (
      type === "skill_studio" ||
      type === "clarification" ||
      type === "canvas_approval" ||
      type === "canvas_feedback" ||
      type === "canvas_context" ||
      type === "tool_status" ||
      type === "agent_plan" ||
      type === "agent_thought" ||
      type === "agent_usage"
    ) {
      return [{ id, type, event: raw.event, ...(seq == null ? {} : { seq }) }];
    }
    return [];
  });
  return parts.length > 0 ? parts : undefined;
}

function textCursorAfterOrderedParts(text: string, parts: ChatMessagePart[]): number | null {
  let cursor = 0;
  for (const part of parts) {
    if (part.type !== "text") continue;
    if (!part.text) continue;
    const exactIndex = text.indexOf(part.text, cursor);
    if (exactIndex >= 0) {
      cursor = exactIndex + part.text.length;
      continue;
    }
    const trimmedText = part.text.trim();
    if (!trimmedText) continue;
    const trimmedIndex = text.indexOf(trimmedText, cursor);
    if (trimmedIndex < 0) return null;
    cursor = trimmedIndex + trimmedText.length;
  }
  return cursor;
}

function completeMessagePartsFromText(
  parts: ChatMessagePart[] | undefined,
  text: string,
): ChatMessagePart[] | undefined {
  if (!parts?.some((part) => part.type !== "text")) return parts;
  if (!text) return parts;
  if (!parts.some((part) => part.type === "text")) {
    return [...parts, { id: `text-${parts.length + 1}`, type: "text", text }];
  }
  const cursor = textCursorAfterOrderedParts(text, parts);
  if (cursor == null) {
    const nonTextParts = parts.filter((part) => part.type !== "text");
    return [...nonTextParts, { id: `text-${nonTextParts.length + 1}`, type: "text", text }];
  }
  if (cursor >= text.length) return parts;
  const trailingText = text.slice(cursor);
  if (!trailingText) return parts;
  const nextParts = [...parts];
  const lastPart = nextParts[nextParts.length - 1];
  if (lastPart?.type === "text") {
    nextParts[nextParts.length - 1] = { ...lastPart, text: `${lastPart.text}${trailingText}` };
    return nextParts;
  }
  nextParts.push({ id: `text-${nextParts.length + 1}`, type: "text", text: trailingText });
  return nextParts;
}

function isHiddenCanvasWriteToolStatusPart(event: unknown): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const raw = (event as Record<string, unknown>).raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const name = (raw as Record<string, unknown>).name;
  return typeof name === "string" && isHiddenToolStatusName(name);
}

function mediaKindToType(kind: unknown): string | undefined {
  if (kind === "image" || kind === "video" || kind === "audio" || kind === "file") {
    return kind;
  }
  return undefined;
}

export function normalizeMessage(message: unknown, fallbackRole: ChatRole = "assistant"): ChatMessage | null {
  const text = extractMessageText(message).trim();
  const value = message && typeof message === "object"
    ? (message as Record<string, unknown>)
    : {};
  const uiEvents = normalizeUiEvents(value);
  const parts = completeMessagePartsFromText(hydrateMessagePartEvents(normalizeMessageParts(value), uiEvents), text);
  if (!text && !hasStructuredContent(message) && !uiEvents && !parts) return null;
  const id =
    normalizeId(value.id)
    ?? normalizeId(value.messageId)
    ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = normalizeTimestamp(value);
  const role = "role" in value ? normalizeRole(value.role) : fallbackRole;
  const turnId = normalizeTurnId(value);
  const displayName = typeof value.displayName === "string" ? value.displayName : undefined;
  const attachments = extractAttachments(value);
  return { id, role, text, turnId, displayName, attachments, parts, uiEvents, timestamp, raw: message };
}

function extractAttachments(value: Record<string, unknown>): ChatAttachment[] {
  const contentAttachments = Array.isArray(value.content)
    ? value.content
    .filter((block) => block && typeof block === "object")
    .map((block) => block as Record<string, unknown>)
    .filter((block) => block.type === "image" || block.type === "file" || block.type === "audio" || block.type === "document")
    .map((block) => {
      const source = block.source && typeof block.source === "object"
        ? (block.source as Record<string, unknown>)
        : {};
      const mimeType =
        typeof block.mimeType === "string"
          ? block.mimeType
          : typeof source.media_type === "string"
            ? source.media_type
            : undefined;
      const data = typeof source.data === "string" ? source.data : undefined;
      return {
        id: typeof block.id === "string" ? block.id : undefined,
        type: typeof block.type === "string" ? block.type : undefined,
        mimeType,
        fileName: typeof block.fileName === "string" ? block.fileName : undefined,
        content: data,
      };
    })
    : [];

  const mediaAttachments = Array.isArray(value.media)
    ? value.media
        .filter((item) => item && typeof item === "object")
        .map((item) => item as Record<string, unknown>)
        .map((item): ChatAttachment => {
          const url = typeof item.url === "string" ? item.url : undefined;
          const path = typeof item.path === "string" ? item.path : undefined;
          const label = typeof item.label === "string" ? item.label : undefined;
          const kind = mediaKindToType(item.kind) ?? "file";
          return {
            id: `${kind}:${path || url || label || Math.random().toString(36).slice(2, 8)}`,
            type: kind,
            kind,
            fileName: label || path?.split("/").pop() || url?.split("/").pop(),
            content: url,
            url,
            path,
            label,
          };
        })
    : [];

  return [...contentAttachments, ...mediaAttachments];
}

export function buildLocalUserMessage(
  text: string,
  turnId: string,
  displayName?: string,
  attachments?: ChatAttachment[],
): ChatMessage {
  return {
    id: `user-${turnId}`,
    role: "user",
    text,
    turnId,
    displayName,
    attachments,
    timestamp: Date.now(),
  };
}
