// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { type ReactNode, useCallback, useRef, useState } from 'react';
import {
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Diamond,
  Lightbulb,
  Link2,
  Pin,
  Scissors,
  SwitchCamera,
  Trash2,
  User,
  Video,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { CloseupTarget } from '../domain/closeupClip';
import type { PrevizClip, PrevizObjectKind, PrevizTrack } from '../domain/scene';
import { isPathClip, uToFrame } from '../domain/timeline';

/** 头列宽度。轨道行、子轨道行、标尺占位共用同一个数，三者才对得齐。 */
export const PREVIZ_TRACK_HEADER_PX = 240;

const ICON_BUTTON =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#8b93a3] hover:bg-[#2a2f3a] hover:text-[#c7cedb] disabled:opacity-30 disabled:hover:bg-transparent';

/*
  「直播」小红标。shrink-0 whitespace-nowrap 不能省：表头挤的时候，中文「直播」两字之间
  是可以断行的，一折成两行就撑破 h-8 的行高，把整条轨道行顶歪。
*/
const LIVE_BADGE =
  'shrink-0 whitespace-nowrap rounded-sm bg-[#ff4d4f] px-1 text-[9px] font-semibold ' +
  'uppercase leading-4 text-white';

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
  /** 这台机位可以跟谁。非机位轨道传空数组——特写是机位的属性。 */
  closeupTargets: CloseupTarget[];
  onAddCloseup: (target: CloseupTarget) => void;
  /** 机位轨才有：把播放头处切到这台机位。 */
  onCut?: () => void;
  /** 镜头轨此刻正播这台机位；表头亮「直播」。 */
  live?: boolean;
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
  closeupTargets,
  onAddCloseup,
  onCut,
  live = false,
}: PrevizTimelineTrackProps) {
  const { t } = useTranslation();
  /** 「跟谁」的选单开着没有。开在行内而不是弹一个对话框：挑的只是一个名字。 */
  const [picking, setPicking] = useState(false);
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
          {picking && closeupTargets.length > 0 && (
            <div
              data-testid="previz-closeup-menu"
              className="absolute left-6 top-7 z-40 flex min-w-40 flex-col rounded border border-[#2f3542] bg-[#1d222b] py-1 shadow-lg"
            >
              <span className="px-2 py-0.5 text-[10px] text-[#6d7585]">
                {t('previz.timeline.closeupTarget')}
              </span>
              {closeupTargets.map((target) => (
                <button
                  key={target.objectId}
                  type="button"
                  className="px-2 py-1 text-left text-xs text-[#c7cedb] hover:bg-[#2a2f3a]"
                  onClick={() => {
                    setPicking(false);
                    onAddCloseup(target);
                  }}
                >
                  {/*
                    名字加它在时间轴上占到的那一段——同一个人物身上可能有好几段戏，
                    只报名字的话选完才知道特写覆盖到哪儿。这里没有可翻译的词。
                  */}
                  {target.name} · {target.startFrame}~{target.endFrame}
                </button>
              ))}
            </div>
          )}
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
          {/* 直播标、切换机位、跟拍都只对机位轨有意义，同一个判断管三个。 */}
          {kind === 'camera' && (
            <>
              {live && (
                <span data-testid="previz-track-live" className={LIVE_BADGE}>
                  {t('previz.timeline.live')}
                </span>
              )}
              {onCut && (
                <button
                  type="button"
                  className={ICON_BUTTON}
                  aria-label={t('previz.timeline.cutHere')}
                  title={t('previz.timeline.cutHere')}
                  onClick={onCut}
                >
                  <SwitchCamera className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                className={ICON_BUTTON}
                aria-label={t('previz.timeline.addCloseup')}
                title={t('previz.timeline.addCloseup')}
                // 场景里只有这台机位时没得跟。摆一个按下去没反应的按钮比没有更糟。
                disabled={closeupTargets.length === 0}
                onClick={() => setPicking((open) => !open)}
              >
                <Link2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
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

/** 片段条的配色：对象轨道两种（蓝=轨迹、紫=特写），固定行两种（橙=切片、青=音频）。 */
const TONE_CLASS = {
  path: { idle: 'bg-[#3560ba]', selected: 'bg-[#4a7de0] ring-1 ring-[#a8c4ff]' },
  closeup: { idle: 'bg-[#6c43ae]', selected: 'bg-[#8a5cd6] ring-1 ring-[#d5bcff]' },
  cut: { idle: 'bg-[#b8801f]', selected: 'bg-[#d69a24] ring-1 ring-[#ffd27a]' },
  audio: { idle: 'bg-[#2a8c7a]', selected: 'bg-[#37b39c] ring-1 ring-[#9ff0dc]' },
} as const;

export type ClipBarTone = keyof typeof TONE_CLASS;

/*
  不给 tone 时按片段种类取色。写成 Record 而不是 isRigClip 三元：三元把 rig 以外的
  一切都当轨迹，切片会画成蓝的；查表则漏了将来的第六种片段就编译不过。
*/
const CLIP_TONE: Record<PrevizClip['kind'], ClipBarTone> = {
  path: 'path',
  action: 'path',
  rig: 'closeup',
  cut: 'cut',
  audio: 'audio',
};

/*
  不给 label 时的兜底文案。切片与音频没有对应的词条，也不该套用「路径片段」——
  它们本来就自带名字（机位名、文件名），兜底只报帧区间，不冒充别的东西。
*/
const CLIP_LABEL_KEY: Record<PrevizClip['kind'], string | null> = {
  path: 'previz.timeline.clipLabel',
  action: 'previz.timeline.clipLabel',
  rig: 'previz.timeline.closeupLabel',
  cut: null,
  audio: null,
};

export function ClipBar({
  clip,
  pxPerFrame,
  selected,
  onSelect,
  onTrim,
  label,
  tone,
  children,
}: {
  clip: PrevizClip;
  pxPerFrame: number;
  selected: boolean;
  onSelect: () => void;
  onTrim: (edge: 'start' | 'end', frame: number) => void;
  /** 不给就按帧区间写「片段 a~b」/「特写 a~b」。 */
  label?: string;
  /** 不给就按片段种类：特写紫、其它蓝。 */
  tone?: ClipBarTone;
  /**
   * 画在标签底下的内容（音频波形）。必须自己 absolute inset-0：
   * 片段条是 flex 行，静态子节点会变成挤在标签前面的兄弟项，
   * 把标签推出 overflow-hidden 之外，看到的就是一条没有字的片段。
   */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const paint = TONE_CLASS[tone ?? CLIP_TONE[clip.kind]];
  const labelKey = CLIP_LABEL_KEY[clip.kind];
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
      /*
        一种片段一种颜色：路径蓝、特写紫、切片橙、音频青。同色的话，一条机位轨道上「自己走位」
        与「跟着人走」两段看起来一模一样，而它们的改法完全不同。
      */
      className={`absolute top-1 flex h-6 items-center overflow-hidden rounded ${
        selected ? paint.selected : paint.idle
      }`}
      style={{
        left: clip.startFrame * pxPerFrame,
        width: (clip.endFrame - clip.startFrame) * pxPerFrame,
      }}
    >
      {children}
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
        {label ??
          (labelKey
            ? t(labelKey, { start: clip.startFrame, end: clip.endFrame })
            : `${clip.startFrame}-${clip.endFrame}`)}
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
