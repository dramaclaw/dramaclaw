// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Scissors,
  Square,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { PrevizClip } from '../domain/scene';
import { PREVIZ_FPS } from '../domain/scene';
import { isPathClip, uToFrame } from '../domain/timeline';
import { PREVIZ_PLAYBACK_RATES, usePrevizStore } from '../store';

/** 传输条上每个图标按钮的样式。 */
const BUTTON_CLASS =
  'flex h-7 w-7 items-center justify-center rounded text-[#c7cedb] hover:bg-[#2a2f3a] disabled:opacity-40';

export function PrevizTimeline() {
  const { t } = useTranslation();
  const durationFrames = usePrevizStore((state) => state.scene.settings.durationFrames);
  const frame = usePrevizStore((state) => state.timelineFrame);
  const playing = usePrevizStore((state) => state.timelinePlaying);
  const rate = usePrevizStore((state) => state.timelineRate);
  const setTimelineFrame = usePrevizStore((state) => state.setTimelineFrame);
  const setTimelinePlaying = usePrevizStore((state) => state.setTimelinePlaying);
  const stopPlayback = usePrevizStore((state) => state.stopPlayback);
  const setTimelineRate = usePrevizStore((state) => state.setTimelineRate);
  const setDurationFrames = usePrevizStore((state) => state.setDurationFrames);
  const objects = usePrevizStore((state) => state.scene.objects);
  const tracks = usePrevizStore((state) => state.scene.timeline.tracks);
  const selectedClipId = usePrevizStore((state) => state.selectedClipId);
  const selectedPointId = usePrevizStore((state) => state.selectedPointId);
  const selectClip = usePrevizStore((state) => state.selectClip);
  const selectPathPoint = usePrevizStore((state) => state.selectPathPoint);
  const splitClipAtPlayhead = usePrevizStore((state) => state.splitClipAtPlayhead);
  const removeTrackFor = usePrevizStore((state) => state.removeTrackFor);
  const addObjectToTimeline = usePrevizStore((state) => state.addObjectToTimeline);

  const nameOf = (objectId: string) =>
    objects.find((object) => object.id === objectId)?.name ?? objectId;
  const untracked = objects.filter(
    (object) => !tracks.some((track) => track.objectId === object.id),
  );

  return (
    <div className="flex flex-col gap-2 border-t border-[#232833] bg-[#15181f] px-3 py-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={BUTTON_CLASS}
          aria-label={t('previz.timeline.goToStart')}
          onClick={() => setTimelineFrame(0)}
        >
          <ChevronFirst className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={BUTTON_CLASS}
          aria-label={t('previz.timeline.prevFrame')}
          onClick={() => setTimelineFrame(frame - 1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={BUTTON_CLASS}
          aria-label={playing ? t('previz.timeline.pause') : t('previz.timeline.play')}
          onClick={() => setTimelinePlaying(!playing)}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <button
          type="button"
          className={BUTTON_CLASS}
          aria-label={t('previz.timeline.stop')}
          onClick={stopPlayback}
        >
          <Square className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={BUTTON_CLASS}
          aria-label={t('previz.timeline.nextFrame')}
          onClick={() => setTimelineFrame(frame + 1)}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={BUTTON_CLASS}
          aria-label={t('previz.timeline.goToEnd')}
          onClick={() => setTimelineFrame(durationFrames)}
        >
          <ChevronLast className="h-4 w-4" />
        </button>

        <button
          type="button"
          className={BUTTON_CLASS}
          aria-label={t('previz.timeline.razor')}
          title={t('previz.timeline.razor')}
          disabled={!selectedClipId}
          onClick={() => selectedClipId && splitClipAtPlayhead(selectedClipId)}
        >
          <Scissors className="h-4 w-4" />
        </button>

        <span
          data-testid="previz-timecode"
          className="ml-2 font-mono text-xs tabular-nums text-[#c7cedb]"
        >
          {/* 秒与帧一起报：只报帧号的话，「这个镜头几秒」每次都得心算。 */}
          {(frame / PREVIZ_FPS).toFixed(2)}s · {frame}/{durationFrames}
        </span>

        <label className="ml-auto flex items-center gap-1 text-xs text-[#8b93a3]">
          {t('previz.timeline.rate')}
          <select
            aria-label={t('previz.timeline.rate')}
            className="rounded bg-[#1d222b] px-1 py-0.5 text-[#c7cedb]"
            value={rate}
            onChange={(event) => setTimelineRate(Number(event.target.value))}
          >
            {PREVIZ_PLAYBACK_RATES.map((option) => (
              <option key={option} value={option}>
                {option}×
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1 text-xs text-[#8b93a3]">
          {t('previz.timeline.duration')}
          <input
            type="number"
            aria-label={t('previz.timeline.duration')}
            className="w-16 rounded bg-[#1d222b] px-1 py-0.5 text-right text-[#c7cedb]"
            defaultValue={durationFrames}
            key={durationFrames}
            onBlur={(event) => setDurationFrames(Number(event.target.value))}
          />
        </label>
      </div>

      {/*
        播放头用 range input 而不是「在时间轴条上按下拖动」：jsdom 没有布局，
        条上的命中测试只能对着 mock 出来的 getBoundingClientRect 断言，等于没测；
        range 顺带白拿键盘可达性。条上拖拽是 P4 的事。
      */}
      <input
        type="range"
        aria-label={t('previz.timeline.playhead')}
        className="w-full accent-[#5b8cff]"
        min={0}
        max={durationFrames}
        step={1}
        value={frame}
        onChange={(event) => setTimelineFrame(Number(event.target.value))}
      />

      <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
        {tracks.length === 0 && (
          <li className="px-1 py-2 text-xs text-[#6d7585]">{t('previz.timeline.empty')}</li>
        )}
        {tracks.map((track) => (
          <li
            key={track.id}
            aria-label={nameOf(track.objectId)}
            className="flex items-center gap-2"
          >
            <span className="w-24 shrink-0 truncate text-xs text-[#c7cedb]">
              {nameOf(track.objectId)}
            </span>

            {/* 片段条按帧号定位在这条 relative 轨槽里，和上面的 range 共用同一套 0~时长坐标。 */}
            <div className="relative h-6 min-w-0 flex-1 rounded bg-[#1d222b]">
              {track.clips.map((clip) => (
                <ClipBar
                  key={clip.id}
                  clip={clip}
                  durationFrames={durationFrames}
                  selected={clip.id === selectedClipId}
                  selectedPointId={selectedPointId}
                  onSelect={() => selectClip(clip.id)}
                  onSelectPoint={(pointId, u) => {
                    selectClip(clip.id);
                    selectPathPoint(pointId);
                    // 播放头跟着跳过去：不跳的话属性面板改的那个点在视口里根本看不见。
                    setTimelineFrame(uToFrame(clip, u));
                  }}
                />
              ))}
            </div>

            <button
              type="button"
              className={BUTTON_CLASS}
              aria-label={t('previz.timeline.removeTrack')}
              title={t('previz.timeline.removeTrack')}
              onClick={() => removeTrackFor(track.objectId)}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>

      <label className="flex items-center gap-1 text-xs text-[#8b93a3]">
        {t('previz.timeline.addObject')}
        <select
          aria-label={t('previz.timeline.addObject')}
          className="rounded bg-[#1d222b] px-1 py-0.5 text-[#c7cedb]"
          value=""
          onChange={(event) => event.target.value && addObjectToTimeline(event.target.value)}
        >
          <option value="" />
          {/* 已经有轨道的对象不列：一个对象一条轨道，再加一次只会加到原来那条上。 */}
          {untracked.map((object) => (
            <option key={object.id} value={object.id}>
              {object.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function ClipBar({
  clip,
  durationFrames,
  selected,
  selectedPointId,
  onSelect,
  onSelectPoint,
}: {
  clip: PrevizClip;
  durationFrames: number;
  selected: boolean;
  selectedPointId: string | null;
  onSelect: () => void;
  onSelectPoint: (pointId: string, u: number) => void;
}) {
  // 除零守卫：时长最小是 1 帧（schema 保证），但这里不依赖那个保证——真除出 NaN 的话
  // 整条轨道会从布局里消失，而不是显示得难看一点。
  const span = durationFrames || 1;
  const left = (clip.startFrame / span) * 100;
  const width = ((clip.endFrame - clip.startFrame) / span) * 100;

  return (
    <div
      data-testid={`previz-clip-${clip.id}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onSelect();
      }}
      className={`absolute top-0 h-6 rounded ${
        selected ? 'bg-[#5b8cff]/45 ring-1 ring-[#8fb0ff]' : 'bg-[#39415a]'
      }`}
      style={{ left: `${left}%`, width: `${width}%` }}
    >
      {isPathClip(clip) &&
        clip.points.map((point) => (
          <button
            key={point.id}
            type="button"
            data-testid={`previz-keyframe-${point.id}`}
            aria-label={`${point.id}`}
            className={`absolute top-1.5 h-3 w-3 -translate-x-1/2 rotate-45 rounded-[2px] ${
              point.id === selectedPointId ? 'bg-[#ffd166]' : 'bg-[#dfe6f5]'
            }`}
            style={{ left: `${point.u * 100}%` }}
            onClick={(event) => {
              // 不冒泡到片段条：那一层会把刚选中的轨迹点清掉（选片段等于换上下文）。
              event.stopPropagation();
              onSelectPoint(point.id, point.u);
            }}
          />
        ))}
    </div>
  );
}
