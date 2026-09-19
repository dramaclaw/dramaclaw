// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 「替换素材」的两条入口：拖到素材库松手，或者点一下进挑选态再选素材。
 *
 * 点击那条是补的——它本来只绑了 onPointerDown，长得像按钮却点不动，而素材库
 * 默认收起时拖拽根本没有落点。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@xyflow/react', () => ({
  Position: { Left: 'left', Right: 'right' },
  NodeToolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useStore: () => 0,
}));
vi.mock('@/features/canvas/ui/ZoomScaledToolbar', () => ({
  ZoomScaledToolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: (selector: (state: unknown) => unknown) =>
    selector({ hoveredNodeId: null }),
}));

const { useAssetDropStore } = await import('@/stores/assetDropStore');
const { AssetCommitHandle } = await import('@/features/canvas/ui/AssetCommitHandle');

const IMAGE_NODE = {
  id: 'img-1',
  type: 'imageGenNode',
  position: { x: 0, y: 0 },
  data: { displayName: '图片节点 10', imageUrl: '/static/projects/p/a.png' },
} as never;

function press(element: Element, at = { clientX: 10, clientY: 10 }) {
  fireEvent.pointerDown(element, { button: 0, ...at });
}

describe('替换素材：挑选态', () => {
  beforeEach(() => {
    // jsdom 没有实现 elementsFromPoint；拖拽命中判定在真实浏览器里走的就是它。
    document.elementsFromPoint = () => [];
    useAssetDropStore.setState({
      activeDrag: null,
      pendingPick: null,
      hoverAssetId: null,
      pendingReplace: null,
    });
  });

  it('点一下把手（没有位移、没命中素材）进入挑选态，而不是静默什么都不做', () => {
    render(<AssetCommitHandle node={IMAGE_NODE} />);
    press(screen.getByRole('button'));
    expect(useAssetDropStore.getState().activeDrag).not.toBeNull();

    fireEvent.pointerUp(window);

    const { activeDrag, pendingPick } = useAssetDropStore.getState();
    expect(activeDrag).toBeNull();
    expect(pendingPick).toMatchObject({
      nodeId: 'img-1',
      mediaType: 'image',
      sourceUrl: '/static/projects/p/a.png',
    });
  });

  it('拖动过就是拖拽：松手不落在素材上只是取消，不会退化成挑选态', () => {
    render(<AssetCommitHandle node={IMAGE_NODE} />);
    press(screen.getByRole('button'));
    fireEvent.pointerMove(window, { clientX: 200, clientY: 140 });
    fireEvent.pointerUp(window);

    expect(useAssetDropStore.getState().pendingPick).toBeNull();
    expect(useAssetDropStore.getState().activeDrag).toBeNull();
  });

  it('挑选态里选中素材，产出与拖拽同款的替换请求（仍走确认气泡）', () => {
    const store = useAssetDropStore.getState();
    store.beginPick({
      nodeId: 'img-1',
      mediaType: 'image',
      sourceUrl: '/static/projects/p/a.png',
      thumbUrl: null,
      label: '图片节点 10',
      directorControlBundle: null,
    });
    useAssetDropStore.getState().commitPick('asset-7');

    const { pendingPick, pendingReplace } = useAssetDropStore.getState();
    expect(pendingPick).toBeNull();
    expect(pendingReplace).toMatchObject({
      assetId: 'asset-7',
      nodeId: 'img-1',
      sourceUrl: '/static/projects/p/a.png',
      label: '图片节点 10',
    });
  });

  it('改用拖拽会作废挑选态，两个态不并存', () => {
    const pick = {
      nodeId: 'img-1',
      mediaType: 'image' as const,
      sourceUrl: '/static/projects/p/a.png',
      thumbUrl: null,
      label: '图片节点 10',
      directorControlBundle: null,
    };
    useAssetDropStore.getState().beginPick(pick);
    useAssetDropStore.getState().beginDrag(pick);

    expect(useAssetDropStore.getState().pendingPick).toBeNull();
    expect(useAssetDropStore.getState().activeDrag).not.toBeNull();
  });

  it('没有可提交地址的节点既不出把手，也进不了挑选态', () => {
    const { container } = render(
      <AssetCommitHandle
        node={{ ...(IMAGE_NODE as object), data: { displayName: '空图片节点' } } as never}
      />,
    );
    expect(container).toBeEmptyDOMElement();

    useAssetDropStore.getState().beginPick({
      nodeId: 'img-2',
      mediaType: 'image',
      sourceUrl: null,
      thumbUrl: null,
      label: '空图片节点',
      directorControlBundle: null,
    });
    expect(useAssetDropStore.getState().pendingPick).toBeNull();
  });
});
