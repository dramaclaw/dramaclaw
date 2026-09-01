// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Square,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PREVIZ_FPS } from '../domain/scene';
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
    </div>
  );
}
