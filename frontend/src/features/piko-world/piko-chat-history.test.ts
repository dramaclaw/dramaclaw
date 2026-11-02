// SPDX-License-Identifier: Elastic-2.0
import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { usePikoChatHistory } from "./piko-chat-history";
import type { PikoWorldChatMessage } from "./piko-world-client";

const welcome = [{ id: "welcome", author: "guide", body: "welcome", time: "", mine: false, unread: true }];
const message = (number: number, author = "other"): PikoWorldChatMessage => ({
  id: `message-${number}`, character_id: author, nickname: author, body: `text-${number}`,
  sent_at: "2026-10-12T01:00:00Z",
});

it("bounds the visible history while retaining read state across incoming messages", () => {
  const incoming = Array.from({ length: 250 }, (_, index) => message(index));
  const hook = renderHook(({ messages, open }) => usePikoChatHistory(messages, "me", open, welcome), {
    initialProps: { messages: incoming, open: false },
  });
  expect(hook.result.current.messages).toHaveLength(101);
  expect(hook.result.current.messages[1].id).toBe("message-150");
  expect(hook.result.current.unreadCount).toBe(101);
  hook.rerender({ messages: incoming, open: true });
  expect(hook.result.current.unreadCount).toBe(0);
  hook.rerender({ messages: [...incoming, message(250)], open: false });
  expect(hook.result.current.unreadCount).toBe(1);
  hook.rerender({ messages: [...incoming, message(250), message(251, "me")], open: false });
  expect(hook.result.current.unreadCount).toBe(1);
  expect(hook.result.current.messages).toHaveLength(101);
});

it("marks live messages read while the panel is open", () => {
  const hook = renderHook(({ messages, open }) => usePikoChatHistory(messages, "me", open, welcome), {
    initialProps: { messages: [message(1)], open: true },
  });
  hook.rerender({ messages: [message(1), message(2)], open: true });
  hook.rerender({ messages: [message(1), message(2)], open: false });
  expect(hook.result.current.unreadCount).toBe(0);
});
