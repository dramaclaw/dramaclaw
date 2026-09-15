// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import {
  createRouter,
  createRootRoute,
  RouterProvider,
  createMemoryHistory,
} from "@tanstack/react-router";
import { TaskDetail, formatLocalTaskTime } from "@/components/task-center/task-detail";
import { useTaskCenterStore } from "@/task-center/store";
import { sampleTask } from "@/__mocks__/msw/handlers/tasks";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      en: {
        translation: {
          taskCenter: {
            panel: { selectPrompt: "Select a task to see details." },
            detail: {
              tabs: { overview: "Overview", logs: "Logs" },
              meta: {
                status: "Status",
                progress: "Progress",
                createdAt: "Created",
                updatedAt: "Updated",
                completedAt: "Completed",
                taskId: "Task ID",
                providerTaskId: "Provider task ID",
              },
              result: { label: "Result" },
              error: { label: "Error" },
              logs: { placeholder: "No log output yet." },
            },
            status: {
              pending: "Pending",
              running: "Running",
              completed: "Completed",
              failed: "Failed",
            },
            actions: {
              cancel: "Cancel",
              copyId: "Copy task ID",
              downloadLogs: "Download logs",
              openOrigin: "Open origin page",
            },
            toast: { copied: "Task ID copied", canceled: "Canceled {{label}}" },
          },
          tasks: { types: { script_writer: "Script writer" } },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
});

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <TaskDetail /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPendingMs: 0,
  });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useTaskCenterStore.getState().reset();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("TaskDetail", () => {
  it("formats task timestamps as local time with timezone label", () => {
    const formatted = formatLocalTaskTime("2026-06-04T08:01:57Z");

    expect(formatted).toContain("2026");
    expect(formatted).toContain("UTC");
  });

  it("keeps empty and invalid task timestamps stable", () => {
    expect(formatLocalTaskTime("")).toBe("—");
    expect(formatLocalTaskTime("not-a-date")).toBe("not-a-date");
  });

  it("shows select-prompt when nothing selected", async () => {
    const { findByText } = renderDetail();
    expect(await findByText(/select a task/i)).toBeInTheDocument();
  });

  it("renders metadata tab for selected task", async () => {
    useTaskCenterStore.getState().hydrate([
      sampleTask({
        task_id: "task-id-a",
        task_key: "task-key-a",
        status: "running",
        progress: 0.42,
      }),
    ]);
    useTaskCenterStore.getState().setSelected("task-key-a");
    const { findByText } = renderDetail();
    expect(await findByText(/^created$/i)).toBeInTheDocument();
    expect(await findByText("task-id-a")).toBeInTheDocument();
  });

  it("renders error block when task.error present", async () => {
    useTaskCenterStore.getState().hydrate([
      sampleTask({
        task_id: "task-id-f",
        task_key: "task-key-f",
        status: "failed",
        error: "Something broke",
      }),
    ]);
    useTaskCenterStore.getState().setSelected("task-key-f");
    const { findByText } = renderDetail();
    expect(await findByText("Something broke")).toBeInTheDocument();
  });

  it("renders result block when task.result present", async () => {
    useTaskCenterStore.getState().hydrate([
      sampleTask({
        task_id: "task-id-c",
        task_key: "task-key-c",
        status: "completed",
        result: { beats: 42 },
      }),
    ]);
    useTaskCenterStore.getState().setSelected("task-key-c");
    const { findByText } = renderDetail();
    expect(await findByText(/"beats": 42/)).toBeInTheDocument();
  });

  it("hides absolute internal paths in result debug json", async () => {
    useTaskCenterStore.getState().hydrate([
      sampleTask({
        task_id: "task-id-path",
        task_key: "task-key-path",
        status: "completed",
        result: {
          output_path: "/data/output/admin/demo/freezone/_outputs/job.png",
          output_url: "/static/projects/proj/freezone/_outputs/job.png?v=1",
          public_path: "/static/projects/proj/freezone/_outputs/public.png",
          nested: {
            frame_paths: ["/data/output/admin/demo/freezone/_outputs/frame.png"],
          },
          target_path: "director_control_frames/ep001/beat_01/combined.png",
        },
      }),
    ]);
    useTaskCenterStore.getState().setSelected("task-key-path");
    const { findByText, queryByText } = renderDetail();

    expect(await findByText(/static\/projects\/proj/)).toBeInTheDocument();
    expect(await findByText(/public\.png/)).toBeInTheDocument();
    expect(await findByText(/director_control_frames/)).toBeInTheDocument();
    expect(queryByText(/\/data\/output\/admin\/demo/)).not.toBeInTheDocument();
  });

  it("renders provider task id when task result carries one", async () => {
    useTaskCenterStore.getState().hydrate([
      sampleTask({
        task_id: "celery-task-id",
        task_key: "task-key-provider",
        status: "completed",
        result: {
          video_path: "/tmp/out.mp4",
          task_metadata: {
            celery_task_id: "celery-task-id",
            provider_task_id: "194f3bde-d486-49c5-8785-a454d3e2fc13",
          },
        },
      }),
    ]);
    useTaskCenterStore.getState().setSelected("task-key-provider");
    const { findByText } = renderDetail();
    expect(
      await findByText(/Provider task ID: 194f3bde-d486-49c5-8785-a454d3e2fc13/),
    ).toBeInTheDocument();
  });
});

it.each(["svg", "gif"])("keeps %s results consistent with other task JSON results", async (format) => {
  useTaskCenterStore.getState().hydrate([sampleTask({
    task_key: "media", task_type: format === "svg" ? "freezone_image_vectorize" : "freezone_image_animate_gif",
    status: "completed", result: { [format + "_url"]: "/static/projects/p/result." + format },
  })]);
  useTaskCenterStore.getState().setSelected("media");
  const { findByText, queryByRole } = renderDetail();
  expect(await findByText(new RegExp(format + "_url"))).toBeInTheDocument();
  expect(queryByRole("img")).toBeNull();
});
