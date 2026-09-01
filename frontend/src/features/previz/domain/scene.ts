// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/** 预演台里所有三元组的统一形状，顺序恒为 [x, y, z]，单位米 / 度。 */
export type Vec3 = [number, number, number];

export const PREVIZ_SCHEMA_VERSION = 1;
export const PREVIZ_FPS = 30;
export const PREVIZ_MIN_DURATION_FRAMES = 1;
export const PREVIZ_MAX_DURATION_FRAMES = 360;
export const PREVIZ_DEFAULT_DURATION_FRAMES = 120;

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

const DISPLAY_MODES: readonly DisplayMode[] = ['solid', 'translucent', 'clay'];
function isDisplayMode(value: unknown): value is DisplayMode {
  return typeof value === 'string' && (DISPLAY_MODES as readonly string[]).includes(value);
}

const OUTPUT_ASPECTS: readonly OutputAspect[] = ['16:9', '9:16', '1:1', '4:3'];
function isOutputAspect(value: unknown): value is OutputAspect {
  return typeof value === 'string' && (OUTPUT_ASPECTS as readonly string[]).includes(value);
}

const BODY_TYPES: readonly BodyType[] = ['slim', 'average', 'heavy'];
const LIGHT_TYPES: readonly PrevizLight['lightType'][] = ['key', 'point', 'spot'];
const SENSORS: readonly PrevizCamera['sensor'][] = ['ff', 's35'];
const ASSET_FORMATS: readonly PrevizProp['assetFormat'][] = ['glb', 'gltf', 'obj'];

function isMember<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function vec3(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) return [...fallback];
  return [num(value[0], fallback[0]), num(value[1], fallback[1]), num(value[2], fallback[2])];
}

function parseTransform(value: unknown): PrevizTransform {
  const source = (value ?? {}) as Partial<PrevizTransform>;
  return {
    position: vec3(source.position, [0, 0, 0]),
    rotation: vec3(source.rotation, [0, 0, 0]),
    scale: vec3(source.scale, [1, 1, 1]),
  };
}

/**
 * 把一条不可信的对象记录读成 `PrevizObject`。**只有两种情况返回 null**：没有可用的
 * id，或者 kind 不认识——这两样都没法修，留着只会在场景图同步时变成幽灵条目。
 * 其余字段一律就地修复回默认值：用户手改坏一个数字，不该让整个人物凭空消失。
 */
function parseObject(raw: unknown): PrevizObject | null {
  if (raw === null || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;

  const id = typeof source.id === 'string' && source.id.length > 0 ? source.id : null;
  if (!id) return null;

  const base = {
    id,
    name: typeof source.name === 'string' ? source.name : id,
    transform: parseTransform(source.transform),
    // 缺字段时按「可见、未锁定」兜底：反过来兜会让读进来的场景整个是空的，
    // 用户看到的是「我的东西全没了」而不是「有一项属性没读出来」。
    visible: source.visible === false ? false : true,
    locked: source.locked === true,
  };

  switch (source.kind) {
    case 'character':
      return {
        ...base,
        kind: 'character',
        bodyType: isMember(BODY_TYPES, source.bodyType) ? source.bodyType : 'average',
        heightCm: num(source.heightCm, 175),
        basePoseId: typeof source.basePoseId === 'string' ? source.basePoseId : 'standing',
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
        focalMm: num(source.focalMm, 50),
        aperture: num(source.aperture, 2.8),
        sensor: isMember(SENSORS, source.sensor) ? source.sensor : 'ff',
      };
    case 'light':
      return {
        ...base,
        kind: 'light',
        lightType: isMember(LIGHT_TYPES, source.lightType) ? source.lightType : 'key',
        color: typeof source.color === 'string' ? source.color : '#ffffff',
        intensity: num(source.intensity, 1),
      };
    case 'prop':
      return {
        ...base,
        kind: 'prop',
        assetUrl: typeof source.assetUrl === 'string' ? source.assetUrl : '',
        assetFormat: isMember(ASSET_FORMATS, source.assetFormat) ? source.assetFormat : 'glb',
      };
    default:
      return null;
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

  const objects = Array.isArray(source.objects)
    ? source.objects.map(parseObject).filter((object): object is PrevizObject => object !== null)
    : [];
  const objectIds = new Set(objects.map((object) => object.id));

  return {
    schemaVersion: PREVIZ_SCHEMA_VERSION,
    settings: {
      fps: PREVIZ_FPS,
      durationFrames: clampDuration(settings.durationFrames),
      displayMode: isDisplayMode(settings.displayMode)
        ? settings.displayMode
        : fallback.settings.displayMode,
      outputAspect: isOutputAspect(settings.outputAspect)
        ? settings.outputAspect
        : fallback.settings.outputAspect,
    },
    objects,
    timeline: { tracks: parseTracks(source.timeline?.tracks, objectIds) },
  };
}
