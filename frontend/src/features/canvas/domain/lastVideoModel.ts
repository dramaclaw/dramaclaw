// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

// 记住用户上一次为视频节点选的模型，让「新建视频节点」继承该选择，而不是每次
// 都回落到写死的 DEFAULT_VIDEO_MODEL_ID。选择只存节点自身 data.model 时，新节点
// 无从得知上次选了什么，于是额外把它镜像到 localStorage。读取到的 id 若已失效，
// VideoNode 的 selectedVideoModel 逻辑会自行回落到首个可用模型，故这里不做校验。

const STORAGE_KEY = 'canvas.lastVideoModel';

/** 返回上次选择的视频模型 id；无记录或不可用时返回 null。 */
export function readLastVideoModel(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** 记录本次选择的视频模型 id，供后续新建节点继承。 */
export function writeLastVideoModel(modelId: string): void {
  if (typeof window === 'undefined') return;
  if (!modelId) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, modelId);
  } catch {
    // localStorage 写不进去就算了，新建节点从默认值开始。
  }
}
