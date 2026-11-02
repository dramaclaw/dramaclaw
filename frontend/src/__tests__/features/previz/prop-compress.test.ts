// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";

import {
  PREVIZ_PROP_COMPRESS_MIN_BYTES,
  PREVIZ_PROP_MAX_TEXTURE_PX,
  compressPrevizProp,
  willCompressPrevizProp,
} from "@/features/previz/propCompress";

function file(name: string, size: number): File {
  const created = new File([new Blob([new Uint8Array(1)])], name);
  Object.defineProperty(created, "size", { value: size });
  return created;
}

/** 交出 `bytes` 个字节的假打包结果。真实现要 three 和 canvas，jsdom 里两样都没有。 */
function repackOf(bytes: number) {
  return vi.fn(async () => new ArrayBuffer(bytes));
}

const BIG = PREVIZ_PROP_COMPRESS_MIN_BYTES;

describe("willCompressPrevizProp", () => {
  it("leaves small models alone", () => {
    expect(willCompressPrevizProp(file("chair.glb", BIG - 1), "glb")).toBe(false);
    expect(willCompressPrevizProp(file("chair.glb", BIG), "glb")).toBe(true);
  });

  // obj 的贴图在另外的 .mtl 和图片文件里，而导入是单文件的：手上这份 obj 既没有贴图
  // 可缩，重新打包还会把它本就没有的材质坐实成没有。
  it("never repacks an obj, however big", () => {
    expect(willCompressPrevizProp(file("city.obj", BIG * 100), "obj")).toBe(false);
  });
});

describe("compressPrevizProp", () => {
  it("hands the compressed glb back in place of the original", async () => {
    const repack = repackOf(BIG / 8);
    const source = file("cottage.gltf", BIG);

    const result = await compressPrevizProp(source, "gltf", { repack });

    expect(result.file).not.toBe(source);
    expect(result.file.size).toBe(BIG / 8);
    expect(result.originalBytes).toBe(BIG);
    // 打包出来的一律是二进制 glb，哪怕进来的是 .gltf——上传的格式得跟着改，
    // 不改的话 loader 会拿 GLTFLoader 的 JSON 分支去读一份二进制文件。
    expect(result.format).toBe("glb");
    expect(result.file.name).toBe("cottage.glb");
    expect(repack).toHaveBeenCalledWith(source, PREVIZ_PROP_MAX_TEXTURE_PX);
  });

  it("skips the repack entirely below the threshold", async () => {
    const repack = repackOf(1);
    const source = file("chair.glb", BIG - 1);

    const result = await compressPrevizProp(source, "glb", { repack });

    expect(result.file).toBe(source);
    expect(repack).not.toHaveBeenCalled();
  });

  // 输入本来就是 Draco / meshopt 压过的 glb 时必然更大：解回来的是未压缩的顶点数据。
  // 这条兜底比「先判断输入压没压过」可靠——那要认全每一种压缩扩展，认漏一个就白白
  // 把模型撑大。
  it("keeps the original when the repack comes out no smaller", async () => {
    const source = file("dense.glb", BIG);

    for (const packed of [BIG, BIG + 1]) {
      const result = await compressPrevizProp(source, "glb", { repack: repackOf(packed) });
      expect(result.file).toBe(source);
      expect(result.format).toBe("glb");
      expect(result.originalBytes).toBe(BIG);
    }
  });

  // 压缩是尽力而为的优化，不该变成一道新的失败关：导出器碰上它不认的贴图格式
  // （KTX2、DataTexture）会当场抛，那时候用户要的是「照旧传上去」，不是一句报错。
  it("falls back to the original when the repack throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = file("exotic.glb", BIG);

    const result = await compressPrevizProp(source, "glb", {
      repack: vi.fn(async () => {
        throw new Error("unsupported texture");
      }),
    });

    expect(result.file).toBe(source);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // 小文件根本不进压缩，给它弹一个「正在压缩」再立刻换成下一条，看到的是一次闪烁。
  it("announces the compression only when one actually happens", async () => {
    const onCompressStart = vi.fn();

    await compressPrevizProp(file("chair.glb", BIG - 1), "glb", {
      repack: repackOf(1),
      onCompressStart,
    });
    expect(onCompressStart).not.toHaveBeenCalled();

    await compressPrevizProp(file("cottage.glb", BIG), "glb", {
      repack: repackOf(1),
      onCompressStart,
    });
    expect(onCompressStart).toHaveBeenCalledTimes(1);
  });
});
