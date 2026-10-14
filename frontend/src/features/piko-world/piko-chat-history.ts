// SPDX-License-Identifier: Elastic-2.0
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PikoWorldChatMessage } from "./piko-world-client";

export const PUBLIC_CHAT_HISTORY_LIMIT = 100;
export const PRIVATE_CHAT_HISTORY_LIMIT = 200;

export type PikoChatEntry = {
  id: string;
  authorKey?: string;
  author?: string;
  bodyKey?: string;
  body?: string;
  time: string;
  mine: boolean;
  unread?: boolean;
};

/** Derive the visible history from the connection's single bounded message buffer. */
export function usePikoChatHistory(
  incoming: PikoWorldChatMessage[],
  ownCharacterId: string | undefined,
  open: boolean,
  welcome: PikoChatEntry[],
) {
  const [readIds, setReadIds] = useState(new Set<string>());
  const formatter = useMemo(() => new Intl.DateTimeFormat(undefined, {
    hour: "2-digit", minute: "2-digit", hour12: false,
  }), []);
  const markRead = useCallback(() => {
    setReadIds(new Set([...welcome.map(message => message.id),
      ...incoming.slice(-PUBLIC_CHAT_HISTORY_LIMIT).map(message => message.id)]));
  }, [incoming, welcome]);
  useEffect(() => { if (open) markRead(); }, [markRead, open]);
  const messages = useMemo<PikoChatEntry[]>(() => [
    ...welcome.map(message => ({ ...message, unread: Boolean(message.unread && !open && !readIds.has(message.id)) })),
    ...incoming.slice(-PUBLIC_CHAT_HISTORY_LIMIT).map(message => {
      const date = new Date(message.sent_at);
      const mine = message.character_id === ownCharacterId;
      return {
        id: message.id, author: message.nickname, body: message.body,
        time: Number.isNaN(date.getTime()) ? "" : formatter.format(date), mine,
        unread: !mine && !open && !readIds.has(message.id),
      };
    }),
  ], [formatter, incoming, open, ownCharacterId, readIds, welcome]);
  return { messages, markRead, unreadCount: messages.filter(message => message.unread).length };
}
