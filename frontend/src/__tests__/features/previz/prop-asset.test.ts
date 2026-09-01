// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";

import {
  PREVIZ_PROP_MAX_BYTES,
  detectPropFormat,
  uploadPrevizProp,
} from "@/features/previz/propAsset";

vi.mock("@/api/ops", () => ({
  uploadFreezoneImage: vi.fn(async () => ({
    url: "/static/u/p/freezone/_uploads/chair.glb",
    filename: "chair.glb",
    size: 1024,
  })),
}));

function file(name: string, size: number): File {
  const blob = new Blob([new Uint8Array(1)]);
  const created = new File([blob], name);
  Object.defineProperty(created, "size", { value: size });
  return created;
}

describe("detectPropFormat", () => {
  it("reads the format off the extension, case-insensitively", () => {
    expect(detectPropFormat("Chair.GLB")).toBe("glb");
    expect(detectPropFormat("chair.gltf")).toBe("gltf");
    expect(detectPropFormat("chair.obj")).toBe("obj");
  });

  it("returns null for anything else", () => {
    expect(detectPropFormat("chair.fbx")).toBeNull();
    expect(detectPropFormat("chair")).toBeNull();
  });

  // 扩展名表是普通对象，直接索引会从原型链上取到 `constructor` / `toString` 这类键。
  // 拿到的是个函数而不是 undefined，`?? null` 兜不住，于是 `chair.constructor` 会被
  // 当成合法模型放行，一路走到 loader 才炸。同 `domain/scene.ts` 的 `isMember`。
  it("does not mistake prototype keys for formats", () => {
    expect(detectPropFormat("chair.constructor")).toBeNull();
    expect(detectPropFormat("chair.toString")).toBeNull();
  });
});

describe("uploadPrevizProp", () => {
  it("uploads a supported model and reports its url and format", async () => {
    const result = await uploadPrevizProp("proj", file("chair.glb", 2048));

    expect(result).toEqual({
      ok: true,
      assetUrl: "/static/u/p/freezone/_uploads/chair.glb",
      assetFormat: "glb",
      name: "chair",
    });
  });

  it("rejects an unsupported extension without hitting the network", async () => {
    const { uploadFreezoneImage } = await import("@/api/ops");
    vi.mocked(uploadFreezoneImage).mockClear();

    await expect(uploadPrevizProp("proj", file("chair.fbx", 2048))).resolves.toEqual({
      ok: false,
      reason: "format",
    });
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });

  // 后端 multipart 上限是 200 MB，但 100 MB 的 GLB 在预演台里解码就要几秒、
  // 显存也扛不住。早点拦比传完再失望便宜。
  it("rejects a file over the client-side cap without hitting the network", async () => {
    const { uploadFreezoneImage } = await import("@/api/ops");
    vi.mocked(uploadFreezoneImage).mockClear();

    await expect(
      uploadPrevizProp("proj", file("huge.glb", PREVIZ_PROP_MAX_BYTES + 1)),
    ).resolves.toEqual({ ok: false, reason: "too-large" });
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });

  it("reports an upload failure instead of throwing", async () => {
    const { uploadFreezoneImage } = await import("@/api/ops");
    vi.mocked(uploadFreezoneImage).mockRejectedValueOnce(new Error("boom"));

    await expect(uploadPrevizProp("proj", file("chair.glb", 2048))).resolves.toEqual({
      ok: false,
      reason: "upload",
    });
  });
});
