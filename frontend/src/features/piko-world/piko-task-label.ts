// SPDX-License-Identifier: Elastic-2.0
import type { TaskStatus } from "@/task-center/types";

export const PIKO_TASK_LABEL_CYCLE_MS = 15000;
export const PIKO_TASK_LABEL_FADE_MS = 250;
export const PIKO_TASK_LABEL_VISIBLE_MS = 5000;
const ACTIVE_TASK_STATUSES = new Set<TaskStatus>(["submitting", "queued", "pending", "starting", "running"]);
export const isPikoTaskActive = (task: { status: TaskStatus }) => ACTIVE_TASK_STATUSES.has(task.status);
export const isPikoTaskStatus = (status: TaskStatus) => ACTIVE_TASK_STATUSES.has(status)
  || status === "completed" || status === "failed" || status === "cancelled";

export type PikoTaskLabelStatus = "running" | "completed" | "failed";

/** Adapter input: only authorized tasks in the current round, never all history. */
export interface PikoLabelTask {
  id: string;
  status: TaskStatus;
  createdAt: number;
  completedAt: number | null;
  acknowledged: boolean;
}

export function selectPikoLabelTask(tasks: readonly PikoLabelTask[], preferredId?: string): PikoLabelTask | null {
  const active = tasks.filter(isPikoTaskActive);
  const latest = (items: readonly PikoLabelTask[], terminal = false) => [...items].sort((a, b) =>
    (terminal ? b.completedAt ?? b.createdAt : b.createdAt) - (terminal ? a.completedAt ?? a.createdAt : a.createdAt)
    || a.id.localeCompare(b.id))[0] ?? null;
  if (active.length) return active.find(task => task.id === preferredId) ?? latest(active);
  const unread = tasks.filter(task => !task.acknowledged);
  return latest(unread.filter(task => task.status === "failed"), true)
    ?? latest(unread.filter(task => task.status === "completed"), true);
}

/** Public projection only; this must be derived by the server for real multiplayer. */
export function publicPikoLabelStatus(status: PikoTaskLabelStatus | null, completedAt: number | null, now: number): "running" | "completed" | null {
  if (status === "running") return "running";
  if (status === "completed" && completedAt !== null && Number.isFinite(completedAt)
    && now >= completedAt && now < completedAt + 60_000) return "completed";
  return null;
}

export type PikoLabelPhase = "fade-in" | "visible" | "fade-out" | "hidden";
export interface PikoLabelClock {
  /** Identity of the semantic state, not progress updates or snapshot timestamps. */
  revision: string;
  startedAt: number;
  heldAt: number | null;
}

export function pikoLabelPhase(clock: PikoLabelClock, now: number, reducedMotion = false): PikoLabelPhase {
  const fade = reducedMotion ? 0 : PIKO_TASK_LABEL_FADE_MS;
  const elapsed = Math.max(0, (clock.heldAt ?? now) - clock.startedAt) % PIKO_TASK_LABEL_CYCLE_MS;
  if (elapsed < fade) return "fade-in";
  if (elapsed < fade + PIKO_TASK_LABEL_VISIBLE_MS) return "visible";
  if (elapsed < 2 * fade + PIKO_TASK_LABEL_VISIBLE_MS) return "fade-out";
  return "hidden";
}

export function updatePikoLabelClock(clock: PikoLabelClock | null, revision: string, now: number, reducedMotion = false): PikoLabelClock {
  if (clock?.revision === revision) return clock;
  // A terminal transition interrupts waiting; a visible label changes text without blinking.
  const visible = clock && pikoLabelPhase(clock, now, reducedMotion) !== "hidden";
  return { revision, startedAt: now - (visible && !reducedMotion ? PIKO_TASK_LABEL_FADE_MS : 0), heldAt: clock?.heldAt !== null && clock?.heldAt !== undefined ? now : null };
}

export function holdPikoLabelClock(clock: PikoLabelClock, hold: boolean, now: number, reducedMotion = false): PikoLabelClock {
  if (hold) {
    if (clock.heldAt !== null || pikoLabelPhase(clock, now, reducedMotion) === "hidden") return clock;
    const phase = pikoLabelPhase(clock, now, reducedMotion);
    return { ...clock, startedAt: phase === "visible" ? clock.startedAt : now - (reducedMotion ? 0 : PIKO_TASK_LABEL_FADE_MS), heldAt: now };
  }
  if (clock.heldAt === null) return clock;
  return { ...clock, startedAt: clock.startedAt + Math.max(0, now - clock.heldAt), heldAt: null };
}
