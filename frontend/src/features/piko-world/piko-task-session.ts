// SPDX-License-Identifier: Elastic-2.0
import { stageForTaskType } from "@/lib/episode-stage-registry";
import { safeLocalStorageSet } from "@/lib/localStorageQuota";
import type { TaskState } from "@/task-center/types";
import { isPikoTaskActive, isPikoTaskStatus, selectPikoLabelTask, type PikoLabelTask } from "./piko-task-label";

export interface PikoTrackedTask extends PikoLabelTask {
  projectId: string;
  taskKey: string;
  updatedAt: number;
  destination: string;
  canvasId: string | null;
}
export interface PikoTaskSession {
  version: 1;
  startedAt: number;
  preferredId?: string;
  tasks: PikoTrackedTask[];
}
export { isPikoTaskActive } from "./piko-task-label";
const stamp = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
const string = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
export const pikoTaskStorageKey = (owner: string, region: string | null) => `dramaclaw.piko.tasks.v1:${JSON.stringify([region, owner])}`;
export const newPikoTaskSession = (now: number): PikoTaskSession => ({ version: 1, startedAt: now, tasks: [] });

export function pikoTaskDestination(projectId: string, task: Pick<TaskState, "task_type" | "episode" | "metadata">) {
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const canvas = string(task.metadata?.canvas_id);
  if (canvas) return `${base}/freezone?${new URLSearchParams({ canvas })}`;
  const routes: Record<string, string> = {
    build_characters: "characters", character_portrait: "characters", identity_image: "characters", identity_portrait: "characters",
    build_scenes: "scenes", scene_reference_asset: "scenes", stage_asset: "scenes",
    build_props: "props", prop_reference_asset: "props", ingest_fast: "ingest", build_episodes: "episodes",
  };
  if (routes[task.task_type]) return `${base}/${routes[task.task_type]}`;
  const stage = stageForTaskType(task.task_type);
  if (stage && Number.isInteger(task.episode) && task.episode > 0) return `${base}/episodes/${task.episode}${stage.routeSegment}`;
  // Unknown provenance goes to the real project task list, never a guessed canvas.
  return `${base}/tasks`;
}

export function reconcilePikoTasks(session: PikoTaskSession, projectId: string, owner: string, incoming: readonly TaskState[]): PikoTaskSession {
  const old = new Map(session.tasks.map(task => [task.id, task]));
  const next = new Map(old);
  const seenKeys = new Set<string>();
  let newRunAt: number | null = null;
  for (const task of incoming) {
    if (task.username !== owner || !task.task_key || (task.project_id && task.project_id !== projectId)) continue;
    const createdAt = stamp(task.created_at);
    const updatedAt = stamp(task.updated_at);
    if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) continue;
    if (!isPikoTaskStatus(task.status)) continue;
    const id = JSON.stringify([projectId, task.task_key, task.task_id || task.created_at]);
    const previous = old.get(id);
    seenKeys.add(id);
    // Include active tasks on arrival, plus new tasks that finished between polls.
    if (!previous && !isPikoTaskActive(task) && createdAt < session.startedAt) continue;
    if (previous && updatedAt < previous.updatedAt) continue;
    if (!previous && isPikoTaskActive(task)) newRunAt = Math.max(newRunAt ?? 0, createdAt);
    for (const [oldId, item] of next) {
      if (oldId !== id && item.projectId === projectId && item.taskKey === task.task_key && item.createdAt <= createdAt) next.delete(oldId);
    }
    const completedAt = stamp(task.completed_at);
    next.set(id, {
      id, projectId, taskKey: task.task_key, status: task.status, createdAt, updatedAt,
      completedAt: Number.isFinite(completedAt) ? completedAt : null,
      acknowledged: previous?.acknowledged ?? false,
      destination: pikoTaskDestination(projectId, task), canvasId: string(task.metadata?.canvas_id),
    });
  }
  // An authoritative snapshot may remove an expired/deleted task; never invent a failure.
  for (const [id, item] of next) if (item.projectId === projectId && !seenKeys.has(id)) next.delete(id);
  if (newRunAt !== null) for (const [id, item] of next) {
    if (!isPikoTaskActive(item) && old.has(id) && (item.completedAt ?? item.updatedAt) <= newRunAt) next.set(id, { ...item, acknowledged: true });
  }
  return { ...session, tasks: [...next.values()] };
}

export function selectedPikoTask(session: PikoTaskSession): PikoTrackedTask | null {
  const selected = selectPikoLabelTask(session.tasks, session.preferredId);
  return selected ? session.tasks.find(task => task.id === selected.id)! : null;
}

export function readPikoTaskSession(key: string, now: number): PikoTaskSession {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as PikoTaskSession | null;
    if (value?.version !== 1 || !Number.isFinite(value.startedAt) || value.startedAt > now || !Array.isArray(value.tasks)) return newPikoTaskSession(now);
    // Persist only minimal navigation and status, never prompts, logs, result URLs or errors.
    const tasks = value.tasks.filter(task => task && typeof task.id === "string" && typeof task.taskKey === "string"
      && typeof task.projectId === "string" && typeof task.destination === "string"
      && task.destination.startsWith(`/projects/${encodeURIComponent(task.projectId)}/`)
      && !/[\\\r\n]/.test(task.destination)
      && Number.isFinite(task.createdAt) && Number.isFinite(task.updatedAt)
      && (task.completedAt === null || Number.isFinite(task.completedAt))
      && (task.canvasId === null || typeof task.canvasId === "string")
      && typeof task.acknowledged === "boolean"
      && isPikoTaskStatus(task.status));
    return { version: 1, startedAt: value.startedAt, preferredId: typeof value.preferredId === "string" ? value.preferredId : undefined, tasks };
  } catch { return newPikoTaskSession(now); }
}
export function writePikoTaskSession(key: string, session: PikoTaskSession) {
  safeLocalStorageSet(key, JSON.stringify(session));
}
