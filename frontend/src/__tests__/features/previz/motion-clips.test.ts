// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as THREE from 'three';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { describe, expect, it, vi } from 'vitest';

import type { PrevizImportedMotion } from '@/features/previz/domain/scene';
import { PREVIZ_MOTION_LIMITS } from '@/features/previz/domain/limits';
import {
  inspectMotionFile,
  motionFormatOf,
  parseMotionData,
  prepareMotion,
  PrevizMotionClips,
  type PrevizMotionParsers,
} from '@/features/previz/engine/motionClips';

/** 人体各关节的世界位置（米，Y 朝上、面朝 +Z、左手在 +X），键是 UAL 骨骼名。 */
const BODY: ReadonlyArray<readonly [bone: string, parent: string | null, at: readonly [number, number, number]]> = [
  ['pelvis', null, [0, 1, 0]],
  ['spine_01', 'pelvis', [0, 1.1, 0]],
  ['spine_02', 'spine_01', [0, 1.2, 0]],
  ['spine_03', 'spine_02', [0, 1.3, 0]],
  ['neck_01', 'spine_03', [0, 1.5, 0]],
  ['Head', 'neck_01', [0, 1.6, 0]],
  ['clavicle_l', 'spine_03', [0.05, 1.45, 0]],
  ['upperarm_l', 'clavicle_l', [0.15, 1.45, 0]],
  ['lowerarm_l', 'upperarm_l', [0.45, 1.45, 0]],
  ['hand_l', 'lowerarm_l', [0.7, 1.45, 0]],
  ['clavicle_r', 'spine_03', [-0.05, 1.45, 0]],
  ['upperarm_r', 'clavicle_r', [-0.15, 1.45, 0]],
  ['lowerarm_r', 'upperarm_r', [-0.45, 1.45, 0]],
  ['hand_r', 'lowerarm_r', [-0.7, 1.45, 0]],
  ['thigh_l', 'pelvis', [0.1, 0.95, 0]],
  ['calf_l', 'thigh_l', [0.1, 0.5, 0]],
  ['foot_l', 'calf_l', [0.1, 0.05, 0]],
  ['ball_l', 'foot_l', [0.1, 0, 0.1]],
  ['thigh_r', 'pelvis', [-0.1, 0.95, 0]],
  ['calf_r', 'thigh_r', [-0.1, 0.5, 0]],
  ['foot_r', 'calf_r', [-0.1, 0.05, 0]],
  ['ball_r', 'foot_r', [-0.1, 0, 0.1]],
];

const MIXAMO: Record<string, string> = {
  pelvis: 'mixamorig:Hips', spine_01: 'mixamorig:Spine', spine_02: 'mixamorig:Spine1', spine_03: 'mixamorig:Spine2',
  neck_01: 'mixamorig:Neck', Head: 'mixamorig:Head',
  clavicle_l: 'mixamorig:LeftShoulder', upperarm_l: 'mixamorig:LeftArm', lowerarm_l: 'mixamorig:LeftForeArm', hand_l: 'mixamorig:LeftHand',
  clavicle_r: 'mixamorig:RightShoulder', upperarm_r: 'mixamorig:RightArm', lowerarm_r: 'mixamorig:RightForeArm', hand_r: 'mixamorig:RightHand',
  thigh_l: 'mixamorig:LeftUpLeg', calf_l: 'mixamorig:LeftLeg', foot_l: 'mixamorig:LeftFoot', ball_l: 'mixamorig:LeftToeBase',
  thigh_r: 'mixamorig:RightUpLeg', calf_r: 'mixamorig:RightLeg', foot_r: 'mixamorig:RightFoot', ball_r: 'mixamorig:RightToeBase',
};

/**
 * 按 `body` 写一段 BVH：`rename` 换骨骼名，`scale` 换单位，每帧都是静止姿势。
 * `body` 缺省用 BODY；退化骨架的用例传一份改过关节位置的拷贝进来。
 */
function bvh({ rename = (bone: string) => bone, scale = 1, frames = 2, body = BODY } = {}): string {
  const lines = ['HIERARCHY'];
  let channels = 0;
  const write = (bone: string, depth: number) => {
    const [, parent, at] = body.find(([name]) => name === bone)!;
    const from = parent ? body.find(([name]) => name === parent)![2] : [0, 0, 0];
    const pad = '  '.repeat(depth);
    const offset = at.map((value, axis) => ((value - from[axis]!) * scale).toFixed(4)).join(' ');
    lines.push(`${pad}${parent ? 'JOINT' : 'ROOT'} ${rename(bone)}`, `${pad}{`, `${pad}  OFFSET ${offset}`);
    lines.push(`${pad}  CHANNELS ${parent ? '3' : '6 Xposition Yposition Zposition'} Zrotation Xrotation Yrotation`);
    channels += parent ? 3 : 6;
    for (const [child, childParent] of body) if (childParent === bone) write(child, depth + 1);
    lines.push(`${pad}}`);
  };
  write('pelvis', 0);
  lines.push('MOTION', `Frames: ${frames}`, `Frame Time: ${1 / 30}`);
  for (let frame = 0; frame < frames; frame += 1) lines.push(Array(channels).fill('0').join(' '));
  return lines.join('\n');
}

const encode = (text: string): ArrayBuffer => {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const bvhParsers: PrevizMotionParsers = {
  parseGltf: () => Promise.reject(new Error('not a glTF')),
  parseBvh: (text) => new BVHLoader().parse(text),
};

/** 当人物源模型用的 UAL 骨架。 */
function actor(): THREE.Object3D {
  const { skeleton } = new BVHLoader().parse(bvh());
  const scene = new THREE.Group();
  scene.add(skeleton.bones[0]!);
  return scene;
}

const motion = (id: string, overrides: Partial<PrevizImportedMotion> = {}): PrevizImportedMotion => ({
  id,
  name: id,
  url: `/files/${id}.bvh`,
  sourceFileName: `${id}.bvh`,
  format: 'bvh',
  skeleton: 'mixamo',
  clipIndex: 0,
  durationSec: 1 / 30,
  loop: false,
  ...overrides,
});

describe('motionFormatOf', () => {
  it('reads the three supported extensions case-insensitively', () => {
    expect(motionFormatOf('Walk.GLB')).toBe('glb');
    expect(motionFormatOf('a.b.gltf')).toBe('gltf');
    expect(motionFormatOf('take_01.bvh')).toBe('bvh');
    expect(motionFormatOf('walk.fbx')).toBeNull();
    expect(motionFormatOf('bvh')).toBeNull();
  });
});

describe('parseMotionData', () => {
  it('wraps a BVH skeleton in a group', async () => {
    const result = await parseMotionData(THREE, bvhParsers, 'bvh', encode(bvh({ rename: (bone) => MIXAMO[bone]! })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.clips).toHaveLength(1);
    expect(result.file.root.getObjectByName('mixamorig:LeftForeArm')).toBeTruthy();
  });

  it('reports garbage as parse_failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(parseMotionData(THREE, bvhParsers, 'bvh', encode('not a bvh'))).resolves.toEqual({
      ok: false,
      error: { code: 'parse_failed' },
    });
    await expect(parseMotionData(THREE, bvhParsers, 'glb', new ArrayBuffer(4))).resolves.toEqual({
      ok: false,
      error: { code: 'parse_failed' },
    });
    warn.mockRestore();
  });

  it('reports a glTF without animations as no_animation', async () => {
    const parsers = { ...bvhParsers, parseGltf: async () => ({ scene: new THREE.Group(), animations: [] }) };
    await expect(parseMotionData(THREE, parsers, 'gltf', new ArrayBuffer(4))).resolves.toEqual({
      ok: false,
      error: { code: 'no_animation' },
    });
  });
});

describe('prepareMotion', () => {
  const parse = async (text: string) => {
    const result = await parseMotionData(THREE, bvhParsers, 'bvh', encode(text));
    if (!result.ok) throw new Error('fixture did not parse');
    return result.file;
  };

  it('detects Mixamo in centimetres and retargets onto the actor skeleton', async () => {
    const file = await parse(bvh({ rename: (bone) => MIXAMO[bone]!, scale: 100 }));
    const target = actor();
    const result = prepareMotion(THREE, clone, file, 0, target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.motion.skeleton).toBe('mixamo');
    expect(result.motion.loop).toBe(true);
    expect(result.motion.clip.tracks.map((track) => track.name)).toEqual(
      expect.arrayContaining(['pelvis.position', 'lowerarm_l.quaternion']),
    );
    // 共享的人物源模型不能被碰：它的骨骼还在静止位置。
    expect(target.getObjectByName('pelvis')!.position.y).toBeCloseTo(1, 5);
  });

  it('can prepare the same file twice', async () => {
    const file = await parse(bvh({ rename: (bone) => MIXAMO[bone]! }));
    const first = prepareMotion(THREE, clone, file, 0, actor());
    const second = prepareMotion(THREE, clone, file, 0, actor());
    expect(first.ok && second.ok).toBe(true);
  });

  it('names the missing core bones', async () => {
    const file = await parse(bvh({ rename: (bone) => (bone === 'lowerarm_l' ? 'Elbow_Thing' : MIXAMO[bone]!) }));
    expect(prepareMotion(THREE, clone, file, 0, actor())).toEqual({
      ok: false,
      error: { code: 'unsupported_skeleton', missing: ['lowerarm_l'] },
    });
  });

  it('rejects a single-frame take and a clip index past the end', async () => {
    const file = await parse(bvh({ rename: (bone) => MIXAMO[bone]!, frames: 1 }));
    expect(prepareMotion(THREE, clone, file, 0, actor())).toEqual({ ok: false, error: { code: 'zero_duration' } });
    expect(prepareMotion(THREE, clone, file, 1, actor())).toEqual({ ok: false, error: { code: 'no_animation' } });
  });

  it('reports a retargetClip throw (coincident thighs) as parse_failed', async () => {
    // 核心骨骼都齐、名字都对，但左右大腿水平投影重合：retargetClip 找不到朝向会直接抛错，
    // prepareMotion 得接住它，不能让这个 throw 一路捅穿到导入流程或加载队列。
    const degenerateThighs = BODY.map(([bone, parent, at]) =>
      bone === 'thigh_r' ? ([bone, parent, [0.1, at[1], at[2]]] as const) : ([bone, parent, at] as const),
    );
    const file = await parse(bvh({ rename: (bone) => MIXAMO[bone]!, body: degenerateThighs }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(prepareMotion(THREE, clone, file, 0, actor())).toEqual({ ok: false, error: { code: 'parse_failed' } });
    warn.mockRestore();
  });
});

describe('inspectMotionFile', () => {
  const deps = {
    three: THREE,
    clone,
    parsers: bvhParsers,
    loadActorSource: async () => ({ scene: actor(), animations: [] }),
  };
  const fileOf = (name: string, text: string, size = text.length) => ({
    name,
    size,
    arrayBuffer: async () => encode(text),
  });

  it('lists the usable clips with their defaults', async () => {
    const result = await inspectMotionFile(deps, fileOf('Take 01.BVH', bvh({ rename: (bone) => MIXAMO[bone]! })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe('bvh');
    expect(result.skeleton).toBe('mixamo');
    expect(result.clips).toHaveLength(1);
    // BVHLoader 给的 clip 名是 `animation`，照用；空名才回落到文件名。
    expect(result.clips[0]).toMatchObject({ clipIndex: 0, truncated: false, loop: true });
    expect(result.clips[0]!.durationSec).toBeCloseTo(1 / 30, 3);
  });

  it('falls back to the file name for an unnamed clip and flags a take past the limit', async () => {
    const parsers: PrevizMotionParsers = {
      ...bvhParsers,
      parseBvh: (text) => {
        const parsed = new BVHLoader().parse(text);
        parsed.clip.name = '';
        parsed.clip.duration = PREVIZ_MOTION_LIMITS.durationSec + 5;
        return parsed;
      },
    };
    const result = await inspectMotionFile({ ...deps, parsers }, fileOf('wave.bvh', bvh({ rename: (bone) => MIXAMO[bone]! })));
    expect(result.ok && result.clips[0]).toMatchObject({
      name: 'wave',
      truncated: true,
      durationSec: PREVIZ_MOTION_LIMITS.durationSec,
    });
  });

  it('refuses before reading anything it cannot take', async () => {
    const read = vi.fn(async () => new ArrayBuffer(0));
    await expect(inspectMotionFile(deps, { name: 'walk.fbx', size: 10, arrayBuffer: read })).resolves.toEqual({
      ok: false,
      error: { code: 'bad_extension' },
    });
    await expect(
      inspectMotionFile(deps, { name: 'walk.glb', size: PREVIZ_MOTION_LIMITS.fileBytes + 1, arrayBuffer: read }),
    ).resolves.toEqual({ ok: false, error: { code: 'too_large' } });
    expect(read).not.toHaveBeenCalled();
  });

  it('reports why no clip could be used', async () => {
    const result = await inspectMotionFile(deps, fileOf('odd.bvh', bvh({ rename: (bone) => (bone === 'Head' ? 'Skull' : MIXAMO[bone]!) })));
    expect(result).toEqual({ ok: false, error: { code: 'unsupported_skeleton', missing: ['Head'] } });
  });

  it('reports a missing actor model as fetch_failed', async () => {
    const result = await inspectMotionFile(
      { ...deps, loadActorSource: () => Promise.reject(new Error('offline')) },
      fileOf('walk.bvh', bvh({ rename: (bone) => MIXAMO[bone]! })),
    );
    expect(result).toEqual({ ok: false, error: { code: 'fetch_failed' } });
  });
});

describe('PrevizMotionClips', () => {
  const mixamoFile = () => encode(bvh({ rename: (bone) => MIXAMO[bone]! }));

  function setup(fetchFile: (url: string) => Promise<ArrayBuffer> = async () => mixamoFile()) {
    const onChange = vi.fn();
    const deps = {
      three: THREE,
      clone,
      parsers: bvhParsers,
      fetchFile: vi.fn(fetchFile),
      loadActorSource: vi.fn(async () => ({ scene: actor(), animations: [] })),
      onChange,
    };
    const clips = new PrevizMotionClips(deps);
    const lastStatuses = () => onChange.mock.calls[onChange.mock.calls.length - 1]![0];
    return { clips, deps, onChange, lastStatuses };
  }

  it('reports loading, then resolves the retargeted clip once settled', async () => {
    const { clips, lastStatuses } = setup();
    clips.sync([motion('a')]);
    expect(lastStatuses()).toEqual({ a: { state: 'loading' } });
    expect(clips.resolve('import:a')).toBeNull();

    await clips.whenSettled();
    expect(lastStatuses()).toEqual({ a: { state: 'ready' } });
    expect(clips.resolve('import:a')?.tracks.length).toBeGreaterThan(0);
    expect(clips.resolve('import:b')).toBeNull();
    expect(clips.resolve('builtin:walk')).toBeNull();
  });

  it('downloads a shared URL once and loads motions one at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { clips, deps } = setup(async (url) => {
      if (url === '/files/a.bvh') await gate;
      return mixamoFile();
    });
    clips.sync([motion('a'), motion('a2', { url: '/files/a.bvh' }), motion('b')]);
    await vi.waitFor(() => expect(deps.fetchFile).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deps.fetchFile.mock.calls.map(([url]) => url)).toEqual(['/files/a.bvh']);

    release();
    await clips.whenSettled();
    expect(deps.fetchFile.mock.calls.map(([url]) => url)).toEqual(['/files/a.bvh', '/files/b.bvh']);
    expect(clips.statuses()).toEqual({ a: { state: 'ready' }, a2: { state: 'ready' }, b: { state: 'ready' } });
  });

  it('records why a motion failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { clips } = setup(async (url) => {
      if (url.includes('gone')) throw new Error('404');
      return encode(bvh({ rename: (bone) => (bone === 'Head' ? 'Skull' : MIXAMO[bone]!) }));
    });
    clips.sync([motion('gone'), motion('odd')]);
    await clips.whenSettled();
    expect(clips.statuses()).toEqual({
      gone: { state: 'error', error: { code: 'fetch_failed' } },
      odd: { state: 'error', error: { code: 'unsupported_skeleton', missing: ['Head'] } },
    });
    expect(clips.resolve('import:odd')).toBeNull();
    warn.mockRestore();
  });

  it('drops a motion removed while it waits in the queue', async () => {
    const { clips, deps, lastStatuses } = setup();
    clips.sync([motion('a'), motion('b')]);
    clips.sync([motion('a')]);
    expect(lastStatuses()).toEqual({ a: { state: 'loading' } });
    await clips.whenSettled();
    expect(deps.fetchFile).toHaveBeenCalledTimes(1);
    expect(lastStatuses()).toEqual({ a: { state: 'ready' } });
  });

  it('keeps a loaded clip across a rename but reloads when the file changes', async () => {
    const { clips, deps, onChange } = setup();
    clips.sync([motion('a')]);
    await clips.whenSettled();
    const calls = onChange.mock.calls.length;
    clips.sync([motion('a', { name: 'renamed', loop: true })]);
    expect(onChange.mock.calls.length).toBe(calls);

    clips.sync([motion('a', { url: '/files/other.bvh' })]);
    expect(clips.statuses()).toEqual({ a: { state: 'loading' } });
    await clips.whenSettled();
    expect(deps.fetchFile).toHaveBeenCalledTimes(2);
  });

  it('uses a primed clip without downloading', async () => {
    const { clips, deps } = setup();
    const primed = new THREE.AnimationClip('primed', 1, []);
    clips.prime('a', primed);
    clips.sync([motion('a')]);
    expect(clips.statuses()).toEqual({ a: { state: 'ready' } });
    expect(clips.resolve('import:a')).toBe(primed);
    await clips.whenSettled();
    expect(deps.fetchFile).not.toHaveBeenCalled();
  });

  it('previews a primed clip before the scene has it, and forgets it when discarded', () => {
    const { clips, onChange } = setup();
    const primed = new THREE.AnimationClip('primed', 1, []);
    clips.prime('a', primed);
    // 导入确认框里的预览：还没上传、没进场景，人物就得能先动起来。
    expect(clips.resolve('import:a')).toBe(primed);
    expect(clips.statuses()).toEqual({});
    expect(onChange).not.toHaveBeenCalled();

    clips.discardPrimed('a');
    expect(clips.resolve('import:a')).toBeNull();
    clips.sync([motion('a')]);
    expect(clips.statuses()).toEqual({ a: { state: 'loading' } });
  });

  it('waits for motions added while it is already waiting', async () => {
    const { clips } = setup();
    await expect(clips.whenSettled()).resolves.toBeUndefined();
    clips.sync([motion('a')]);
    const settled = clips.whenSettled();
    clips.sync([motion('a'), motion('b')]);
    await settled;
    expect(clips.statuses()).toEqual({ a: { state: 'ready' }, b: { state: 'ready' } });
  });

  it('stops reporting after dispose and releases waiters', async () => {
    const { clips, onChange } = setup();
    clips.sync([motion('a')]);
    const settled = clips.whenSettled();
    const calls = onChange.mock.calls.length;
    clips.dispose();
    await settled;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onChange.mock.calls.length).toBe(calls);
    expect(clips.resolve('import:a')).toBeNull();
  });

  it('resolves whenSettled immediately when called after dispose, even with a load still in flight', async () => {
    // 与上一条不同：这里 `whenSettled()` 是在 `dispose()` **之后**才调用的，赶不上
    // dispose() 里那轮「叫醒当时已经在等的 waiters」。此时在途的下载有没有决出胜负都
    // 不再重要——不该让调用方等它自己的超时才罢休，见 `whenSettled()` 里的注释。
    let releaseA!: () => void;
    const gate = new Promise<void>((resolve) => (releaseA = resolve));
    const { clips } = setup(async () => {
      await gate;
      return mixamoFile();
    });
    clips.sync([motion('a')]);
    await vi.waitFor(() => expect(clips.statuses()).toEqual({ a: { state: 'loading' } }));

    clips.dispose();
    await expect(clips.whenSettled()).resolves.toBeUndefined();

    releaseA();
  });

  it('frees a shared URL cache once every queued reference is gone, even the one removed mid-flight', async () => {
    let releaseC!: () => void;
    const gate = new Promise<void>((resolve) => (releaseC = resolve));
    const { clips, deps } = setup(async (url) => {
      if (url === '/files/c.bvh') await gate;
      return mixamoFile();
    });
    // 队列是 a(X)、c(Y)、b(X)：a 和 b 共用一个 URL。
    clips.sync([motion('a', { url: '/files/x.bvh' }), motion('c'), motion('b', { url: '/files/x.bvh' })]);
    await vi.waitFor(() => expect(deps.fetchFile).toHaveBeenCalledWith('/files/c.bvh'));
    // c 还在下载 Y 的时候，把排在它后面、还没轮到的 b 删掉。
    clips.sync([motion('a', { url: '/files/x.bvh' }), motion('c')]);
    releaseC();
    await clips.whenSettled();
    expect(deps.fetchFile.mock.calls.map(([url]) => url)).toEqual(['/files/x.bvh', '/files/c.bvh']);

    // 重新加回一条用 X 的动作：X 的缓存该跟着被删掉的 b 一起释放掉了，得重新下载——
    // 不然如果那次缓存的是失败结果，这条新动作会直接继承那个永远翻不了身的错误。
    clips.sync([motion('a', { url: '/files/x.bvh' }), motion('c'), motion('d', { url: '/files/x.bvh' })]);
    await clips.whenSettled();
    expect(deps.fetchFile.mock.calls.map(([url]) => url)).toEqual(['/files/x.bvh', '/files/c.bvh', '/files/x.bvh']);
  });

  it('drops the result of a superseded fetch instead of writing it back', async () => {
    let releaseOld!: () => void;
    const gate = new Promise<void>((resolve) => (releaseOld = resolve));
    const { clips, deps, onChange } = setup(async (url) => {
      if (url === '/files/a.bvh') await gate;
      return mixamoFile();
    });
    clips.sync([motion('a')]);
    await vi.waitFor(() => expect(deps.fetchFile).toHaveBeenCalledWith('/files/a.bvh'));
    // 老的下载还卡着，这时候把同一个 id 换成另一个文件。
    clips.sync([motion('a', { url: '/files/other.bvh' })]);
    releaseOld();
    await clips.whenSettled();

    // 老结果不能写回：最终状态只能是新一轮下载落地的结果，广播次数也不多不少。
    expect(clips.statuses()).toEqual({ a: { state: 'ready' } });
    expect(clips.resolve('import:a')?.tracks.length).toBeGreaterThan(0);
    expect(onChange.mock.calls.map(([statuses]) => statuses)).toEqual([
      { a: { state: 'loading' } }, // 第一次 sync
      { a: { state: 'loading' } }, // 换文件，重新进入 loading
      { a: { state: 'ready' } }, // 只有新一轮下载落地才会再广播一次；老下载的收尾是静默的
    ]);
    expect(deps.fetchFile.mock.calls.map(([url]) => url)).toEqual(['/files/a.bvh', '/files/other.bvh']);
  });
});
