// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getFreezoneCanvas, putFreezoneCanvas } from "@/api/canvas";
import { ApiError } from "@/api/client";
import {
  FREEZONE_HYDRATE_RELEASE_GRACE_MS,
  FREEZONE_HYDRATE_SETTLED_REUSE_MS,
  HISTORY_PERSIST_MAX_STEPS,
  trimHistoryForStorage,
  useCanvasSync,
} from "@/features/freezone/useCanvasSync";
import {
  readCanvasDraft,
  writeCanvasDraft,
} from "@/features/freezone/canvasDraftStorage";
import {
  applyRemoteFreezoneCanvas,
  consumeQueuedLocalFreezoneProjections,
  queueLocalFreezoneProjection,
  removeLocalFreezoneProjection,
} from "@/features/freezone/canvasSyncRuntime";
import { useShotMetadataStore } from "@/features/freezone/shotMetadataStore";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";

vi.mock("@/api/canvas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/canvas")>();
  return {
    ...actual,
    getFreezoneCanvas: vi.fn(),
    putFreezoneCanvas: vi.fn(),
  };
});

vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({
    setViewport: vi.fn(),
  }),
}));

describe("useCanvasSync hydrate lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.mocked(getFreezoneCanvas).mockReset();
    vi.mocked(putFreezoneCanvas).mockReset();
    vi.mocked(putFreezoneCanvas).mockResolvedValue({
      saved: true,
      revision: 2,
    });
    vi.unstubAllGlobals();
    window.localStorage.clear();
    useCanvasStore.getState().setCanvasData([], []);
    useShotMetadataStore.getState().hydrate({});
  });

  it("aborts the in-flight hydrate request after the release grace when unmounted", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockImplementation(
      () => new Promise(() => undefined),
    );

    const { unmount } = renderHook(() =>
      useCanvasSync("project-a", "user_eric"),
    );

    expect(getFreezoneCanvas).toHaveBeenCalledTimes(1);
    const options = vi.mocked(getFreezoneCanvas).mock.calls[0][2];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal?.aborted).toBe(false);

    unmount();

    expect(options?.signal?.aborted).toBe(false);
    act(() => {
      vi.advanceTimersByTime(FREEZONE_HYDRATE_RELEASE_GRACE_MS);
    });
    expect(options?.signal?.aborted).toBe(true);
  });

  it("reuses an in-flight hydrate request across a StrictMode-style remount", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockImplementation(
      () => new Promise(() => undefined),
    );

    const first = renderHook(() => useCanvasSync("project-a", "user_eric"));

    expect(getFreezoneCanvas).toHaveBeenCalledTimes(1);
    const options = vi.mocked(getFreezoneCanvas).mock.calls[0][2];

    first.unmount();
    expect(options?.signal?.aborted).toBe(false);

    const second = renderHook(() => useCanvasSync("project-a", "user_eric"));
    expect(getFreezoneCanvas).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(FREEZONE_HYDRATE_RELEASE_GRACE_MS);
    });
    expect(options?.signal?.aborted).toBe(false);

    second.unmount();
    act(() => {
      vi.advanceTimersByTime(FREEZONE_HYDRATE_RELEASE_GRACE_MS);
    });
    expect(options?.signal?.aborted).toBe(true);
  });

  it("reuses a just-settled hydrate snapshot across the settled reuse window", async () => {
    let resolveRemote: (value: { nodes: []; edges: []; revision: number }) => void =
      () => undefined;
    vi.mocked(getFreezoneCanvas).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRemote = resolve;
        }),
    );

    const first = renderHook(() =>
      useCanvasSync("project-a", "strict_user_eric"),
    );

    expect(getFreezoneCanvas).toHaveBeenCalledTimes(1);

    first.unmount();
    await act(async () => {
      resolveRemote({ nodes: [], edges: [], revision: 1 });
      await Promise.resolve();
    });

    const second = renderHook(() =>
      useCanvasSync("project-a", "strict_user_eric"),
    );

    expect(getFreezoneCanvas).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(second.result.current.revision).toBe(1));

    second.unmount();
  });

  it("does not reuse a settled hydrate snapshot after the settled reuse window", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas)
      .mockResolvedValueOnce({
        nodes: [],
        edges: [],
        revision: 1,
      })
      .mockResolvedValueOnce({
        nodes: [],
        edges: [],
        revision: 2,
      });

    const first = renderHook(() =>
      useCanvasSync("project-a", "settled_user_eric"),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(first.result.current.status).toBe("ready");
    expect(getFreezoneCanvas).toHaveBeenCalledTimes(1);

    first.unmount();
    act(() => {
      vi.advanceTimersByTime(FREEZONE_HYDRATE_SETTLED_REUSE_MS + 10);
    });

    const second = renderHook(() =>
      useCanvasSync("project-a", "settled_user_eric"),
    );

    expect(getFreezoneCanvas).toHaveBeenCalledTimes(2);
    await act(async () => {
      await Promise.resolve();
    });
    expect(second.result.current.revision).toBe(2);

    second.unmount();
  });

  it("does not reuse a settled hydrate snapshot after local edits", async () => {
    vi.mocked(getFreezoneCanvas)
      .mockResolvedValueOnce({
        nodes: [],
        edges: [],
        revision: 1,
      })
      .mockResolvedValueOnce({
        nodes: [],
        edges: [],
        revision: 2,
      });

    const first = renderHook(() =>
      useCanvasSync("project-a", "edited_user_eric"),
    );

    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    expect(getFreezoneCanvas).toHaveBeenCalledTimes(1);

    first.unmount();
    useCanvasStore.setState({ userEditsSinceHydrate: 1 });

    const second = renderHook(() =>
      useCanvasSync("project-a", "edited_user_eric"),
    );

    expect(getFreezoneCanvas).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(second.result.current.revision).toBe(2));

    second.unmount();
  });

  it("restores a same-revision draft and lets the existing autosave flush it", async () => {
    vi.useFakeTimers();
    const draftNode = {
      id: "draft-node",
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 10, y: 20 },
      data: { imageUrl: "/static/draft.png" },
    };
    writeCanvasDraft("project-a", "draft_user_eric", {
      baseRevision: 7,
      nodes: [draftNode],
      edges: [],
      viewport: { x: 1, y: 2, zoom: 1 },
      metadata: null,
      history: { past: [], future: [] },
      mutation: {
        userEditsSinceHydrate: 1,
        lastMutationSource: "user_edit",
        pendingClearIntent: false,
      },
      updatedAt: Date.now(),
    });
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
    });

    const hook = renderHook(() =>
      useCanvasSync("project-a", "draft_user_eric"),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.status).toBe("ready");
    expect(useCanvasStore.getState().nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "draft-node" })]),
    );
    expect(useCanvasStore.getState().userEditsSinceHydrate).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });

    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(vi.mocked(putFreezoneCanvas).mock.calls[0][2]).toMatchObject({
      base_revision: 7,
      nodes: [expect.objectContaining({ id: "draft-node" })],
      save_source: "autosave",
    });

    hook.unmount();
  });

  it("restores an empty manual-clear draft without tripping the dangerous-empty guard", async () => {
    vi.useFakeTimers();
    writeCanvasDraft("project-a", "clear_user_eric", {
      baseRevision: 7,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      metadata: null,
      history: { past: [], future: [] },
      mutation: {
        userEditsSinceHydrate: 1,
        lastMutationSource: "manual_clear",
        pendingClearIntent: true,
      },
      updatedAt: Date.now(),
    });
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [
        {
          id: "server-node",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { imageUrl: "/static/server.png" },
        },
      ],
      edges: [],
      revision: 7,
    });

    const hook = renderHook(() =>
      useCanvasSync("project-a", "clear_user_eric"),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.status).toBe("ready");
    expect(useCanvasStore.getState().nodes).toEqual([]);
    expect(useCanvasStore.getState().pendingClearIntent).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });

    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(vi.mocked(putFreezoneCanvas).mock.calls[0][2]).toMatchObject({
      save_source: "manual_clear",
      allow_empty_overwrite: true,
    });

    hook.unmount();
  });

  it("clears a stale draft when the server already has the same content at a newer revision", async () => {
    const node = {
      id: "saved-node",
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 0 },
      data: { imageUrl: "/static/saved.png" },
    };
    writeCanvasDraft("project-a", "saved_user_eric", {
      baseRevision: 7,
      nodes: [node],
      edges: [],
      viewport: null,
      metadata: null,
      history: { past: [], future: [] },
      mutation: {
        userEditsSinceHydrate: 1,
        lastMutationSource: "user_edit",
        pendingClearIntent: false,
      },
      updatedAt: Date.now(),
    });
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [node],
      edges: [],
      revision: 8,
    });

    const hook = renderHook(() =>
      useCanvasSync("project-a", "saved_user_eric"),
    );

    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    expect(hook.result.current.status).not.toBe("conflict");
    expect(putFreezoneCanvas).not.toHaveBeenCalled();

    hook.unmount();
  });

  it("clears a saved projection draft when server metadata contains extra fields", async () => {
    const projectionNode = {
      id: "projection_beat_1_4__projection_group_beat_1_4",
      type: "groupNode",
      position: { x: 0, y: 0 },
      data: { projection_key: "beat:1:4" },
    } as any;
    writeCanvasDraft("project-a", "saved_projection_user_eric", {
      baseRevision: 7,
      nodes: [projectionNode],
      edges: [],
      viewport: null,
      metadata: {
        projections: {
          "beat:1:4": {
            projection_key: "beat:1:4",
            facts_signature: "sig",
          },
        },
      },
      history: { past: [], future: [] },
      mutation: {
        userEditsSinceHydrate: 1,
        lastMutationSource: "user_edit",
        pendingClearIntent: false,
      },
      updatedAt: Date.now(),
    });
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [projectionNode],
      edges: [],
      revision: 8,
      metadata: {
        preset: { scope: "free" },
        projections: {
          "beat:1:4": {
            projection_key: "beat:1:4",
            facts_signature: "sig",
            request: { scope: "beat", episode: 1, beat: 4 },
          },
        },
      },
    });

    const hook = renderHook(() =>
      useCanvasSync("project-a", "saved_projection_user_eric"),
    );

    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    expect(hook.result.current.error).toBeNull();
    expect(putFreezoneCanvas).not.toHaveBeenCalled();
    expect(readCanvasDraft("project-a", "saved_projection_user_eric")).toBeNull();

    hook.unmount();
  });

  it("does not auto-restore a different draft when either revision is unknown", async () => {
    writeCanvasDraft("project-a", "unknown_revision_user_eric", {
      baseRevision: null,
      nodes: [
        {
          id: "draft-node",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { imageUrl: "/static/draft.png" },
        },
      ],
      edges: [],
      viewport: null,
      metadata: null,
      history: { past: [], future: [] },
      mutation: {
        userEditsSinceHydrate: 1,
        lastMutationSource: "user_edit",
        pendingClearIntent: false,
      },
      updatedAt: Date.now(),
    });
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [
        {
          id: "server-node",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { imageUrl: "/static/server.png" },
        },
      ],
      edges: [],
      revision: null,
    });

    const hook = renderHook(() =>
      useCanvasSync("project-a", "unknown_revision_user_eric"),
    );

    await waitFor(() => expect(hook.result.current.status).toBe("conflict"));
    expect(useCanvasStore.getState().nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "server-node" })]),
    );
    expect(putFreezoneCanvas).not.toHaveBeenCalled();

    hook.unmount();
  });

  it("does not autosave new edits while a draft conflict is unresolved", async () => {
    vi.useFakeTimers();
    writeCanvasDraft("project-a", "conflict_user_eric", {
      baseRevision: 7,
      nodes: [
        {
          id: "draft-node",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { imageUrl: "/static/draft.png" },
        },
      ],
      edges: [],
      viewport: null,
      metadata: null,
      history: { past: [], future: [] },
      mutation: {
        userEditsSinceHydrate: 1,
        lastMutationSource: "user_edit",
        pendingClearIntent: false,
      },
      updatedAt: Date.now(),
    });
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [
        {
          id: "server-node",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { imageUrl: "/static/server.png" },
        },
      ],
      edges: [],
      revision: 8,
    });

    const hook = renderHook(() =>
      useCanvasSync("project-a", "conflict_user_eric"),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.status).toBe("conflict");

    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 100, y: 100 }, {});
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });

    expect(putFreezoneCanvas).not.toHaveBeenCalled();

    hook.unmount();
  });

  it("stashes a 409 save conflict and freezes further network autosaves", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [
        {
          id: "server-node",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { imageUrl: "/static/server.png" },
        },
      ],
      edges: [],
      revision: 7,
    });
    vi.mocked(putFreezoneCanvas).mockRejectedValueOnce(
      new ApiError("conflict", 409, {}),
    );

    const hook = renderHook(() =>
      useCanvasSync("project-a", "save_conflict_user_eric"),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.status).toBe("ready");

    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 100, y: 100 }, {});
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });

    expect(hook.result.current.status).toBe("conflict");
    expect(hook.result.current.readConflictSnapshot()).toMatchObject({
      canvas_id: "save_conflict_user_eric",
      nodes: expect.arrayContaining([expect.objectContaining({ id: "server-node" })]),
    });
    expect(readCanvasDraft("project-a", "save_conflict_user_eric")).not.toBeNull();

    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 200, y: 200 }, {});
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });

    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);

    hook.unmount();
  });

  // Regression: on a slow link a PUT outlives the 800ms debounce, so two more
  // debounced saves stack on the same in-flight promise. They used to resume in
  // one microtask batch and both fire with the base_revision the first save had
  // just published — the second earned a 409 and the UI blamed "another window"
  // for a race the client created. Reproducible in the browser by throttling to
  // 3G and dragging nodes.
  it("serializes saves that stack behind a slow in-flight PUT", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
    });

    const baseRevisions: Array<number | null> = [];
    const nodeCounts: number[] = [];
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let revision = 7;
    vi.mocked(putFreezoneCanvas).mockImplementation(
      (_project: string, _canvasId: string, payload: unknown) => {
        const body = payload as {
          base_revision?: number | null;
          nodes?: unknown[];
        };
        baseRevisions.push(body.base_revision ?? null);
        nodeCounts.push((body.nodes ?? []).length);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => {
          releases.push(() => {
            inFlight -= 1;
            revision += 1;
            resolve({ saved: true, revision });
          });
        });
      },
    );

    const hook = renderHook(() =>
      useCanvasSync("project-a", "slow_link_user_eric"),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.status).toBe("ready");

    // Three edits, each debounced out while the previous PUT is still hanging.
    for (const x of [100, 200, 300]) {
      useCanvasStore
        .getState()
        .addNode(CANVAS_NODE_TYPES.upload, { x, y: x }, {});
      await act(async () => {
        vi.advanceTimersByTime(800);
        await Promise.resolve();
      });
    }

    // Only the first save is on the wire; the other two collapse into one
    // queued follow-up rather than stacking.
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(releases).toHaveLength(1);

    // Release the in-flight save; the queued follow-up then goes out.
    await act(async () => {
      releases[0]();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(2);
    expect(releases).toHaveLength(2);
    await act(async () => {
      releases[1]();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Three edits produce two PUTs, never concurrent, never sharing a
    // base_revision — and the queued one carries the newest node set rather
    // than the snapshot captured before it waited.
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(baseRevisions).toEqual([7, 8]);
    expect(nodeCounts).toEqual([1, 3]);
    expect(useCanvasStore.getState().nodes).toHaveLength(3);
    expect(hook.result.current.status).toBe("ready");

    hook.unmount();
  });

  // A queued save wakes up holding refs that now describe a *different* canvas:
  // FreezoneShell is mounted without a key, so switching canvases re-runs the
  // hydrate effect against the same ref set. Re-reading the store at that point
  // would PUT the new canvas's content under the old canvas's id.
  it("drops a save queued across a canvas switch", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockImplementation(
      async (_project: string, canvasId: string) => ({
        nodes:
          canvasId === "switch_target_user_eric"
            ? [
                {
                  id: "b-node",
                  type: CANVAS_NODE_TYPES.upload,
                  position: { x: 0, y: 0 },
                  data: { imageUrl: "/static/b.png" },
                },
              ]
            : [],
        edges: [],
        revision: 7,
      }),
    );

    const putCanvasIds: string[] = [];
    const releases: Array<() => void> = [];
    vi.mocked(putFreezoneCanvas).mockImplementation(
      (_project: string, canvasId: string) => {
        putCanvasIds.push(canvasId);
        return new Promise((resolve) => {
          releases.push(() => resolve({ saved: true, revision: 8 }));
        });
      },
    );

    const hook = renderHook(
      ({ canvasId }: { canvasId: string }) =>
        useCanvasSync("project-a", canvasId),
      { initialProps: { canvasId: "switch_source_user_eric" } },
    );
    await act(async () => {
      await Promise.resolve();
    });

    // Edit canvas A and let its save reach the wire.
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 10, y: 10 }, {});
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
    expect(putCanvasIds).toEqual(["switch_source_user_eric"]);

    // A second edit queues behind it, then the user switches canvases.
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 20, y: 20 }, {});
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });

    hook.rerender({ canvasId: "switch_target_user_eric" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Canvas A's PUT finally lands; the queued save must not resume against
    // canvas B's content.
    await act(async () => {
      releases[0]();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(putCanvasIds).toEqual(["switch_source_user_eric"]);

    hook.unmount();
  });

  // Same shape as above, except the user *edits* the canvas they switched to
  // while the old canvas's PUT is still hanging. Dropping the stale queued save
  // must not drop the new canvas's edit with it. Save sessions are per-canvas,
  // so canvas B does not queue behind canvas A at all — the backend lock is
  // per-canvas, and making B wait out A's slow request buys nothing.
  it("dispatches the new canvas's save without waiting for the old canvas's PUT", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockImplementation(
      async (_project: string, canvasId: string) => ({
        nodes:
          canvasId === "cross_target_user_eric"
            ? [
                {
                  id: "b-node",
                  type: CANVAS_NODE_TYPES.upload,
                  position: { x: 0, y: 0 },
                  data: { imageUrl: "/static/b.png" },
                },
              ]
            : [],
        edges: [],
        revision: canvasId === "cross_target_user_eric" ? 3 : 7,
      }),
    );

    const putCanvasIds: string[] = [];
    const putBaseRevisions: Array<number | null> = [];
    const putNodeXs: number[][] = [];
    const releases: Array<() => void> = [];
    vi.mocked(putFreezoneCanvas).mockImplementation(
      (_project: string, canvasId: string, payload: unknown) => {
        const body = payload as {
          base_revision?: number | null;
          nodes?: Array<{ position?: { x?: number } }>;
        };
        putCanvasIds.push(canvasId);
        putBaseRevisions.push(body.base_revision ?? null);
        putNodeXs.push((body.nodes ?? []).map((node) => node.position?.x ?? -1));
        return new Promise((resolve) => {
          releases.push(() => resolve({ saved: true, revision: 42 }));
        });
      },
    );

    const hook = renderHook(
      ({ canvasId }: { canvasId: string }) =>
        useCanvasSync("project-a", canvasId),
      { initialProps: { canvasId: "cross_source_user_eric" } },
    );
    await act(async () => {
      await Promise.resolve();
    });

    // Canvas A: first edit reaches the wire and hangs there.
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 10, y: 10 }, {});
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
    expect(putCanvasIds).toEqual(["cross_source_user_eric"]);

    // Canvas A: a second edit takes the single queue slot behind it.
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 20, y: 20 }, {});
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
    expect(putCanvasIds).toHaveLength(1);

    // Switch to canvas B, then edit it while canvas A's PUT is still hanging.
    hook.rerender({ canvasId: "cross_target_user_eric" });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 99, y: 99 }, {});
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
    // Canvas B's edit goes out on its own session, immediately.
    expect(putCanvasIds).toEqual([
      "cross_source_user_eric",
      "cross_target_user_eric",
    ]);
    expect(putNodeXs).toEqual([[10], [0, 99]]);
    // And it carries canvas B's own revision, not canvas A's.
    expect(putBaseRevisions).toEqual([7, 3]);

    // Canvas A's PUT finally lands. Its queued follow-up belongs to a canvas we
    // left, so it must not produce a third request against canvas B.
    await act(async () => {
      releases[0]();
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
    expect(putCanvasIds).toHaveLength(2);

    hook.unmount();
  });

  // Unmount is the third way a session can be orphaned (after a canvas switch
  // and a remote refresh). The store is global, so whatever mounts next owns it;
  // a queued save from the unmounted hook would read *that* content and PUT it
  // to the canvas it left.
  it("drops a queued save when the hook unmounts", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockImplementation(
      async (_project: string, canvasId: string) => ({
        nodes:
          canvasId === "unmount_target_user_eric"
            ? [
                {
                  id: "b-node",
                  type: CANVAS_NODE_TYPES.upload,
                  position: { x: 0, y: 0 },
                  data: { imageUrl: "/static/b.png" },
                },
              ]
            : [],
        edges: [],
        revision: canvasId === "unmount_target_user_eric" ? 3 : 7,
      }),
    );

    const putCanvasIds: string[] = [];
    const releases: Array<() => void> = [];
    vi.mocked(putFreezoneCanvas).mockImplementation(
      (_project: string, canvasId: string) => {
        putCanvasIds.push(canvasId);
        return new Promise((resolve) => {
          releases.push(() => resolve({ saved: true, revision: 42 }));
        });
      },
    );

    const hookA = renderHook(() =>
      useCanvasSync("project-a", "unmount_source_user_eric"),
    );
    await act(async () => {
      await Promise.resolve();
    });

    // Canvas A: one PUT on the wire, one save queued behind it.
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 10, y: 10 }, {});
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 20, y: 20 }, {});
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
    expect(putCanvasIds).toEqual(["unmount_source_user_eric"]);

    // Canvas A goes away and canvas B takes over the global store.
    hookA.unmount();
    const hookB = renderHook(() =>
      useCanvasSync("project-a", "unmount_target_user_eric"),
    );
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    // Canvas A's PUT finally answers. Draining its queue now would send canvas
    // B's nodes to canvas A's id.
    await act(async () => {
      releases[0]();
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
    expect(putCanvasIds).toEqual(["unmount_source_user_eric"]);

    hookB.unmount();
  });

  // A remote refresh rewrites revisionRef from the server. A PUT dispatched
  // before that refresh comes back carrying an *older* revision; letting it
  // land would roll the ref backwards and 409 the very next save.
  it("ignores a save response that lands after a remote refresh", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
    });

    const putBaseRevisions: Array<number | null> = [];
    const releases: Array<(revision: number) => void> = [];
    vi.mocked(putFreezoneCanvas).mockImplementation(
      (_project: string, _canvasId: string, payload: unknown) => {
        const body = payload as { base_revision?: number | null };
        putBaseRevisions.push(body.base_revision ?? null);
        return new Promise((resolve) => {
          releases.push((revision: number) =>
            resolve({ saved: true, revision }),
          );
        });
      },
    );

    const hook = renderHook(() =>
      useCanvasSync("project-a", "fence_user_eric"),
    );
    await act(async () => {
      await Promise.resolve();
    });

    // An edit goes out against revision 7 and hangs on the wire.
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 10, y: 10 }, {});
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
    expect(putBaseRevisions).toEqual([7]);

    // Meanwhile the runtime pushes a much newer server state.
    act(() => {
      applyRemoteFreezoneCanvas("project-a", "fence_user_eric", {
        nodes: [
          {
            id: "remote-node",
            type: CANVAS_NODE_TYPES.upload,
            position: { x: 0, y: 0 },
            data: { imageUrl: "/static/remote.png" },
          },
        ],
        edges: [],
        revision: 100,
      });
    });
    expect(hook.result.current.revision).toBe(100);

    // The stale PUT finally answers with revision 8. It must not win.
    await act(async () => {
      releases[0](8);
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
    expect(hook.result.current.revision).toBe(100);

    // And the next save must build on 100, not on the rolled-back 8.
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 30, y: 30 }, {});
    await act(async () => {
      vi.advanceTimersByTime(800);
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
    expect(putBaseRevisions).toEqual([7, 100]);

    hook.unmount();
  });

  // The draft is the only copy of edits that have not reached the server. A
  // save landing clears it — but only if nothing newer is still queued behind
  // that save, otherwise the newest edit exists nowhere at all.
  it("keeps the draft when newer content is still queued behind a save", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
    });

    const releases: Array<() => void> = [];
    let revision = 7;
    vi.mocked(putFreezoneCanvas).mockImplementation(() => {
      return new Promise((resolve) => {
        releases.push(() => {
          revision += 1;
          resolve({ saved: true, revision });
        });
      });
    });

    const hook = renderHook(() =>
      useCanvasSync("project-a", "draft_race_user_eric"),
    );
    await act(async () => {
      await Promise.resolve();
    });

    // First edit: draft written, PUT on the wire.
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 10, y: 10 }, {});
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
    expect(readCanvasDraft("project-a", "draft_race_user_eric")).not.toBeNull();

    // Second edit while the first is still hanging: queued, draft-only.
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 20, y: 20 }, {});
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });

    // First PUT succeeds. The draft must survive: it is the only copy of the
    // second node until the queued save lands.
    await act(async () => {
      releases[0]();
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
    const midFlight = readCanvasDraft("project-a", "draft_race_user_eric");
    expect(midFlight?.nodes).toHaveLength(2);

    // Once the queued save lands too, nothing is unsaved and the draft goes.
    await act(async () => {
      releases[1]();
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
    expect(readCanvasDraft("project-a", "draft_race_user_eric")).toBeNull();

    hook.unmount();
  });

  // The session only learns about content that has reached `requestSave`. An
  // edit still inside the autosave debounce has already been written to the
  // draft but has no version yet, so "nothing newer is queued" is not enough to
  // conclude the draft is redundant.
  it("keeps the draft for an edit still inside the autosave debounce window", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
    });

    const releases: Array<() => void> = [];
    let revision = 7;
    vi.mocked(putFreezoneCanvas).mockImplementation(() => {
      return new Promise((resolve) => {
        releases.push(() => {
          revision += 1;
          resolve({ saved: true, revision });
        });
      });
    });

    const hook = renderHook(() =>
      useCanvasSync("project-a", "draft_debounce_user_eric"),
    );
    await act(async () => {
      await Promise.resolve();
    });

    // First edit: draft written, PUT on the wire.
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 10, y: 10 }, {});
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
    expect(releases).toHaveLength(1);

    // Second edit: past the 300ms draft debounce, still short of the 800ms
    // autosave debounce. The session has never heard of this content.
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 20, y: 20 }, {});
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(
      readCanvasDraft("project-a", "draft_debounce_user_eric")?.nodes,
    ).toHaveLength(2);

    // The first save lands. It only ever carried one node, so the draft is
    // still the sole copy of the second one.
    await act(async () => {
      releases[0]();
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
    expect(
      readCanvasDraft("project-a", "draft_debounce_user_eric")?.nodes,
    ).toHaveLength(2);

    // Once the debounce elapses and that save lands too, the draft is redundant.
    await act(async () => {
      vi.advanceTimersByTime(500);
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
    await act(async () => {
      releases[1]();
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
    expect(readCanvasDraft("project-a", "draft_debounce_user_eric")).toBeNull();

    hook.unmount();
  });

  it("writes a draft and keepalive PUT on beforeunload when an edit is pending", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
    });

    const hook = renderHook(() =>
      useCanvasSync("project-a", "unload_user_eric"),
    );

    await act(async () => {
      await Promise.resolve();
    });
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 10, y: 10 }, {});

    act(() => {
      window.dispatchEvent(new Event("beforeunload"));
    });

    const draft = readCanvasDraft("project-a", "unload_user_eric");
    expect(draft?.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: CANVAS_NODE_TYPES.upload })]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/projects/project-a/freezone/canvases/unload_user_eric");
    expect(options).toMatchObject({
      method: "PUT",
      credentials: "include",
      keepalive: true,
    });
    expect(JSON.parse(String(options.body))).toMatchObject({
      base_revision: 7,
      save_source: "autosave",
      nodes: expect.arrayContaining([expect.objectContaining({ type: CANVAS_NODE_TYPES.upload })]),
    });

    hook.unmount();
  });

  it("preserves manual-clear intent on the beforeunload keepalive PUT", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [
        {
          id: "server-node",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { imageUrl: "/static/server.png" },
        },
      ],
      edges: [],
      revision: 7,
    });

    const hook = renderHook(() =>
      useCanvasSync("project-a", "unload_clear_user_eric"),
    );

    await act(async () => {
      await Promise.resolve();
    });
    useCanvasStore.getState().clearCanvas();

    act(() => {
      window.dispatchEvent(new Event("beforeunload"));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(payload).toMatchObject({
      save_source: "manual_clear",
      allow_empty_overwrite: true,
      nodes: [],
    });
    expect(readCanvasDraft("project-a", "unload_clear_user_eric")?.mutation).toMatchObject({
      lastMutationSource: "manual_clear",
      pendingClearIntent: true,
    });

    hook.unmount();
  });

  it("clears drafts after successful autosave and backup-pending saves, but keeps them on fatal errors", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
    });
    const hook = renderHook(() =>
      useCanvasSync("project-a", "save_result_user_eric"),
    );
    await act(async () => {
      await Promise.resolve();
    });

    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 1, y: 1 }, {});
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(readCanvasDraft("project-a", "save_result_user_eric")).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(readCanvasDraft("project-a", "save_result_user_eric")).toBeNull();

    vi.mocked(putFreezoneCanvas).mockRejectedValueOnce(
      new ApiError("backup pending", 503, {
        detail: { code: "canvas_backup_pending" },
      }),
    );
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 2, y: 2 }, {});
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(readCanvasDraft("project-a", "save_result_user_eric")).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(readCanvasDraft("project-a", "save_result_user_eric")).toBeNull();

    vi.mocked(putFreezoneCanvas).mockRejectedValueOnce(
      new ApiError("fatal", 500, {}),
    );
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 3, y: 3 }, {});
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(readCanvasDraft("project-a", "save_result_user_eric")).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(readCanvasDraft("project-a", "save_result_user_eric")).not.toBeNull();

    hook.unmount();
  });

  it("drafts and saves shot metadata-only changes", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
      metadata: { preset: { scope: "blank" } },
    });

    const hook = renderHook(() =>
      useCanvasSync("project-a", "metadata_user_eric"),
    );

    await act(async () => {
      await Promise.resolve();
    });
    useShotMetadataStore.getState().setShot({ angle: "low angle" });

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(readCanvasDraft("project-a", "metadata_user_eric")?.metadata).toMatchObject({
      preset: { scope: "blank" },
      shotMetadata: { angle: "low angle" },
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(putFreezoneCanvas).toHaveBeenCalledWith(
      "project-a",
      "metadata_user_eric",
      expect.objectContaining({
        metadata: expect.objectContaining({
          preset: { scope: "blank" },
          shotMetadata: { angle: "low angle" },
        }),
      }),
    );

    hook.unmount();
  });

  it("restores draft history so undo works after draft hydrate", async () => {
    writeCanvasDraft("project-a", "history_user_eric", {
      baseRevision: 7,
      nodes: [
        {
          id: "draft-node",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { imageUrl: "/static/draft.png" },
        },
      ],
      edges: [],
      viewport: null,
      metadata: null,
      history: {
        past: [{ nodes: [], edges: [] }],
        future: [],
      },
      mutation: {
        userEditsSinceHydrate: 1,
        lastMutationSource: "user_edit",
        pendingClearIntent: false,
      },
      updatedAt: Date.now(),
    });
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
    });

    const hook = renderHook(() =>
      useCanvasSync("project-a", "history_user_eric"),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toEqual([]);

    hook.unmount();
  });

  it("continues autosave when localStorage draft writes fail", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
    });
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });

    const hook = renderHook(() =>
      useCanvasSync("project-a", "quota_user_eric"),
    );

    await act(async () => {
      await Promise.resolve();
    });
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 1, y: 1 }, {});

    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });

    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(readCanvasDraft("project-a", "quota_user_eric")).toBeNull();

    hook.unmount();
    setItemSpy.mockRestore();
  });

  it("retries canvas_lock_busy with the same client save id", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
    });
    vi.mocked(putFreezoneCanvas)
      .mockRejectedValueOnce(
        new ApiError("lock busy", 503, {
          detail: { code: "canvas_lock_busy" },
        }),
      )
      .mockResolvedValueOnce({
        saved: true,
        revision: 8,
      });

    const hook = renderHook(() =>
      useCanvasSync("project-a", "lock_busy_user_eric"),
    );

    await act(async () => {
      await Promise.resolve();
    });
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 1, y: 1 }, {});

    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(2);
    const firstPayload = vi.mocked(putFreezoneCanvas).mock.calls[0][2];
    const secondPayload = vi.mocked(putFreezoneCanvas).mock.calls[1][2];
    expect(secondPayload.client_save_id).toBe(firstPayload.client_save_id);
    expect(readCanvasDraft("project-a", "lock_busy_user_eric")).toBeNull();

    hook.unmount();
  });

  it("applies queued preset projections as local edits after hydrate", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
      metadata: {},
    });
    queueLocalFreezoneProjection("project-a", "user_eric", {
      projectionKey: "beat:1:4",
      nodes: [
        {
          id: "projection_group_beat_1_4",
          type: "groupNode",
          position: { x: 0, y: 0 },
          data: { projection_key: "beat:1:4" },
        } as any,
        {
          id: "context_beat",
          type: "beatContextNode",
          parentId: "projection_group_beat_1_4",
          position: { x: 10, y: 10 },
          data: { content: "queued" },
        } as any,
      ],
      edges: [],
      metadata: {
        projections: {
          "beat:1:4": {
            projection_key: "beat:1:4",
            facts_signature: "sig",
          },
        },
        last_projection_key: "beat:1:4",
      },
    });

    const hook = renderHook(() => useCanvasSync("project-a", "user_eric"));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hook.result.current.status).toBe("ready");
    expect(useCanvasStore.getState().nodes.map((node) => node.id)).toContain(
      "projection_beat_1_4__context_beat",
    );
    expect(useCanvasStore.getState().userEditsSinceHydrate).toBeGreaterThan(0);

    await act(async () => {
      vi.advanceTimersByTime(801);
      vi.runOnlyPendingTimers();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(vi.mocked(putFreezoneCanvas).mock.calls[0][2].metadata).toMatchObject({
      projections: {
        "beat:1:4": {
          projection_key: "beat:1:4",
        },
      },
    });

    hook.unmount();
  });

  it("autosaves queued projection metadata when the graph is unchanged", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
      metadata: {
        projections: {
          "beat:1:4": {
            projection_key: "beat:1:4",
            facts_signature: "old",
          },
        },
      },
    });
    queueLocalFreezoneProjection("project-a", "metadata_only_user_eric", {
      projectionKey: "beat:1:4",
      nodes: [],
      edges: [],
      metadata: {
        projections: {
          "beat:1:4": {
            projection_key: "beat:1:4",
            facts_signature: "new",
            request: {
              scope: "beat",
              episode: 1,
              beat: 4,
              primary_slot: "render",
            },
          },
        },
      },
    });

    const hook = renderHook(() =>
      useCanvasSync("project-a", "metadata_only_user_eric"),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hook.result.current.status).toBe("ready");
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(vi.mocked(putFreezoneCanvas).mock.calls[0][2].metadata).toMatchObject({
      projections: {
        "beat:1:4": {
          facts_signature: "new",
          request: {
            scope: "beat",
            episode: 1,
            beat: 4,
            primary_slot: "render",
          },
        },
      },
    });

    hook.unmount();
  });

  it("flushes a projection applied to an already-open canvas without waiting for autosave debounce", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
      metadata: {},
    });

    const hook = renderHook(() => useCanvasSync("project-a", "live_projection_user_eric"));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hook.result.current.status).toBe("ready");
    expect(putFreezoneCanvas).not.toHaveBeenCalled();

    queueLocalFreezoneProjection("project-a", "live_projection_user_eric", {
      projectionKey: "beat:1:4",
      nodes: [
        {
          id: "projection_group_beat_1_4",
          type: "groupNode",
          position: { x: 0, y: 0 },
          data: { projection_key: "beat:1:4" },
        } as any,
      ],
      edges: [],
      metadata: {
        projections: {
          "beat:1:4": {
            projection_key: "beat:1:4",
            facts_signature: "sig",
          },
        },
      },
    });

    act(() => {
      expect(
        consumeQueuedLocalFreezoneProjections("project-a", "live_projection_user_eric"),
      ).toBe(true);
    });

    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(vi.mocked(putFreezoneCanvas).mock.calls[0][2].base_revision).toBe(7);
    expect(vi.mocked(putFreezoneCanvas).mock.calls[0][2].nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "projection_beat_1_4__projection_group_beat_1_4",
        }),
      ]),
    );

    hook.unmount();
  });

  it("does not restore a stale local draft after a projection save then refresh", async () => {
    vi.useFakeTimers();
    const projectedNode = {
      id: "projection_beat_1_4__projection_group_beat_1_4",
      type: "groupNode",
      position: { x: 0, y: 0 },
      data: { projection_key: "beat:1:4" },
    } as any;
    vi.mocked(getFreezoneCanvas)
      .mockResolvedValueOnce({
        nodes: [],
        edges: [],
        revision: 7,
        metadata: {},
      })
      .mockResolvedValueOnce({
        nodes: [projectedNode],
        edges: [],
        revision: 8,
        metadata: {
          projections: {
            "beat:1:4": {
              projection_key: "beat:1:4",
              facts_signature: "sig",
            },
          },
        },
      });
    vi.mocked(putFreezoneCanvas).mockResolvedValueOnce({
      saved: true,
      revision: 8,
    });

    const first = renderHook(() =>
      useCanvasSync("project-a", "projection_refresh_user_eric"),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(first.result.current.status).toBe("ready");

    queueLocalFreezoneProjection("project-a", "projection_refresh_user_eric", {
      projectionKey: "beat:1:4",
      nodes: [
        {
          id: "projection_group_beat_1_4",
          type: "groupNode",
          position: { x: 0, y: 0 },
          data: { projection_key: "beat:1:4" },
        } as any,
      ],
      edges: [],
      metadata: {
        projections: {
          "beat:1:4": {
            projection_key: "beat:1:4",
            facts_signature: "sig",
          },
        },
      },
    });

    act(() => {
      expect(
        consumeQueuedLocalFreezoneProjections(
          "project-a",
          "projection_refresh_user_eric",
        ),
      ).toBe(true);
    });

    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(readCanvasDraft("project-a", "projection_refresh_user_eric")).toBeNull();

    first.unmount();

    const second = renderHook(() =>
      useCanvasSync("project-a", "projection_refresh_user_eric"),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(second.result.current.status).toBe("ready");
    expect(second.result.current.error).toBeNull();
    expect(second.result.current.revision).toBe(8);
    expect(useCanvasStore.getState().nodes).toEqual([
      expect.objectContaining({
        id: projectedNode.id,
        data: expect.objectContaining({ projection_key: "beat:1:4" }),
      }),
    ]);

    second.unmount();
  });

  it("does not write a local draft on browser refresh after projection save is settled", async () => {
    vi.useFakeTimers();
    const projectedNode = {
      id: "projection_beat_1_4__projection_group_beat_1_4",
      type: "groupNode",
      position: { x: 0, y: 0 },
      data: { projection_key: "beat:1:4" },
    } as any;
    vi.mocked(getFreezoneCanvas)
      .mockResolvedValueOnce({
        nodes: [],
        edges: [],
        revision: 7,
        metadata: {},
      })
      .mockResolvedValueOnce({
        nodes: [projectedNode],
        edges: [],
        revision: 8,
        metadata: {
          projections: {
            "beat:1:4": {
              projection_key: "beat:1:4",
              facts_signature: "sig",
              request: { scope: "beat", episode: 1, beat: 4 },
            },
          },
        },
      });
    vi.mocked(putFreezoneCanvas).mockResolvedValueOnce({
      saved: true,
      revision: 8,
    });

    const first = renderHook(() =>
      useCanvasSync("project-a", "projection_beforeunload_user_eric"),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    queueLocalFreezoneProjection("project-a", "projection_beforeunload_user_eric", {
      projectionKey: "beat:1:4",
      nodes: [
        {
          id: "projection_group_beat_1_4",
          type: "groupNode",
          position: { x: 0, y: 0 },
          data: { projection_key: "beat:1:4" },
        } as any,
      ],
      edges: [],
      metadata: {
        projections: {
          "beat:1:4": {
            projection_key: "beat:1:4",
            facts_signature: "sig",
          },
        },
      },
    });

    act(() => {
      expect(
        consumeQueuedLocalFreezoneProjections(
          "project-a",
          "projection_beforeunload_user_eric",
        ),
      ).toBe(true);
    });

    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(readCanvasDraft("project-a", "projection_beforeunload_user_eric")).toBeNull();

    act(() => {
      window.dispatchEvent(new Event("beforeunload"));
    });
    expect(readCanvasDraft("project-a", "projection_beforeunload_user_eric")).toBeNull();

    first.unmount();

    const second = renderHook(() =>
      useCanvasSync("project-a", "projection_beforeunload_user_eric"),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(second.result.current.status).toBe("ready");
    expect(second.result.current.error).toBeNull();
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);

    second.unmount();
  });

  it("does not conflict after moving a saved projection group and refreshing", async () => {
    vi.useFakeTimers();
    const projectionNode = (x: number, y: number) => ({
      id: "projection_beat_1_4__projection_group_beat_1_4",
      type: "groupNode",
      position: { x, y },
      data: { projection_key: "beat:1:4" },
    } as any);
    vi.mocked(getFreezoneCanvas)
      .mockResolvedValueOnce({
        nodes: [],
        edges: [],
        revision: 7,
        metadata: {},
      })
      .mockResolvedValueOnce({
        nodes: [projectionNode(120, 80)],
        edges: [],
        revision: 9,
        metadata: {
          projections: {
            "beat:1:4": {
              projection_key: "beat:1:4",
              facts_signature: "sig",
            },
          },
        },
      });
    vi.mocked(putFreezoneCanvas)
      .mockResolvedValueOnce({ saved: true, revision: 8 })
      .mockResolvedValueOnce({ saved: true, revision: 9 });

    const first = renderHook(() =>
      useCanvasSync("project-a", "projection_move_refresh_user_eric"),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    queueLocalFreezoneProjection("project-a", "projection_move_refresh_user_eric", {
      projectionKey: "beat:1:4",
      nodes: [
        {
          id: "projection_group_beat_1_4",
          type: "groupNode",
          position: { x: 0, y: 0 },
          data: { projection_key: "beat:1:4" },
        } as any,
      ],
      edges: [],
      metadata: {
        projections: {
          "beat:1:4": {
            projection_key: "beat:1:4",
            facts_signature: "sig",
          },
        },
      },
    });

    act(() => {
      expect(
        consumeQueuedLocalFreezoneProjections(
          "project-a",
          "projection_move_refresh_user_eric",
        ),
      ).toBe(true);
    });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);

    act(() => {
      useCanvasStore
        .getState()
        .updateNodePosition(
          "projection_beat_1_4__projection_group_beat_1_4",
          { x: 120, y: 80 },
        );
    });
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(2);
    expect(vi.mocked(putFreezoneCanvas).mock.calls[1][2]).toMatchObject({
      base_revision: 8,
      nodes: [
        expect.objectContaining({
          id: "projection_beat_1_4__projection_group_beat_1_4",
          position: { x: 120, y: 80 },
        }),
      ],
    });

    act(() => {
      window.dispatchEvent(new Event("beforeunload"));
    });
    expect(readCanvasDraft("project-a", "projection_move_refresh_user_eric")).toBeNull();

    first.unmount();

    const second = renderHook(() =>
      useCanvasSync("project-a", "projection_move_refresh_user_eric"),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(second.result.current.status).toBe("ready");
    expect(second.result.current.error).toBeNull();
    expect(useCanvasStore.getState().nodes).toEqual([
      expect.objectContaining({
        id: "projection_beat_1_4__projection_group_beat_1_4",
        position: { x: 120, y: 80 },
      }),
    ]);

    second.unmount();
  });

  it("removes preset projections as local edits through autosave", async () => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [
        {
          id: "projection_group_beat_1_4",
          type: "groupNode",
          position: { x: 0, y: 0 },
          data: { projection_key: "beat:1:4" },
        } as any,
        {
          id: "context_beat",
          type: "beatContextNode",
          parentId: "projection_group_beat_1_4",
          position: { x: 10, y: 10 },
          data: { projection_key: "beat:1:4", content: "queued" },
        } as any,
      ],
      edges: [],
      revision: 7,
      metadata: {
        projections: {
          "beat:1:4": {
            projection_key: "beat:1:4",
            facts_signature: "sig",
          },
        },
        last_projection_key: "beat:1:4",
      },
    });

    const hook = renderHook(() =>
      useCanvasSync("project-a", "remove_projection_user_eric"),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hook.result.current.status).toBe("ready");

    let removed = false;
    await act(async () => {
      removed = removeLocalFreezoneProjection(
        "project-a",
        "remove_projection_user_eric",
        "beat:1:4",
      );
      await Promise.resolve();
    });
    expect(removed).toBe(true);
    expect(useCanvasStore.getState().nodes).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(vi.mocked(putFreezoneCanvas).mock.calls[0][2].metadata).toMatchObject({
      projections: {},
    });

    hook.unmount();
  });
});

describe("trimHistoryForStorage", () => {
  const snap = (id: number) => ({
    nodes: [{ id: `n${id}` }],
    edges: [],
  }) as unknown as Parameters<typeof trimHistoryForStorage>[0]["past"][number];

  it("keeps only the most recent N undo steps", () => {
    const past = Array.from({ length: 50 }, (_, i) => snap(i));
    const trimmed = trimHistoryForStorage({ past, future: [] });
    expect(trimmed.past).toHaveLength(HISTORY_PERSIST_MAX_STEPS);
    // The retained steps are the newest ones (tail of the stack).
    expect(trimmed.past[0]).toBe(past[past.length - HISTORY_PERSIST_MAX_STEPS]);
    expect(trimmed.past[trimmed.past.length - 1]).toBe(past[past.length - 1]);
  });

  it("caps the redo stack too and leaves short stacks intact", () => {
    const future = Array.from({ length: 30 }, (_, i) => snap(i));
    const trimmed = trimHistoryForStorage({ past: [snap(0)], future });
    expect(trimmed.past).toHaveLength(1);
    expect(trimmed.future).toHaveLength(HISTORY_PERSIST_MAX_STEPS);
  });
});
