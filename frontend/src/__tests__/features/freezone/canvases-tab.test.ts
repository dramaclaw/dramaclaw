// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FreezoneCanvasSummary } from "@/api/canvas";
import * as freezoneShellModule from "@/features/freezone/FreezoneShell";
import {
  buildCanvasBrowserSections,
  canDeleteCanvasSummary,
  canvasCreationQuotaStatus,
  canvasKindFromSummary,
  countCanvasesCreatedBy,
  findDuplicateCanvasName,
  userCreatedCanvasId,
} from "@/features/freezone/CanvasesTab";
import { MAX_USER_CREATED_CANVASES_PER_PROJECT } from "@/lib/limits";
import {
  hasLegacyPresetCanvasMetadata,
  nodeDataPatchAfterCommittedTarget,
  nodeDataPatchAfterCommittedSourceSlot,
  requestFromProjectionMetadata,
  resolveSubmitNodeData,
  shouldClearProjectionStatuses,
  shouldFetchProjectionStatuses,
  shouldRefreshCommittedTargetNodes,
  shouldSkipProjectionStatusRevision,
} from "@/features/freezone/FreezoneShell";
import {
  buildConflictCopyCanvasId,
  buildConflictCopyMetadata,
  saveErrorStatusAndBody,
  shouldAbortBestEffortPresetRefresh,
  shouldDeferPresetRefreshUntilReady,
  shouldFlushBeforePresetRefresh,
} from "@/features/freezone/useCanvasSync";
import { BackendStatusError } from "@/lib/api-errors";

afterEach(() => {
  vi.useRealTimers();
});

function canvas(
  id: string,
  canvas_scope?: string,
  modified_at = "2026-06-03T00:00:00Z",
  extra: Partial<FreezoneCanvasSummary> = {},
): FreezoneCanvasSummary {
  return {
    id,
    canvas_scope,
    modified_at,
    size: 1,
    ...extra,
  };
}

describe("freezone canvas browser sections", () => {
  it("places my canvas first and keeps old canvases under other canvases", () => {
    const sections = buildCanvasBrowserSections(
      [
        canvas("ep1_beat1", "beat", "2026-06-03T10:00:00Z", { episode: 1, beat: 1 }),
        canvas("ep1_beat2", "beat", "2026-06-03T11:00:00Z", { episode: 1, beat: 2 }),
        canvas("ep2_beat1", "beat", "2026-06-03T12:00:00Z", { episode: 2, beat: 1 }),
        canvas("asset_1", "asset", "2026-06-03T13:00:00Z"),
        canvas("default", "default", "2026-06-01T00:00:00Z"),
      ],
      "default",
      "eric@example.com",
    );

    expect(sections.defaultCanvas.id).toBe("user_eric_example_com_1m9fjbn");
    expect(sections.defaultCanvas.displayName).toBe("eric@example.com");
    expect(sections.memberCanvases).toEqual([]);
    expect(sections.otherCanvases.map((item) => item.id)).toEqual([
      "asset_1",
      "ep2_beat1",
      "ep1_beat2",
      "ep1_beat1",
      "default",
    ]);
  });

  it("separates member canvases from old and scratch canvases", () => {
    const sections = buildCanvasBrowserSections(
      [
        canvas("default", "default"),
        canvas("user_eric_example_com_1m9fjbn", undefined, "2026-06-03T13:00:00Z"),
        canvas("user_director_example_com_abc123", undefined, "2026-06-03T12:00:00Z"),
        canvas("asset_1", "asset", "2026-06-03T11:00:00Z"),
        canvas("scratch", "blank", "2026-06-03T10:00:00Z"),
        canvas("ep1_beat1", "beat", "2026-06-03T09:00:00Z", { episode: 1, beat: 1 }),
      ],
      "default",
      "eric@example.com",
    );

    expect(sections.defaultCanvas.id).toBe("user_eric_example_com_1m9fjbn");
    expect(sections.memberCanvases.map((item) => item.id)).toEqual(["user_director_example_com_abc123"]);
    expect(sections.otherCanvases.map((item) => item.id)).toEqual([
      "asset_1",
      "scratch",
      "ep1_beat1",
      "default",
    ]);
  });

  it("creates a placeholder personal canvas when it does not exist yet", () => {
    const sections = buildCanvasBrowserSections([canvas("default", "default")], "default", "林知微");

    expect(sections.defaultCanvas).toMatchObject({
      id: "user_u_klqmat",
      displayName: "林知微",
      size: 0,
    });
    expect(sections.otherCanvases.map((item) => item.id)).toEqual(["default"]);
  });

  it("keeps conflict copies under other canvases", () => {
    const sections = buildCanvasBrowserSections(
      [
        canvas("user_eric_example_com_1m9fjbn", undefined, "2026-06-03T13:00:00Z"),
        canvas("user_director_example_com_abc123", undefined, "2026-06-03T12:00:00Z"),
        canvas("copy_1790000000000_ab12cd_user_eric_example_com", undefined, "2026-06-03T14:00:00Z", {
          metadata: {
            canvas_origin: "conflict_copy",
            source_canvas_id: "user_eric_example_com_1m9fjbn",
          },
        }),
        canvas("user_eric_example_com_1m9fjbn_copy_1790000000000", undefined, "2026-06-03T11:00:00Z"),
      ],
      "user_eric_example_com_1m9fjbn",
      "eric@example.com",
    );

    expect(sections.memberCanvases.map((item) => item.id)).toEqual(["user_director_example_com_abc123"]);
    expect(sections.otherCanvases.map((item) => item.id)).toEqual([
      "copy_1790000000000_ab12cd_user_eric_example_com",
      "user_eric_example_com_1m9fjbn_copy_1790000000000",
    ]);
  });

  it("places user-created canvases under member canvases for shared browsing", () => {
    const sections = buildCanvasBrowserSections(
      [
        canvas("default", "default"),
        canvas("canvas_story_lab_abc123", undefined, "2026-06-03T13:00:00Z", {
          metadata: {
            canvas_origin: "user_created",
            display_name: "故事实验",
            creator_username: "alice",
          },
        }),
      ],
      "default",
      "eric@example.com",
    );

    expect(sections.memberCanvases.map((item) => item.id)).toEqual(["canvas_story_lab_abc123"]);
    expect(sections.otherCanvases.map((item) => item.id)).toEqual(["default"]);
  });

  it("shows user-created canvases as blank canvases even when backend scope is default", () => {
    expect(
      canvasKindFromSummary(
        canvas("canvas_story_lab_abc123", "default", "2026-06-03T13:00:00Z", {
          metadata: {
            canvas_origin: "user_created",
            display_name: "故事实验",
            creator_username: "alice",
          },
        }),
      ),
    ).toBe("blank");
  });

  it("detects duplicate user-facing canvas names", () => {
    const t = (key: string, options?: Record<string, unknown>) =>
      key === "freezone.canvases.description.default"
        ? "默认画布"
        : String(options?.name ?? key);
    const items = [
      canvas("canvas_story_lab_abc123", undefined, "2026-06-03T13:00:00Z", {
        metadata: {
          canvas_origin: "user_created",
          display_name: "故事实验",
          creator_username: "alice",
        },
      }),
    ];

    expect(findDuplicateCanvasName(items, " 故事实验 ", t)?.id).toBe("canvas_story_lab_abc123");
    expect(findDuplicateCanvasName(items, "新的画布", t)).toBeNull();
  });

  it("builds stable user-created canvas ids from username and name", () => {
    expect(userCreatedCanvasId("故事实验", "alice")).toBe(userCreatedCanvasId("故事实验", "alice"));
    expect(userCreatedCanvasId("故事实验", "alice")).not.toBe(userCreatedCanvasId("故事实验", "bob"));
    expect(userCreatedCanvasId("故事实验", "alice")).toMatch(/^canvas_canvas_[a-z0-9]+$/);
  });

  it("allows deleting only non-personal canvases", () => {
    expect(canDeleteCanvasSummary(canvas("user_eric_example_com_1m9fjbn"), "eric@example.com")).toBe(false);
    expect(canDeleteCanvasSummary(canvas("user_director_example_com_abc123"), "eric@example.com")).toBe(false);
    expect(
      canDeleteCanvasSummary(
        canvas("copy_179_ab_user_eric", undefined, "2026-06-03T00:00:00Z", {
          metadata: { canvas_origin: "conflict_copy", source_canvas_id: "user_eric_example_com_1m9fjbn" },
        }),
        "eric@example.com",
      ),
    ).toBe(true);
    expect(canDeleteCanvasSummary(canvas("default", "default"), "eric@example.com")).toBe(true);
    expect(canDeleteCanvasSummary(canvas("asset_1", "asset"), "eric@example.com")).toBe(true);
  });
});

describe("freezone preset auto refresh guard", () => {
  it("silently aborts best-effort refresh when the local canvas cannot flush", () => {
    expect(shouldAbortBestEffortPresetRefresh(true, false)).toBe(true);
    expect(shouldAbortBestEffortPresetRefresh(false, false)).toBe(false);
    expect(shouldAbortBestEffortPresetRefresh(true, true)).toBe(false);
  });

  it("skips pre-flush for clean best-effort refreshes", () => {
    expect(shouldFlushBeforePresetRefresh(true, 0)).toBe(false);
    expect(shouldFlushBeforePresetRefresh(true, 1)).toBe(true);
    expect(shouldFlushBeforePresetRefresh(false, 0)).toBe(true);
  });

  it("defers best-effort refresh until the current canvas is hydrated with a revision", () => {
    expect(shouldDeferPresetRefreshUntilReady(true, null, "old", "new")).toBe(true);
    expect(shouldDeferPresetRefreshUntilReady(true, 3, "old", "new")).toBe(true);
    expect(shouldDeferPresetRefreshUntilReady(true, null, "new", "new")).toBe(true);
    expect(shouldDeferPresetRefreshUntilReady(true, 3, "new", "new")).toBe(false);
    expect(shouldDeferPresetRefreshUntilReady(false, null, null, "new")).toBe(false);
  });

  it("does not treat projection canvases as legacy preset canvases", () => {
    expect(hasLegacyPresetCanvasMetadata({ preset: { scope: "beat" } })).toBe(true);
    expect(
      hasLegacyPresetCanvasMetadata({
        preset: { scope: "beat" },
        projections: { "beat:1:4": { projection_key: "beat:1:4" } },
      }),
    ).toBe(false);
  });

  it("keeps projection panel visible during transient canvas save states", () => {
    expect(
      shouldClearProjectionStatuses({
        canvasId: "user_eric",
        hydratedCanvasId: "user_eric",
        projectionKeyCount: 2,
      }),
    ).toBe(false);
    expect(
      shouldClearProjectionStatuses({
        canvasId: "user_eric",
        hydratedCanvasId: "other",
        projectionKeyCount: 2,
      }),
    ).toBe(true);
    expect(
      shouldClearProjectionStatuses({
        canvasId: "user_eric",
        hydratedCanvasId: "user_eric",
        projectionKeyCount: 0,
      }),
    ).toBe(true);
  });

  it("does not fetch projection statuses while the canvas save is unsettled", () => {
    expect(
      shouldFetchProjectionStatuses({
        canvasId: "user_eric",
        hydratedCanvasId: "user_eric",
        projectionKeyCount: 2,
        revision: 7,
        syncStatus: "saving",
      }),
    ).toBe(false);
    expect(
      shouldFetchProjectionStatuses({
        canvasId: "user_eric",
        hydratedCanvasId: "user_eric",
        projectionKeyCount: 2,
        revision: 8,
        syncStatus: "ready",
      }),
    ).toBe(true);
  });

  it("does not restart projection status requests after session expiry", () => {
    expect(
      shouldFetchProjectionStatuses({
        canvasId: "user_eric",
        hydratedCanvasId: "user_eric",
        projectionKeyCount: 2,
        revision: 8,
        syncStatus: "ready",
        sessionExpired: true,
      } as Parameters<typeof shouldFetchProjectionStatuses>[0] & {
        sessionExpired: boolean;
      }),
    ).toBe(false);
  });

  it("stops projection timer and browser refresh triggers on session expiry", () => {
    vi.useFakeTimers();
    const bump = vi.fn();
    const startProjectionStatusRefresh = (
      freezoneShellModule as typeof freezoneShellModule & {
        startProjectionStatusRefresh?: (
          refresh: () => void,
          onSessionExpired: () => void,
        ) => () => void;
      }
    ).startProjectionStatusRefresh;
    expect(startProjectionStatusRefresh).toBeTypeOf("function");
    if (!startProjectionStatusRefresh) return;

    const onSessionExpired = vi.fn();
    const cleanup = startProjectionStatusRefresh(bump, onSessionExpired);
    vi.advanceTimersByTime(30_000);
    expect(bump).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event("session-expired"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(60_000);

    expect(onSessionExpired).toHaveBeenCalledOnce();
    expect(bump).toHaveBeenCalledOnce();
    cleanup();
  });

  it("allows a fresh projection monitor after a new login mounts the shell", () => {
    vi.useFakeTimers();
    const startProjectionStatusRefresh = (
      freezoneShellModule as typeof freezoneShellModule & {
        startProjectionStatusRefresh?: (
          refresh: () => void,
          onSessionExpired: () => void,
        ) => () => void;
      }
    ).startProjectionStatusRefresh;
    expect(startProjectionStatusRefresh).toBeTypeOf("function");
    if (!startProjectionStatusRefresh) return;

    const expiredBump = vi.fn();
    startProjectionStatusRefresh(expiredBump, vi.fn());
    window.dispatchEvent(new Event("session-expired"));

    const freshBump = vi.fn();
    const cleanup = startProjectionStatusRefresh(freshBump, vi.fn());
    vi.advanceTimersByTime(30_000);

    expect(freshBump).toHaveBeenCalledOnce();
    cleanup();
  });

  it("does not refetch projection statuses for the same persisted revision", () => {
    expect(
      shouldSkipProjectionStatusRevision({
        canvasId: "user_eric",
        revision: 7,
        refreshToken: 0,
        lastChecked: { canvasId: "user_eric", revision: 7, refreshToken: 0 },
      }),
    ).toBe(true);
    expect(
      shouldSkipProjectionStatusRevision({
        canvasId: "user_eric",
        revision: 8,
        refreshToken: 0,
        lastChecked: { canvasId: "user_eric", revision: 7, refreshToken: 0 },
      }),
    ).toBe(false);
    expect(
      shouldSkipProjectionStatusRevision({
        canvasId: "user_eric",
        revision: 7,
        refreshToken: 0,
        lastChecked: { canvasId: "other", revision: 7, refreshToken: 0 },
      }),
    ).toBe(false);
    expect(
      shouldSkipProjectionStatusRevision({
        canvasId: "user_eric",
        revision: 7,
        refreshToken: 1,
        lastChecked: { canvasId: "user_eric", revision: 7, refreshToken: 0 },
      }),
    ).toBe(false);
  });

  it("refetches projection statuses after the persisted revision changes", () => {
    expect(
      shouldSkipProjectionStatusRevision({
        canvasId: "user_eric",
        revision: 9,
        refreshToken: 0,
        lastChecked: {
          canvasId: "user_eric",
          revision: 8,
          refreshToken: 0,
        },
      }),
    ).toBe(false);
    expect(
      shouldSkipProjectionStatusRevision({
        canvasId: "user_eric",
        revision: 8,
        refreshToken: 0,
        lastChecked: {
          canvasId: "user_eric",
          revision: 8,
          refreshToken: 0,
        },
      }),
    ).toBe(true);
  });

  it("recovers a sync request from legacy projection metadata without request", () => {
    expect(
      requestFromProjectionMetadata(
        {
          projections: {
            "beat:1:4": {
              projection_key: "beat:1:4",
              facts_signature: "old",
            },
          },
        },
        "beat:1:4",
      ),
    ).toEqual({
      scope: "beat",
      episode: 1,
      beat: 4,
      primary_slot: "render",
      asset_kind: undefined,
      character: undefined,
      identity_id: undefined,
      asset_id: undefined,
    });
  });

  it("does not refresh canvas node urls after scene director world manifest commits", () => {
    expect(shouldRefreshCommittedTargetNodes({
      kind: "scene_director_world",
      scene_id: "公寓楼电梯间",
    })).toBe(false);
    expect(shouldRefreshCommittedTargetNodes({
      kind: "scene_3gs_master_ply",
      scene_id: "公寓楼电梯间",
    })).toBe(true);
  });

  it("uses latest canvas node data for structured submit payloads", () => {
    const fallback = { scene: { camera: "old" } };
    const latest = { scene: { camera: "new" } };

    expect(resolveSubmitNodeData(latest, fallback)).toBe(latest);
    expect(resolveSubmitNodeData(null, fallback)).toBe(fallback);
  });

  it("builds a temporary director-world payload for source slot manifest sync", () => {
    const scene = {
      world: { activeSourceId: "custom-local" },
      actors: [{ id: "actor-1" }],
    };

    const patch = nodeDataPatchAfterCommittedSourceSlot(
      {
        user_spawned: true,
        activeSourceId: "custom-local",
        scene,
        scenesBySourceId: { "custom-local": scene },
        sources: [
          {
            id: "custom-local",
            source_type: "sog",
            source_kind: "custom",
            ply_url: "/static/proj/freezone/generated/custom.sog",
            current: true,
          },
        ],
      },
      { kind: "scene_3gs_master_ply", scene_id: "公寓楼电梯间" },
      {
        target_path: "director_worlds/公寓楼电梯间/v1/master.sog",
        target_url: "/static/proj/director_worlds/公寓楼电梯间/v1/master.sog?v=1",
        backup: null,
      },
      "proj",
    );

    expect(patch).toMatchObject({
      activeSourceId: "custom-local",
      displayName: "已提交 · 公寓楼电梯间 / 正面世界",
      plyUrl: "/static/proj/director_worlds/公寓楼电梯间/v1/master.sog?v=1",
      sourceFileName: "master.sog",
      slot_target: { kind: "scene_3gs_master_ply", scene_id: "公寓楼电梯间" },
      committed_slot_url: "/static/proj/director_worlds/公寓楼电梯间/v1/master.sog?v=1",
      committed_target_label: "公寓楼电梯间 / 正面世界",
      mainline_context: undefined,
      scene: { world: { activeSourceId: "custom-local" } },
      scenesBySourceId: {
        "custom-local": { world: { activeSourceId: "custom-local" } },
      },
    });
    expect((patch?.sources as Array<{ id: string; current?: boolean; label?: string }>)).toEqual([
      expect.objectContaining({ id: "custom-local", current: true }),
    ]);
    expect((patch?.sources as Array<{ label?: string }>).some((source) => source.label === "正面世界")).toBe(false);
  });

  it("does not rewrite the canvas node after a director-world source slot commit", () => {
    expect(nodeDataPatchAfterCommittedTarget(
      {
        user_spawned: true,
        activeSourceId: "custom-local",
        plyUrl: "/static/proj/freezone/generated/custom.sog",
      },
      { kind: "scene_3gs_master_ply", scene_id: "公寓楼电梯间" },
      {
        target_path: "director_worlds/公寓楼电梯间/v1/master.sog",
        target_url: "/static/proj/director_worlds/公寓楼电梯间/v1/master.sog?v=1",
        backup: null,
      },
      "proj",
    )).toBeNull();
  });

  it("canonicalizes ordinary image-like commits back into mainline canvas identity", () => {
    const patch = nodeDataPatchAfterCommittedTarget(
      {
        imageUrl: "/static/proj/freezone/generated/frame.png",
        user_spawned: true,
        slot_target: { kind: "frame", episode: 1, beat: 3 },
      },
      { kind: "frame", episode: 1, beat: 3 },
      {
        target_path: "renders/ep001/beat_03.png",
        target_url: "/static/proj/renders/ep001/beat_03.png?v=2",
        backup: null,
      },
      "proj",
    );

    expect(patch).toMatchObject({
      imageUrl: "/static/proj/renders/ep001/beat_03.png?v=2",
      previewImageUrl: "/static/proj/renders/ep001/beat_03.png?v=2",
      displayName: "已提交 · EP1 / Beat 3 / 分镜",
      sourceFileName: "beat_03.png",
      slot_target: { kind: "frame", episode: 1, beat: 3 },
      committed_slot_url: "/static/proj/renders/ep001/beat_03.png?v=2",
      committed_target_label: "EP1 / Beat 3 / 分镜",
      mainline_context: undefined,
    });
  });

  it("canonicalizes video, audio, identity, and prop commits with target-specific fields", () => {
    expect(nodeDataPatchAfterCommittedTarget(
      { videoUrl: "/tmp/video.mp4" },
      { kind: "video", episode: 2, beat: 4 },
      { target_path: "videos/ep002/beat_04.mp4", target_url: "/static/video.mp4", backup: null },
      "proj",
    )).toMatchObject({
      videoUrl: "/static/video.mp4",
      previewImageUrl: "/static/video.mp4",
      displayName: "EP2 / Beat 4 / 视频",
      mainline_context: [expect.objectContaining({ kind: "video", episode: 2, beat: 4 })],
    });

    expect(nodeDataPatchAfterCommittedTarget(
      { audioUrl: "/tmp/audio.wav" },
      { kind: "beat_audio", episode: 2, beat: 4 },
      { target_path: "audio/ep002/beat_04.wav", target_url: "/static/audio.wav", backup: null },
      "proj",
    )).toMatchObject({
      audioUrl: "/static/audio.wav",
      url: "/static/audio.wav",
      displayName: "EP2 / Beat 4 / 音频",
      mainline_context: [expect.objectContaining({ kind: "audio", audioRole: "beat_audio" })],
    });

    expect(nodeDataPatchAfterCommittedTarget(
      { imageUrl: "/tmp/identity.png" },
      { kind: "identity", character: "杜晨", identity_id: "default" },
      { target_path: "characters/duchen/default.png", target_url: "/static/identity.png", backup: null },
      "proj",
    )).toMatchObject({
      imageUrl: "/static/identity.png",
      displayName: "杜晨 / default / 身份",
      __freezone_source: {
        meta: { character: "杜晨", identity_id: "default" },
      },
      mainline_context: [expect.objectContaining({ kind: "identity", character: "杜晨", identityId: "default" })],
    });

    expect(nodeDataPatchAfterCommittedTarget(
      { imageUrl: "/tmp/prop.png" },
      { kind: "prop_ref", prop_id: "纸箱" },
      { target_path: "props/box.png", target_url: "/static/prop.png", backup: null },
      "proj",
    )).toMatchObject({
      imageUrl: "/static/prop.png",
      displayName: "纸箱 / 道具",
      __freezone_source: {
        meta: { prop_id: "纸箱", prop: "纸箱" },
      },
      mainline_context: [expect.objectContaining({ kind: "prop", propId: "纸箱" })],
    });
  });
});

describe("freezone save error normalization", () => {
  it("extracts status and body from backend status errors", () => {
    const body = { detail: { code: "canvas_lock_busy" } };
    expect(saveErrorStatusAndBody(new BackendStatusError("busy", 503, body))).toEqual({
      status: 503,
      body,
    });
  });
});

describe("freezone conflict copy helpers", () => {
  it("builds copy ids that cannot be mistaken for personal canvases", () => {
    const copyId = buildConflictCopyCanvasId("user_admin_en845w", 1790000000000, "ab12cd");

    expect(copyId).toBe("copy_1790000000000_ab12cd_user_admin_en845w");
    expect(copyId.startsWith("user_")).toBe(false);
    expect(copyId.length).toBeLessThanOrEqual(64);
  });

  it("stamps conflict copy metadata with the source canvas id", () => {
    expect(
      buildConflictCopyMetadata({
        sourceCanvasId: "user_admin_en845w",
        metadata: { existing: true },
      }),
    ).toEqual({
      existing: true,
      canvas_origin: "conflict_copy",
      source_canvas_id: "user_admin_en845w",
    });
  });
});

describe("freezone canvas creation limit", () => {
  function myCanvas(index: number, creator: string | null = "alice"): FreezoneCanvasSummary {
    return canvas(`canvas_mine_${index}`, undefined, "2026-06-03T00:00:00Z", {
      metadata: {
        canvas_origin: "user_created",
        display_name: `我的画布 ${index}`,
        ...(creator === null ? {} : { creator_username: creator }),
      },
    });
  }

  it("counts only the canvases the given user created", () => {
    const items = [
      canvas("default", "default"),
      canvas("user_alice_ab12"),
      myCanvas(1),
      myCanvas(2),
      myCanvas(3, "bob"),
    ];

    expect(countCanvasesCreatedBy(items, "alice")).toBe(2);
    expect(countCanvasesCreatedBy(items, "bob")).toBe(1);
  });

  it("does not count preset, personal or projection canvases toward the quota", () => {
    const items = [
      canvas("default", "default"),
      canvas("ep_1", "episode"),
      canvas("beat_1_2", "beat"),
      canvas("user_alice_ab12"),
    ];

    expect(countCanvasesCreatedBy(items, "alice")).toBe(0);
  });

  it("attributes canvases with no creator metadata to the anonymous bucket", () => {
    const items = [myCanvas(1, null), myCanvas(2, "alice")];

    expect(countCanvasesCreatedBy(items, null)).toBe(1);
    expect(countCanvasesCreatedBy(items, "alice")).toBe(1);
  });

  it("blocks creation once the user owns the maximum number of canvases", () => {
    const mine = Array.from({ length: MAX_USER_CREATED_CANVASES_PER_PROJECT }, (_unused, index) =>
      myCanvas(index),
    );

    expect(canvasCreationQuotaStatus(mine, "alice")).toBe("reached");
    expect(canvasCreationQuotaStatus(mine.slice(0, -1), "alice")).toBe("available");
  });

  it("keeps another user's quota independent", () => {
    const mine = Array.from({ length: MAX_USER_CREATED_CANVASES_PER_PROJECT }, (_unused, index) =>
      myCanvas(index),
    );

    expect(canvasCreationQuotaStatus(mine, "bob")).toBe("available");
  });

  it("reports the quota as unknown until the canvas list has loaded", () => {
    // 列表还没回来时手上是空数组，按它算出来的「还没超」是假的：后端不数个数，
    // 放行等于真的多建一张。
    expect(canvasCreationQuotaStatus(undefined, "alice")).toBe("unknown");
  });

  it("reports the quota as unknown until the username has loaded", () => {
    // 登录态还没落地时 username 是 null，此时数出来的是「缺 creator_username 的
    // 老画布」这个匿名桶——既不能拿它拦真作者，也不能当成还有余量。
    const orphans = Array.from({ length: MAX_USER_CREATED_CANVASES_PER_PROJECT }, (_unused, index) =>
      myCanvas(index, null),
    );

    expect(canvasCreationQuotaStatus(orphans, null)).toBe("unknown");
    expect(canvasCreationQuotaStatus(orphans, "   ")).toBe("unknown");
    expect(canvasCreationQuotaStatus([], null)).toBe("unknown");
  });
});
