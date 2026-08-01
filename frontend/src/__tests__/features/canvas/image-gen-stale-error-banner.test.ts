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
 * 抓出 `updateNodeData(<目标>, { ... })` 里那对花括号的完整内容（按嵌套配平，
 * 因为 slot_target / generationBatch 这些字段本身就是对象字面量）。
 * 目标写法各文件不同：节点自己用 `id`，编辑器浮层用 `nodeId` / `node.id`。
 */
function updateNodeDataPatches(source: string): string[] {
  const patches: string[] = [];
  const opener = /updateNodeData\(\s*[\w.]+\s*,\s*\{/g;
  let match = opener.exec(source);
  while (match !== null) {
    let depth = 0;
    let index = match.index + match[0].length - 1;
    for (; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    patches.push(source.slice(match.index + match[0].length, index));
    opener.lastIndex = index;
    match = opener.exec(source);
  }
  return patches;
}

/** 只管「装上一张新图」的写入；清空（`: null`）不会露出图，无所谓。 */
function installsImage(patch: string): boolean {
  return [
    ...patch.matchAll(/\b(?:imageUrl|previewImageUrl|referenceImageUrl)\s*:\s*([^\s,]+)/g),
  ].some((match) => match[1] !== "null");
}

function staleErrorOffenders(source: string): string[] {
  return updateNodeDataPatches(source).filter(
    (patch) =>
      installsImage(patch) &&
      !patch.includes("GENERATION_ERROR_CLEARED_PATCH") &&
      !patch.includes("buildImageGenerationSuccessPatch"),
  );
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

    expect(staleErrorOffenders(source)).toEqual([]);
  });

  // 四个编辑器浮层都会往节点上写一张新图。超分是唯一原地改写源节点的
  // （其余三个都 addNode 建新结果节点），所以只有它会真的留下上一轮的失败残影；
  // 另外三个一并纳入，是为了挡住「以后被改成原地写」时悄悄退化。
  it.each([
    "src/features/canvas/ui/UpscaleEditorOverlay.tsx",
    "src/features/canvas/ui/EraseOverlay.tsx",
    "src/features/canvas/ui/RedrawOverlay.tsx",
    "src/features/canvas/ui/OutpaintEditorOverlay.tsx",
  ])("clears the failure state on every image write in %s", (path) => {
    expect(staleErrorOffenders(read(path))).toEqual([]);
  });

  // 超分原地复用源节点，所以「开一轮新的」本身就得把上一轮的请求 ID 清掉，
  // 不能等回填成功——中途失败时横幅会挂着上一次的请求 ID。
  it("clears the previous failure when an in-place upscale starts", () => {
    const source = read("src/features/canvas/ui/UpscaleEditorOverlay.tsx");
    const startPatch = updateNodeDataPatches(source).find((patch) =>
      /isGenerating\s*:\s*true/.test(patch),
    );

    expect(startPatch).toBeDefined();
    expect(startPatch).toContain("GENERATION_ERROR_CLEARED_PATCH");
  });

  // 参考图排在显示优先级最后：已有生成图时它顶不到主体，失败信息仍然对得上那张
  // 旧图，不能一上传就清掉。
  it("only clears the banner on reference upload when nothing was generated yet", () => {
    const source = read("src/features/canvas/nodes/ImageGenNode.tsx");
    const uploadPatch = updateNodeDataPatches(source).find((patch) =>
      patch.includes("referenceImageUrl: result.url"),
    );

    expect(uploadPatch).toBeDefined();
    expect(uploadPatch).toContain("hasGeneratedResult ? {} : GENERATION_ERROR_CLEARED_PATCH");
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

  it("invalidates late batch writes when a history image replaces the result", () => {
    const source = read("src/features/canvas/nodes/ImageGenNode.tsx");
    const restoreStart = source.indexOf("const handleRestoreHistory = useCallback");
    const restoreEnd = source.indexOf("// 生成结束（成功/失败）", restoreStart);
    const restoreHandler = source.slice(restoreStart, restoreEnd);
    const submitStart = source.indexOf("const handleSubmit = useCallback");
    const submitEnd = source.indexOf("// ===== Step B", submitStart);
    const submitHandler = source.slice(submitStart, submitEnd);

    expect(source).toContain("const generationAttemptRef = useRef(0)");
    expect(restoreHandler).toContain("generationAttemptRef.current += 1");
    expect(submitHandler).toContain(
      "generationAttemptRef.current === generationAttempt",
    );
    expect(
      submitHandler.match(/if \(!isCurrentGenerationAttempt\(\)\) return;/g),
    ).toHaveLength(3);
  });
});
