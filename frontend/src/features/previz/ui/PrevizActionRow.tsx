// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Plus, Scissors } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { importedIdOf, motionInfo, type PrevizMotionInfo, type PrevizMotionStatus } from '../domain/motionLibrary';
import {
  PREVIZ_FPS,
  type PrevizActionClip,
  type PrevizImportedMotion,
  type PrevizTrack,
} from '../domain/scene';
import { actionClipsOf } from '../domain/timeline';
import { motionErrorText, motionLabel } from './motionLabel';
import { ClipBar, PREVIZ_TRACK_HEADER_PX } from './PrevizTimelineTrack';

const ICON_BUTTON =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#8b93a3] hover:bg-[#2a2f3a] hover:text-[#c7cedb] disabled:opacity-30 disabled:hover:bg-transparent';

/** 循环分隔线之间至少隔这么多像素；缩得再小就是一片白，不如不画。 */
const MIN_LOOP_SPACING_PX = 4;

/** 失败片段的红斜纹。写成内联样式：Tailwind 没有现成的斜纹类，任意值里的逗号又得转义。 */
const ERROR_STRIPES =
  'repeating-linear-gradient(135deg, rgba(214,64,64,0.9) 0 6px, rgba(128,32,32,0.9) 6px 12px)';

export interface PrevizActionClipMarks {
  /** 每圈结束处的绝对帧号，不含片段两端。 */
  loops: number[];
  /** 单次动作播完的绝对帧号；片段比动作短时为 null。 */
  onceEnd: number | null;
}

/**
 * 片段条上要画的刻度。帧号不取整：分隔线落在求值器真正绕圈的地方
 * （`elapsed % durationSec`），取整会让长片段后半截的线与画面对不上。
 */
export function actionClipMarks(
  clip: PrevizActionClip,
  info: PrevizMotionInfo | null,
  pxPerFrame: number,
): PrevizActionClipMarks {
  if (!info || info.durationSec <= 0) return { loops: [], onceEnd: null };
  const cycle = info.durationSec * PREVIZ_FPS;
  if (!info.loop) {
    const end = clip.startFrame + cycle;
    return { loops: [], onceEnd: end < clip.endFrame ? end : null };
  }
  const loops: number[] = [];
  if (cycle * pxPerFrame >= MIN_LOOP_SPACING_PX) {
    for (let at = clip.startFrame + cycle; at < clip.endFrame; at += cycle) loops.push(at);
  }
  return { loops, onceEnd: null };
}

export interface PrevizActionRowProps {
  track: PrevizTrack;
  pxPerFrame: number;
  laneWidthPx: number;
  frame: number;
  selectedClipId: string | null;
  motions: readonly PrevizImportedMotion[];
  motionStatus: Readonly<Record<string, PrevizMotionStatus>>;
  onSelectClip: (clipId: string) => void;
  onTrimClip: (clipId: string, edge: 'start' | 'end', frame: number) => void;
  onSplit: (clipId: string) => void;
  onAdd: () => void;
}

/**
 * 人物轨道下面那一行「动作」。与路径行分开画：动作片段互不重叠、按顺序接着播，
 * 和允许叠在一起的路径片段挤在同一行的话，一段走位会把底下的动作整个盖住。
 */
export function PrevizActionRow({
  track,
  pxPerFrame,
  laneWidthPx,
  frame,
  selectedClipId,
  motions,
  motionStatus,
  onSelectClip,
  onTrimClip,
  onSplit,
  onAdd,
}: PrevizActionRowProps) {
  const { t } = useTranslation();
  const clips = actionClipsOf(track);
  // 剃刀只切动作：播放头同时压着一段路径时，切哪段由按的是哪一行的剃刀决定。
  const current = clips.find((clip) => frame > clip.startFrame && frame < clip.endFrame);

  return (
    <div data-testid="previz-action-row" className="flex h-8 items-stretch bg-[#12151b]">
      <div
        className="sticky left-0 z-30 flex shrink-0 items-center gap-1 bg-[#12151b] pl-6 pr-2"
        style={{ width: PREVIZ_TRACK_HEADER_PX }}
      >
        <span className="min-w-0 flex-1 truncate text-[11px] text-[#8b93a3]">{t('previz.motion.row')}</span>
        <button
          type="button"
          className={ICON_BUTTON}
          aria-label={t('previz.motion.razor')}
          title={t('previz.motion.razor')}
          disabled={!current}
          onClick={() => current && onSplit(current.id)}
        >
          <Scissors className="h-3.5 w-3.5" />
        </button>
        {clips.length > 0 && (
          <button
            type="button"
            className={ICON_BUTTON}
            aria-label={t('previz.motion.addTitle')}
            title={t('previz.motion.addTitle')}
            onClick={onAdd}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="relative shrink-0" style={{ width: laneWidthPx }}>
        {clips.length === 0 && (
          <button
            type="button"
            className="absolute left-1 top-1 h-6 rounded border border-dashed border-[#3a4252] px-2 text-[11px] text-[#6d7585] hover:border-[#3fae5f] hover:text-[#c7cedb]"
            onClick={onAdd}
          >
            {t('previz.motion.add')}
          </button>
        )}
        {clips.map((clip) => {
          const importedId = importedIdOf(clip.motionId);
          const status = importedId === null ? undefined : motionStatus[importedId];
          const marks = actionClipMarks(clip, motionInfo(motions, clip.motionId), pxPerFrame);
          const offset = (at: number) => (at - clip.startFrame) * pxPerFrame;
          return (
            <ClipBar
              key={clip.id}
              clip={clip}
              pxPerFrame={pxPerFrame}
              selected={clip.id === selectedClipId}
              onSelect={() => onSelectClip(clip.id)}
              onTrim={(edge, at) => onTrimClip(clip.id, edge, at)}
              label={motionLabel(t, motions, clip.motionId)}
              tone="action"
            >
              {marks.loops.map((at) => (
                <span
                  key={at}
                  data-testid="previz-action-loop"
                  className="pointer-events-none absolute inset-y-1 w-px bg-white/35"
                  style={{ left: offset(at) }}
                />
              ))}
              {marks.onceEnd !== null && (
                <>
                  {/* 播完之后人定格在最后一帧：压暗那一截，看得出这里已经没在动了。 */}
                  <span
                    className="pointer-events-none absolute inset-y-0 right-0 bg-black/35"
                    style={{ left: offset(marks.onceEnd) }}
                  />
                  <span
                    data-testid="previz-action-once-end"
                    className="pointer-events-none absolute inset-y-0 w-px bg-white/80"
                    style={{ left: offset(marks.onceEnd) }}
                  />
                </>
              )}
              {status?.state === 'error' && (
                // 斜纹是片段条的子节点，点在上面照样冒泡到片段条、选中它；title 悬停才出来。
                <span
                  data-testid="previz-action-error"
                  className="absolute inset-0"
                  style={{ backgroundImage: ERROR_STRIPES }}
                  title={motionErrorText(t, status.error)}
                />
              )}
              {status?.state === 'loading' && (
                <span
                  className="absolute inset-0 animate-pulse bg-white/10"
                  title={t('previz.motion.loading')}
                />
              )}
            </ClipBar>
          );
        })}
      </div>
    </div>
  );
}
