// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  applyOptimisticWorkflowRunUpdate,
  aggregateChatTaskBatchItems,
  chatTaskBatchStatusSummary,
  chatTaskBatchWaitingItems,
  isStatusBarWorkflowContinuable,
  mergeWorkflowRunUpdate,
  resolveWorkflowRunDisplayCompletion,
  selectChatTaskItems,
  selectChatWorkflowRun,
  selectWorkflowActivityLabels,
  workflowRunStatusPollMs,
  workflowSettledCount,
  workflowStatusCounts,
} from "@/features/superchat/chat-task-status-bar";
import type { FreezoneWorkflowRun } from "@/api/canvas";
import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from "@/features/canvas/domain/canvasNodes";
import type { TaskState } from "@/task-center/types";

const NOW = Date.parse("2026-07-27T08:00:00.000Z");

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    task_key: "task-1",
    task_id: "job-1",
    task_type: "freezone_image",
    username: "local",
    project: "project-1",
    project_id: "project-1",
    episode: 0,
    beat_num: null,
    scope: null,
    status: "running",
    progress: 0.5,
    current_task: "Generating",
    result: null,
    metadata: null,
    error: null,
    logs: [],
    created_at: "2026-07-27T07:59:00.000Z",
    updated_at: "2026-07-27T07:59:30.000Z",
    completed_at: "",
    ...overrides,
  };
}

function node(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: "node-1",
    type: "imageGen",
    position: { x: 0, y: 0 },
    data: {
      displayName: "商品主图",
      generationTaskKey: "task-1",
    },
    ...overrides,
  } as CanvasNode;
}

function workflowRun(overrides: Partial<FreezoneWorkflowRun> = {}): FreezoneWorkflowRun {
  return {
    schema_version: "freezone_workflow_run.v1",
    run_id: "run-1",
    project_id: "project-1",
    canvas_id: "canvas-1",
    status: "running",
    resumable: true,
    created_at: "2026-07-27T07:58:00.000Z",
    started_at: "2026-07-27T07:58:00.000Z",
    updated_at: "2026-07-27T07:59:30.000Z",
    actions: [{
      node_id: "node-1",
      action: "generate_image",
      status: "running",
      phase: "compiling_recipe",
    }],
    ...overrides,
  };
}

describe("selectChatTaskItems", () => {
  it("matches a task through the canvas node generation key", () => {
    const result = selectChatTaskItems([task()], [node()], "canvas-1", NOW);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      nodeId: "node-1",
      nodeLabel: "商品主图",
    });
  });

  it("matches task metadata for the current canvas and excludes another canvas", () => {
    const current = task({
      task_key: "current",
      metadata: { canvas_id: "canvas-1" },
    });
    const other = task({
      task_key: "other",
      metadata: { canvas_id: "canvas-2" },
    });

    const result = selectChatTaskItems([current, other], [], "canvas-1", NOW);

    expect(result.map(({ task: item }) => item.task_key)).toEqual(["current"]);
  });

  it("keeps recent terminal tasks and hides expired terminal tasks", () => {
    const recent = task({
      task_key: "recent",
      status: "completed",
      completed_at: "2026-07-27T07:59:57.000Z",
      metadata: { canvas_id: "canvas-1" },
    });
    const expired = task({
      task_key: "expired",
      status: "failed",
      completed_at: "2026-07-27T07:58:00.000Z",
      metadata: { canvas_id: "canvas-1" },
    });

    const result = selectChatTaskItems([recent, expired], [], "canvas-1", NOW);

    expect(result.map(({ task: item }) => item.task_key)).toEqual(["recent"]);
  });

  it("puts active tasks before recent terminal tasks", () => {
    const completed = task({
      task_key: "completed",
      status: "completed",
      completed_at: "2026-07-27T07:59:58.000Z",
      metadata: { canvas_id: "canvas-1" },
    });
    const running = task({
      task_key: "running",
      updated_at: "2026-07-27T07:59:20.000Z",
      metadata: { canvas_id: "canvas-1" },
    });

    const result = selectChatTaskItems([completed, running], [], "canvas-1", NOW);

    expect(result.map(({ task: item }) => item.task_key)).toEqual([
      "running",
      "completed",
    ]);
  });

  it("shows tasks from every canvas in project scope without stale node links", () => {
    const first = task({
      task_key: "first",
      metadata: { canvas_id: "canvas-1", node_id: "node-1" },
    });
    const second = task({
      task_key: "second",
      metadata: { canvas_id: "canvas-2" },
    });

    const result = selectChatTaskItems(
      [first, second],
      [node()],
      null,
      NOW,
      "project",
    );

    expect(result.map(({ task: item }) => item.task_key)).toEqual(["first", "second"]);
    expect(result.every((item) => item.nodeId === null && item.nodeLabel === null)).toBe(true);
  });

  it("keeps every batch member available for the expanded task details", () => {
    const tasks = [1, 2, 3].map((beat) => task({
      task_key: `frame-${beat}`,
      beat_num: beat,
      metadata: {
        batch_id: "first-frame-batch",
        batch_size: "9",
        canvas_id: "canvas-1",
      },
    }));

    const result = selectChatTaskItems(tasks, [], "canvas-1", NOW);

    expect(result.map(({ task: item }) => item.task_key)).toEqual([
      "frame-1",
      "frame-2",
      "frame-3",
    ]);
  });

  it("collapses queued tasks with the same batch id into one status item", () => {
    const first = task({
      task_key: "grid-1",
      progress: 1,
      status: "completed",
      metadata: { batch_id: "sketch-batch-1", batch_size: "2" },
    });
    const second = task({
      task_key: "grid-2",
      progress: 0.5,
      status: "running",
      metadata: { batch_id: "sketch-batch-1", batch_size: "2" },
    });

    const result = aggregateChatTaskBatchItems([
      { task: first, nodeId: null, nodeLabel: null },
      { task: second, nodeId: null, nodeLabel: null },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].task).toMatchObject({
      status: "running",
      progress: 0.75,
      current_task: "批次进度 1/2 · 运行 1",
    });
  });

  it("shows submitted and waiting counts for a partially admitted agent batch", () => {
    const items = [1, 2, 3].map((beat) => ({
      task: task({
        task_key: `frame-${beat}`,
        status: "running",
        metadata: { batch_id: "first-frame-batch", batch_size: "9" },
      }),
      nodeId: null,
      nodeLabel: null,
    }));

    const result = aggregateChatTaskBatchItems(items);

    expect(result).toHaveLength(1);
    expect(result[0].task.current_task).toBe("批次进度 0/9 · 运行 3 · 等待 6");
    expect(chatTaskBatchStatusSummary(result)).toBe(
      "批次进度 0/9 · 运行 3 · 等待 6",
    );
    expect(chatTaskBatchWaitingItems(items)).toMatchObject([{
      batchId: "first-frame-batch",
      expected: 9,
      waiting: 6,
    }]);
  });

  it("does not add a waiting summary after every batch item has entered the task list", () => {
    const items = [1, 2, 3].map((beat) => ({
      task: task({
        task_key: `video-${beat}`,
        status: beat === 3 ? "queued" : "running",
        metadata: { batch_id: "video-batch", batch_size: "3" },
      }),
      nodeId: null,
      nodeLabel: null,
    }));

    expect(chatTaskBatchWaitingItems(items)).toEqual([]);
  });
});

describe("selectChatWorkflowRun", () => {
  it("prefers an active workflow over a newer completed workflow", () => {
    const active = workflowRun({ run_id: "active" });
    const completed = workflowRun({
      run_id: "completed",
      status: "completed",
      updated_at: "2026-07-27T07:59:50.000Z",
      completed_at: "2026-07-27T07:59:50.000Z",
    });

    expect(selectChatWorkflowRun([completed, active], NOW)?.run_id).toBe("active");
  });

  it("hides terminal workflows after the recent-result window", () => {
    const expired = workflowRun({
      status: "completed",
      completed_at: "2026-07-27T07:58:00.000Z",
    });

    expect(selectChatWorkflowRun([expired], NOW)).toBeNull();
  });

  it("hides a successful workflow shortly after completion", () => {
    const completed = workflowRun({
      status: "completed",
      resumable: false,
      completed_at: "2026-07-27T07:59:54.000Z",
    });

    expect(selectChatWorkflowRun([completed], NOW)).toBeNull();
  });

  it("keeps an old resumable interrupted workflow visible", () => {
    const interrupted = workflowRun({
      status: "interrupted",
      resumable: true,
      updated_at: "2026-07-27T07:00:00.000Z",
      completed_at: "2026-07-27T07:00:00.000Z",
    });

    expect(selectChatWorkflowRun([interrupted], NOW)?.run_id).toBe("run-1");
  });
});

describe("workflowRunStatusPollMs", () => {
  it("polls actively only while a workflow is running", () => {
    expect(workflowRunStatusPollMs([workflowRun()])).toBe(5_000);
  });

  it("keeps a low-frequency idle poll for cross-tab workflow starts", () => {
    expect(workflowRunStatusPollMs([
      workflowRun({
        status: "completed",
        resumable: false,
      }),
    ])).toBe(60_000);
    expect(workflowRunStatusPollMs([])).toBe(60_000);
  });
});

describe("isStatusBarWorkflowContinuable", () => {
  it("allows failed and interrupted resumable workflows", () => {
    expect(isStatusBarWorkflowContinuable(workflowRun({
      status: "failed",
      resumable: true,
    }))).toBe(true);
    expect(isStatusBarWorkflowContinuable(workflowRun({
      status: "interrupted",
      resumable: true,
    }))).toBe(true);
  });

  it("does not offer continuation for running, completed, or non-resumable runs", () => {
    expect(isStatusBarWorkflowContinuable(workflowRun())).toBe(false);
    expect(isStatusBarWorkflowContinuable(workflowRun({
      status: "completed",
      resumable: false,
    }))).toBe(false);
    expect(isStatusBarWorkflowContinuable(workflowRun({
      status: "failed",
      resumable: false,
    }))).toBe(false);
  });
});

describe("resolveWorkflowRunDisplayCompletion", () => {
  it("presents a running workflow as complete when its last verified result is ready", () => {
    const run = workflowRun({
      actions: [
        { node_id: "done", action: "generate_video", status: "completed" },
        { node_id: "compose", action: "auto_compose_video", status: "running" },
      ],
    });

    const resolved = resolveWorkflowRunDisplayCompletion(
      run,
      (nodeId) => nodeId === "compose",
      "2026-07-27T08:00:00.000Z",
    );

    expect(resolved?.status).toBe("completed");
    expect(resolved?.actions.map((action) => action.status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  it("keeps running when the visible result is not verified for this workflow", () => {
    const run = workflowRun({
      actions: [{
        node_id: "compose",
        action: "auto_compose_video",
        status: "running",
      }],
    });

    expect(resolveWorkflowRunDisplayCompletion(run, () => false)).toBe(run);
  });

  it("presents a cancelled recovery run as complete when its fresh result exists", () => {
    const run = workflowRun({
      status: "cancelled",
      resumable: false,
      actions: [{
        node_id: "compose",
        action: "auto_compose_video",
        status: "skipped",
      }],
    });

    const resolved = resolveWorkflowRunDisplayCompletion(
      run,
      (nodeId) => nodeId === "compose",
      "2026-07-27T08:00:00.000Z",
    );

    expect(resolved?.status).toBe("completed");
    expect(resolved?.actions[0]?.status).toBe("completed");
  });

  it("keeps a failed workflow failed when any required result is missing", () => {
    const run = workflowRun({
      status: "failed",
      actions: [
        { node_id: "video", action: "generate_video", status: "completed" },
        { node_id: "compose", action: "auto_compose_video", status: "blocked" },
      ],
    });

    expect(resolveWorkflowRunDisplayCompletion(
      run,
      (nodeId) => nodeId === "video",
    )).toBe(run);
  });
});

describe("applyOptimisticWorkflowRunUpdate", () => {
  it("settles one action immediately without waiting for its parallel peer", () => {
    const run = workflowRun({
      actions: [
        {
          node_id: "node-1",
          action: "generate_image",
          status: "running",
          phase: "generating",
        },
        {
          node_id: "node-2",
          action: "generate_image",
          status: "running",
          phase: "generating",
        },
      ],
    });

    const updated = applyOptimisticWorkflowRunUpdate(run, {
      projectId: "project-1",
      canvasId: "canvas-1",
      runId: "run-1",
      actionUpdates: [{
        node_id: "node-1",
        action: "generate_image",
        status: "completed",
      }],
    }, "2026-07-27T08:00:00.000Z");

    expect(updated.actions.map((action) => action.status)).toEqual([
      "completed",
      "running",
    ]);
    expect(workflowStatusCounts(updated.actions)).toMatchObject({
      completed: 1,
      inProgress: 1,
    });
  });

  it("does not let an older server phase regress an optimistically settled action", () => {
    const completed = workflowRun({
      actions: [{
        node_id: "node-1",
        action: "generate_image",
        status: "completed",
      }],
    });
    const stale = workflowRun({
      updated_at: "2026-07-27T08:00:01.000Z",
      actions: [{
        node_id: "node-1",
        action: "generate_image",
        status: "running",
        phase: "generating",
      }],
    });

    expect(mergeWorkflowRunUpdate(completed, stale).actions[0]?.status).toBe("completed");
  });
});

describe("workflowStatusCounts", () => {
  it("separates active, waiting and failed actions without counting skipped as completed", () => {
    const actions: FreezoneWorkflowRun["actions"] = [
      { node_id: "done", action: "generate_text", status: "completed" },
      {
        node_id: "compile",
        action: "generate_image",
        status: "running",
        phase: "compiling_recipe",
      },
      {
        node_id: "capacity",
        action: "generate_video",
        status: "running",
        phase: "waiting_capacity",
      },
      {
        node_id: "pending",
        action: "generate_audio",
        status: "pending",
        phase: "waiting_dependencies",
      },
      { node_id: "failed", action: "generate_video", status: "failed" },
      { node_id: "skipped", action: "generate_audio", status: "skipped" },
    ];

    expect(workflowStatusCounts(actions)).toEqual({
      completed: 1,
      skipped: 1,
      inProgress: 1,
      waiting: 2,
      failed: 1,
    });
    expect(workflowSettledCount(actions)).toBe(2);
  });

  it("uses live task state instead of treating queued generation as running", () => {
    const actions: FreezoneWorkflowRun["actions"] = [
      {
        node_id: "queued-node",
        action: "generate_video",
        status: "running",
        phase: "generating",
        task_key: "queued-task",
      },
      {
        node_id: "running-node",
        action: "generate_video",
        status: "running",
        phase: "generating",
        task_key: "running-task",
      },
    ];
    const tasks = new Map([
      ["queued-task", task({ task_key: "queued-task", status: "queued" })],
      ["running-task", task({ task_key: "running-task", status: "running" })],
    ]);

    expect(workflowStatusCounts(actions, tasks)).toMatchObject({
      inProgress: 1,
      waiting: 1,
    });
  });
});

describe("selectWorkflowActivityLabels", () => {
  it("returns active node names and excludes actions that are still waiting", () => {
    const actions: FreezoneWorkflowRun["actions"] = [
      {
        node_id: "node-1",
        action: "generate_image",
        status: "running",
        phase: "generating",
      },
      {
        node_id: "node-2",
        action: "generate_video",
        status: "running",
        phase: "waiting_capacity",
      },
    ];

    expect(selectWorkflowActivityLabels(
      actions,
      [
        node(),
        node({
          id: "node-2",
          type: CANVAS_NODE_TYPES.video,
          data: { displayName: "等待中的视频" },
        }),
      ],
      (label, phase) => `${phase}:${label}`,
    )).toEqual(["generating:商品主图"]);
  });

  it("uses a running task linked by the persisted workflow task key after refresh", () => {
    const actions: FreezoneWorkflowRun["actions"] = [
      {
        node_id: "node-1",
        action: "generate_image",
        status: "running",
        phase: "waiting_capacity",
        task_key: "running-after-refresh",
      },
    ];
    const tasks = new Map([
      [
        "running-after-refresh",
        task({
          task_key: "running-after-refresh",
          status: "running",
          metadata: null,
        }),
      ],
    ]);

    expect(selectWorkflowActivityLabels(
      actions,
      [node({ data: { displayName: "刷新后仍在生成" } })],
      (label, phase) => `${phase}:${label}`,
      tasks,
    )).toEqual(["waiting_capacity:刷新后仍在生成"]);
    expect(workflowStatusCounts(actions, tasks)).toMatchObject({
      inProgress: 1,
      waiting: 0,
    });
  });
});
