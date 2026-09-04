import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  listFreezoneWorkflowRuns,
  updateFreezoneWorkflowRun,
  type FreezoneWorkflowRun,
} from "@/api/canvas";
import { applyCanvasChatCommandsAsync } from "@/features/freezone/canvasChatCommands";
import {
  recoverableWorkflowNodeIds,
  resumableWorkflowNodeIds,
  staleResumableWorkflowRunIds,
  WorkflowRunRecoveryBar,
} from "@/features/freezone/WorkflowRunRecoveryBar";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";
import { useTaskCenterStore } from "@/task-center/store";

const failedRun: FreezoneWorkflowRun = {
  schema_version: "freezone_workflow_run.v1",
  run_id: "run-failed",
  project_id: "project-a",
  canvas_id: "canvas-a",
  status: "failed",
  resumable: true,
  created_at: "2026-07-21T00:00:00Z",
  started_at: "2026-07-21T00:00:00Z",
  updated_at: "2026-07-21T00:01:00Z",
  actions: [
    { node_id: "image-1", action: "generate_image", status: "completed" },
    { node_id: "video-1", action: "generate_video", status: "failed" },
    { node_id: "compose-1", action: "open_video_compose_modal", status: "blocked" },
  ],
};

vi.mock("@/api/canvas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/canvas")>();
  return {
    ...actual,
    listFreezoneWorkflowRuns: vi.fn(),
    updateFreezoneWorkflowRun: vi.fn(),
  };
});

vi.mock("@/features/freezone/canvasChatCommands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/freezone/canvasChatCommands")>();
  return {
    ...actual,
    applyCanvasChatCommandsAsync: vi.fn(),
  };
});

describe("WorkflowRunRecoveryBar", () => {
  beforeEach(() => {
    useTaskCenterStore.getState().reset();
    useCanvasStore.getState().setCanvasData([
      {
        id: "image-1",
        type: CANVAS_NODE_TYPES.imageGen,
        position: { x: 0, y: 0 },
        data: {},
      },
      {
        id: "video-1",
        type: CANVAS_NODE_TYPES.video,
        position: { x: 400, y: 0 },
        data: {},
      },
      {
        id: "compose-1",
        type: CANVAS_NODE_TYPES.videoCompose,
        position: { x: 800, y: 0 },
        data: {},
      },
    ], []);
    vi.mocked(listFreezoneWorkflowRuns).mockReset();
    vi.mocked(updateFreezoneWorkflowRun).mockReset();
    vi.mocked(applyCanvasChatCommandsAsync).mockReset();
    vi.mocked(listFreezoneWorkflowRuns).mockResolvedValue({ runs: [failedRun] });
    vi.mocked(updateFreezoneWorkflowRun).mockResolvedValue({
      ...failedRun,
      status: "cancelled",
      resumable: false,
    });
    vi.mocked(applyCanvasChatCommandsAsync).mockResolvedValue({
      applied: 1,
      openedUiActions: 2,
      createdNodeIds: [],
      errors: [],
      commandResults: [],
    });
  });

  it("returns only unfinished workflow node ids", () => {
    expect(resumableWorkflowNodeIds(failedRun)).toEqual(["video-1", "compose-1"]);
    expect(recoverableWorkflowNodeIds(
      failedRun,
      new Set(["image-1", "video-1", "compose-1"]),
    )).toEqual(["video-1"]);
  });

  it("does not expose blocked downstream generation as another retry target", () => {
    const runWithBlockedGeneration: FreezoneWorkflowRun = {
      ...failedRun,
      actions: [
        { node_id: "video-1", action: "generate_video", status: "failed" },
        {
          node_id: "compose-1",
          action: "auto_compose_video",
          status: "blocked",
          error: "跳过 auto_compose_video：上游节点 video-1 未成功完成。",
        },
      ],
    };
    expect(recoverableWorkflowNodeIds(
      runWithBlockedGeneration,
      new Set(["video-1", "compose-1"]),
    )).toEqual(["video-1"]);
  });

  it("hides recovery records whose nodes were deleted from the canvas", async () => {
    useCanvasStore.getState().setCanvasData([], []);

    render(<WorkflowRunRecoveryBar projectId="project-a" canvasId="canvas-a" />);

    await waitFor(() => expect(listFreezoneWorkflowRuns).toHaveBeenCalled());
    expect(screen.queryByText("发现未完成的工作流")).not.toBeInTheDocument();
    await waitFor(() => expect(updateFreezoneWorkflowRun).toHaveBeenCalledWith(
      "project-a",
      "canvas-a",
      "run-failed",
      { status: "cancelled" },
    ));
  });

  it("identifies only runs whose unfinished nodes are all gone", () => {
    expect(staleResumableWorkflowRunIds([failedRun], new Set(["video-1"]))).toEqual([]);
    expect(staleResumableWorkflowRunIds([failedRun], new Set())).toEqual(["run-failed"]);
  });

  it("cancels a stale recovery record after its nodes later produce outputs", async () => {
    useCanvasStore.getState().setCanvasData([
      {
        id: "image-1",
        type: CANVAS_NODE_TYPES.imageGen,
        position: { x: 0, y: 0 },
        data: {},
      },
      {
        id: "video-1",
        type: CANVAS_NODE_TYPES.video,
        position: { x: 400, y: 0 },
        data: { videoUrl: "/outputs/video.mp4" },
      },
      {
        id: "compose-1",
        type: CANVAS_NODE_TYPES.videoCompose,
        position: { x: 800, y: 0 },
        data: { resultVideoUrl: "/outputs/final.mp4" },
      },
    ], []);

    render(<WorkflowRunRecoveryBar projectId="project-a" canvasId="canvas-a" />);

    await waitFor(() => expect(listFreezoneWorkflowRuns).toHaveBeenCalled());
    expect(screen.queryByText("发现未完成的工作流")).not.toBeInTheDocument();
    await waitFor(() => expect(updateFreezoneWorkflowRun).toHaveBeenCalledWith(
      "project-a",
      "canvas-a",
      "run-failed",
      { status: "cancelled" },
    ));
  });

  it("recovers a node when only a stale task handle remains", async () => {
    useCanvasStore.getState().setCanvasData([
      {
        id: "image-1",
        type: CANVAS_NODE_TYPES.imageGen,
        position: { x: 0, y: 0 },
        data: {},
      },
      {
        id: "video-1",
        type: CANVAS_NODE_TYPES.video,
        position: { x: 400, y: 0 },
        data: { isGenerating: false, generationTaskKey: "task-video-1" },
      },
      {
        id: "compose-1",
        type: CANVAS_NODE_TYPES.videoCompose,
        position: { x: 800, y: 0 },
        data: {},
      },
    ], []);

    render(<WorkflowRunRecoveryBar projectId="project-a" canvasId="canvas-a" />);

    await waitFor(() => expect(listFreezoneWorkflowRuns).toHaveBeenCalled());
    expect(await screen.findByText("发现未完成的工作流")).toBeInTheDocument();
  });

  it("hides but preserves a run while its generation task is active", async () => {
    useCanvasStore.getState().setCanvasData([
      {
        id: "image-1",
        type: CANVAS_NODE_TYPES.imageGen,
        position: { x: 0, y: 0 },
        data: {},
      },
      {
        id: "video-1",
        type: CANVAS_NODE_TYPES.video,
        position: { x: 400, y: 0 },
        data: { isGenerating: true, generationTaskKey: "task-video-1" },
      },
      {
        id: "compose-1",
        type: CANVAS_NODE_TYPES.videoCompose,
        position: { x: 800, y: 0 },
        data: {},
      },
    ], []);

    render(<WorkflowRunRecoveryBar projectId="project-a" canvasId="canvas-a" />);

    await waitFor(() => expect(listFreezoneWorkflowRuns).toHaveBeenCalled());
    expect(screen.queryByText("发现未完成的工作流")).not.toBeInTheDocument();
    expect(updateFreezoneWorkflowRun).not.toHaveBeenCalled();
  });

  it("does not present a healthy running workflow as recoverable", async () => {
    vi.mocked(listFreezoneWorkflowRuns).mockResolvedValueOnce({
      runs: [{ ...failedRun, status: "running" }],
    });

    render(<WorkflowRunRecoveryBar projectId="project-a" canvasId="canvas-a" />);

    await waitFor(() => expect(listFreezoneWorkflowRuns).toHaveBeenCalled());
    expect(screen.queryByText("发现未完成的工作流")).not.toBeInTheDocument();
  });

  it("reconciles a workflow immediately when its task-center state changes", async () => {
    const trackedRun: FreezoneWorkflowRun = {
      ...failedRun,
      actions: failedRun.actions.map((action) =>
        action.node_id === "video-1"
          ? { ...action, task_key: "task-video-1", status: "running" }
          : action
      ),
    };
    vi.mocked(listFreezoneWorkflowRuns).mockResolvedValue({ runs: [trackedRun] });
    render(<WorkflowRunRecoveryBar projectId="project-a" canvasId="canvas-a" />);
    await waitFor(() => expect(listFreezoneWorkflowRuns).toHaveBeenCalledTimes(1));
    await screen.findByText("发现未完成的工作流");

    act(() => {
      useTaskCenterStore.getState().upsert({
        task_key: "task-video-1",
        task_id: "task-id-1",
        task_type: "freezone_video",
        username: "alice",
        project: "demo",
        project_id: "project-a",
        episode: 0,
        beat_num: null,
        scope: "job-1",
        status: "completed",
        progress: 1,
        current_task: "completed",
        result: { video_url: "/outputs/video.mp4" },
        error: null,
        logs: [],
        created_at: "2026-07-21T00:00:00Z",
        updated_at: "2026-07-21T00:01:00Z",
        completed_at: "2026-07-21T00:01:00Z",
      });
    });

    await waitFor(() => expect(listFreezoneWorkflowRuns).toHaveBeenCalledTimes(2));
  });

  it("requires an explicit click before resuming unfinished nodes", async () => {
    render(<WorkflowRunRecoveryBar projectId="project-a" canvasId="canvas-a" />);

    expect(await screen.findByText("发现未完成的工作流")).toBeInTheDocument();
    expect(applyCanvasChatCommandsAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "继续下游" }));

    await waitFor(() => {
      expect(applyCanvasChatCommandsAsync).toHaveBeenCalledWith(
        [expect.objectContaining({
          commands: [{
            type: "run_workflow",
            node_ids: ["video-1"],
            direction: "downstream",
            regenerate: false,
          }],
        })],
        { projectId: "project-a", canvasId: "canvas-a" },
      );
      expect(updateFreezoneWorkflowRun).not.toHaveBeenCalled();
    });
  });

  it("keeps the old run resumable when a resume attempt cannot start", async () => {
    vi.mocked(applyCanvasChatCommandsAsync).mockResolvedValueOnce({
      applied: 0,
      openedUiActions: 0,
      createdNodeIds: [],
      errors: ["执行启动失败"],
      commandResults: [],
    });
    render(<WorkflowRunRecoveryBar projectId="project-a" canvasId="canvas-a" />);

    fireEvent.click(await screen.findByRole("button", { name: "继续下游" }));

    expect(await screen.findByText("执行启动失败")).toBeInTheDocument();
    expect(updateFreezoneWorkflowRun).not.toHaveBeenCalled();
  });

  it("can retry only failed nodes without running blocked downstream nodes", async () => {
    render(<WorkflowRunRecoveryBar projectId="project-a" canvasId="canvas-a" />);

    fireEvent.click(await screen.findByRole("button", { name: "仅重试失败" }));

    await waitFor(() => {
      expect(applyCanvasChatCommandsAsync).toHaveBeenCalledWith(
        [expect.objectContaining({
          commands: [{
            type: "run_workflow",
            node_ids: ["video-1"],
            direction: "node",
            regenerate: true,
          }],
        })],
        { projectId: "project-a", canvasId: "canvas-a" },
      );
      expect(updateFreezoneWorkflowRun).not.toHaveBeenCalled();
    });
  });
});
