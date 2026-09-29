// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 把「参考图转白模」的结果并进场景。
 *
 * 纯函数、不碰 store：进来一份场景和一份后端结果，出去一份新场景或者一个拒绝理由。
 * 要么整份写进去，要么一件都不写——白模写一半比不写更糟，用户得自己去认哪些是
 * 这次生成的、哪些没来得及进来。
 */
import {
  PREVIZ_OBJECT_LIMITS,
  PREVIZ_PRIMITIVE_LIMIT,
  classifySceneSize,
  countObjects,
  countPrimitives,
  estimateSceneBytes,
} from './limits';
import { isPrevizPrimitiveShape } from './primitives';
import {
  parseObject,
  type PrevizCamera,
  type PrevizObject,
  type PrevizProp,
  type PrevizScene,
} from './scene';

/** 后端任务结果里前端用得到的两样。`objects` 是不可信输入，逐条过 `parseObject`。 */
export interface PrevizBlockoutPayload {
  objects: readonly unknown[];
  referenceCameraId: string | null;
}

/** `replace` 先删掉场景里已有的白模再写；`append` 原样留着。 */
export type PrevizBlockoutImportMode = 'replace' | 'append';

export type PrevizBlockoutRejection =
  /** 结果里一件能用的都没有。 */
  | { reason: 'empty' }
  /** 基础几何体放不下，`missing` 是还差几个名额。 */
  | { reason: 'primitive-limit'; missing: number; limit: number }
  | { reason: 'camera-limit'; missing: number; limit: number }
  /** 写进去之后场景会大到触发整张画布停止自动保存的那一档。 */
  | { reason: 'too-large'; bytes: number };

export type PrevizBlockoutPlan =
  | {
      ok: true;
      scene: PrevizScene;
      addedIds: string[];
      removedIds: string[];
      /** 已经按改名后的 id 换算过；结果里没有机位时为 null。 */
      referenceCameraId: string | null;
      /** 结果里被丢掉的记录数：不是基础几何体、形状不认识、没带白模标记等。 */
      dropped: number;
    }
  | { ok: false; rejection: PrevizBlockoutRejection };

type BlockoutObject = PrevizProp | PrevizCamera;

export function isBlockoutObject(object: PrevizObject): boolean {
  return (object.kind === 'prop' || object.kind === 'camera') && object.blockout !== undefined;
}

export function hasBlockout(scene: PrevizScene): boolean {
  return scene.objects.some(isBlockoutObject);
}

/**
 * 白模只能带进来两样东西：带标记的基础几何体，带标记的机位。
 *
 * 收得这么窄是因为这条路不经过用户的手：模型库里挑一个模型是用户自己点的，而这里的
 * 记录来自一次模型调用。放一个 `assetFormat: 'glb'` 进来，就等于让那次调用替用户
 * 决定了浏览器要去哪个地址下载文件。
 */
function readBlockoutObject(raw: unknown): BlockoutObject | null {
  const parsed = parseObject(raw);
  if (!parsed || !isBlockoutObject(parsed)) return null;
  if (parsed.kind === 'camera') return parsed;
  if (parsed.kind !== 'prop') return null;
  if (parsed.assetFormat !== 'primitive' || !isPrevizPrimitiveShape(parsed.assetUrl)) return null;
  return parsed;
}

/** 后端的 id 是确定性的（`blockout-<名字>`），第二次生成必然撞上第一次的，所以追加时要改名。 */
function uniqueId(id: string, taken: Set<string>): string {
  let candidate = id;
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${id}-${suffix}`;
  taken.add(candidate);
  return candidate;
}

export function planBlockoutImport(
  scene: PrevizScene,
  payload: PrevizBlockoutPayload,
  mode: PrevizBlockoutImportMode,
): PrevizBlockoutPlan {
  const records = Array.isArray(payload.objects) ? payload.objects : [];
  const incoming: BlockoutObject[] = [];
  for (const record of records) {
    const object = readBlockoutObject(record);
    if (object) incoming.push(object);
  }
  if (incoming.length === 0) return { ok: false, rejection: { reason: 'empty' } };

  const removed = mode === 'replace' ? scene.objects.filter(isBlockoutObject) : [];
  const removedIds = new Set(removed.map((object) => object.id));
  const kept = scene.objects.filter((object) => !removedIds.has(object.id));
  const base: PrevizScene = { ...scene, objects: kept };

  const primitives = incoming.filter((object) => object.kind === 'prop').length;
  const primitiveOverflow = countPrimitives(base) + primitives - PREVIZ_PRIMITIVE_LIMIT;
  if (primitiveOverflow > 0) {
    return {
      ok: false,
      rejection: {
        reason: 'primitive-limit',
        missing: primitiveOverflow,
        limit: PREVIZ_PRIMITIVE_LIMIT,
      },
    };
  }
  const cameras = incoming.length - primitives;
  const cameraOverflow = countObjects(base, 'camera') + cameras - PREVIZ_OBJECT_LIMITS.camera;
  if (cameraOverflow > 0) {
    return {
      ok: false,
      rejection: {
        reason: 'camera-limit',
        missing: cameraOverflow,
        limit: PREVIZ_OBJECT_LIMITS.camera,
      },
    };
  }

  const taken = new Set(kept.map((object) => object.id));
  const renamed = new Map<string, string>();
  const added = incoming.map((object) => {
    const id = uniqueId(object.id, taken);
    // 结果里自己重了 id 的话只记第一个：参考机位按原 id 找，指的是先出现的那台。
    if (!renamed.has(object.id)) renamed.set(object.id, id);
    return { ...object, id };
  });

  const next: PrevizScene = {
    ...scene,
    objects: [...kept, ...added],
    timeline: {
      ...scene.timeline,
      tracks: scene.timeline.tracks.filter((track) => !removedIds.has(track.objectId)),
      program: scene.timeline.program.filter((cut) => !removedIds.has(cut.cameraId)),
    },
  };

  const bytes = estimateSceneBytes(next);
  if (classifySceneSize(bytes) === 'offload') {
    return { ok: false, rejection: { reason: 'too-large', bytes } };
  }

  const firstCamera = added.find((object) => object.kind === 'camera');
  const named =
    typeof payload.referenceCameraId === 'string'
      ? renamed.get(payload.referenceCameraId)
      : undefined;
  const namedIsCamera = added.some((object) => object.id === named && object.kind === 'camera');

  return {
    ok: true,
    scene: next,
    addedIds: added.map((object) => object.id),
    removedIds: [...removedIds],
    referenceCameraId: (namedIsCamera ? named : firstCamera?.id) ?? null,
    dropped: records.length - incoming.length,
  };
}
