// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export type ImportEdge = { from: string; specifier: string };

export type ImportGraph = {
  /** Absolute paths of every local module reached through runtime imports. */
  files: Set<string>;
  /** Bare package specifiers reached, mapped to the local files importing them. */
  packages: Map<string, Set<string>>;
  /** Importer of each reached local file, for printing the chain that reached it. */
  parent: Map<string, string>;
};

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"];

function resolveLocal(base: string): string | null {
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const extension of SOURCE_EXTENSIONS) {
    if (fs.existsSync(base + extension)) return base + extension;
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const index = path.join(base, `index${extension}`);
    if (fs.existsSync(index)) return index;
  }
  return null;
}

/**
 * Runtime import specifiers of one module. `import type` and `export type` are
 * erased by the compiler; every other form is kept, including
 * `import { type A } from "x"`, which `verbatimModuleSyntax` emits as a
 * side-effect import, and dynamic `import()`, which a bundle still has to carry.
 */
export function runtimeImportSpecifiers(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

export function collectImportGraph(entries: string[], srcRoot: string): ImportGraph {
  const graph: ImportGraph = { files: new Set(), packages: new Map(), parent: new Map() };
  const queue = [...entries];
  for (const entry of entries) graph.files.add(entry);
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (file.endsWith(".json")) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const specifier of runtimeImportSpecifiers(file, text)) {
      const bare = specifier.split("?")[0];
      let target: string | null = null;
      if (bare.startsWith("@/")) target = resolveLocal(path.join(srcRoot, bare.slice(2)));
      else if (bare.startsWith(".")) target = resolveLocal(path.resolve(path.dirname(file), bare));
      else {
        // Keep the full subpath: `zustand/vanilla` and `zustand` are different modules.
        if (!graph.packages.has(bare)) graph.packages.set(bare, new Set());
        graph.packages.get(bare)!.add(file);
        continue;
      }
      if (!target) throw new Error(`unresolved import ${specifier} from ${file}`);
      if (!graph.files.has(target)) {
        graph.files.add(target);
        graph.parent.set(target, file);
        queue.push(target);
      }
    }
  }
  return graph;
}

export function importChain(graph: ImportGraph, file: string, srcRoot: string): string {
  const chain = [file];
  let current = graph.parent.get(file);
  while (current) {
    chain.unshift(current);
    current = graph.parent.get(current);
  }
  return chain.map((item) => path.relative(srcRoot, item)).join(" -> ");
}
