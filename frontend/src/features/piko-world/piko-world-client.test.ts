// SPDX-License-Identifier: Elastic-2.0
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  upsertRemotePlayer,
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
