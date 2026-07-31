// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  GENERATION_ERROR_CLEARED_PATCH,
  buildImageGenerationSuccessPatch,
} from "@/features/canvas/application/generationTaskArbitration";

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

/**
 * 抓出 `updateNodeData(id, { ... })` 里那对花括号的完整内容（按嵌套配平，
 * 因为 slot_target / generationBatch 这些字段本身就是对象字面量）。
 */
function updateNodeDataPatches(source: string): string[] {
  const patches: string[] = [];
  const opener = "updateNodeData(id, {";
  let cursor = source.indexOf(opener);
  while (cursor !== -1) {
    let depth = 0;
    let index = cursor + opener.length - 1;
    for (; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    patches.push(source.slice(cursor + opener.length, index));
    cursor = source.indexOf(opener, index);
  }
  return patches;
}

describe("stale generation-error banner", () => {
  it("clears every field the failure overlay reads", () => {
    // 浮层读这三个字段（文案 / 详情 / 请求 ID），少清一个就会留下残影。
    expect(Object.keys(GENERATION_ERROR_CLEARED_PATCH).sort()).toEqual([
      "generationError",
      "generationErrorDetails",
      "generationErrorRequestId",
    ]);
    expect(Object.values(GENERATION_ERROR_CLEARED_PATCH)).toEqual([null, null, null]);
    expect(buildImageGenerationSuccessPatch("https://x/y.png")).toMatchObject(
      GENERATION_ERROR_CLEARED_PATCH,
    );
  });

  it("clears the failure state on every in-place image write in ImageGenNode", () => {
    const source = read("src/features/canvas/nodes/ImageGenNode.tsx");

    // 失败横幅是 absolute 盖在图上的，只要节点换了新图却没清错误字段，
    // 上一次的「生成失败」就会糊在新图上面。
    expect(source).toContain("{!isGenerating && generationError && (");

    // 只管「装上一张新图」的写入；清空（`: null`）不会露出图，无所谓。
    const installsImage = (patch: string): boolean =>
      [...patch.matchAll(/\b(?:imageUrl|previewImageUrl|referenceImageUrl)\s*:\s*([^\s,]+)/g)].some(
        (match) => match[1] !== "null",
      );
    const offenders = updateNodeDataPatches(source).filter(
      (patch) =>
        installsImage(patch) &&
        !patch.includes("GENERATION_ERROR_CLEARED_PATCH") &&
        !patch.includes("buildImageGenerationSuccessPatch"),
    );

    expect(offenders).toEqual([]);
  });

  it("clears the request id alongside the message in the Canvas job poller", () => {
    const source = read("src/features/canvas/Canvas.tsx");
    const successPatch = source.slice(
      source.indexOf("generationStoryboardMetadata: undefined,"),
      source.indexOf("generationDebugContext: undefined,"),
    );

    expect(successPatch).toContain("generationError: null,");
    expect(successPatch).toContain("generationErrorDetails: null,");
    expect(successPatch).toContain("generationErrorRequestId: null,");
  });
});
