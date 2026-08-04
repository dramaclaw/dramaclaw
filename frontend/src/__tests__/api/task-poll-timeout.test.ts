// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 前端等待预算必须覆盖后端上限：后端重任务（视频 / 图像 / ffmpeg / stage_asset /
// image-to-3gs）最长 30 分钟——见 generators/video_generator.py 的
// NEWAPI_VIDEO_HTTP_TIMEOUT_SECONDS、nanobanana_grid.py 的
// NEWAPI_IMAGE_HTTP_TIMEOUT_SECONDS、freezone/jobs.py 的 _run_cmd(timeout=1800)。
// 共享预算只有 20 分钟，两边不一致时任务还在生成就先弹了「超时」。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  awaitTaskCompletion,
  DEFAULT_MAX_POLL_MS,
  isTaskPollTimeoutError,
  LONG_JOB_MAX_POLL_MS,
  pollTimeoutForTaskType,
  TaskPollTimeoutError,
} from "@/api/tasks";

vi.mock("@/api/client", () => ({
  apiCall: vi.fn(async () => []),
}));

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

beforeEach(() => {
  MockEventSource.instances.length = 0;
  // @ts-expect-error test EventSource replacement
  globalThis.EventSource = MockEventSource;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("task poll timeout budget", () => {
  it("keeps waiting on a long job past the shared 20-minute budget", async () => {
    const settled = vi.fn();
    const promise = awaitTaskCompletion("video-key", "demo", {
      taskType: "freezone_video_generate",
    }).then(settled, settled);

    await advance(DEFAULT_MAX_POLL_MS + 60_000);
    expect(settled).not.toHaveBeenCalled();

    await advance(LONG_JOB_MAX_POLL_MS - DEFAULT_MAX_POLL_MS);
    await promise;

    const error = settled.mock.calls[0][0];
    expect(isTaskPollTimeoutError(error)).toBe(true);
    expect((error as TaskPollTimeoutError).taskKey).toBe("video-key");
    expect((error as TaskPollTimeoutError).waitedMs).toBeGreaterThanOrEqual(
      LONG_JOB_MAX_POLL_MS,
    );
  });

  it("times out short-ceiling tasks on the default budget", async () => {
    const settled = vi.fn();
    const promise = awaitTaskCompletion("translate-key", "demo", {
      taskType: "freezone_text_translate",
    }).then(settled, settled);

    await advance(DEFAULT_MAX_POLL_MS - 60_000);
    expect(settled).not.toHaveBeenCalled();

    await advance(120_000);
    await promise;

    expect(isTaskPollTimeoutError(settled.mock.calls[0][0])).toBe(true);
  });

  it("keeps the default budget for callers that pass no task type", async () => {
    const settled = vi.fn();
    const promise = awaitTaskCompletion("bare-key", "demo").then(
      settled,
      settled,
    );

    await advance(DEFAULT_MAX_POLL_MS + 60_000);
    await promise;

    expect(isTaskPollTimeoutError(settled.mock.calls[0][0])).toBe(true);
  });

  it("covers the backend's 30-minute ceiling for heavy task types", () => {
    expect(LONG_JOB_MAX_POLL_MS).toBeGreaterThan(30 * 60 * 1000);
    for (const taskType of [
      "freezone_video_generate",
      "freezone_video_upscale",
      "freezone_image_generate",
      "freezone_image_upscale",
      "freezone_audio_separate",
      "stage_asset",
    ]) {
      expect(pollTimeoutForTaskType(taskType)).toBe(LONG_JOB_MAX_POLL_MS);
    }
  });

  it("defaults unknown task types to the long budget", () => {
    // 新增的后端任务类型没登记时宁可多等：等久了只是晚一点兜底，
    // 等短了会把还在跑的任务报成失败。
    expect(pollTimeoutForTaskType("freezone_some_new_job")).toBe(
      LONG_JOB_MAX_POLL_MS,
    );
    expect(pollTimeoutForTaskType(null)).toBe(LONG_JOB_MAX_POLL_MS);
  });
});
