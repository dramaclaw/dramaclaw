// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 保存被后端以 `canvas_media_scope_mismatch` 拒绝后的自愈：解析 refs、把素材拷进
 * 本项目、按字段路径填回节点；拷不动的置空并标记失败，让保存能继续走下去。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const copyFreezoneAssets = vi.hoisted(() => vi.fn());
vi.mock('@/api/ops', () => ({ copyFreezoneAssets }));

const { applyForeignMediaRepairToNodes, parseCanvasMediaScopeRefs, repairForeignMediaRefs } =
  await import(
    '@/features/canvas/application/canvasMediaScope'
  );

const FOREIGN = '/static/projects/projA/freezone/_uploads/a.png';
const COPIED = '/static/projects/projB/freezone/_uploads/a.png';

function ref(overrides: Record<string, unknown> = {}) {
  return {
    node_id: 'n1',
    field: 'imageUrl',
    url: FOREIGN,
    source_project_id: 'projA',
    ...overrides,
  };
}

describe('parseCanvasMediaScopeRefs', () => {
  it('reads the refs out of the 422 body', () => {
    expect(
      parseCanvasMediaScopeRefs(422, {
        detail: { code: 'canvas_media_scope_mismatch', project_id: 'projB', refs: [ref()] },
      }),
    ).toEqual([ref()]);
  });

  it('ignores any other error', () => {
    expect(parseCanvasMediaScopeRefs(409, { detail: { code: 'canvas_revision_conflict' } })).toBeNull();
    expect(parseCanvasMediaScopeRefs(422, { detail: { code: 'canvas_payload_too_large' } })).toBeNull();
    expect(parseCanvasMediaScopeRefs(422, undefined)).toBeNull();
  });

  it('drops malformed entries instead of trusting the wire', () => {
    expect(
      parseCanvasMediaScopeRefs(422, {
        detail: {
          code: 'canvas_media_scope_mismatch',
          refs: [ref(), { node_id: 'n2' }, 'nonsense', null],
        },
      }),
    ).toEqual([ref()]);
  });

  it('returns null when the backend reports the code with no usable ref', () => {
    // 没有可修的位置就别进自愈分支空转一圈,直接按普通错误报出去。
    expect(
      parseCanvasMediaScopeRefs(422, { detail: { code: 'canvas_media_scope_mismatch', refs: [] } }),
    ).toBeNull();
  });
});

describe('repairForeignMediaRefs', () => {
  beforeEach(() => {
    copyFreezoneAssets.mockReset();
  });

  it('copies the asset into this project and writes the new url back into the node', async () => {
    copyFreezoneAssets.mockResolvedValue({ mapping: { [FOREIGN]: COPIED }, failed: [] });
    const updateNodeData = vi.fn();

    const result = await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    expect(copyFreezoneAssets).toHaveBeenCalledWith('projB', [FOREIGN]);
    expect(updateNodeData).toHaveBeenCalledWith('n1', { imageUrl: COPIED });
    expect(result.urlMap.get(FOREIGN)).toBe(COPIED);
    expect(result.failedUrls.size).toBe(0);
  });

  it('walks the nested field path the backend reported', async () => {
    copyFreezoneAssets.mockResolvedValue({ mapping: { [FOREIGN]: COPIED }, failed: [] });
    const updateNodeData = vi.fn();

    await repairForeignMediaRefs({
      refs: [ref({ field: 'cells[1].imageUrl' })],
      targetProject: 'projB',
      getLiveNodeData: () =>
        ({ cells: [{ imageUrl: null }, { imageUrl: FOREIGN }] }) as never,
      updateNodeData,
    });

    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      cells: [{ imageUrl: null }, { imageUrl: COPIED }],
    });
  });

  it('copies one url once even when several nodes point at it', async () => {
    copyFreezoneAssets.mockResolvedValue({ mapping: { [FOREIGN]: COPIED }, failed: [] });
    const updateNodeData = vi.fn();

    await repairForeignMediaRefs({
      refs: [ref(), ref({ node_id: 'n2' })],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    expect(copyFreezoneAssets).toHaveBeenCalledTimes(1);
    expect(updateNodeData).toHaveBeenCalledTimes(2);
  });

  it('blanks the field and marks the node failed when the copy does not succeed', async () => {
    copyFreezoneAssets.mockResolvedValue({
      mapping: {},
      failed: [{ source: FOREIGN, reason: 'forbidden' }],
    });
    const updateNodeData = vi.fn();

    const result = await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    // 置空是必须的:保留源项目 URL 就等于把 403 再存一次,后端也会再拒一次。
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      imageUrl: null,
      assetMigration: 'failed',
    });
    expect(result.failedUrls.has(FOREIGN)).toBe(true);
  });

  it('treats a request that blows up as a failure for every url in it', async () => {
    copyFreezoneAssets.mockRejectedValue(new Error('network down'));
    const updateNodeData = vi.fn();

    const result = await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    expect(result.failedUrls.has(FOREIGN)).toBe(true);
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      imageUrl: null,
      assetMigration: 'failed',
    });
  });

  it('skips a node that is gone by the time the copy comes back', async () => {
    copyFreezoneAssets.mockResolvedValue({ mapping: { [FOREIGN]: COPIED }, failed: [] });
    const updateNodeData = vi.fn();

    await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => null,
      updateNodeData,
    });

    expect(updateNodeData).not.toHaveBeenCalled();
  });

  it('leaves a field the user already changed alone', async () => {
    copyFreezoneAssets.mockResolvedValue({ mapping: { [FOREIGN]: COPIED }, failed: [] });
    const updateNodeData = vi.fn();

    await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      // 拒绝到重试之间用户自己换了图:那是他的选择,别拿拷贝结果盖掉。
      getLiveNodeData: () => ({ imageUrl: '/static/projects/projB/mine.png' }) as never,
      updateNodeData,
    });

    expect(updateNodeData).not.toHaveBeenCalled();
  });
});

describe('applyForeignMediaRepairToNodes', () => {
  const nodes = [
    { id: 'n1', data: { imageUrl: FOREIGN, label: '一' } },
    { id: 'n2', data: { imageUrl: '/static/projects/projB/ok.png' } },
  ];

  it('rewrites the repaired urls in the snapshot the retry will send', () => {
    const next = applyForeignMediaRepairToNodes(nodes as never, [ref()], {
      urlMap: new Map([[FOREIGN, COPIED]]),
      failedUrls: new Set<string>(),
    });

    expect((next[0] as { data: { imageUrl: string; label: string } }).data).toEqual({
      imageUrl: COPIED,
      label: '一',
    });
    // 没被碰过的节点保持同一引用,免得整棵画布白重渲染一遍。
    expect(next[1]).toBe(nodes[1]);
  });

  it('blanks and marks what could not be copied, so the retry is not rejected again', () => {
    const next = applyForeignMediaRepairToNodes(nodes as never, [ref()], {
      urlMap: new Map<string, string>(),
      failedUrls: new Set([FOREIGN]),
    });

    expect((next[0] as { data: Record<string, unknown> }).data).toMatchObject({
      imageUrl: null,
      assetMigration: 'failed',
    });
  });

  it('returns the very same array when there is nothing to change', () => {
    const next = applyForeignMediaRepairToNodes(nodes as never, [ref({ node_id: 'gone' })], {
      urlMap: new Map([[FOREIGN, COPIED]]),
      failedUrls: new Set<string>(),
    });

    expect(next).toBe(nodes);
  });
});
