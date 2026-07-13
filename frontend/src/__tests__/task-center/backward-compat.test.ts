// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect } from "vitest";

describe("backward compatibility (AC-6)", () => {
  it("useTaskStream is still exported with expected shape", async () => {
    const mod = await import("@/hooks/use-task-stream");
    expect(typeof mod.useTaskStream).toBe("function");
  });

  it("tasks query hooks remain exported", async () => {
    const mod = await import("@/lib/queries/tasks");
    expect(typeof mod.useTasks).toBe("function");
    expect(typeof mod.useCancelTask).toBe("function");
    expect(typeof mod.useClearCompleted).toBe("function");
    expect(typeof mod.useDeleteTask).toBe("function");
  });

  it("legacy tasks route file exports Route", async () => {
    // path format of TanStack file-based routes after rebase: src/routes/_app/projects.$project/tasks.tsx
    const mod = await import("@/routes/_app/projects.$project/tasks");
    expect(mod.Route).toBeDefined();
  });

  it("app-store retains active cross-region state and task panel fields", async () => {
    const { useAppStore } = await import("@/stores/app-store");
    const state = useAppStore.getState();
    expect(typeof state.language).toBe("string");
    expect(typeof state.theme).toBe("string");
    expect(typeof state.dashboardTab).toBe("string");
    expect(typeof state.setLanguage).toBe("function");
    expect(typeof state.setTheme).toBe("function");
    // Task-center fields added:
    expect(typeof state.taskPanelOpen).toBe("boolean");
    expect(typeof state.taskPanelHeight).toBe("number");
    expect(typeof state.setTaskPanelOpen).toBe("function");
    expect(typeof state.setTaskPanelHeight).toBe("function");
  });
});
