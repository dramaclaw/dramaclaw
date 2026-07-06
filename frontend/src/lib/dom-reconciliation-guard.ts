// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

// 浏览器 / webview 的「翻译此页」(Chrome、Edge、微信内置浏览器)以及部分扩展,
// 会直接改写 React 托管的 DOM:把文本节点搬进新插入的 <font> 容器、或整段替换。
// 等 React 下一次协调想对原节点执行 removeChild / insertBefore 时,该节点的
// parentNode 已经不是 React 记忆里的那个父节点,浏览器便抛:
//   NotFoundError: 未能在"节点"上执行"removeChild":被移除的节点不是该节点的子节点
// 这个异常未被业务代码捕获,冒泡到根错误边界,整页变成「页面加载失败」。
//
// React 官方 issue facebook/react#11538 给出的通行缓解:给这两个原型方法加一层
// 防御——当目标节点的父节点对不上时,静默跳过(或改为追加)而不是抛错。翻译插件
// 照常工作,React 只是不再因它的 DOM 改写而崩。仅在「父节点不匹配」这一异常路径
// 短路,正常路径完全走原生实现,无副作用、无性能影响。

let installed = false;

export function installDomReconciliationGuard(): void {
  if (installed) return;
  if (typeof Node !== "function" || !Node.prototype) return;
  installed = true;

  const originalRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function guardedRemoveChild<T extends Node>(
    this: Node,
    child: T,
  ): T {
    if (child.parentNode !== this) {
      // 节点已被翻译器搬到别的父节点下,原生调用必抛。当作删除已完成,把 child
      // 还回去:React 会丢弃对它的引用,残留节点随翻译器容器一起被清理。
      if (typeof console !== "undefined") {
        console.warn("[dom-guard] removeChild 目标节点的父节点已变更,跳过", child);
      }
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };

  const originalInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function guardedInsertBefore<T extends Node>(
    this: Node,
    newNode: T,
    referenceNode: Node | null,
  ): T {
    if (referenceNode && referenceNode.parentNode !== this) {
      // 参照节点已被翻译器搬走,无法在它前面插入。退化为追加(insertBefore(node, null)
      // 等价于 appendChild),保证新节点仍进入 DOM,React 下一轮协调会自行纠正顺序。
      if (typeof console !== "undefined") {
        console.warn("[dom-guard] insertBefore 参照节点的父节点已变更,改为追加", newNode);
      }
      return originalInsertBefore.call(this, newNode, null) as T;
    }
    return originalInsertBefore.call(this, newNode, referenceNode) as T;
  };
}

export function resetDomReconciliationGuardForTests(): void {
  installed = false;
}
