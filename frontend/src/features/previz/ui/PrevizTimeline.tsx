// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Maximize,
  Pause,
  Play,
  Plus,
  Square,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { closeupTargets } from '../domain/closeupClip';
import type { PrevizObjectKind } from '../domain/scene';
import { PREVIZ_FPS } from '../domain/scene';
import { PREVIZ_PLAYBACK_RATES, usePrevizStore } from '../store';
import { PrevizTimeRuler } from './PrevizTimeRuler';
import { PREVIZ_TRACK_HEADER_PX, PrevizTimelineTrack } from './PrevizTimelineTrack';

/** 传输条上每个图标按钮的样式。 */
const BUTTON_CLASS =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded text-[#c7cedb] hover:bg-[#2a2f3a] disabled:opacity-40';

/** 缩放按钮一次走多少倍。1.5 大约是「按三下翻一番」，手感不至于太跳。 */
const ZOOM_STEP = 1.5;

export function PrevizTimeline({
  onCreateObject,
}: {
  /**
   * 空态里的「创建人物 / 创建机位」走这里。不直接调 store 的 addObject：
   * 机位在编辑器里要先过创建对话框，绕过去就少了取景那一步。没传时退回直接建。
   */
  onCreateObject?: (kind: PrevizObjectKind) => void;
} = {}) {
  const { t } = useTranslation();
  const durationFrames = usePrevizStore((state) => state.scene.settings.durationFrames);
  const frame = usePrevizStore((state) => state.timelineFrame);
  const playing = usePrevizStore((state) => state.timelinePlaying);
  const rate = usePrevizStore((state) => state.timelineRate);
  const zoom = usePrevizStore((state) => state.timelineZoom);
  const setTimelineFrame = usePrevizStore((state) => state.setTimelineFrame);
  const setTimelinePlaying = usePrevizStore((state) => state.setTimelinePlaying);
  const stopPlayback = usePrevizStore((state) => state.stopPlayback);
  const setTimelineRate = usePrevizStore((state) => state.setTimelineRate);
  const setDurationFrames = usePrevizStore((state) => state.setDurationFrames);
  const zoomTimelineBy = usePrevizStore((state) => state.zoomTimelineBy);
  const fitTimelineZoom = usePrevizStore((state) => state.fitTimelineZoom);
  const scene = usePrevizStore((state) => state.scene);
  const objects = usePrevizStore((state) => state.scene.objects);
  const tracks = usePrevizStore((state) => state.scene.timeline.tracks);
  const selectedClipId = usePrevizStore((state) => state.selectedClipId);
  const selectedPointId = usePrevizStore((state) => state.selectedPointId);
  const selectClip = usePrevizStore((state) => state.selectClip);
  const selectPathPoint = usePrevizStore((state) => state.selectPathPoint);
  const splitClipAtPlayhead = usePrevizStore((state) => state.splitClipAtPlayhead);
  const removeTrackFor = usePrevizStore((state) => state.removeTrackFor);
  const pinTrackToTop = usePrevizStore((state) => state.pinTrackToTop);
  const addObjectToTimeline = usePrevizStore((state) => state.addObjectToTimeline);
  const appendClip = usePrevizStore((state) => state.appendClip);
  const setClipEdge = usePrevizStore((state) => state.setClipEdge);
  const insertKeyframe = usePrevizStore((state) => state.insertKeyframe);
  const clearPath = usePrevizStore((state) => state.clearPath);
  const addObject = usePrevizStore((state) => state.addObject);
  const addCloseup = usePrevizStore((state) => state.addCloseup);

  /** 折叠过的轨道。没记过的默认展开——建完轨迹马上要看关键帧。 */
  const [collapsed, setCollapsed] = useState<Record<string, true>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportPx, setViewportPx] = useState(0);

  useEffect(() => {
    const node = scrollRef.current;
    // jsdom 没有 ResizeObserver，也没有布局——量不出来就按 0 走，轨槽退回内容宽度。
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setViewportPx(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const pxPerFrame = zoom / PREVIZ_FPS;
  const lanePx = Math.max(viewportPx - PREVIZ_TRACK_HEADER_PX, 0);
  // 尺子铺满面板，哪怕内容只有 4 秒——参照实现里 0s~10s 的刻度是一直在的。
  const laneWidthPx = Math.max(durationFrames * pxPerFrame, lanePx, 1);

  const seekFromPointer = useCallback(
    (clientX: number, element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      setTimelineFrame(Math.round((clientX - rect.left) / (pxPerFrame || 1)));
    },
    [pxPerFrame, setTimelineFrame],
  );

  const scrubFrom = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      seekFromPointer(event.clientX, element);
      const move = (moved: PointerEvent) => seekFromPointer(moved.clientX, element);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [seekFromPointer],
  );

  const create = (kind: PrevizObjectKind) => (onCreateObject ? onCreateObject(kind) : addObject(kind));
  const nameOf = (objectId: string) =>
    objects.find((object) => object.id === objectId)?.name ?? objectId;
  const kindOf = (objectId: string): PrevizObjectKind =>
    objects.find((object) => object.id === objectId)?.kind ?? 'prop';
  const untracked = objects.filter(
    (object) => !tracks.some((track) => track.objectId === object.id),
  );

  return (
    <div className="flex flex-col border-t border-[#232833] bg-[#15181f]">
      <div className="flex items-center gap-1 px-3 py-1.5">
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
          {/* 帧号、已走的秒数、总长一起报：只报帧号的话「这个镜头几秒」每次都得心算。 */}
          F{frame} · {(frame / PREVIZ_FPS).toFixed(2)}s /{' '}
          {(durationFrames / PREVIZ_FPS).toFixed(2)}s
        </span>

        <label className="ml-3 flex items-center gap-1 text-xs text-[#8b93a3]">
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

        <label className="flex items-center gap-1 text-xs text-[#8b93a3]">
          <Plus className="h-3.5 w-3.5" />
          <span className="sr-only">{t('previz.timeline.addObject')}</span>
          <select
            aria-label={t('previz.timeline.addObject')}
            className="rounded bg-[#1d222b] px-1 py-0.5 text-[#c7cedb]"
            value=""
            onChange={(event) => event.target.value && addObjectToTimeline(event.target.value)}
          >
            <option value="">{t('previz.timeline.addObject')}</option>
            {/* 已经有轨道的对象不列：一个对象一条轨道，再加一次只会加到原来那条上。 */}
            {untracked.map((object) => (
              <option key={object.id} value={object.id}>
                {object.name}
              </option>
            ))}
          </select>
        </label>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className={BUTTON_CLASS}
            aria-label={t('previz.timeline.zoomOut')}
            onClick={() => zoomTimelineBy(1 / ZOOM_STEP)}
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={BUTTON_CLASS}
            aria-label={t('previz.timeline.zoomIn')}
            onClick={() => zoomTimelineBy(ZOOM_STEP)}
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={BUTTON_CLASS}
            aria-label={t('previz.timeline.zoomFit')}
            onClick={() => fitTimelineZoom(lanePx)}
          >
            <Maximize className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/*
        播放头另外挂一个 range：jsdom 没有布局，在轨槽上按下拖动的命中测试只能对着
        mock 出来的 getBoundingClientRect 断言，等于没测。range 顺带白拿键盘可达性，
        视觉上藏起来——参照实现的时间轴上并没有这么一根滑块。
      */}
      <input
        type="range"
        aria-label={t('previz.timeline.playhead')}
        className="sr-only"
        min={0}
        max={durationFrames}
        step={1}
        value={frame}
        onChange={(event) => setTimelineFrame(Number(event.target.value))}
      />

      <div ref={scrollRef} className="relative max-h-56 overflow-auto">
        <div className="relative min-w-max">
          {/*
            三层压着的顺序是有讲究的：头列（30）> 播放头（20）> 标尺与轨槽（10）。
            头列要在最上面，横向滚动时片段得从它底下穿过去；播放头要压过标尺，
            不然顶上那个把手看不见——而参照实现里正是抓着那个把手拖的。
          */}
          <div className="sticky top-0 z-10 flex items-stretch bg-[#15181f]">
            <div
              className="sticky left-0 z-30 shrink-0 border-b border-[#232833] bg-[#15181f]"
              style={{ width: PREVIZ_TRACK_HEADER_PX }}
            />
            <div
              className="shrink-0 cursor-ew-resize"
              style={{ width: laneWidthPx }}
              onPointerDown={scrubFrom}
            >
              <PrevizTimeRuler seconds={laneWidthPx / zoom} pxPerSecond={zoom} />
            </div>
          </div>

          <ul>
            {tracks.map((track) => (
              <PrevizTimelineTrack
                key={track.id}
                track={track}
                name={nameOf(track.objectId)}
                kind={kindOf(track.objectId)}
                pxPerFrame={pxPerFrame}
                laneWidthPx={laneWidthPx}
                frame={frame}
                expanded={!collapsed[track.id]}
                selectedClipId={selectedClipId}
                selectedPointId={selectedPointId}
                onToggleExpand={() =>
                  setCollapsed((current) => {
                    const next = { ...current };
                    if (next[track.id]) delete next[track.id];
                    else next[track.id] = true;
                    return next;
                  })
                }
                onSelectClip={selectClip}
                onSelectPoint={(clipId, pointId, at) => {
                  selectClip(clipId);
                  selectPathPoint(pointId);
                  // 播放头跟着跳过去：不跳的话属性面板改的那个点在视口里根本看不见。
                  setTimelineFrame(at);
                }}
                onTrimClip={setClipEdge}
                onSplit={splitClipAtPlayhead}
                onAppend={() => appendClip(track.objectId)}
                onPin={() => pinTrackToTop(track.objectId)}
                onRemove={() => removeTrackFor(track.objectId)}
                onInsertKeyframe={insertKeyframe}
                onClearPath={clearPath}
                onSeek={setTimelineFrame}
                // 只有机位跟得了别人。其余轨道拿到空列表，那颗按钮根本不出现。
                closeupTargets={
                  kindOf(track.objectId) === 'camera' ? closeupTargets(scene, track.objectId) : []
                }
                onAddCloseup={(target) => addCloseup(track.objectId, target)}
              />
            ))}
          </ul>

          {tracks.length === 0 && (
            <div className="sticky left-0 flex flex-col items-center gap-2 px-4 py-8 text-center">
              {objects.length === 0 ? (
                <>
                  <p className="text-xs text-[#c7cedb]">{t('previz.timeline.emptyNoObjects')}</p>
                  <p className="text-[11px] text-[#6d7585]">
                    {t('previz.timeline.emptyNoObjectsHint')}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="rounded-full border border-[#2f3542] px-3 py-1 text-xs text-[#c7cedb] hover:border-[#5b8cff]"
                      onClick={() => create('character')}
                    >
                      {t('previz.timeline.createCharacter')}
                    </button>
                    <button
                      type="button"
                      className="rounded-full border border-[#2f3542] px-3 py-1 text-xs text-[#c7cedb] hover:border-[#5b8cff]"
                      onClick={() => create('camera')}
                    >
                      {t('previz.timeline.createCamera')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-[#8b93a3]">{t('previz.timeline.empty')}</p>
                  <p className="text-[11px] text-[#6d7585]">{t('previz.timeline.emptyHint')}</p>
                </>
              )}
            </div>
          )}

          {/* 播放头：一条贯穿所有轨道的竖线，压在头列下面（头列 z 更高）。 */}
          <div
            className="pointer-events-none absolute inset-y-0 z-20"
            style={{ left: PREVIZ_TRACK_HEADER_PX, width: laneWidthPx }}
          >
            <div
              data-testid="previz-playhead"
              className="absolute inset-y-0 w-px bg-[#e8ecf5]"
              style={{ left: frame * pxPerFrame }}
            >
              <span className="absolute -left-[5px] top-0 h-2.5 w-2.5 rounded-b-sm bg-[#e8ecf5]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
