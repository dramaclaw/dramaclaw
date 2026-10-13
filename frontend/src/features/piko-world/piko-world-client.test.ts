// SPDX-License-Identifier: Elastic-2.0
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  upsertRemotePlayer,
  updateRemotePlayerTaskStatus,
  usePikoWorldConnection,
  type PikoCharacter,
  type PikoRemotePlayer,
} from "./piko-world-client";
import type { PlayerAccessorySelection } from "./piko-player-accessories";
import { PRIVATE_CHAT_HISTORY_LIMIT } from "./piko-chat-history";

const OriginalWebSocket = globalThis.WebSocket;
let sockets: TestWebSocket[];
class TestWebSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  readyState = 0;
  sent: string[] = [];
  closeArgs: [number?, string?] | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor(_url: string) { sockets.push(this); }
  send(value: string) { this.sent.push(value); }
  close(code?: number, reason?: string) { this.closeArgs = [code, reason]; this.readyState = 3; }
  open() { this.readyState = TestWebSocket.OPEN; this.onopen?.(); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
  disconnect() { this.readyState = 3; this.onclose?.({ code: 1006 } as CloseEvent); }
}
beforeEach(() => {
  sockets = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: TestWebSocket });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: OriginalWebSocket,
  });
});

const remotePlayer = (overrides: Partial<PikoRemotePlayer> = {}): PikoRemotePlayer => ({
  character_id: "player-1",
  nickname: "小禾",
  gender: "female",
  scene_id: "welcome-courtyard",
  x: 100,
  y: 200,
  facing: "south",
  ...overrides,
});
const localCharacter: PikoCharacter = {
  id: "player-local", nickname: "小花", gender: "female", bio: "",
  scene_id: "welcome-courtyard", position_x: 1270, position_y: 480, facing: "south",
};

it("retains an active speech bubble while applying movement updates", () => {
  const speech = { id: "message-1", body: "大家好", expiresAt: 20_000 };
  const players = [remotePlayer({ speech })];

  const result = upsertRemotePlayer(
    players,
    remotePlayer({ x: 140, y: 230, facing: "east" }),
    15_000,
  );

  expect(result[0]).toMatchObject({ x: 140, y: 230, facing: "east", speech });
});

it("drops an expired speech bubble on the next player update", () => {
  const players = [remotePlayer({
    speech: { id: "message-1", body: "已经过期", expiresAt: 20_000 },
  })];

  const result = upsertRemotePlayer(players, remotePlayer({ x: 140 }), 20_000);

  expect(result[0].speech).toBeUndefined();
});

it("updates only the matching remote player's public task status", () => {
  const players = [
    remotePlayer({ character_id: "player-1" }),
    remotePlayer({ character_id: "player-2", task_status: "running" }),
  ];

  const result = updateRemotePlayerTaskStatus(players, "player-1", "running");

  expect(result[0].task_status).toBe("running");
  expect(result[1]).toBe(players[1]);
});

it("accepts task status in snapshots and consumes live task status events", () => {
  const hook = renderHook(() => usePikoWorldConnection(localCharacter, localCharacter.scene_id));
  act(() => sockets[0].open());
  act(() => sockets[0].receive({
    type: "world.snapshot",
    players: [remotePlayer({ task_status: "running" })],
  }));
  expect(hook.result.current.remotePlayers[0].task_status).toBe("running");

  act(() => sockets[0].receive({
    type: "player.task_status",
    character_id: "player-1",
    task_status: null,
  }));
  expect(hook.result.current.remotePlayers[0].task_status).toBeNull();
  hook.unmount();
});

it("sends heartbeats and leaves explicitly when the page is hidden", () => {
  vi.useFakeTimers();
  const character: PikoCharacter = {
    id: "player-local",
    nickname: "小花",
    gender: "female",
    bio: "",
    scene_id: "welcome-courtyard",
    position_x: 1270,
    position_y: 480,
    facing: "south",
  };

  const hook = renderHook(() => usePikoWorldConnection(character, character.scene_id));
  act(() => sockets[0].open());
  act(() => vi.advanceTimersByTime(15_000));
  act(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));

  expect(sockets[0].sent.map(frame => JSON.parse(frame))).toEqual([
    expect.objectContaining({ type: "scene.join" }),
    { type: "profile.update", accessory_id: null },
    { type: "ping" },
    { type: "client.leave" },
  ]);
  expect(sockets[0].closeArgs).toEqual([1000, "page_exit"]);
  hook.unmount();
});

it("updates profile without reconnecting or losing the private conversation", () => {
  const hook = renderHook(({ character }) => usePikoWorldConnection(character, character.scene_id), {
    initialProps: { character: localCharacter },
  });
  act(() => sockets[0].open());
  act(() => sockets[0].receive({
    type: "chat.request.responded", request_id: "request-1", accepted: true,
    peer: { character_id: "other", nickname: "小叶" },
  }));
  hook.rerender({ character: { ...localCharacter, nickname: "新昵称", bio: "新简介" } });
  expect(sockets).toHaveLength(1);
  expect(sockets[0].closeArgs).toBeNull();
  expect(JSON.parse(sockets[0].sent[sockets[0].sent.length - 1])).toEqual({ type: "profile.update", accessory_id: null });
  expect(hook.result.current.privateChatPeers[0].character_id).toBe("other");
  hook.unmount();
});

it("broadcasts equipment changes and resends the selection after reconnecting", () => {
  vi.useFakeTimers();
  const hook = renderHook(({ accessory }: { accessory: PlayerAccessorySelection }) =>
    usePikoWorldConnection(localCharacter, localCharacter.scene_id, accessory), { initialProps: { accessory: "wizard-hat" } });
  act(() => sockets[0].open());
  expect(JSON.parse(sockets[0].sent[sockets[0].sent.length - 1])).toEqual({ type: "profile.update", accessory_id: "wizard-hat" });
  hook.rerender({ accessory: "red-bow" });
  expect(JSON.parse(sockets[0].sent[sockets[0].sent.length - 1])).toEqual({ type: "profile.update", accessory_id: "red-bow" });
  hook.rerender({ accessory: null });
  expect(JSON.parse(sockets[0].sent[sockets[0].sent.length - 1])).toEqual({ type: "profile.update", accessory_id: null });
  hook.rerender({ accessory: "wizard-hat" });
  expect(sockets).toHaveLength(1);
  act(() => sockets[0].disconnect());
  act(() => vi.advanceTimersByTime(1500));
  act(() => sockets[1].open());
  expect(JSON.parse(sockets[1].sent[sockets[1].sent.length - 1])).toEqual({ type: "profile.update", accessory_id: "wizard-hat" });
  act(() => sockets[1].receive({ type: "player.updated", player: remotePlayer({ accessory_id: "bamboo-hat" }) }));
  expect(hook.result.current.remotePlayers[0].accessory_id).toBe("bamboo-hat");
  hook.unmount();
});

it("waits for a matching receipt and reports a rejected private send", async () => {
  const hook = renderHook(() => usePikoWorldConnection(localCharacter, localCharacter.scene_id));
  act(() => sockets[0].open());
  let first!: Promise<boolean>;
  act(() => { first = hook.result.current.sendPrivateChat("other", "first"); });
  const firstId = JSON.parse(sockets[0].sent[sockets[0].sent.length - 1]).client_message_id;
  act(() => sockets[0].receive({ type: "chat.sent", client_message_id: firstId, message_id: "server-1" }));
  await expect(first).resolves.toBe(true);
  let second!: Promise<boolean>;
  act(() => { second = hook.result.current.sendPrivateChat("other", "second"); });
  const secondId = JSON.parse(sockets[0].sent[sockets[0].sent.length - 1]).client_message_id;
  act(() => sockets[0].receive({ type: "error", code: "private_chat_cooldown", client_message_id: secondId }));
  await expect(second).resolves.toBe(false);
  hook.unmount();
});

it.each([false, true])("opens a composer locally and keeps acceptance when the response arrives before the receipt: %s", async fastResponse => {
  const hook = renderHook(() => usePikoWorldConnection(localCharacter, localCharacter.scene_id));
  act(() => sockets[0].open());
  act(() => sockets[0].receive({ type: "world.snapshot", players: [remotePlayer()] }));
  const before = sockets[0].sent.length;
  act(() => { expect(hook.result.current.openPrivateChat("player-1")).toBe(true); });
  expect(sockets[0].sent).toHaveLength(before);
  expect(hook.result.current.privateChatPeers[0]).toMatchObject({ nickname: "小禾", status: "draft" });
  let first!: Promise<boolean>;
  act(() => { first = hook.result.current.sendPrivateChat("player-1", "hello"); });
  const request = JSON.parse(sockets[0].sent[sockets[0].sent.length - 1]);
  expect(request).toMatchObject({ type: "chat.request", body: "hello", target_character_id: "player-1" });
  const message = { id: "request-1", from_character_id: localCharacter.id,
    to_character_id: "player-1", from_nickname: localCharacter.nickname, body: "hello", sent_at: new Date().toISOString() };
  const accepted = { type: "chat.request.responded", request_id: "request-1", accepted: true,
    peer: { character_id: "player-1", nickname: "小禾" }, message };
  if (fastResponse) act(() => sockets[0].receive(accepted));
  act(() => sockets[0].receive({ type: "chat.request.sent", request_id: "request-1",
    target_character_id: "player-1", client_message_id: request.client_message_id, message }));
  await expect(first).resolves.toBe(true);
  if (!fastResponse) {
    expect(hook.result.current.privateChatPeers[0].status).toBe("pending");
    act(() => sockets[0].receive(accepted));
  }
  expect(hook.result.current.privateChatPeers[0].status).toBe("active");
  expect(hook.result.current.privateChatMessages).toEqual([message]);
  hook.unmount();
});

it.each([false, true])("waits for confirmation when responding to an invitation: %s", async accepted => {
  const hook = renderHook(() => usePikoWorldConnection(localCharacter, localCharacter.scene_id));
  act(() => sockets[0].open());
  act(() => sockets[0].receive({ type: "chat.request", request: {
    id: "incoming", from_character_id: "other", from_nickname: "小叶", sent_at: "2026-10-12T10:00:00Z",
  } }));
  let confirmation!: Promise<boolean>;
  act(() => { confirmation = hook.result.current.respondToChatRequest("incoming", accepted); });
  const frame = JSON.parse(sockets[0].sent[sockets[0].sent.length - 1]);
  expect(frame).toMatchObject({ type: "chat.request.respond", request_id: "incoming", accepted });
  act(() => sockets[0].receive({ type: "chat.request.responded", request_id: "incoming", accepted,
    client_message_id: frame.client_message_id, peer: { character_id: "other", nickname: "小叶" } }));
  await expect(confirmation).resolves.toBe(true);
  expect(hook.result.current.chatRequests).toEqual([]);
  hook.unmount();
});

it.each(["chat_request_failed", "chat_request_unavailable"])("handles %s when responding to an invitation", async code => {
  const hook = renderHook(() => usePikoWorldConnection(localCharacter, localCharacter.scene_id));
  act(() => sockets[0].open());
  act(() => sockets[0].receive({ type: "chat.request", request: {
    id: "incoming", from_character_id: "other", from_nickname: "小叶", sent_at: "2026-10-12T10:00:00Z",
  } }));
  let confirmation!: Promise<boolean>;
  act(() => { confirmation = hook.result.current.respondToChatRequest("incoming", true); });
  const frame = JSON.parse(sockets[0].sent[sockets[0].sent.length - 1]);
  act(() => sockets[0].receive({ type: "error", code, request_id: "incoming", client_message_id: frame.client_message_id }));
  await expect(confirmation).resolves.toBe(false);
  expect(hook.result.current.chatRequests).toHaveLength(code === "chat_request_failed" ? 1 : 0);
  hook.unmount();
});

it.each(["chat.request.sent", "chat.request.message.sent"])("keeps an active conversation when a stale %s arrives", type => {
  const hook = renderHook(() => usePikoWorldConnection(localCharacter, localCharacter.scene_id));
  act(() => sockets[0].open());
  act(() => sockets[0].receive({ type: "chat.request.responded", request_id: "accepted", accepted: true,
    peer: { character_id: "other", nickname: "小叶" } }));
  act(() => sockets[0].receive({ type, request_id: "older-request", target_character_id: "other" }));
  expect(hook.result.current.privateChatPeers[0]).toMatchObject({ status: "active", request_id: "accepted" });
  hook.unmount();
});

it("keeps an accepted conversation when an earlier queued send is rejected", () => {
  const hook = renderHook(() => usePikoWorldConnection(localCharacter, localCharacter.scene_id));
  act(() => sockets[0].open());
  act(() => sockets[0].receive({ type: "chat.request.responded", request_id: "accepted", accepted: true,
    peer: { character_id: "other", nickname: "小叶" } }));
  act(() => sockets[0].receive({ type: "error", code: "chat_request_unavailable", request_id: "accepted" }));
  expect(hook.result.current.privateChatPeers[0]).toMatchObject({ status: "active", request_id: "accepted" });
  hook.unmount();
});

it("queues more messages under one pending request and merges the accepted batch without duplicates", async () => {
  const hook = renderHook(() => usePikoWorldConnection(localCharacter, localCharacter.scene_id));
  act(() => sockets[0].open());
  act(() => sockets[0].receive({ type: "world.snapshot", players: [remotePlayer()] }));
  act(() => hook.result.current.openPrivateChat("player-1"));
  const first = { id: "request-q", from_character_id: localCharacter.id, to_character_id: "player-1",
    from_nickname: localCharacter.nickname, body: "first", sent_at: "2026-10-12T10:00:00Z" };
  act(() => sockets[0].receive({ type: "chat.request.sent", request_id: "request-q", target_character_id: "player-1", message: first }));
  let sending!: Promise<boolean>;
  act(() => { sending = hook.result.current.sendPrivateChat("player-1", "second"); });
  const frame = JSON.parse(sockets[0].sent[sockets[0].sent.length - 1]);
  expect(frame).toMatchObject({ type: "chat.request.message", request_id: "request-q", body: "second" });
  const second = { ...first, id: "second", body: "second", sent_at: "2026-10-12T10:00:01Z" };
  act(() => sockets[0].receive({ type: "chat.request.message.sent", request_id: "request-q", target_character_id: "player-1",
    client_message_id: frame.client_message_id, message: second }));
  await expect(sending).resolves.toBe(true);
  act(() => sockets[0].receive({ type: "chat.request.responded", request_id: "request-q", accepted: true,
    peer: { character_id: "player-1", nickname: "小禾" }, messages: [first, second] }));
  expect(hook.result.current.privateChatMessages).toEqual([first, second]);
  hook.unmount();
});

it("keeps an early refusal when the request receipt arrives later and allows a new request", async () => {
  const hook = renderHook(() => usePikoWorldConnection(localCharacter, localCharacter.scene_id));
  act(() => sockets[0].open());
  act(() => sockets[0].receive({ type: "world.snapshot", players: [remotePlayer()] }));
  act(() => hook.result.current.openPrivateChat("player-1"));
  let sending!: Promise<boolean>;
  act(() => { sending = hook.result.current.sendPrivateChat("player-1", "hello"); });
  const sent = JSON.parse(sockets[0].sent[sockets[0].sent.length - 1]);
  act(() => sockets[0].receive({ type: "chat.request.responded", request_id: "early-refusal", accepted: false,
    peer: { character_id: "player-1", nickname: "小禾" } }));
  act(() => sockets[0].receive({ type: "chat.request.sent", request_id: "early-refusal", target_character_id: "player-1",
    client_message_id: sent.client_message_id }));
  await expect(sending).resolves.toBe(true);
  expect(hook.result.current.privateChatPeers[0].status).toBe("declined");
  act(() => { void hook.result.current.sendPrivateChat("player-1", "try again"); });
  expect(JSON.parse(sockets[0].sent[sockets[0].sent.length - 1])).toMatchObject({ type: "chat.request", body: "try again" });
  hook.unmount();
});

it("keeps a pending queue intact while limiting another conversation's live history", () => {
  const hook = renderHook(() => usePikoWorldConnection(localCharacter, localCharacter.scene_id));
  act(() => sockets[0].open());
  const message = (id: string, peer: string) => ({ id, from_character_id: localCharacter.id,
    to_character_id: peer, from_nickname: localCharacter.nickname, body: id, sent_at: "2026-10-12T10:00:00Z" });
  const queuedCount = PRIVATE_CHAT_HISTORY_LIMIT + 21;
  act(() => {
    for (let index = 0; index < queuedCount; index++) {
      sockets[0].receive({ type: "chat.request.message.sent", request_id: "pending-one", target_character_id: "player-1",
        message: message(`pending-${index}`, "player-1") });
      sockets[0].receive({ type: "chat.private.message", message: message(`live-${index}`, "player-2") });
    }
  });
  expect(hook.result.current.privateChatMessages.filter(item => item.to_character_id === "player-1")).toHaveLength(queuedCount);
  expect(hook.result.current.privateChatMessages.filter(item => item.to_character_id === "player-2")).toHaveLength(PRIVATE_CHAT_HISTORY_LIMIT);
  expect(hook.result.current.privateChatMessages.find(item => item.id === "pending-0")).toBeDefined();
  hook.unmount();
});

it("ignores malformed frames and orders a batch with offset timestamps by send time", () => {
  const hook = renderHook(() => usePikoWorldConnection(localCharacter, localCharacter.scene_id));
  act(() => sockets[0].open());
  const later = { id: "later", from_character_id: "player-1", to_character_id: localCharacter.id,
    from_nickname: "小禾", body: "later", sent_at: "2026-10-12T10:00:01Z" };
  const earlier = { ...later, id: "earlier", body: "earlier", sent_at: "2026-10-12T11:00:00+01:00" };
  act(() => {
    sockets[0].receive(null);
    sockets[0].receive([]);
    sockets[0].receive({ type: "chat.request.responded", request_id: "buffered", accepted: true,
      peer: { character_id: "player-1", nickname: "小禾" },
      messages: [null, 123, { ...later, sent_at: "invalid" }, { ...later, to_character_id: "unrelated" }, later, earlier] });
  });
  expect(hook.result.current.privateChatMessages).toEqual([earlier, later]);
  hook.unmount();
});

it("syncs seated identity in movement updates and clears it on changing maps", () => {
  const hook = renderHook(({ scene }) => usePikoWorldConnection(localCharacter, scene), { initialProps: { scene: "town-hall-interior" } });
  act(() => sockets[0].open());
  act(() => hook.result.current.move(1572, 680, "south", "hall-west-seat"));
  expect(JSON.parse(sockets[0].sent[sockets[0].sent.length - 1])).toMatchObject({ type: "player.move", seat_id: "hall-west-seat" });
  act(() => sockets[0].receive({ type: "player.moved", player: remotePlayer({ seat_id: "hall-east-seat" }) }));
  expect(hook.result.current.remotePlayers[0].seat_id).toBe("hall-east-seat");
  hook.rerender({ scene: "welcome-courtyard" });
  expect(JSON.parse(sockets[0].sent[sockets[0].sent.length - 1])).toMatchObject({ type: "scene.join", seat_id: null });
  hook.unmount();
});

it("settles unconfirmed sends on timeout, disconnect and unmount", async () => {
  vi.useFakeTimers();
  const hook = renderHook(() => usePikoWorldConnection(localCharacter, localCharacter.scene_id));
  act(() => sockets[0].open());
  let timeout!: Promise<boolean>;
  act(() => { timeout = hook.result.current.chat("timeout"); });
  act(() => vi.advanceTimersByTime(8_000));
  await expect(timeout).resolves.toBe(false);
  let disconnected!: Promise<boolean>;
  act(() => { disconnected = hook.result.current.chat("disconnect"); });
  act(() => sockets[0].disconnect());
  await expect(disconnected).resolves.toBe(false);
  hook.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
