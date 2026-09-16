// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 读取期诊断：后端在 GET 里报出画布仍在服务的外项目引用，前端据此把那些节点标出来
 * 并给一键修复，而不是留给用户一片没有解释的裂图。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const copyFreezoneAssets = vi.hoisted(() => vi.fn());
const updateNodeData = vi.hoisted(() => vi.fn());
const nodes = vi.hoisted(() => [] as Array<{ id: string; data: unknown }>);

vi.mock('@/api/ops', () => ({ copyFreezoneAssets }));
vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: { getState: () => ({ nodes, updateNodeData }) },
}));

const {
  clearForeignMediaRefs,
  publishForeignMediaRefs,
  readForeignMediaRefsForNode,
} = await import('@/features/canvas/application/canvasMediaScope');
const { ForeignMediaNodeOverlay } = await import(
  '@/features/canvas/ui/ForeignMediaNodeOverlay'
);

const FOREIGN = '/static/projects/projA/freezone/_uploads/a.png';
const COPIED = '/static/projects/projB/freezone/_uploads/a.png';
const REF = {
  node_id: 'n1',
  field: 'imageUrl',
  url: FOREIGN,
  source_project_id: 'projA',
};

describe('foreign media registry', () => {
  beforeEach(() => {
    clearForeignMediaRefs();
    copyFreezoneAssets.mockReset();
    updateNodeData.mockReset();
    nodes.length = 0;
  });
  afterEach(() => {
    clearForeignMediaRefs();
  });

  it('indexes the published refs by node', () => {
    publishForeignMediaRefs('projB', 'default', [REF, { ...REF, node_id: 'n2' }]);
    expect(readForeignMediaRefsForNode('n1')).toEqual([REF]);
    expect(readForeignMediaRefsForNode('n3')).toEqual([]);
  });

  it('forgets everything from the previous canvas when a new one publishes', () => {
    publishForeignMediaRefs('projB', 'default', [REF]);
    publishForeignMediaRefs('projB', 'default', []);
    expect(readForeignMediaRefsForNode('n1')).toEqual([]);
  });
});

describe('ForeignMediaNodeOverlay', () => {
  beforeEach(() => {
    clearForeignMediaRefs();
    copyFreezoneAssets.mockReset();
    updateNodeData.mockReset();
    nodes.length = 0;
    nodes.push({ id: 'n1', data: { imageUrl: FOREIGN } });
  });
  afterEach(() => {
    clearForeignMediaRefs();
  });

  it('renders nothing for a node with no reported problem', () => {
    const { container } = render(<ForeignMediaNodeOverlay nodeId="n1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('explains why the media is broken instead of leaving a bare cracked image', () => {
    publishForeignMediaRefs('projB', 'default', [REF]);
    render(<ForeignMediaNodeOverlay nodeId="n1" />);
    expect(screen.getByText('素材属于其他项目')).toBeInTheDocument();
  });

  it('copies the media into this project when the user asks, then clears the marker', async () => {
    copyFreezoneAssets.mockResolvedValue({ mapping: { [FOREIGN]: COPIED }, failed: [] });
    publishForeignMediaRefs('projB', 'default', [REF]);
    render(<ForeignMediaNodeOverlay nodeId="n1" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '复制到本项目' }));
    });

    expect(copyFreezoneAssets).toHaveBeenCalledWith('projB', [FOREIGN]);
    expect(updateNodeData).toHaveBeenCalledWith('n1', { imageUrl: COPIED }, { recordHistory: false });
    expect(readForeignMediaRefsForNode('n1')).toEqual([]);
    expect(screen.queryByText('素材属于其他项目')).toBeNull();
  });

  it('keeps the marker when the copy fails so the user is not told it worked', async () => {
    copyFreezoneAssets.mockResolvedValue({
      mapping: {},
      failed: [{ source: FOREIGN, reason: 'forbidden' }],
    });
    publishForeignMediaRefs('projB', 'default', [REF]);
    render(<ForeignMediaNodeOverlay nodeId="n1" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '复制到本项目' }));
    });

    expect(readForeignMediaRefsForNode('n1')).toEqual([REF]);
  });

  it('says why the copy failed instead of looking like a dead button', async () => {
    // 拷贝失败最常见的原因就是对源项目没权限——正是 #192 那批画布的处境。
    // 静默不动会让用户以为按钮坏了，一直点。
    copyFreezoneAssets.mockResolvedValue({
      mapping: {},
      failed: [{ source: FOREIGN, reason: 'forbidden' }],
    });
    publishForeignMediaRefs('projB', 'default', [REF]);
    render(<ForeignMediaNodeOverlay nodeId="n1" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '复制到本项目' }));
    });

    expect(screen.getByText('复制失败，可能没有源项目的访问权限')).toBeInTheDocument();
  });
});
