// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 保存被后端以 `canvas_media_scope_mismatch` 拒绝后的自愈：解析 refs、把素材拷进
 * 本项目、按字段路径填回节点；拷不动的置空并标记失败，让保存能继续走下去。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const copyFreezoneAssets = vi.hoisted(() => vi.fn());
vi.mock('@/api/ops', () => ({ copyFreezoneAssets }));

const {
  applyForeignMediaRepairToNodes,
  clearForeignMediaRefs,
  parseCanvasMediaScopeRefs,
  publishForeignMediaRefs,
  repairForeignMediaRefs,
} = await import('@/features/canvas/application/canvasMediaScope');

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
    clearForeignMediaRefs();
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

  it('leaves every field alone when the request itself did not go through', async () => {
    // 请求没走通 ≠ 这些素材拷不了。置空是不可逆的,不能拿它换一次网络抖动。
    copyFreezoneAssets.mockRejectedValue(new Error('network down'));
    const updateNodeData = vi.fn();

    const result = await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    expect(result.retryable).toBe(true);
    expect(result.failedUrls.size).toBe(0);
    expect(updateNodeData).not.toHaveBeenCalled();
  });

  it('leaves every field alone when the backend says a source is only unavailable', async () => {
    copyFreezoneAssets.mockResolvedValue({
      mapping: {},
      failed: [{ source: FOREIGN, reason: 'unavailable' }],
    });
    const updateNodeData = vi.fn();

    const result = await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    expect(result.retryable).toBe(true);
    expect(updateNodeData).not.toHaveBeenCalled();
  });

  it('leaves every field alone when the copy failed on the storage side', async () => {
    // copy_failed = 拷贝/建目标文件时的 OSError,是存储侧出岔子,不是这个源拷不了。
    copyFreezoneAssets.mockResolvedValue({
      mapping: {},
      failed: [{ source: FOREIGN, reason: 'copy_failed' }],
    });
    const updateNodeData = vi.fn();

    const result = await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    expect(result.retryable).toBe(true);
    expect(updateNodeData).not.toHaveBeenCalled();
  });

  it('normalizes a same-origin absolute url before asking the backend to copy it', async () => {
    // 守卫按浏览器语义扫得到它,复制接口却只认相对 canonical 路径:不归一化就换回
    // invalid_source,自愈反倒把引用删了。
    const absolute = `${window.location.origin}/static/projects/projA/freezone/x/../_uploads/a.png`;
    copyFreezoneAssets.mockResolvedValue({ mapping: { [FOREIGN]: COPIED }, failed: [] });
    const updateNodeData = vi.fn();

    const result = await repairForeignMediaRefs({
      refs: [ref({ url: absolute })],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: absolute }) as never,
      updateNodeData,
    });

    expect(copyFreezoneAssets).toHaveBeenCalledWith('projB', [FOREIGN]);
    // 对外仍按画布里那串原 URL 作 key,调用方才改得动自己手上的快照。
    expect(result.urlMap.get(absolute)).toBe(COPIED);
    expect(updateNodeData).toHaveBeenCalledWith('n1', { imageUrl: COPIED });
  });

  it('does not touch an url it cannot resolve to a same-origin asset', async () => {
    // 路径长得像项目资源的外链图:守卫会误拦,但它本来就不是本站资源,拷不了也不该删。
    const external = 'https://cdn.example.com/static/projects/projA/a.png';
    const updateNodeData = vi.fn();

    const result = await repairForeignMediaRefs({
      refs: [ref({ url: external })],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: external }) as never,
      updateNodeData,
    });

    expect(copyFreezoneAssets).not.toHaveBeenCalled();
    expect(result.failedUrls.size).toBe(0);
    expect(updateNodeData).not.toHaveBeenCalled();
  });

  it('still blanks what the backend definitively refused', async () => {
    // 403 是终局:留着源项目 URL 就是把 403 再存一次,后端下一轮还会拒,保存永远卡死。
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

    expect(result.retryable).toBe(false);
    expect(result.failedUrls.has(FOREIGN)).toBe(true);
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      imageUrl: null,
      assetMigration: 'failed',
    });
  });

  it('writes nothing when the canvas changed while the copy was in flight', async () => {
    // 拷贝要几秒;期间换了画布,手上的 refs 指的已经不是屏幕上这张图了。
    publishForeignMediaRefs('projB', 'canvas-a', [ref()]);
    const updateNodeData = vi.fn();
    copyFreezoneAssets.mockImplementation(async () => {
      publishForeignMediaRefs('projB', 'canvas-b', []);
      return { mapping: { [FOREIGN]: COPIED }, failed: [] };
    });

    const result = await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    expect(result.retryable).toBe(true);
    expect(updateNodeData).not.toHaveBeenCalled();
  });

  it('keeps going when the same canvas merely re-hydrates mid-copy', async () => {
    // 后台刷新不能把用户正在跑的修复打断。
    publishForeignMediaRefs('projB', 'canvas-a', [ref()]);
    const updateNodeData = vi.fn();
    copyFreezoneAssets.mockImplementation(async () => {
      publishForeignMediaRefs('projB', 'canvas-a', [ref()]);
      return { mapping: { [FOREIGN]: COPIED }, failed: [] };
    });

    const result = await repairForeignMediaRefs({
      refs: [ref()],
      targetProject: 'projB',
      getLiveNodeData: () => ({ imageUrl: FOREIGN }) as never,
      updateNodeData,
    });

    expect(result.retryable).toBe(false);
    expect(updateNodeData).toHaveBeenCalledWith('n1', { imageUrl: COPIED });
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
      retryable: false,
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
      retryable: false,
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
      retryable: false,
    });

    expect(next).toBe(nodes);
  });
});
