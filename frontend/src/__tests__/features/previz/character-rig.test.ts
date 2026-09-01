// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrevizObject } from '@/features/previz/domain/objects';
import type { PrevizCharacter } from '@/features/previz/domain/scene';
import {
  CharacterRigFactory,
  PREVIZ_ACTOR_MODEL_URL,
  type CharacterRigDeps,
  type PrevizGltf,
} from '@/features/previz/engine/characterRig';

function character(overrides: Partial<PrevizCharacter> = {}): PrevizCharacter {
  return { ...createPrevizObject('character', []), ...overrides };
}

/**
 * 一份够用的假 three。真 three 在 jsdom 里建不出 WebGL 上下文，而这个模块要测的全是
 * 「克隆了几次、姿势采在第几秒、缩放算成多少」这类结构性行为——`CharacterRigFactory`
 * 把 three 当构造参数收就是为了这个。
 */
class FakeObject3D {
  name = '';
  visible = true;
  userData: Record<string, unknown> = {};
  children: FakeObject3D[] = [];
  parent: FakeObject3D | null = null;
  position = new FakeVector3();
  rotation = new FakeVector3();
  scale = new FakeVector3(1, 1, 1);

  add(child: FakeObject3D) {
    child.parent = this;
    this.children.push(child);
    return this;
  }

  traverse(callback: (object: FakeObject3D) => void) {
    callback(this);
    for (const child of [...this.children]) child.traverse(callback);
  }
}

class FakeVector3 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}

  set(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
}

/** 打开后所有 `setFromObject()` 都交出空盒，模拟「模型解出来一片几何体都没有」。 */
let boxIsEmpty = false;

const setTime = vi.fn();
const play = vi.fn();
/** 每次 `clipAction(clip)` 收到的那条 clip，用来断言挑中的是哪一条。 */
let clipActions: Array<{ name: string }> = [];
/** 每个 AnimationMixer 是挂在谁身上建的：必须是克隆体，不是共享的源场景。 */
let mixerRoots: unknown[] = [];

function fakeThree() {
  return {
    Object3D: FakeObject3D,
    Group: FakeObject3D,
    /**
     * 净高 2 m、半宽 0.3 m 的一个模型。
     *
     * 关键在于它把**对象自身的缩放算进去**——真 `Box3.setFromObject()` 量的是世界包围盒，
     * 根对象的 scale 就在它的 matrixWorld 里。恒定尺寸的假实现会让「重量一次已经缩放过的
     * rig」这个错误完全测不出来。
     */
    Box3: class {
      min = new FakeVector3(Infinity, Infinity, Infinity);
      max = new FakeVector3(-Infinity, -Infinity, -Infinity);
      setFromObject(object: FakeObject3D) {
        if (boxIsEmpty) return this;
        this.min.set(-0.3 * object.scale.x, 0, -0.3 * object.scale.z);
        this.max.set(0.3 * object.scale.x, 2 * object.scale.y, 0.3 * object.scale.z);
        return this;
      }
      isEmpty() {
        return this.max.x < this.min.x || this.max.y < this.min.y || this.max.z < this.min.z;
      }
    },
    AnimationMixer: class {
      constructor(root: unknown) {
        mixerRoots.push(root);
      }
      clipAction(clip: { name: string }) {
        clipActions.push(clip);
        return { play };
      }
      setTime = setTime;
    },
  } as unknown as typeof import('three');
}

function gltf(clipNames: string[]): PrevizGltf {
  return {
    scene: new FakeObject3D() as unknown as PrevizGltf['scene'],
    animations: clipNames.map((name) => ({ name })) as unknown as PrevizGltf['animations'],
  };
}

/** 断言用的最小结构视图：`THREE.Object3D` 上的 scale/rotation 在假 three 里就是这个形状。 */
interface RigView {
  scale: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  userData: Record<string, unknown>;
}

function viewOf(rig: unknown): RigView {
  if (!rig) throw new Error('expected a rig');
  return rig as RigView;
}

/**
 * 真的克隆出一个新对象。`(object) => object` 这种恒等「克隆」会让同一次测试里的几个
 * 人物共用一个 rig，后一个的缩放把前一个的断言盖掉——而生产里 `SkeletonUtils.clone`
 * 本来就必须交出新对象，否则第二个人物一出现第一个就从原地消失。
 */
const freshClone = (() => new FakeObject3D()) as unknown as CharacterRigDeps['clone'];

function factoryWith(clipNames: string[]): CharacterRigFactory {
  return new CharacterRigFactory({
    three: fakeThree(),
    loadGltf: async () => gltf(clipNames),
    clone: freshClone,
  });
}

beforeEach(() => {
  boxIsEmpty = false;
  clipActions = [];
  mixerRoots = [];
  setTime.mockClear();
  play.mockClear();
});

describe('CharacterRigFactory', () => {
  it('points at a model that is really in public/', () => {
    // 路径写错就是一次静默 404：人物永远停在占位胶囊上，控制台之外什么都看不出来。
    // 期望值刻意写字面量，从被测模块 import 回来的常量改一处两边一起变。
    expect(PREVIZ_ACTOR_MODEL_URL).toBe('/viewer-kit/quaternius/ual2/UAL2_Standard.glb');
    expect(existsSync(resolve(process.cwd(), `public${PREVIZ_ACTOR_MODEL_URL}`))).toBe(true);
  });

  it('loads the shared model once and clones it per character', async () => {
    const loadGltf = vi.fn(async () => gltf(['Idle_Loop']));
    const clone = vi.fn((object: unknown) => object);
    const factory = new CharacterRigFactory({
      three: fakeThree(),
      loadGltf,
      clone: clone as CharacterRigDeps['clone'],
    });

    await factory.build(character());
    await factory.build(character());

    // 每个人物各下一次 8 MB 的 GLB 会把 50 人的场景变成 400 MB 流量。
    expect(loadGltf).toHaveBeenCalledTimes(1);
    expect(loadGltf).toHaveBeenCalledWith('/viewer-kit/quaternius/ual2/UAL2_Standard.glb');
    // 直接把共享的那份 scene 挂进场景的话，第二个人物一出现，第一个就从原地消失
    // （同一个 Object3D 只能有一个父节点）。
    expect(clone).toHaveBeenCalledTimes(2);
  });

  it('samples the catalogued clip at the catalogued time', async () => {
    // walking 那条候选刻意不排在第一位：排第一的话「随手拿 animations[0] 顶上」
    // 这种写法照样绿。
    const factory = factoryWith(['Sprint_Loop', 'Idle_Loop', 'Walk_Loop']);

    const rig = await factory.build(character({ basePoseId: 'walking' }));

    // 挑中的必须是 walking 那条候选，不是模型里的第一条 clip。
    expect(clipActions.map((clip) => clip.name)).toEqual(['Walk_Loop']);
    expect(play).toHaveBeenCalledTimes(1);
    // walking 的采样时刻是 0.35：定格在起步瞬间比定格在 0 更像「在走」。
    expect(setTime).toHaveBeenCalledWith(0.35);
    // mixer 必须挂在这个人物自己的克隆体上：挂在共享的源场景上，一个人物摆姿势
    // 会把所有人物一起摆过去。
    expect(mixerRoots).toHaveLength(1);
    expect(mixerRoots[0]).toBe(rig);
  });

  it('scales the model to the requested height', async () => {
    const factory = factoryWith(['Idle_Loop']);

    const rig = viewOf(await factory.build(character({ heightCm: 150, bodyType: 'average' })));

    // 假 Box3 给的模型净高是 2 m，要 1.5 m 就得整体缩到 0.75。
    expect(rig.scale.y).toBeCloseTo(0.75, 6);
    expect(rig.scale.x).toBeCloseTo(0.75, 6);
    expect(rig.scale.z).toBeCloseTo(0.75, 6);
  });

  it('clamps heightCm before scaling, the same way the placeholder capsule does', async () => {
    const factory = factoryWith(['Idle_Loop']);

    const tall = viewOf(await factory.build(character({ heightCm: 1e9 })));
    const tiny = viewOf(await factory.build(character({ heightCm: 0 })));
    const broken = viewOf(await factory.build(character({ heightCm: Number.NaN })));

    // 身高区间是 120..220 cm、默认 175。占位胶囊那边夹、这边不夹的话，模型一到位
    // 人物就会从一个 2.2 m 的胶囊变成一个一千万米高的巨人，把整个场景挤出视锥。
    expect(tall.scale.y).toBeCloseTo(1.1, 6);
    expect(tiny.scale.y).toBeCloseTo(0.6, 6);
    // 非有限值回落到默认身高而不是边界值，与 `clampToRange` 的约定一致；
    // 原样透出去的话缩放是 NaN，整棵子树的世界矩阵跟着烂掉，人物凭空消失。
    expect(broken.scale.y).toBeCloseTo(0.875, 6);
  });

  it('widens or narrows only the horizontal axes for body type', async () => {
    const factory = factoryWith(['Idle_Loop']);

    const heavy = viewOf(await factory.build(character({ heightCm: 200, bodyType: 'heavy' })));
    const slim = viewOf(await factory.build(character({ heightCm: 200, bodyType: 'slim' })));

    // 身高换算给的是 1.0，体型只加宽 X/Z：连 Y 一起放大等于又改了身高。
    expect(heavy.scale.y).toBeCloseTo(1, 6);
    expect(heavy.scale.x).toBeCloseTo(1.15, 6);
    expect(heavy.scale.z).toBeCloseTo(1.15, 6);
    expect(slim.scale.y).toBeCloseTo(1, 6);
    expect(slim.scale.x).toBeCloseTo(0.9, 6);
    expect(slim.scale.z).toBeCloseTo(0.9, 6);
  });

  it('keeps the scale finite when the model has no geometry to measure', async () => {
    boxIsEmpty = true;
    const factory = factoryWith(['Idle_Loop']);

    const rig = viewOf(await factory.build(character({ heightCm: 180, bodyType: 'heavy' })));

    // 净高 0 时除下去是 Infinity，模型被炸到视锥之外——宁可尺寸不对也要留有限值。
    expect(rig.scale.y).toBe(1);
    expect(rig.scale.x).toBeCloseTo(1.15, 6);
  });

  it('rescales an existing rig from the native height, not the already scaled one', async () => {
    const factory = factoryWith(['Idle_Loop']);
    const rig = await factory.build(character({ heightCm: 150 }));
    expect(viewOf(rig).scale.y).toBeCloseTo(0.75, 6);

    factory.applyBodyScale(rig!, character({ heightCm: 200, bodyType: 'heavy' }));

    // 净高只能在缩放还是 1 的时候量一次。重量一次量到的是已经缩到 1.5 m 的身体，
    // 于是 2.0 / 1.5 = 1.333 —— 拖两次身高滑杆，人就越长越高。
    expect(viewOf(rig).scale.y).toBeCloseTo(1, 6);
    expect(viewOf(rig).scale.x).toBeCloseTo(1.15, 6);
  });

  it('applies the pose adjust angles in degrees', async () => {
    const factory = factoryWith(['Idle_Loop']);

    const rig = viewOf(
      await factory.build(character({ poseAdjust: { pitch: 30, turn: -45, lean: 10 } })),
    );

    expect(rig.rotation.x).toBeCloseTo(Math.PI / 6, 6);
    expect(rig.rotation.y).toBeCloseTo(-Math.PI / 4, 6);
    expect(rig.rotation.z).toBeCloseTo(Math.PI / 18, 6);
  });

  it('clamps the pose adjust angles into their own ranges', async () => {
    const factory = factoryWith(['Idle_Loop']);

    const rig = viewOf(
      await factory.build(
        character({ poseAdjust: { pitch: 90, turn: -180, lean: Number.NaN } }),
      ),
    );

    // 区间是 pitch -30..45 / turn -60..60 / lean -35..35（`PREVIZ_POSE_ADJUST_RANGE`）。
    // 超界的角木偶做不出来，只会把关节拧穿；非有限值回落到 0，否则整棵子树的世界矩阵
    // 变成 NaN，人物从画面上凭空消失而 three 一声不吭。
    expect(rig.rotation.x).toBeCloseTo(Math.PI / 4, 6);
    expect(rig.rotation.y).toBeCloseTo(-Math.PI / 3, 6);
    expect(rig.rotation.z).toBe(0);
  });

  it('returns null instead of throwing when the model cannot be loaded', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loadGltf = vi.fn(async () => {
      throw new Error('404');
    });
    const factory = new CharacterRigFactory({
      three: fakeThree(),
      loadGltf,
      clone: freshClone,
    });

    // 模型 404、GLB 换版本导致 clip 全对不上、解码失败——任何一种都不该把整个
    // 编辑器打挂。返回 null，调用方保留占位胶囊。
    await expect(factory.build(character())).resolves.toBeNull();
    expect(error).toHaveBeenCalled();

    // 失败的 Promise 缓存住会让后续每个人物都拿到同一个错误，重试永远不发生。
    await expect(factory.build(character())).resolves.toBeNull();
    expect(loadGltf).toHaveBeenCalledTimes(2);

    error.mockRestore();
  });

  it('still returns a model when no clip matches the pose', async () => {
    const factory = factoryWith(['Some_Unknown_Clip']);

    const rig = await factory.build(character());

    // 姿势对不上就用模型的绑定姿势站着，比整个人消失强。
    expect(rig).not.toBeNull();
    // 但绝不能拿模型里随便一条 clip 顶上：那会摆出一个跟属性面板完全对不上的姿势。
    expect(clipActions).toHaveLength(0);
    expect(setTime).not.toHaveBeenCalled();
    // 身高体型照常生效——姿势没解出来不该连缩放一起放弃。
    expect(viewOf(rig).scale.y).toBeCloseTo(0.875, 6);
  });

  it('marks the rig so the scene graph can find it again', async () => {
    const factory = factoryWith(['Idle_Loop']);

    const rig = viewOf(await factory.build(character()));

    // 场景图靠这个标记在节点的子节点里认出「已经换过模型了」，也靠它拿到要重新缩放的
    // 那个根节点。丢了它，每次 sync 都会再下一次模型往同一个节点上叠。
    expect(rig.userData.previzRig).toBe(true);
  });
});

describe('CharacterRigFactory.applyCharacter', () => {
  it('re-poses a rig that is already in the scene', async () => {
    const factory = factoryWith(['Idle_Loop', 'Walk_Loop']);
    const rig = await factory.build(character({ basePoseId: 'standing' }));
    clipActions = [];
    setTime.mockClear();

    factory.applyCharacter(rig!, character({ basePoseId: 'walking' }));

    // 模型是在第一次 sync 时按当时的姿势定格的。之后只重新缩放的话，属性面板的
    // 「基础姿势」下拉框对已加载的人物完全失效——改成抱臂，人还站着。
    expect(clipActions.map((clip) => clip.name)).toEqual(['Walk_Loop']);
    expect(setTime).toHaveBeenCalledWith(0.35);
  });

  it('re-applies the pose adjust angles and the body scale', async () => {
    const factory = factoryWith(['Idle_Loop']);
    const rig = await factory.build(character({ heightCm: 150 }));

    factory.applyCharacter(
      rig!,
      character({ heightCm: 200, bodyType: 'heavy', poseAdjust: { pitch: 30, turn: -45, lean: 10 } }),
    );

    expect(viewOf(rig).rotation.x).toBeCloseTo(Math.PI / 6, 6);
    expect(viewOf(rig).rotation.y).toBeCloseTo(-Math.PI / 4, 6);
    expect(viewOf(rig).rotation.z).toBeCloseTo(Math.PI / 18, 6);
    expect(viewOf(rig).scale.y).toBeCloseTo(1, 6);
    expect(viewOf(rig).scale.x).toBeCloseTo(1.15, 6);
  });

  it('does not rebuild the mixer when the pose has not changed', async () => {
    const factory = factoryWith(['Idle_Loop']);
    const rig = await factory.build(character({ basePoseId: 'standing' }));
    clipActions = [];
    mixerRoots = [];

    factory.applyCharacter(rig!, character({ basePoseId: 'standing', heightCm: 200 }));

    // sync 每次编辑都跑。姿势没变还建一个 AnimationMixer、把整副骨架重推一遍，
    // 是拖身高滑杆时每一帧都要付的钱。
    expect(mixerRoots).toHaveLength(0);
    expect(clipActions).toHaveLength(0);
    expect(viewOf(rig).scale.y).toBeCloseTo(1, 6);
  });

  it('keeps the rig posed when the new pose resolves to nothing', async () => {
    const factory = factoryWith(['Idle_Loop']);
    const rig = await factory.build(character({ basePoseId: 'standing' }));
    clipActions = [];

    factory.applyCharacter(rig!, character({ basePoseId: 'sword', heightCm: 200 }));

    // 模型里没有 sword 的候选 clip：保持现有姿势，绝不拿别的 clip 顶上。
    // 缩放照常生效——姿势解不出来不该连身高一起放弃。
    expect(clipActions).toHaveLength(0);
    expect(viewOf(rig).scale.y).toBeCloseTo(1, 6);
  });
});
