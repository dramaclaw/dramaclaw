// SPDX-License-Identifier: Elastic-2.0
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  upsertRemotePlayer,
  usePikoWorldConnection,
  type PikoCharacter,
  type PikoRemotePlayer,
} from "./piko-world-client";

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
  receive(frame: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
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
  expect(JSON.parse(sockets[0].sent[sockets[0].sent.length - 1])).toEqual({ type: "profile.update" });
  expect(hook.result.current.privateChatPeers[0].character_id).toBe("other");
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
