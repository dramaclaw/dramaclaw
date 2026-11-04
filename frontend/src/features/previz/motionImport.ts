// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';
import { v4 as uuidv4 } from 'uuid';

import { uploadFreezoneImage } from '@/api/ops';

import type { PrevizMotionLoadError } from './domain/motionLibrary';
import type { PrevizImportedMotion, PrevizMotionFormat, PrevizSkeletonKind } from './domain/scene';
import type { PrevizMotionInspection } from './engine/motionClips';

/** 确认框里的一条候选动画。id 读完文件就定下，预览与最终写进场景用的是同一个。 */
export interface PrevizStagedMotion {
  id: string;
  clipIndex: number;
  name: string;
  durationSec: number;
  truncated: boolean;
  loop: boolean;
}

export type PrevizStagedMotionImport =
  | { ok: true; format: PrevizMotionFormat; skeleton: PrevizSkeletonKind; clips: PrevizStagedMotion[] }
  | { ok: false; error: PrevizMotionLoadError };

/** 渲染器上导入要用的那两样；单列出来，测试不必起一个 WebGL 渲染器。 */
export interface PrevizMotionStager {
  inspectMotionFile: (file: File) => Promise<PrevizMotionInspection>;
  primeMotion: (importedId: string, clip: THREE.AnimationClip) => void;
}

/**
 * 读文件、试跑重定向，把能用的每条动画先 prime 进渲染器。
 *
 * 在确认**之前**就 prime：确认框要拿这个人物预览播放，而此时文件还没上传、场景里还没有
 * 这条 motion。代价是取消或上传失败时调用方要记得 `discardPrimedMotion`。
 */
export async function stageMotionImport(
  stager: PrevizMotionStager,
  file: File,
  makeId: () => string = uuidv4,
): Promise<PrevizStagedMotionImport> {
  const inspection = await stager.inspectMotionFile(file);
  if (!inspection.ok) return inspection;
  const clips = inspection.clips.map(({ clip, ...rest }) => {
    const id = makeId();
    stager.primeMotion(id, clip);
    return { id, ...rest };
  });
  return { ok: true, format: inspection.format, skeleton: inspection.skeleton, clips };
}

/** 用户在确认框里对一条候选动画的决定。没勾的不出现在列表里。 */
export interface PrevizMotionPick {
  id: string;
  name: string;
  loop: boolean;
}

/**
 * 传一次文件，按勾选写出 motion：同一个 GLB 勾几条就是几条 motion、共用一个 URL，
 * 打开编辑器时缓存按 URL 只下一遍。
 */
export async function uploadMotionImport(
  project: string,
  file: File,
  staged: Extract<PrevizStagedMotionImport, { ok: true }>,
  picks: readonly PrevizMotionPick[],
): Promise<{ ok: true; motions: PrevizImportedMotion[] } | { ok: false }> {
  let url: string;
  try {
    url = (await uploadFreezoneImage(project, file, file.name)).url;
  } catch {
    return { ok: false };
  }
  const byId = new Map(picks.map((pick) => [pick.id, pick]));
  // 按文件里的顺序写：「已导入」分类里的卡片顺序跟着文件走，不随用户点勾的先后乱跳。
  const motions = staged.clips.flatMap((clip): PrevizImportedMotion[] => {
    const pick = byId.get(clip.id);
    if (!pick) return [];
    return [
      {
        id: clip.id,
        name: pick.name.trim() || clip.name,
        url,
        sourceFileName: file.name,
        format: staged.format,
        skeleton: staged.skeleton,
        clipIndex: clip.clipIndex,
        durationSec: clip.durationSec,
        loop: pick.loop,
      },
    ];
  });
  return { ok: true, motions };
}
