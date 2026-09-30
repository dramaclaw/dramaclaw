// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { blockoutTone } from "@/features/previz/domain/blockout";
import type { PrevizObject } from "@/features/previz/domain/scene";

function prop(semanticType?: string): PrevizObject {
  return {
    kind: "prop",
    assetUrl: "cube",
    assetFormat: "primitive",
    ...(semanticType ? { blockout: { id: "piece", semanticType } } : {}),
  } as PrevizObject;
}

describe("blockoutTone", () => {
  it.each(["wall", "floor"])("reads a %s as part of the set", (semanticType) => {
    expect(blockoutTone(prop(semanticType))).toBe("structure");
  });

  // 语义类别是模型写的，列不完；认不出来的一律算摆在布景里的东西。
  it.each(["table", "platform", "prop", "glass_partition"])(
    "reads a %s as a piece standing in the set",
    (semanticType) => {
      expect(blockoutTone(prop(semanticType))).toBe("piece");
    },
  );

  it("has no tone for a prop the user placed by hand", () => {
    expect(blockoutTone(prop())).toBeNull();
  });

  // 参考机位也带白模标记，但它是一台摄影机，颜色由机位模型自己管。
  it("has no tone for the reference camera", () => {
    const camera = {
      kind: "camera",
      blockout: { id: "cam", semanticType: "reference_camera" },
    } as PrevizObject;

    expect(blockoutTone(camera)).toBeNull();
  });
});
