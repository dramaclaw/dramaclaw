// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { v4 as uuidv4 } from 'uuid';

import type { PrevizRange } from './camera';
import { PREVIZ_DEFAULT_POSE_ID } from './poses';
import type {
  PrevizCamera,
  PrevizCharacter,
  PrevizLight,
  PrevizObject,
  PrevizObjectKind,
  PrevizProp,
  PrevizTransform,
} from './scene';

export const PREVIZ_DEFAULT_HEIGHT_CM = 175;
export const PREVIZ_MIN_HEIGHT_CM = 120;
export const PREVIZ_MAX_HEIGHT_CM = 220;

/**
 * 身高区间，即 `clampToRange` 要的那个形状。三个边界各自还有直接的调用方，所以边界
 * 常量继续单独导出；但「区间」这个组合形状有两处要用（`domain/scene.ts` 的 parseScene
 * 夹 heightCm、`engine/sceneGraph.ts` 按身高定占位胶囊），拼在这里才不会出现两份逐字
 * 相同的对象字面量——数字没抄第二遍，形状抄了也一样是重复。
 */
export const PREVIZ_HEIGHT_CM_RANGE: PrevizRange = {
  min: PREVIZ_MIN_HEIGHT_CM,
  max: PREVIZ_MAX_HEIGHT_CM,
  default: PREVIZ_DEFAULT_HEIGHT_CM,
};

/**
 * 人物辨识色。所有人物共用同一份角色模型，站在场里长得一模一样——颜色是分清谁是谁
 * 最便宜的一刀：图层面板的图标、脚下的辨识环读的都是它。
 *
 * 八个色相在深色底上都认得出，也刻意避开机位那套青白，免得一眼扫过去把人当成机位。
 */
export const PREVIZ_CHARACTER_COLORS = [
  '#6ea8fe',
  '#f78da7',
  '#ffd166',
  '#06d6a0',
  '#c77dff',
  '#ff9f68',
  '#8ce99a',
  '#ffa8a8',
] as const;

/**
 * 下一个人物用哪个颜色：先挑没人用的，用满一轮之后按人数循环。
 *
 * 「先挑没人用的」而不是直接按人数取模，是为了让删掉的人把颜色还回来——否则场上
 * 只剩两个人，颜色却已经排到了第五个。
 */
export function nextCharacterColor(objects: readonly PrevizObject[]): string {
  const characters = objects.filter((object) => object.kind === 'character');
  const taken = new Set(characters.map((character) => character.color.toLowerCase()));
  return (
    PREVIZ_CHARACTER_COLORS.find((color) => !taken.has(color)) ??
    PREVIZ_CHARACTER_COLORS[characters.length % PREVIZ_CHARACTER_COLORS.length]
  );
}

/**
 * 硬编码中文，与 `nodeDisplay.ts` 的 `DEFAULT_NODE_DISPLAY_NAME` 同一个取舍：
 * 名字是要随场景落盘的数据，跟着 i18n 走会让同一份 JSON 在两种语言下自相矛盾
 * （中文建的场景切到英文再存一次，一半对象叫 Camera 一半叫机位）。
 */
// i18n-exempt-start: 规范默认值，会写进场景 JSON；理由见上面的注释
export const PREVIZ_OBJECT_BASE_NAME: Record<PrevizObjectKind, string> = {
  character: '人物',
  camera: '机位',
  light: '灯光',
  prop: '物件',
};
// i18n-exempt-end

/**
 * 对象的可编辑字段补丁：一次编辑要动哪些字段。属性面板（Task 14）落地时会拿它当入参
 * 类型；在那之前 `src` 下还没有消费者，先定在这里是因为它整个是从四个 kind 的字段推出
 * 来的，跟 schema 放在一起才不会随着字段增删各走各的。四个 kind 的 `Partial` 求交：
 * 公共字段（name / transform / visible / locked）类型一致，各自的专有字段互不冲突，
 * 于是交出来是「全部可选」。`id` 与 `kind` 刻意排除——换 kind 等于换对象，走删除加新建。
 */
export type PrevizObjectPatch = Partial<Omit<PrevizCharacter, 'id' | 'kind'>> &
  Partial<Omit<PrevizCamera, 'id' | 'kind'>> &
  Partial<Omit<PrevizLight, 'id' | 'kind'>> &
  Partial<Omit<PrevizProp, 'id' | 'kind'>>;

type PrevizObjectOfKind<K extends PrevizObjectKind> = Extract<PrevizObject, { kind: K }>;

/**
 * 新建一个对象时可以带上的初始字段，按 kind 收窄：往人物身上写机位字段编译期就红。
 * `id` 与 `kind` 排除的理由同 `PrevizObjectPatch`——换 kind 等于换对象。
 * 定在这里而不是在调用方从 `createPrevizObject` 的参数反推：反推读不动，而且没法被
 * UI 代码拿去声明一个 overrides 变量。
 */
export type PrevizObjectOverrides<K extends PrevizObjectKind> = Partial<
  Omit<PrevizObjectOfKind<K>, 'id' | 'kind'>
>;

/**
 * 滤掉值为 `undefined` 的键。`exactOptionalPropertyTypes` 关着，所以调用方常见的
 * 「有就带上」写法 `{ name: maybeName }`（`string | undefined`）照样通过类型检查；
 * 直接展开合并会把目标上已有的值盖成 `undefined`，再被规范化「修」成字段默认值——
 * 一次可选补丁就能把用户改过的名字抹回基名、把隐藏的对象重新显示出来。
 * 工厂与 store 的补丁路径共用这一份，免得两条路各防各的、日后只补上其中一条。
 *
 * **只滤顶层键。** `{ transform: { position: undefined, … } }` 这种嵌套的 undefined 滤不掉，
 * 会被 `parseTransform` 兜成 `[0, 0, 0]`——位置悄悄清回原点。属性面板拼 transform 与
 * poseAdjust 时是把已有值整份展开再改一个分量（见 `PrevizInspector` 的 `patchTransform`），
 * 所以现在走不到；换成「有就带上」的写法就会踩上，那时要滤的是子对象而不是这一层。
 */
export function withoutUndefined<T extends object>(source: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function identityTransform(): PrevizTransform {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
}

/**
 * 同类对象里取「基名 + 空格 + 数字」的最大编号加一。用户改过名的对象匹配不上这个
 * 模式，自然不参与编号——这正是想要的行为，见测试里的说明。
 */
export function nextObjectName(objects: readonly PrevizObject[], kind: PrevizObjectKind): string {
  const base = PREVIZ_OBJECT_BASE_NAME[kind];
  // 基名是本文件里的常量，不含正则元字符，直接拼安全。
  const pattern = new RegExp(`^${base} (\\d+)$`);
  let highest = 0;
  for (const object of objects) {
    if (object.kind !== kind) continue;
    const matched = pattern.exec(object.name);
    if (matched) highest = Math.max(highest, Number(matched[1]));
  }
  return `${base} ${highest + 1}`;
}

function baseFields(objects: readonly PrevizObject[], kind: PrevizObjectKind) {
  return {
    id: uuidv4(),
    name: nextObjectName(objects, kind),
    transform: identityTransform(),
    visible: true,
    locked: false,
  };
}

function withDefaults(
  kind: PrevizObjectKind,
  base: ReturnType<typeof baseFields>,
  objects: readonly PrevizObject[],
): PrevizObject {
  switch (kind) {
    case 'character':
      return {
        ...base,
        kind: 'character',
        color: nextCharacterColor(objects),
        bodyType: 'average',
        heightCm: PREVIZ_DEFAULT_HEIGHT_CM,
        basePoseId: PREVIZ_DEFAULT_POSE_ID,
        poseAdjust: { pitch: 0, turn: 0, lean: 0 },
      };
    case 'camera':
      return {
        ...base,
        kind: 'camera',
        // 眼高 1.6 m、退后 4 m，正对 -Z：three 的相机默认朝 -Z，rotation 全零即
        // 「看向场景原点方向」，新建即可用，不必再手动转一次。
        transform: { ...identityTransform(), position: [0, 1.6, 4] },
        focalMm: 50,
        aperture: 2.8,
        sensor: 'ff',
        cameraBody: 'cine',
        lensSeries: 'prime',
      };
    case 'light':
      return {
        ...base,
        kind: 'light',
        transform: { ...identityTransform(), position: [3, 4, 3] },
        lightType: 'key',
        color: '#ffffff',
        intensity: 1,
      };
    case 'prop':
      return {
        ...base,
        kind: 'prop',
        assetUrl: '',
        assetFormat: 'glb',
      };
  }
}

/**
 * 建一个新对象。`objects` 只用来算名字编号，不会被改动。
 * `overrides` 用于「导入物件时顺带带上 assetUrl」这类场景，按 kind 收窄，
 * 往人物身上写机位字段这种事在编译期就被挡掉。
 *
 * 残留的两条收窄边界，都不在「按 kind 分派」这一侧：
 * 1. kind 传的是 `PrevizObjectKind` 类型的**变量**而非字面量时，K 推成整个联合。
 *    `Extract` 在 `PrevizObject` 上分发出四个成员，但随后的 `Omit<A | B | C | D, …>`
 *    只留得下四者的**公共**键——于是动态 kind 的 overrides 反而比字面量调用点更严：
 *    `{ name }` 收，`{ assetUrl }` 连 kind 运行时确实是 'prop' 都不收。方向是安全的
 *    （不会漏），但很意外，动态 kind 的调用点只能先建后改。
 * 2. 超额属性检查是**新鲜对象字面量**才有的规则。overrides 先落进变量再传进来，且它与
 *    目标至少有一个同名属性时，多出来的字段就查不出来了：
 *    `const patch = { name: 'a', assetUrl: 'x' }; createPrevizObject('character', [], patch)`
 *    编译得过。一个属性都不重叠时还有弱类型检测兜底（单传 `{ assetUrl }` 会红）。
 *    这是 TS 的语言规则，不是这个签名的疏漏。
 * 两条都仍严格好过重构前——那时 `overrides` 是一个 `PrevizObjectPatch`，四个 kind 的
 * 字段在**所有**调用点、连新鲜字面量都一律放行。
 */
export function createPrevizObject<K extends PrevizObjectKind>(
  kind: K,
  objects: readonly PrevizObject[],
  overrides: PrevizObjectOverrides<K> = {},
): PrevizObjectOfKind<K> {
  const created = withDefaults(kind, baseFields(objects, kind), objects);

  // 唯一一处断言：`withDefaults` 按运行时的 kind 分支返回联合类型，TS 没法把这个
  // 分支结果绑回类型参数 K；每个 case 的字面量 kind 已经保证了两者一致。
  return Object.assign(created, withoutUndefined(overrides)) as PrevizObjectOfKind<K>;
}
