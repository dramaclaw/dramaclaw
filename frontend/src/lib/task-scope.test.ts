import { describe, expect, it } from "vitest";

import {
  propReferenceAssetScope,
  sceneReferenceAssetScope,
  stageAssetScope,
} from "./task-scope";

// Golden values produced by the backend's own helpers
// (novelvideo.task_scopes) so the FE hash stays byte-compatible with the
// scope stored on task rows. If these drift, `useTaskController` reconcile
// stops matching and loading state is lost on refresh.
describe("task-scope hashing matches the backend", () => {
  it("scene_reference_asset_scope", () => {
    expect(sceneReferenceAssetScope("大学宿舍", "master")).toBe(
      "scene_ref__f126561a8bba",
    );
    // `reverse_master` is the kind the BE uses for the 背面 image (not "reverse").
    expect(sceneReferenceAssetScope("大学宿舍", "reverse_master")).toBe(
      "scene_ref__02e6e3b31892",
    );
    expect(sceneReferenceAssetScope("苏鸢寝殿", "master")).toBe(
      "scene_ref__d902739345bd",
    );
    expect(sceneReferenceAssetScope("苏鸢寝殿", "reverse_master")).toBe(
      "scene_ref__c99c0228dd85",
    );
  });

  it("stage_asset_scope", () => {
    expect(stageAssetScope("大学宿舍", "pano_from_master")).toBe(
      "stage_asset__0060da8d52de",
    );
    expect(stageAssetScope("大学宿舍", "pano_from_text")).toBe(
      "stage_asset__03118b334715",
    );
    expect(stageAssetScope("大学宿舍", "single_face_sharp")).toBe(
      "stage_asset__a1b352c6307b",
    );
    expect(stageAssetScope("大学宿舍", "pano_sharp")).toBe(
      "stage_asset__f3813dfc19bc",
    );
    expect(stageAssetScope("苏鸢寝殿", "pano_from_master")).toBe(
      "stage_asset__f70b565fb943",
    );
    expect(stageAssetScope("苏鸢寝殿", "pano_sharp")).toBe(
      "stage_asset__d81c1edae22e",
    );
  });

  it("prop_reference_asset_scope", () => {
    expect(propReferenceAssetScope("道具A")).toBe("prop_ref__a6d6813f7e52");
    expect(propReferenceAssetScope("sword")).toBe("prop_ref__d36303bf3afe");
    expect(propReferenceAssetScope("宝剑")).toBe("prop_ref__a87302d6d2cc");
  });
});
