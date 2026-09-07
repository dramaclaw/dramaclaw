// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isAssetMigrationInFlight,
  migratePastedNodeAssets,
  readAssetMigrationState,
  subscribeAssetMigrations,
  withholdForeignAssetUrls,
  type PastedNodeForMigration,
} from '@/features/canvas/application/crossProjectAssets';
import type { CanvasNodeData } from '@/features/canvas/domain/canvasNodes';

const copyFreezoneAssets = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', () => ({
  copyFreezoneAssets,
}));

function asData(value: Record<string, unknown>): CanvasNodeData {
  return value as unknown as CanvasNodeData;
}

function basename(url: string): string {
  return url.split('?')[0].split('/').pop() ?? url;
}

/**
 * 模拟粘贴：源数据先经 withholdForeignAssetUrls 扣下外项目 URL，扣下后的数据就是
 * 进 store 的那份（这里当作 live 数据），再交给 migratePastedNodeAssets。
 */
function paste(
  entries: Array<{ id: string; data: Record<string, unknown> }>,
  targetProject = 'projB',
) {
  const live: Record<string, CanvasNodeData> = {};
  const nodes: PastedNodeForMigration[] = [];
  for (const { id, data } of entries) {
    const result = withholdForeignAssetUrls(asData(data), targetProject);
    live[id] = result.data;
    nodes.push({ id, withheld: result.withheld });
  }
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const updateNodeData = (id: string, patch: Partial<CanvasNodeData>) => {
    updates.push({ id, patch: patch as Record<string, unknown> });
    live[id] = { ...live[id], ...patch } as CanvasNodeData;
  };
  const run = () =>
    migratePastedNodeAssets({
      nodes,
      targetProject,
      getLiveNodeData: (id) => live[id] ?? null,
      updateNodeData,
    });
  return { live, nodes, updates, updateNodeData, run };
}

function containsSourceProject(value: unknown): boolean {
  return JSON.stringify(value).includes('projA');
}

describe('withholdForeignAssetUrls', () => {
  it('blanks every foreign asset url (incl. nested arrays), records its slot and marks the node copying', () => {
    const { data, withheld } = withholdForeignAssetUrls(
      asData({
        videoUrl: '/static/projects/projA/videos/clip.mp4',
        album: [
          { imageUrl: '/static/projects/projA/images/a.png' },
          { imageUrl: '/static/projects/projB/images/mine.png' },
        ],
        // non-asset url field: external link must be left untouched
        externalUrl: 'https://example.com/page',
        // non-url field with a path string must be left untouched
        label: '/static/projects/projA/images/a.png',
        prompt: 'keep me',
      }),
      'projB',
    );

    expect(data).toEqual({
      videoUrl: null,
      album: [{ imageUrl: null }, { imageUrl: '/static/projects/projB/images/mine.png' }],
      externalUrl: 'https://example.com/page',
      label: '/static/projects/projA/images/a.png',
      prompt: 'keep me',
      assetMigration: 'copying',
    });
    expect(withheld).toEqual([
      { path: ['videoUrl'], url: '/static/projects/projA/videos/clip.mp4' },
      { path: ['album', 0, 'imageUrl'], url: '/static/projects/projA/images/a.png' },
    ]);
    expect(readAssetMigrationState(data)).toBe('copying');
  });

  it('returns the data untouched and no marker when nothing points at another project', () => {
    const original = asData({
      imageUrl: '/static/projects/projB/images/mine.png',
      previewImageUrl: 'blob:http://localhost/abc',
      externalUrl: 'https://example.com/x.png',
    });
    const { data, withheld } = withholdForeignAssetUrls(original, 'projB');
    expect(withheld).toEqual([]);
    expect(data).toBe(original);
    expect(readAssetMigrationState(data)).toBeNull();
  });
});

describe('migratePastedNodeAssets', () => {
  beforeEach(() => {
    copyFreezoneAssets.mockReset();
    // The backend copies every source it can and answers with old → new URL pairs.
    copyFreezoneAssets.mockImplementation(async (project: string, sources: string[]) => ({
      mapping: Object.fromEntries(
        sources.map((source) => [source, `/static/projects/${project}/freezone/_uploads/${basename(source)}`]),
      ),
      failed: [],
    }));
  });

  it('never lets a source-project url into the store: placeholder first, target urls filled in on success', async () => {
    const { live, updates, run } = paste([
      {
        id: 'n1',
        data: {
          videoUrl: '/static/projects/projA/videos/clip.mp4',
          album: [
            { imageUrl: '/static/projects/projA/images/a.png' },
            { imageUrl: '/static/projects/projA/images/b.png' },
          ],
          externalUrl: 'https://example.com/page',
          label: '/static/projects/projA/images/a.png',
        },
      },
    ]);
    // Store content while the copy is running: no source url, explicit copying marker.
    expect(live.n1).toMatchObject({ videoUrl: null, assetMigration: 'copying' });
    expect(JSON.stringify({ ...live.n1, label: undefined })).not.toContain('projA');

    const summary = await run();

    expect(summary).toEqual({ migrated: 3, failed: 0, failedNodeIds: [] });
    // One round trip, no fetch/upload of the bytes through the browser.
    expect(copyFreezoneAssets).toHaveBeenCalledTimes(1);
    expect(copyFreezoneAssets).toHaveBeenCalledWith('projB', [
      '/static/projects/projA/videos/clip.mp4',
      '/static/projects/projA/images/a.png',
      '/static/projects/projA/images/b.png',
    ]);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('n1');
    expect(updates[0].patch).toEqual({
      videoUrl: '/static/projects/projB/freezone/_uploads/clip.mp4',
      album: [
        { imageUrl: '/static/projects/projB/freezone/_uploads/a.png' },
        { imageUrl: '/static/projects/projB/freezone/_uploads/b.png' },
      ],
      assetMigration: undefined,
    });
    expect(readAssetMigrationState(live.n1)).toBeNull();
    expect(JSON.stringify({ ...live.n1, label: undefined })).not.toContain('projA');
  });

  it('sends each unique asset URL only once', async () => {
    const reused = '/static/projects/projA/images/shared.png';
    const { run, live } = paste([
      { id: 'n1', data: { imageUrl: reused, previewImageUrl: reused } },
      { id: 'n2', data: { imageUrl: reused } },
    ]);
    await run();
    expect(copyFreezoneAssets).toHaveBeenCalledTimes(1);
    expect(copyFreezoneAssets).toHaveBeenCalledWith('projB', [reused]);
    expect(live.n1).toMatchObject({
      imageUrl: '/static/projects/projB/freezone/_uploads/shared.png',
      previewImageUrl: '/static/projects/projB/freezone/_uploads/shared.png',
    });
    expect(live.n2.imageUrl).toBe('/static/projects/projB/freezone/_uploads/shared.png');
  });

  it('splits large batches into several requests', async () => {
    const { run } = paste(
      Array.from({ length: 150 }, (_, index) => ({
        id: `n${index}`,
        data: { imageUrl: `/static/projects/projA/images/${index}.png` },
      })),
    );
    const summary = await run();
    expect(summary.migrated).toBe(150);
    expect(copyFreezoneAssets.mock.calls.length).toBeGreaterThan(1);
    for (const [, sources] of copyFreezoneAssets.mock.calls) {
      expect((sources as string[]).length).toBeLessThanOrEqual(64);
    }
  });

  it('leaves the slot empty and marks the node failed when the backend rejects a source', async () => {
    copyFreezoneAssets.mockResolvedValue({
      mapping: {},
      failed: [{ source: '/static/projects/projA/videos/clip.mp4', reason: 'forbidden' }],
    });
    const { live, updates, run } = paste([
      { id: 'n1', data: { videoUrl: '/static/projects/projA/videos/clip.mp4', prompt: 'p' } },
    ]);

    const summary = await run();

    expect(summary).toEqual({ migrated: 0, failed: 1, failedNodeIds: ['n1'] });
    expect(updates).toEqual([{ id: 'n1', patch: { assetMigration: 'failed' } }]);
    // The node is an explicit error placeholder: no url at all, never the source one.
    expect(live.n1).toEqual({ videoUrl: null, prompt: 'p', assetMigration: 'failed' });
    expect(containsSourceProject(live.n1)).toBe(false);
  });

  it('fills what succeeded and still marks a node failed when one of its assets did not copy', async () => {
    copyFreezoneAssets.mockImplementation(async (project: string, sources: string[]) => ({
      mapping: Object.fromEntries(
        sources
          .filter((source) => !source.endsWith('missing.png'))
          .map((source) => [source, `/static/projects/${project}/freezone/_uploads/${basename(source)}`]),
      ),
      failed: [{ source: '/static/projects/projA/images/missing.png', reason: 'not_found' }],
    }));
    const { live, run } = paste([
      {
        id: 'n1',
        data: {
          album: [
            { imageUrl: '/static/projects/projA/images/ok.png' },
            { imageUrl: '/static/projects/projA/images/missing.png' },
          ],
        },
      },
    ]);

    const summary = await run();

    expect(summary).toEqual({ migrated: 1, failed: 1, failedNodeIds: ['n1'] });
    expect(live.n1).toEqual({
      album: [{ imageUrl: '/static/projects/projB/freezone/_uploads/ok.png' }, { imageUrl: null }],
      assetMigration: 'failed',
    });
  });

  it('counts every URL of a failed request as failed and still applies the requests that succeeded', async () => {
    copyFreezoneAssets.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const { live, run } = paste([
      { id: 'n1', data: { imageUrl: '/static/projects/projA/images/a.png' } },
      { id: 'n2', data: { imageUrl: '/static/projects/projA/images/b.png' } },
    ]);
    const summary = await run();
    expect(summary).toEqual({ migrated: 0, failed: 2, failedNodeIds: ['n1', 'n2'] });
    expect(live.n1).toEqual({ imageUrl: null, assetMigration: 'failed' });
    expect(live.n2).toEqual({ imageUrl: null, assetMigration: 'failed' });
  });

  it('fills the LIVE node data, keeps concurrent user edits and skips vanished nodes', async () => {
    const { live, updates, run } = paste([
      {
        id: 'n1',
        data: {
          videoUrl: '/static/projects/projA/videos/clip.mp4',
          album: [{ imageUrl: '/static/projects/projA/images/a.png' }],
        },
      },
      { id: 'n2', data: { imageUrl: '/static/projects/projA/images/a.png' } },
    ]);
    // While the copy runs: the user dropped their own image into n1's album slot and
    // appended a card; n2 was deleted.
    live.n1 = asData({
      ...live.n1,
      album: [
        { imageUrl: '/static/projects/projB/images/user-picked.png' },
        { imageUrl: '/static/projects/projB/images/user-added.png' },
      ],
    });
    delete live.n2;

    const summary = await run();

    expect(summary).toEqual({ migrated: 2, failed: 0, failedNodeIds: [] });
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('n1');
    expect(updates[0].patch).toEqual({
      videoUrl: '/static/projects/projB/freezone/_uploads/clip.mp4',
      assetMigration: undefined,
    });
    // The slot the user filled themselves is not clobbered.
    expect(live.n1.album).toEqual([
      { imageUrl: '/static/projects/projB/images/user-picked.png' },
      { imageUrl: '/static/projects/projB/images/user-added.png' },
    ]);
  });

  it('registers the nodes as in flight only while the copy is running', async () => {
    let resolveCopy: (value: unknown) => void = () => undefined;
    copyFreezoneAssets.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCopy = resolve;
        }),
    );
    const notified = vi.fn();
    const unsubscribe = subscribeAssetMigrations(notified);
    const { run } = paste([{ id: 'n1', data: { imageUrl: '/static/projects/projA/images/a.png' } }]);

    expect(isAssetMigrationInFlight('n1')).toBe(false);
    const pending = run();
    expect(isAssetMigrationInFlight('n1')).toBe(true);
    expect(notified).toHaveBeenCalledTimes(1);

    resolveCopy({
      mapping: { '/static/projects/projA/images/a.png': '/static/projects/projB/freezone/_uploads/a.png' },
      failed: [],
    });
    await pending;
    expect(isAssetMigrationInFlight('n1')).toBe(false);
    expect(notified).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('marks still-copying nodes failed when the migration itself crashes', async () => {
    const { live, run, updates } = paste([
      { id: 'n1', data: { imageUrl: '/static/projects/projA/images/a.png' } },
    ]);
    // Simulate an unexpected error in the fill step (first store write throws).
    const original = updates;
    let calls = 0;
    const summary = await migratePastedNodeAssets({
      nodes: [{ id: 'n1', withheld: [{ path: ['imageUrl'], url: '/static/projects/projA/images/a.png' }] }],
      targetProject: 'projB',
      getLiveNodeData: (id) => live[id] ?? null,
      updateNodeData: (id, patch) => {
        calls += 1;
        if (calls === 1) {
          throw new Error('store exploded');
        }
        live[id] = { ...live[id], ...patch } as CanvasNodeData;
        original.push({ id, patch: patch as Record<string, unknown> });
      },
    });
    void run;
    expect(summary).toEqual({ migrated: 0, failed: 1, failedNodeIds: ['n1'] });
    expect(live.n1).toEqual({ imageUrl: null, assetMigration: 'failed' });
    expect(isAssetMigrationInFlight('n1')).toBe(false);
  });
});
