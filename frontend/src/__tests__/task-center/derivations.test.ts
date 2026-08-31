// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect } from "vitest";
import { sampleTask } from "@/__mocks__/msw/handlers/tasks";
import {
  isTerminal,
  isActive,
  ageMs,
  currentTaskText,
  displayLabel,
  originDeepLink,
} from "@/task-center/derivations";

import { zhT } from "../helpers/i18n-fixtures";

describe("isTerminal", () => {
  it("returns true for completed", () => expect(isTerminal(sampleTask({ status: "completed" }))).toBe(true));
  it("returns true for failed", () => expect(isTerminal(sampleTask({ status: "failed" }))).toBe(true));
  it("returns false for running", () => expect(isTerminal(sampleTask({ status: "running" }))).toBe(false));
  it("returns false for submitting", () => expect(isTerminal(sampleTask({ status: "submitting" }))).toBe(false));
  it("returns false for pending", () => expect(isTerminal(sampleTask({ status: "pending" }))).toBe(false));
  it("returns false for starting", () => expect(isTerminal(sampleTask({ status: "starting" }))).toBe(false));
});

describe("isActive", () => {
  it("returns true for submitting/queued/pending/starting/running", () => {
    expect(isActive(sampleTask({ status: "submitting" }))).toBe(true);
    expect(isActive(sampleTask({ status: "queued" }))).toBe(true);
    expect(isActive(sampleTask({ status: "pending" }))).toBe(true);
    expect(isActive(sampleTask({ status: "starting" }))).toBe(true);
    expect(isActive(sampleTask({ status: "running" }))).toBe(true);
  });
  it("returns false for terminal", () => {
    expect(isActive(sampleTask({ status: "completed" }))).toBe(false);
    expect(isActive(sampleTask({ status: "failed" }))).toBe(false);
  });
});

describe("ageMs", () => {
  it("computes ms since updated_at", () => {
    const task = sampleTask({ updated_at: "2026-04-18T14:33:12Z" });
    const now = new Date("2026-04-18T14:33:42Z").getTime();
    expect(ageMs(task, now)).toBe(30_000);
  });
});

describe("displayLabel", () => {
  // 用真词条表跑：后端那份中文 display_name 只是兜底，界面要显示的是词条里的那条。
  const t = zhT as unknown as (k: string, opts?: Record<string, unknown>) => string;

  it("localizes base task type", () => {
    expect(displayLabel(sampleTask({ task_type: "sketch_regen", episode: 3 }), t)).toBe(
      "草图重生成 · ep3",
    );
  });
  it("rebuilds the label when the backend display name is just the type + episode", () => {
    expect(
      displayLabel(
        sampleTask({
          task_type: "episode_scene_planner",
          episode: 3,
          display_name: "规划场景 · ep3",
        }),
        t,
      ),
    ).toBe("规划场景 · ep3");
  });
  it("keeps a caller-authored display name untouched", () => {
    expect(
      displayLabel(
        sampleTask({
          task_type: "freezone_gen",
          episode: 0,
          display_name: "雨夜巷口 · 第二版",
          display_name_localizable: false,
        }),
        t,
      ),
    ).toBe("雨夜巷口 · 第二版");
  });
  it("composes stage asset labels from metadata", () => {
    expect(
      displayLabel(
        sampleTask({
          task_type: "stage_asset",
          episode: 0,
          display_name: "场景资产 · 皇宫大殿 · 单面转 SOG",
          metadata: { scene_name: "皇宫大殿", step: "single_face_sharp" },
        }),
        t,
      ),
    ).toBe("场景资产 · 皇宫大殿 · 单面转 SOG");
  });
  it("falls back to the backend label for task types with no entry yet", () => {
    expect(
      displayLabel(
        sampleTask({
          task_type: "brand_new_task",
          episode: 0,
          task_type_label: "全新任务",
        }),
        t,
      ),
    ).toBe("全新任务");
  });
  it("appends beat when present", () => {
    expect(displayLabel(sampleTask({ task_type: "single_video", episode: 3, beat_num: 7 }), t)).toBe(
      "单镜视频 · ep3 · beat 7",
    );
  });
  it("appends scope when present", () => {
    expect(displayLabel(sampleTask({ task_type: "sketch_regen", episode: 3, scope: "regen__abc" }), t)).toBe(
      "草图重生成 · ep3 · regen__abc",
    );
  });
  it("hides internal episode asset planner run scopes", () => {
    expect(
      displayLabel(
        sampleTask({
          task_type: "episode_scene_planner",
          episode: 3,
          scope: "scene_run_abc123",
        }),
        t,
      ),
    ).toBe("规划场景 · ep3");
    expect(
      displayLabel(
        sampleTask({
          task_type: "episode_prop_planner",
          episode: 3,
          scope: "prop_run_abc123",
        }),
        t,
      ),
    ).toBe("规划道具 · ep3");
  });
});

describe("currentTaskText", () => {
  const t = zhT as unknown as (k: string, opts?: Record<string, unknown>) => string;

  it("replaces the backend terminal sentinel with the localized status", () => {
    expect(currentTaskText(sampleTask({ status: "completed", current_task: "完成" }), t)).toBe(
      "已完成",
    );
    expect(currentTaskText(sampleTask({ status: "completed", current_task: "done" }), t)).toBe(
      "已完成",
    );
  });
  it("keeps real progress text as the backend sent it", () => {
    expect(
      currentTaskText(sampleTask({ status: "running", current_task: "Writing beats..." }), t),
    ).toBe("Writing beats...");
    expect(
      currentTaskText(sampleTask({ status: "completed", current_task: "生成 12 个 Beat" }), t),
    ).toBe("生成 12 个 Beat");
  });
  it("returns empty for a blank current task", () => {
    expect(currentTaskText(sampleTask({ status: "running", current_task: "" }), t)).toBe("");
  });
});

describe("originDeepLink", () => {
  it("returns route info for sketch-family tasks", () => {
    const link = originDeepLink(sampleTask({ task_type: "sketch_regen", project: "demo", episode: 3 }));
    expect(link).toEqual({
      to: "/projects/$project/episodes/$episode/sketches",
      params: { project: "demo", episode: "3" },
    });
  });
  it("returns null for project-level task types (no episode stage)", () => {
    expect(originDeepLink(sampleTask({ task_type: "build_characters" }))).toBeNull();
  });
  it("returns null for unknown task types", () => {
    expect(originDeepLink(sampleTask({ task_type: "no_such_type_ever" }))).toBeNull();
  });
});
