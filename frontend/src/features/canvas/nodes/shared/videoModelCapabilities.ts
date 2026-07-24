// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { VideoGenMode } from "@/features/canvas/domain/canvasNodes";

/**
 * Freezone 画布视频模型的**能力口径**——与后端 `freezone.py` 各视频端点的模型门禁
 * 一一对齐，作为 CTA / 模式可见性 / 自动推导默认 / 提交校验的**单一事实来源**，
 * 避免「把所有非 HappyHorse 模型都当作 Seedance 2.0」的假设散落在组件各处。
 *
 * 后端事实（src/novelvideo/api/routes/freezone.py）：
 * - 全能参考 omni-gen：`is_freezone_seedance2_backend` 为假直接 400；
 * - 首尾帧 keyframes：仅 Seedance 2.0 才 append 尾帧，其余后端**静默丢弃尾帧**；
 * - 图生视频 i2v / 首尾帧 keyframes / 视频编辑 edit：均**不校验 prompt**（允许空提示词）；
 * - 视频编辑 edit：仅 HappyHorse。
 *
 * 模型 id / apiModel 形如 `newapi_seedance-2.0-fast` / `newapi_seedance-1.0-pro-fast`
 * / `newapi_happyhorse-1.0`（见 freezone/video_node.py）。这里统一去掉分隔符后按版本号
 * 前缀匹配，避免把 `2.0` 误命中成 `1.x`（`seedance1\d` 只吃 `seedance1` 后跟数字）。
 */

function normalizeVideoModelId(modelId: string | null | undefined): string {
  return String(modelId ?? "")
    .replace(/[\s._-]/g, "")
    .toLowerCase();
}

export function isHappyHorseVideoModel(modelId: string | null | undefined): boolean {
  return normalizeVideoModelId(modelId).includes("happyhorse10");
}

export function isGrokVideoChannelModel(modelId: string | null | undefined): boolean {
  return normalizeVideoModelId(modelId).includes("grokvideochannel");
}

// Seedance 1 全系列（1.0 Pro Fast / 1.5 Pro / …）：版本号 `1.x` → `1x`，匹配
// `seedance1` 后跟任意数字，避免误命中 2.0（`seedance20`）。引用素材时这些模型受限。
export function isSeedance1xVideoModel(modelId: string | null | undefined): boolean {
  return /seedance1\d/.test(normalizeVideoModelId(modelId));
}

// Seedance 2.0 全系列（2.0 / fast / value / fast-value）：与后端
// `is_freezone_seedance2_backend`（model.startswith("seedance-2.0")）等价。
export function isSeedance2VideoModel(modelId: string | null | undefined): boolean {
  return /seedance2/.test(normalizeVideoModelId(modelId));
}

/**
 * 指定模型是否支持某 genMode（与可见 tab / 切模型时是否重置残留模式口径一致）。
 * - HappyHorse：文生 / 首帧(i2v) / 图片参考(r2v) / 视频编辑。
 * - 非 HappyHorse：视频编辑是 HappyHorse 专属；全能参考与「真尾帧」首尾帧只有
 *   Seedance 2.0 后端支持（非 2.0 打 omni→400、首尾帧静默丢尾帧）；文生 / 首帧 /
 *   图片参考其余视频模型均支持。
 */
export function isVideoModeSupportedByModel(
  mode: VideoGenMode,
  modelId: string | null | undefined,
): boolean {
  if (isHappyHorseVideoModel(modelId)) {
    return (
      mode === "textToVideo" ||
      mode === "imageToVideo" ||
      mode === "imageReference" ||
      mode === "videoEdit"
    );
  }
  if (mode === "videoEdit") return false;
  if (mode === "allReference" || mode === "firstLastFrame") {
    return isSeedance2VideoModel(modelId);
  }
  return true;
}

/**
 * 空态 CTA 只覆盖「铺素材起步」的图片 / 首尾帧模式——文生视频无需素材、视频编辑走
 * 独立入口，都不在空态 CTA 里。与 `spawnFrameUploads` 接受的模式一一对应。
 */
export type VideoEmptyStateCtaMode =
  | "allReference"
  | "imageReference"
  | "imageToVideo"
  | "firstLastFrame";

/**
 * 视频节点「空态」CTA 的模式顺序——只列该模型**真正能起步**的图片 / 首尾帧模式：
 * - HappyHorse：首帧 → 图片参考；
 * - Seedance 2.0：全能参考 → 图片参考 → 首尾帧；
 * - Seedance 1.x 及其它非 2.0 非 HappyHorse：全能参考会 400、首尾帧尾帧被静默丢弃、
 *   多图参考也不支持，只给确实可用的「首帧」。
 */
export function videoEmptyStateCtaModes(
  modelId: string | null | undefined,
): VideoEmptyStateCtaMode[] {
  if (isHappyHorseVideoModel(modelId)) {
    return ["imageToVideo", "imageReference"];
  }
  if (isSeedance2VideoModel(modelId)) {
    return ["allReference", "imageReference", "firstLastFrame"];
  }
  return ["imageToVideo"];
}

/**
 * 非 HappyHorse 模型「首次接入图片素材」后的默认模式：Seedance 2.0 用全能参考
 * （omni，1-9 图 + 视频 + 音频的通用入口），其余（Seedance 1.x）不支持全能参考，
 * 退到确实可用的「首帧」，避免默认推导把 1.x 顶进一个提交必 400 的模式。
 */
export function videoUpstreamImageDefaultMode(
  modelId: string | null | undefined,
): VideoGenMode {
  return isSeedance2VideoModel(modelId) ? "allReference" : "imageToVideo";
}

/**
 * 该 genMode 是否**必须带提示词**才能提交：文生 / 全能参考 后端强校验 prompt；
 * 首帧(i2v) / 图片参考 / 首尾帧 / 视频编辑 允许空提示词（只要素材齐备即可提交）。
 */
export function videoModeRequiresPrompt(mode: VideoGenMode): boolean {
  return mode === "textToVideo" || mode === "allReference";
}

/**
 * 提交前守卫：当前 (模型, 模式) 是否会**丢弃或被后端直接拒绝**已接入的上游素材。
 * 返回非空理由则应禁用提交、并把理由显示到按钮 tooltip 上，替代「静默丢素材 / 提交 400」。
 *
 * 规则对齐后端 freezone i2v / omni-gen 端点（src/novelvideo/api/routes/freezone.py）：
 * - 视频素材：仅「全能参考」(omni，Seedance 2.0) 与「视频编辑」(HappyHorse) 消费，
 *   其余模式静默丢弃 → 拦；
 * - 音频素材：仅「全能参考」(omni，Seedance 2.0) 消费，其余模式静默丢弃 → 拦；
 * - 多图(>1)：i2v 端点仅 Seedance 2.0 / HappyHorse 放行，非 2.0 非 HappyHorse
 *   （Seedance 1.x）传 >1 图后端直接 400 → 拦。
 *
 * 非 2.0 / 非 HappyHorse 一接入视频/音频就无模式可消费（allReference / videoEdit 均
 * 不受支持），因此这三条只会在真正会丢素材 / 400 的场景触发；2.0 / HappyHorse 的自动
 * 推导 effect 会先把模式导到能消费素材的模式，不会误伤。
 */
export function videoSubmitMediaRejectionReason(
  mode: VideoGenMode,
  modelId: string | null | undefined,
  counts: { images: number; videos: number; audios: number },
): string | null {
  if (counts.videos > 0 && mode !== "allReference" && mode !== "videoEdit") {
    return "该模型不支持视频素材";
  }
  if (counts.audios > 0 && mode !== "allReference") {
    return "该模型不支持音频素材";
  }
  if (
    counts.images > 1 &&
    !isSeedance2VideoModel(modelId) &&
    !isHappyHorseVideoModel(modelId)
  ) {
    return "该模型单次仅支持 1 张图片";
  }
  return null;
}
