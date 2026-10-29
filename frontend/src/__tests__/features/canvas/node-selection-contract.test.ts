// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 节点内部的程序化选中必须走 selectNodeExclusively：只写 store 的 selectedNodeId
 * 会被 Canvas 的「React Flow → store」同步 effect 在下一次渲染抹回去，
 * 导致 store 选中态和 React Flow selected 态不一致。
 *
 * 清空选中（setSelectedNode(null)）不在本约束内——它配合 onNodesChange 另行处理。
 */
const NODES_DIR = join(process.cwd(), "src/features/canvas/nodes");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("programmatic node selection", () => {
  it("节点内部不再直接调用 setSelectedNode 选中节点", () => {
    const offenders = sourceFiles(NODES_DIR)
      .filter((path) =>
        /(?:store\.|state\.)?setSelectedNode\s*\(\s*(?!null\b)/.test(
          stripComments(readFileSync(path, "utf8")),
        ),
      )
      .map((path) => path.slice(process.cwd().length + 1));

    expect(offenders).toEqual([]);
  });
});
