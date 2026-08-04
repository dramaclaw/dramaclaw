// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 等待预算的语义：只有「服务端不再报告这个任务」才算脱离，排队和执行都不消耗
// 预算。后端重任务（视频 / 图像 / ffmpeg / stage_asset / image-to-3gs）执行上限
// 就有 30 分钟（generators/video_generator.py 的 NEWAPI_VIDEO_HTTP_TIMEOUT_SECONDS、
// nanobanana_grid.py 的 NEWAPI_IMAGE_HTTP_TIMEOUT_SECONDS、freezone/jobs.py 的
// _run_cmd(timeout=1800)），线上排队还要另算——按墙钟一刀切必然误杀。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiCall } from "@/api/client";
import type { TaskPollTimeoutError, TaskState } from "@/api/tasks";

vi.mock("@/api/client", () => ({
  apiCall: vi.fn(async () => []),
}));

const listTasksMock = vi.mocked(apiCall);

/** Make the shared poller answer with this task list from now on. */
function serverReports(tasks: Partial<TaskState>[]): void {
  listTasksMock.mockImplementation(async () => tasks as TaskState[]);
}

function task(taskKey: string, status: TaskState["status"]): Partial<TaskState> {
  return { task_key: taskKey, task_type: "freezone_video_generate", status };
}

class MockEventSource {
  static instances: MockEventSource[] = [];
  readyState = 1;
  onerror: ((event: Event) => void) | null = null;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener() {}
  close() {
    this.readyState = 2;
  }
}

/** Drive the 4s shared poller forward without waiting in real time. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

// tasks.ts keeps its pending map / SSE stream / poller in module state, and a
// test that leaves a job pending would otherwise strand the shared poller's
// timer when the fake clock is torn down — the next test's poller sees
// `pollersByProject.has(project)` and never schedules a tick. Reload the module
// per test so every case gets its own monitor.
let tasks: typeof import("@/api/tasks");

beforeEach(async () => {
  MockEventSource.instances.length = 0;
  // @ts-expect-error test EventSource replacement
  globalThis.EventSource = MockEventSource;
  listTasksMock.mockReset();
  serverReports([]);
  vi.useFakeTimers();
  vi.resetModules();
  tasks = await import("@/api/tasks");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("budget is idle-time, not wall-clock", () => {
  it("follows a job that queues 10 minutes and then runs 28", async () => {
    const settled = vi.fn();
    serverReports([task("video-key", "queued")]);
    const promise = tasks.awaitTaskCompletion("video-key", "demo", {
      taskType: "freezone_video_generate",
    }).then(settled, settled);

    // 10 分钟排队 —— 换成旧的墙钟预算，这段时间是从执行预算里扣的。
    await advance(10 * 60 * 1000);
    expect(settled).not.toHaveBeenCalled();

    serverReports([task("video-key", "running")]);
    // 28 分钟执行，加上排队总计 38 分钟 > 35 分钟预算。
    await advance(28 * 60 * 1000);
    expect(settled).not.toHaveBeenCalled();

    serverReports([
      { ...task("video-key", "completed"), result: { output_url: "u" } },
    ]);
    await advance(10_000);
    await promise;

    expect(settled).toHaveBeenCalledTimes(1);
    expect((settled.mock.calls[0][0] as TaskState).status).toBe("completed");
  });

  it("never detaches a job the server keeps reporting as running", async () => {
    const settled = vi.fn();
    serverReports([task("long-key", "running")]);
    void tasks.awaitTaskCompletion("long-key", "demo", {
      taskType: "freezone_video_generate",
    }).then(settled, settled);

    await advance(3 * tasks.LONG_JOB_MAX_POLL_MS);

    expect(settled).not.toHaveBeenCalled();
  });

  it("detaches once the task record goes missing for a whole budget", async () => {
    const settled = vi.fn();
    serverReports([task("gone-key", "running")]);
    const promise = tasks.awaitTaskCompletion("gone-key", "demo", {
      taskType: "freezone_video_generate",
    }).then(settled, settled);

    await advance(5 * 60 * 1000);
    expect(settled).not.toHaveBeenCalled();

    // 任务记录消失（被清理 / 查不到）——这才是前端该收手的信号。
    serverReports([]);
    await advance(tasks.LONG_JOB_MAX_POLL_MS - 60_000);
    expect(settled).not.toHaveBeenCalled();

    await advance(120_000);
    await promise;

    const error = settled.mock.calls[0][0];
    expect(tasks.isTaskPollTimeoutError(error)).toBe(true);
    expect((error as TaskPollTimeoutError).taskKey).toBe("gone-key");
    expect((error as TaskPollTimeoutError).lastStatus).toBe("running");
    // 空转时长按「最后一次听到」算，而不是从提交时算。
    expect((error as TaskPollTimeoutError).idleMs).toBeGreaterThanOrEqual(
      tasks.LONG_JOB_MAX_POLL_MS,
    );
    expect((error as TaskPollTimeoutError).waitedMs).toBeGreaterThan(
      (error as TaskPollTimeoutError).idleMs,
    );
  });

  it("detaches when the task list itself stays unreachable", async () => {
    const settled = vi.fn();
    listTasksMock.mockImplementation(async () => {
      throw new Error("network down");
    });
    const promise = tasks.awaitTaskCompletion("offline-key", "demo", {
      taskType: "freezone_video_generate",
    }).then(settled, settled);

    await advance(tasks.LONG_JOB_MAX_POLL_MS - 60_000);
    expect(settled).not.toHaveBeenCalled();

    serverReports([]);
    await advance(120_000);
    await promise;

    expect(tasks.isTaskPollTimeoutError(settled.mock.calls[0][0])).toBe(true);
  });
});

describe("budget sizing per task type", () => {
  it("times out short-ceiling tasks on the default budget", async () => {
    const settled = vi.fn();
    const promise = tasks.awaitTaskCompletion("translate-key", "demo", {
      taskType: "freezone_text_translate",
    }).then(settled, settled);

    await advance(tasks.DEFAULT_MAX_POLL_MS - 60_000);
    expect(settled).not.toHaveBeenCalled();

    await advance(120_000);
    await promise;

    expect(tasks.isTaskPollTimeoutError(settled.mock.calls[0][0])).toBe(true);
  });

  it("keeps the default budget for callers that pass no task type", async () => {
    const settled = vi.fn();
    const promise = tasks.awaitTaskCompletion("bare-key", "demo").then(
      settled,
      settled,
    );

    await advance(tasks.DEFAULT_MAX_POLL_MS + 60_000);
    await promise;

    expect(tasks.isTaskPollTimeoutError(settled.mock.calls[0][0])).toBe(true);
  });

  it("covers the backend's 30-minute ceiling for heavy task types", () => {
    expect(tasks.LONG_JOB_MAX_POLL_MS).toBeGreaterThan(30 * 60 * 1000);
    for (const taskType of [
      "freezone_video_generate",
      "freezone_video_upscale",
      "freezone_image_generate",
      "freezone_image_upscale",
      "freezone_audio_separate",
      "stage_asset",
    ]) {
      expect(tasks.pollTimeoutForTaskType(taskType)).toBe(tasks.LONG_JOB_MAX_POLL_MS);
    }
  });

  it("defaults unknown task types to the long budget", () => {
    // 新增的后端任务类型没登记时宁可多等：等久了只是晚一点兜底，
    // 等短了会把还在跑的任务报成失败。
    expect(tasks.pollTimeoutForTaskType("freezone_some_new_job")).toBe(
      tasks.LONG_JOB_MAX_POLL_MS,
    );
    expect(tasks.pollTimeoutForTaskType(null)).toBe(tasks.LONG_JOB_MAX_POLL_MS);
  });
});
