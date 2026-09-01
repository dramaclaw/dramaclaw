// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 工作流视频节点的等价性矩阵：7 个 genMode × 5 个提交端点，外加多结果画册、
// 任务句柄（刷新恢复）与历史刷新回调。
//
// 为什么要单独有这一份：VideoNode 的表单逻辑整体搬进了 `useVideoGenerationForm`
// （与故事板资产板共用）。搬家前后「哪个模式打哪个接口、带什么载荷」是这次重构
// 里最容易悄悄错位的一段——它是一条长 if/else 链，每个分支各自收集上游素材，
// 编译通过、类型正确，但接错端点后端只会给一个 400，本地测试全绿。
//
// 断言一律落在 ops 层的载荷与节点数据上——中间怎么重构都行，这两头必须不变。
//
// 模式覆盖说明：genMode 不是纯粹的受控字段，hook 里有一整套「随上游与模型自动
// 纠正」的 effect。所以这里的用例分两类：
//   - 显式模式（firstFrame / firstLastFrame / allReference）：写进节点数据，
//     并配上不会触发纠正 effect 的模型 + 上游组合；
//   - HappyHorse 三态（imageToVideo / imageReference / videoEdit）：**不写**
//     genMode，交给状态机按上游类型推——那正是线上真实路径。
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  submitFreezoneVideoEdit,
  submitFreezoneVideoGen,
  submitFreezoneVideoI2v,
  submitFreezoneVideoKeyframes,
  submitFreezoneVideoOmniGen,
} from "@/api/ops";
import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { showErrorDialog } from "@/features/canvas/application/errorDialog";
import { useVideoGenerationForm } from "@/features/canvas/nodes/shared/useVideoGenerationForm";
import { useCanvasStore } from "@/stores/canvasStore";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      typeof fallback === "string"
        ? fallback
        : ((fallback as { defaultValue?: string } | undefined)?.defaultValue ?? key),
    i18n: { language: "zh" },
  }),
}));

vi.mock("@/lib/queries/generation-credit-cost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries/generation-credit-cost")>()),
  useGenerationCreditCost: () => ({ data: undefined, error: null }),
}));

vi.mock("@/lib/url-params", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-params")>()),
  readUrl: () => ({ project: "demo-project", canvas: "canvas-9" }),
}));

// 提交序号：每次调用任一端点都 +1，任务 key 因此可辨认（task-1 / task-2 …），
// 「多结果各自等各自的任务」「句柄只留第 1 条」才有东西可断言。
const submits = vi.hoisted(() => ({ seq: 0 }));
// awaitTaskCompletion 执行时节点上的数据快照 —— 任务在途期间的状态只有在这里
// 才看得到（整批结束后 hook 会清掉任务句柄字段）。
const inflight = vi.hoisted(() => ({ snapshots: [] as Record<string, unknown>[] }));

vi.mock("@/api/ops", async (importOriginal) => {
  const nextRef = (taskType: string) => async () => {
    submits.seq += 1;
    return {
      task_key: `task-${submits.seq}`,
      task_type: taskType,
      job_id: `job-${submits.seq}`,
    };
  };
  return {
    ...(await importOriginal<typeof import("@/api/ops")>()),
    fetchFreezoneVideoModels: vi.fn(async () => [
      {
        id: "huimeng/seedance-1.5-pro",
        providerId: "huimeng",
        apiModel: "seedance-1.5-pro",
        label: "Seedance 1.5 Pro",
        catalogId: "catalog-sd1",
      },
      {
        id: "huimeng/seedance-2.0",
        providerId: "huimeng",
        apiModel: "seedance-2.0",
        label: "Seedance 2.0",
        catalogId: "catalog-sd2",
      },
      {
        id: "huimeng/happyhorse-1.0",
        providerId: "huimeng",
        apiModel: "happyhorse-1.0",
        label: "HappyHorse 1.0",
        catalogId: "catalog-hh",
      },
    ]),
    fetchFreezoneVideoCameraTemplates: vi.fn(async () => []),
    listFreezoneGenerationHistory: vi.fn(async () => []),
    submitFreezoneVideoGen: vi.fn(nextRef("freezone_video_gen")),
    submitFreezoneVideoKeyframes: vi.fn(nextRef("freezone_video_keyframes")),
    submitFreezoneVideoI2v: vi.fn(nextRef("freezone_video_i2v")),
    submitFreezoneVideoEdit: vi.fn(nextRef("freezone_video_edit")),
    submitFreezoneVideoOmniGen: vi.fn(nextRef("freezone_video_omni_gen")),
    fetchFreezoneJobResult: vi.fn(async () => ({ url: "/static/fallback.mp4" })),
  };
});

vi.mock("@/api/tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/tasks")>()),
  awaitTaskCompletion: vi.fn(async (taskKey: string) => {
    const { useCanvasStore: store } = await import("@/stores/canvasStore");
    inflight.snapshots.push({
      ...((store.getState().nodes.find((n) => n.id === "vid-1")?.data ?? {}) as Record<
        string,
        unknown
      >),
    });
    // 每个任务回一条与自己 task_key 对应的视频，方便断言画册收齐了几条。
    return { result: { video_url: `/static/${taskKey}.mp4` } };
  }),
}));

vi.mock("@/features/canvas/application/errorDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/canvas/application/errorDialog")>()),
  showErrorDialog: vi.fn(async () => undefined),
}));

const MODEL_SD1 = "huimeng/seedance-1.5-pro";
const MODEL_SD2 = "huimeng/seedance-2.0";
const MODEL_HH = "huimeng/happyhorse-1.0";

function videoNode(data: Record<string, unknown> = {}): CanvasNode {
  return {
    id: "vid-1",
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 },
    data: { prompt: "一只猫跳上桌子", model: MODEL_SD2, ...data },
  } as CanvasNode;
}

function uploadImageNode(id: string, url: string): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.upload,
    position: { x: 0, y: 0 },
    data: { imageUrl: url },
  } as CanvasNode;
}

function upstreamVideoNode(id: string, url: string): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 },
    data: { videoUrl: url, durationMs: 4000 },
  } as CanvasNode;
}

function edge(
  id: string,
  source: string,
  data?: Record<string, unknown>,
): { id: string; source: string; target: string; data?: Record<string, unknown> } {
  return { id, source, target: "vid-1", ...(data ? { data } : {}) };
}

function nodeData(): Record<string, unknown> {
  return (useCanvasStore.getState().nodes.find((n) => n.id === "vid-1")?.data ??
    {}) as Record<string, unknown>;
}

/** 某个端点第 1 次调用时收到的载荷（五个端点各有自己的 payload 类型）。 */
function payloadOf<P>(
  fn: (project: string, payload: P) => unknown,
): Record<string, unknown> | null {
  const calls = vi.mocked(fn).mock.calls;
  return calls.length > 0 ? (calls[0][1] as unknown as Record<string, unknown>) : null;
}

const ALL_ENDPOINTS = [
  submitFreezoneVideoGen,
  submitFreezoneVideoKeyframes,
  submitFreezoneVideoI2v,
  submitFreezoneVideoEdit,
  submitFreezoneVideoOmniGen,
] as const;

/** 除了 `expected` 之外的四个端点都不许被碰过——分派错了必须当场暴露。 */
function expectOnlyEndpointCalled(expected: (typeof ALL_ENDPOINTS)[number]) {
  for (const endpoint of ALL_ENDPOINTS) {
    if (endpoint === expected) {
      expect(vi.mocked(endpoint)).toHaveBeenCalled();
    } else {
      expect(vi.mocked(endpoint)).not.toHaveBeenCalled();
    }
  }
}

/** 挂 hook、等就绪、提交、等落地。 */
async function submitAndSettle(options?: { onGenerationSettled?: () => void }) {
  const { result } = renderHook(() => useVideoGenerationForm("vid-1", options));
  await waitFor(() => {
    expect(result.current.submitDisabled).toBe(false);
  });
  await result.current.submit();
  await waitFor(() => {
    expect(nodeData().isGenerating).toBe(false);
  });
  return result;
}

beforeEach(() => {
  submits.seq = 0;
  inflight.snapshots = [];
  for (const endpoint of ALL_ENDPOINTS) vi.mocked(endpoint).mockClear();
  vi.mocked(showErrorDialog).mockClear();
});

describe("视频节点：genMode → 提交端点的分派", () => {
  it("文生视频 → /video/gen", async () => {
    useCanvasStore.getState().setCanvasData([videoNode({ genMode: "textToVideo" })], []);

    await submitAndSettle();

    expectOnlyEndpointCalled(submitFreezoneVideoGen);
    expect(payloadOf(submitFreezoneVideoGen)).toMatchObject({
      genMode: "textToVideo",
      prompt: "一只猫跳上桌子",
      // 提交给后端的是媒体目录 id，不是前端的展示 id。
      model: "catalog-sd2",
      canvasId: "canvas-9",
      nodeId: "vid-1",
    });
  });

  it("首帧生成视频 → /video/keyframes，只带首帧", async () => {
    // Seedance 1.x：单图首帧是它唯一能走的路径，模式不会被任何纠正 effect 改掉。
    useCanvasStore
      .getState()
      .setCanvasData(
        [
          videoNode({ model: MODEL_SD1, genMode: "firstFrame" }),
          uploadImageNode("img-1", "/static/first.png"),
        ],
        [edge("e1", "img-1")],
      );

    await submitAndSettle();

    expectOnlyEndpointCalled(submitFreezoneVideoKeyframes);
    expect(payloadOf(submitFreezoneVideoKeyframes)).toMatchObject({
      genMode: "firstFrame",
      firstFrameUrl: "/static/first.png",
      // 首帧模式下尾帧必须留空，否则后端会当首尾帧插值任务跑。
      lastFrameUrl: null,
      model: "catalog-sd1",
    });
  });

  it("首尾帧 → /video/keyframes，按连线上的槽位分首尾", async () => {
    useCanvasStore.getState().setCanvasData(
      [
        videoNode({ genMode: "firstLastFrame" }),
        uploadImageNode("img-1", "/static/tail.png"),
        uploadImageNode("img-2", "/static/head.png"),
      ],
      [
        // 故意让「尾帧」那条边排在前面：分槽位靠的是边上的 keyframeSlot，
        // 不是连线顺序。
        edge("e1", "img-1", { keyframeSlot: "last" }),
        edge("e2", "img-2", { keyframeSlot: "first" }),
      ],
    );

    await submitAndSettle();

    expectOnlyEndpointCalled(submitFreezoneVideoKeyframes);
    expect(payloadOf(submitFreezoneVideoKeyframes)).toMatchObject({
      genMode: "firstLastFrame",
      firstFrameUrl: "/static/head.png",
      lastFrameUrl: "/static/tail.png",
    });
  });

  it("图生视频（HappyHorse + 单图上游）→ /video/i2v，1 张图", async () => {
    useCanvasStore
      .getState()
      .setCanvasData(
        [videoNode({ model: MODEL_HH }), uploadImageNode("img-1", "/static/a.png")],
        [edge("e1", "img-1")],
      );

    await submitAndSettle();

    expectOnlyEndpointCalled(submitFreezoneVideoI2v);
    expect(payloadOf(submitFreezoneVideoI2v)).toMatchObject({
      genMode: "imageToVideo",
      imageUrls: ["/static/a.png"],
      model: "catalog-hh",
    });
  });

  it("图片参考（HappyHorse + 多图上游）→ /video/i2v，按连线顺序带多张", async () => {
    useCanvasStore
      .getState()
      .setCanvasData(
        [
          videoNode({ model: MODEL_HH }),
          uploadImageNode("img-1", "/static/a.png"),
          uploadImageNode("img-2", "/static/b.png"),
        ],
        [edge("e1", "img-1"), edge("e2", "img-2")],
      );

    await submitAndSettle();

    expectOnlyEndpointCalled(submitFreezoneVideoI2v);
    expect(payloadOf(submitFreezoneVideoI2v)).toMatchObject({
      // 同一个端点，靠图片张数与 genMode 在后端分流成「图片参考视频」。
      genMode: "imageReference",
      imageUrls: ["/static/a.png", "/static/b.png"],
    });
  });

  it("视频编辑（HappyHorse + 视频上游）→ /video/edit，带源视频", async () => {
    useCanvasStore
      .getState()
      .setCanvasData(
        [
          videoNode({ model: MODEL_HH }),
          upstreamVideoNode("src-1", "/static/source.mp4"),
          uploadImageNode("img-1", "/static/a.png"),
        ],
        [edge("e1", "src-1"), edge("e2", "img-1")],
      );

    await submitAndSettle();

    expectOnlyEndpointCalled(submitFreezoneVideoEdit);
    expect(payloadOf(submitFreezoneVideoEdit)).toMatchObject({
      genMode: "videoEdit",
      videoUrl: "/static/source.mp4",
      imageUrls: ["/static/a.png"],
      model: "catalog-hh",
    });
  });

  it("全能参考（Seedance 2.0 + 图 + 视频）→ /video/omni-gen，按类型归类引用", async () => {
    useCanvasStore
      .getState()
      .setCanvasData(
        [
          videoNode({ genMode: "allReference" }),
          uploadImageNode("img-1", "/static/a.png"),
          upstreamVideoNode("src-1", "/static/source.mp4"),
        ],
        [edge("e1", "img-1"), edge("e2", "src-1")],
      );

    await submitAndSettle();

    expectOnlyEndpointCalled(submitFreezoneVideoOmniGen);
    expect(payloadOf(submitFreezoneVideoOmniGen)).toMatchObject({
      genMode: "allReference",
      references: [
        { type: "image", url: "/static/a.png" },
        { type: "video", url: "/static/source.mp4" },
      ],
      model: "catalog-sd2",
    });
  });

  it("全能参考撞上非 2.0 模型时拦在前端，不发任何请求", async () => {
    // Seedance 1.x 走不了 omni-gen；放过去只会换来一个后端 400。
    useCanvasStore
      .getState()
      .setCanvasData(
        [
          videoNode({ model: MODEL_SD1, genMode: "allReference" }),
          uploadImageNode("img-1", "/static/a.png"),
        ],
        [edge("e1", "img-1")],
      );

    await submitAndSettle();

    for (const endpoint of ALL_ENDPOINTS) {
      expect(vi.mocked(endpoint)).not.toHaveBeenCalled();
    }
    expect(showErrorDialog).toHaveBeenCalled();
    expect(String(vi.mocked(showErrorDialog).mock.calls[0][0])).toContain("Seedance 2.0");
  });
});

describe("视频节点：多结果画册", () => {
  it("生成数量 3 → 并发提交 3 次，三条全落进同一个节点的画册", async () => {
    useCanvasStore
      .getState()
      .setCanvasData([videoNode({ genMode: "textToVideo", count: 3 })], []);

    await submitAndSettle();

    expect(vi.mocked(submitFreezoneVideoGen)).toHaveBeenCalledTimes(3);
    // 不再复制兄弟节点：画布上还是只有这一个视频节点。
    expect(
      useCanvasStore.getState().nodes.filter((n) => n.type === CANVAS_NODE_TYPES.video),
    ).toHaveLength(1);

    const batch = nodeData().generationBatch as string[];
    expect(batch).toHaveLength(3);
    expect([...batch].sort()).toEqual([
      "/static/task-1.mp4",
      "/static/task-2.mp4",
      "/static/task-3.mp4",
    ]);
    // 第 1 条完成的同时成为主视频。
    expect(batch).toContain(nodeData().videoUrl);
  });

  it("单条时不写画册（叠卡 UI 只在多结果下出现）", async () => {
    useCanvasStore
      .getState()
      .setCanvasData([videoNode({ genMode: "textToVideo", count: 1 })], []);

    await submitAndSettle();

    expect(vi.mocked(submitFreezoneVideoGen)).toHaveBeenCalledTimes(1);
    expect(nodeData().generationBatch).toBeNull();
    expect(nodeData().videoUrl).toBe("/static/task-1.mp4");
  });
});

describe("视频节点：恢复与历史", () => {
  it("任务在途期间节点上带着句柄（刷新页面才能续上轮询），落地后清空", async () => {
    useCanvasStore.getState().setCanvasData([videoNode({ genMode: "textToVideo" })], []);

    await submitAndSettle();

    expect(inflight.snapshots).toHaveLength(1);
    expect(inflight.snapshots[0]).toMatchObject({
      generationTaskKey: "task-1",
      generationTaskType: "freezone_video_gen",
      generationTaskJobId: "job-1",
    });
    // 整批结束后句柄必须清掉，否则下次打开画布会去轮询一个早已完成的任务。
    expect(nodeData().generationTaskKey).toBeNull();
  });

  it("多条并发时只持久化第 1 条的句柄（节点上只有一份，不能被后来的覆盖）", async () => {
    useCanvasStore
      .getState()
      .setCanvasData([videoNode({ genMode: "textToVideo", count: 3 })], []);

    await submitAndSettle();

    expect(inflight.snapshots).toHaveLength(3);
    const seen = inflight.snapshots.map((snapshot) => snapshot.generationTaskKey);
    expect(seen).toContain("task-1");
    // task-2 / task-3 一旦出现，说明后续任务把第 1 条的句柄覆盖掉了。
    expect(seen.every((key) => key == null || key === "task-1")).toBe(true);
  });

  it("整批落地后回调宿主刷新历史", async () => {
    useCanvasStore
      .getState()
      .setCanvasData([videoNode({ genMode: "textToVideo", count: 2 })], []);
    const onGenerationSettled = vi.fn();

    await submitAndSettle({ onGenerationSettled });

    await waitFor(() => {
      expect(onGenerationSettled).toHaveBeenCalled();
    });
  });
});
