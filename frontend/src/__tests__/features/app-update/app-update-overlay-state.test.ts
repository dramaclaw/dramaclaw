// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  nextOverlayState,
  type OverlayState,
} from "@/features/app-update/AppUpdateOverlay";
import type { AppUpdateStatus } from "@/lib/queries/app-update";

function working(overrides: Partial<Extract<OverlayState, { kind: "working" }>> = {}) {
  return {
    kind: "working",
    tag: "v1.0.7",
    label: "starting",
    percent: 0,
    misses: 0,
    ...overrides,
  } satisfies OverlayState;
}

function status(overrides: Partial<AppUpdateStatus> = {}): AppUpdateStatus {
  return {
    mode: "self_update",
    current_version: "1.0.6",
    update_available: true,
    latest_tag: "v1.0.7",
    release_url: null,
    asset_name: null,
    asset_size: null,
    progress: { phase: "idle", percent: 0, error: null, target_tag: null },
    ...overrides,
  };
}

describe("nextOverlayState", () => {
  it("tracks download progress", () => {
    const next = nextOverlayState(working(), {
      ok: true,
      baseline: "1.0.6",
      status: status({
        progress: { phase: "downloading", percent: 42, error: null, target_tag: "v1.0.7" },
      }),
    });
    expect(next).toMatchObject({ kind: "working", label: "downloading", percent: 42 });
  });

  it("switches to installing on launching phase", () => {
    const next = nextOverlayState(working({ label: "downloading", percent: 99 }), {
      ok: true,
      baseline: "1.0.6",
      status: status({
        progress: { phase: "launching", percent: 100, error: null, target_tag: "v1.0.7" },
      }),
    });
    expect(next).toMatchObject({ kind: "working", label: "installing" });
  });

  it("completes when current_version leaves the baseline", () => {
    const next = nextOverlayState(working({ label: "restarting" }), {
      ok: true,
      baseline: "1.0.6",
      status: status({ current_version: "1.0.7" }),
    });
    expect(next).toEqual({ kind: "done", tag: "v1.0.7" });
  });

  it("surfaces backend failure with its error", () => {
    const next = nextOverlayState(working({ label: "downloading" }), {
      ok: true,
      baseline: "1.0.6",
      status: status({
        progress: {
          phase: "failed",
          percent: 10,
          error: "sha256 mismatch",
          target_tag: "v1.0.7",
        },
      }),
    });
    expect(next).toEqual({ kind: "failed", tag: "v1.0.7", error: "sha256 mismatch" });
  });

  it("treats connection loss after installing as a restart", () => {
    const next = nextOverlayState(working({ label: "installing" }), { ok: false });
    expect(next).toMatchObject({ kind: "working", label: "restarting" });
  });

  it("tolerates early blips but fails after repeated misses", () => {
    let state: OverlayState = working({ label: "downloading" });
    for (let i = 0; i < 4; i += 1) {
      state = nextOverlayState(state, { ok: false });
      expect(state.kind).toBe("working");
    }
    state = nextOverlayState(state, { ok: false });
    expect(state).toMatchObject({ kind: "failed", error: "connection lost" });
  });

  it("keeps waiting while the old server idles before download starts", () => {
    const next = nextOverlayState(working(), {
      ok: true,
      baseline: "1.0.6",
      status: status(),
    });
    expect(next).toMatchObject({ kind: "working", label: "starting" });
  });

  it("ignores input once hidden or failed", () => {
    const failed: OverlayState = { kind: "failed", tag: "v1.0.7", error: "x" };
    expect(nextOverlayState(failed, { ok: false })).toBe(failed);
  });
});
