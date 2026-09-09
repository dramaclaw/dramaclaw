// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, renderHook } from "@testing-library/react";
import i18next from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sampleTask } from "@/__mocks__/msw/handlers/tasks";
import { useTaskCenterStore } from "@/task-center/store";
import { useTaskActivity } from "@/task-center/use-task-activity";
import type { TaskState } from "@/task-center/types";

import { enTranslation } from "../helpers/i18n-fixtures";

const buildScenes = (overrides: Partial<TaskState> = {}): TaskState =>
  sampleTask({
    task_key: "task:build_scenes:alice:demo:0",
    task_type: "build_scenes",
    episode: 0,
    status: "running",
    progress: 0.4,
    current_task: "抽取场景…",
    ...overrides,
  });

/** 模拟 provider 接管项目：setProject 先发生，补水随后才到。 */
function mountProvider(projectId = "demo") {
  act(() => {
    useTaskCenterStore.getState().setProject(projectId);
  });
}

/** 模拟任务中心补水完成（provider 在首次 GET /tasks 之后做的事）。 */
function hydrateWith(tasks: TaskState[]) {
  act(() => {
    useTaskCenterStore.getState().hydrate(tasks);
    useTaskCenterStore.getState().markHydrated();
  });
}

function render() {
  return renderHook(() => useTaskActivity("build_scenes", { episode: 0 }));
}

beforeEach(() => {
  useTaskCenterStore.getState().reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  useTaskCenterStore.getState().reset();
});

describe("useTaskActivity", () => {
  it("补水完成前报告 isRestoring，此时 isActive 不可信", () => {
    const { result } = render();
    mountProvider();
    // 硬刷新后的初始状态：store 是空的，但那只是还没拉到 /tasks。
    expect(result.current.isRestoring).toBe(true);
    expect(result.current.isActive).toBe(false);

    hydrateWith([buildScenes()]);

    expect(result.current.isRestoring).toBe(false);
    expect(result.current.isActive).toBe(true);
  });

  it("没有 provider 在跑时不报 isRestoring，免得把按钮永久禁死", () => {
    const { result } = render();
    // 组件被渲染在 TaskCenterProvider 之外：补水永远不会到。
    expect(result.current.isRestoring).toBe(false);
    expect(result.current.isActive).toBe(false);
  });

  it("补水后认出后台仍在跑的任务，并带出进度和步骤文案", () => {
    const { result } = render();
    hydrateWith([buildScenes({ progress: 0.4, current_task: "抽取场景…" })]);

    expect(result.current.isActive).toBe(true);
    expect(result.current.progress).toBe(0.4);
    expect(result.current.currentTask).toBe("抽取场景…");
    expect(result.current.task?.task_type).toBe("build_scenes");
  });

  it("步骤文案按 current_task_code 本地化，不透出后端的中文兜底", async () => {
    // review #462：场景构建页直接渲染这一串，之前返回的是 task.current_task，
    // 于是英文界面运行构建任务时会一路显示中文进度。
    i18next.addResourceBundle("en", "translation", enTranslation, true, true);
    await act(async () => {
      await i18next.changeLanguage("en");
    });
    try {
      const { result } = render();
      hydrateWith([
        buildScenes({
          current_task: "从场次头提取基础场景...",
          current_task_code: "tasks.progress.scenes.extractingFromHeadings",
        }),
      ]);

      expect(result.current.currentTask).toBe(
        "Extracting base scenes from scene headings…",
      );
    } finally {
      await act(async () => {
        await i18next.changeLanguage("zh");
      });
    }
  });

  it("后端还没带 code 时照旧回显那句中文，不显示裸 key", () => {
    const { result } = render();
    hydrateWith([buildScenes({ current_task: "抽取场景…" })]);

    expect(result.current.currentTask).toBe("抽取场景…");
  });

  it("忽略别的类型和别的 episode 的任务", () => {
    const { result } = render();
    hydrateWith([
      sampleTask({ task_key: "a", task_type: "build_characters", episode: 0 }),
      buildScenes({ task_key: "b", episode: 3 }),
    ]);

    expect(result.current.isActive).toBe(false);
  });

  it("终态任务不算活跃", () => {
    const { result } = render();
    hydrateWith([buildScenes({ status: "completed", progress: 1 })]);

    expect(result.current.isActive).toBe(false);
  });

  it("markStarted 兜住任务进任务中心前的空窗", () => {
    const { result } = render();
    hydrateWith([]);
    expect(result.current.isActive).toBe(false);

    act(() => result.current.markStarted());
    expect(result.current.isActive).toBe(true);

    // 任务随后从 SSE 进来，接管 loading。
    act(() => {
      useTaskCenterStore.getState().upsert(buildScenes());
    });
    expect(result.current.isActive).toBe(true);
    expect(result.current.task).not.toBeNull();
  });

  it("任务始终没出现时，乐观窗口到点自动收回 loading", () => {
    const { result } = render();
    hydrateWith([]);

    act(() => result.current.markStarted());
    expect(result.current.isActive).toBe(true);

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(result.current.isActive).toBe(false);
  });

  it("SSE 比入队响应先到时，任务跑完立刻收回 loading（不空等 15 秒）", () => {
    const { result } = render();
    hydrateWith([]);

    // 先收到 SSE 推来的任务……
    act(() => {
      useTaskCenterStore.getState().upsert(buildScenes());
    });
    // ……入队接口这时才返回，组件照常调 markStarted()。
    act(() => result.current.markStarted());
    expect(result.current.isActive).toBe(true);

    // 任务完成：活跃任务消失，乐观标记必须一起退场。
    act(() => {
      useTaskCenterStore.getState().upsert(buildScenes({ status: "completed", progress: 1 }));
    });
    expect(result.current.isActive).toBe(false);

    // 即便再推进到超时点，也不该出现回弹。
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(result.current.isActive).toBe(false);
  });

  it("首轮采样就撞上终态时，凭 task_id 立刻收回 loading", () => {
    const { result } = render();
    hydrateWith([]);

    act(() => result.current.markStarted({ taskId: "run-2" }));
    expect(result.current.isActive).toBe(true);

    // 轮询兜底（5s）下任务在两次采样之间跑完：这一轮 GET /tasks 回来时
    // 已经是终态，活跃态从头到尾没被观察到。
    act(() => {
      useTaskCenterStore
        .getState()
        .hydrate([buildScenes({ task_id: "run-2", status: "completed", progress: 1 })]);
    });

    expect(result.current.isActive).toBe(false);
  });

  it("任务入队后立刻失败时，凭 task_id 立刻收回 loading", () => {
    const { result } = render();
    hydrateWith([]);

    act(() => result.current.markStarted({ taskId: "run-2" }));
    act(() => {
      useTaskCenterStore
        .getState()
        .upsert(buildScenes({ task_id: "run-2", status: "failed", error: "boom" }));
    });

    expect(result.current.isActive).toBe(false);
  });

  it("上一轮的旧终态记录不该把新一轮的乐观窗口提前清掉", () => {
    const { result } = render();
    // task_key 跨轮复用，上一轮跑完的记录会在 store 里躺到被 prune 为止。
    hydrateWith([buildScenes({ task_id: "run-1", status: "completed", progress: 1 })]);

    act(() => result.current.markStarted({ taskId: "run-2" }));

    // 新一轮刚入队、任务中心还没更新：loading 必须继续。
    expect(result.current.isActive).toBe(true);
  });

  it("没拿到 task_id 时退回 15 秒兜底，不误伤旧调用方", () => {
    const { result } = render();
    hydrateWith([buildScenes({ task_id: "run-1", status: "completed", progress: 1 })]);

    act(() => result.current.markStarted());
    expect(result.current.isActive).toBe(true);

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(result.current.isActive).toBe(false);
  });

  it("任务正常跑完后收回 loading", () => {
    const { result } = render();
    hydrateWith([buildScenes()]);
    expect(result.current.isActive).toBe(true);

    act(() => {
      useTaskCenterStore.getState().upsert(buildScenes({ status: "completed", progress: 1 }));
    });
    expect(result.current.isActive).toBe(false);
    expect(result.current.progress).toBe(0);
  });
});
