// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * Agent 改场景的唯一入口：一批「加 / 改 / 删对象」，要么整批写进去，要么一件都不写。
 *
 * 纯函数、不碰 store。进来的是一次模型调用的产物，所以每个字段都当不可信输入读：
 * 认不出的一律拒绝并说明是哪一条，不做「猜它想写什么」的修补——半对的迷宫比没有更糟。
 *
 * 物件只收基础几何体和内置模型库的 id，不收模型地址：放一个 glb 地址进来等于让那次调用
 * 替用户决定浏览器去哪下载文件（与 `blockout.ts` 的 `readBlockoutObject` 同一个理由）。
 *
 * 时间轴（走位、跟拍、动作、切镜）走 `timeline` 这一段，落地用的是编辑器自己的那批纯函数
 * （`upsertClip` / `addRigClip` / `insertActionClip` / `insertCut`），规则只有一份。
 * 音频轨不在这里：音频来自上游节点或本地文件，不是一句话能描述出来的东西。
 */
import { v4 as uuidv4 } from 'uuid';

import { insertActionClip } from './actionClips';
import { PREVIZ_FOCAL_MM } from './camera';
import {
  PREVIZ_RIG_DISTANCE_RANGE,
  PREVIZ_RIG_ELEVATION_RANGE,
  PREVIZ_RIG_HEIGHT_RANGE,
  lookAtEulerDeg,
} from './closeup';
import { addRigClip, closeupTargets, createRigClip, updateRigClip, type RigClipPatch } from './closeupClip';
import { PREVIZ_LIBRARY_MODELS } from './libraryModels';
import {
  PREVIZ_MOTION_LIMITS,
  PREVIZ_OBJECT_LIMITS,
  PREVIZ_PRIMITIVE_LIMIT,
  classifySceneSize,
  countObjects,
  countPrimitives,
  estimateSceneBytes,
} from './limits';
import { PREVIZ_LIBRARY_ENTRIES, findPrevizLibraryModel } from './modelLibrary';
import {
  BUILTIN_MOTION_PREFIX,
  PREVIZ_BUILTIN_MOTIONS,
  builtinMotionById,
  isKnownMotionId,
} from './motionLibrary';
import { createPrevizObject } from './objects';
import { PREVIZ_PATH_SPEED_MPS, pathPointSeeds, polylineLength } from './pathDraw';
import { isPrevizPrimitiveShape } from './primitives';
import { PREVIZ_MAX_CUTS, insertCut } from './program';
import {
  PREVIZ_FPS,
  PREVIZ_MAX_DURATION_FRAMES,
  PREVIZ_MIN_CLIP_FRAMES,
  PREVIZ_MIN_DURATION_FRAMES,
  PREVIZ_SCALE_RANGE,
  type PrevizActionClip,
  type PrevizClip,
  type PrevizObject,
  type PrevizObjectKind,
  type PrevizPathClip,
  type PrevizScene,
  type RigAnchorPart,
  type RigBearing,
  type RigMotion,
  type Vec3,
} from './scene';
import { actionClipsOf, clipById, removeClip, trackFor, upsertClip } from './timeline';

/** 一次编辑最多带多少条操作。上限跟着基础几何体的名额走：再多也放不进场景。 */
export const PREVIZ_AGENT_EDIT_MAX_OPS = 200;
/** 坐标的绝对值上限（米）。超出相机远裁面的东西摆了也看不见，多半是算错了。 */
export const PREVIZ_AGENT_POSITION_LIMIT_M = 500;
/** 一条走位最多几个点。点之间走样条，几十个点足够描一条绕场的路线。 */
export const PREVIZ_AGENT_PATH_MAX_POINTS = 64;

const RIG_ANCHOR_PARTS: readonly RigAnchorPart[] = [
  'feet',
  'knee',
  'pelvis',
  'body',
  'chest',
  'shoulder',
  'face',
  'head',
];
const RIG_MOTIONS: readonly RigMotion[] = [
  'static',
  'orbit',
  'arcLeft',
  'arcRight',
  'push',
  'pull',
  'craneUp',
  'craneDown',
];
const RIG_BEARINGS: readonly RigBearing[] = ['front', 'custom'];

const LIGHT_TYPES = ['key', 'point', 'spot'] as const;
const KINDS: readonly PrevizObjectKind[] = ['prop', 'camera', 'character', 'light'];

export type PrevizAgentEditResult =
  | { ok: true; scene: PrevizScene; addedIds: string[]; updatedIds: string[]; removedIds: string[] }
  | { ok: false; error: string };

/** 给 Agent 看的对象清单：只留摆位置用得上的字段，数字收到两位小数，省上下文。 */
export interface PrevizAgentObjectDigest {
  id: string;
  kind: PrevizObjectKind;
  name: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  shape?: string;
  /** 内置模型库的 id；用户自己导入的模型没有这个字段。 */
  model?: string;
  focalMm?: number;
  locked?: true;
  hidden?: true;
  /** 这个对象轨道上的片段。没有片段的对象不带这个字段。 */
  clips?: PrevizAgentClipDigest[];
}

/** 片段的摘要。`kind` 用的是编辑入口里的叫法：特写片段对 Agent 就是「跟拍」。 */
export type PrevizAgentClipDigest =
  | {
      id: string;
      kind: 'path';
      startFrame: number;
      endFrame: number;
      points: number;
      from?: Vec3;
      to?: Vec3;
      aimObjectId?: string;
    }
  | {
      id: string;
      kind: 'follow';
      startFrame: number;
      endFrame: number;
      targetId: string;
      aimObjectId: string | null;
      motion: RigMotion;
      distance: number;
    }
  | { id: string; kind: 'action'; startFrame: number; endFrame: number; motion: string };

export interface PrevizAgentSceneDigest {
  objectCount: number;
  primitiveCount: number;
  primitiveLimit: number;
  fps: number;
  durationFrames: number;
  objects: PrevizAgentObjectDigest[];
  /** 镜头轨：哪几帧看哪台机位。 */
  cuts: Array<{ id: string; startFrame: number; endFrame: number; cameraId: string }>;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundVec(value: Vec3): Vec3 {
  return [round(value[0]), round(value[1]), round(value[2])];
}

function motionName(motionId: string): string {
  return builtinMotionById(motionId)?.clipName ?? motionId;
}

function clipDigest(clip: PrevizClip): PrevizAgentClipDigest | null {
  const range = { id: clip.id, startFrame: clip.startFrame, endFrame: clip.endFrame };
  if (clip.kind === 'path') {
    const points = [...clip.points].sort((left, right) => left.u - right.u);
    return {
      ...range,
      kind: 'path',
      points: points.length,
      ...(points.length > 0
        ? { from: roundVec(points[0].position), to: roundVec(points[points.length - 1].position) }
        : {}),
      ...(clip.aimObjectId ? { aimObjectId: clip.aimObjectId } : {}),
    };
  }
  if (clip.kind === 'rig') {
    return {
      ...range,
      kind: 'follow',
      targetId: clip.anchorObjectId,
      aimObjectId: clip.aimObjectId,
      motion: clip.motion,
      distance: round(clip.distance),
    };
  }
  if (clip.kind === 'action') return { ...range, kind: 'action', motion: motionName(clip.motionId) };
  return null;
}

function propDigest(object: PrevizObject): { shape?: string; model?: string } {
  if (object.kind !== 'prop') return {};
  if (object.assetFormat === 'primitive') return { shape: object.assetUrl };
  const model = findPrevizLibraryModel(object.assetUrl);
  return model ? { shape: 'model', model: model.id } : { shape: 'model' };
}

export function agentSceneDigest(scene: PrevizScene): PrevizAgentSceneDigest {
  return {
    objectCount: scene.objects.length,
    primitiveCount: countPrimitives(scene),
    primitiveLimit: PREVIZ_PRIMITIVE_LIMIT,
    fps: PREVIZ_FPS,
    durationFrames: scene.settings.durationFrames,
    objects: scene.objects.map((object) => {
      const clips = (trackFor(scene, object.id)?.clips ?? [])
        .map(clipDigest)
        .filter((clip): clip is PrevizAgentClipDigest => clip !== null);
      return {
        id: object.id,
        kind: object.kind,
        name: object.name,
        position: roundVec(object.transform.position),
        rotation: roundVec(object.transform.rotation),
        scale: roundVec(object.transform.scale),
        ...propDigest(object),
        ...(object.kind === 'camera' ? { focalMm: object.focalMm } : {}),
        ...(object.locked ? { locked: true as const } : {}),
        ...(object.visible ? {} : { hidden: true as const }),
        ...(clips.length > 0 ? { clips } : {}),
      };
    }),
    cuts: scene.timeline.program.map((cut) => ({
      id: cut.id,
      startFrame: cut.startFrame,
      endFrame: cut.endFrame,
      cameraId: cut.cameraId,
    })),
  };
}

/**
 * Agent 能点名的内置素材：动作名与模型库 id，按分类排。写进字段说明里而不是场景摘要里——
 * 它们不随场景变，跟着每次读场景再发一遍是白占上下文。
 */
export function agentSceneCatalog(): { motions: Record<string, string[]>; models: Record<string, string[]> } {
  const motions: Record<string, string[]> = {};
  for (const motion of PREVIZ_BUILTIN_MOTIONS) (motions[motion.category] ??= []).push(motion.clipName);
  const models: Record<string, string[]> = {};
  for (const model of PREVIZ_LIBRARY_MODELS) (models[model.category] ??= []).push(model.id);
  return { motions, models };
}

class EditError extends Error {}

function fail(message: string): never {
  throw new EditError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readVec(value: unknown, path: string, range: { min: number; max: number }): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) fail(`${path} must be [x, y, z]`);
  const numbers = (value as unknown[]).map((entry) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) fail(`${path} must be three finite numbers`);
    if (entry < range.min || entry > range.max) fail(`${path} out of range ${range.min}..${range.max}`);
    return entry;
  });
  return [numbers[0], numbers[1], numbers[2]];
}

const POSITION_RANGE = { min: -PREVIZ_AGENT_POSITION_LIMIT_M, max: PREVIZ_AGENT_POSITION_LIMIT_M };
const ROTATION_RANGE = { min: -3600, max: 3600 };

function readName(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${path} must be a non-empty string`);
  return value.trim().slice(0, 64);
}

function readColor(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) fail(`${path} must be #rrggbb`);
  return value.toLowerCase();
}

function readFocal(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be a number`);
  if (value < PREVIZ_FOCAL_MM.min || value > PREVIZ_FOCAL_MM.max) {
    fail(`${path} out of range ${PREVIZ_FOCAL_MM.min}..${PREVIZ_FOCAL_MM.max}`);
  }
  return value;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(`${path} has unsupported fields: ${unknown.join(', ')}`);
}

/**
 * 变换与朝向。`lookAt` 与 `rotation` 只能给一个：两个都给时谁赢没有显然的答案。
 * `position` 是这次要用来算朝向的眼位——改对象时没给新位置就用它原来的。
 */
function readTransformPatch(
  record: Record<string, unknown>,
  path: string,
  current: PrevizObject['transform'],
): PrevizObject['transform'] {
  if (record.lookAt !== undefined && record.rotation !== undefined) {
    fail(`${path} cannot set both lookAt and rotation`);
  }
  const position =
    record.position === undefined ? current.position : readVec(record.position, `${path}.position`, POSITION_RANGE);
  let rotation = current.rotation;
  if (record.rotation !== undefined) rotation = readVec(record.rotation, `${path}.rotation`, ROTATION_RANGE);
  if (record.lookAt !== undefined) {
    const target = readVec(record.lookAt, `${path}.lookAt`, POSITION_RANGE);
    if (target.every((value, index) => value === position[index])) fail(`${path}.lookAt equals position`);
    rotation = lookAtEulerDeg(position, target);
  }
  const scale =
    record.scale === undefined ? current.scale : readVec(record.scale, `${path}.scale`, PREVIZ_SCALE_RANGE);
  return { position, rotation, scale };
}

const COMMON_FIELDS = ['name', 'position', 'rotation', 'scale', 'lookAt', 'visible'] as const;
const KIND_FIELDS: Record<PrevizObjectKind, readonly string[]> = {
  prop: [],
  camera: ['focalMm'],
  character: ['color'],
  light: ['color', 'lightType'],
};

/** 各类对象自己的字段。加和改共用，所以只返回给了的那几个。 */
function readKindFields(kind: PrevizObjectKind, record: Record<string, unknown>, path: string) {
  const fields: Record<string, unknown> = {};
  if (record.name !== undefined) fields.name = readName(record.name, `${path}.name`);
  if (record.visible !== undefined) {
    if (typeof record.visible !== 'boolean') fail(`${path}.visible must be a boolean`);
    fields.visible = record.visible;
  }
  if (kind === 'camera' && record.focalMm !== undefined) {
    fields.focalMm = readFocal(record.focalMm, `${path}.focalMm`);
  }
  if ((kind === 'character' || kind === 'light') && record.color !== undefined) {
    fields.color = readColor(record.color, `${path}.color`);
  }
  if (kind === 'light' && record.lightType !== undefined) {
    if (!LIGHT_TYPES.includes(record.lightType as (typeof LIGHT_TYPES)[number])) {
      fail(`${path}.lightType must be one of ${LIGHT_TYPES.join(', ')}`);
    }
    fields.lightType = record.lightType;
  }
  return fields;
}

function addObject(objects: PrevizObject[], raw: unknown, path: string): PrevizObject {
  if (!isRecord(raw)) fail(`${path} must be an object`);
  const kind = raw.kind as PrevizObjectKind;
  if (!KINDS.includes(kind)) fail(`${path}.kind must be one of ${KINDS.join(', ')}`);
  rejectUnknownKeys(
    raw,
    ['kind', 'ref', ...(kind === 'prop' ? ['shape', 'model'] : []), ...COMMON_FIELDS, ...KIND_FIELDS[kind]],
    path,
  );
  if (raw.position === undefined) fail(`${path}.position is required`);

  const created = createPrevizObject(kind, objects);
  const overrides: Record<string, unknown> = {
    ...readKindFields(kind, raw, path),
    transform: readTransformPatch(raw, path, created.transform),
  };
  if (kind === 'prop') {
    if ((raw.shape === undefined) === (raw.model === undefined)) {
      fail(`${path} needs exactly one of shape (primitive) or model (library id)`);
    }
    if (raw.model !== undefined) {
      // 只认模型库的 id，地址由我们自己拼：见文件头的说明。
      const entry = PREVIZ_LIBRARY_ENTRIES.find(
        (candidate) => candidate.id === raw.model && candidate.assetFormat !== 'primitive',
      );
      if (!entry) fail(`${path}.model is not a model library id`);
      overrides.assetUrl = entry.assetUrl;
      overrides.assetFormat = entry.assetFormat;
      if (overrides.name === undefined) overrides.name = entry.tags.join(' ') || entry.id;
    } else {
      if (!isPrevizPrimitiveShape(raw.shape)) fail(`${path}.shape is not a known primitive shape`);
      overrides.assetUrl = raw.shape;
      overrides.assetFormat = 'primitive';
    }
  }
  return Object.assign(created, overrides) as PrevizObject;
}

function updateObject(objects: PrevizObject[], raw: unknown, path: string): string {
  if (!isRecord(raw)) fail(`${path} must be an object`);
  const index = objects.findIndex((object) => object.id === raw.id);
  if (index < 0) fail(`${path}.id does not match any object in the scene`);
  const target = objects[index];
  // 锁定是用户说「别动这个」，Agent 也不例外。
  if (target.locked) fail(`${path}: object "${target.name}" is locked by the user`);
  rejectUnknownKeys(raw, ['id', ...COMMON_FIELDS, ...KIND_FIELDS[target.kind]], path);
  objects[index] = {
    ...target,
    ...readKindFields(target.kind, raw, path),
    transform: readTransformPatch(raw, path, target.transform),
  } as PrevizObject;
  return target.id;
}

function readList(value: unknown, path: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value as unknown[];
}

/** 时间轴条目里指对象的那些字段：先认这一批 `add` 里起的 `ref`，再认场景里已有的 id。 */
type ObjectLookup = (value: unknown, path: string) => PrevizObject;

/** 片段会带着对象动；锁定的对象不该被挪，哪怕是通过时间轴。 */
function unlocked(object: PrevizObject, path: string): PrevizObject {
  if (object.locked) fail(`${path}: object "${object.name}" is locked by the user`);
  return object;
}

function readNumber(value: unknown, path: string, range: { min: number; max: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be a number`);
  if (value < range.min || value > range.max) fail(`${path} out of range ${range.min}..${range.max}`);
  return value;
}

const FRAME_RANGE = { min: 0, max: PREVIZ_MAX_DURATION_FRAMES };

function readFrame(value: unknown, path: string): number {
  const frame = readNumber(value, path, FRAME_RANGE);
  if (!Number.isInteger(frame)) fail(`${path} must be a whole frame number`);
  return frame;
}

function readEnum<T extends string>(value: unknown, options: readonly T[], path: string): T {
  if (!options.includes(value as T)) fail(`${path} must be one of ${options.join(', ')}`);
  return value as T;
}

/** 片段伸出时间轴末尾时把时间轴拉长，从不缩短：时长是全场共用的（见 store 的 `placePathClip`）。 */
function coveringFrame(scene: PrevizScene, endFrame: number): PrevizScene {
  if (endFrame <= scene.settings.durationFrames) return scene;
  return { ...scene, settings: { ...scene.settings, durationFrames: endFrame } };
}

function readRange(
  record: Record<string, unknown>,
  path: string,
  fallback: { startFrame: number; endFrame: number },
): { startFrame: number; endFrame: number } {
  const startFrame =
    record.startFrame === undefined ? fallback.startFrame : readFrame(record.startFrame, `${path}.startFrame`);
  const endFrame = record.endFrame === undefined ? fallback.endFrame : readFrame(record.endFrame, `${path}.endFrame`);
  if (endFrame - startFrame < PREVIZ_MIN_CLIP_FRAMES) fail(`${path}: endFrame must be after startFrame`);
  return { startFrame, endFrame };
}

/**
 * 走位：对象在 `[startFrame, endFrame]` 内沿这串点走。没给 `endFrame` 时按速度算时长
 * （长度 ÷ 速度，与画一笔轨迹同一条公式），装不进时间轴上限就拒绝。朝向沿切线，机位保留自己原来的俯仰（`pathPointSeeds`）。
 */
function addPath(scene: PrevizScene, raw: unknown, path: string, lookup: ObjectLookup): PrevizScene {
  if (!isRecord(raw)) fail(`${path} must be an object`);
  rejectUnknownKeys(raw, ['objectId', 'points', 'startFrame', 'endFrame', 'speedMps', 'aimObjectId'], path);
  const object = unlocked(lookup(raw.objectId, `${path}.objectId`), path);

  if (!Array.isArray(raw.points) || raw.points.length < 2) fail(`${path}.points needs at least 2 points`);
  if (raw.points.length > PREVIZ_AGENT_PATH_MAX_POINTS) {
    fail(`${path}.points has more than ${PREVIZ_AGENT_PATH_MAX_POINTS} points`);
  }
  const positions = (raw.points as unknown[]).map((point, index) =>
    readVec(point, `${path}.points[${index}]`, POSITION_RANGE),
  );
  if (polylineLength(positions) === 0) fail(`${path}.points are all the same point`);

  if (raw.endFrame !== undefined && raw.speedMps !== undefined) fail(`${path} cannot set both endFrame and speedMps`);
  const startFrame = raw.startFrame === undefined ? 0 : readFrame(raw.startFrame, `${path}.startFrame`);
  const speedMps =
    raw.speedMps === undefined
      ? PREVIZ_PATH_SPEED_MPS.default
      : readNumber(raw.speedMps, `${path}.speedMps`, PREVIZ_PATH_SPEED_MPS);
  const endFrame =
    raw.endFrame === undefined
      ? // 不用 `strokeDurationFrames`：它会把超长的路悄悄夹到时间轴上限，等于偷偷加速。
        startFrame + Math.max(PREVIZ_MIN_CLIP_FRAMES, Math.round((polylineLength(positions) / speedMps) * PREVIZ_FPS))
      : readFrame(raw.endFrame, `${path}.endFrame`);
  if (endFrame - startFrame < PREVIZ_MIN_CLIP_FRAMES) fail(`${path}: endFrame must be after startFrame`);
  if (endFrame > PREVIZ_MAX_DURATION_FRAMES) {
    fail(
      `${path} would end at frame ${endFrame}; the timeline maximum is ${PREVIZ_MAX_DURATION_FRAMES}. Set endFrame or raise speedMps`,
    );
  }

  const clip: PrevizPathClip = {
    id: uuidv4(),
    kind: 'path',
    startFrame,
    endFrame,
    points: pathPointSeeds(positions, object.kind === 'camera' ? object.transform.rotation : null),
  };
  if (raw.aimObjectId !== undefined && raw.aimObjectId !== null) {
    const aim = lookup(raw.aimObjectId, `${path}.aimObjectId`);
    if (aim.id === object.id) fail(`${path}.aimObjectId cannot be the object itself`);
    clip.aimObjectId = aim.id;
  }
  return coveringFrame(upsertClip(scene, object.id, clip), endFrame);
}

/**
 * 跟拍：机位在这段帧里挂在目标身上。帧范围缺省时抄目标轨道的范围（没有轨道就铺满
 * 时间轴），与编辑器里「跟随」的默认一致。
 */
function addFollow(scene: PrevizScene, raw: unknown, path: string, lookup: ObjectLookup): PrevizScene {
  if (!isRecord(raw)) fail(`${path} must be an object`);
  rejectUnknownKeys(
    raw,
    [
      'cameraId',
      'targetId',
      'startFrame',
      'endFrame',
      'anchorPart',
      'aimObjectId',
      'azimuth',
      'elevation',
      'distance',
      'height',
      'bearing',
      'motion',
    ],
    path,
  );
  const camera = unlocked(lookup(raw.cameraId, `${path}.cameraId`), path);
  if (camera.kind !== 'camera') fail(`${path}.cameraId is not a camera`);
  const target = lookup(raw.targetId, `${path}.targetId`);
  if (target.id === camera.id) fail(`${path}.targetId cannot be the camera itself`);

  const span = closeupTargets(scene, camera.id).find((entry) => entry.objectId === target.id);
  const range = readRange(raw, path, {
    startFrame: span?.startFrame ?? 0,
    endFrame: span?.endFrame ?? scene.settings.durationFrames,
  });

  const patch: RigClipPatch = {};
  if (raw.anchorPart !== undefined) patch.anchorPart = readEnum(raw.anchorPart, RIG_ANCHOR_PARTS, `${path}.anchorPart`);
  if (raw.motion !== undefined) patch.motion = readEnum(raw.motion, RIG_MOTIONS, `${path}.motion`);
  if (raw.bearing !== undefined) patch.bearing = readEnum(raw.bearing, RIG_BEARINGS, `${path}.bearing`);
  if (raw.azimuth !== undefined) patch.azimuth = readNumber(raw.azimuth, `${path}.azimuth`, ROTATION_RANGE);
  if (raw.elevation !== undefined) {
    patch.elevation = readNumber(raw.elevation, `${path}.elevation`, PREVIZ_RIG_ELEVATION_RANGE);
  }
  if (raw.distance !== undefined) {
    patch.distance = readNumber(raw.distance, `${path}.distance`, PREVIZ_RIG_DISTANCE_RANGE);
  }
  if (raw.height !== undefined) patch.height = readNumber(raw.height, `${path}.height`, PREVIZ_RIG_HEIGHT_RANGE);
  if (raw.aimObjectId === null) patch.aimObjectId = null;
  else if (raw.aimObjectId !== undefined) {
    const aim = lookup(raw.aimObjectId, `${path}.aimObjectId`);
    if (aim.id === camera.id) fail(`${path}.aimObjectId cannot be the camera itself`);
    patch.aimObjectId = aim.id;
  }

  const clip = createRigClip({ anchorObjectId: target.id, ...range });
  // 经 `updateRigClip` 落字段：水平角的归一化只在那里做。
  return coveringFrame(updateRigClip(addRigClip(scene, camera.id, clip), clip.id, patch), range.endFrame);
}

/**
 * 动作片段。只给 `startFrame` 时与动作库里点「添加」一样（按动作自身时长，撞上已有片段就
 * 顺延）；给了 `endFrame` 就是明说占哪一段，放不下直接拒绝而不是挪到别处。
 */
function addAction(scene: PrevizScene, raw: unknown, path: string, lookup: ObjectLookup): PrevizScene {
  if (!isRecord(raw)) fail(`${path} must be an object`);
  rejectUnknownKeys(raw, ['objectId', 'motion', 'startFrame', 'endFrame'], path);
  const object = unlocked(lookup(raw.objectId, `${path}.objectId`), path);
  if (object.kind !== 'character') fail(`${path}.objectId is not a character`);
  if (typeof raw.motion !== 'string') fail(`${path}.motion must be a motion name`);
  const motionId = raw.motion.includes(':') ? raw.motion : `${BUILTIN_MOTION_PREFIX}${raw.motion}`;
  if (!isKnownMotionId(motionId, new Set(scene.motions.map((motion) => motion.id)))) {
    fail(`${path}.motion is not a known motion`);
  }
  const startFrame = raw.startFrame === undefined ? 0 : readFrame(raw.startFrame, `${path}.startFrame`);

  if (raw.endFrame === undefined) {
    const inserted = insertActionClip(scene, object.id, motionId, startFrame);
    if (inserted.ok) return inserted.scene;
    if (inserted.reason === 'limit') {
      fail(`${path}: "${object.name}" already has ${PREVIZ_MOTION_LIMITS.clipsPerCharacter} action clips`);
    }
    fail(`${path}: no room for this motion before the timeline ends (frame ${scene.settings.durationFrames})`);
  }

  const endFrame = readFrame(raw.endFrame, `${path}.endFrame`);
  if (endFrame - startFrame < PREVIZ_MIN_CLIP_FRAMES) fail(`${path}: endFrame must be after startFrame`);
  if (endFrame > scene.settings.durationFrames) {
    fail(`${path}.endFrame is past the timeline end (frame ${scene.settings.durationFrames}); set timeline.durationFrames`);
  }
  const track = trackFor(scene, object.id);
  const existing = track ? actionClipsOf(track) : [];
  if (existing.length >= PREVIZ_MOTION_LIMITS.clipsPerCharacter) {
    fail(`${path}: "${object.name}" already has ${PREVIZ_MOTION_LIMITS.clipsPerCharacter} action clips`);
  }
  // 动作片段是半开区间，首尾相接不算重叠。
  const clash = existing.find((clip) => clip.startFrame < endFrame && startFrame < clip.endFrame);
  if (clash) fail(`${path} overlaps action clip ${clash.id} (${clash.startFrame}-${clash.endFrame}); remove it first`);
  const clip: PrevizActionClip = { id: uuidv4(), kind: 'action', startFrame, endFrame, motionId };
  return upsertClip(scene, object.id, clip);
}

function addCut(scene: PrevizScene, raw: unknown, path: string, lookup: ObjectLookup): PrevizScene {
  if (!isRecord(raw)) fail(`${path} must be an object`);
  rejectUnknownKeys(raw, ['frame', 'cameraId'], path);
  const camera = lookup(raw.cameraId, `${path}.cameraId`);
  const frame = readFrame(raw.frame, `${path}.frame`);
  const result = insertCut(scene, frame, camera.id);
  if (result.ok) return result.scene;
  if (result.reason === 'no-camera') fail(`${path}.cameraId is not a camera`);
  if (result.reason === 'same-camera') fail(`${path}: frame ${frame} is already on this camera`);
  if (result.reason === 'limit') fail(`${path}: the program track already has ${PREVIZ_MAX_CUTS} cuts`);
  fail(`${path}.frame is at or past the timeline end (frame ${scene.settings.durationFrames})`);
}

function removeAgentClip(scene: PrevizScene, clipId: unknown, path: string): PrevizScene {
  const found = typeof clipId === 'string' ? clipById(scene, clipId) : undefined;
  if (!found || found.table === 'audio') fail(`${path} does not match any path, follow, action or cut clip`);
  if (found.table === 'tracks') {
    const owner = scene.objects.find((object) => object.id === found.track.objectId);
    if (owner) unlocked(owner, path);
  }
  return removeClip(scene, found.clip.id);
}

const TIMELINE_LISTS = ['removeClips', 'paths', 'follows', 'actions', 'cuts'] as const;

function timelineOpCount(raw: unknown): number {
  if (raw === undefined) return 0;
  if (!isRecord(raw)) fail('sceneEdit.timeline must be an object');
  rejectUnknownKeys(raw, ['durationFrames', ...TIMELINE_LISTS], 'sceneEdit.timeline');
  return (
    TIMELINE_LISTS.reduce((count, key) => count + readList(raw[key], `sceneEdit.timeline.${key}`).length, 0) +
    (raw.durationFrames === undefined ? 0 : 1)
  );
}

/**
 * 顺序是定死的：先删片段、再定时长、然后走位 → 跟拍 → 动作 → 切镜。跟拍缺省的帧范围
 * 抄的是目标的走位，动作与切镜要落在时间轴以内，所以走位（它会把时间轴拉长）排在前面。
 */
function applyTimeline(scene: PrevizScene, raw: Record<string, unknown>, lookupIn: (scene: PrevizScene) => ObjectLookup) {
  const base = 'sceneEdit.timeline';
  let next = scene;
  readList(raw.removeClips, `${base}.removeClips`).forEach((clipId, index) => {
    next = removeAgentClip(next, clipId, `${base}.removeClips[${index}]`);
  });
  if (raw.durationFrames !== undefined) {
    const durationFrames = readFrame(raw.durationFrames, `${base}.durationFrames`);
    if (durationFrames < PREVIZ_MIN_DURATION_FRAMES) fail(`${base}.durationFrames must be at least 1`);
    next = { ...next, settings: { ...next.settings, durationFrames } };
  }
  const steps = [
    ['paths', addPath],
    ['follows', addFollow],
    ['actions', addAction],
    ['cuts', addCut],
  ] as const;
  for (const [key, apply] of steps) {
    readList(raw[key], `${base}.${key}`).forEach((entry, index) => {
      next = apply(next, entry, `${base}.${key}[${index}]`, lookupIn(next));
    });
  }
  return next;
}

export function applyAgentSceneEdit(scene: PrevizScene, edit: unknown): PrevizAgentEditResult {
  try {
    if (!isRecord(edit)) fail('sceneEdit must be an object with add / update / remove / timeline');
    rejectUnknownKeys(edit, ['add', 'update', 'remove', 'timeline'], 'sceneEdit');
    const adds = readList(edit.add, 'sceneEdit.add');
    const updates = readList(edit.update, 'sceneEdit.update');
    const removes = readList(edit.remove, 'sceneEdit.remove');
    const total = adds.length + updates.length + removes.length + timelineOpCount(edit.timeline);
    if (total === 0) fail('sceneEdit is empty');
    if (total > PREVIZ_AGENT_EDIT_MAX_OPS) fail(`sceneEdit has more than ${PREVIZ_AGENT_EDIT_MAX_OPS} operations`);

    // 先删后改再加：删掉的名额这一批里就能用上。
    const removedIds = new Set<string>();
    removes.forEach((id, index) => {
      const target = scene.objects.find((object) => object.id === id);
      if (!target) fail(`sceneEdit.remove[${index}] does not match any object in the scene`);
      if (target.locked) fail(`sceneEdit.remove[${index}]: object "${target.name}" is locked by the user`);
      removedIds.add(target.id);
    });
    const objects = scene.objects.filter((object) => !removedIds.has(object.id));

    const updatedIds = updates.map((raw, index) => updateObject(objects, raw, `sceneEdit.update[${index}]`));
    // 这一批里新加的对象可以起一个 `ref`，时间轴条目拿它当 id 用：加人、给他画走位、
    // 再让机位跟上，本来就是一句话的事，不该拆成「先加、读回 id、再发一次」。
    const refs = new Map<string, string>();
    const addedIds = adds.map((raw, index) => {
      const path = `sceneEdit.add[${index}]`;
      const created = addObject(objects, raw, path);
      const ref = (raw as Record<string, unknown>).ref;
      if (ref !== undefined) {
        if (typeof ref !== 'string' || !ref.trim()) fail(`${path}.ref must be a non-empty string`);
        if (refs.has(ref) || objects.some((object) => object.id === ref)) fail(`${path}.ref "${ref}" is already used`);
        refs.set(ref, created.id);
      }
      objects.push(created);
      return created.id;
    });

    let next: PrevizScene = {
      ...scene,
      objects,
      timeline: {
        ...scene.timeline,
        tracks: scene.timeline.tracks.filter((track) => !removedIds.has(track.objectId)),
        program: scene.timeline.program.filter((cut) => !removedIds.has(cut.cameraId)),
      },
    };

    if (edit.timeline !== undefined) {
      const lookupIn =
        (current: PrevizScene): ObjectLookup =>
        (value, path) => {
          const id = typeof value === 'string' ? (refs.get(value) ?? value) : null;
          const object = current.objects.find((candidate) => candidate.id === id);
          if (!object) fail(`${path} does not match any object in the scene or any ref in this edit`);
          return object;
        };
      next = applyTimeline(next, edit.timeline as Record<string, unknown>, lookupIn);
    }

    // 只在这次编辑让数量变多时才拦：存量场景本来就超的话，删东西和挪东西不该被卡住。
    if (addedIds.length > 0) {
      if (countPrimitives(next) > PREVIZ_PRIMITIVE_LIMIT) {
        fail(`primitive limit is ${PREVIZ_PRIMITIVE_LIMIT}; this edit would reach ${countPrimitives(next)}`);
      }
      // `prop` 数的是模型库的模型；基础几何体的名额上面已经算过。
      for (const kind of KINDS) {
        const count = countObjects(next, kind);
        if (count > PREVIZ_OBJECT_LIMITS[kind]) {
          fail(`${kind} limit is ${PREVIZ_OBJECT_LIMITS[kind]}; this edit would reach ${count}`);
        }
      }
    }
    if (addedIds.length > 0 || edit.timeline !== undefined) {
      if (classifySceneSize(estimateSceneBytes(next)) === 'offload') fail('scene would become too large to save');
    }

    return { ok: true, scene: next, addedIds, updatedIds, removedIds: [...removedIds] };
  } catch (error) {
    if (error instanceof EditError) return { ok: false, error: error.message };
    throw error;
  }
}
