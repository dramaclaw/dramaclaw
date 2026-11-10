// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { collectImportGraph, importChain, type ImportGraph } from "./importGraph";

const srcRoot = path.resolve(__dirname, "../../..");
const nodeEntry = path.join(srcRoot, "features/canvas/nodeEntry.ts");

/** Packages the Node entry may load. Anything new has to be checked for browser needs first. */
const ALLOWED_PACKAGES = ["i18next", "uuid", "zustand/vanilla"];

/** Local folders that hold the browser app: views, network client, hooks, React stores. */
const BROWSER_ONLY_DIRS = ["api/", "stores/", "hooks/", "components/", "routes/", "lib/"];

/** Globals that exist only in a browser (or jsdom). */
const BROWSER_GLOBALS = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
  "location",
  "history",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "HTMLElement",
  "HTMLCanvasElement",
  "HTMLImageElement",
  "Image",
  "FileReader",
  "ResizeObserver",
  "IntersectionObserver",
  "MutationObserver",
]);

function relative(file: string): string {
  return path.relative(srcRoot, file);
}

/** Problems that would stop the reached modules from loading or running in Node. */
function browserDependencies(graph: ImportGraph): string[] {
  const problems: string[] = [];
  for (const name of [...graph.packages.keys()].sort()) {
    if (!ALLOWED_PACKAGES.includes(name)) {
      const importer = [...graph.packages.get(name)!][0];
      problems.push(`package ${name} via ${importChain(graph, importer, srcRoot)}`);
    }
  }
  for (const file of [...graph.files].sort()) {
    const local = relative(file);
    if (local.endsWith(".tsx")) problems.push(`view module ${importChain(graph, file, srcRoot)}`);
    const dir = BROWSER_ONLY_DIRS.find((prefix) => local.startsWith(prefix));
    if (dir) problems.push(`${dir} module ${importChain(graph, file, srcRoot)}`);
  }
  return problems;
}

/**
 * Browser globals a module reads without first checking `typeof name`. Property
 * names, object keys and types are not reads; a name the module declares in scope
 * (resolved by the type checker, so shadowing is scoped) is not a global.
 */
function unguardedBrowserGlobals(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options);
  const program = ts.createProgram({
    rootNames: [fileName],
    options,
    host: { ...host, getSourceFile: (name) => (name === fileName ? source : undefined) },
  });
  const checker = program.getTypeChecker();
  const declaredHere = (node: ts.Identifier): boolean => {
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    const declarations = symbol?.declarations ?? [];
    return declarations.some((declaration) => declaration.getSourceFile() === source);
  };

  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && BROWSER_GLOBALS.has(node.text)) {
      const parent = node.parent;
      const isName =
        (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) ||
          ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) ||
          ts.isPropertyDeclaration(parent)) &&
        parent.name === node;
      if (!isName && !ts.isTypeOfExpression(parent) && !declaredHere(node) &&
        !isGuarded(node, node.text)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${fileName}:${line + 1} ${node.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function isTypeofCheck(condition: ts.Expression, name: string, operator: ts.SyntaxKind): boolean {
  return (
    ts.isBinaryExpression(condition) &&
    condition.operatorToken.kind === operator &&
    ts.isTypeOfExpression(condition.left) &&
    ts.isIdentifier(condition.left.expression) &&
    condition.left.expression.text === name &&
    ts.isStringLiteral(condition.right) &&
    condition.right.text === "undefined"
  );
}

function exits(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  const [only, ...rest] = ts.isBlock(statement) ? statement.statements : [];
  return only !== undefined && rest.length === 0 && exits(only);
}

/**
 * True when `node` only runs after `typeof name !== 'undefined'` held: in the true
 * branch of that check, or after an earlier `if (typeof name === 'undefined')` that
 * returns or throws.
 */
function isGuarded(node: ts.Node, name: string): boolean {
  const present = ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const absent = ts.SyntaxKind.EqualsEqualsEqualsToken;
  for (let current: ts.Node = node; current.parent; current = current.parent) {
    const parent = current.parent;
    if (ts.isConditionalExpression(parent) && parent.whenTrue === current &&
      isTypeofCheck(parent.condition, name, present)) return true;
    if (ts.isIfStatement(parent) && parent.thenStatement === current &&
      isTypeofCheck(parent.expression, name, present)) return true;
    if (ts.isBinaryExpression(parent) && parent.right === current &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      isTypeofCheck(parent.left, name, present)) return true;
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      const statements = parent.statements;
      const index = statements.indexOf(current as ts.Statement);
      for (const earlier of statements.slice(0, Math.max(index, 0))) {
        if (ts.isIfStatement(earlier) && isTypeofCheck(earlier.expression, name, absent) &&
          exits(earlier.thenStatement)) return true;
      }
    }
  }
  return false;
}

function unguardedBrowserGlobalsIn(file: string): string[] {
  return unguardedBrowserGlobals(relative(file), fs.readFileSync(file, "utf8"));
}

describe("Node canvas entry imports", () => {
  it("reaches no React, view, network or browser store module", () => {
    const graph = collectImportGraph([nodeEntry], srcRoot);

    expect(browserDependencies(graph)).toEqual([]);
    expect([...graph.packages.keys()].sort()).toEqual(ALLOWED_PACKAGES);
  });

  it("reads no browser global without checking that it exists", () => {
    const graph = collectImportGraph([nodeEntry], srcRoot);

    expect([...graph.files].sort().flatMap(unguardedBrowserGlobalsIn)).toEqual([]);
  });

  it("flags the browser canvas store, which wraps the core in React bindings", () => {
    const graph = collectImportGraph([path.join(srcRoot, "stores/canvasStore.ts")], srcRoot);
    const problems = browserDependencies(graph);

    expect(problems).toContain("package zustand via stores/canvasStore.ts");
    expect(problems.some((problem) => problem.startsWith("package react "))).toBe(true);
  });

  it("tells unguarded browser global reads from guarded ones and from plain names", () => {
    const text = [
      "const width = window.innerWidth;",
      "const agent = typeof navigator !== 'undefined' ? navigator.userAgent : '';",
      "function read() {",
      "  if (typeof localStorage === 'undefined') return null;",
      "  return localStorage.getItem('k');",
      "}",
      "const options = { history: 1 };",
      "const size = options.document;",
      "function draw(document: unknown) { return document; }",
      "document.title = 'x';",
    ].join("\n");

    expect(unguardedBrowserGlobals("sample.ts", text)).toEqual([
      "sample.ts:1 window",
      "sample.ts:10 document",
    ]);
  });
});
