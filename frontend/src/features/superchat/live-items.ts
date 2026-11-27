// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { normalizeMessagePart } from "@/features/superchat/message";
import type { ChatMessage, ChatMessagePart, ServerFrame } from "@/features/superchat/types";

type ItemFrame = Extract<ServerFrame, { type: "chat.item" }>;
type ItemDeltaFrame = Extract<ServerFrame, { type: "chat.item.delta" }>;

function targetMessageIndex(messages: ChatMessage[], frame: ItemFrame | ItemDeltaFrame): number {
  const byId = messages.findIndex(message => message.id === frame.message_id);
  return byId >= 0 ? byId : messages.findIndex(message =>
    message.role === "assistant" && message.turnId === frame.turn_id);
}

function withParts(message: ChatMessage, parts: ChatMessagePart[]): ChatMessage {
  return { ...message, parts, text: parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n\n") };
}

export function applyLiveItemFrame(messages: ChatMessage[], frame: ItemFrame): ChatMessage[] {
  const normalized = normalizeMessagePart(frame.card);
  const part = normalized ? { ...normalized, id: frame.item_id } : null;
  const index = targetMessageIndex(messages, frame);
  if (index < 0) {
    return [...messages, withParts({
      id: frame.message_id, role: "assistant", turnId: frame.turn_id,
      text: "", parts: [], timestamp: Date.now(),
    }, part ? [part] : [])];
  }
  const message = messages[index];
  const parts = message.parts ?? [];
  const partIndex = parts.findIndex(candidate => candidate.id === frame.item_id);
  if (message.id === frame.message_id && (
    (!part && partIndex < 0)
    || (partIndex >= 0 && JSON.stringify(parts[partIndex]) === JSON.stringify(part))
  )) return messages;
  const nextParts = partIndex < 0
    ? part ? [...parts, part] : parts
    : part ? parts.map((previous, i) => i === partIndex ? part : previous)
      : parts.filter((_, i) => i !== partIndex);
  const updated = withParts({ ...message, id: frame.message_id }, nextParts);
  return messages.map((previous, i) => i === index ? updated : previous);
}

export function applyLiveItemDeltaFrame(messages: ChatMessage[], frame: ItemDeltaFrame): ChatMessage[] {
  if (!Number.isInteger(frame.offset) || frame.offset < 0) return messages;
  const index = targetMessageIndex(messages, frame);
  if (index < 0) return messages;
  const message = messages[index];
  const parts = message.parts ?? [];
  const partIndex = parts.findIndex(part => part.id === frame.item_id);
  const part = parts[partIndex];
  let updatedPart: ChatMessagePart;
  if (frame.kind === "text" && part?.type === "text") {
    if (frame.offset > part.text.length) return messages;
    const text = part.text.slice(0, frame.offset) + frame.text;
    if (text === part.text && message.id === frame.message_id) return messages;
    updatedPart = { ...part, text };
  } else if (frame.kind === "reasoning" && part?.type === "agent_thought") {
    const event = part.event;
    if (!event || typeof event !== "object" || !("text" in event) || typeof event.text !== "string") return messages;
    if (frame.offset > event.text.length) return messages;
    const text = event.text.slice(0, frame.offset) + frame.text;
    if (text === event.text && message.id === frame.message_id) return messages;
    updatedPart = { ...part, event: { ...event, text } };
  } else {
    return messages;
  }
  const updated = withParts({ ...message, id: frame.message_id },
    parts.map((previous, i) => i === partIndex ? updatedPart : previous));
  return messages.map((previous, i) => i === index ? updated : previous);
}
