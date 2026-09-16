// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 保存被 `canvas_media_scope_mismatch` 拒绝后的自愈闭环：拷素材 → 改节点 → 重试一次。
 * 拷不动时字段置空 + 标失败再重试，绝不把源项目 URL 原样再交一遍（否则死循环）。
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { putFreezoneCanvas, getFreezoneCanvas } from "@/api/canvas";
import { ApiError } from "@/api/client";
import { useCanvasSync } from "@/features/freezone/useCanvasSync";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  clearForeignMediaRefs,
  foreignMediaTargetProject,
  publishForeignMediaRefs,
  readForeignMediaRefsForNode,
} from "@/features/canvas/application/canvasMediaScope";

vi.mock("@/api/canvas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/canvas")>();
  return { ...actual, getFreezoneCanvas: vi.fn(), putFreezoneCanvas: vi.fn() };
});

const copyFreezoneAssets = vi.hoisted(() => vi.fn());
vi.mock("@/api/ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/ops")>();
  return { ...actual, copyFreezoneAssets };
});

vi.mock("@xyflow/react", () => ({ useReactFlow: () => ({ setViewport: vi.fn() }) }));

function lastNodeId(): string {
  const { nodes } = useCanvasStore.getState();
  return nodes[nodes.length - 1].id;
}

const FOREIGN = "/static/projects/projA/freezone/_uploads/a.png";
const COPIED = "/static/projects/project-a/freezone/_uploads/a.png";

function scopeRejection(nodeId: string) {
  return new ApiError("media scope", 422, {
    detail: {
      code: "canvas_media_scope_mismatch",
      project_id: "project-a",
      refs: [
        { node_id: nodeId, field: "imageUrl", url: FOREIGN, source_project_id: "projA" },
      ],
    },
  });
}

async function addForeignNodeAndSave(user: string): Promise<{
  nodeId: string;
  unmount: () => void;
}> {
  const hook = renderHook(() => useCanvasSync("project-a", user));
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.upload, { x: 1, y: 1 }, { imageUrl: FOREIGN });
  });
  const nodeId = lastNodeId();
  vi.mocked(putFreezoneCanvas).mockRejectedValueOnce(scopeRejection(nodeId));
  await act(async () => {
    vi.advanceTimersByTime(800);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return { nodeId, unmount: hook.unmount };
}

describe("useCanvasSync · canvas_media_scope_mismatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockReset();
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
    } as unknown as Awaited<ReturnType<typeof getFreezoneCanvas>>);
    vi.mocked(putFreezoneCanvas).mockReset();
    vi.mocked(putFreezoneCanvas).mockResolvedValue({ saved: true, revision: 8 });
    copyFreezoneAssets.mockReset();
    window.localStorage.clear();
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("copies the asset into this project and retries the save with the new url", async () => {
    copyFreezoneAssets.mockResolvedValue({ mapping: { [FOREIGN]: COPIED }, failed: [] });

    const { nodeId, unmount } = await addForeignNodeAndSave("scope_user_a");

    expect(copyFreezoneAssets).toHaveBeenCalledWith("project-a", [FOREIGN]);
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(2);
    const retried = vi.mocked(putFreezoneCanvas).mock.calls[1][2];
    const node = (retried.nodes as Array<{ id: string; data: Record<string, unknown> }>).find(
      (n) => n.id === nodeId,
    );
    expect(node?.data.imageUrl).toBe(COPIED);
    // store 也得改,否则下一次自动保存又把源项目 URL 交上去。
    expect(
      (useCanvasStore.getState().nodes.find((n) => n.id === nodeId)!.data as { imageUrl: string })
        .imageUrl,
    ).toBe(COPIED);
    unmount();
  });

  it("blanks and marks the node when the copy fails, and still retries once", async () => {
    copyFreezoneAssets.mockResolvedValue({
      mapping: {},
      failed: [{ source: FOREIGN, reason: "forbidden" }],
    });

    const { nodeId, unmount } = await addForeignNodeAndSave("scope_user_b");

    expect(putFreezoneCanvas).toHaveBeenCalledTimes(2);
    const retried = vi.mocked(putFreezoneCanvas).mock.calls[1][2];
    const node = (retried.nodes as Array<{ id: string; data: Record<string, unknown> }>).find(
      (n) => n.id === nodeId,
    );
    expect(node?.data.imageUrl).toBeNull();
    expect(node?.data.assetMigration).toBe("failed");
    unmount();
  });

  it("gives up after one self-heal instead of looping", async () => {
    copyFreezoneAssets.mockResolvedValue({ mapping: { [FOREIGN]: COPIED }, failed: [] });
    // 后端第二次还拒(不该发生):必须停在这里,不能再拷再重试。
    let nodeId = "";
    vi.mocked(putFreezoneCanvas).mockImplementation(async () =>
      Promise.reject(scopeRejection(nodeId)),
    );
    const hook = renderHook(() => useCanvasSync("project-a", "scope_user_c"));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      useCanvasStore
        .getState()
        .addNode(CANVAS_NODE_TYPES.upload, { x: 1, y: 1 }, { imageUrl: FOREIGN });
    });
    nodeId = lastNodeId();

    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // 修复写回 store 会再触发一次自动保存,但保存链路已经进 error 态,不再发请求。
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(putFreezoneCanvas).toHaveBeenCalledTimes(2);
    expect(copyFreezoneAssets).toHaveBeenCalledTimes(1);
    hook.unmount();
  });
});

describe("useCanvasSync · 读取期诊断", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getFreezoneCanvas).mockReset();
    vi.mocked(putFreezoneCanvas).mockReset();
    vi.mocked(putFreezoneCanvas).mockResolvedValue({ saved: true, revision: 8 });
    copyFreezoneAssets.mockReset();
    window.localStorage.clear();
    useCanvasStore.getState().setCanvasData([], []);
    clearForeignMediaRefs();
  });

  it("publishes what the backend reported so the node overlay can explain the 403", async () => {
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
      foreign_media: [
        { node_id: "n1", field: "imageUrl", url: FOREIGN, source_project_id: "projA" },
      ],
    } as unknown as Awaited<ReturnType<typeof getFreezoneCanvas>>);

    const hook = renderHook(() => useCanvasSync("project-a", "diag_user"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readForeignMediaRefsForNode("n1")).toHaveLength(1);
    expect(foreignMediaTargetProject()).toBe("project-a");
    hook.unmount();
  });

  it("drops the previous canvas's diagnostics when a clean canvas loads", async () => {
    publishForeignMediaRefs("project-a", "default", [
      { node_id: "n1", field: "imageUrl", url: FOREIGN, source_project_id: "projA" },
    ]);
    vi.mocked(getFreezoneCanvas).mockResolvedValue({
      nodes: [],
      edges: [],
      revision: 7,
    } as unknown as Awaited<ReturnType<typeof getFreezoneCanvas>>);

    const hook = renderHook(() => useCanvasSync("project-a", "diag_user_clean"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readForeignMediaRefsForNode("n1")).toEqual([]);
    hook.unmount();
  });
});
