// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { surfaceAccess } from "@/lib/queries/product-surfaces";

describe("product surface access", () => {
  it("finds the requested fixed product surface", () => {
    const data = {
      ok: true as const,
      data: {
        items: [
          {
            surface_code: "mainline" as const,
            label: "主线",
            available: true,
            unavailable_message: "主线功能暂未开放",
          },
          {
            surface_code: "assistant" as const,
            label: "虾导",
            available: false,
            unavailable_message: "虾导功能暂未开放",
          },
        ],
      },
    };

    expect(surfaceAccess(data, "assistant")).toMatchObject({
      available: false,
      unavailable_message: "虾导功能暂未开放",
    });
    expect(surfaceAccess(data, "freezone")).toBeUndefined();
  });
});
