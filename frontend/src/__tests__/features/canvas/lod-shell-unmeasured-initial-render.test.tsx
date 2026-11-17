// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 回归：首屏强制渲染那一遍不能挂完整组件、不能发媒体请求。
 *
 * onlyRenderVisibleElements 对没有 handleBounds 的节点一律强制渲染
 * （@xyflow/system getNodesInside 的 forceInitialRender），首屏会把画布上全部
 * 节点挂一遍再裁剪。冷加载实测 575 个节点在这一遍里以完整组件挂上，屏外的
 * 285 张原图（421MB）和 175 个视频在同一次提交里全部发出请求。
 *
 * 这里锁三件事（缩放 1，高于低缩放阈值，排除 lowDetail 的干扰）：
 *   1. 未测量的节点渲染 shell，且 shell 里没有 <img>；
 *   2. 测量完成（handleBounds 写入）后经升级队列换成完整组件；
 *   3. 被选中的节点（如刚放置的新节点）不受影响，直接是完整组件。
 */
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const measured = new Set<string>();
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  useStore: (selector: (state: unknown) => unknown) =>
    selector({
      transform: [0, 0, 1],
      nodeLookup: {
        get: (id: string) => ({
          internals: { handleBounds: measured.has(id) ? { source: [], target: [] } : undefined },
        }),
      },
    }),
}));

let selectedNodeId: string | null = null;
vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: (selector: (state: { selectedNodeId: string | null }) => unknown) =>
    selector({ selectedNodeId }),
}));

const { withLodShell } = await import('@/features/canvas/nodes/LodShellNode');

function ImageStub() {
  return <div data-testid="full-image-node">full</div>;
}

const WrappedImageNode = withLodShell('imageGenNode', ImageStub);

function renderNode(id: string) {
  return render(
    <WrappedImageNode
      id={id}
      type="imageGenNode"
      data={{ imageUrl: '/static/projects/p/freezone/_outputs/a.png' }}
      selected={false}
      width={580}
      height={360}
      dragging={false}
      zIndex={0}
      isConnectable
      positionAbsoluteX={0}
      positionAbsoluteY={0}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {...({} as any)}
    />,
  );
}

async function flushUpgradeQueue() {
  // 升级队列按帧放行（rAF），推进几帧即可。
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
  }
}

describe('withLodShell 首次测量前', () => {
  beforeEach(() => {
    measured.clear();
    selectedNodeId = null;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('未测量的节点出不带图片的 shell', () => {
    const { container, queryByTestId } = renderNode('n1');
    expect(queryByTestId('full-image-node')).toBeNull();
    expect(container.querySelector('.dc-lod-shell')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('测量完成后升级成完整组件', async () => {
    const view = renderNode('n2');
    expect(view.queryByTestId('full-image-node')).toBeNull();

    measured.add('n2');
    view.rerender(
      <WrappedImageNode
        id="n2"
        type="imageGenNode"
        data={{ imageUrl: '/static/projects/p/freezone/_outputs/a.png' }}
        selected={false}
        width={580}
        height={360}
        dragging={false}
        zIndex={0}
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {...({} as any)}
      />,
    );
    await flushUpgradeQueue();
    expect(view.queryByTestId('full-image-node')).not.toBeNull();
  });

  it('选中的节点不等测量，直接是完整组件', () => {
    selectedNodeId = 'n3';
    const { queryByTestId } = renderNode('n3');
    expect(queryByTestId('full-image-node')).not.toBeNull();
  });
});
