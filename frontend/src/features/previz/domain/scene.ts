// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { PREVIZ_APERTURE, PREVIZ_FOCAL_MM, clampToRange, type PrevizRange } from './camera';
import {
  PREVIZ_DEFAULT_HEIGHT_CM,
  PREVIZ_MAX_HEIGHT_CM,
  PREVIZ_MIN_HEIGHT_CM,
  PREVIZ_OBJECT_BASE_NAME,
} from './objects';
import { PREVIZ_DEFAULT_POSE_ID } from './poses';

/** 预演台里所有三元组的统一形状，顺序恒为 [x, y, z]，单位米 / 度。 */
export type Vec3 = [number, number, number];

export const PREVIZ_SCHEMA_VERSION = 1;
export const PREVIZ_FPS = 30;
export const PREVIZ_MIN_DURATION_FRAMES = 1;
export const PREVIZ_MAX_DURATION_FRAMES = 360;
export const PREVIZ_DEFAULT_DURATION_FRAMES = 120;

/**
 * 灯光强度区间，属性面板的滑杆与 parseScene 的夹取共用同一份边界。强度必须非负：
 * 负值在 three 里等于从场景里反向减光，画面会出现无解的黑块。上限取 10 是为了让滑杆
 * 整条行程都有用——P1 没有任何东西要把灯推到 10 倍以上，真存了更大值的场景是少数，
 * 夹回来是老实的做法；反过来做一条四分之三行程都用不到的滑杆，是天天都在的别扭。
 */
export const PREVIZ_INTENSITY_RANGE = { min: 0, max: 10, default: 1 } as const;

/**
 * 缩放分量区间。为 0 会压出退化几何（法线全零、包围盒没厚度），手柄跟着抓不住；
 * 负值翻转面朝向、打乱光照，而 P1 没有镜像需求。两头都挡在正区间内。
 */
export const PREVIZ_SCALE_RANGE = { min: 0.01, max: 100, default: 1 } as const;

export type BodyType = 'slim' | 'average' | 'heavy';
export type DisplayMode = 'solid' | 'translucent' | 'clay';
export type OutputAspect = '16:9' | '9:16' | '1:1' | '4:3';
export type RigMotion = 'static' | 'orbit' | 'push' | 'pull';

export interface PrevizTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export interface PrevizObjectBase {
  id: string;
  name: string;
  transform: PrevizTransform;
  visible: boolean;
  locked: boolean;
}

export interface PrevizCharacter extends PrevizObjectBase {
  kind: 'character';
  bodyType: BodyType;
  heightCm: number;
  /**
   * 刻意留成 string 而不是 PrevizPoseId：新版客户端存进来的姿势要原样活过一次
   * 读写，静默改写成默认姿势是无声的数据损坏。认不出的 id 由引擎侧回落。
   */
  basePoseId: string;
  poseAdjust: { pitch: number; turn: number; lean: number };
}

export interface PrevizCamera extends PrevizObjectBase {
  kind: 'camera';
  focalMm: number;
  aperture: number;
  sensor: 'ff' | 's35';
}

export interface PrevizLight extends PrevizObjectBase {
  kind: 'light';
  lightType: 'key' | 'point' | 'spot';
  color: string;
  intensity: number;
}

export interface PrevizProp extends PrevizObjectBase {
  kind: 'prop';
  assetUrl: string;
  assetFormat: 'glb' | 'gltf' | 'obj';
}

export type PrevizObject = PrevizCharacter | PrevizCamera | PrevizLight | PrevizProp;

/** 派生自 PrevizObject 的 kind 字面量集合，避免和四个具体类型的 `kind` 字段维护两份真相。 */
export type PrevizObjectKind = PrevizObject['kind'];

/** 路径点的 u 是片段内归一化参数；rotationEdited 标记用户显式改过朝向的点。 */
export interface PrevizPathPoint {
  id: string;
  u: number;
  position: Vec3;
  rotation: Vec3;
  rotationEdited?: boolean;
}

export interface PrevizPathClip {
  id: string;
  kind: 'path';
  startFrame: number;
  endFrame: number;
  points: PrevizPathPoint[];
}

export interface PrevizActionClip {
  id: string;
  kind: 'action';
  startFrame: number;
  endFrame: number;
  poseId: string;
}

export interface PrevizRigClip {
  id: string;
  kind: 'rig';
  startFrame: number;
  endFrame: number;
  anchorObjectId: string;
  aimObjectId: string | null;
  azimuth: number;
  elevation: number;
  distance: number;
  motion: RigMotion;
}

export type PrevizClip = PrevizPathClip | PrevizActionClip | PrevizRigClip;

export interface PrevizTrack {
  id: string;
  objectId: string;
  clips: PrevizClip[];
}

export interface PrevizSceneSettings {
  fps: typeof PREVIZ_FPS;
  durationFrames: number;
  displayMode: DisplayMode;
  /** 场景级单一画幅，全部机位共用——见设计文档「场景数据结构」一节的取舍说明。 */
  outputAspect: OutputAspect;
}

export interface PrevizScene {
  schemaVersion: typeof PREVIZ_SCHEMA_VERSION;
  settings: PrevizSceneSettings;
  objects: PrevizObject[];
  timeline: { tracks: PrevizTrack[] };
}

/** 卡片上不打开编辑器就能看到规模的摘要，随场景一起写回 node.data。 */
export interface PrevizNodeSummary {
  objectCount: number;
  durationFrames: number;
}

export function createDefaultScene(): PrevizScene {
  return {
    schemaVersion: PREVIZ_SCHEMA_VERSION,
    settings: {
      fps: PREVIZ_FPS,
      durationFrames: PREVIZ_DEFAULT_DURATION_FRAMES,
      displayMode: 'solid',
      outputAspect: '16:9',
    },
    objects: [],
    timeline: { tracks: [] },
  };
}

/** 场景版本高于本实现时抛出；调用方据此提示「版本过新」而不是做有损降级。 */
export class PrevizSceneVersionError extends Error {
  readonly schemaVersion: number;

  constructor(schemaVersion: number) {
    super(`previz scene schemaVersion ${schemaVersion} is newer than ${PREVIZ_SCHEMA_VERSION}`);
    this.name = 'PrevizSceneVersionError';
    this.schemaVersion = schemaVersion;
  }
}

function clampDuration(value: unknown): number {
  const frames =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.round(value)
      : PREVIZ_DEFAULT_DURATION_FRAMES;
  return Math.min(PREVIZ_MAX_DURATION_FRAMES, Math.max(PREVIZ_MIN_DURATION_FRAMES, frames));
}

/**
 * 枚举白名单一律写成 Record 而不是数组：Record 的键必须覆盖联合类型的全部成员，
 * 往 `assetFormat` 加了 'fbx' 却忘了改这里，编译期就红；数组只查得出「多写」，
 * 查不出「漏写」，而漏写的后果是 parseObject 把已经落盘的新值静默改回默认值。
 */
const DISPLAY_MODES: Record<DisplayMode, true> = { solid: true, translucent: true, clay: true };
const OUTPUT_ASPECTS: Record<OutputAspect, true> = {
  '16:9': true,
  '9:16': true,
  '1:1': true,
  '4:3': true,
};
const OBJECT_KINDS: Record<PrevizObjectKind, true> = {
  character: true,
  camera: true,
  light: true,
  prop: true,
};
const BODY_TYPES: Record<BodyType, true> = { slim: true, average: true, heavy: true };
const LIGHT_TYPES: Record<PrevizLight['lightType'], true> = { key: true, point: true, spot: true };
const SENSORS: Record<PrevizCamera['sensor'], true> = { ff: true, s35: true };
const ASSET_FORMATS: Record<PrevizProp['assetFormat'], true> = { glb: true, gltf: true, obj: true };

function isMember<T extends string>(table: Record<T, true>, value: unknown): value is T {
  // hasOwnProperty 而不是 `in`：`in` 会把 'constructor' 这类原型链上的键也认成合法值。
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(table, value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 夹取本身不在这里实现，一律走 camera.ts 的 `clampToRange`：domain 层只留一份夹取
 * 语义，两处各写一遍迟早会对非有限输入给出不同答案。这个包装只补上 `clampToRange`
 * 没有的那一层——它收 number，而 parseScene 拿到的是 unknown。非数字与非有限值一样
 * 落到 `range.default`（不是落到边界值）：NaN 更可能是上游算错了或输入框空着，
 * 把它夹成 min 等于替用户做了个他没提过的选择。
 */
function clampRange(value: unknown, range: PrevizRange): number {
  return typeof value === 'number' ? clampToRange(value, range) : range.default;
}

/** 身高的三个常量在 objects.ts 各有各的调用方，这里只是拼成 `clampRange` 要的形状。 */
const HEIGHT_CM_RANGE: PrevizRange = {
  min: PREVIZ_MIN_HEIGHT_CM,
  max: PREVIZ_MAX_HEIGHT_CM,
  default: PREVIZ_DEFAULT_HEIGHT_CM,
};

function vec3(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) return [...fallback];
  return [num(value[0], fallback[0]), num(value[1], fallback[1]), num(value[2], fallback[2])];
}

function scaleVec3(value: unknown): Vec3 {
  const fallback = PREVIZ_SCALE_RANGE.default;
  const raw = vec3(value, [fallback, fallback, fallback]);
  return [
    clampRange(raw[0], PREVIZ_SCALE_RANGE),
    clampRange(raw[1], PREVIZ_SCALE_RANGE),
    clampRange(raw[2], PREVIZ_SCALE_RANGE),
  ];
}

function parseTransform(value: unknown): PrevizTransform {
  const source = (value ?? {}) as Partial<PrevizTransform>;
  return {
    position: vec3(source.position, [0, 0, 0]),
    rotation: vec3(source.rotation, [0, 0, 0]),
    scale: scaleVec3(source.scale),
  };
}

/**
 * 把一条不可信的对象记录读成 `PrevizObject`。**只有两种情况返回 null**：没有可用的
 * id，或者 kind 不认识——这两样都没法修，留着只会在场景图同步时变成幽灵条目。
 * 其余字段一律就地修复回默认值或夹回合法区间：用户手改坏一个数字，不该让整个人物
 * 凭空消失，但也不能让 `focalMm: 0` 这种值把 three 的投影矩阵算成 NaN。
 */
function parseObject(raw: unknown): PrevizObject | null {
  if (raw === null || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;

  const id = typeof source.id === 'string' && source.id.length > 0 ? source.id : null;
  if (!id) return null;
  if (!isMember(OBJECT_KINDS, source.kind)) return null;
  const kind = source.kind;

  const base = {
    id,
    // 名字空着或缺失都回落到类型基名：图层面板要按名字列条目，空串是一行看不见的
    // 东西，uuid 则是一串对用户没有意义的字符。
    name:
      typeof source.name === 'string' && source.name.trim().length > 0
        ? source.name
        : PREVIZ_OBJECT_BASE_NAME[kind],
    transform: parseTransform(source.transform),
    // 缺字段时按「可见、未锁定」兜底：反过来兜会让读进来的场景整个是空的，
    // 用户看到的是「我的东西全没了」而不是「有一项属性没读出来」。
    visible: source.visible !== false,
    locked: source.locked === true,
  };

  switch (kind) {
    case 'character':
      return {
        ...base,
        kind: 'character',
        bodyType: isMember(BODY_TYPES, source.bodyType) ? source.bodyType : 'average',
        heightCm: clampRange(source.heightCm, HEIGHT_CM_RANGE),
        basePoseId:
          typeof source.basePoseId === 'string' ? source.basePoseId : PREVIZ_DEFAULT_POSE_ID,
        poseAdjust: {
          pitch: num((source.poseAdjust as { pitch?: unknown } | undefined)?.pitch, 0),
          turn: num((source.poseAdjust as { turn?: unknown } | undefined)?.turn, 0),
          lean: num((source.poseAdjust as { lean?: unknown } | undefined)?.lean, 0),
        },
      };
    case 'camera':
      return {
        ...base,
        kind: 'camera',
        focalMm: clampRange(source.focalMm, PREVIZ_FOCAL_MM),
        aperture: clampRange(source.aperture, PREVIZ_APERTURE),
        sensor: isMember(SENSORS, source.sensor) ? source.sensor : 'ff',
      };
    case 'light':
      return {
        ...base,
        kind: 'light',
        lightType: isMember(LIGHT_TYPES, source.lightType) ? source.lightType : 'key',
        color: typeof source.color === 'string' ? source.color : '#ffffff',
        intensity: clampRange(source.intensity, PREVIZ_INTENSITY_RANGE),
      };
    case 'prop':
      return {
        ...base,
        kind: 'prop',
        assetUrl: typeof source.assetUrl === 'string' ? source.assetUrl : '',
        assetFormat: isMember(ASSET_FORMATS, source.assetFormat) ? source.assetFormat : 'glb',
      };
  }
}

function parseTracks(raw: unknown, objectIds: ReadonlySet<string>): PrevizTrack[] {
  if (!Array.isArray(raw)) return [];
  const tracks: PrevizTrack[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const source = entry as Partial<PrevizTrack>;
    if (typeof source.id !== 'string' || typeof source.objectId !== 'string') continue;
    // 悬空轨道直接丢：求值器（P3）拿到指向已删对象的轨道只会报错或静默出错。
    if (!objectIds.has(source.objectId)) continue;
    tracks.push({
      id: source.id,
      objectId: source.objectId,
      // clips 只做浅拷贝，片段内部原样透传：片段校验是 P3 求值器落地时的事，
      // 现在没有任何代码读它，提前写一遍只会和那时的真实需求对不上。
      clips: Array.isArray(source.clips) ? [...source.clips] : [],
    });
  }
  return tracks;
}

/**
 * 把 node.data.scene 这类不可信 JSON 读成 PrevizScene：缺字段或非法枚举回落默认值，
 * 版本过新抛 PrevizSceneVersionError。对象逐条校验（见 parseObject），认不出 kind 或
 * 没有 id 的丢弃，其余字段就地修复；轨道指向已不存在的对象时一并丢弃。
 */
export function parseScene(raw: unknown): PrevizScene {
  if (raw === null || typeof raw !== 'object') return createDefaultScene();

  const source = raw as Partial<PrevizScene>;
  const version =
    typeof source.schemaVersion === 'number' ? source.schemaVersion : PREVIZ_SCHEMA_VERSION;
  if (version > PREVIZ_SCHEMA_VERSION) throw new PrevizSceneVersionError(version);

  const fallback = createDefaultScene();
  const settings = (source.settings ?? {}) as Partial<PrevizSceneSettings>;

  const objects: PrevizObject[] = [];
  const objectIds = new Set<string>();
  for (const entry of Array.isArray(source.objects) ? source.objects : []) {
    const object = parseObject(entry);
    // 同 id 的第二条直接丢（先到者留下）：场景图与 store 都按 id 取对象，留着等于让
    // 两条记录互相覆盖，表现是「图层面板里有它，选中却改到了另一个」。
    if (!object || objectIds.has(object.id)) continue;
    objectIds.add(object.id);
    objects.push(object);
  }

  return {
    schemaVersion: PREVIZ_SCHEMA_VERSION,
    settings: {
      fps: PREVIZ_FPS,
      durationFrames: clampDuration(settings.durationFrames),
      displayMode: isMember(DISPLAY_MODES, settings.displayMode)
        ? settings.displayMode
        : fallback.settings.displayMode,
      outputAspect: isMember(OUTPUT_ASPECTS, settings.outputAspect)
        ? settings.outputAspect
        : fallback.settings.outputAspect,
    },
    objects,
    timeline: { tracks: parseTracks(source.timeline?.tracks, objectIds) },
  };
}
