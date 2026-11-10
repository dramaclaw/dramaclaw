// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";
import { applyLiveItemFrame, applyLiveItemDeltaFrame } from "@/features/superchat/live-items";
import { normalizeMessage } from "@/features/superchat/message";
import type { ChatMessage, ChatMessagePart } from "@/features/superchat/types";

const target = { turn_id: "turn-1", message_id: "assistant:codex-turn-1" };
const item = (card: ChatMessagePart | null, itemId = card?.id ?? "msg-1") => ({
  type: "chat.item" as const, ...target, item_id: itemId, card,
});
const delta = (itemId: string, kind: "text" | "reasoning", offset: number, text: string) => ({
  type: "chat.item.delta" as const, ...target, item_id: itemId, kind, offset, text,
});
const thought = (text: string, status = "running"): ChatMessagePart => ({
  id: "reason-1", seq: 5, type: "agent_thought",
  event: { type: "agent.thought", turn_id: "turn-1", text, status, truncated: false },
});
const tool = (status: string): ChatMessagePart => ({
  id: "tool-1", seq: 7, type: "tool_status", event: {
    id: "agent-tool-tool-1", role: "tool", text: "read_file", turnId: "turn-1", timestamp: 7,
    raw: { type: "agent.tool.updated", turn_id: "turn-1", call_id: "tool-1", name: "read_file",
      status, input: null, text: "", error: null, result_json: null, duration_ms: null },
  },
});

describe("live item cards", () => {
  it("L1 applies text cards and UTF-16 replacement deltas to one stable message", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValue(200);
    let messages = applyLiveItemFrame([], item({ id: "msg-1", seq: 10, type: "text", text: "" }));
    messages = applyLiveItemDeltaFrame(messages, delta("msg-1", "text", 0, "Hel"));
    expect(messages[0].text).toBe("Hel");
    messages = applyLiveItemDeltaFrame(messages, delta("msg-1", "text", 3, "lo"));
    expect(messages[0].text).toBe("Hello");
    messages = applyLiveItemFrame(messages, item({ id: "msg-1", seq: 10, type: "text", text: "Hello" }));
    expect(messages).toEqual([{
      id: "assistant:codex-turn-1", role: "assistant", turnId: "turn-1", text: "Hello",
      timestamp: 100, parts: [{ id: "msg-1", seq: 10, type: "text", text: "Hello" }],
    }]);
    vi.restoreAllMocks();
  });

  it("L2 adopts a same-turn assistant and preserves its clarification", () => {
    const event = { type: "assistant.clarification.request", bridge_key: "bk-1", questions: [] };
    const clarification: ChatMessagePart = { id: "clarify-1", type: "clarification", event };
    const user: ChatMessage = { id: "user-1", role: "user", text: "Hello", timestamp: 1 };
    const messages = applyLiveItemFrame([user, {
      id: "assistant-turn-1", role: "assistant", turnId: "turn-1", text: "", timestamp: 2,
      uiEvents: [event], parts: [clarification],
    }], item({ id: "msg-1", type: "text", text: "Welcome" }));
    expect(messages).toEqual([user, {
      id: "assistant:codex-turn-1", role: "assistant", turnId: "turn-1", text: "Welcome",
      timestamp: 2, uiEvents: [event],
      parts: [clarification, { id: "msg-1", type: "text", text: "Welcome" }],
    }]);
  });

  it("L3 updates reasoning and replaces tools in first-seen order, then removes null cards", () => {
    let messages = applyLiveItemFrame([], item(thought("Think")));
    messages = applyLiveItemDeltaFrame(messages, delta("reason-1", "reasoning", 5, " carefully"));
    expect(messages[0].parts).toEqual([thought("Think carefully")]);
    messages = applyLiveItemFrame(messages, item(tool("in_progress")));
    messages = applyLiveItemFrame(messages, item({ id: "msg-1", type: "text", text: "Done" }));
    messages = applyLiveItemFrame(messages, item(tool("completed")));
    expect(messages[0].parts).toEqual([
      thought("Think carefully"), tool("completed"), { id: "msg-1", type: "text", text: "Done" },
    ]);
    messages = applyLiveItemFrame(messages, item(null, "tool-1"));
    expect(messages[0].parts).toEqual([
      thought("Think carefully"), { id: "msg-1", type: "text", text: "Done" },
    ]);
  });

  it("L4 ignores missing items and out-of-range or mismatched deltas without allocation", () => {
    const messages = applyLiveItemFrame([], item({ id: "msg-1", type: "text", text: "Hi" }));
    expect(applyLiveItemDeltaFrame(messages, delta("msg-1", "text", 3, "!"))).toBe(messages);
    expect(applyLiveItemDeltaFrame(messages, delta("unknown", "text", 0, "!"))).toBe(messages);
    expect(applyLiveItemDeltaFrame(messages, delta("msg-1", "reasoning", 0, "!"))).toBe(messages);
    expect(applyLiveItemFrame(messages, item(null, "unknown"))).toBe(messages);
  });

  it("L5 renders the same normalized text and parts live and from history", () => {
    const finalCards: ChatMessagePart[] = [thought("Checked", "completed"), tool("completed"),
      { id: "msg-1", seq: 10, type: "text", text: "Hello" },
      { id: "compact-1", seq: 11, type: "context_compaction", event: {
        type: "context_compaction", turn_id: "turn-1", status: "completed",
      } },
      { id: "msg-2", seq: 12, type: "text", text: "World" },
    ];
    let messages: ChatMessage[] = [];
    for (const card of [thought("Check"), tool("in_progress"),
      { id: "msg-1", seq: 10, type: "text", text: "" } satisfies ChatMessagePart,
      { ...finalCards[3], event: { type: "context_compaction", turn_id: "turn-1", status: "running" } },
    ]) messages = applyLiveItemFrame(messages, item(card));
    messages = applyLiveItemDeltaFrame(messages, delta("reason-1", "reasoning", 5, "ed"));
    messages = applyLiveItemDeltaFrame(messages, delta("msg-1", "text", 0, "Hello"));
    for (const card of finalCards) messages = applyLiveItemFrame(messages, item(card));
    const history = normalizeMessage({ id: target.message_id, role: "assistant", content: "Hello\n\nWorld",
      turn_id: "turn-1", parts: finalCards, ui_events: [] });
    expect(messages[0].text).toBe("Hello\n\nWorld");
    expect(messages[0].parts).toEqual(finalCards);
    expect(messages[0].parts).toEqual(history?.parts);
    expect(messages[0].text).toEqual(history?.text);
  });

  it("uses UTF-16 offsets and ignores redelivery without changing the array", () => {
    const messages = applyLiveItemFrame([], item({ id: "msg-1", type: "text", text: "Hi😀!" }));
    const next = applyLiveItemDeltaFrame(messages, delta("msg-1", "text", 4, "?"));
    expect(next[0].text).toBe("Hi😀?");
    expect(applyLiveItemDeltaFrame(next, delta("msg-1", "text", 4, "?"))).toBe(next);
    expect(applyLiveItemFrame(next, item({ id: "msg-1", type: "text", text: "Hi😀?" }))).toBe(next);
  });

  it("normalizes hidden tool cards as removal", () => {
    const hidden = { id: "tool-1", type: "tool_status", event: {
      raw: { name: "freezone_get_node_detail" },
    } } satisfies ChatMessagePart;
    const messages = applyLiveItemFrame([], item(tool("in_progress")));
    expect(applyLiveItemFrame(messages, item(hidden))[0].parts).toEqual([]);
  });
});
