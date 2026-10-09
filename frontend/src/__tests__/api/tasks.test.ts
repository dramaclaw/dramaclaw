import { describe, expect, it, vi } from "vitest";

import {
  awaitTaskCompletion,
  publishTaskState,
  type TaskState,
} from "@/api/tasks";

function taskState(
  taskKey: string,
  status: TaskState["status"],
): TaskState {
  return {
    task_type: "freezone_image",
    task_key: taskKey,
    project_id: "project-a",
    username: "alice",
    project: "demo",
    episode: 0,
    status,
    progress: status === "completed" ? 1 : 0.5,
    current_task: status,
    result: status === "completed" ? { image_url: "/static/image.png" } : null,
  };
}

describe("unified task completion channel", () => {
  it("settles a node waiter from the task-center event without opening another SSE", async () => {
    const eventSource = vi.fn();
    vi.stubGlobal("EventSource", eventSource);
    const waiting = awaitTaskCompletion("task:freezone_image:project:project-a:0:job-1", "project-a");

    publishTaskState(
      taskState("task:freezone_image:project:project-a:0:job-1", "completed"),
    );

    await expect(waiting).resolves.toMatchObject({
      status: "completed",
      result: { image_url: "/static/image.png" },
    });
    expect(eventSource).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("propagates the authoritative task failure to the node waiter", async () => {
    const taskKey = "task:freezone_video:project:project-a:0:job-2";
    const waiting = awaitTaskCompletion(taskKey, "project-a");

    publishTaskState({
      ...taskState(taskKey, "failed"),
      error: "upstream failed",
    });

    await expect(waiting).rejects.toMatchObject({
      message: "upstream failed",
      status: "failed",
      taskKey,
    });
  });
});
