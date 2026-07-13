// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect, beforeEach, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  resetRegionState,
  resetUserSessionState,
} from "@/lib/reset-region-state";
import { useAuthStore } from "@/stores/auth-store";
import { useSaveStatusStore } from "@/stores/save-status-store";
import { useSeenPoolStore } from "@/stores/seen-pool-store";
import { useEpisodeWorkbenchStore } from "@/stores/episode-workbench-store";
import { useTaskCenterStore } from "@/task-center/store";

describe("resetRegionState", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("calls reset() on auth, save-status, seen-pool, episode-workbench, task-center stores", () => {
    const authSpy = vi.spyOn(useAuthStore.getState(), "reset");
    const saveSpy = vi.spyOn(useSaveStatusStore.getState(), "reset");
    const seenSpy = vi.spyOn(useSeenPoolStore.getState(), "reset");
    const workbenchSpy = vi.spyOn(useEpisodeWorkbenchStore.getState(), "reset");
    const taskSpy = vi.spyOn(useTaskCenterStore.getState(), "reset");
    resetRegionState({ queryClient: new QueryClient() });
    expect(authSpy).toHaveBeenCalled();
    expect(saveSpy).toHaveBeenCalled();
    expect(seenSpy).toHaveBeenCalled();
    expect(workbenchSpy).toHaveBeenCalled();
    expect(taskSpy).toHaveBeenCalled();
  });

  it("clears queryClient cache", () => {
    const qc = new QueryClient();
    qc.setQueryData(["x"], { ok: true });
    resetRegionState({ queryClient: qc });
    expect(qc.getQueryData(["x"])).toBeUndefined();
  });

  it("localStorage sweep removes supertale-* and legacy episode workbench keys", () => {
    localStorage.setItem("supertale-auth", JSON.stringify({ state: {} }));
    localStorage.setItem("supertale-seen-pools", "x");
    localStorage.setItem("st.episode.p1.e1.voice", "edge");
    localStorage.setItem("st.beats.toggles.p1.e1", "expanded");
    localStorage.setItem("st.beats.action-panel.sections.p1.e1", "expanded");
    resetRegionState({ queryClient: new QueryClient() });
    expect(localStorage.getItem("supertale-auth")).toBeNull();
    expect(localStorage.getItem("supertale-seen-pools")).toBeNull();
    expect(localStorage.getItem("st.episode.p1.e1.voice")).toBeNull();
    expect(localStorage.getItem("st.beats.toggles.p1.e1")).toBeNull();
    expect(localStorage.getItem("st.beats.action-panel.sections.p1.e1")).toBeNull();
  });

  it("localStorage sweep preserves supertale-app and i18nextLng", () => {
    localStorage.setItem("supertale-app", JSON.stringify({ state: { language: "zh" } }));
    localStorage.setItem("i18nextLng", "zh");
    resetRegionState({ queryClient: new QueryClient() });
    expect(localStorage.getItem("supertale-app")).not.toBeNull();
    expect(localStorage.getItem("i18nextLng")).toBe("zh");
  });
});

describe("resetUserSessionState", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("clears queryClient cache so the next account never sees stale data", () => {
    // 回归用例：手动退出登录只清了 auth store，React Query 缓存原样留在内存里；
    // 换账号登录后 projectSummaries 还在 staleTime 内，B 直接看到 A 的项目列表。
    const qc = new QueryClient();
    qc.setQueryData(["projectSummaries"], ["A 的项目"]);
    resetUserSessionState({ queryClient: qc });
    expect(qc.getQueryData(["projectSummaries"])).toBeUndefined();
  });

  it("sweeps user-scoped localStorage keys like the region reset does", () => {
    localStorage.setItem("supertale-seen-pools", "x");
    localStorage.setItem("st.episode.p1.e1.voice", "edge");
    resetUserSessionState({ queryClient: new QueryClient() });
    expect(localStorage.getItem("supertale-seen-pools")).toBeNull();
    expect(localStorage.getItem("st.episode.p1.e1.voice")).toBeNull();
  });

  it("preserves the region selection — logout must not force a region re-pick", () => {
    localStorage.setItem("supertale-region", JSON.stringify({ state: { selectedRegionId: "cn-1" } }));
    localStorage.setItem("supertale-app", "keep");
    localStorage.setItem("i18nextLng", "zh");
    resetUserSessionState({ queryClient: new QueryClient() });
    expect(localStorage.getItem("supertale-region")).not.toBeNull();
    expect(localStorage.getItem("supertale-app")).toBe("keep");
    expect(localStorage.getItem("i18nextLng")).toBe("zh");
  });

  it("resetRegionState still sweeps the region key (region-switch behavior unchanged)", () => {
    localStorage.setItem("supertale-region", "x");
    resetRegionState({ queryClient: new QueryClient() });
    expect(localStorage.getItem("supertale-region")).toBeNull();
  });
});
