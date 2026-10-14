// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import { uploadFreezoneImage } from '@/api/ops';
import type { PrevizMotionInspection } from '@/features/previz/engine/motionClips';
import {
  stageMotionImport,
  uploadMotionImport,
  type PrevizStagedMotionImport,
} from '@/features/previz/motionImport';

vi.mock('@/api/ops', () => ({
  uploadFreezoneImage: vi.fn(async () => ({
    url: '/static/u/p/freezone/_uploads/wave.glb',
    filename: 'wave.glb',
    size: 1024,
  })),
}));

const clip = (name: string) => ({ name }) as THREE.AnimationClip;
const file = new File([new Uint8Array(1)], 'wave.glb');

function stager(inspection: PrevizMotionInspection) {
  return { inspectMotionFile: vi.fn(async () => inspection), primeMotion: vi.fn() };
}

describe('stageMotionImport', () => {
  it('gives every usable clip an id and primes it for preview', async () => {
    const wave = clip('Wave');
    const bow = clip('Bow');
    const renderer = stager({
      ok: true,
      format: 'glb',
      skeleton: 'mixamo',
      clips: [
        { clipIndex: 0, name: 'Wave', durationSec: 1.5, truncated: false, loop: false, clip: wave },
        { clipIndex: 2, name: 'Bow', durationSec: 60, truncated: true, loop: true, clip: bow },
      ],
    });
    const ids = ['m1', 'm2'];
    const staged = await stageMotionImport(renderer, file, () => ids.shift()!);

    expect(staged).toEqual({
      ok: true,
      format: 'glb',
      skeleton: 'mixamo',
      clips: [
        { id: 'm1', clipIndex: 0, name: 'Wave', durationSec: 1.5, truncated: false, loop: false },
        { id: 'm2', clipIndex: 2, name: 'Bow', durationSec: 60, truncated: true, loop: true },
      ],
    });
    expect(renderer.primeMotion).toHaveBeenCalledWith('m1', wave);
    expect(renderer.primeMotion).toHaveBeenCalledWith('m2', bow);
  });

  it('passes a failed inspection through without priming anything', async () => {
    const renderer = stager({ ok: false, error: { code: 'unsupported_skeleton', missing: ['Hips'] } });
    expect(await stageMotionImport(renderer, file)).toEqual({
      ok: false,
      error: { code: 'unsupported_skeleton', missing: ['Hips'] },
    });
    expect(renderer.primeMotion).not.toHaveBeenCalled();
  });
});

describe('uploadMotionImport', () => {
  const staged: PrevizStagedMotionImport = {
    ok: true,
    format: 'glb',
    skeleton: 'mixamo',
    clips: [
      { id: 'm1', clipIndex: 0, name: 'Wave', durationSec: 1.5, truncated: false, loop: false },
      { id: 'm2', clipIndex: 2, name: 'Bow', durationSec: 3, truncated: false, loop: true },
    ],
  };

  it('uploads the file once and writes one motion per pick, sharing the URL', async () => {
    vi.mocked(uploadFreezoneImage).mockClear();
    const result = await uploadMotionImport('p', file, staged, [
      { id: 'm2', name: '  鞠躬 ', loop: false },
      { id: 'm1', name: '', loop: true },
    ]);
    expect(uploadFreezoneImage).toHaveBeenCalledTimes(1);
    expect(uploadFreezoneImage).toHaveBeenCalledWith('p', file, 'wave.glb');
    const url = '/static/u/p/freezone/_uploads/wave.glb';
    expect(result).toEqual({
      ok: true,
      motions: [
        // 按文件里的顺序写，不按勾选顺序；名字去空白，空名字回落到 clip 默认名。
        { id: 'm1', name: 'Wave', url, sourceFileName: 'wave.glb', format: 'glb', skeleton: 'mixamo', clipIndex: 0, durationSec: 1.5, loop: true },
        { id: 'm2', name: '鞠躬', url, sourceFileName: 'wave.glb', format: 'glb', skeleton: 'mixamo', clipIndex: 2, durationSec: 3, loop: false },
      ],
    });
  });

  it('reports an upload failure', async () => {
    vi.mocked(uploadFreezoneImage).mockRejectedValueOnce(new Error('413'));
    expect(await uploadMotionImport('p', file, staged, [{ id: 'm1', name: 'Wave', loop: false }])).toEqual({
      ok: false,
    });
  });
});
