// SPDX-License-Identifier: Elastic-2.0
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createPikoChatGate, usePikoPublicChat } from "./piko-public-chat";
afterEach(() => vi.useRealTimers());
it("rejects bursts per account, accepts the exact cooldown boundary and isolates users", () => {
  const gate = createPikoChatGate();
  expect(gate.send("alice", "你好", 10000).ok).toBe(true);
  expect(gate.send("alice", "重复", 10000)).toEqual({ ok: false, reason: "cooldown" });
  expect(gate.send("bob", "你好", 10001).ok).toBe(true);
  expect(gate.send("alice", "还没到", 12999).ok).toBe(false);
  expect(gate.send("alice", "到时间了", 13000).ok).toBe(true);
});
it("counts unicode characters and does not consume cooldown on invalid input", () => {
  const gate = createPikoChatGate();
  expect(gate.send("a", " \n ", 10000)).toEqual({ ok: false, reason: "empty" });
  expect(gate.send("a", "你".repeat(81), 10000)).toEqual({ ok: false, reason: "length" });
  expect(gate.send("a", "😀".repeat(80), 10000).ok).toBe(true);
});
it("replaces the bubble, expires from the latest send and hides it for other accounts", () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const { result, rerender, unmount } = renderHook(({ owner }) => usePikoPublicChat(owner), { initialProps: { owner: "bubble-test" } });
  act(() => { result.current.send("第一句"); });
  expect(result.current.speech?.body).toBe("第一句");
  expect(result.current.remaining).toBe(3);
  act(() => { result.current.send("刷屏"); });
  expect(result.current.speech?.body).toBe("第一句");
  act(() => vi.advanceTimersByTime(3000));
  act(() => { result.current.send("第二句"); });
  act(() => vi.advanceTimersByTime(2000));
  expect(result.current.speech?.body).toBe("第二句");
  rerender({ owner: "someone-else" });
  expect(result.current.speech).toBeNull();
  rerender({ owner: "bubble-test" });
  act(() => vi.advanceTimersByTime(3000));
  expect(result.current.speech).toBeNull();
  unmount(); expect(vi.getTimerCount()).toBe(0);
});
