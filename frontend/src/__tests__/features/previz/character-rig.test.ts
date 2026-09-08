// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrevizObject } from '@/features/previz/domain/objects';
import { PREVIZ_POSE_CLIPS } from '@/features/previz/domain/poses';
import type { PrevizCharacter } from '@/features/previz/domain/scene';
import {
  CharacterRigFactory,
  disposeRigMaterials,
  PREVIZ_ACTOR_ANIMATION_URLS,
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

/**
 * 源模型的两个材质槽，照着仓库里那份 UAL2：一槽主体、一槽关节，两槽明暗不同。
 * 值取的是那两份 `baseColorFactor` 换算过来的颜色，好让「亮暗关系」这条断言测的
 * 是真模型的量级，而不是随手编的两个数。
 */
const SOURCE_MAIN_COLOR = 0xeaab3a;
const SOURCE_JOINT_COLOR = 0xaa65dd;

/**
 * 颜色不能只是一个 `set` 桩：辨识色要按材质自己的明度分级染上去，读不到通道就
 * 「主体和关节染成同一个色」和「关节按明度压暗」在断言里分不开——而那正是这组
 * 用例要测的东西。通道按 sRGB 字节直接摊开，不做 gamma：这份假实现要能锁住的是
 * 「哪一槽拿到纯正的辨识色、哪一槽被压暗」，不是 three 的色彩空间换算。
 */
class FakeColor {
  r = 1;
  g = 1;
  b = 1;
  /** 记成 spy：颜色没变时那条早退路径靠「一次都没写」才看得出来。 */
  set = vi.fn((value: number | string) => {
    const hex = typeof value === 'number' ? value : Number.parseInt(value.slice(1), 16);
    this.r = ((hex >> 16) & 0xff) / 255;
    this.g = ((hex >> 8) & 0xff) / 255;
    this.b = (hex & 0xff) / 255;
    return this;
  });

  constructor(hex: number) {
    this.set(hex);
    this.set.mockClear();
  }

  multiplyScalar(scalar: number) {
    this.r *= scalar;
    this.g *= scalar;
    this.b *= scalar;
    return this;
  }

  /** 与真 `Color.getHex()` 一样把通道夹回 0..1 再取整：越界的通道会溢进相邻字节。 */
  getHex() {
    const byte = (channel: number) => Math.max(0, Math.min(255, Math.round(channel * 255)));
    return (byte(this.r) << 16) | (byte(this.g) << 8) | byte(this.b);
  }
}

class FakeMaterial {
  color: FakeColor;
  userData: Record<string, unknown> = {};
  dispose = vi.fn();
  /** 按实例记 spy：一个 rig 该只克隆一次，每次 sync 重克隆是按帧漏显存。 */
  clone = vi.fn((): FakeMaterial => new FakeMaterial(this.color.getHex()));

  constructor(hex: number) {
    this.color = new FakeColor(hex);
  }
}

class FakeMesh extends FakeObject3D {
  /** 数组形态是真事：一个网格挂多份材质在 glTF 里靠 groups 分段，`ownMaterials` 得认。 */
  constructor(public material: FakeMaterial | FakeMaterial[]) {
    super();
  }
}

/** 打开后所有 `setFromObject()` 都交出空盒，模拟「模型解出来一片几何体都没有」。 */
let boxIsEmpty = false;

const setTime = vi.fn();
const play = vi.fn();
const stopAllAction = vi.fn();
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
      stopAllAction = stopAllAction;
    },
  } as unknown as typeof import('three');
}

function gltf(clipNames: string[]): PrevizGltf {
  const scene = new FakeObject3D();
  // 暗的那一槽刻意排在前面：「拿遇到的第一份材质当基准」这种写法会把亮暗关系倒过来，
  // 而模型里材质槽的先后本来就是导出工具定的，谁都不该依赖它。
  scene.add(new FakeMesh(new FakeMaterial(SOURCE_JOINT_COLOR)));
  scene.add(new FakeMesh(new FakeMaterial(SOURCE_MAIN_COLOR)));
  return {
    scene: scene as unknown as PrevizGltf['scene'],
    animations: clipNames.map((name) => ({ name })) as unknown as PrevizGltf['animations'],
  };
}

/** 一棵子树里的材质，按遍历顺序。源模型是 [关节, 主体]，克隆体同序。 */
function materialsOf(object: unknown): FakeMaterial[] {
  const found: FakeMaterial[] = [];
  (object as FakeObject3D).traverse((child) => {
    const material = (child as FakeMesh).material;
    if (!material) return;
    found.push(...(Array.isArray(material) ? material : [material]));
  });
  return found;
}

/** 一个 rig 上每份材质当前的颜色，按 [关节, 主体] 的顺序。 */
function coloursOf(rig: unknown): number[] {
  return materialsOf(rig).map((material) => material.color.getHex());
}

/** 断言用的最小结构视图：`THREE.Object3D` 上的 scale/rotation 在假 three 里就是这个形状。 */
interface RigView {
  scale: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  userData: Record<string, unknown>;
  children: RigView[];
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
const freshClone = ((object: FakeObject3D) => shallowClone(object)) as unknown as
  CharacterRigDeps['clone'];

/**
 * 结构上是新的一棵树，材质仍指向源模型那几份——`SkeletonUtils.clone` 就是这样的浅克隆，
 * 而这一点正是「染一个人物会不会把所有人物连同源模型一起染了」的全部要害。
 * 材质也一起新建的假克隆会让那个 bug 完全测不出来。
 */
function shallowClone(object: FakeObject3D): FakeObject3D {
  const material = (object as FakeMesh).material;
  const copy = material ? new FakeMesh(material) : new FakeObject3D();
  for (const child of object.children) copy.add(shallowClone(child));
  return copy;
}

/**
 * 直接从 public/ 里的 GLB 读 clip 名。GLB 头 12 字节之后是第一个 chunk（JSON）的长度与
 * 类型，再往后就是 glTF 的 JSON 本体——不用拉起 three 的加载器就能看到 `animations[].name`。
 */
function shippedClipNames(url: string): string[] {
  const file = readFileSync(resolve(process.cwd(), `public${url}`));
  const jsonLength = file.readUInt32LE(12);
  const json = JSON.parse(file.subarray(20, 20 + jsonLength).toString('utf8')) as {
    animations?: Array<{ name: string }>;
  };
  return (json.animations ?? []).map((clip) => clip.name);
}

/**
 * 模型每次都成功，动画库第一次 404、之后成功——模拟「网络抖了一下」。
 * 两份都成功的版本用 `factoryWith` 就够了。
 */
function flakyLibrary(modelClips: string[], libraryClips: string[]) {
  let libraryAttempts = 0;
  return async (url: string) => {
    if (url === PREVIZ_ACTOR_MODEL_URL) return gltf(modelClips);
    libraryAttempts += 1;
    if (libraryAttempts === 1) throw new Error('503');
    return gltf(libraryClips);
  };
}

function factoryWith(clipNames: string[]): CharacterRigFactory {
  return new CharacterRigFactory({
    three: fakeThree(),
    loadGltf: async () => gltf(clipNames),
    clone: freshClone,
  });
}

/** 同 `factoryWith`，但把那份共享源模型也交出来：染色这组用例要盯着它有没有被碰。 */
function factoryWithSource(clipNames: string[]) {
  const source = gltf(clipNames);
  const factory = new CharacterRigFactory({
    three: fakeThree(),
    loadGltf: async () => source,
    clone: freshClone,
  });
  return { factory, source, materials: materialsOf(source.scene) };
}

/**
 * 照给定的那几个材质槽建一份源模型的工厂。染色这组里有两个用例要的不是仓库那份
 * UAL2 的槽位，而是特定的明暗组合。
 */
function factoryForScene(scene: FakeObject3D): CharacterRigFactory {
  return new CharacterRigFactory({
    three: fakeThree(),
    loadGltf: async () =>
      ({ scene, animations: [{ name: 'Idle_Loop' }] }) as unknown as PrevizGltf,
    clone: freshClone,
  });
}

beforeEach(() => {
  boxIsEmpty = false;
  clipActions = [];
  mixerRoots = [];
  setTime.mockClear();
  play.mockClear();
  stopAllAction.mockClear();
});

describe('CharacterRigFactory', () => {
  it('points at a model that is really in public/', () => {
    // 路径写错就是一次静默 404：人物永远停在占位胶囊上，控制台之外什么都看不出来。
    // 期望值刻意写字面量，从被测模块 import 回来的常量改一处两边一起变。
    expect(PREVIZ_ACTOR_MODEL_URL).toBe('/viewer-kit/quaternius/ual2/UAL2_Standard.glb');
    expect(existsSync(resolve(process.cwd(), `public${PREVIZ_ACTOR_MODEL_URL}`))).toBe(true);
    expect(PREVIZ_ACTOR_ANIMATION_URLS).toEqual(['/viewer-kit/quaternius/ual1/UAL1_Standard.glb']);
    for (const url of PREVIZ_ACTOR_ANIMATION_URLS) {
      expect(existsSync(resolve(process.cwd(), `public${url}`))).toBe(true);
    }
  });

  it('ships the first-choice clip of every pose in the model or its animation library', () => {
    // 候选表是对着 UAL2 + UAL1 两份文件挑的。只加载其中一份时候选会静默往后落：
    // 「蹲伏」两条都没有就保持上一姿势，「坐下」落到靠栏杆，「奔跑」落到持盾冲刺，
    // 「行走」和「持物」都落到同一条 Walk_Carry_Loop——下拉框选什么和画面对不上。
    // 这条盯的是首选而不是「随便哪条候选在」：后备候选本来就是将就用的。
    const shipped = new Set(
      [PREVIZ_ACTOR_MODEL_URL, ...PREVIZ_ACTOR_ANIMATION_URLS].flatMap(shippedClipNames),
    );
    for (const [pose, config] of Object.entries(PREVIZ_POSE_CLIPS)) {
      expect(shipped.has(config.names[0]!), `${pose} → ${config.names[0]}`).toBe(true);
    }
  });

  it('loads the shared model and its animation library once, cloning per character', async () => {
    const loadGltf = vi.fn(async (_url: string) => gltf(['Idle_Loop']));
    const clone = vi.fn((object: unknown) => object);
    const factory = new CharacterRigFactory({
      three: fakeThree(),
      loadGltf,
      clone: clone as CharacterRigDeps['clone'],
    });

    await factory.build(character());
    await factory.build(character());

    // 每个人物各下一次 8 MB 的 GLB 会把 50 人的场景变成 400 MB 流量——模型和动画库都是。
    expect(loadGltf.mock.calls.map(([url]) => url)).toEqual([
      '/viewer-kit/quaternius/ual2/UAL2_Standard.glb',
      '/viewer-kit/quaternius/ual1/UAL1_Standard.glb',
    ]);
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

  it('resolves a pose from the animation library when the model lacks the clip', async () => {
    // UAL2 自己没有任何蹲姿 clip；「蹲伏」只能靠 UAL1 里的 Crouch_Idle_Loop。
    const loadGltf = vi.fn(async (url: string) =>
      url === PREVIZ_ACTOR_MODEL_URL ? gltf(['Idle_No_Loop']) : gltf(['Crouch_Idle_Loop']),
    );
    const factory = new CharacterRigFactory({ three: fakeThree(), loadGltf, clone: freshClone });

    const rig = await factory.build(character({ basePoseId: 'crouching' }));

    expect(rig).not.toBeNull();
    expect(clipActions.map((clip) => clip.name)).toEqual(['Crouch_Idle_Loop']);
    expect(setTime).toHaveBeenCalledWith(0.25);
  });

  it("prefers the model's own clip when the library repeats a name", async () => {
    const own = gltf(['Idle_Loop']);
    const library = gltf(['Idle_Loop']);
    const loadGltf = vi.fn(async (url: string) => (url === PREVIZ_ACTOR_MODEL_URL ? own : library));
    const factory = new CharacterRigFactory({ three: fakeThree(), loadGltf, clone: freshClone });

    await factory.build(character({ basePoseId: 'standing' }));

    // 两份文件都带 A_TPose 这类同名 clip：模型自己那条是对着自己的骨架导出的，以它为准。
    expect(clipActions).toHaveLength(1);
    expect(clipActions[0]).toBe(own.animations[0]);
  });

  it('still builds and poses from the model when the animation library fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadGltf = vi.fn(async (url: string) => {
      if (url !== PREVIZ_ACTOR_MODEL_URL) throw new Error('404');
      return gltf(['Idle_No_Loop']);
    });
    const factory = new CharacterRigFactory({ three: fakeThree(), loadGltf, clone: freshClone });

    const rig = await factory.build(character({ basePoseId: 'standing' }));

    // 动画库下不下来只掉姿势不掉人：模型自带的候选照常用，控制台留一条 warn 说明原因。
    expect(rig).not.toBeNull();
    expect(clipActions.map((clip) => clip.name)).toEqual(['Idle_No_Loop']);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('retries a failed animation library on the next build, keeping the model', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadGltf = vi.fn(flakyLibrary(['Idle_No_Loop'], ['Crouch_Idle_Loop']));
    const factory = new CharacterRigFactory({ three: fakeThree(), loadGltf, clone: freshClone });

    await factory.build(character({ basePoseId: 'crouching' }));
    // 库没到：蹲伏在模型自带的 clip 里没有候选，人保持绑定姿势。
    expect(clipActions).toHaveLength(0);

    await factory.build(character({ basePoseId: 'crouching' }));

    // 库下不下来往往只是网络抖一下，不该让整个会话的蹲、坐、走、跑永远对不上；
    // 但 8 MB 的模型已经在手里，重试只该再下库那一份。
    const urls = loadGltf.mock.calls.map(([url]) => url);
    expect(urls.filter((url) => url === PREVIZ_ACTOR_MODEL_URL)).toHaveLength(1);
    expect(urls.filter((url) => url !== PREVIZ_ACTOR_MODEL_URL)).toHaveLength(2);
    expect(clipActions.map((clip) => clip.name)).toEqual(['Crouch_Idle_Loop']);

    warn.mockRestore();
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

  it('narrows a tall build past a slim one', async () => {
    const factory = factoryWith(['Idle_Loop']);

    const tall = viewOf(await factory.build(character({ heightCm: 180, bodyType: 'tall' })));
    const slim = viewOf(await factory.build(character({ heightCm: 180, bodyType: 'slim' })));

    // 「高挑」在这套模型里只有一个可用的表达手段：同样的身高下把人削得比「偏瘦」更窄。
    // 身高本身是另一根滑杆，体型这一档不该去碰它——两者一起动，用户拖身高时会发现
    // 换个体型身高也跟着变，两个控件互相打架。
    expect(tall.scale.x).toBeLessThan(slim.scale.x);
    expect(tall.scale.y).toBeCloseTo(slim.scale.y, 6);
    expect(tall.scale.z).toBeCloseTo(tall.scale.x, 6);
  });

  // 「简化圆柱体」在缩放表里必须是 1：它列在表里只为让 `Record<BodyType, …>` 保持穷尽，
  // 真正的分叉在场景图那条换模型的路上。给它一个 ≠1 的宽度，就等于给这一档偷偷加了
  // 一层胖瘦语义——将来那条分叉一旦回落到 GLB（模型下不来），人会莫名其妙地变形。
  // 注意这条断言区分不了 `capsule` 和 `average`（两者都是 1）：这一轮不需要区分。
  it('leaves the simplified-cylinder build at its natural width', async () => {
    const factory = factoryWith(['Idle_Loop']);

    const rig = viewOf(await factory.build(character({ heightCm: 200, bodyType: 'capsule' })));

    expect(rig.scale.y).toBeCloseTo(1, 6);
    expect(rig.scale.x).toBeCloseTo(1, 6);
    expect(rig.scale.z).toBeCloseTo(1, 6);
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadGltf = vi.fn(async (_url: string) => {
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
    const modelRequests = loadGltf.mock.calls.filter(([url]) => url === PREVIZ_ACTOR_MODEL_URL);
    expect(modelRequests).toHaveLength(2);

    warn.mockRestore();
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

  it('turns the model half a turn so its face points where the heading arrow does', async () => {
    const factory = factoryWith(['Idle_Loop']);

    const adjust = { pitch: 0, turn: 30, lean: 0 };
    const rig = viewOf(await factory.build(character({ poseAdjust: adjust })));

    // Quaternius 模型的脸朝 +Z（脚尖顶点在 +Z 侧），而预演台的「正前方」是 -Z：机位、
    // 路径切线、选中环上的箭头都按这条。不转这半圈，人物沿路径倒着走，箭头指着后脑勺。
    expect(rig.children).toHaveLength(1);
    expect(rig.children[0].rotation.y).toBeCloseTo(Math.PI, 10);
    // 半圈转在克隆体上、姿态微调在外层。叠在同一个对象上的话，下一次 sync 重写
    // rotation 就把半圈抹掉了，人物又转回去。
    expect(rig.rotation.y).toBeCloseTo(Math.PI / 6, 10);
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

  it('re-poses a rig built before the animation library arrived', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadGltf = vi.fn(flakyLibrary(['Idle_No_Loop'], ['Crouch_Idle_Loop']));
    const factory = new CharacterRigFactory({ three: fakeThree(), loadGltf, clone: freshClone });
    const early = await factory.build(character({ basePoseId: 'crouching' }));
    await factory.build(character({ basePoseId: 'standing' }));
    clipActions = [];
    mixerRoots = [];

    factory.applyCharacter(early!, character({ basePoseId: 'crouching' }));

    // 库补到之后，早先按残缺列表落的候选就过时了：下一次 sync 得按新列表重摆，
    // 不然先建的人物永远蹲不下去、后建的能蹲——看着像随机失灵。
    expect(clipActions.map((clip) => clip.name)).toEqual(['Crouch_Idle_Loop']);
    expect(mixerRoots).toEqual([early]);

    // 重摆只做一次：之后的 sync 又回到「姿势没变就早退」。
    factory.applyCharacter(early!, character({ basePoseId: 'crouching' }));
    expect(mixerRoots).toHaveLength(1);

    warn.mockRestore();
  });

  it('does not re-pose a rig when a later build finds the same clip list', async () => {
    const factory = factoryWith(['Idle_Loop']);
    const first = await factory.build(character({ basePoseId: 'standing' }));
    await factory.build(character({ basePoseId: 'standing' }));
    mixerRoots = [];

    factory.applyCharacter(first!, character({ basePoseId: 'standing' }));

    // 每次 build 都把合成结果当新的，会让每加一个人物就把场上所有人物重摆一遍。
    expect(mixerRoots).toHaveLength(0);
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

describe('CharacterRigFactory.applyPose', () => {
  it('advances the walk cycle to the requested second', async () => {
    const factory = factoryWith(['Idle_Loop', 'Walk_Loop']);
    const rig = await factory.build(character({ basePoseId: 'standing' }));
    clipActions = [];
    setTime.mockClear();
    stopAllAction.mockClear();

    factory.applyPose(rig!, 'walking', 1.5);

    // 沿路径走位时每帧推一次。不停掉上一条 action 的话，站姿和走姿两条权重都是 1，
    // 骨骼被拧到两者之和上。
    expect(stopAllAction).toHaveBeenCalledTimes(1);
    expect(clipActions.map((clip) => clip.name)).toEqual(['Walk_Loop']);
    expect(setTime).toHaveBeenCalledWith(1.5);
  });

  it('keeps one mixer per rig and only moves the clock between frames', async () => {
    const factory = factoryWith(['Idle_Loop', 'Walk_Loop']);
    const rig = await factory.build(character({ basePoseId: 'standing' }));
    factory.applyPose(rig!, 'walking', 0.1);
    mixerRoots = [];
    clipActions = [];
    stopAllAction.mockClear();
    setTime.mockClear();

    factory.applyPose(rig!, 'walking', 0.2);
    factory.applyPose(rig!, 'walking', 0.3);

    // 每帧新建一个 mixer、重新 play 一次的话，clipAction 要把几十根骨骼的绑定重新解一遍，
    // 那是播放时每一帧都要付的钱。
    expect(mixerRoots).toHaveLength(0);
    expect(clipActions).toHaveLength(0);
    expect(stopAllAction).not.toHaveBeenCalled();
    expect(setTime.mock.calls).toEqual([[0.2], [0.3]]);
  });

  it('does nothing when the pose and the time are both unchanged', async () => {
    const factory = factoryWith(['Idle_Loop', 'Walk_Loop']);
    const rig = await factory.build(character({ basePoseId: 'standing' }));
    factory.applyPose(rig!, 'walking', 0.5);
    setTime.mockClear();

    factory.applyPose(rig!, 'walking', 0.5);

    // 暂停时每次 sync 都会把同一帧重放一遍，不早退就是白推一遍骨架。
    expect(setTime).not.toHaveBeenCalled();
  });

  it('keeps the current clip when the requested pose resolves to nothing', async () => {
    const factory = factoryWith(['Idle_Loop']);
    const rig = await factory.build(character({ basePoseId: 'standing' }));
    clipActions = [];
    stopAllAction.mockClear();

    factory.applyPose(rig!, 'moonwalk', 1);

    // 对不上就保持现有姿势：绝不拿别的 clip 顶上，也不把正在播的停掉留下一副绑定姿势。
    expect(clipActions).toHaveLength(0);
    expect(stopAllAction).not.toHaveBeenCalled();
  });
});

describe('CharacterRigFactory tinting', () => {
  it('paints every rig in its own colour without touching the shared source model', async () => {
    const { factory, materials } = factoryWithSource(['Idle_Loop']);

    const red = await factory.build(character({ color: '#ff0000' }));
    const green = await factory.build(character({ color: '#00ff00' }));

    // 直接改材质的颜色，改的是源模型那一份——所有人物共用它，四个人瞬间同色，
    // 而且之后新建的每一个人物都从已经被染过的源上克隆下来。
    expect(coloursOf(red)[1]).toBe(0xff0000);
    expect(coloursOf(green)[1]).toBe(0x00ff00);
    expect(materials.map((material) => material.color.getHex())).toEqual([
      SOURCE_JOINT_COLOR,
      SOURCE_MAIN_COLOR,
    ]);
  });

  it("keeps the model's own light and shade instead of flattening it", async () => {
    const { factory } = factoryWithSource(['Idle_Loop']);

    const [joint, main] = coloursOf(await factory.build(character({ color: '#ff0000' })));

    // 最亮的那一槽拿到纯正的辨识色：属性面板上的色块和视口里的人物必须是同一个颜色，
    // 否则「按颜色认人」这件事在两处对不上。
    expect(main).toBe(0xff0000);
    // 其余各槽按自己在源模型里的明度压暗。整个模型刷成同一颗纯色的话，两槽之间的
    // 明暗关系没了——人物看起来是一个色块而不是一个人。
    expect(joint).not.toBe(main);
    const red = ((joint ?? 0) >> 16) & 0xff;
    expect(red).toBeGreaterThan(0);
    expect(red).toBeLessThan(0xff);
    // 压暗只动明度不动色相：关节槽在源模型里是紫的，染完不该还留着紫。
    expect((joint ?? 0) & 0x00ffff).toBe(0);
  });

  it('re-tints the materials it already cloned instead of cloning a fresh batch', async () => {
    const { factory, materials } = factoryWithSource(['Idle_Loop']);
    const rig = await factory.build(character({ color: '#ff0000' }));
    const owned = materialsOf(rig);

    factory.applyCharacter(rig!, character({ color: '#0000ff' }));

    // 属性面板的色板一点就是一次 sync。每次都重克隆一批材质，等于每换一次颜色
    // 漏一批 GPU 资源，而画面上什么都看不出来。
    expect(materialsOf(rig)[0]).toBe(owned[0]);
    expect(materialsOf(rig)[1]).toBe(owned[1]);
    for (const material of materials) expect(material.clone).toHaveBeenCalledTimes(1);
    expect(coloursOf(rig)[1]).toBe(0x0000ff);
  });

  it('leaves the materials alone when the colour has not changed', async () => {
    const { factory } = factoryWithSource(['Idle_Loop']);
    const rig = await factory.build(character({ color: '#ff0000' }));
    for (const material of materialsOf(rig)) material.color.set.mockClear();

    factory.applyCharacter(rig!, character({ color: '#ff0000', heightCm: 200 }));

    // sync 每帧都跑。颜色没变还重染一遍，场景图那边就会跟着每帧重刷一次显示模式——
    // 而那要遍历整棵模型子树。
    for (const material of materialsOf(rig)) {
      expect(material.color.set).not.toHaveBeenCalled();
    }
  });

  it('disposes the materials it cloned, and only those', async () => {
    const { factory, materials } = factoryWithSource(['Idle_Loop']);
    const rig = await factory.build(character());
    const owned = materialsOf(rig);

    disposeRigMaterials(rig!);

    // `previzSharedModel` 让 `disposeSubtree` 整棵跳过，所以每 rig 独有的这几份克隆
    // 材质没有别人替它还——少了这条定向回收，每删一个人物漏一批材质。
    for (const material of owned) expect(material.dispose).toHaveBeenCalledTimes(1);
    // 源模型那批是所有人物共用的：还掉之后新建的人物拿到的是已经 dispose 的材质。
    for (const material of materials) expect(material.dispose).not.toHaveBeenCalled();
  });

  it('clones one material per source slot, not one per mesh', async () => {
    // 一份材质挂在多个网格上是导出工具的常态（同一份皮肤拆成好几个 primitive）。
    const shared = new FakeMaterial(SOURCE_MAIN_COLOR);
    const scene = new FakeObject3D();
    scene.add(new FakeMesh(shared));
    scene.add(new FakeMesh(shared));

    const rig = await factoryForScene(scene).build(character({ color: '#ff0000' }));

    // 一槽克隆一份就够。一网格一份既白占显存，又只有最后那一份进得了染色名单——
    // 同一块皮肤于是半边染上了辨识色、半边还是模型的原色。
    expect(shared.clone).toHaveBeenCalledTimes(1);
    const [first, second] = materialsOf(rig);
    expect(first).toBe(second);
    expect(coloursOf(rig)).toEqual([0xff0000, 0xff0000]);
  });

  it('ranks the slots by brightness rather than by a single channel', async () => {
    // 一槽暗红、一槽亮绿。按红通道分级会把这两槽的明暗判反：最显眼的那一槽拿不到
    // 纯正的辨识色，反而被压到全黑——那是拿色相当亮度使。
    const scene = new FakeObject3D();
    scene.add(new FakeMesh(new FakeMaterial(0xff0000)));
    scene.add(new FakeMesh(new FakeMaterial(0x00ff00)));

    const rig = await factoryForScene(scene).build(character({ color: '#ffffff' }));

    const [dim, bright] = coloursOf(rig);
    expect(bright).toBe(0xffffff);
    expect((dim ?? 0) >> 16).toBeGreaterThan(0);
    expect(dim).not.toBe(bright);
  });

  it('still paints a model whose slots are all black', async () => {
    const scene = new FakeObject3D();
    scene.add(new FakeMesh(new FakeMaterial(0x000000)));

    const rig = await factoryForScene(scene).build(character({ color: '#ff0000' }));

    // 一片全黑的模型除下去是 0/0。按 0 算的话每一槽都被压成全黑，人物在视口里
    // 是一团看不出形状的黑影；按 1 算至少每一槽都是纯正的辨识色。
    expect(coloursOf(rig)).toEqual([0xff0000]);
  });

  it('clones every slot of a mesh that carries a material array', async () => {
    // 一个网格挂多份材质（glTF 里靠 groups 分段）是导出工具的常态。只认单份的话，
    // 这种网格整个跳过染色：人物身上一大块还留着模型的原色。
    const joint = new FakeMaterial(SOURCE_JOINT_COLOR);
    const main = new FakeMaterial(SOURCE_MAIN_COLOR);
    const scene = new FakeObject3D();
    scene.add(new FakeMesh([joint, main]));

    const rig = await factoryForScene(scene).build(character({ color: '#ff0000' }));

    expect(coloursOf(rig)[1]).toBe(0xff0000);
    expect(coloursOf(rig)[0]).not.toBe(SOURCE_JOINT_COLOR);
    // 源模型那两份仍旧一份没被碰：数组分支同样得走克隆。
    expect(joint.color.getHex()).toBe(SOURCE_JOINT_COLOR);
    expect(main.color.getHex()).toBe(SOURCE_MAIN_COLOR);
  });

  it('is a no-op the second time the same rig is disposed', async () => {
    const { factory } = factoryWithSource(['Idle_Loop']);
    const rig = await factory.build(character());
    const owned = materialsOf(rig);

    disposeRigMaterials(rig!);
    disposeRigMaterials(rig!);

    // 这是个导出函数，签名上没说「一棵子树只能调一次」。调两遍就 dispose 两遍同一批
    // 材质，而调用方那边要不要论证「这条路只走一遍」，取决于这里幂等不幂等。
    for (const material of owned) expect(material.dispose).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a subtree that owns no materials', () => {
    // 物件的 GLB 走的是同一条 `disposeSubtree` 分支，它身上没有这批账。
    expect(() => disposeRigMaterials(new FakeObject3D() as never)).not.toThrow();
  });
});

/**
 * 钉在真 three 上的一条。上面那些用例的 `FakeColor` 把 sRGB 字节直接当通道用，而
 * `GLTFLoader` 塞进 `material.color` 的是 `baseColorFactor` 的**线性**值——两者差着一次
 * gamma：同样是仓库里那两个槽，假替身量出的压暗量是 0.706，真 three 是 0.499，差四成。
 *
 * 而且不只是精度：`#0000ff` 与 `#404040` 这两槽谁更亮，在两个空间里的答案是相反的，
 * 而「哪一槽最亮」正是 `ownMaterials` 里唯一承重的决策。假替身量的是我们自己的算术，
 * 这条量的是生产里真会发生的数。
 */
describe('CharacterRigFactory tinting on real three', () => {
  it("grades the shipped model's two slots by their linear luminance", async () => {
    // 灌法照抄 `GLTFLoader`：`baseColorFactor` 原样 setRGB 进线性空间，不做 sRGB 解码。
    const slot = (r: number, g: number, b: number) => {
      const material = new THREE.MeshStandardMaterial();
      material.color.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
      return new THREE.Mesh(new THREE.BufferGeometry(), material);
    };
    // 值取自 public/viewer-kit/quaternius/ual2/UAL2_Standard.glb 的那两个 baseColorFactor。
    const scene = new THREE.Group();
    scene.add(slot(0.4003796577, 0.1315960139, 0.7071905136));
    scene.add(slot(0.8007264733, 0.4029893279, 0.0429254025));

    const factory = factoryForScene(scene as unknown as FakeObject3D);
    const rig = await factory.build(character({ color: '#ff0000' }));
    const [joint, main] = materialsOf(rig) as unknown as THREE.MeshStandardMaterial[];

    // 最亮那一槽（主体）拿到纯正的辨识色：线性空间里 `#ff0000` 就是 (1, 0, 0)。
    expect(main!.color.getHex()).toBe(0xff0000);
    // 关节槽按两槽的 Rec.709 明度之比压暗：0.2303 / 0.4616 = 0.499。系数整体放大缩小、
    // 或者改到 sRGB 空间去量（会算成 0.712），视口里就是关节整体偏浅或偏深一大截。
    expect(joint!.color.r).toBeCloseTo(0.499, 3);
    expect(joint!.color.g).toBe(0);
    expect(joint!.color.b).toBe(0);
  });
});
