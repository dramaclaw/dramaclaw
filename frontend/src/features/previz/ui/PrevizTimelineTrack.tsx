// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useRef } from 'react';
import {
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Diamond,
  Lightbulb,
  Pin,
  Scissors,
  Trash2,
  User,
  Video,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { PrevizClip, PrevizObjectKind, PrevizTrack } from '../domain/scene';
import { isPathClip, uToFrame } from '../domain/timeline';

/** 头列宽度。轨道行、子轨道行、标尺占位共用同一个数，三者才对得齐。 */
export const PREVIZ_TRACK_HEADER_PX = 240;

const ICON_BUTTON =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#8b93a3] hover:bg-[#2a2f3a] hover:text-[#c7cedb] disabled:opacity-30 disabled:hover:bg-transparent';

const KIND_ICON: Record<PrevizObjectKind, typeof Video> = {
  camera: Video,
  character: User,
  light: Lightbulb,
  prop: Box,
};

export interface PrevizTimelineTrackProps {
  track: PrevizTrack;
  name: string;
  kind: PrevizObjectKind;
  pxPerFrame: number;
  laneWidthPx: number;
  /** 播放头所在帧。剃刀、插入关键帧、上一帧/下一帧都以它为准。 */
  frame: number;
  expanded: boolean;
  selectedClipId: string | null;
  selectedPointId: string | null;
  onToggleExpand: () => void;
  onSelectClip: (clipId: string) => void;
  onSelectPoint: (clipId: string, pointId: string, frame: number) => void;
  onTrimClip: (clipId: string, edge: 'start' | 'end', frame: number) => void;
  onSplit: (clipId: string) => void;
  onAppend: () => void;
  onPin: () => void;
  onRemove: () => void;
  onInsertKeyframe: (clipId: string) => void;
  onClearPath: (clipId: string) => void;
  onSeek: (frame: number) => void;
}

/** 播放头压着的那个片段。剃刀、插入关键帧、清空轨迹都作用在它身上。 */
function clipUnder(track: PrevizTrack, frame: number): PrevizClip | undefined {
  return track.clips.find((clip) => frame >= clip.startFrame && frame <= clip.endFrame);
}

/** 这条轨道上所有关键帧的帧号，升序。上一帧/下一帧按钮靠它跳。 */
function keyframeFrames(track: PrevizTrack): number[] {
  return track.clips
    .filter(isPathClip)
    .flatMap((clip) => clip.points.map((point) => uToFrame(clip, point.u)))
    .sort((left, right) => left - right);
}

export function PrevizTimelineTrack({
  track,
  name,
  kind,
  pxPerFrame,
  laneWidthPx,
  frame,
  expanded,
  selectedClipId,
  selectedPointId,
  onToggleExpand,
  onSelectClip,
  onSelectPoint,
  onTrimClip,
  onSplit,
  onAppend,
  onPin,
  onRemove,
  onInsertKeyframe,
  onClearPath,
  onSeek,
}: PrevizTimelineTrackProps) {
  const { t } = useTranslation();
  const KindIcon = KIND_ICON[kind];
  const current = clipUnder(track, frame);
  const keyframes = keyframeFrames(track);
  const previous = [...keyframes].reverse().find((at) => at < frame);
  const next = keyframes.find((at) => at > frame);
  const lastEnd = track.clips.reduce((end, clip) => Math.max(end, clip.endFrame), 0);

  return (
    <li aria-label={name} className="border-b border-[#1c202a]">
      <div className="flex h-8 items-stretch">
        <div
          className="sticky left-0 z-30 flex shrink-0 items-center gap-1 bg-[#15181f] pl-1 pr-2"
          style={{ width: PREVIZ_TRACK_HEADER_PX }}
        >
          <button
            type="button"
            className={ICON_BUTTON}
            aria-label={expanded ? t('previz.timeline.collapseTrack') : t('previz.timeline.expandTrack')}
            onClick={onToggleExpand}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          <KindIcon className="h-3.5 w-3.5 shrink-0 text-[#6d7585]" />
          <span className="min-w-0 flex-1 truncate text-xs text-[#c7cedb]">{name}</span>

          <button
            type="button"
            className={ICON_BUTTON}
            aria-label={t('previz.timeline.razor')}
            title={t('previz.timeline.razor')}
            disabled={!current}
            onClick={() => current && onSplit(current.id)}
          >
            <Scissors className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={ICON_BUTTON}
            aria-label={t('previz.timeline.pinTrack')}
            title={t('previz.timeline.pinTrack')}
            onClick={onPin}
          >
            <Pin className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={ICON_BUTTON}
            aria-label={t('previz.timeline.removeTrack')}
            title={t('previz.timeline.removeTrack')}
            onClick={onRemove}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="relative shrink-0" style={{ width: laneWidthPx }}>
          {track.clips.map((clip) => (
            <ClipBar
              key={clip.id}
              clip={clip}
              pxPerFrame={pxPerFrame}
              selected={clip.id === selectedClipId}
              onSelect={() => onSelectClip(clip.id)}
              onTrim={(edge, at) => onTrimClip(clip.id, edge, at)}
            />
          ))}
          {/* 末尾还有空档才给追加按钮：铺满了追加只能得到一个 0 长片段。 */}
          {lastEnd * pxPerFrame < laneWidthPx && (
            <button
              type="button"
              aria-label={t('previz.timeline.appendClip')}
              title={t('previz.timeline.appendClip')}
              className="absolute top-1 flex h-6 w-6 items-center justify-center rounded border border-dashed border-[#3a4252] text-[#6d7585] hover:border-[#5b8cff] hover:text-[#c7cedb]"
              style={{ left: lastEnd * pxPerFrame + 4 }}
              onClick={onAppend}
            >
              +
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="flex h-7 items-stretch bg-[#12151b]">
          <div
            className="sticky left-0 z-30 flex shrink-0 items-center gap-1 bg-[#12151b] pl-6 pr-2"
            style={{ width: PREVIZ_TRACK_HEADER_PX }}
          >
            <span className="min-w-0 flex-1 truncate text-[11px] text-[#8b93a3]">
              {t('previz.timeline.motionPath')}
            </span>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={t('previz.timeline.prevKeyframe')}
              disabled={previous === undefined}
              onClick={() => previous !== undefined && onSeek(previous)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={t('previz.timeline.insertKeyframe')}
              disabled={!current}
              onClick={() => current && onInsertKeyframe(current.id)}
            >
              <Diamond className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={t('previz.timeline.nextKeyframe')}
              disabled={next === undefined}
              onClick={() => next !== undefined && onSeek(next)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={t('previz.timeline.clearPath')}
              title={t('previz.timeline.clearPath')}
              disabled={!current}
              onClick={() => current && onClearPath(current.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="relative shrink-0" style={{ width: laneWidthPx }}>
            {track.clips.filter(isPathClip).map((clip) => (
              <div key={clip.id}>
                {/* 关键帧串在一条线上，看得出这段轨迹从哪儿到哪儿。 */}
                <div
                  className="absolute top-1/2 h-px bg-[#3f6bd8]"
                  style={{
                    left: clip.startFrame * pxPerFrame,
                    width: (clip.endFrame - clip.startFrame) * pxPerFrame,
                  }}
                />
                {clip.points.map((point) => {
                  const at = uToFrame(clip, point.u);
                  return (
                    <button
                      key={point.id}
                      type="button"
                      data-testid={`previz-keyframe-${point.id}`}
                      aria-label={`${point.id}`}
                      className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] ${
                        point.id === selectedPointId ? 'bg-[#ffd166]' : 'bg-[#8fb0ff]'
                      }`}
                      style={{ left: at * pxPerFrame }}
                      onClick={() => onSelectPoint(clip.id, point.id, at)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

function ClipBar({
  clip,
  pxPerFrame,
  selected,
  onSelect,
  onTrim,
}: {
  clip: PrevizClip;
  pxPerFrame: number;
  selected: boolean;
  onSelect: () => void;
  onTrim: (edge: 'start' | 'end', frame: number) => void;
}) {
  const { t } = useTranslation();
  const drag = useRef<{ x: number; frame: number; edge: 'start' | 'end' } | null>(null);

  const startTrim = useCallback(
    (edge: 'start' | 'end', event: React.PointerEvent) => {
      // 不冒泡到片段条：按下把手不是「选中这个片段」。
      event.stopPropagation();
      event.preventDefault();
      drag.current = {
        x: event.clientX,
        frame: edge === 'start' ? clip.startFrame : clip.endFrame,
        edge,
      };

      const move = (moved: PointerEvent) => {
        const state = drag.current;
        if (!state) return;
        // 按位移算而不是按落点算：落点要拿容器的 getBoundingClientRect，
        // 滚动一下就得重新量，位移只依赖两次 clientX 之差。
        const delta = Math.round((moved.clientX - state.x) / (pxPerFrame || 1));
        onTrim(state.edge, state.frame + delta);
      };
      const up = () => {
        drag.current = null;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [clip.endFrame, clip.startFrame, onTrim, pxPerFrame],
  );

  return (
    <div
      data-testid={`previz-clip-${clip.id}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onSelect();
      }}
      className={`absolute top-1 flex h-6 items-center overflow-hidden rounded ${
        selected ? 'bg-[#4a7de0] ring-1 ring-[#a8c4ff]' : 'bg-[#3560ba]'
      }`}
      style={{
        left: clip.startFrame * pxPerFrame,
        width: (clip.endFrame - clip.startFrame) * pxPerFrame,
      }}
    >
      <span
        role="slider"
        tabIndex={0}
        aria-label={t('previz.timeline.trimStart')}
        aria-valuenow={clip.startFrame}
        className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/40"
        onPointerDown={(event) => startTrim('start', event)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') onTrim('start', clip.startFrame - 1);
          if (event.key === 'ArrowRight') onTrim('start', clip.startFrame + 1);
        }}
      />
      <span className="pointer-events-none truncate px-3 text-[11px] text-white/90">
        {t('previz.timeline.clipLabel', { start: clip.startFrame, end: clip.endFrame })}
      </span>
      <span
        role="slider"
        tabIndex={0}
        aria-label={t('previz.timeline.trimEnd')}
        aria-valuenow={clip.endFrame}
        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/40"
        onPointerDown={(event) => startTrim('end', event)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') onTrim('end', clip.endFrame - 1);
          if (event.key === 'ArrowRight') onTrim('end', clip.endFrame + 1);
        }}
      />
    </div>
  );
}
