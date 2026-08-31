// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  directorWorldSourceDisplayName,
  isUserSelectableCommitKind,
  modelSlotKindsForNodeData,
  sceneOptionLabel,
} from "@/features/freezone/commit/CommitDialog";
import { promoteToAsset } from "@/features/freezone/commit/promoteToAsset";
import { assetToPushTarget, completeTarget, inferDefaultTarget } from "@/features/freezone/commit/pushTarget";

import { zhT } from "../../helpers/i18n-fixtures";

describe("CommitDialog target kinds", () => {
  it("hides deprecated and auxiliary scene asset kinds from user selection", () => {
    expect(isUserSelectableCommitKind("scene_360")).toBe(false);
    expect(isUserSelectableCommitKind("scene_3gs_active_ply")).toBe(false);
    expect(isUserSelectableCommitKind("scene_3gs_collision_glb")).toBe(false);
  });

  it("keeps user-facing scene asset kinds selectable", () => {
    expect(isUserSelectableCommitKind("scene_master")).toBe(true);
    expect(isUserSelectableCommitKind("scene_reverse_master")).toBe(true);
    expect(isUserSelectableCommitKind("scene_director_pano_360")).toBe(true);
    expect(isUserSelectableCommitKind("scene_3gs_master_ply")).toBe(true);
  });

  it("routes scene 360 candidates to Director Pano 360 instead of the old scene_360 slot", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/freezone/capabilities/candidate_capabilities.ts"),
      "utf8",
    );

    expect(source).toContain('outputKind: "scene_director_pano_360"');
    expect(source).not.toContain('outputKind: "scene_360"');
  });

  it("normalizes old scene_360 sources to the Director Pano 360 target", () => {
    const target = completeTarget(
      inferDefaultTarget({
        kind: "scene_360",
        meta: { scene_id: "厨房" },
      }),
    );

    expect(target).toEqual({ kind: "scene_director_pano_360", scene_id: "厨房" });
  });

  it("treats scene director world as one structured scene commit target", () => {
    expect(assetToPushTarget({
      kind: "scene",
      role: "scene_director_world",
      meta: { scene_id: "公寓楼电梯间" },
    })).toEqual({ kind: "scene_director_world", scene_id: "公寓楼电梯间" });
  });

  it("labels scene director world commits as manifest state instead of a raw 3D model", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/freezone/commit/CommitDialog.tsx"),
      "utf8",
    );

    expect(source).toContain("commitSourceTitle");
    expect(source).toContain('target?.kind === "scene_director_world"');
    // 文案已搬进词条，源码里只剩 key；词条内容由 locale 对齐测试兜底。
    expect(source).toContain('t("freezone.commit.directorWorldState")');
    expect(source).toContain('t("freezone.commit.directorWorldManifestHint")');
  });

  it("shows model scene targets as scene selection instead of a raw scene_id-only field", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/freezone/commit/CommitDialog.tsx"),
      "utf8",
    );

    expect(source).toContain("listScenes(project)");
    expect(source).toContain('aria-label={t("freezone.commit.sections.scene")}');
    expect(source).toContain("sceneOptionLabel(scene)");
  });

  it("shows canonical scene names in commit target dropdowns, not aliases", () => {
    expect(sceneOptionLabel({
      name: "公寓楼电梯间",
      aliases: ["电梯"],
      variant_id: "night",
    })).toBe("公寓楼电梯间");
  });

  it("uses director world source labels instead of raw generated SOG filenames", () => {
    expect(directorWorldSourceDisplayName(
      {
        activeSourceId: "custom",
        sources: [
          {
            id: "custom",
            source_type: "sog",
            source_kind: "custom",
            ply_url: "/static/u/p/freezone/generated/master_sharp.sog",
          },
        ],
      },
      "/static/u/p/freezone/generated/master_sharp.sog",
      "master_sharp.sog",
      zhT,
    )).toBe("自定义 3D 世界");
  });

  it("does not allow scene director world through the file-copy commit route", async () => {
    await expect(promoteToAsset(
      "proj",
      "/static/proj/world.ply",
      { kind: "scene_director_world", scene_id: "公寓楼电梯间" },
    )).rejects.toThrow("Scene director world commit requires canvas node state");
  });

  it("keeps custom 3D world sources on the normal slot commit path", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/freezone/commit/CommitDialog.tsx"),
      "utf8",
    );

    expect(isUserSelectableCommitKind("scene_3gs_custom_scene")).toBe(true);
    expect(source).toContain('mediaType === "model"');
    expect(source).toContain('"scene_3gs_custom_scene"');
    expect(source).toContain("modelCommitKindAllowed");
    expect(source).toContain("MODEL_WORLD_SLOT_KINDS");
  });

  it("separates pano 360 image commits from 3GS world commits", () => {
    expect(modelSlotKindsForNodeData({
      activeSourceId: "pano",
      sources: [{ id: "pano", source_type: "pano360", pano_url: "/static/pano.jpg" }],
    }, "/static/pano.jpg")).toEqual(["scene_director_pano_360"]);

    expect(modelSlotKindsForNodeData({
      activeSourceId: "world",
      sources: [{ id: "world", source_type: "sog", ply_url: "/static/world.ply" }],
    }, "/static/world.ply")).toEqual([
      "scene_3gs_master_ply",
      "scene_3gs_reverse_ply",
      "scene_3gs_pano_ply",
      "scene_3gs_custom_scene",
    ]);
  });

  it("does not offer file slot commits for the empty Director World source", () => {
    expect(modelSlotKindsForNodeData({
      activeSourceId: "__empty_director_world__",
      sources: [
        { id: "world", source_type: "sog", ply_url: "/static/world.sog" },
      ],
      plyUrl: "/static/world.sog",
    }, "/static/world.sog")).toEqual([]);
  });
});
