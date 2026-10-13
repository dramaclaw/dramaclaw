// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { featureEntrySeenKey, useFeatureEntrySeen } from "@/lib/feature-entry-state";

describe("feature entry discovery", () => {
  beforeEach(() => localStorage.clear());

  it("starts unseen, syncs subscribers and restores a saved activation on mount", () => {
    const first = renderHook(() => useFeatureEntrySeen("piko-hub-v1", "alice"));
    const second = renderHook(() => useFeatureEntrySeen("piko-hub-v1", "alice"));
    expect(first.result.current.seen).toBe(false);
    act(() => first.result.current.markSeen());
    expect(first.result.current.seen).toBe(true);
    expect(second.result.current.seen).toBe(true);
    first.unmount();
    second.unmount();
    expect(renderHook(() => useFeatureEntrySeen("piko-hub-v1", "alice")).result.current.seen).toBe(true);
  });

  it("keeps accounts and launch versions separate during a session switch", () => {
    const hook = renderHook(
      ({ feature, username }) => useFeatureEntrySeen(feature, username),
      { initialProps: { feature: "piko-hub-v1", username: "alice" } },
    );
    act(() => hook.result.current.markSeen());
    hook.rerender({ feature: "piko-hub-v1", username: "bob" });
    expect(hook.result.current.seen).toBe(false);
    hook.rerender({ feature: "piko-hub-v2", username: "alice" });
    expect(hook.result.current.seen).toBe(false);
    hook.rerender({ feature: "piko-hub-v1", username: "alice" });
    expect(hook.result.current.seen).toBe(true);
  });

  it("updates from another tab and after clearing browser storage", () => {
    const key = featureEntrySeenKey("piko-hub-v1", "alice");
    const hook = renderHook(() => useFeatureEntrySeen("piko-hub-v1", "alice"));
    act(() => {
      localStorage.setItem(key, "seen");
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: "seen" }));
    });
    expect(hook.result.current.seen).toBe(true);
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(hook.result.current.seen).toBe(false);
  });

  it("still dismisses the reminder when local storage is blocked", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => { throw new Error("blocked"); },
    });
    try {
      const hook = renderHook(() => useFeatureEntrySeen("blocked-feature-v1", "alice"));
      expect(hook.result.current.seen).toBe(false);
      act(() => hook.result.current.markSeen());
      expect(hook.result.current.seen).toBe(true);
    } finally {
      Object.defineProperty(window, "localStorage", descriptor);
    }
  });
});
