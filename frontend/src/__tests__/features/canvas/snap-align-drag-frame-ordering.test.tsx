// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { render } from '@testing-library/react';
import { useCallback, useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';

// createSnapAlignDragSession 把 positionOffset 算成
// `getInternalNode(id).internals.positionAbsolute - node.position`，并在整段拖动里
// 复用这个值。只有当会话建立的那一帧里，两个来源取自同一帧，offset 才是纯粹的父级
// 偏移；否则首帧位移会被混进 offset，之后每条吸附线都整体偏移。
//
// 这条契约依赖 React Flow 的更新顺序：拖动循环改的是 getDragItems() 复制出来的
// dragItem（内含全新的 internals 对象），updateNodePositions 只负责把 change 交给
// onNodesChange，两者都不会写 nodeLookup。nodeLookup 的 positionAbsolute 只在受控
// nodes 重新流入时刷新。所以 onNodesChange 里读到的 positionAbsolute 不会领先受控
// store。这里用真实拖动链路把该顺序钉住，升级 React Flow 时如果变了就会红。

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function installDomStubs() {
  // jsdom 缺这两样：React Flow 用 ResizeObserver 量节点，用 DOMMatrixReadOnly.m22
  // 读缩放。走 Object.assign 赋值，免得为签名差异散一堆 ts-expect-error。
  Object.assign(globalThis, {
    ResizeObserver: StubResizeObserver,
    DOMMatrixReadOnly: class {
      m22 = 1;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 100 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 100 });
}

type Frame = {
  changePosition: { x: number; y: number };
  internalAbsolute: { x: number; y: number };
  storePosition: { x: number; y: number };
};

function Harness({ frames }: { frames: Frame[] }) {
  const rf = useReactFlow();
  const nodesRef = useRef<Node[]>([
    {
      id: 'a',
      position: { x: 0, y: 0 },
      data: {},
      width: 100,
      height: 100,
      measured: { width: 100, height: 100 },
    },
  ]);
  const [nodes, setNodes] = useState<Node[]>(nodesRef.current);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      for (const change of changes) {
        if (change.type !== 'position' || !change.position) continue;
        const internal = rf.getInternalNode(change.id);
        const stored = nodesRef.current.find((n) => n.id === change.id);
        if (!internal || !stored) continue;
        // 采样必须发生在 applyNodesChange 之前——Canvas.tsx 建立吸附会话的时机同此。
        frames.push({
          changePosition: { ...change.position },
          internalAbsolute: { ...internal.internals.positionAbsolute },
          storePosition: { ...stored.position },
        });
        const next = nodesRef.current.map((n) =>
          n.id === change.id ? { ...n, position: { ...change.position! } } : n,
        );
        nodesRef.current = next;
        setNodes(next);
      }
    },
    [rf, frames],
  );

  return (
    <div style={{ width: 800, height: 600 }}>
      <ReactFlow nodes={nodes} edges={[]} onNodesChange={onNodesChange} />
    </div>
  );
}

// jsdom 不接受构造参数里的 view，但 d3-drag 的 nodrag() 会读 event.view.document，
// 所以构造后再补一个 view 属性。
function dispatchMouse(type: string, target: EventTarget, clientX: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY: 0,
    button: 0,
    buttons: type === 'mouseup' ? 0 : 1,
  });
  Object.defineProperty(event, 'view', { value: window });
  target.dispatchEvent(event);
}

describe('snap-align 依赖的拖动帧顺序', () => {
  it('会话建立那一帧，internals.positionAbsolute 不领先受控 store', () => {
    installDomStubs();
    const frames: Frame[] = [];

    const { container } = render(
      <ReactFlowProvider>
        <Harness frames={frames} />
      </ReactFlowProvider>,
    );
    const nodeEl = container.querySelector('.react-flow__node');
    expect(nodeEl).not.toBeNull();

    dispatchMouse('mousedown', nodeEl!, 0);
    for (const step of [2, 5, 9]) dispatchMouse('mousemove', document, step);
    dispatchMouse('mouseup', document, 9);

    expect(frames.length).toBeGreaterThan(0);

    // 首帧 = 吸附会话建立的那一帧。positionAbsolute 必须还等于受控 store 的位置，
    // 而不是本帧的新坐标——否则 positionOffset 会把首帧位移吃进去。
    const first = frames[0];
    expect(first.internalAbsolute).toEqual(first.storePosition);
    expect(first.changePosition).not.toEqual(first.storePosition);

    // 这个节点没有父级，所以推导出来的 offset 必须是 0，不能带上首帧位移。
    const positionOffset = {
      x: first.internalAbsolute.x - first.storePosition.x,
      y: first.internalAbsolute.y - first.storePosition.y,
    };
    expect(positionOffset).toEqual({ x: 0, y: 0 });
  });
});
