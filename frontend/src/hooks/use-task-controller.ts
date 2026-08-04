// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";

import {
  claimOwnership,
  isActiveStatus,
  releaseOwnership,
  serializeKey,
  useEntrySnapshot,
  useInstanceId,
  useTaskRegistry,
  type TaskKey,
  type TaskStreamState,
} from "@/components/episode/task-controller-provider";
import { useTaskStream } from "@/hooks/use-task-stream";
import { useCancelTask, useTasks } from "@/lib/queries/tasks";
import { mergeTaskLogs } from "@/lib/script-feedback";

/**
 * Public handle returned by `useTaskController`. Mirrors `useStageTask`'s
 * surface plus the `logs` rolling buffer so migration is mechanical.
 */
export interface TaskControllerHandle {
  started: boolean;
  stream: TaskStreamState;
  logs: string[];
  /**
   * Mark the task as started and open the SSE stream. Pass `{ scope, taskId }`
   * from the backend TaskResponse so the first stream request hits the right
   * row and terminal reconciliation ignores stale rows from older runs.
   */
  start: (override?: { scope?: string; taskId?: string }) => void;
  stop: () => Promise<void>;
  stopping: boolean;
}

export interface UseTaskControllerOptions {
  key: TaskKey;
  /** Extra task types to auto-resume on mount (see `useStageTask`). */
  alsoReconcile?: string[];
  invalidateKeys?: QueryKey[];
  onComplete?: (result: unknown) => void;
  onError?: (error: string) => void;
  showCompleteToast?: boolean;
}

const LOG_CAP = 200;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Scoped task controller hook.
 *
 * Consumers call this with a `TaskKey`. The first caller per key claims
 * ownership, opening exactly one SSE stream for the task. Subsequent callers
 * with the same key share the owner's state via the registry's external store
 * (see `task-controller-provider.tsx`).
 *
 * Return value: same shape as `useStageTask` so migration is drop-in.
 */
export function useTaskController(
  opts: UseTaskControllerOptions,
): TaskControllerHandle {
  const {
    key,
    alsoReconcile,
    invalidateKeys,
    onComplete,
    onError,
    showCompleteToast,
  } = opts;

  // `useTaskRegistry` both fetches the handle AND asserts that a
  // `TaskControllerProvider` wraps the caller; we need it for `getOrCreate`
  // below and also as a runtime guard against stray uses.
  const registry = useTaskRegistry();
  const queryClient = useQueryClient();
  const instanceId = useInstanceId();

  // Serialize the key so dependency arrays are stable strings rather than
  // fresh object refs per render.
  const serialized = serializeKey(key);

  // Resolve the entry during render. `useMemo` rekeys on serialized so a
  // caller who changes key.taskType (e.g. the script rhythm toggle) moves to
  // a fresh entry. The ownership effect below releases the old entry.
  const entry = useMemo(
    () => registry.getOrCreate(key),
    // Depend on serialized; `key` is a fresh object literal each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registry, serialized],
  );

  // Subscribe to snapshot updates (tear-free). Reading the snapshot first
  // means the ownership watchdog effect below sees the freshest `hasOwner`
  // value on each commit, which is what drives observer → owner promotion
  // when the previous owner unmounts.
  const snapshot = useEntrySnapshot(entry);

  // Ownership is derived, not local state: on each render we read the
  // registry entry. This is intentional — we want `isOwner` to flip during
  // the same render that observes `snapshot.hasOwner` changing, so the
  // owner-gated `useTaskStream` opens the connection in the same commit that
  // promotes this subscriber. `useSyncExternalStore` already delivered a
  // tear-free snapshot; reading `ownerInstanceId` off the entry afterwards
  // is safe because the snapshot's `hasOwner` was updated atomically with it.
  const isOwner = entry.ownerInstanceId === instanceId;

  // Membership effect: track this subscriber in the entry's subscriber set.
  // Keep this separate from the claim watchdog so strict-mode's simulated
  // unmount/remount does not interleave membership with ownership decisions.
  useEffect(() => {
    entry.subscribers.add(instanceId);
    return () => {
      entry.subscribers.delete(instanceId);
      if (entry.ownerInstanceId === instanceId) {
        // Release first so any re-entry in the same tick sees a vacant slot
        // and can claim it. `releaseOwnership` emits `hasOwner: false`, which
        // re-renders the other subscribers and triggers their watchdog claim.
        releaseOwnership(entry, instanceId);
      }
    };
  }, [entry, instanceId]);

  // Ownership watchdog: if this subscriber is registered and the entry has
  // no owner, attempt a claim. Runs on:
  //   - initial mount (after membership effect registers this instance),
  //   - strict-mode remount (same),
  //   - owner unmount of a different instance (previous owner's cleanup
  //     flipped `snapshot.hasOwner` to false → re-render → effect re-runs).
  //
  // Idempotency: `claimOwnership` is a no-op when the caller already owns
  // or the slot is taken by someone else, so concurrent watchdog runs by
  // multiple subscribers resolve deterministically to a single owner.
  useEffect(() => {
    if (snapshot.hasOwner) return;
    if (!entry.subscribers.has(instanceId)) return;
    claimOwnership(entry, instanceId);
  }, [snapshot.hasOwner, entry, instanceId]);

  // ─── Reconcile once against /tasks list (owner-only) ─────────────────────
  // Scope the /tasks subscription to this controller's episode so unrelated
  // task churn doesn't re-fire the effect.
  const { data: tasksRes } = useTasks({
    project: key.project,
    episode: key.episode,
  });

  const logsRef = useRef<string[]>([]);
  const [, forceRerender] = useState(0);
  const appendLogs = useCallback((incoming: readonly string[] | null | undefined) => {
    const next = mergeTaskLogs(logsRef.current, incoming, LOG_CAP);
    if (
      next.length === logsRef.current.length &&
      next.every((line, index) => line === logsRef.current[index])
    ) {
      return;
    }
    logsRef.current = next;
    forceRerender((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!isOwner) return;
    if (entry.reconciled) return;
    if (tasksRes === undefined) return;
    const tasks = tasksRes.data ?? [];
    const candidates = [key.taskType, ...(alsoReconcile ?? [])];
    // Reconcile must filter by scope when the caller is scope-aware —
    // otherwise a card keyed to `character_portrait:alice` could snap onto
    // an active `character_portrait:bob` run and steal its SSE stream.
    // `key.scope` undefined means "no scope filter" (legacy unscoped
    // controllers); when defined, require an exact match on `task.scope`
    // (nullish-normalized).
    const match = tasks.find(
      (t) =>
        candidates.includes(t.task_type) &&
        (key.beatNum === undefined || t.beat_num === key.beatNum) &&
        (key.scope === undefined || (t.scope ?? null) === (key.scope ?? null)) &&
        isActiveStatus(t.status),
    );
    if (match) {
      entry.setSnapshot({
        ...entry.getSnapshot(),
        started: true,
        activeTaskType: match.task_type,
        activeTaskId: match.task_id ?? null,
        // Capture the scope the BE assigned to this matched task so the stream
        // URL below hits the correct (scoped) endpoint. Without this the per-
        // task SSE endpoint returns "Task not found" and completion events
        // never reach the FE, so callers' invalidateKeys never fire.
        activeScope: match.scope ?? null,
      });
    }
    entry.reconciled = true;
  }, [
    isOwner,
    entry,
    tasksRes,
    key.taskType,
    key.project,
    key.episode,
    key.beatNum,
    key.scope,
    alsoReconcile,
  ]);

  // ─── Stream (owner-only) ─────────────────────────────────────────────────
  //
  // Only the owner opens an EventSource. Observers pass `enabled=false`.
  // Callbacks stashed in a ref so they don't reopen the stream on every render.
  const callbacksRef = useRef({ onComplete, onError });
  callbacksRef.current = { onComplete, onError };

  // Fallback for missed per-task SSE terminal events. The project task list is
  // also kept fresh by polling/global SSE; if it already shows this task as
  // terminal, clear the local `started` flag instead of leaving the beat card
  // stuck in its waiting state.
  useEffect(() => {
    if (!isOwner) return;
    if (!snapshot.started) return;
    if (tasksRes === undefined) return;
    const tasks = tasksRes.data ?? [];
    const candidates = [snapshot.activeTaskType || key.taskType, ...(alsoReconcile ?? [])];
    const match = tasks.find(
      (t) =>
        candidates.includes(t.task_type) &&
        (!snapshot.activeTaskId || t.task_id === snapshot.activeTaskId) &&
        (key.beatNum === undefined || t.beat_num === key.beatNum) &&
        ((snapshot.activeScope ?? key.scope) === undefined ||
          (t.scope ?? null) === ((snapshot.activeScope ?? key.scope) ?? null)) &&
        TERMINAL_STATUSES.has(t.status),
    );
    if (!match) return;

    const current = entry.getSnapshot();
    if (!current.started) return;
    entry.setSnapshot({
      ...current,
      started: false,
      streamState: {
        status: match.status,
        progress: match.progress ?? current.streamState.progress,
        currentTask: match.current_task ?? current.streamState.currentTask,
        result: match.result ?? null,
        error: match.error ?? null,
        logs: Array.isArray(match.logs) ? match.logs : current.streamState.logs,
      },
    });

    if (match.status === "completed") {
      if (invalidateKeys) {
        invalidateKeys.forEach((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        );
      }
      callbacksRef.current.onComplete?.(match.result);
    } else {
      callbacksRef.current.onError?.(
        match.error ?? (match.status === "cancelled" ? "Task cancelled" : "Task failed"),
      );
    }
  }, [
    isOwner,
    snapshot.started,
    snapshot.activeTaskType,
    snapshot.activeTaskId,
    snapshot.activeScope,
    tasksRes,
    entry,
    key.taskType,
    key.beatNum,
    key.scope,
    alsoReconcile,
    invalidateKeys,
    queryClient,
  ]);

  const ownerStream = useTaskStream({
    taskType: snapshot.activeTaskType,
    project: key.project,
    episode: key.episode,
    beatNum: key.beatNum,
    // Prefer the reconciled scope (captured from the live `/tasks` list)
    // over the caller-supplied key.scope. Callers that trigger a regen from
    // the UI don't know the server-computed scope (e.g., selection_scope =
    // mode_key + sha1(beats)), so activeScope from reconcile is authoritative.
    scope: snapshot.activeScope ?? key.scope,
    enabled: isOwner && snapshot.started,
    invalidateKeys,
    showCompleteToast,
    onComplete: (r) => {
      entry.setSnapshot({ ...entry.getSnapshot(), started: false });
      callbacksRef.current.onComplete?.(r);
    },
    onError: (e) => {
      entry.setSnapshot({ ...entry.getSnapshot(), started: false });
      callbacksRef.current.onError?.(e);
    },
  });

  // Push the owner's live stream state into the entry so observers see it.
  // Done post-commit to avoid writing during render.
  useEffect(() => {
    if (!isOwner) return;
    if (!snapshot.started && ownerStream.status === "idle") return;
    const current = entry.getSnapshot();
    const prev = current.streamState;
    const ownerLogs = ownerStream.logs ?? [];
    const logsSame =
      prev.logs.length === ownerLogs.length &&
      prev.logs.every((line, index) => line === ownerLogs[index]);
    if (
      prev.status === ownerStream.status &&
      prev.progress === ownerStream.progress &&
      prev.currentTask === ownerStream.currentTask &&
      prev.result === ownerStream.result &&
      prev.error === ownerStream.error &&
      logsSame
    ) {
      return;
    }
    entry.setSnapshot({
      ...current,
      streamState: {
        status: ownerStream.status,
        progress: ownerStream.progress,
        currentTask: ownerStream.currentTask,
        result: ownerStream.result,
        error: ownerStream.error,
        logs: ownerLogs,
      },
    });
  }, [
    isOwner,
    snapshot.started,
    entry,
    ownerStream.status,
    ownerStream.progress,
    ownerStream.currentTask,
    ownerStream.result,
    ownerStream.error,
    ownerStream.logs,
  ]);

  // ─── Logs rolling buffer (per-consumer; kept local) ──────────────────────
  //
  // Merge the task manager's stored logs (from `/tasks`) plus any logs the
  // per-task SSE endpoint sends. If neither source has logs, fall back to
  // currentTask so older task streams still show useful progress.
  useEffect(() => {
    if (!isOwner) return;
    const tasks = tasksRes?.data ?? [];
    const candidates = [key.taskType, ...(alsoReconcile ?? [])];
    const match = tasks.find(
      (t) =>
        candidates.includes(t.task_type) &&
        (key.beatNum === undefined || t.beat_num === key.beatNum) &&
        (key.scope === undefined || (t.scope ?? null) === (key.scope ?? null)) &&
        isActiveStatus(t.status),
    );
    appendLogs(match?.logs);
  }, [
    isOwner,
    tasksRes,
    key.taskType,
    key.beatNum,
    key.scope,
    alsoReconcile,
    appendLogs,
  ]);

  useEffect(() => {
    appendLogs(snapshot.streamState.logs);
  }, [snapshot.streamState.logs, appendLogs]);

  // Fallback terminal reconciliation. The per-task SSE is the primary path,
  // but if the terminal event is missed the `/tasks` list still knows the
  // truth. Clear local spinners from that authoritative task row.
  useEffect(() => {
    if (!isOwner) return;
    if (!snapshot.started) return;
    if (tasksRes === undefined) return;

    const tasks = tasksRes.data ?? [];
    const activeScope = snapshot.activeScope ?? key.scope ?? null;
    const match = tasks.find(
      (t) =>
        t.task_type === snapshot.activeTaskType &&
        (!snapshot.activeTaskId || t.task_id === snapshot.activeTaskId) &&
        (key.beatNum === undefined || t.beat_num === key.beatNum) &&
        (activeScope === null || (t.scope ?? null) === activeScope) &&
        !isActiveStatus(t.status),
    );
    if (!match) return;

    entry.setSnapshot({
      ...entry.getSnapshot(),
      started: false,
      activeScope: match.scope ?? activeScope,
      streamState: {
        status: match.status,
        progress: match.progress ?? 1,
        currentTask: match.current_task ?? "",
        result: match.result ?? null,
        error: match.error ?? null,
        logs: Array.isArray(match.logs) ? match.logs.filter((x) => typeof x === "string") : [],
      },
    });
    if (invalidateKeys) {
      invalidateKeys.forEach((queryKey) => {
        queryClient.invalidateQueries({ queryKey });
      });
    }
    if (match.status === "completed") {
      callbacksRef.current.onComplete?.(match.result);
    } else if (match.status === "failed") {
      callbacksRef.current.onError?.(match.error || "Task failed");
    }
  }, [
    isOwner,
    snapshot.started,
    snapshot.activeScope,
    snapshot.activeTaskType,
    snapshot.activeTaskId,
    tasksRes,
    key.scope,
    key.beatNum,
    entry,
    invalidateKeys,
    queryClient,
  ]);

  useEffect(() => {
    const current = snapshot.streamState.currentTask;
    if (!current) return;
    appendLogs([current]);
  }, [snapshot.streamState.currentTask, appendLogs]);

  // Clear logs when the entry changes (e.g. rhythm toggle → new task type).
  const lastEntryRef = useRef(entry);
  if (lastEntryRef.current !== entry) {
    lastEntryRef.current = entry;
    logsRef.current = [];
  }

  // ─── Cancel mutation ─────────────────────────────────────────────────────
  const cancelTask = useCancelTask();

  const start = useCallback(
    (override?: { scope?: string; taskId?: string }) => {
      logsRef.current = [];
      // Re-open the reconcile window so the NEXT /tasks poll tick can discover
      // the server-assigned scope for this run. Callers that *know* the scope
      // up front (from the TaskResponse returned by the mutation) should pass
      // it via `start({ scope, taskId })` — that way the per-task SSE stream
      // hits the right row on first open, and terminal reconciliation will not
      // mistake an older task with the same scope for the current run.
      entry.reconciled = false;
      entry.setSnapshot({
        ...entry.getSnapshot(),
        started: true,
        activeTaskType: key.taskType,
        activeTaskId: override?.taskId ?? null,
        activeScope: override?.scope ?? key.scope ?? null,
        streamState: {
          status: "idle",
          progress: 0,
          currentTask: "",
          result: null,
          error: null,
          logs: [],
        },
      });
    },
    [entry, key.taskType, key.scope],
  );

  const stop = useCallback(async () => {
    const snap = entry.getSnapshot();
    const activeTaskType = snap.activeTaskType;
    try {
      const result = await cancelTask.mutateAsync({
        type: activeTaskType,
        project: key.project,
        episode: key.episode,
        beatNum: key.beatNum,
        // Prefer the BE-assigned scope captured during reconcile so cancel
        // hits the exact task row — the caller-provided `key.scope` is the
        // authoritative fallback when no reconcile has happened yet (e.g.
        // we just fired `.start()` in the same tick).
        scope: snap.activeScope ?? key.scope,
      });
      if (result.ok) entry.setSnapshot({ ...snap, started: false });
    } catch {
      // Keep tracking the task when cancellation did not complete.
    }
  }, [cancelTask, entry, key.project, key.episode, key.beatNum, key.scope]);

  return {
    started: snapshot.started,
    stream: snapshot.streamState,
    logs: logsRef.current,
    start,
    stop,
    stopping: cancelTask.isPending,
  };
}
