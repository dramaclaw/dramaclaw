// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installDomReconciliationGuard,
  resetDomReconciliationGuardForTests,
} from "@/lib/dom-reconciliation-guard";

// 原生方法引用,用于每个用例后还原 prototype,避免污染其它测试。
const nativeRemoveChild = Node.prototype.removeChild;
const nativeInsertBefore = Node.prototype.insertBefore;

describe("installDomReconciliationGuard", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    Node.prototype.removeChild = nativeRemoveChild;
    Node.prototype.insertBefore = nativeInsertBefore;
    resetDomReconciliationGuardForTests();
    vi.restoreAllMocks();
  });

  it("不再抛错:翻译器把文本节点搬进 <font> 后,React 删除原节点", () => {
    installDomReconciliationGuard();

    // 复现真实场景:<p> 里有一个文本节点,翻译插件把它移进新建的 <font>。
    const p = document.createElement("p");
    const text = document.createTextNode("Hello ");
    p.appendChild(text);

    const font = document.createElement("font");
    font.appendChild(text); // text 的 parentNode 从 <p> 变成 <font>

    // React 仍以为 text 是 <p> 的子节点,协调时会 p.removeChild(text)。
    expect(() => p.removeChild(text)).not.toThrow();
    // 节点没被误删,仍挂在翻译器的 <font> 下。
    expect(text.parentNode).toBe(font);
  });

  it("正常删除仍然生效", () => {
    installDomReconciliationGuard();

    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.appendChild(child);

    parent.removeChild(child);
    expect(child.parentNode).toBeNull();
    expect(parent.childNodes.length).toBe(0);
  });

  it("insertBefore 参照节点父节点错位时退化为追加,不抛错", () => {
    installDomReconciliationGuard();

    const parent = document.createElement("div");
    const orphanRef = document.createElement("i"); // 不是 parent 的子节点
    const inserted = document.createElement("b");

    expect(() => parent.insertBefore(inserted, orphanRef)).not.toThrow();
    // 退化为 appendChild:新节点仍进入了 parent。
    expect(inserted.parentNode).toBe(parent);
  });

  it("insertBefore 正常路径保持原有顺序语义", () => {
    installDomReconciliationGuard();

    const parent = document.createElement("div");
    const first = document.createElement("span");
    const ref = document.createElement("span");
    parent.appendChild(ref);

    parent.insertBefore(first, ref);
    expect(parent.firstChild).toBe(first);
    expect(parent.childNodes[1]).toBe(ref);
  });
});
