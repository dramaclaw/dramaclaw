// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import {
  createRouter,
  createRootRoute,
  RouterProvider,
  createMemoryHistory,
} from "@tanstack/react-router";
import { TaskPanel } from "@/components/task-center/panel";
import { useAppStore } from "@/stores/app-store";
import { useTaskCenterStore } from "@/task-center/store";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      en: {
        translation: {
          taskCenter: {
            title: "Task Center",
            panel: {
              close: "Close",
              selectPrompt: "Select a task to see details.",
              filters: { all: "All", running: "Running", failed: "Failed", done: "Done" },
              empty: "No tasks yet.",
              emptyFiltered: "No {{filter}} tasks.",
            },
            detail: {
              tabs: { overview: "Overview", logs: "Logs" },
              meta: {
                status: "Status",
                progress: "Progress",
                createdAt: "Created",
                updatedAt: "Updated",
                completedAt: "Completed",
                taskId: "Task ID",
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

function renderPanel(extra?: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <TaskPanel />
        {extra}
      </>
    ),
  });
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
  useAppStore.setState({ taskPanelOpen: false, taskPanelHeight: 320 });
  useTaskCenterStore.getState().reset();
});

describe("TaskPanel", () => {
  it("keeps the animated panel shell collapsed when taskPanelOpen is false", async () => {
    const { container } = renderPanel();
    await waitFor(() =>
      expect(container.querySelector("[role='region']")).toBeInTheDocument(),
    );
    const region = container.querySelector("[role='region']") as HTMLElement;
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute("aria-hidden", "true");
    expect(region.style.height).toBe("0px");
    const backdrop = screen.getByTestId("task-panel-backdrop");
    expect(backdrop).toHaveClass("invisible", "opacity-0", "pointer-events-none");
    expect(backdrop).toHaveClass("transition-[opacity,visibility]", "motion-reduce:transition-none");
  });

  it("renders list + detail when open", async () => {
    useAppStore.setState({ taskPanelOpen: true });
    renderPanel();
    expect(await screen.findByRole("region", { name: /task center/i })).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: /all/i })).toBeInTheDocument();
    expect(await screen.findByText(/select a task/i)).toBeInTheDocument();
    expect(screen.getByTestId("task-panel-backdrop")).toHaveClass("visible", "opacity-100", "pointer-events-auto");
  });

  it("close button sets taskPanelOpen to false", async () => {
    useAppStore.setState({ taskPanelOpen: true });
    renderPanel();
    const closeBtn = await screen.findByRole("button", { name: /close/i });
    fireEvent.click(closeBtn);
    expect(useAppStore.getState().taskPanelOpen).toBe(false);
    expect(screen.getByTestId("task-panel-backdrop")).toHaveClass("invisible", "opacity-0");
  });

  it("restores the backdrop immediately when reopened during a close transition", async () => {
    useAppStore.setState({ taskPanelOpen: true });
    renderPanel();
    const backdrop = await screen.findByTestId("task-panel-backdrop");
    fireEvent.click(backdrop);
    expect(useAppStore.getState().taskPanelOpen).toBe(false);
    expect(backdrop).toHaveClass("invisible", "pointer-events-none");

    act(() => useAppStore.getState().setTaskPanelOpen(true));
    expect(backdrop).toHaveClass("visible", "opacity-100", "pointer-events-auto");
    expect(backdrop).not.toHaveClass("invisible");
  });

  it("Esc while focus is inside panel closes it", async () => {
    useAppStore.setState({ taskPanelOpen: true });
    renderPanel();
    const closeBtn = await screen.findByRole("button", { name: /close/i });
    closeBtn.focus();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(useAppStore.getState().taskPanelOpen).toBe(false);
  });

  it("Esc while focus is outside panel does NOT close it", async () => {
    useAppStore.setState({ taskPanelOpen: true });
    renderPanel(<input data-testid="outside" />);
    // ensure panel rendered first
    await screen.findByRole("region", { name: /task center/i });
    const input = screen.getByTestId("outside") as HTMLInputElement;
    input.focus();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(useAppStore.getState().taskPanelOpen).toBe(true);
  });

  it("panel height reflects store value", async () => {
    useAppStore.setState({ taskPanelOpen: true, taskPanelHeight: 450 });
    renderPanel();
    const region = await screen.findByRole("region", { name: /task center/i });
    expect((region as HTMLElement).style.height).toBe("450px");
  });
});
