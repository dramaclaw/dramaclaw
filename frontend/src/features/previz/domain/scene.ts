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

/**
 * 把 node.data.scene 这类不可信 JSON 读成 PrevizScene：缺字段或非法枚举回落默认值，
 * 版本过新抛 PrevizSceneVersionError。objects / tracks 只校验是不是数组（并做浅拷贝以
 * 免和调用方共享可变引用）——逐对象校验留到 P1 真正有对象编辑时再补，现在做只会是空转。
 */
export function parseScene(raw: unknown): PrevizScene {
  if (raw === null || typeof raw !== 'object') return createDefaultScene();

  const source = raw as Partial<PrevizScene>;
  const version =
    typeof source.schemaVersion === 'number' ? source.schemaVersion : PREVIZ_SCHEMA_VERSION;
  if (version > PREVIZ_SCHEMA_VERSION) throw new PrevizSceneVersionError(version);

  const fallback = createDefaultScene();
  const settings = (source.settings ?? {}) as Partial<PrevizSceneSettings>;

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
    objects: Array.isArray(source.objects) ? [...source.objects] : [],
    timeline: {
      tracks: Array.isArray(source.timeline?.tracks) ? [...source.timeline.tracks] : [],
    },
  };
}
