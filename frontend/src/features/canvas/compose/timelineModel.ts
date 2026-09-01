// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type {
  FreezoneVideoComposePayload,
  FreezoneVideoComposeResolution,
} from "@/api/ops";

/**
 * 前端「视频合成」时间线模型。
 *
 * 这层是纯逻辑（无 DOM / React），把 libtv 风格的多轨时间线编辑状态映射到后端
 * 已有的 `submitFreezoneVideoCompose` 契约（{@link FreezoneVideoComposePayload}）。
 * 渲染/编码全部由后端 FFmpeg 完成 —— 前端只负责「编排 + 预览」。
 *
 * v2：每个片段在输出时间线上的位置由显式 `timelineStartMs` 决定，允许片段之间留有
 * 间隙、也允许把片段拖到任意位置（libtv 风格自由定位）。同一轨道内不应重叠（由 UI
 * 拖拽时约束）。后端 payload 本身就支持任意 timelineStart，这里据此排布。
 * 同种类可有多条轨道（多轨），渲染顺序即数组顺序。
 */

export type ComposeTrackKind = "video" | "audio";

export interface ComposeClip {
  /** 本地片段 id，同时作为提交时的 itemId。 */
  id: string;
  /** 来源画布节点 id（用于回溯缩略图/名称）；外部注入的素材可为 null。 */
  nodeId: string | null;
  kind: ComposeTrackKind;
  sourceUrl: string;
  displayName: string | null;
  /** 缩略图（视频节点的 previewImageUrl）；音频/缺失时为 null。 */
  thumbUrl: string | null;
  /** 源媒体完整时长（ms）。探测到元数据前为 null。 */
  durationMs: number | null;
  /** 片段左边缘在输出时间线上的位置（ms）。允许间隙；同轨不应重叠。 */
  timelineStartMs: number;
  /** 源内裁剪起点（ms）。 */
  trimStartMs: number;
  /** 源内裁剪终点（ms，不含）。必须 > trimStartMs。 */
  trimEndMs: number;
  /** 0..1 音量。 */
  volume: number;
  muted: boolean;
  /**
   * 播放倍速（变速）。1 = 原速。时间线上占用长度 = 源裁剪长度 / speed。
   * ⚠️ 导出是否真正变速取决于后端 compose 接口是否支持该字段。
   */
  speed: number;
}

export interface ComposeTrack {
  id: string;
  kind: ComposeTrackKind;
  /** 顺序即首尾相接的排布顺序。 */
  clips: ComposeClip[];
}

/**
 * 整条合成时间线的封面。两种来源都归一成一张已上传的稳定图片 URL：
 *  - `frame`：从时间线某帧截取（`frameMs` 记录时间线位置，用于回显选帧滑块）；
 *  - `upload`：用户上传的自定义图片（`frameMs` 为 null）。
 * 仅持久化已上传的 `url`；本地未上传前的预览不进此结构（避免把 base64 写进草稿）。
 */
export interface ComposeCover {
  source: "frame" | "upload";
  /** 选帧来源时的时间线位置（ms）；upload 来源为 null。 */
  frameMs: number | null;
  /** 已上传的稳定封面 URL；落地后才有值。 */
  url: string | null;
}

export interface ComposeTimelineState {
  tracks: ComposeTrack[];
  resolution: FreezoneVideoComposeResolution;
  /** 合成封面（未设置时为空）。随草稿持久化。 */
  cover?: ComposeCover | null;
}

/** 默认裁剪长度（ms）—— 源时长未知时的兜底，避免长度为 0 无法排布/预览。 */
export const FALLBACK_CLIP_MS = 5000;
export const MIN_CLIP_MS = 200;

/**
 * 主视频轨 / 主音频轨的固定 id。主视频轨是唯一的「磁吸」轨：片段永远无缝紧贴、
 * 拖拽只能换序；附加视频轨与音频轨自由定位。补位（{@link compactVideoTracks}）
 * 与拖拽分支都以此 id 判定，保持同一条规则。
 */
export const VIDEO_TRACK_ID = "track_video";
export const AUDIO_TRACK_ID = "track_audio";

/** 源裁剪长度（ms）—— 消费掉的源媒体时长，与倍速无关。 */
export function sourceSpanMs(clip: ComposeClip): number {
  return Math.max(0, clip.trimEndMs - clip.trimStartMs);
}

/** 片段在时间线上占用的长度（ms）= 源裁剪长度 / 倍速。 */
export function clipLengthMs(clip: ComposeClip): number {
  return sourceSpanMs(clip) / (clip.speed > 0 ? clip.speed : 1);
}

export interface LaidClip {
  clip: ComposeClip;
  timelineStartMs: number;
  timelineEndMs: number;
}

/**
 * 按各片段显式的 `timelineStartMs` 排布（升序），算出在输出时间线上的起止（ms）。
 * 允许间隙；负值被夹到 0。长度为 0 的片段跳过。
 */
export function layoutTrack(track: ComposeTrack): LaidClip[] {
  return track.clips
    .filter((clip) => clipLengthMs(clip) > 0)
    .map((clip) => {
      const start = Math.max(0, clip.timelineStartMs);
      return { clip, timelineStartMs: start, timelineEndMs: start + clipLengthMs(clip) };
    })
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
}

/**
 * 把一条轨道的片段按数组顺序首尾相接地重新排布（magnetic / 无缝）：
 * timelineStartMs 从 0 起依次累加每段时间线长度，返回新的 clips 数组（不改原对象）。
 * 视频轨用它实现「剪映式」磁吸轨——拖拽换序后整条轨永远无缝紧贴、不留空隙。
 */
export function packTrackClips(clips: ComposeClip[]): ComposeClip[] {
  let cursor = 0;
  return clips.map((clip) => {
    const packed = { ...clip, timelineStartMs: Math.round(cursor) };
    cursor += clipLengthMs(clip);
    return packed;
  });
}

/**
 * 把「主视频轨」按时间线顺序无缝补位（ripple）：删除 / 裁剪 / 变速后用它消除空隙，
 * 让主轨永远首尾紧贴。附加视频轨与音频轨保持自由定位、原样不动 —— 拖拽分支允许
 * 用户把附加轨片段摆到任意时间位置，这里若一并打包会把它们悄悄吸回 0、制造与主轨
 * 的时间重叠（导出被 hasOverlappingVideoClips 拦截）。
 */
export function compactVideoTracks(
  state: ComposeTimelineState,
): ComposeTimelineState {
  return {
    ...state,
    tracks: state.tracks.map((track) =>
      track.kind === "video" && track.id === VIDEO_TRACK_ID
        ? {
            ...track,
            clips: packTrackClips(
              [...track.clips].sort(
                (a, b) => a.timelineStartMs - b.timelineStartMs,
              ),
            ),
          }
        : track,
    ),
  };
}

/**
 * 拖拽换序时，根据被拖片段左缘在时间线上的落点（ms），算它该插入到「已无缝排布的
 * siblings」中的下标。判定基准是被拖片段的中心越过某 sibling 的中心即排到其前面。
 * siblings 必须已按时间线顺序排列。
 */
export function reorderIndexForDrag(
  siblings: ComposeClip[],
  draggedLeftMs: number,
  draggedLengthMs: number,
): number {
  const center = Math.max(0, draggedLeftMs) + draggedLengthMs / 2;
  let acc = 0;
  for (let i = 0; i < siblings.length; i += 1) {
    const len = clipLengthMs(siblings[i]);
    if (center < acc + len / 2) return i;
    acc += len;
  }
  return siblings.length;
}

/**
 * 一条轨道上某片段紧邻的左右邻居边界（按时间线位置排序后的前一段末尾 / 后一段开头）。
 * 拖拽 / 裁剪时用来把片段约束在邻居之间、避免重叠。无邻居侧返回 null。
 */
export function neighborBoundsMs(
  track: ComposeTrack,
  clipId: string,
): { prevEndMs: number | null; nextStartMs: number | null } {
  const laid = layoutTrack(track);
  const index = laid.findIndex((entry) => entry.clip.id === clipId);
  if (index < 0) return { prevEndMs: null, nextStartMs: null };
  return {
    prevEndMs: index > 0 ? laid[index - 1].timelineEndMs : null,
    nextStartMs: index < laid.length - 1 ? laid[index + 1].timelineStartMs : null,
  };
}

/** 整个时间线的总时长（ms）= 各轨道排布后末尾的最大值。 */
export function timelineDurationMs(state: ComposeTimelineState): number {
  let max = 0;
  for (const track of state.tracks) {
    const laid = layoutTrack(track);
    const end = laid.length > 0 ? laid[laid.length - 1].timelineEndMs : 0;
    if (end > max) max = end;
  }
  return max;
}

export interface ActiveClip {
  laid: LaidClip;
  /** 该播放头时刻对应的「源媒体内」时间（ms）。 */
  sourceMs: number;
}

/**
 * 给定播放头位置，返回某条轨道上当前命中的片段及其源内时间。
 * 落在片段之间的空隙 / 末尾之外时返回 null。
 */
export function activeClipAt(
  track: ComposeTrack,
  playheadMs: number,
): ActiveClip | null {
  for (const laid of layoutTrack(track)) {
    if (playheadMs >= laid.timelineStartMs && playheadMs < laid.timelineEndMs) {
      const offset = playheadMs - laid.timelineStartMs;
      const speed = laid.clip.speed > 0 ? laid.clip.speed : 1;
      return { laid, sourceMs: laid.clip.trimStartMs + offset * speed };
    }
  }
  return null;
}

export interface BuildComposeOptions {
  title?: string;
  canvasId?: string;
  nodeId?: string;
  fps?: number;
}

/** 把时间线状态映射成后端 compose 接口入参（ms → 秒）。空轨道被剔除。 */
export function buildComposePayload(
  state: ComposeTimelineState,
  options: BuildComposeOptions = {},
): FreezoneVideoComposePayload {
  const tracks = state.tracks
    .map((track) => ({
      trackId: track.id,
      kind: track.kind,
      items: layoutTrack(track).map(({ clip, timelineStartMs }) => ({
        itemId: clip.id,
        sourceUrl: clip.sourceUrl,
        timelineStart: timelineStartMs / 1000,
        sourceStart: clip.trimStartMs / 1000,
        sourceEnd: clip.trimEndMs / 1000,
        volume: clip.volume,
        muted: clip.muted,
        // ⚠️ 后端需支持该字段才会真正变速；否则被忽略（导出按原速）。
        speed: clip.speed > 0 ? clip.speed : 1,
      })),
    }))
    .filter((track) => track.items.length > 0);

  return {
    title: options.title,
    canvasId: options.canvasId,
    nodeId: options.nodeId,
    resolution: state.resolution,
    fps: options.fps ?? 30,
    // 封面作为成片元信息返回，前端写入结果视频节点的 previewImageUrl / poster。
    coverUrl: state.cover?.url ?? null,
    tracks,
  };
}

/** 时间线是否有任何可导出的片段。 */
export function hasExportableClips(state: ComposeTimelineState): boolean {
  return state.tracks.some((track) =>
    track.clips.some((clip) => clipLengthMs(clip) > 0),
  );
}

/**
 * 是否存在「时间上重叠的视频片段」（跨所有视频轨道合并后按时间排序判断）。
 * MVP 后端 compose 不支持视频重叠合成，导出前据此拦截并给出明确提示。
 * 音频不在此判断内（多条音频轨可叠加混音）。1ms 容差吸收浮点取整误差。
 */
export function hasOverlappingVideoClips(state: ComposeTimelineState): boolean {
  return overlappingVideoClipIds(state).size > 0;
}

/**
 * 返回所有「与其它视频片段时间重叠」的视频片段 id（跨所有视频轨道）。
 * 用于在时间轴上把冲突片段高亮出来提示用户。1ms 容差吸收浮点取整。
 */
export function overlappingVideoClipIds(state: ComposeTimelineState): Set<string> {
  const laid = state.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => layoutTrack(track))
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const ids = new Set<string>();
  for (let i = 0; i < laid.length; i += 1) {
    for (let j = i + 1; j < laid.length; j += 1) {
      // 已按起点排序：一旦后者起点 ≥ 前者终点，更后面的更不会与 i 重叠，提前停。
      if (laid[j].timelineStartMs >= laid[i].timelineEndMs - 1) break;
      ids.add(laid[i].clip.id);
      ids.add(laid[j].clip.id);
    }
  }
  return ids;
}
