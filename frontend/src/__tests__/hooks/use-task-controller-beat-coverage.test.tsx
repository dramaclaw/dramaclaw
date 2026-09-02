// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 选中 Beats 再生（`sketch_regen` / `selected_regen`）的任务行 `beat_num` 是 None，
 * scope 又是服务端算的 `mode_key__sha1(beats)`，前端无从反推。于是每个 beat 的
 * 草图 / 渲染图面板都用同一个 `taskType|project|episode` 键订阅同一个注册表条目，
 * 一个 beat 在跑，其他 beat 的面板也跟着显示「生成中」。
 *
 * 修法：任务行在 metadata 里带上这次覆盖的 beat 号，controller 把它挂到快照上，
 * 面板按 `covers(beatNum)` 决定要不要显示进度条。共享一条 SSE 流的设计不变。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TaskControllerProvider } from "@/components/episode/task-controller-provider";
import type { Task } from "@/types/task";

const state = vi.hoisted(() => ({
  tasks: [] as Task[],
}));

vi.mock("@/hooks/use-task-stream", () => ({
  useTaskStream: () => ({
    status: "idle" as const,
    progress: 0,
    currentTask: "",
    result: null,
    error: null,
    logs: [],
  }),
}));

vi.mock("@/lib/queries/tasks", () => ({
  useTasks: () => ({ data: { ok: true, data: state.tasks } }),
  useCancelTask: () => ({
    mutateAsync: vi.fn().mockResolvedValue({ ok: true, data: null }),
    isPending: false,
  }),
}));

import { useTaskController } from "@/hooks/use-task-controller";

const KEY = { taskType: "sketch_regen", project: "demo", episode: 1 } as const;

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <TaskControllerProvider project="demo" episode={1}>
        {children}
      </TaskControllerProvider>
    </QueryClientProvider>
  );
}

function renderController() {
  return renderHook(() => useTaskController({ key: { ...KEY } }), {
    wrapper: ({ children }) => wrap(children),
  });
}

function runningRegen(overrides: Partial<Task> = {}): Task {
  return {
    task_type: "sketch_regen",
    username: "u",
    project: "demo",
    episode: 1,
    status: "running",
    progress: 0.2,
    scope: "sketch_1x1__ab12cd34ef56",
    ...overrides,
  };
}

beforeEach(() => {
  state.tasks = [];
});

describe("useTaskController beat coverage", () => {
  it("start() 带上的 beat 号决定哪些面板显示生成中", () => {
    const { result } = renderController();

    act(() => {
      result.current.start({ scope: "sketch_1x1__ab12cd34ef56", beatNumbers: [9] });
    });

    expect(result.current.started).toBe(true);
    expect(result.current.covers(9)).toBe(true);
    // 这一条正是用户看到的 bug：beat 11 没在跑，面板却也转圈。
    expect(result.current.covers(11)).toBe(false);
  });

  it("刷新后从任务行的 metadata.beat_numbers 复原覆盖范围", async () => {
    state.tasks = [runningRegen({ metadata: { beat_numbers: [9] } })];

    const { result } = renderController();

    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.covers(9)).toBe(true);
    expect(result.current.covers(11)).toBe(false);
  });

  it("批量再生覆盖多个 beat 时，这些 beat 都算在跑", async () => {
    state.tasks = [runningRegen({ metadata: { beat_numbers: [9, 10, 12] } })];

    const { result } = renderController();

    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.covers(10)).toBe(true);
    expect(result.current.covers(12)).toBe(true);
    expect(result.current.covers(11)).toBe(false);
  });

  it("任务行没带 beat 号时退回旧行为，不把真在跑的 beat 藏掉", async () => {
    // 老任务行（后端加 metadata 之前入队的）和不认识这个字段的后端都会走到这里。
    state.tasks = [runningRegen()];

    const { result } = renderController();

    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.covers(9)).toBe(true);
    expect(result.current.covers(11)).toBe(true);
  });

  it("同一条任务的 reconcile 不会把已知的 beat 归属抹回未知", async () => {
    // 任务行没带 beat_numbers——后端还没跟上这个字段（比如 dev 机上没重启的旧
    // 进程），或者是这次改动之前入队的老行。
    state.tasks = [runningRegen({ task_id: "t1" })];
    const { result } = renderController();

    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.covers(11)).toBe(true);

    // `start()` 之后 controller 已经知道这次只跑 beat 9。紧接着的那次 reconcile
    // 命中的是同一条任务，任务行沉默不等于「覆盖全部」，不该把已知的归属抹掉。
    act(() => {
      result.current.start({
        scope: "sketch_1x1__ab12cd34ef56",
        taskId: "t1",
        beatNumbers: [9],
      });
    });

    expect(result.current.covers(9)).toBe(true);
    expect(result.current.covers(11)).toBe(false);
  });

  it("同时有两条再生任务时，认 start() 给的那条，不被别人的任务抢走", async () => {
    // 批量面板发的另一条 sketch_regen 排在前面。reconcile 的兜底 find 不看 scope，
    // 先命中的就是它，会把本 beat 的 scope / 覆盖范围整个改指过去。
    state.tasks = [
      runningRegen({ task_id: "t2", scope: "sketch_1x1__ffffffffffff", metadata: { beat_numbers: [5, 6] } }),
      runningRegen({ task_id: "t1", metadata: { beat_numbers: [9] } }),
    ];
    const { result } = renderController();

    act(() => {
      result.current.start({
        scope: "sketch_1x1__ab12cd34ef56",
        taskId: "t1",
        beatNumbers: [9],
      });
    });

    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.covers(9)).toBe(true);
    expect(result.current.covers(5)).toBe(false);
  });

  it("换成另一条任务时不沿用上一次的 beat 归属", async () => {
    // 别的入口（如批量面板）发起的另一条任务，同样没带 beat_numbers。沿用上一次
    // 的 [9] 会把这条任务真在跑的 beat 藏掉，必须退回「覆盖全部」。
    state.tasks = [runningRegen({ task_id: "t2" })];
    const { result } = renderController();

    act(() => {
      result.current.start({
        scope: "sketch_1x1__ab12cd34ef56",
        taskId: "t1",
        beatNumbers: [9],
      });
    });

    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.covers(11)).toBe(true);
  });

  // 用户报的 bug：beat 4 在跑草图，切到 beat 5 「立即生成」是灰的，而且 beat 5
  // 因为 covers() 不命中连进度条都没有——按钮成了没有任何解释的死键。后端本来就
  // 支持并发（每个 selection_scope 是独立的 scope/任务行），所以 key 加 coversBeat
  // 让每个 beat 拿自己的注册表条目，reconcile 也按覆盖范围过滤。
  it("coversBeat 让别的 beat 在跑时本 beat 不被点亮", async () => {
    state.tasks = [runningRegen({ task_id: "t4", metadata: { beat_numbers: [4] } })];

    // 两个面板挂在同一个 provider 下：等 beat 4 那格认领成功，再断言 beat 5 没被带亮。
    // 只断言「一直是 false」会因为初始就是 false 而形同虚设。
    const { result } = renderHook(
      () => ({
        four: useTaskController({ key: { ...KEY, coversBeat: 4 } }),
        five: useTaskController({ key: { ...KEY, coversBeat: 5 } }),
      }),
      { wrapper: ({ children }) => wrap(children) },
    );

    await waitFor(() => expect(result.current.four.started).toBe(true));
    expect(result.current.five.started).toBe(false);
  });

  it("coversBeat 命中的任务行照常认领", async () => {
    state.tasks = [runningRegen({ task_id: "t4", metadata: { beat_numbers: [4] } })];

    const { result } = renderHook(
      () => useTaskController({ key: { ...KEY, coversBeat: 4 } }),
      { wrapper: ({ children }) => wrap(children) },
    );

    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.covers(4)).toBe(true);
  });

  it("覆盖范围未知的任务行仍按命中处理，不把真在跑的 beat 藏掉", async () => {
    state.tasks = [runningRegen({ task_id: "t4" })];

    const { result } = renderHook(
      () => useTaskController({ key: { ...KEY, coversBeat: 5 } }),
      { wrapper: ({ children }) => wrap(children) },
    );

    await waitFor(() => expect(result.current.started).toBe(true));
  });

  it("任务行只带 beat_num 时按单 beat 归属", async () => {
    state.tasks = [
      runningRegen({ task_type: "director_control_to_sketch", beat_num: 9, scope: undefined }),
    ];

    const { result } = renderHook(
      () =>
        useTaskController({
          key: { taskType: "director_control_to_sketch", project: "demo", episode: 1 },
        }),
      { wrapper: ({ children }) => wrap(children) },
    );

    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.covers(9)).toBe(true);
    expect(result.current.covers(11)).toBe(false);
  });
});
