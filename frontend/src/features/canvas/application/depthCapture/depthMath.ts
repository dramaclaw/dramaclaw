// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 深度动作捕捉的纯计算：尺寸、归一化区间、灰度映射。worker 与单测共用，不碰 DOM。
//
// 模型输出是相对逆深度（近处值大），每帧量纲都不一样。逐帧 min/max 归一化会让整段
// 视频亮度来回跳，所以区间取 1%/99% 分位数抗离群点，再用 EMA 在帧间平滑。

export const DEPTH_MAX_OUTPUT_HEIGHT = 1080;
/** 推理画布高度：模型内部本来就缩到 518，喂更大的图只是白白多插值。 */
export const DEPTH_INFERENCE_HEIGHT = 518;
export const DEPTH_MAX_DURATION_SEC = 60;
export const DEPTH_RANGE_ALPHA = 0.1;

const MAX_RANGE_SAMPLES = 16384;

export interface FrameSize {
  width: number;
  height: number;
}

export interface DepthRange {
  lo: number;
  hi: number;
}

function evenFloor(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/** 高度封顶 maxHeight（源更小则保持），宽按比例；两边都取偶数（H.264 要求）。 */
export function fitHeight(srcWidth: number, srcHeight: number, maxHeight: number): FrameSize {
  const height = evenFloor(Math.min(srcHeight, maxHeight));
  const width = evenFloor((srcWidth * height) / srcHeight);
  return { width, height };
}

/** 等步长抽样后取分位数；每帧十几万个像素，全量排序没必要。 */
export function percentileRange(
  values: ArrayLike<number>,
  lowQ = 0.01,
  highQ = 0.99,
): DepthRange {
  const total = values.length;
  if (total === 0) {
    return { lo: 0, hi: 0 };
  }
  const step = Math.max(1, Math.floor(total / MAX_RANGE_SAMPLES));
  const count = Math.ceil(total / step);
  const samples = new Float32Array(count);
  for (let i = 0, j = 0; i < total; i += step, j += 1) {
    samples[j] = values[i];
  }
  samples.sort();
  const pick = (q: number) =>
    samples[Math.min(count - 1, Math.max(0, Math.round(q * (count - 1))))];
  return { lo: pick(lowQ), hi: pick(highQ) };
}

/** 首帧直接取值，之后 lo/hi 各自按 alpha 向新帧靠拢。 */
export function smoothRange(
  prev: DepthRange | null,
  next: DepthRange,
  alpha = DEPTH_RANGE_ALPHA,
): DepthRange {
  if (!prev) {
    return next;
  }
  return {
    lo: prev.lo + alpha * (next.lo - prev.lo),
    hi: prev.hi + alpha * (next.hi - prev.hi),
  };
}

/** 线性映射到 0–255 灰度写进 RGBA；Uint8ClampedArray 自带 clamp 与取整。 */
export function depthToGray(
  depth: ArrayLike<number>,
  range: DepthRange,
  rgba: Uint8ClampedArray,
): void {
  const span = range.hi - range.lo;
  const scale = span > 1e-6 ? 255 / span : 0;
  for (let i = 0; i < depth.length; i += 1) {
    const value = (depth[i] - range.lo) * scale;
    const offset = i * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
}
