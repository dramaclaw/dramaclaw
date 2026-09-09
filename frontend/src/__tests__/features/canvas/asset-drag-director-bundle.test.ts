// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { spawnAssetNode } from "@/features/canvas/domain/assetDrag";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { usableDirectorWorldPreviewUrl } from "@/features/canvas/nodes/ThreeDWorldNode";
import { directorControlBundleFromAssetSource } from "@/features/freezone/AssetLibraryPanel";
import { deriveNodeDropInfo } from "@/stores/assetDropStore";

describe("director bundle canvas assets", () => {
  it("keeps director control bundle on nodes spawned from library assets", () => {
    const bundle = {
      schema_version: "director_control_bundle_v1" as const,
      episode: 1,
      beat: 6,
      rel_paths: {
        combined: "director_control_frames/ep001/beat_06/combined.png",
        env_only: "director_control_frames/ep001/beat_06/env_only.png",
        frame_meta: "director_control_frames/ep001/beat_06/frame_meta.json",
      },
      urls: {
        combined: "/static/u/p/director_control_frames/ep001/beat_06/combined.png",
        env_only: "/static/u/p/director_control_frames/ep001/beat_06/env_only.png",
        frame_meta: "/static/u/p/director_control_frames/ep001/beat_06/frame_meta.json",
      },
    };
    const calls: Array<{ type: string; data: Record<string, unknown> }> = [];
    const store = {
      addNode: (type: string, _position: { x: number; y: number }, data: Record<string, unknown>) => {
        calls.push({ type, data });
        return "node-1";
      },
    };

    const nodeId = spawnAssetNode(
      store as Parameters<typeof spawnAssetNode>[0],
      {
        kind: "image",
        label: "导演合成图",
        url: bundle.urls.combined,
        aspectRatio: "16:9",
        source: {
          kind: "director_render",
          role: "director_combined",
          rel_path: bundle.rel_paths.combined,
          slot_target: { kind: "director_render", episode: 1, beat: 6 },
          director_control_bundle: bundle,
        },
      },
      { x: 10, y: 20 },
    );

    expect(nodeId).toBe("node-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.type).toBe(CANVAS_NODE_TYPES.upload);
    expect(calls[0]?.data.director_control_bundle).toEqual(bundle);
    expect(calls[0]?.data.__freezone_source).toMatchObject({
      director_control_bundle: bundle,
      role: "director_combined",
    });
    expect(calls[0]?.data.user_spawned).toBe(true);
    expect(calls[0]?.data.slot_target).toEqual({ kind: "director_render", episode: 1, beat: 6 });
  });

  it("downgrades library mainline assets to editable canvas candidates", () => {
    const calls: Array<{ type: string; data: Record<string, unknown> }> = [];
    const store = {
      addNode: (type: string, _position: { x: number; y: number }, data: Record<string, unknown>) => {
        calls.push({ type, data });
        return "node-1";
      },
    };

    spawnAssetNode(
      store as Parameters<typeof spawnAssetNode>[0],
      {
        kind: "model",
        label: "公寓楼电梯间 / 导演世界",
        url: "/static/projects/proj/director_worlds/公寓楼电梯间/v1/master.sog",
        source: {
          kind: "scene",
          role: "scene_3gs_master_ply",
          slot_target: { kind: "scene_3gs_master_ply", scene_id: "公寓楼电梯间" },
        },
        mainlineContext: [
          {
            kind: "scene",
            projectId: "proj",
            sceneId: "公寓楼电梯间",
            role: "scene_3gs_master_ply",
          },
        ],
      },
      { x: 10, y: 20 },
    );

    expect(calls[0]?.type).toBe(CANVAS_NODE_TYPES.threeDWorld);
    expect(calls[0]?.data).toMatchObject({
      user_spawned: true,
      slot_target: { kind: "scene_3gs_master_ply", scene_id: "公寓楼电梯间" },
      mainline_context: [
        expect.objectContaining({
          kind: "scene",
          sceneId: "公寓楼电梯间",
        }),
      ],
    });
  });

  it("exposes director_render as a normal beat commit target", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/freezone/commit/CommitDialog.tsx"),
      "utf8",
    );
    const beatSlotKinds = source.match(/const BEAT_SLOT_KINDS:[\s\S]*?=\s*\[([\s\S]*?)\];/);

    expect(beatSlotKinds?.[1]).toContain('"director_render"');
  });

  it("reconstructs a director bundle from a combined asset source", () => {
    const bundle = directorControlBundleFromAssetSource({
      role: "director_combined",
      rel_path: "director_control_frames/ep001/beat_06/combined.png",
      url: "/static/u/p/director_control_frames/ep001/beat_06/combined.png",
    });

    expect(bundle).toMatchObject({
      schema_version: "director_control_bundle_v1",
      rel_paths: {
        combined: "director_control_frames/ep001/beat_06/combined.png",
        env_only: "director_control_frames/ep001/beat_06/env_only.png",
        frame_meta: "director_control_frames/ep001/beat_06/frame_meta.json",
      },
      urls: {
        combined: "/static/u/p/director_control_frames/ep001/beat_06/combined.png",
        env_only: "/static/u/p/director_control_frames/ep001/beat_06/env_only.png",
        frame_meta: "/static/u/p/director_control_frames/ep001/beat_06/frame_meta.json",
      },
    });
  });

  it("commits director_render replacements through the unified director render helper", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/freezone/AssetLibraryPanel.tsx"),
      "utf8",
    );

    expect(source).toContain("commitDirectorRenderFromCanvasSource(");
    expect(source).not.toContain("已用导演合成 bundle 替换");
  });

  it("labels director render commit success messages as composite asset writes", () => {
    const dialog = readFileSync(
      resolve(process.cwd(), "src/features/freezone/commit/CommitDialog.tsx"),
      "utf8",
    );
    const shell = readFileSync(
      resolve(process.cwd(), "src/features/freezone/FreezoneShell.tsx"),
      "utf8",
    );
    const zh = readFileSync(
      resolve(process.cwd(), "public/locales/zh/translation.json"),
      "utf8",
    );

    // 文案已搬进词条，源码里只剩 key；措辞本身对着 locale 查。
    expect(dialog).toContain('t("freezone.commit.success.directorRender"');
    expect(shell).toContain('t("freezone.commit.success.directorRender"');
    expect(JSON.parse(zh).freezone.commit.success.directorRender).toContain("导演合成资产");
    expect(dialog).not.toContain("导演合成 bundle");
    expect(shell).not.toContain("导演合成 bundle");
    expect(zh).not.toContain("导演合成 bundle");
  });

  it("uses mainline asset wording and keeps current background labels beat-agnostic", () => {
    const panel = readFileSync(
      resolve(process.cwd(), "src/features/freezone/AssetLibraryPanel.tsx"),
      "utf8",
    );
    const selectedBackgroundSlot = readFileSync(
      resolve(process.cwd(), "src/features/canvas/application/selectedBackgroundSlot.ts"),
      "utf8",
    );
    const zh = readFileSync(
      resolve(process.cwd(), "public/locales/zh/translation.json"),
      "utf8",
    );
    const badges = readFileSync(
      resolve(process.cwd(), "src/features/freezone/context/NodeContextBadges.tsx"),
      "utf8",
    );

    // 文案搬进 i18n 之后这两处只剩 key，中文在词条表里；"主线素材" 这个旧叫法
    // 三个文件都不该再出现。
    expect(panel).toContain("freezone.assetPanel.tab.library");
    expect(badges).toContain("freezone.nodeContext.mainlineAsset");
    expect(zh).toContain('"library": "主线资产"');
    expect(zh).toContain('"mainlineAsset": "主线资产"');
    expect(`${panel}\n${badges}\n${zh}`).not.toContain("主线素材");
    expect(panel).not.toContain(">素材库<");
    expect(selectedBackgroundSlot).not.toContain("当前背景 · EP");
    expect(selectedBackgroundSlot).not.toContain("已设置 EP");
    expect(zh).toContain('"selectedBackgroundOutputLabel": "当前背景"');
  });

  it("refreshes the asset library after commits handled outside the library panel", () => {
    const shell = readFileSync(
      resolve(process.cwd(), "src/features/freezone/FreezoneShell.tsx"),
      "utf8",
    );
    const panel = readFileSync(
      resolve(process.cwd(), "src/features/freezone/AssetLibraryPanel.tsx"),
      "utf8",
    );

    expect(shell).toContain("assetLibraryReloadToken");
    expect(shell).toContain("setAssetLibraryReloadToken");
    expect(shell).toContain("reloadToken={assetLibraryReloadToken}");
    expect(panel).toContain("reloadToken?: number");
    expect(panel).toContain("projectAssetsReloadKey");
    expect(panel).toContain("projectAssetsQuery.refetch()");
    expect(panel).toContain("beatContextQuery.refetch()");
  });

  it("carries director bundle through canvas node drag-replace metadata", () => {
    const bundle = {
      rel_paths: {
        combined: "director_control_frames/ep001/beat_06/combined.png",
        env_only: "director_control_frames/ep001/beat_06/env_only.png",
        frame_meta: "director_control_frames/ep001/beat_06/frame_meta.json",
      },
      urls: {
        combined: "/static/u/p/director_control_frames/ep001/beat_06/combined.png",
      },
    };

    const info = deriveNodeDropInfo({
      id: "n1",
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 0 },
      data: {
        imageUrl: "/static/u/p/director_control_frames/ep001/beat_06/combined.png",
        director_control_bundle: bundle,
      },
    });

    expect(info?.directorControlBundle).toEqual(bundle);
  });

  it("exposes pano-backed scene director worlds as committable canvas nodes", () => {
    const info = deriveNodeDropInfo({
      id: "world-1",
      type: CANVAS_NODE_TYPES.threeDWorld,
      position: { x: 0, y: 0 },
      data: {
        sources: [
          {
            id: "pano",
            source_type: "pano360",
            pano_url: "/static/u/p/director_worlds/scene/pano.jpg",
          },
        ],
      },
    });

    expect(info).toMatchObject({
      mediaType: "model",
      sourceUrl: "/static/u/p/director_worlds/scene/pano.jpg",
    });
  });

  it("commits the active director world source instead of a stale top-level model url", () => {
    const info = deriveNodeDropInfo({
      id: "world-1",
      type: CANVAS_NODE_TYPES.threeDWorld,
      position: { x: 0, y: 0 },
      data: {
        plyUrl: "/static/u/p/director_worlds/scene/front.sog",
        activeSourceId: "reverse",
        sources: [
          {
            id: "front",
            source_type: "sog",
            source_kind: "master",
            ply_url: "/static/u/p/director_worlds/scene/front.sog",
          },
          {
            id: "reverse",
            source_type: "sog",
            source_kind: "reverse",
            ply_url: "/static/u/p/director_worlds/scene/reverse.sog",
          },
        ],
      },
    });

    expect(info).toMatchObject({
      mediaType: "model",
      sourceUrl: "/static/u/p/director_worlds/scene/reverse.sog",
    });
  });

  it("does not render director world manifest or model files as image previews", () => {
    expect(usableDirectorWorldPreviewUrl("/static/p/director_worlds/scene/v1/stage_manifest.json")).toBeNull();
    expect(usableDirectorWorldPreviewUrl("/static/p/director_worlds/scene/v1/master_sharp.sog?v=1")).toBeNull();
    expect(usableDirectorWorldPreviewUrl("/static/p/director_worlds/scene/v1/cover.png?v=1")).toBe(
      "/static/p/director_worlds/scene/v1/cover.png?v=1",
    );
  });
});
