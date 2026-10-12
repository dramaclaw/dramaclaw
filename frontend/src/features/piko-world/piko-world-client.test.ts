// SPDX-License-Identifier: Elastic-2.0
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  upsertRemotePlayer,
  updateRemotePlayerTaskStatus,
  usePikoWorldConnection,
  type PikoCharacter,
  type PikoRemotePlayer,
} from "./piko-world-client";

const OriginalWebSocket = globalThis.WebSocket;

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

it("sends heartbeats and leaves explicitly when the page is hidden", () => {
  vi.useFakeTimers();
  const sockets: TestWebSocket[] = [];
  class TestWebSocket {
    static readonly OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    closeArgs: [number?, string?] | null = null;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;

    constructor(_url: string) {
      sockets.push(this);
    }

    send(value: string) {
      this.sent.push(value);
    }

    close(code?: number, reason?: string) {
      this.closeArgs = [code, reason];
    }

    open() {
      this.readyState = TestWebSocket.OPEN;
      this.onopen?.();
    }
  }
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: TestWebSocket,
  });
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
  act(() => sockets[0].onmessage?.(new MessageEvent("message", {
    data: JSON.stringify({ type: "world.snapshot", players: [remotePlayer()] }),
  })));
  act(() => sockets[0].onmessage?.(new MessageEvent("message", {
    data: JSON.stringify({
      type: "player.task_status",
      character_id: "player-1",
      task_status: "running",
    }),
  })));
  expect(hook.result.current.remotePlayers[0].task_status).toBe("running");
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

function installSockets() {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static readonly OPEN = 1;
    readyState = 0;
    sent: Array<Record<string, unknown>> = [];
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;

    constructor(_url: string) { sockets.push(this); }
    send(value: string) { this.sent.push(JSON.parse(value)); }
    close() { this.closed = true; }
    open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
    receive(frame: Record<string, unknown>) {
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
    }
  }
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true, writable: true, value: FakeSocket,
  });
  return sockets;
}

const localCharacter: PikoCharacter = {
  id: "player-local", nickname: "小花", gender: "female", bio: "",
  scene_id: "welcome-courtyard", position_x: 1270, position_y: 480, facing: "south",
};
const acceptedChat = {
  type: "chat.request.responded", request_id: "request-1", accepted: true,
  peer: { character_id: "player-1", nickname: "小叶" },
};

it("keeps the connection and its private chats when the profile is saved", () => {
  const sockets = installSockets();
  const hook = renderHook(
    ({ character }) => usePikoWorldConnection(character, character.scene_id),
    { initialProps: { character: localCharacter } },
  );
  act(() => sockets[0].open());
  act(() => sockets[0].receive(acceptedChat));
  expect(hook.result.current.privateChatPeers).toHaveLength(1);

  // Saving returns a new object for the same character.
  hook.rerender({ character: { ...localCharacter, nickname: "小花花", bio: "换了名字" } });

  expect(sockets).toHaveLength(1);
  expect(sockets[0].closed).toBe(false);
  expect(sockets[0].sent.some(frame => frame.type === "client.leave")).toBe(false);
  expect(hook.result.current.privateChatPeers).toHaveLength(1);
  act(() => { hook.result.current.refreshProfile(); });
  expect(sockets[0].sent[sockets[0].sent.length - 1]).toEqual({ type: "profile.refresh" });
  hook.unmount();
});

it("applies another player's profile update in place", () => {
  const sockets = installSockets();
  const hook = renderHook(() => usePikoWorldConnection(localCharacter, localCharacter.scene_id));
  act(() => sockets[0].open());
  act(() => sockets[0].receive({ type: "world.snapshot", players: [remotePlayer()] }));

  act(() => sockets[0].receive({
    type: "player.updated", player: remotePlayer({ nickname: "改名的小叶", bio: "新简介" }),
  }));

  expect(hook.result.current.remotePlayers).toHaveLength(1);
  expect(hook.result.current.remotePlayers[0]).toMatchObject({ nickname: "改名的小叶", bio: "新简介" });
  hook.unmount();
});

it("drops the previous character's session state when the character changes", () => {
  const sockets = installSockets();
  const hook = renderHook(
    ({ character }) => usePikoWorldConnection(character, character.scene_id),
    { initialProps: { character: localCharacter } },
  );
  act(() => sockets[0].open());
  act(() => sockets[0].receive(acceptedChat));
  act(() => sockets[0].receive({ type: "world.snapshot", players: [remotePlayer()] }));

  hook.rerender({ character: { ...localCharacter, id: "player-other" } });

  expect(sockets).toHaveLength(2);
  expect(sockets[0].closed).toBe(true);
  expect(hook.result.current.privateChatPeers).toEqual([]);
  expect(hook.result.current.remotePlayers).toEqual([]);
  hook.unmount();
});
