// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { migratePastedNodeAssets } from '@/features/canvas/application/crossProjectAssets';
import type { CanvasNodeData } from '@/features/canvas/domain/canvasNodes';

const copyFreezoneAssets = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', () => ({
  copyFreezoneAssets,
}));

function asData(value: Record<string, unknown>): CanvasNodeData {
  return value as unknown as CanvasNodeData;
}

// Simulates "live" node data === the pasted snapshot (no concurrent edit).
function liveFrom(nodes: Array<{ id: string; data: CanvasNodeData }>) {
  return (id: string) => nodes.find((node) => node.id === id)?.data ?? null;
}

function basename(url: string): string {
  return url.split('?')[0].split('/').pop() ?? url;
}

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

  it('asks the backend to copy source-project media and rewrites URLs, incl. nested arrays', async () => {
    const updates: Array<{ id: string; patch: Partial<CanvasNodeData> }> = [];
    const nodes = [
      {
        id: 'n1',
        data: asData({
          videoUrl: '/static/projects/projA/videos/clip.mp4',
          // nested album cards — must be migrated too
          album: [
            { imageUrl: '/static/projects/projA/images/a.png' },
            { imageUrl: '/static/projects/projA/images/b.png' },
          ],
          // non-asset url field: external link must be left untouched
          externalUrl: 'https://example.com/page',
          // non-url field with a path string must be left untouched
          label: '/static/projects/projA/images/a.png',
        }),
      },
    ];

    const summary = await migratePastedNodeAssets({
      nodes,
      targetProject: 'projB',
      getLiveNodeData: liveFrom(nodes),
      updateNodeData: (id, patch) => updates.push({ id, patch }),
    });

    expect(summary.failed).toBe(0);
    expect(summary.migrated).toBe(3); // clip.mp4 + a.png + b.png (deduped per URL)
    // One round trip, no fetch/upload of the bytes through the browser.
    expect(copyFreezoneAssets).toHaveBeenCalledTimes(1);
    expect(copyFreezoneAssets).toHaveBeenCalledWith('projB', [
      '/static/projects/projA/videos/clip.mp4',
      '/static/projects/projA/images/a.png',
      '/static/projects/projA/images/b.png',
    ]);
    expect(updates).toHaveLength(1);

    const patch = updates[0].patch as Record<string, unknown>;
    expect(patch.videoUrl).toBe('/static/projects/projB/freezone/_uploads/clip.mp4');
    expect(patch.album).toEqual([
      { imageUrl: '/static/projects/projB/freezone/_uploads/a.png' },
      { imageUrl: '/static/projects/projB/freezone/_uploads/b.png' },
    ]);
    // Untouched fields are not part of the patch.
    expect('externalUrl' in patch).toBe(false);
    expect('label' in patch).toBe(false);
  });

  it('sends each unique asset URL only once', async () => {
    const reused = '/static/projects/projA/images/shared.png';
    const nodes = [
      { id: 'n1', data: asData({ imageUrl: reused, previewImageUrl: reused }) },
      { id: 'n2', data: asData({ imageUrl: reused }) },
    ];
    await migratePastedNodeAssets({
      nodes,
      targetProject: 'projB',
      getLiveNodeData: liveFrom(nodes),
      updateNodeData: () => undefined,
    });
    expect(copyFreezoneAssets).toHaveBeenCalledTimes(1);
    expect(copyFreezoneAssets).toHaveBeenCalledWith('projB', [reused]);
  });

  it('splits large batches into several requests', async () => {
    const nodes = Array.from({ length: 150 }, (_, index) => ({
      id: `n${index}`,
      data: asData({ imageUrl: `/static/projects/projA/images/${index}.png` }),
    }));
    const summary = await migratePastedNodeAssets({
      nodes,
      targetProject: 'projB',
      getLiveNodeData: liveFrom(nodes),
      updateNodeData: () => undefined,
    });
    expect(summary.migrated).toBe(150);
    expect(copyFreezoneAssets.mock.calls.length).toBeGreaterThan(1);
    for (const [, sources] of copyFreezoneAssets.mock.calls) {
      expect((sources as string[]).length).toBeLessThanOrEqual(64);
    }
  });

  it('keeps the original URL and counts failures the backend reports', async () => {
    copyFreezoneAssets.mockResolvedValue({
      mapping: {},
      failed: [{ source: '/static/projects/projA/videos/clip.mp4', reason: 'forbidden' }],
    });
    const updates: Array<{ id: string; patch: Partial<CanvasNodeData> }> = [];

    const nodes = [
      { id: 'n1', data: asData({ videoUrl: '/static/projects/projA/videos/clip.mp4' }) },
    ];
    const summary = await migratePastedNodeAssets({
      nodes,
      targetProject: 'projB',
      getLiveNodeData: liveFrom(nodes),
      updateNodeData: (id, patch) => updates.push({ id, patch }),
    });

    expect(summary.failed).toBe(1);
    expect(summary.migrated).toBe(0);
    // No rewrite => no updateNodeData call (URL stays pointing at the source).
    expect(updates).toHaveLength(0);
  });

  it('counts every URL of a failed request and still applies the requests that succeeded', async () => {
    copyFreezoneAssets
      .mockImplementationOnce(async () => {
        throw new Error('boom');
      });
    const nodes = [
      { id: 'n1', data: asData({ imageUrl: '/static/projects/projA/images/a.png' }) },
      { id: 'n2', data: asData({ imageUrl: '/static/projects/projA/images/b.png' }) },
    ];
    const summary = await migratePastedNodeAssets({
      nodes,
      targetProject: 'projB',
      getLiveNodeData: liveFrom(nodes),
      updateNodeData: () => undefined,
    });
    expect(summary.failed).toBe(2);
    expect(summary.migrated).toBe(0);
  });

  it('rewrites the LIVE node data, preserving concurrent user edits and skipping vanished nodes', async () => {
    const updates: Array<{ id: string; patch: Partial<CanvasNodeData> }> = [];
    // Snapshot captured at paste time.
    const snapshot = [
      { id: 'n1', data: asData({ videoUrl: '/static/projects/projA/videos/clip.mp4' }) },
      { id: 'n2', data: asData({ imageUrl: '/static/projects/projA/images/a.png' }) },
    ];
    // By the time migration finishes: n1 gained a user-added album card; n2 was deleted.
    const live: Record<string, CanvasNodeData> = {
      n1: asData({
        videoUrl: '/static/projects/projA/videos/clip.mp4',
        album: [{ imageUrl: '/static/projects/projA/images/user-added.png' }],
      }),
    };

    const summary = await migratePastedNodeAssets({
      nodes: snapshot,
      targetProject: 'projB',
      getLiveNodeData: (id) => live[id] ?? null,
      updateNodeData: (id, patch) => updates.push({ id, patch }),
    });

    // Both snapshot assets were copied...
    expect(summary.migrated).toBe(2);
    expect(summary.failed).toBe(0);
    // ...but only the still-present node n1 is patched (n2 is gone -> skipped).
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('n1');
    const patch = updates[0].patch as Record<string, unknown>;
    expect(patch.videoUrl).toBe('/static/projects/projB/freezone/_uploads/clip.mp4');
    // The user's later album edit is untouched (not in the migration map, not clobbered).
    expect('album' in patch).toBe(false);
  });
});
