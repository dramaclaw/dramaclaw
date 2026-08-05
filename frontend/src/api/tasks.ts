// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// SuperTale project-scoped task endpoints — read task state, subscribe to SSE.
//
// We use native EventSource because SuperTale auth is cookie-based and
// HttpOnly cookies are sent on the EventSource handshake automatically
// (no header needed). If the cookie is missing/expired, the stream returns
// a 401 immediately and we surface that to the caller.

import { apiCall } from "./client";
import { SESSION_EXPIRED_EVENT } from "@/lib/session-expiry";
import { readUrl } from "@/lib/url-params";

export type TaskStatus =
  | "submitting"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskState {
  task_type: string;
  task_key: string;
  project_id?: string;
  username: string;
  project: string;
  episode: number;
  beat_num?: number | null;
  scope?: string | null;
  status: TaskStatus;
  progress?: number | null;
  current_task?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  logs?: string[];
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown> | null;
}

export class TaskCompletionError extends Error {
  constructor(
    message: string,
    public readonly status: TaskStatus,
    public readonly taskKey: string,
  ) {
    super(message);
    this.name = "TaskCompletionError";
  }
}

/** 用户主动终止的任务不是错误 —— 用于跳过错误弹窗/错误横幅。 */
export function isTaskCancelledError(error: unknown): boolean {
  return error instanceof TaskCompletionError && error.status === "cancelled";
}

/**
 * The third settle state, alongside completed and failed: the front-end
 * *detached*. It does NOT mean the task failed — it means the server stopped
 * confirming the task is alive (record gone, or the task list unreachable) for
 * a whole idle budget, so this page can no longer follow it.
 *
 * A job the server still reports as submitting/queued/running never lands here,
 * no matter how long it takes (see {@link awaitTaskCompletion}). Callers must
 * therefore treat it as "stopped watching": keep the persisted task handle and
 * `isGenerating`, never write a generation error, never clear the handle — the
 * handle is the only way back to a result the backend may still produce.
 */
export class TaskPollTimeoutError extends Error {
  constructor(
    public readonly taskKey: string,
    /** Total time from the await call to the detach. */
    public readonly waitedMs: number,
    /** How long the server said nothing about this task before we detached. */
    public readonly idleMs: number = waitedMs,
    /** Last non-terminal status seen, or null if the task was never observed. */
    public readonly lastStatus: TaskStatus | null = null,
  ) {
    super("task polling detached: no server activity");
    this.name = "TaskPollTimeoutError";
  }
}

export function isTaskPollTimeoutError(error: unknown): error is TaskPollTimeoutError {
  return error instanceof TaskPollTimeoutError;
}

function resolveTaskProjectId(projectId?: string): string {
  const resolved = (projectId ?? readUrl().project ?? "").trim();
  if (!resolved) {
    throw new Error("project_id is required for task monitoring");
  }
  return resolved;
}

export async function listTasks(projectId?: string): Promise<TaskState[]> {
  const resolved = resolveTaskProjectId(projectId);
  return await apiCall<TaskState[]>(
    `projects/${encodeURIComponent(resolved)}/tasks`,
  );
}

export async function getTaskByKey(
  task_type: string,
  projectId: string,
  episode: number = 0,
): Promise<TaskState | null> {
  // SuperTale's per-task GET is keyed by (task_type, project_id, episode);
  // for freezone we keep episode=0 and scope-search via the SSE stream
  // for the specific job_id.
  try {
    return await apiCall<TaskState | null>(
      `projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task_type)}/${episode}`,
    );
  } catch {
    return null;
  }
}

export interface SseHandle {
  close(): void;
}

export interface TaskStreamHandler {
  onTask: (task: TaskState) => void;
  onError?: (err: Event) => void;
  onAuthRevoked?: () => void;
  projectId?: string;
}

/**
 * Open a project SSE stream that fans every `task_updated` event out to the
 * registered handler. Reconnects with exponential backoff on transient errors.
 */
export function openTaskStream(handler: TaskStreamHandler): SseHandle {
  const projectId = resolveTaskProjectId(handler.projectId);
  let es: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: number | null = null;

  const close = () => {
    closed = true;
    if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    es?.close();
    es = null;
  };
  const handleSessionExpired = () => {
    window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    close();
    handler.onAuthRevoked?.();
  };
  window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);

  const connect = () => {
    if (closed) return;
    es = new EventSource(
      `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/stream?snapshot=false`,
      { withCredentials: true },
    );

    es.addEventListener("task_updated", (event) => {
      attempt = 0;
      try {
        const data = JSON.parse((event as MessageEvent).data);
        handler.onTask(data as TaskState);
      } catch (err) {
        console.warn("[freezone] task_updated parse failed", err);
      }
    });
    es.addEventListener("auth_revoked", () => {
      handler.onAuthRevoked?.();
    });
    es.onerror = (err) => {
      handler.onError?.(err);
      es?.close();
      es = null;
      if (closed) return;
      attempt += 1;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
      reconnectTimer = window.setTimeout(connect, delay);
    };
  };

  connect();

  return {
    close() {
      close();
      window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    },
  };
}

// ---------------------------------------------------------------------- //
// In-process job tracker: callers can `await` a freezone job by task_key
// and the underlying SSE stream resolves the promise on completion / failure.

interface PendingResolver {
  resolve: (task: TaskState) => void;
  reject: (err: Error) => void;
  projectId: string;
  startedAt: number;
  /** Idle budget: how long we tolerate hearing *nothing* about this task. */
  budgetMs: number;
  /**
   * Last moment the server confirmed the task exists in a non-terminal state.
   * The deadline hangs off this, not off submit time — a job that spends 10
   * minutes queued and then runs for 28 must not be abandoned at minute 35.
   */
  lastSeenAt: number;
  /** Latest non-terminal status the server reported, for the detach report. */
  lastStatus: TaskStatus | null;
}

interface ProjectPoller {
  timer: number | null;
  inFlight: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 4000;
export const DEFAULT_MAX_POLL_MS = 20 * 60 * 1000;

/**
 * Idle budget for jobs whose backend ceiling is 30 minutes — video generation
 * (`NEWAPI_VIDEO_HTTP_TIMEOUT_SECONDS`, `_run_video_subprocess(timeout=30 * 60)`,
 * the `max_polls=360 * 5s` loop in `generators/video_generator.py`), image
 * generation (`NEWAPI_IMAGE_HTTP_TIMEOUT_SECONDS`), the ffmpeg renders behind
 * compose/erase/upscale (`freezone/jobs.py` `_run_cmd(timeout=1800)`),
 * `stage_asset_tasks` and image-to-3GS.
 *
 * This is how long the task may stay *unheard-of* before we detach, not a cap
 * on how long it may run: the clock restarts on every queued/running sighting.
 * Sized past the backend ceiling so that even a job whose only trace is its
 * start and end records is still being followed when the end record lands.
 */
export const LONG_JOB_MAX_POLL_MS = 35 * 60 * 1000;

/**
 * Task types whose backend ceiling comfortably fits the default budget: audio
 * speech / music (900s, `freezone/audio_node.py`), text translate and video
 * story analysis (300s) and reverse prompt (180s) in `freezone/vision_gateway.py`.
 * Everything else — known heavy types and any type added later — gets
 * {@link LONG_JOB_MAX_POLL_MS}: over-waiting merely delays a safety net, while
 * under-waiting reports a running job as failed.
 */
const SHORT_TASK_TYPES = new Set([
  "freezone_audio_speech",
  "freezone_audio_eleven_music",
  "freezone_text_translate",
  "freezone_analyze_video_story",
  "freezone_image_reverse_prompt",
]);

export function pollTimeoutForTaskType(taskType: string | null | undefined): number {
  if (taskType && SHORT_TASK_TYPES.has(taskType)) {
    return DEFAULT_MAX_POLL_MS;
  }
  return LONG_JOB_MAX_POLL_MS;
}
const pendingByTaskKey = new Map<string, PendingResolver>();
const sharedStreamsByProject = new Map<string, SseHandle>();
const pollersByProject = new Map<string, ProjectPoller>();

function closeAllTaskMonitoring(err?: Error): void {
  for (const [, stream] of sharedStreamsByProject) {
    stream.close();
  }
  sharedStreamsByProject.clear();

  for (const [, poller] of pollersByProject) {
    if (poller.timer != null) {
      window.clearTimeout(poller.timer);
    }
  }
  pollersByProject.clear();

  if (err) {
    for (const [, pending] of pendingByTaskKey) {
      pending.reject(err);
    }
    pendingByTaskKey.clear();
  }
}

function pendingCountForProject(projectId: string): number {
  let count = 0;
  for (const pending of pendingByTaskKey.values()) {
    if (pending.projectId === projectId) count += 1;
  }
  return count;
}

function maybeStopProjectMonitoring(projectId: string): void {
  if (pendingCountForProject(projectId) > 0) return;

  const poller = pollersByProject.get(projectId);
  if (poller) {
    if (poller.timer != null) {
      window.clearTimeout(poller.timer);
    }
    pollersByProject.delete(projectId);
  }

  // No job awaiting this project anymore — tear down the shared SSE stream too,
  // otherwise an idle connection (and its backoff reconnects) keeps hitting
  // /tasks/stream forever. It re-opens lazily on the next awaitTaskCompletion.
  const stream = sharedStreamsByProject.get(projectId);
  if (stream) {
    stream.close();
    sharedStreamsByProject.delete(projectId);
  }
}

function settleTask(task: TaskState): void {
  const pending = pendingByTaskKey.get(task.task_key);
  if (!pending) return;
  if (task.status === "completed") {
    pending.resolve(task);
    pendingByTaskKey.delete(task.task_key);
    maybeStopProjectMonitoring(pending.projectId);
  } else if (task.status === "failed" || task.status === "cancelled") {
    pending.reject(new TaskCompletionError(task.error ?? `task ${task.status}`, task.status, task.task_key));
    pendingByTaskKey.delete(task.task_key);
    maybeStopProjectMonitoring(pending.projectId);
  } else {
    // submitting / queued / running: the server just told us the job is alive,
    // so the idle budget starts over. Queue time must not eat execution time.
    pending.lastSeenAt = Date.now();
    pending.lastStatus = task.status;
  }
}

/**
 * Detach the jobs this project has heard nothing about for a whole idle budget
 * — the record vanished from the task list, or the list itself keeps failing.
 *
 * A task the server still reports as submitting/queued/running is never
 * detached here, however long it takes: that was the bug. A 10-minute queue
 * followed by a 28-minute render is a healthy job, and a wall clock started at
 * submission called it a timeout.
 */
function detachIdlePending(projectId: string): void {
  const now = Date.now();
  for (const [taskKey, pending] of pendingByTaskKey) {
    if (pending.projectId !== projectId) continue;
    if (now - pending.lastSeenAt <= pending.budgetMs) continue;
    pending.reject(
      new TaskPollTimeoutError(
        taskKey,
        now - pending.startedAt,
        now - pending.lastSeenAt,
        pending.lastStatus,
      ),
    );
    pendingByTaskKey.delete(taskKey);
  }
}

function rejectProjectPending(projectId: string, err: Error): void {
  for (const [taskKey, pending] of pendingByTaskKey) {
    if (pending.projectId !== projectId) continue;
    pending.reject(err);
    pendingByTaskKey.delete(taskKey);
  }
  maybeStopProjectMonitoring(projectId);
}

function ensureSharedStream(projectId?: string) {
  const resolved = resolveTaskProjectId(projectId);
  if (sharedStreamsByProject.has(resolved)) return;
  const stream = openTaskStream({
    projectId: resolved,
    onTask: (task) => {
      settleTask(task);
    },
    onAuthRevoked: () => {
      rejectProjectPending(resolved, new Error("auth revoked"));
    },
  });
  sharedStreamsByProject.set(resolved, stream);
}

/**
 * Shared HTTP polling fallback for {@link awaitTaskCompletion}. SSE is the
 * primary channel, but the stream can drop events during reconnect windows,
 * idle disconnects, or proxy hiccups. Keep one poller per project so concurrent
 * jobs share a single `/projects/:project/tasks` request cadence.
 */
function ensureProjectPoller(projectId: string): void {
  if (pollersByProject.has(projectId)) return;

  const poller: ProjectPoller = { timer: null, inFlight: false };
  pollersByProject.set(projectId, poller);

  const schedule = () => {
    if (!pollersByProject.has(projectId)) return;
    poller.timer = window.setTimeout(run, DEFAULT_POLL_INTERVAL_MS);
  };

  const run = async () => {
    poller.timer = null;
    if (pendingCountForProject(projectId) === 0) {
      pollersByProject.delete(projectId);
      return;
    }
    if (poller.inFlight) {
      schedule();
      return;
    }

    poller.inFlight = true;
    try {
      const tasks = await listTasks(projectId);
      const tasksByKey = new Map(tasks.map((task) => [task.task_key, task]));
      for (const [taskKey, pending] of pendingByTaskKey) {
        if (pending.projectId !== projectId) continue;
        const found = tasksByKey.get(taskKey);
        // Terminal → settles; non-terminal → refreshes the idle deadline.
        if (found) settleTask(found);
      }
    } catch {
      // Transient list failure. Don't skip the sweep below: "the task list has
      // been unreachable for a whole budget" is exactly one of the two ways the
      // server goes quiet, and swallowing it here would leave the caller
      // awaiting a promise nothing can ever settle.
    } finally {
      poller.inFlight = false;
    }

    detachIdlePending(projectId);

    if (pendingCountForProject(projectId) === 0) {
      pollersByProject.delete(projectId);
      return;
    }
    schedule();
  };

  schedule();
}

/**
 * Await a freezone job by task key.
 *
 * The budget is an **idle** budget, not a deadline: it only runs while the
 * server says nothing about the task. Every observation of submitting / queued
 * / running (via SSE or the shared poller) restarts it, so a job that queues
 * for 10 minutes and then renders for 28 is followed to the end. Pass the
 * submission's `task_type` to size the budget after that job's backend ceiling
 * ({@link pollTimeoutForTaskType}); `timeoutMs` overrides it outright.
 *
 * Rejects with {@link TaskPollTimeoutError} only when the task goes unheard-of
 * for a whole budget — a detach, not a failure.
 */
export function awaitTaskCompletion(
  taskKey: string,
  projectId: string,
  options?: { timeoutMs?: number; taskType?: string | null },
): Promise<TaskState> {
  const resolved = resolveTaskProjectId(projectId);
  ensureSharedStream(resolved);
  ensureProjectPoller(resolved);
  const startedAt = Date.now();
  const budgetMs =
    options?.timeoutMs ??
    (options && "taskType" in options
      ? pollTimeoutForTaskType(options.taskType)
      : DEFAULT_MAX_POLL_MS);
  const promise = new Promise<TaskState>((resolve, reject) => {
    pendingByTaskKey.set(taskKey, {
      resolve,
      reject,
      projectId: resolved,
      startedAt,
      budgetMs,
      lastSeenAt: startedAt,
      lastStatus: null,
    });
  });
  return promise.finally(() => {
    pendingByTaskKey.delete(taskKey);
    maybeStopProjectMonitoring(resolved);
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    closeAllTaskMonitoring(new Error("task monitor reloaded"));
  });
}
