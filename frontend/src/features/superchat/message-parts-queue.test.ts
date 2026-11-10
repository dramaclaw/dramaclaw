import { afterEach, expect, it, vi } from "vitest";
import { createMessagePartsQueue } from "./message-parts-queue";
afterEach(() => vi.useRealTimers());
const body = (text: string) => ({ scope: { kind: "home" }, turn_id: "t", event: { type: "assistant.message_parts", parts: [{ text }] } });
it("coalesces streaming snapshots and flushes the terminal snapshot", async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockResolvedValue(undefined);
  const queue = createMessagePartsQueue(send);
  for (let i = 0; i < 100; i++) queue.enqueue("t", body(String(i)));
  expect(send).not.toHaveBeenCalled();
  await queue.flush();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].event.parts).toEqual([{ text: "99" }]);
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(1);
});
it("serializes in-flight updates and retains their captured scope", async () => {
  let resolve!: () => void;
  const send = vi.fn().mockImplementationOnce(() => new Promise<void>(r => { resolve = r; })).mockResolvedValue(undefined);
  const queue = createMessagePartsQueue(send);
  queue.enqueue("a", body("first"));
  const flushing = queue.flush();
  queue.enqueue("a", body("last"));
  resolve();
  await flushing;
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][0].event.snapshot_revision).toBeGreaterThan(send.mock.calls[0][0].event.snapshot_revision);
  await queue.flush();
});
