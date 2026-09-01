// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { v4 as uuidv4 } from 'uuid';

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
 * 硬编码中文，与 `nodeDisplay.ts` 的 `DEFAULT_NODE_DISPLAY_NAME` 同一个取舍：
 * 名字是要随场景落盘的数据，跟着 i18n 走会让同一份 JSON 在两种语言下自相矛盾
 * （中文建的场景切到英文再存一次，一半对象叫 Camera 一半叫机位）。
 */
export const PREVIZ_OBJECT_BASE_NAME: Record<PrevizObjectKind, string> = {
  character: '人物',
  camera: '机位',
  light: '灯光',
  prop: '物件',
};

/**
 * 对象的可编辑字段补丁，属性面板用它描述「改哪些字段」。四个 kind 的 `Partial` 求交：
 * 公共字段（name / transform / visible / locked）类型一致，各自的专有字段互不冲突，
 * 于是交出来是「全部可选」。`id` 与 `kind` 刻意排除——换 kind 等于换对象，走删除加新建。
 */
export type PrevizObjectPatch = Partial<Omit<PrevizCharacter, 'id' | 'kind'>> &
  Partial<Omit<PrevizCamera, 'id' | 'kind'>> &
  Partial<Omit<PrevizLight, 'id' | 'kind'>> &
  Partial<Omit<PrevizProp, 'id' | 'kind'>>;

type PrevizObjectOfKind<K extends PrevizObjectKind> = Extract<PrevizObject, { kind: K }>;

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

function withDefaults(kind: PrevizObjectKind, base: ReturnType<typeof baseFields>): PrevizObject {
  switch (kind) {
    case 'character':
      return {
        ...base,
        kind: 'character',
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
 */
export function createPrevizObject<K extends PrevizObjectKind>(
  kind: K,
  objects: readonly PrevizObject[],
  overrides: Partial<Omit<PrevizObjectOfKind<K>, 'id' | 'kind'>> = {},
): PrevizObjectOfKind<K> {
  // 显式的 undefined 先滤掉再合并：exactOptionalPropertyTypes 关着，`{ name: maybe }`
  // 照样通过类型检查，直接合并会得到一个 name 是 undefined 的对象，一路存到画布里。
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  const created = withDefaults(kind, baseFields(objects, kind));

  // 唯一一处断言：`withDefaults` 按运行时的 kind 分支返回联合类型，TS 没法把这个
  // 分支结果绑回类型参数 K；每个 case 的字面量 kind 已经保证了两者一致。
  return Object.assign(created, defined) as PrevizObjectOfKind<K>;
}
