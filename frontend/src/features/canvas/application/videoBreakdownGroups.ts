// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';

import { resolveMinEdgeFittedSize } from './imageNodeSizing';

/**
 * 逐帧拉片产出 → 画布结果组的排版计划。
 *
 * 输入类型按「结构兼容」写成宽松版本（字段全可选、允许 null），这样
 * `FreezoneVideoBreakdownResult`（api/ops）可以直接传进来，而画布层不用反向
 * 依赖 API 层。计划本身是纯数据：store 只负责把它变成节点 / 边，一次 set()
 * 落一个 undo 步。
 */

export interface VideoBreakdownShotLike {
  code?: string | null;
  shot?: number | null;
  duration?: number | null;
  shot_size?: string | null;
  lighting?: string | null;
  camera_movement?: string | null;
  description?: string | null;
  image_prompt?: string | null;
  image_url?: string | null;
}

export interface VideoBreakdownGroupLike {
  group_index?: number | null;
  label?: string | null;
  shots?: VideoBreakdownShotLike[];
}

export interface VideoBreakdownMotionClipLike {
  code?: string | null;
  duration_sec?: number | null;
  camera_movement?: string | null;
  description?: string | null;
  motion_prompt?: string | null;
  video_url?: string | null;
  preview_image_url?: string | null;
}

export interface VideoBreakdownMusicClipLike {
  code?: string | null;
  duration_sec?: number | null;
  description?: string | null;
  mood?: string | null;
  bpm?: number | null;
  audio_url?: string | null;
}

export interface VideoBreakdownResultLike {
  storyboard?: { label?: string | null; groups?: VideoBreakdownGroupLike[] } | null;
  motion?: { label?: string | null; clips?: VideoBreakdownMotionClipLike[] } | null;
  music?: { label?: string | null; clip?: VideoBreakdownMusicClipLike | null } | null;
}

export type VideoBreakdownGroupKind = 'storyboard' | 'motion' | 'music';

export interface VideoBreakdownChildPlan {
  type: CanvasNodeType;
  /** 相对父组的坐标（React Flow 子节点坐标系）。 */
  position: { x: number; y: number };
  width: number;
  height: number;
  data: Record<string, unknown>;
}

export interface VideoBreakdownGroupPlan {
  kind: VideoBreakdownGroupKind;
  label: string;
  /** 画布绝对坐标。 */
  position: { x: number; y: number };
  width: number;
  height: number;
  children: VideoBreakdownChildPlan[];
}

const SIDE_PADDING = 20;
const TOP_PADDING = 34;
const BOTTOM_PADDING = 20;
const CELL_GAP = 24;
/** 组与组之间的纵向间距（三个结果组自上而下排一列）。 */
const GROUP_GAP_Y = 56;

/**
 * 分镜卡两列排。一组通常是 4 个镜头，排成一行会横着拉出很宽的组框 —— 在画布上
 * 既看不全，也压掉了下面动态/音乐组的位置；2×2 的方块更接近分镜表的读法。
 */
const STORYBOARD_COLS = 2;
const MOTION_COLS = 3;

/** 结果里没有画幅信息，统一按 16:9 落位；图片加载后节点自己按真实比例微调。 */
const DEFAULT_ASPECT = '16:9';

// 分镜卡片用图片节点加载完成后会自吸附到的尺寸落位，避免落位后再跳一次。
const STORYBOARD_CELL = resolveMinEdgeFittedSize(DEFAULT_ASPECT, {
  minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
  minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
});
// 与 VideoNode / AudioNode 的 DEFAULT_WIDTH/HEIGHT 对齐。
const MOTION_CELL = { width: 580, height: 380 };
const MUSIC_CELL = { width: 480, height: 210 };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function formatSeconds(value: unknown): string {
  const parsed = seconds(value);
  if (parsed === null) return '';
  return `${Math.round(parsed * 10) / 10}s`;
}

/** 卡片标题按「镜号 | 景别·光线 | 描述」拼，缺项自动省略而不是留空段。 */
function joinLabel(parts: (string | null | undefined)[]): string {
  return parts.map((part) => text(part)).filter(Boolean).join(' | ');
}

function gridSize(count: number, cols: number, cell: { width: number; height: number }) {
  const usedCols = Math.max(1, Math.min(cols, count));
  const rows = Math.max(1, Math.ceil(count / usedCols));
  return {
    cols: usedCols,
    rows,
    width: SIDE_PADDING * 2 + usedCols * cell.width + (usedCols - 1) * CELL_GAP,
    height:
      TOP_PADDING + BOTTOM_PADDING + rows * cell.height + (rows - 1) * CELL_GAP,
  };
}

function cellPosition(
  index: number,
  cols: number,
  cell: { width: number; height: number }
) {
  const col = index % cols;
  const row = Math.floor(index / cols);
  return {
    x: SIDE_PADDING + col * (cell.width + CELL_GAP),
    y: TOP_PADDING + row * (cell.height + CELL_GAP),
  };
}

function planStoryboardGroups(
  result: VideoBreakdownResultLike,
  fallbackLabel: (index: number) => string
): VideoBreakdownGroupPlan[] {
  const groups = result.storyboard?.groups ?? [];
  const plans: VideoBreakdownGroupPlan[] = [];

  groups.forEach((group, groupIndex) => {
    // 抽帧失败的镜头没有 image_url，落一张空卡片只是噪音，直接跳过。
    const shots = (group.shots ?? []).filter((shot) => text(shot.image_url));
    if (shots.length === 0) return;

    const grid = gridSize(shots.length, STORYBOARD_COLS, STORYBOARD_CELL);
    const children = shots.map((shot, index) => {
      const imageUrl = text(shot.image_url);
      return {
        type: CANVAS_NODE_TYPES.exportImage,
        position: cellPosition(index, grid.cols, STORYBOARD_CELL),
        width: STORYBOARD_CELL.width,
        height: STORYBOARD_CELL.height,
        data: {
          imageUrl,
          previewImageUrl: imageUrl,
          aspectRatio: DEFAULT_ASPECT,
          // 拉片产出是参考素材，模型抽出来的那一帧不一定合意 —— 右上角给一个
          // 「替换」入口，让用户传自己的图顶掉它（走 upload 落 OSS）。
          allowLocalReplace: true,
          displayName: joinLabel([
            shot.code,
            joinTone(shot.shot_size, shot.lighting),
            shot.description,
          ]),
        },
      } satisfies VideoBreakdownChildPlan;
    });

    plans.push({
      kind: 'storyboard',
      label: text(group.label) || fallbackLabel(groupIndex + 1),
      position: { x: 0, y: 0 },
      width: grid.width,
      height: grid.height,
      children,
    });
  });

  return plans;
}

/** 「景别·光线」：两者都缺时整段省略，只有一个时不留下孤零零的点。 */
function joinTone(shotSize: unknown, lighting: unknown): string {
  return [text(shotSize), text(lighting)].filter(Boolean).join('·');
}

function planMotionGroup(
  result: VideoBreakdownResultLike,
  fallbackLabel: string
): VideoBreakdownGroupPlan | null {
  const clips = (result.motion?.clips ?? []).filter((clip) => text(clip.video_url));
  if (clips.length === 0) return null;

  const grid = gridSize(clips.length, MOTION_COLS, MOTION_CELL);
  const children = clips.map((clip, index) => {
    const durationSec = seconds(clip.duration_sec);
    return {
      type: CANVAS_NODE_TYPES.video,
      position: cellPosition(index, grid.cols, MOTION_CELL),
      width: MOTION_CELL.width,
      height: MOTION_CELL.height,
      data: {
        videoUrl: text(clip.video_url),
        previewImageUrl: text(clip.preview_image_url) || null,
        aspectRatio: DEFAULT_ASPECT,
        durationMs: durationSec === null ? null : Math.round(durationSec * 1000),
        // 参考素材：只播放 + 顶部工具条，不渲染底部生成面板。
        referenceOnly: true,
        allowLocalReplace: true,
        prompt: text(clip.motion_prompt),
        displayName: joinLabel([
          clip.code,
          joinTone(formatSeconds(clip.duration_sec), clip.camera_movement),
          clip.description,
        ]),
      },
    } satisfies VideoBreakdownChildPlan;
  });

  return {
    kind: 'motion',
    label: text(result.motion?.label) || fallbackLabel,
    position: { x: 0, y: 0 },
    width: grid.width,
    height: grid.height,
    children,
  };
}

function planMusicGroup(
  result: VideoBreakdownResultLike,
  fallbackLabel: string
): VideoBreakdownGroupPlan | null {
  const clip = result.music?.clip ?? null;
  if (!clip || !text(clip.audio_url)) return null;

  const grid = gridSize(1, 1, MUSIC_CELL);
  const durationSec = seconds(clip.duration_sec);

  return {
    kind: 'music',
    label: text(result.music?.label) || fallbackLabel,
    position: { x: 0, y: 0 },
    width: grid.width,
    height: grid.height,
    children: [
      {
        type: CANVAS_NODE_TYPES.audio,
        position: cellPosition(0, 1, MUSIC_CELL),
        width: MUSIC_CELL.width,
        height: MUSIC_CELL.height,
        data: {
          audioUrl: text(clip.audio_url),
          durationMs: durationSec === null ? null : Math.round(durationSec * 1000),
          audioKind: 'music',
          allowLocalReplace: true,
          // 音乐描述落到 text：用户可以直接拿这段描述去「文字生成音乐」重出一版。
          text: text(clip.description),
          displayName: joinLabel([
            clip.code,
            joinTone(formatSeconds(clip.duration_sec), clip.mood),
          ]),
        },
      },
    ],
  };
}

export interface PlanVideoBreakdownGroupsOptions {
  /** 第一个组的左上角（画布绝对坐标），通常是拉片节点右侧。 */
  origin: { x: number; y: number };
  /** 分镜组缺 label 时的兜底名，入参是 1-based 组序号。 */
  storyboardFallbackLabel?: (index: number) => string;
  motionFallbackLabel?: string;
  musicFallbackLabel?: string;
}

/**
 * 把一次拉片结果排成「分镜组 01/02/03 → 动态｜运镜动作参考 → 音乐｜BGM参考片段」
 * 的一列结果组。没有产出的维度不会占位，返回空数组表示这次拉片没有任何可落盘内容。
 */
export function planVideoBreakdownGroups(
  result: VideoBreakdownResultLike,
  options: PlanVideoBreakdownGroupsOptions
): VideoBreakdownGroupPlan[] {
  const storyboardFallback =
    options.storyboardFallbackLabel ??
    ((index: number) => `分镜组${String(index).padStart(2, '0')}`);

  const plans = [
    ...planStoryboardGroups(result, storyboardFallback),
    planMotionGroup(result, options.motionFallbackLabel ?? '动态｜运镜动作参考'),
    planMusicGroup(result, options.musicFallbackLabel ?? '音乐｜BGM参考片段'),
  ].filter((plan): plan is VideoBreakdownGroupPlan => plan !== null);

  let cursorY = Math.round(options.origin.y);
  for (const plan of plans) {
    plan.position = { x: Math.round(options.origin.x), y: cursorY };
    cursorY += plan.height + GROUP_GAP_Y;
  }

  return plans;
}
