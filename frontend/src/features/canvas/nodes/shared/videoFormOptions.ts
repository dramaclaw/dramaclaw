// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 视频生成表单与视频节点**共用**的纯常量 / 纯函数 / 纯类型。
//
// 抽这一层只为一件事：`VideoGenerationForm` 是被 `VideoNode` 引入的（单向依赖），
// 但下面这几个符号两边都要用（节点算引用上限、表单画上限角标；节点夹时长、
// 表单滑杆夹时长…）。放在表单文件里再让节点反向 import 会绕出「UI 组件导出领域
// 常量」的怪味，放这里两边都只是 import 一个无 React 依赖的小模块。

import type { VideoGenMode } from "@/features/canvas/domain/canvasNodes";
import type { FreezoneVideoAspectRatio } from "@/api/ops";

export const ASPECT_RATIOS: ReadonlyArray<FreezoneVideoAspectRatio> = [
  "auto",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
  "21:9",
];

// 各 genMode 对上游引用数量的硬上限。UI 用这张表把后端字段约束（多图 / 多模态
// 场景下）显式表达出来：超额 chip 标灰 + 从 @ 候选剔除，避免「prompt 引用了
// @图片10 但提交时被静默丢掉」。
//
// 这里是**默认**上限；媒体目录（Admin 配置）给模型声明了 referenceImageMax /
// referenceVideoMax / referenceAudioMax 时，按模型覆盖，见 referenceCapsForMode()。
// 表里没出现的模式默认不限制（textToVideo 不消费上游），走原有路径。
//   - firstFrame / imageToVideo：都只接 1 张图；前者锁定首帧，后者作为整体画面参考。
//   - imageReference：图片参考，image 1-9。
//   - videoEdit            ：video 1 + image ≤5（HappyHorse 视频编辑）。
//   - allReference (omni)  ：image 1-9 / video 0-3 / audio 0-3。总时长 ≤ 15s
//                            的部分前端拿不到精确媒体元数据，延后交给服务端。
//   - firstLastFrame       ：仅图片 2 张（首帧 + 尾帧），不允许任何视频 / 音频。
//                            图片 >2 时另有自动切到 allReference 的兜底（见
//                            VideoNode 内部 effect）。
export const REFERENCE_CAPS_BY_MODE: Partial<
  Record<VideoGenMode, { image: number; video: number; audio: number }>
> = {
  firstFrame: { image: 1, video: 0, audio: 0 },
  imageToVideo: { image: 1, video: 0, audio: 0 },
  imageReference: { image: 9, video: 0, audio: 0 },
  videoEdit: { image: 5, video: 1, audio: 0 },
  allReference: { image: 9, video: 3, audio: 3 },
  firstLastFrame: { image: 2, video: 0, audio: 0 },
};

// 首帧与单图图生视频的 1 张图是结构性限制，不能被目录容量覆盖。
const FIXED_IMAGE_CAP_BY_MODE: Partial<Record<VideoGenMode, number>> = {
  firstFrame: 1,
  imageToVideo: 1,
};

/** 媒体目录里能声明逐类型素材上限的那部分模型字段（#210）。 */
export interface ReferenceCapModel {
  referenceImageMax?: number | null;
  referenceVideoMax?: number | null;
  referenceAudioMax?: number | null;
}

/**
 * 当前模式的实际素材上限：以 REFERENCE_CAPS_BY_MODE 为底，被媒体目录里模型自己
 * 声明的上限逐项覆盖。模式不在表里（textToVideo）返回 null = 不限制。
 */
export function referenceCapsForMode(
  model: ReferenceCapModel | null | undefined,
  mode: VideoGenMode,
): { image: number; video: number; audio: number } | null {
  const defaults = REFERENCE_CAPS_BY_MODE[mode];
  if (!defaults) return null;
  return {
    image: FIXED_IMAGE_CAP_BY_MODE[mode] ?? model?.referenceImageMax ?? defaults.image,
    video: model?.referenceVideoMax ?? defaults.video,
    audio: model?.referenceAudioMax ?? defaults.audio,
  };
}

/** 模型是否自带 Admin 配置的素材上限（决定 omni 的总数上限用配置值还是旧的 12）。 */
export function hasConfiguredReferenceCaps(
  model: ReferenceCapModel | null | undefined,
): boolean {
  return (
    model?.referenceImageMax != null ||
    model?.referenceVideoMax != null ||
    model?.referenceAudioMax != null
  );
}

export function clampVideoDuration(
  value: number,
  bounds: { min: number; max: number },
): number {
  return Math.min(Math.max(Math.round(value), bounds.min), bounds.max);
}

export function isHappyHorseVideoModel(modelId: string | null | undefined): boolean {
  const normalized = String(modelId ?? "")
    .replace(/[\s._-]/g, "")
    .toLowerCase();
  return normalized.includes("happyhorse10");
}

export type ReferenceMediaItem =
  | {
      kind: "image";
      nodeId: string;
      imageUrl: string;
      displayName?: string | null;
    }
  | {
      kind: "video";
      nodeId: string;
      videoUrl: string;
      thumbUrl?: string | null;
      displayName?: string | null;
    }
  | {
      kind: "audio";
      nodeId: string;
      audioUrl: string;
      displayName?: string | null;
    };

export interface ReferenceMediaCapEntry {
  item: ReferenceMediaItem;
  /** 1-based 同类型序号（图片/视频/音频 各自累加），与 chip 角标 + @ 提及对齐。 */
  typeIndex: number;
  /** 是否在当前模式的引用上限内；表里没有的模式默认 true。 */
  withinCap: boolean;
}

const REFERENCE_MEDIA_KIND_LABEL: Record<ReferenceMediaItem["kind"], string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
};

export function formatReferenceMediaCompilerLabel(entry: ReferenceMediaCapEntry): string {
  const { item, typeIndex } = entry;
  const title =
    typeof item.displayName === "string" && item.displayName.trim().length > 0
      ? item.displayName.trim()
      : item.nodeId;
  return `${REFERENCE_MEDIA_KIND_LABEL[item.kind]}${typeIndex}：${title}`;
}
