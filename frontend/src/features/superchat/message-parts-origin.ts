import type { ChatMessage, ChatScope } from "./types";

// Symbols survive an in-memory history merge but never JSON cache serialization.
// A replay can retain an existing write intent; it cannot create a new one.
const LOCAL_SNAPSHOT = Symbol("local-message-snapshot");
export type LocalSnapshot = {
  scope: ChatScope;
  scopeKey: string;
  turnId: string;
  parts: ChatMessage["parts"];
  text: string;
};
type MarkedMessage = ChatMessage & { [LOCAL_SNAPSHOT]?: LocalSnapshot };

export function localSnapshot(message: ChatMessage): LocalSnapshot | undefined {
  return (message as MarkedMessage)[LOCAL_SNAPSHOT];
}

export function markLocalMessageChanges(
  previous: ChatMessage[], next: ChatMessage[], scope: ChatScope, scopeKey: string,
): ChatMessage[] {
  if (previous === next) return next;
  const before = new Map(previous.map(message => [message.id, message]));
  return next.map(message => {
    const old = before.get(message.id);
    if (message.role !== "assistant" || !message.turnId
      || (old?.parts === message.parts && old?.text === message.text)) return message;
    return { ...message, [LOCAL_SNAPSHOT]: {
      scope, scopeKey, turnId: message.turnId, parts: message.parts, text: message.text,
    } };
  });
}
