// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 跨项目粘贴占位遮罩：复制中转圈、失败（或标记残留但任务已不在）出错误占位 + 移除。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const copyFreezoneAssets = vi.hoisted(() => vi.fn());
const deleteNode = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', () => ({ copyFreezoneAssets }));
vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: { getState: () => ({ deleteNode }) },
}));

const { AssetMigrationNodeOverlay } = await import('@/features/canvas/ui/AssetMigrationNodeOverlay');
const { migratePastedNodeAssets } = await import('@/features/canvas/application/crossProjectAssets');

const SOURCE = '/static/projects/projA/images/a.png';

describe('AssetMigrationNodeOverlay', () => {
  beforeEach(() => {
    copyFreezoneAssets.mockReset();
    deleteNode.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing for an ordinary node', () => {
    const { container } = render(
      <AssetMigrationNodeOverlay nodeId="n1" data={{ imageUrl: '/static/projects/projB/x.png' }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the copying placeholder while the migration runs, then the error placeholder if the marker outlives it', async () => {
    let resolveCopy: (value: unknown) => void = () => undefined;
    copyFreezoneAssets.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCopy = resolve;
        }),
    );
    const pending = migratePastedNodeAssets({
      nodes: [{ id: 'n1', withheld: [{ path: ['imageUrl'], url: SOURCE }] }],
      targetProject: 'projB',
      // 节点在拷贝期间被删掉了：填回步骤跳过，store 里（这个测试用静态 data 模拟）标记残留。
      getLiveNodeData: () => null,
      updateNodeData: () => undefined,
    });

    render(<AssetMigrationNodeOverlay nodeId="n1" data={{ imageUrl: null, assetMigration: 'copying' }} />);
    expect(screen.getByTestId('asset-migration-copying')).toBeInTheDocument();
    expect(screen.getByText('素材复制中…')).toBeInTheDocument();
    expect(screen.queryByTestId('asset-migration-failed')).toBeNull();

    await act(async () => {
      resolveCopy({ mapping: { [SOURCE]: '/static/projects/projB/freezone/_uploads/a.png' }, failed: [] });
      await pending;
    });

    // 任务结束而标记还是 copying（刷新后落库的残留、或节点已不在填回名单里）→ 按失败占位。
    expect(screen.queryByTestId('asset-migration-copying')).toBeNull();
    expect(screen.getByTestId('asset-migration-failed')).toBeInTheDocument();
  });

  it('treats a persisted copying marker with no running migration as failed (after a reload)', () => {
    render(<AssetMigrationNodeOverlay nodeId="stale" data={{ imageUrl: null, assetMigration: 'copying' }} />);
    expect(screen.getByTestId('asset-migration-failed')).toBeInTheDocument();
    expect(screen.getByText('素材复制失败，请删除后重新粘贴')).toBeInTheDocument();
  });

  it('lets the user remove a failed placeholder node', () => {
    render(<AssetMigrationNodeOverlay nodeId="n9" data={{ imageUrl: null, assetMigration: 'failed' }} />);
    fireEvent.click(screen.getByRole('button', { name: '移除节点' }));
    expect(deleteNode).toHaveBeenCalledWith('n9');
  });
});
