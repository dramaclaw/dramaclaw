import { afterEach, expect, it, vi } from "vitest";
import { createMessagePartsQueue, SnapshotRejectedError } from "./message-parts-queue";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
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
const texts = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map(([b]) => (b.event.parts[0] as { text: string }).text);
it("delivers a newer snapshot enqueued while an older one exhausts its retries", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const send = vi.fn(async (b: { event: { parts: unknown[] } }) => {
    if ((b.event.parts[0] as { text: string }).text === "running") throw new Error("HTTP 503");
  });
  const queue = createMessagePartsQueue(send);
  queue.enqueue("t", body("running"));
  const first = queue.flush();
  await vi.advanceTimersByTimeAsync(0);
  queue.enqueue("t", body("done"));
  const second = queue.flush();
  await vi.runAllTimersAsync();
  await Promise.all([first, second]);
  expect(texts(send)).toEqual(["running", "running", "running", "done"]);
  // The superseded snapshot must not be retained to overwrite the terminal state later.
  await queue.flush();
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(4);
});
it("does not strand other turns behind a failing snapshot", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const send = vi.fn(async (b: { turn_id: string }) => {
    if (b.turn_id === "bad") throw new Error("HTTP 503");
  });
  const queue = createMessagePartsQueue(send);
  queue.enqueue("bad", { ...body("x"), turn_id: "bad" });
  queue.enqueue("ok", { ...body("y"), turn_id: "ok" });
  const flushing = queue.flush();
  await vi.runAllTimersAsync();
  await flushing;
  expect(send.mock.calls.map(([b]) => b.turn_id)).toEqual(["bad", "bad", "bad", "ok"]);
});
it("keeps a failed snapshot for the next flush when nothing newer arrived", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const send = vi.fn().mockRejectedValueOnce(new Error("a")).mockRejectedValueOnce(new Error("b"))
    .mockRejectedValueOnce(new Error("c")).mockResolvedValue(undefined);
  const queue = createMessagePartsQueue(send);
  queue.enqueue("t", body("done"));
  const flushing = queue.flush();
  await vi.runAllTimersAsync();
  await flushing;
  expect(send).toHaveBeenCalledTimes(3);
  await queue.flush();
  expect(texts(send)).toEqual(["done", "done", "done", "done"]);
});
it("stops retrying a turn the server rejected permanently and ignores later snapshots for it", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const send = vi.fn(async (b: { turn_id: string }) => {
    if (b.turn_id === "big") throw new SnapshotRejectedError("HTTP 413");
  });
  const queue = createMessagePartsQueue(send);
  queue.enqueue("big", { ...body("running"), turn_id: "big" });
  queue.enqueue("ok", body("other"));
  await queue.flush();
  expect(send.mock.calls.map(([b]) => b.turn_id)).toEqual(["big", "t"]);
  queue.enqueue("big", { ...body("done"), turn_id: "big" });
  await queue.flush();
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(2);
});
