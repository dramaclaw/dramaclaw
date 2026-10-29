// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { parseObject, parseScene, createDefaultScene } from "@/features/previz/domain/scene";

const TRANSFORM = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

function rawProp(extra: Record<string, unknown> = {}) {
  return {
    id: "blockout-counter",
    kind: "prop",
    name: "counter",
    transform: TRANSFORM,
    visible: true,
    locked: false,
    assetUrl: "cube",
    assetFormat: "primitive",
    ...extra,
  };
}

function rawCamera(extra: Record<string, unknown> = {}) {
  return {
    id: "blockout-cam",
    kind: "camera",
    name: "参考机位",
    transform: TRANSFORM,
    visible: true,
    locked: false,
    focalMm: 28,
    aperture: 2.8,
    sensor: "ff",
    cameraBody: "cine",
    lensSeries: "prime",
    ...extra,
  };
}

describe("previz blockout tag", () => {
  it("keeps the tag on a prop", () => {
    const parsed = parseObject(rawProp({ blockout: { id: "counter", semanticType: "counter" } }));

    expect(parsed).toMatchObject({ blockout: { id: "counter", semanticType: "counter" } });
  });

  it("keeps the tag on a camera", () => {
    const parsed = parseObject(
      rawCamera({ blockout: { id: "cam", semanticType: "reference_camera" } }),
    );

    expect(parsed).toMatchObject({ blockout: { id: "cam", semanticType: "reference_camera" } });
  });

  it("leaves objects without the tag exactly as before", () => {
    // 老场景一个字段都不该多出来：多一个 `blockout: undefined` 也会让存量场景的 JSON 变样。
    expect(parseObject(rawProp())).not.toHaveProperty("blockout");
    expect(parseObject(rawCamera())).not.toHaveProperty("blockout");
  });

  it.each([
    ["not an object", "counter"],
    ["null", null],
    ["missing id", { semanticType: "counter" }],
    ["empty id", { id: "", semanticType: "counter" }],
    ["missing semantic type", { id: "counter" }],
    ["non-string semantic type", { id: "counter", semanticType: 3 }],
    ["overlong id", { id: "x".repeat(65), semanticType: "counter" }],
  ])("drops a malformed tag but keeps the object (%s)", (_label, blockout) => {
    const parsed = parseObject(rawProp({ blockout }));

    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("blockout");
  });

  it("copies only the two known keys", () => {
    const parsed = parseObject(
      rawProp({ blockout: { id: "counter", semanticType: "counter", program: "import os" } }),
    );

    expect(parsed).toMatchObject({ blockout: { id: "counter", semanticType: "counter" } });
    expect((parsed as { blockout: object }).blockout).not.toHaveProperty("program");
  });

  it("ignores the tag on kinds that do not carry it", () => {
    const parsed = parseObject({
      id: "l",
      kind: "light",
      name: "l",
      transform: TRANSFORM,
      lightType: "key",
      color: "#ffffff",
      intensity: 1,
      blockout: { id: "l", semanticType: "prop" },
    });

    expect(parsed).not.toHaveProperty("blockout");
  });

  it("survives a whole-scene round trip", () => {
    const scene = createDefaultScene();
    const stored = JSON.parse(
      JSON.stringify({
        ...scene,
        objects: [
          rawProp({ blockout: { id: "counter", semanticType: "counter" } }),
          rawCamera({ blockout: { id: "cam", semanticType: "reference_camera" } }),
        ],
      }),
    );

    const reparsed = parseScene(stored);

    expect(reparsed.objects.map((object) => (object as { blockout?: unknown }).blockout)).toEqual([
      { id: "counter", semanticType: "counter" },
      { id: "cam", semanticType: "reference_camera" },
    ]);
  });
});
