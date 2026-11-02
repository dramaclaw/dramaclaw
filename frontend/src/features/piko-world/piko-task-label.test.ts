// SPDX-License-Identifier: Elastic-2.0
import { expect, it } from "vitest";
import { holdPikoLabelClock, pikoLabelPhase, publicPikoLabelStatus, selectPikoLabelTask, updatePikoLabelClock, type PikoLabelTask } from "./piko-task-label";

const task = (id: string, status: PikoLabelTask["status"], createdAt: number, acknowledged = false): PikoLabelTask =>
  ({ id, status, createdAt, completedAt: createdAt + 100, acknowledged });

it("prioritizes active tasks, respects the originating task and otherwise selects the latest", () => {
  const tasks = [task("failed", "failed", 30), task("old", "running", 10), task("new", "queued", 20)];
  expect(selectPikoLabelTask(tasks)?.id).toBe("new");
  expect(selectPikoLabelTask(tasks, "old")?.id).toBe("old");
  expect(selectPikoLabelTask(tasks, "failed")?.id).toBe("new");
});

it("prefers unread failures when the round ends and excludes cancelled or acknowledged results", () => {
  expect(selectPikoLabelTask([task("ok", "completed", 50), task("error", "failed", 10)])?.id).toBe("error");
  expect(selectPikoLabelTask([task("ok", "completed", 50), task("error", "failed", 10, true)])?.id).toBe("ok");
  expect(selectPikoLabelTask([task("cancel", "cancelled", 60), task("read", "completed", 50, true)])).toBeNull();
});

it("publishes no failures or private fields and expires completed status after exactly 60 seconds", () => {
  expect(publicPikoLabelStatus("running", null, 1000)).toBe("running");
  expect(publicPikoLabelStatus("failed", 1000, 1001)).toBeNull();
  expect(publicPikoLabelStatus("completed", null, 1001)).toBeNull();
  expect(publicPikoLabelStatus("completed", 1000, 999)).toBeNull();
  expect(publicPikoLabelStatus("completed", 1000, 60999)).toBe("completed");
  expect(publicPikoLabelStatus("completed", 1000, 61000)).toBeNull();
});

it("includes both fades outside the five-second display within each fifteen-second cycle", () => {
  const clock = updatePikoLabelClock(null, "running", 0);
  expect([0, 250, 5249, 5250, 5500, 14999, 15000].map(now => pikoLabelPhase(clock, now)))
    .toEqual(["fade-in", "visible", "visible", "fade-out", "hidden", "hidden", "fade-in"]);
});

it("interrupts waiting for completion but does not reset on identical snapshots", () => {
  const clock = updatePikoLabelClock(null, "running", 0);
  expect(updatePikoLabelClock(clock, "running", 10000)).toBe(clock);
  const done = updatePikoLabelClock(clock, "completed", 10000);
  expect(pikoLabelPhase(done, 10000)).toBe("fade-in");
  expect(pikoLabelPhase(done, 15249)).toBe("visible");
});

it("changes visible text without blinking and restarts a full five seconds", () => {
  const clock = updatePikoLabelClock(null, "running", 0);
  const failed = updatePikoLabelClock(clock, "failed", 4000);
  expect(pikoLabelPhase(failed, 4000)).toBe("visible");
  expect(pikoLabelPhase(failed, 8999)).toBe("visible");
  expect(pikoLabelPhase(failed, 9000)).toBe("fade-out");
});

it("holds a visible phase for interaction and resumes without consuming held time", () => {
  const clock = updatePikoLabelClock(null, "running", 0);
  const held = holdPikoLabelClock(clock, true, 5000);
  expect(pikoLabelPhase(held, 50000)).toBe("visible");
  const resumed = holdPikoLabelClock(held, false, 50000);
  expect(pikoLabelPhase(resumed, 50249)).toBe("visible");
  expect(pikoLabelPhase(resumed, 50250)).toBe("fade-out");
  expect(holdPikoLabelClock(clock, true, 6000)).toBe(clock);
});

it("skips animations for reduced motion and derives the current cycle without replaying past frames", () => {
  const clock = updatePikoLabelClock(null, "running", 0);
  expect(pikoLabelPhase(clock, 0, true)).toBe("visible");
  expect(pikoLabelPhase(clock, 5000, true)).toBe("hidden");
  expect(pikoLabelPhase(clock, 15000, true)).toBe("visible");
  expect(pikoLabelPhase(clock, 150000 + 6000)).toBe("hidden");
});

it("keeps the label fully visible when interaction begins during either fade", () => {
  const clock = updatePikoLabelClock(null, "running", 0);
  for (const now of [100, 5300]) {
    const held = holdPikoLabelClock(clock, true, now);
    expect(pikoLabelPhase(held, now + 30000)).toBe("visible");
  }
});
