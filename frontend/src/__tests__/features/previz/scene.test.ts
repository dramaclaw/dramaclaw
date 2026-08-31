// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  PREVIZ_DEFAULT_DURATION_FRAMES,
  PREVIZ_FPS,
  PREVIZ_MAX_DURATION_FRAMES,
  PREVIZ_SCHEMA_VERSION,
  PrevizSceneVersionError,
  createDefaultScene,
  parseScene,
} from "@/features/previz/domain/scene";

describe("previz scene schema", () => {
  it("creates an empty scene at the current schema version", () => {
    const scene = createDefaultScene();

    expect(scene.schemaVersion).toBe(PREVIZ_SCHEMA_VERSION);
    expect(scene.settings.fps).toBe(PREVIZ_FPS);
    expect(scene.settings.durationFrames).toBe(120);
    expect(scene.settings.outputAspect).toBe("16:9");
    expect(scene.objects).toEqual([]);
    expect(scene.timeline.tracks).toEqual([]);
  });

  it("falls back to a default scene for absent or non-object input", () => {
    expect(parseScene(undefined)).toEqual(createDefaultScene());
    expect(parseScene(null)).toEqual(createDefaultScene());
    expect(parseScene("not a scene")).toEqual(createDefaultScene());
  });

  it("round-trips a scene through JSON without losing objects or tracks", () => {
    const scene = createDefaultScene();
    scene.objects.push({
      id: "cam-1",
      kind: "camera",
      name: "主机位",
      transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
      visible: true,
      locked: false,
      focalMm: 35,
      aperture: 2.8,
      sensor: "ff",
    });
    scene.timeline.tracks.push({ id: "track-1", objectId: "cam-1", clips: [] });

    const parsed = parseScene(JSON.parse(JSON.stringify(scene)));

    expect(parsed).toEqual(scene);
  });

  it("rejects a scene written by a newer implementation", () => {
    expect(() => parseScene({ schemaVersion: PREVIZ_SCHEMA_VERSION + 1 })).toThrow(
      PrevizSceneVersionError,
    );
  });

  it("clamps duration into the supported frame range", () => {
    expect(parseScene({ settings: { durationFrames: 0 } }).settings.durationFrames).toBe(1);
    expect(parseScene({ settings: { durationFrames: 9999 } }).settings.durationFrames).toBe(
      PREVIZ_MAX_DURATION_FRAMES,
    );
    expect(parseScene({ settings: { durationFrames: 90.6 } }).settings.durationFrames).toBe(91);
  });

  it("falls back to the default duration for non-numeric input", () => {
    expect(parseScene({ settings: { durationFrames: "abc" } }).settings.durationFrames).toBe(
      PREVIZ_DEFAULT_DURATION_FRAMES,
    );
    expect(parseScene({ settings: { durationFrames: NaN } }).settings.durationFrames).toBe(
      PREVIZ_DEFAULT_DURATION_FRAMES,
    );
  });

  it("falls back to the default value for an invalid displayMode or outputAspect", () => {
    expect(parseScene({ settings: { displayMode: "wireframe" } }).settings.displayMode).toBe(
      "solid",
    );
    expect(parseScene({ settings: { outputAspect: 42 } }).settings.outputAspect).toBe("16:9");
  });

  it("does not throw and falls back to empty arrays for malformed objects or timeline", () => {
    expect(() => parseScene({ timeline: "oops" })).not.toThrow();
    expect(parseScene({ timeline: "oops" }).timeline.tracks).toEqual([]);

    expect(() => parseScene({ objects: "oops" })).not.toThrow();
    expect(parseScene({ objects: "oops" }).objects).toEqual([]);
  });

  it("copies objects and tracks instead of sharing the input's array references", () => {
    const rawObjects: unknown[] = [];
    const rawTracks: unknown[] = [];
    const raw = { objects: rawObjects, timeline: { tracks: rawTracks } };

    const parsed = parseScene(raw);

    expect(parsed.objects).not.toBe(rawObjects);
    expect(parsed.timeline.tracks).not.toBe(rawTracks);
  });
});
