// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 配音的任务行按「项目 + 集」复用，同一集上一次的配音任务（已结束）会在 `/tasks`
 * 里留一小时。start() 不带 taskId 时，终态兜底会把那条旧行当成这次的结果，当场
 * 收尾，新任务真正完成后 beats 就不再刷新，面板一直显示没生成。
 *
 * 带上 taskId 后，controller 只认这次的任务行。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

const BEATS_KEY = ["beats", "demo", 1];

function renderAudioController() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const view = renderHook(
    () =>
      useTaskController({
        key: { taskType: "audio_generation_indextts2", project: "demo", episode: 1 },
        invalidateKeys: [BEATS_KEY],
      }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={qc}>
          <TaskControllerProvider project="demo" episode={1}>
            {children}
          </TaskControllerProvider>
        </QueryClientProvider>
      ),
    },
  );
  return { ...view, invalidate };
}

function finishedAudio(taskId: string): Task {
  return {
    task_id: taskId,
    task_type: "audio_generation_indextts2",
    username: "u",
    project: "demo",
    episode: 1,
    status: "completed",
    progress: 1,
  };
}

beforeEach(() => {
  state.tasks = [];
});

describe("useTaskController 与上一次已结束的同类任务", () => {
  it("start() 带 taskId 时，上一次的终态任务行不会让这次提前结束", async () => {
    state.tasks = [finishedAudio("previous-run")];
    const { result, invalidate } = renderAudioController();

    act(() => {
      result.current.start({ taskId: "this-run" });
    });
    await act(async () => {});

    expect(result.current.started).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("这次的任务行结束后才收尾，并刷新 beats", async () => {
    state.tasks = [finishedAudio("previous-run")];
    const { result, rerender, invalidate } = renderAudioController();

    act(() => {
      result.current.start({ taskId: "this-run" });
    });
    state.tasks = [finishedAudio("this-run")];
    rerender();

    await waitFor(() => expect(result.current.started).toBe(false));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: BEATS_KEY });
  });
});
