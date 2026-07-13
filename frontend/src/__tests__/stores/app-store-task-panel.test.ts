// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect, beforeEach } from "vitest";
import {
  useAppStore,
  TASK_PANEL_HEIGHT_MIN,
  TASK_PANEL_HEIGHT_MAX_VH,
  TASK_PANEL_HEIGHT_DEFAULT,
} from "@/stores/app-store";

beforeEach(() => {
  useAppStore.persist.clearStorage();
  useAppStore.setState({ taskPanelOpen: false, taskPanelHeight: TASK_PANEL_HEIGHT_DEFAULT });
});

describe("app-store task panel state", () => {
  it("defaults", () => {
    expect(useAppStore.getState().taskPanelOpen).toBe(false);
    expect(useAppStore.getState().taskPanelHeight).toBe(TASK_PANEL_HEIGHT_DEFAULT);
  });

  it("setTaskPanelOpen toggles", () => {
    useAppStore.getState().setTaskPanelOpen(true);
    expect(useAppStore.getState().taskPanelOpen).toBe(true);
  });

  it("setTaskPanelHeight clamps to min", () => {
    useAppStore.getState().setTaskPanelHeight(50);
    expect(useAppStore.getState().taskPanelHeight).toBe(TASK_PANEL_HEIGHT_MIN);
  });

  it("setTaskPanelHeight clamps to max (70vh of 1000 viewport = 700)", () => {
    Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true });
    useAppStore.getState().setTaskPanelHeight(5000);
    expect(useAppStore.getState().taskPanelHeight).toBe(700);
  });

  it("persist migrate fills missing fields from v0 blob", () => {
    const legacy = {
      sidebarCollapsed: false,
      sidebarWidth: 100,
      language: "zh",
      theme: "system",
      dashboardTab: "active",
    };
    const migrated = useAppStore.persist.getOptions().migrate!(legacy, 0);
    expect(migrated).toMatchObject({
      taskPanelOpen: false,
      taskPanelHeight: TASK_PANEL_HEIGHT_DEFAULT,
    });
    expect(migrated).toMatchObject({ language: "zh", theme: "system" });
    expect(migrated).not.toHaveProperty("sidebarCollapsed");
    expect(migrated).not.toHaveProperty("sidebarWidth");
  });
});

// Touch to silence unused import if TASK_PANEL_HEIGHT_MAX_VH ever becomes unused.
void TASK_PANEL_HEIGHT_MAX_VH;
