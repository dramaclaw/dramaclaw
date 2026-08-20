// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Scoped Task Controller — one SSE stream per `TaskKey`, shared across subscribers.
 *
 * ARCHITECTURE (Option A: context + owner + useSyncExternalStore):
 *
 *   The provider holds a ref-scoped Map keyed on `serializeKey(TaskKey)`. Each
 *   registry entry is a tiny external store:
 *
 *     entry = {
 *       ownerInstanceId,   // the single `useTaskController` caller that runs the stream
 *       subscribers,       // set of instance ids subscribed to this key
 *       snapshot,          // { started, activeTaskType, streamState, hasOwner } — owner writes, all read
 *       listeners,         // Set<() => void> for useSyncExternalStore
 *     }
 *
 *   - First `useTaskController` for a key claims ownership; `isOwner === true` →
 *     its internal `useTaskStream` call has `enabled = true` and it is the only
 *     subscriber opening an EventSource for this key.
 *   - Non-owners get `enabled = false` on their `useTaskStream` — they do not
 *     open a connection. Instead they observe the shared `snapshot` via
 *     `useSyncExternalStore` and render from it.
 *   - On unmount, owner releases. `releaseOwnership` emits a snapshot with
 *     `hasOwner: false`, which re-renders observers via `useSyncExternalStore`;
 *     the next-in-line subscriber then claims on its "hasOwner watchdog" effect.
 *
 * Why this pattern (vs. a pure React-context broadcast): `useSyncExternalStore`
 * gives us tear-free subscriber renders without spraying context updates through
 * unrelated trees (the provider wraps `<Outlet/>` so a context update would
 * re-render every tab/drawer). Tearing matters here because the owner writes
 * `streamState` frequently (per SSE event) and non-owner consumers must see the
 * same snapshot on commit.
 *
 * Lifecycle invariants (enforced by design, guarded by integration tests):
 *
 *   1. Exactly one entry per serialized TaskKey per provider instance.
 *      - Entries are *never* deleted while the provider is mounted. This is a
 *        deliberate choice to defeat React StrictMode's simulated unmount:
 *        cleanup → maybeDelete(empty) → remount would otherwise orphan the
 *        entry that the fiber still holds via `useMemo`, and a second
 *        subscriber would create a duplicate entry → duplicate SSE stream.
 *      - The map is bounded by the number of distinct TaskKeys touched during
 *        the provider's lifetime (~single-digit per episode). GC happens
 *        automatically when the provider remounts on scope change.
 *
 *   2. Ownership transfer is reactive, not polled.
 *      - `releaseOwnership` bumps the snapshot (`hasOwner: false`), which
 *        re-renders every subscriber for that entry. A watchdog effect on each
 *        subscriber runs `claimOwnership` and, on success, takes over the
 *        stream. No setInterval, no manual prod.
 *
 * Acceptable caveats (flagged in the plan):
 *   1. If the owner unmounts while the task is running, the stream momentarily
 *      disconnects until another subscriber claims ownership on its next effect.
 *      This is a single-digit-millisecond gap; EventSource reconnect semantics
 *      handle it on the server side.
 *   2. `useCancelTask` does not forward `beat_num` / `scope` to the backend yet;
 *      scope-narrowed cancellation is a follow-up. Today's cancel is stage-wide.
 */

import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { TaskStatus } from "@/types/task";

// ─── Public types ───────────────────────────────────────────────────────────

export interface TaskKey {
  taskType: string;
  project: string;
  episode: number;
  beatNum?: number;
  scope?: string;
}

export interface TaskStreamState {
  status: "idle" | TaskStatus;
  progress: number;
  currentTask: string;
  result: unknown | null;
  error: string | null;
  logs: string[];
}

export interface TaskControllerSnapshot {
  started: boolean;
  activeTaskType: string;
  /**
   * Server-assigned task id for the currently-running task. Scope can be
   * reused by later runs, so terminal reconciliation should prefer task id
   * when the launch response provides it.
   */
  activeTaskId: string | null;
  /**
   * Scope of the currently-running matched task, discovered during reconcile.
   * The scope is derived server-side from content (e.g., selection_scope →
   * mode_key + beats hash) and the caller usually doesn't know it up front.
   * Captured here so `useTaskStream` can connect to the correctly-scoped SSE
   * endpoint; without it the BE's `get_task` lookup fails with "Task not
   * found" and completion events never reach the FE.
   */
  activeScope: string | null;
  /**
   * Beats the currently-tracked run covers, or `null` when unknown.
   *
   * Per-beat panels (草图 / 渲染图) all subscribe to one episode-wide entry
   * because selection-scoped runs carry `beat_num = null` and an opaque scope
   * hash — without this field every panel would render the same spinner and a
   * single regen would look like the whole episode was generating.
   * `null` means "no attribution available", which callers read as
   * "covers everything" rather than hiding a genuinely running beat.
   */
  activeBeatNumbers: number[] | null;
  streamState: TaskStreamState;
  /**
   * Mirrors `entry.ownerInstanceId !== null`. Exposed through the snapshot so
   * `useSyncExternalStore` consumers re-render when ownership becomes vacant,
   * giving non-owner subscribers a deterministic trigger to attempt a claim.
   * Single source of truth remains `entry.ownerInstanceId`; this field is
   * updated atomically by `claimOwnership` / `releaseOwnership`.
   */
  hasOwner: boolean;
}

// Owner-only API exposed to `useTaskController` so it can manage the registry
// entry it claimed. Kept private-ish to this module: callers don't touch this;
// they call `useTaskController`.
export interface TaskRegistryEntry {
  readonly key: TaskKey;
  readonly serializedKey: string;
  // Current owner of the stream for this key (or null if unowned).
  ownerInstanceId: string | null;
  // All active subscribers (including the owner). When 0, entry is removed.
  readonly subscribers: Set<string>;
  // Whether the owner has already reconciled the /tasks list for this key.
  // Reconcile happens once and survives owner transfer, so a re-mount of the
  // owner after an owner-transfer gap does not reset status.
  reconciled: boolean;
  // External-store shape.
  getSnapshot(): TaskControllerSnapshot;
  setSnapshot(next: TaskControllerSnapshot): void;
  subscribe(listener: () => void): () => void;
}

// ─── Serialization ──────────────────────────────────────────────────────────

const ACTIVE_STATUSES: readonly TaskStatus[] = [
  "submitting",
  "queued",
  "pending",
  "starting",
  "running",
] as const;

/**
 * Stable string representation of a TaskKey. Two keys produce the same string
 * iff they identify the same scoped task. Exported for tests.
 */
export function serializeKey(k: TaskKey): string {
  return `${k.taskType}|${k.project}|${k.episode}|${k.beatNum ?? ""}|${k.scope ?? ""}`;
}

export function isActiveStatus(status: TaskStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

const INITIAL_STREAM_STATE: TaskStreamState = {
  status: "idle",
  progress: 0,
  currentTask: "",
  result: null,
  error: null,
  logs: [],
};

// ─── Registry (mutable, ref-held) ───────────────────────────────────────────

function createEntry(key: TaskKey): TaskRegistryEntry {
  const serializedKey = serializeKey(key);
  const listeners = new Set<() => void>();
  let snapshot: TaskControllerSnapshot = {
    started: false,
    activeTaskType: key.taskType,
    activeTaskId: null,
    activeScope: key.scope ?? null,
    activeBeatNumbers: key.beatNum === undefined ? null : [key.beatNum],
    streamState: INITIAL_STREAM_STATE,
    hasOwner: false,
  };
  return {
    key,
    serializedKey,
    ownerInstanceId: null,
    subscribers: new Set(),
    reconciled: false,
    getSnapshot: () => snapshot,
    setSnapshot(next) {
      snapshot = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ─── Context ────────────────────────────────────────────────────────────────

interface RegistryHandle {
  /** Get or create the entry for a key. Does not affect ownership. */
  getOrCreate(key: TaskKey): TaskRegistryEntry;
}

const TaskRegistryContext = createContext<RegistryHandle | null>(null);

export function useTaskRegistry(): RegistryHandle {
  const ctx = useContext(TaskRegistryContext);
  if (!ctx) {
    throw new Error(
      "useTaskRegistry must be used inside <TaskControllerProvider>",
    );
  }
  return ctx;
}

// Exported for tests that need an ambient provider identity (e.g. same project
// + episode). In production the provider is mounted exactly once per
// episode view inside `episodes.tsx`.
export function TaskControllerProvider({
  project,
  episode,
  children,
}: {
  project: string;
  episode: number;
  children: ReactNode;
}) {
  // The registry map lives for the lifetime of this provider instance.
  // Remounting (e.g. switching episodes) produces a fresh map.
  const mapRef = useRef<Map<string, TaskRegistryEntry> | null>(null);
  if (mapRef.current === null) {
    mapRef.current = new Map();
  }

  // Guard against stale entries when project/episode changes. If a parent
  // reuses the provider across episodes (it doesn't today — episodes.tsx
  // re-mounts per selected episode — but defend anyway), we reset.
  const scopeKey = `${project}|${episode}`;
  const lastScopeRef = useRef(scopeKey);
  if (lastScopeRef.current !== scopeKey) {
    lastScopeRef.current = scopeKey;
    mapRef.current = new Map();
  }

  const handle = useMemo<RegistryHandle>(
    () => ({
      getOrCreate: (key) => {
        const serialized = serializeKey(key);
        const existing = mapRef.current!.get(serialized);
        if (existing) return existing;
        const entry = createEntry(key);
        mapRef.current!.set(serialized, entry);
        return entry;
      },
      // NB: no `maybeDelete`. Entries live for the provider's lifetime. Removing
      // empty entries naively breaks under StrictMode — see file-level docstring
      // for the full argument. Memory is bounded by `|distinct TaskKeys per episode|`.
    }),
    // `mapRef` is stable; `scopeKey` triggers a fresh handle when scope resets
    // so consumers dependent on it re-subscribe cleanly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeKey],
  );

  return (
    <TaskRegistryContext.Provider value={handle}>
      {children}
    </TaskRegistryContext.Provider>
  );
}

// ─── Owner-internal helpers (used by useTaskController) ─────────────────────

/**
 * Claim or re-claim ownership of the given entry for `instanceId`. Returns
 * `true` iff this call set (or re-set) this instance as the owner.
 *
 * Writes `hasOwner: true` into the snapshot (and emits listeners) on a
 * successful claim so `useSyncExternalStore` consumers — including other
 * subscribers waiting on a vacancy — observe the transition on their next
 * render.
 */
export function claimOwnership(
  entry: TaskRegistryEntry,
  instanceId: string,
): boolean {
  if (entry.ownerInstanceId === instanceId) return true;
  if (entry.ownerInstanceId === null) {
    entry.ownerInstanceId = instanceId;
    const cur = entry.getSnapshot();
    // Only emit if hasOwner actually flipped — avoids a redundant listener fan-out
    // on the strict-mode re-mount path where we claim twice for the same id.
    if (!cur.hasOwner) {
      entry.setSnapshot({ ...cur, hasOwner: true });
    }
    return true;
  }
  return false;
}

/**
 * Release ownership if `instanceId` currently owns. Writes `hasOwner: false`
 * into the snapshot so observers waiting on a vacancy re-render and can claim.
 */
export function releaseOwnership(
  entry: TaskRegistryEntry,
  instanceId: string,
): void {
  if (entry.ownerInstanceId === instanceId) {
    entry.ownerInstanceId = null;
    const cur = entry.getSnapshot();
    if (cur.hasOwner) {
      entry.setSnapshot({ ...cur, hasOwner: false });
    }
  }
}

/**
 * `useSyncExternalStore`-compatible hook that tracks a registry entry's
 * snapshot. Re-renders the caller whenever the owner updates the snapshot.
 */
export function useEntrySnapshot(
  entry: TaskRegistryEntry,
): TaskControllerSnapshot {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable entry ref
  const subscribe = useCallback(
    (listener: () => void) => entry.subscribe(listener),
    [entry],
  );
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable entry ref
  const getSnapshot = useCallback(() => entry.getSnapshot(), [entry]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Exposed for `useTaskController` to mint a stable per-instance id. Uses
 * React's `useId` so ids are deterministic across strict-mode double-render.
 */
export function useInstanceId(): string {
  return useId();
}
