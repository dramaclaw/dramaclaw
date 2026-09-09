// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSceneDirectorWorld,
  getSceneDirectorStageManifest,
  saveSceneDirectorWorld,
  saveSceneDirectorWorldSource,
} from "@/api/viewerManifests";
import {
  commitSceneDirectorWorldFromCanvasNode,
  hasDirectorWorldSceneState,
  nodeDataAfterDirectorWorldSourceSlotCommit,
} from "@/features/freezone/commit/sceneDirectorWorldCommit";
import { zhT } from "../../helpers/i18n-fixtures";

vi.mock("@/api/viewerManifests", () => ({
  clearSceneDirectorWorld: vi.fn(async () => ({ active_source_id: "" })),
  getSceneDirectorStageManifest: vi.fn(async () => ({
    viewer_kind: "three_d_director",
    mode: "scene",
    project: "proj",
    scene_id: "公寓楼电梯间",
    display_name: "公寓楼电梯间",
    source: { source_kind: "master" },
    sources: [],
    scenes_by_source_id: {},
    palette: { actors: [], props: [], anonymous_colors: [], anonymous_prop_colors: [] },
    allowed_destinations: ["view"],
  })),
  saveSceneDirectorWorld: vi.fn(async (_project: string, _sceneId: string, payload: Record<string, unknown>) => ({
    active_source_id: payload.active_source_id,
    manifest: null,
  })),
  saveSceneDirectorWorldSource: vi.fn(async (_project: string, _sceneId: string, payload: Record<string, unknown>) => ({
    active_source_id: payload.source_id,
    manifest: null,
  })),
}));

describe("commitSceneDirectorWorldFromCanvasNode", () => {
  beforeEach(() => {
    vi.mocked(clearSceneDirectorWorld).mockClear();
    vi.mocked(getSceneDirectorStageManifest).mockClear();
    vi.mocked(getSceneDirectorStageManifest).mockResolvedValue({
      viewer_kind: "three_d_director",
      mode: "scene",
      project: "proj",
      scene_id: "公寓楼电梯间",
      display_name: "公寓楼电梯间",
      source: { source_kind: "master" },
      sources: [],
      scenes_by_source_id: {},
      palette: { actors: [], props: [], anonymous_colors: [], anonymous_prop_colors: [] },
      allowed_destinations: ["view"],
    });
    vi.mocked(saveSceneDirectorWorld).mockClear();
    vi.mocked(saveSceneDirectorWorld).mockResolvedValue({
      active_source_id: "",
      manifest: null,
    });
    vi.mocked(saveSceneDirectorWorldSource).mockClear();
    vi.mocked(saveSceneDirectorWorldSource).mockResolvedValue({
      active_source_id: "",
      manifest: null,
    });
  });

  it("replaces the whole mainline scene director world from canvas-local saved sources", async () => {
    const frontScene = {
      camera: { position: [0, 1, 2] },
      actors: [{ id: "actor-1" }],
      props: [],
      world: { activeSourceId: "front", sourceTransform: { yawDeg: 1 } },
    };
    const panoScene = {
      camera: { position: [2, 1, 0] },
      actors: [],
      props: [{ id: "prop-1" }],
      world: { activeSourceId: "pano", sourceTransform: { yawDeg: 9 } },
    };

    const result = await commitSceneDirectorWorldFromCanvasNode(
      "proj",
      { kind: "scene_director_world", scene_id: "公寓楼电梯间" },
      {
        activeSourceId: "pano",
        scene: panoScene,
        scenesBySourceId: {
          front: frontScene,
          pano: panoScene,
        },
        sources: [
          { id: "front", source_type: "sog", source_kind: "master", url: "/static/proj/director_worlds/公寓楼电梯间/v1/master.ply" },
          { id: "pano", source_type: "pano360", source_kind: "pano", url: "/static/proj/director_worlds/公寓楼电梯间/v1/pano.jpg" },
        ],
      },
      zhT,
    );

    expect(clearSceneDirectorWorld).not.toHaveBeenCalled();
    expect(saveSceneDirectorWorld).toHaveBeenCalledTimes(2);
    expect(vi.mocked(saveSceneDirectorWorld).mock.calls.map((call) => call[2].active_source_id)).toEqual([
      "front",
      "pano",
    ]);
    expect(vi.mocked(saveSceneDirectorWorld).mock.calls[1]?.[2]).toMatchObject({
      active_source_id: "pano",
      snapshot: panoScene,
      active_source: { id: "pano", source_type: "pano360" },
    });
    expect(result).toMatchObject({
      target_path: "director_worlds/公寓楼电梯间/v1/stage_manifest.json",
      target_url: "/static/proj/director_worlds/公寓楼电梯间/v1/pano.jpg",
      backup: null,
      affected_count: 2,
    });
  });

  it("saves new source states before clearing stale mainline source states", async () => {
    vi.mocked(getSceneDirectorStageManifest).mockResolvedValue({
      viewer_kind: "three_d_director",
      mode: "scene",
      project: "proj",
      scene_id: "公寓楼电梯间",
      display_name: "公寓楼电梯间",
      active_source_id: "old",
      source: { source_kind: "master" },
      sources: [
        { id: "front", source_type: "sog", source_kind: "master" },
        { id: "old", source_type: "sog", source_kind: "custom" },
      ],
      scenes_by_source_id: { front: null, old: null },
      palette: { actors: [], props: [], anonymous_colors: [], anonymous_prop_colors: [] },
      allowed_destinations: ["view"],
    });
    const scene = {
      camera: { position: [0, 1, 2] },
      actors: [],
      props: [],
      world: { activeSourceId: "front" },
    };

    await commitSceneDirectorWorldFromCanvasNode(
      "proj",
      { kind: "scene_director_world", scene_id: "公寓楼电梯间" },
      {
        activeSourceId: "front",
        scene,
        sources: [
          { id: "front", source_type: "sog", source_kind: "master", url: "/static/proj/director_worlds/公寓楼电梯间/v1/master.sog" },
        ],
      },
      zhT,
    );

    expect(saveSceneDirectorWorld).toHaveBeenCalledTimes(1);
    expect(clearSceneDirectorWorld).toHaveBeenCalledTimes(1);
    expect(clearSceneDirectorWorld).toHaveBeenCalledWith("proj", "公寓楼电梯间", "old");
    expect(
      vi.mocked(saveSceneDirectorWorld).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(clearSceneDirectorWorld).mock.invocationCallOrder[0],
    );
  });

  it("does not clear existing mainline state when saving the replacement manifest fails", async () => {
    vi.mocked(getSceneDirectorStageManifest).mockResolvedValue({
      viewer_kind: "three_d_director",
      mode: "scene",
      project: "proj",
      scene_id: "公寓楼电梯间",
      display_name: "公寓楼电梯间",
      active_source_id: "old",
      source: { source_kind: "master" },
      sources: [{ id: "old", source_type: "sog", source_kind: "custom" }],
      scenes_by_source_id: { old: null },
      palette: { actors: [], props: [], anonymous_colors: [], anonymous_prop_colors: [] },
      allowed_destinations: ["view"],
    });
    vi.mocked(saveSceneDirectorWorld).mockRejectedValueOnce(new Error("save failed"));

    await expect(commitSceneDirectorWorldFromCanvasNode(
      "proj",
      { kind: "scene_director_world", scene_id: "公寓楼电梯间" },
      {
        activeSourceId: "front",
        scene: {
          camera: { position: [0, 1, 2] },
          actors: [],
          props: [],
          world: { activeSourceId: "front" },
        },
        sources: [
          { id: "front", source_type: "sog", source_kind: "master", url: "/static/proj/director_worlds/公寓楼电梯间/v1/master.sog" },
        ],
      },
      zhT,
    )).rejects.toThrow("save failed");

    expect(clearSceneDirectorWorld).not.toHaveBeenCalled();
  });

  it("requires freezone custom world sources to be committed to a slot first", async () => {
    await expect(commitSceneDirectorWorldFromCanvasNode(
      "proj",
      { kind: "scene_director_world", scene_id: "公寓楼电梯间" },
      {
        activeSourceId: "custom-local",
        scene: {
          camera: { position: [0, 1, 2] },
          actors: [],
          props: [],
          world: { activeSourceId: "custom-local" },
        },
        sources: [
          {
            id: "custom-local",
            source_type: "sog",
            source_kind: "custom",
            ply_url: "/static/admin/proj/freezone/generated/custom-world.ply",
          },
        ],
      },
      zhT,
    )).rejects.toThrow("先把当前世界来源提交到主线槽位");

    expect(clearSceneDirectorWorld).not.toHaveBeenCalled();
    expect(saveSceneDirectorWorld).not.toHaveBeenCalled();
  });

  it("requires freezone pano sources to be committed to a mainline slot before manifest sync", async () => {
    await expect(commitSceneDirectorWorldFromCanvasNode(
      "proj",
      { kind: "scene_director_world", scene_id: "公寓楼电梯间" },
      {
        activeSourceId: "pano-local",
        scene: {
          camera: { position: [0, 1, 2] },
          actors: [],
          props: [],
          world: { activeSourceId: "pano-local" },
        },
        sources: [
          {
            id: "pano-local",
            source_type: "pano360",
            source_kind: "pano",
            pano_url: "/static/admin/proj/freezone/generated/pano.png",
          },
        ],
      },
      zhT,
    )).rejects.toThrow("先把当前世界来源提交到主线槽位");

    expect(clearSceneDirectorWorld).not.toHaveBeenCalled();
    expect(saveSceneDirectorWorld).not.toHaveBeenCalled();
  });

  it("requires freezone-generated pano 3DGS sources to be committed before manifest sync", async () => {
    await expect(commitSceneDirectorWorldFromCanvasNode(
      "proj",
      { kind: "scene_director_world", scene_id: "公寓楼电梯间" },
      {
        activeSourceId: "generated-sog:pano:1",
        scene: {
          camera: { position: [0, 1, 2] },
          actors: [],
          props: [],
          world: { activeSourceId: "generated-sog:pano:1" },
        },
        sources: [
          {
            id: "generated-sog:pano:1",
            source_type: "sog",
            source_kind: "pano",
            ply_url: "/static/admin/proj/freezone/generated/pano-world.sog",
          },
        ],
      },
      zhT,
    )).rejects.toThrow("先把当前世界来源提交到主线槽位");

    expect(clearSceneDirectorWorld).not.toHaveBeenCalled();
    expect(saveSceneDirectorWorld).not.toHaveBeenCalled();
  });

  it("lets a candidate source slot commit carry the director world manifest without changing local source identity", async () => {
    const scene = {
      camera: { position: [0, 1, 2] },
      actors: [{ id: "actor-1" }],
      props: [],
      world: { activeSourceId: "custom-local" },
    };
    const staleScene = {
      camera: { position: [9, 9, 9] },
      actors: [{ id: "stale-actor" }],
      props: [],
      world: { activeSourceId: "stale-local" },
    };
    const originalNodeData = {
      user_spawned: true,
      activeSourceId: "custom-local",
      scene,
      scenesBySourceId: {
        "custom-local": scene,
        "stale-local": staleScene,
      },
      sources: [
        {
          id: "stale-local",
          source_type: "sog",
          source_kind: "custom",
          ply_url: "/static/admin/proj/freezone/generated/stale-world.ply",
        },
        {
          id: "custom-local",
          source_type: "sog",
          source_kind: "custom",
          ply_url: "/static/admin/proj/freezone/generated/custom-world.ply",
          current: true,
        },
      ],
    };
    const patchedData = nodeDataAfterDirectorWorldSourceSlotCommit(
      originalNodeData,
      { kind: "scene_3gs_master_ply", scene_id: "公寓楼电梯间" },
      {
        target_path: "director_worlds/公寓楼电梯间/v1/master.ply",
        target_url: "/static/admin/proj/director_worlds/公寓楼电梯间/v1/master.ply",
      },
      zhT,
    );

    expect(originalNodeData.sources.find((source) => source.id === "custom-local")).toMatchObject({
      source_kind: "custom",
      ply_url: "/static/admin/proj/freezone/generated/custom-world.ply",
    });
    expect(patchedData.sources).not.toBe(originalNodeData.sources);

    await commitSceneDirectorWorldFromCanvasNode(
      "proj",
      { kind: "scene_director_world", scene_id: "公寓楼电梯间" },
      patchedData,
      zhT,
    );

    expect(saveSceneDirectorWorld).toHaveBeenCalledTimes(1);
    const canonicalMasterSourceId =
      "legacy:master:sog:/static/admin/proj/director_worlds/公寓楼电梯间/v1/master.ply";
    expect(vi.mocked(saveSceneDirectorWorld).mock.calls[0]?.[2]).toMatchObject({
      active_source_id: canonicalMasterSourceId,
      snapshot: {
        ...scene,
        world: { activeSourceId: canonicalMasterSourceId },
      },
      active_source: {
        id: canonicalMasterSourceId,
        source_type: "sog",
        source_kind: "master",
        ply_url: "/static/admin/proj/director_worlds/公寓楼电梯间/v1/master.ply",
      },
    });
    expect(patchedData).toMatchObject({
      activeSourceId: "custom-local",
      scene: {
        world: { activeSourceId: "custom-local" },
      },
      scenesBySourceId: {
        "custom-local": {
          world: { activeSourceId: "custom-local" },
        },
      },
    });
    expect((patchedData.scenesBySourceId as Record<string, unknown>)[canonicalMasterSourceId]).toBeUndefined();
    expect((patchedData.sources as Array<{ id: string; current?: boolean; label?: string }>)).toEqual([
      expect.objectContaining({ id: "custom-local", current: true }),
    ]);
    expect((patchedData.scenesBySourceId as Record<string, unknown>)["stale-local"]).toBeUndefined();
    expect((patchedData.sources as Array<{ label?: string }>).some((source) => source.label === "正面世界")).toBe(false);
  });

  it("does not treat a plain source slot commit as a director-world state commit", () => {
    const patchedData = nodeDataAfterDirectorWorldSourceSlotCommit(
      {
        user_spawned: true,
        activeSourceId: "custom-local",
        sources: [
          {
            id: "custom-local",
            source_type: "sog",
            source_kind: "custom",
            ply_url: "/static/admin/proj/freezone/generated/custom-world.ply",
            current: true,
          },
        ],
      },
      { kind: "scene_3gs_master_ply", scene_id: "公寓楼电梯间" },
      {
        target_path: "director_worlds/公寓楼电梯间/v1/master.sog",
        target_url: "/static/projects/proj/director_worlds/公寓楼电梯间/v1/master.sog?v=123",
      },
      zhT,
    );

    expect(hasDirectorWorldSceneState(patchedData)).toBe(false);
  });

  it("can sync a source-slot director state without clearing other mainline sources", async () => {
    const reverseScene = {
      schemaVersion: 1 as const,
      savedAt: 9,
      camera: { azim: 9, elev: 1, distance: 2, focalPoint: [0, 0, 0] as [number, number, number] },
      actors: [
        {
          id: "reverse-actor",
          label: "reverse-actor",
          color: "#00aaff",
          position: [0, 0, 0] as [number, number, number],
          yawDeg: 0,
          scale: [1, 1, 1] as [number, number, number],
        },
      ],
      props: [],
      stagings: [],
      world: { activeSourceId: "legacy:reverse:sog:/static/reverse.sog" },
    };
    vi.mocked(getSceneDirectorStageManifest).mockResolvedValue({
      viewer_kind: "three_d_director",
      mode: "scene",
      project: "proj",
      scene_id: "公寓楼电梯间",
      display_name: "公寓楼电梯间",
      active_source_id: "legacy:reverse:sog:/static/reverse.sog",
      source: { source_kind: "master" },
      sources: [
        { id: "legacy:master:sog:/static/master.sog", source_type: "sog", source_kind: "master" },
        { id: "legacy:reverse:sog:/static/reverse.sog", source_type: "sog", source_kind: "reverse" },
      ],
      scenes_by_source_id: {
        "legacy:master:sog:/static/master.sog": null,
        "legacy:reverse:sog:/static/reverse.sog": reverseScene,
      },
      palette: { actors: [], props: [], anonymous_colors: [], anonymous_prop_colors: [] },
      allowed_destinations: ["view"],
    });
    const scene = {
      camera: { position: [0, 1, 2] },
      actors: [{ id: "actor-1" }],
      props: [],
      world: { activeSourceId: "legacy:master:sog:/static/master.sog" },
    };

    await commitSceneDirectorWorldFromCanvasNode(
      "proj",
      { kind: "scene_director_world", scene_id: "公寓楼电梯间" },
      {
        activeSourceId: "legacy:master:sog:/static/master.sog",
        scene,
        sources: [
          {
            id: "legacy:master:sog:/static/master.sog",
            source_type: "sog",
            source_kind: "master",
            url: "/static/proj/director_worlds/公寓楼电梯间/v1/master.sog",
          },
        ],
      },
      zhT,
      { pruneStale: false },
    );

    expect(saveSceneDirectorWorld).not.toHaveBeenCalled();
    expect(saveSceneDirectorWorldSource).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveSceneDirectorWorldSource).mock.calls[0]?.[2]).toMatchObject({
      source_id: "legacy:master:sog:/static/master.sog",
      snapshot: scene,
      source: { id: "legacy:master:sog:/static/master.sog", source_kind: "master" },
    });
    expect(clearSceneDirectorWorld).not.toHaveBeenCalled();
  });

  it("canonicalizes legacy committed source ids that include backend media versions", async () => {
    const scene = {
      camera: { position: [0, 1, 2] },
      actors: [{ id: "actor-1" }],
      props: [],
      world: {
        activeSourceId:
          "legacy:master:sog:/static/projects/proj/director_worlds/公寓楼电梯间/v1/master.sog?v=123",
      },
    };

    await commitSceneDirectorWorldFromCanvasNode(
      "proj",
      { kind: "scene_director_world", scene_id: "公寓楼电梯间" },
      {
        user_spawned: true,
        activeSourceId: "custom-local",
        scene: {
          ...scene,
          world: { activeSourceId: "custom-local" },
        },
        scenesBySourceId: {
          "custom-local": {
            ...scene,
            world: { activeSourceId: "custom-local" },
          },
        },
        sources: [
          {
            id: "custom-local",
            source_type: "sog",
            source_kind: "custom",
            ply_url: "/static/projects/proj/director_worlds/公寓楼电梯间/v1/master.sog?v=123",
            current: true,
          },
        ],
        slot_target: { kind: "scene_3gs_master_ply", scene_id: "公寓楼电梯间" },
        committed_slot_url: "/static/projects/proj/director_worlds/公寓楼电梯间/v1/master.sog?v=123",
        committed_source_id:
          "legacy:master:sog:/static/projects/proj/director_worlds/公寓楼电梯间/v1/master.sog?v=123",
      },
      zhT,
      { pruneStale: false },
    );

    const canonicalMasterSourceId =
      "legacy:master:sog:/static/projects/proj/director_worlds/公寓楼电梯间/v1/master.sog";
    expect(saveSceneDirectorWorldSource).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveSceneDirectorWorldSource).mock.calls[0]?.[2]).toMatchObject({
      source_id: canonicalMasterSourceId,
      snapshot: {
        world: { activeSourceId: canonicalMasterSourceId },
      },
      source: {
        id: canonicalMasterSourceId,
        ply_url: "/static/projects/proj/director_worlds/公寓楼电梯间/v1/master.sog?v=123",
      },
    });
  });

  it("does not prune a non-active source whose local legacy id includes backend media versions", async () => {
    const canonicalMasterSourceId = "legacy:master:sog:/static/projects/proj/director_worlds/Hall/v1/master.sog";
    const versionedMasterSourceId = `${canonicalMasterSourceId}?v=123`;
    const reverseSourceId = "legacy:reverse:sog:/static/projects/proj/director_worlds/Hall/v1/reverse.sog";
    const masterScene = {
      schemaVersion: 1 as const,
      savedAt: 1,
      camera: { azim: 0, elev: 1, distance: 2, focalPoint: [0, 0, 0] as [number, number, number] },
      actors: [],
      props: [],
      stagings: [],
      world: { activeSourceId: versionedMasterSourceId },
    };
    const reverseScene = {
      schemaVersion: 1 as const,
      savedAt: 2,
      camera: { azim: 2, elev: 1, distance: 3, focalPoint: [0, 0, 0] as [number, number, number] },
      actors: [],
      props: [],
      stagings: [],
      world: { activeSourceId: reverseSourceId },
    };
    vi.mocked(getSceneDirectorStageManifest).mockResolvedValue({
      viewer_kind: "three_d_director",
      mode: "scene",
      project: "proj",
      scene_id: "Hall",
      display_name: "Hall",
      active_source_id: reverseSourceId,
      source: { source_kind: "reverse" },
      sources: [
        { id: canonicalMasterSourceId, source_type: "sog", source_kind: "master" },
        { id: reverseSourceId, source_type: "sog", source_kind: "reverse" },
      ],
      scenes_by_source_id: {
        [canonicalMasterSourceId]: masterScene,
        [reverseSourceId]: reverseScene,
      },
      palette: { actors: [], props: [], anonymous_colors: [], anonymous_prop_colors: [] },
      allowed_destinations: ["view"],
    });

    await commitSceneDirectorWorldFromCanvasNode(
      "proj",
      { kind: "scene_director_world", scene_id: "Hall" },
      {
        activeSourceId: reverseSourceId,
        scene: reverseScene,
        scenesBySourceId: {
          [versionedMasterSourceId]: masterScene,
          [reverseSourceId]: reverseScene,
        },
        sources: [
          {
            id: versionedMasterSourceId,
            source_type: "sog",
            source_kind: "master",
            url: "/static/projects/proj/director_worlds/Hall/v1/master.sog?v=123",
          },
          {
            id: reverseSourceId,
            source_type: "sog",
            source_kind: "reverse",
            url: "/static/projects/proj/director_worlds/Hall/v1/reverse.sog",
          },
        ],
      },
      zhT,
    );

    expect(saveSceneDirectorWorld).toHaveBeenCalledWith("proj", "Hall", expect.objectContaining({
      active_source_id: canonicalMasterSourceId,
      snapshot: expect.objectContaining({
        world: { activeSourceId: canonicalMasterSourceId },
      }),
    }));
    expect(clearSceneDirectorWorld).not.toHaveBeenCalledWith("proj", "Hall", canonicalMasterSourceId);
  });

  it("uses a stable source id when a committed slot URL carries a backend version", () => {
    const scene = {
      camera: { position: [0, 1, 2] },
      actors: [],
      props: [],
      world: { activeSourceId: "custom-local" },
    };

    const patchedData = nodeDataAfterDirectorWorldSourceSlotCommit(
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
            ply_url: "/static/admin/proj/freezone/generated/custom-world.ply",
            current: true,
          },
        ],
      },
      { kind: "scene_3gs_master_ply", scene_id: "公寓楼电梯间" },
      {
        target_path: "director_worlds/公寓楼电梯间/v1/master.sog",
        target_url: "/static/projects/proj/director_worlds/公寓楼电梯间/v1/master.sog?v=123#frag",
      },
      zhT,
    );

    expect(patchedData.activeSourceId).toBe("custom-local");
    expect(patchedData.scene).toMatchObject({
      world: { activeSourceId: "custom-local" },
    });
    expect(patchedData.sources).toEqual([
      expect.objectContaining({
        id: "custom-local",
        url: "/static/projects/proj/director_worlds/公寓楼电梯间/v1/master.sog?v=123#frag",
        current: true,
      }),
    ]);
  });

  it("keeps source-slot commits local when a custom node has no mainline identity", () => {
    const scene = {
      camera: { position: [0, 1, 2] },
      actors: [{ id: "actor-1" }],
      props: [],
      world: { activeSourceId: "custom-local" },
    };

    const patchedData = nodeDataAfterDirectorWorldSourceSlotCommit(
      {
        activeSourceId: "custom-local",
        scene,
        scenesBySourceId: { "custom-local": scene },
        sources: [
          {
            id: "custom-local",
            source_type: "sog",
            source_kind: "custom",
            ply_url: "/static/admin/proj/freezone/generated/custom-world.sog",
            current: true,
          },
        ],
      },
      { kind: "scene_3gs_master_ply", scene_id: "公寓楼电梯间" },
      {
        target_path: "director_worlds/公寓楼电梯间/v1/master.sog",
        target_url: "/static/projects/proj/director_worlds/公寓楼电梯间/v1/master.sog",
      },
      zhT,
    );

    expect(patchedData.mainline_context).toBeUndefined();
    expect(patchedData.activeSourceId).toBe("custom-local");
    expect(patchedData.sources).toEqual([
      expect.objectContaining({
        id: "custom-local",
        source_kind: "custom",
        current: true,
      }),
    ]);
  });
});
