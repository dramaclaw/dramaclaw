// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";

import {
  PREVIZ_PROP_MAX_BYTES,
  PREVIZ_PROP_MAX_MB,
  detectPropFormat,
  propSizeMb,
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
      // 2 KB 够不着压缩门槛，原件照旧上传：两个数相等就是「这趟没压」的意思。
      originalBytes: 2048,
      bytes: 2048,
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

  // 超了后端也会 413，传完再被拒是纯粹的浪费——大文件那一趟可能是好几分钟。
  it("rejects a file over the cap without hitting the network, and says how big it is", async () => {
    const { uploadFreezoneImage } = await import("@/api/ops");
    vi.mocked(uploadFreezoneImage).mockClear();

    const size = PREVIZ_PROP_MAX_BYTES + 1;
    await expect(uploadPrevizProp("proj", file("huge.glb", size))).resolves.toEqual({
      ok: false,
      reason: "too-large",
      size,
    });
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });

  // 不合规的文件根本不上网，给它弹「正在上传」再立刻换成错误，看到的是一次闪烁。
  it("does not announce an upload that never happens", async () => {
    const onUploadStart = vi.fn();

    await uploadPrevizProp("proj", file("chair.fbx", 2048), { onUploadStart });
    await uploadPrevizProp("proj", file("huge.glb", PREVIZ_PROP_MAX_BYTES + 1), { onUploadStart });

    expect(onUploadStart).not.toHaveBeenCalled();
  });

  it("announces the upload once before the request goes out", async () => {
    const { uploadFreezoneImage } = await import("@/api/ops");
    vi.mocked(uploadFreezoneImage).mockClear();
    const calls: string[] = [];
    vi.mocked(uploadFreezoneImage).mockImplementationOnce(async () => {
      calls.push("request");
      return { url: "/static/u/p/freezone/_uploads/chair.glb", filename: "chair.glb", size: 1024 };
    });

    await uploadPrevizProp("proj", file("chair.glb", 2048), {
      onUploadStart: () => calls.push("announce"),
    });

    expect(calls).toEqual(["announce", "request"]);
  });

  // 体积检查压在压缩之后：一份 4K 贴图的建筑常常压完只剩零头，先按原始体积一刀切掉
  // 的话，被拒的正是那些最该压、也最压得动的文件。
  it("lets a model that only fits after compression through", async () => {
    const { uploadFreezoneImage } = await import("@/api/ops");
    vi.mocked(uploadFreezoneImage).mockClear();
    const huge = file("cottage.glb", PREVIZ_PROP_MAX_BYTES + 1);

    const result = await uploadPrevizProp("proj", huge, {
      repack: async () => new ArrayBuffer(4096),
    });

    expect(result.ok).toBe(true);
    expect(uploadFreezoneImage).toHaveBeenCalled();
    // 传上去的是压完那份，不是原件。
    expect(vi.mocked(uploadFreezoneImage).mock.calls[0]![1]!.size).toBe(4096);
  });

  // 压不动的超限文件还是要拒，而且报的是压完之后的体积——报原始体积会让用户以为
  // 减面没起作用。
  it("still refuses a model that compression could not save", async () => {
    const { uploadFreezoneImage } = await import("@/api/ops");
    vi.mocked(uploadFreezoneImage).mockClear();
    const size = PREVIZ_PROP_MAX_BYTES + 1;

    await expect(
      uploadPrevizProp("proj", file("cottage.glb", size), {
        repack: async () => new ArrayBuffer(size),
      }),
    ).resolves.toEqual({ ok: false, reason: "too-large", size });
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

describe("size limits", () => {
  // 后端 `_request_body_limit` 卡的是整个请求体，不是文件；multipart 的 boundary 和
  // 文件名也算在里面。卡到 200 MB 整的话，正好 200 MB 的文件会在传完之后才被 413。
  it("stays under the backend body limit with room for the multipart envelope", () => {
    const backendBodyLimit = 200 * 1024 * 1024;
    expect(PREVIZ_PROP_MAX_BYTES).toBeLessThan(backendBodyLimit);
    expect(backendBodyLimit - PREVIZ_PROP_MAX_BYTES).toBe(1024 * 1024);
  });

  // 上限向下取整、体积向上取整，于是被拒文件的显示体积必然严格大于显示上限；
  // 都用同一种取整的话，只超出一个字节的文件会说「199 MB 超过 199 MB」。
  it("never renders a file as no larger than the limit it broke", () => {
    expect(PREVIZ_PROP_MAX_MB).toBe(199);
    expect(propSizeMb(PREVIZ_PROP_MAX_BYTES + 1)).toBeGreaterThan(PREVIZ_PROP_MAX_MB);
    expect(propSizeMb(260 * 1024 * 1024)).toBe(260);
  });
});
