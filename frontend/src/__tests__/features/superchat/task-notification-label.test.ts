// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";
import { buildChatTaskLabel } from "@/features/superchat/task-notification-label";
import type { TaskState } from "@/task-center/types";

import { zhT } from "../../helpers/i18n-fixtures";

// 真词条表：key 写错、词条漏了都会当场抛，不会静悄悄回显 key。
const t = zhT as unknown as (key: string, options?: Record<string, unknown>) => string;

function task(overrides: Partial<TaskState>): TaskState {
  return {
    task_key: "task:demo",
    task_id: "id-demo",
    task_type: "unknown",
    username: "alice",
    project: "demo",
    project_id: "demo",
    episode: 0,
    beat_num: null,
    scope: null,
    status: "completed",
    progress: 1,
    current_task: "completed",
    result: null,
    error: null,
    logs: [],
    created_at: "",
    updated_at: "",
    completed_at: "",
    ...overrides,
  };
}

describe("buildChatTaskLabel", () => {
  it("uses scene result fields for scene reference tasks", () => {
    expect(
      buildChatTaskLabel(
        task({
          task_type: "scene_reference_asset",
          result: { scene_name: "大学宿舍", kind: "master" },
        }),
        t,
      ),
    ).toBe("大学宿舍主场景参考图");
  });

  it("uses character result fields for portraits", () => {
    expect(
      buildChatTaskLabel(
        task({
          task_type: "character_portrait",
          result: { mode: "portrait", character_name: "苏糖" },
        }),
        t,
      ),
    ).toBe("苏糖肖像");
  });

  it("uses identity result fields for identity images", () => {
    expect(
      buildChatTaskLabel(
        task({
          task_type: "identity_image",
          result: { character_name: "苏糖", identity_name: "大学生" },
        }),
        t,
      ),
    ).toBe("苏糖「大学生」身份图");
  });

  it("falls back to scope when result omits names", () => {
    expect(
      buildChatTaskLabel(
        task({
          task_type: "character_portrait",
          scope: "character:苏糖:identity_portrait:大学生",
          result: {},
        }),
        t,
      ),
    ).toBe("苏糖「大学生」身份肖像");
  });

  it("derives sketch grid labels from result metadata", () => {
    expect(
      buildChatTaskLabel(
        task({
          task_type: "sketch_generation",
          episode: 1,
          result: {
            grid_index: 0,
            total_grids: 2,
            beat_numbers: [1, 2, 3, 4, 5],
          },
        }),
        t,
      ),
    ).toBe("第 1 集草图网格 1/2（Beat 1-5）");
  });

  it("keeps non-contiguous sketch beat ranges readable", () => {
    expect(
      buildChatTaskLabel(
        task({
          task_type: "sketch_generation",
          episode: 1,
          result: {
            grid_index: 1,
            total_grids: 2,
            beat_numbers: [26, 27, 29, 30, 37],
          },
        }),
        t,
      ),
    ).toBe("第 1 集草图网格 2/2（Beat 26-27, 29-30, 37）");
  });
});
