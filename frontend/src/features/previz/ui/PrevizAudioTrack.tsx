// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { AudioLines, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { loadAudioPeaks, PEAK_BUCKETS_PER_SEC } from '@/features/canvas/compose/audioPeaks';

import { framesToMs, PREVIZ_MAX_AUDIO_CLIPS } from '../domain/audioTrack';
import type { PrevizScene } from '../domain/scene';
import { ClipBar, PREVIZ_TRACK_HEADER_PX } from './PrevizTimelineTrack';
import type { PendingAudioClip, PrevizUpstreamAudio } from './useAudioImport';

/** 样式串太长，写在 JSX 里会把行挤过 100 列，提成常量。以下四个同理。 */
const ICON_BUTTON =
  'flex h-6 w-6 items-center justify-center rounded text-[#8b93a5] hover:bg-[#2a2f3a] ' +
  'hover:text-white disabled:opacity-40 disabled:hover:bg-transparent';

const MENU =
  'absolute left-6 top-7 z-40 flex min-w-44 flex-col rounded border border-[#2f3542] ' +
  'bg-[#1d222b] py-1 shadow-lg';

const MENU_ITEM = 'px-2 py-1 text-left text-xs text-[#c7cedb] hover:bg-[#2a2f3a]';

const PENDING_BAR =
  'absolute top-1 flex h-6 items-center overflow-hidden rounded border border-dashed ' +
  'border-white/30 bg-white/5 px-3 text-[11px] text-white/60';

export interface PrevizAudioTrackProps {
  scene: PrevizScene;
  pxPerFrame: number;
  laneWidthPx: number;
  selectedClipId: string | null;
  onSelect: (clipId: string) => void;
  onTrim: (clipId: string, edge: 'start' | 'end', frame: number) => void;
  upstreamAudio: readonly PrevizUpstreamAudio[];
  pending: PendingAudioClip | null;
  onAddFile: (file: File) => void;
  onAddUpstream: (source: PrevizUpstreamAudio) => void;
}

/** 音频轨：固定一行，挂在对象轨道下面。 */
export function PrevizAudioTrack({
  scene,
  pxPerFrame,
  laneWidthPx,
  selectedClipId,
  onSelect,
  onTrim,
  upstreamAudio,
  pending,
  onAddFile,
  onAddUpstream,
}: PrevizAudioTrackProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const clips = scene.timeline.audio;
  const full = clips.length >= PREVIZ_MAX_AUDIO_CLIPS;
  const fps = scene.settings.fps;

  /*
    两种禁用原因都写在包着按钮的 span 上：禁用的表单控件不派发鼠标事件，title 挂在按钮
    自己身上，恰恰在需要解释的那一刻弹不出来，用户只看到一颗点不动、也不说为什么的加号。
  */
  const hint = full
    ? t('previz.audio.limit')
    : pending !== null
      ? t('previz.audio.uploading')
      : t('previz.audio.add');

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => {
      // 落在表头里（含加号自己）不管：那一下交给按钮的 onClick 去切，
      // 否则这里先关、按钮再开，看起来就像点了没反应。
      if (header.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [menuOpen]);

  return (
    <div
      data-testid="previz-audio-track"
      className="flex h-8 items-stretch border-b border-[#1c202a]"
    >
      <div
        ref={header}
        className="sticky left-0 z-30 flex shrink-0 items-center gap-1 bg-[#15181f] pl-1 pr-2"
        style={{ width: PREVIZ_TRACK_HEADER_PX }}
      >
        {/*
          补上对象轨道行那颗展开箭头的位置。音频轨没有子轨道，但少了这 24px，
          图标与标题会比它上面的每一条轨道都往左错开一截。
        */}
        <span aria-hidden="true" className="h-6 w-6 shrink-0" />
        {/*
          禁用条件也管着菜单：加号只在自己身上拦得住新片段，菜单开着时状态从外部翻过去
          （撤销恢复出一个装满的场景、或者另一段开始上传），条目还挂在那儿点得动。
        */}
        {menuOpen && !full && pending === null && (
          <div role="menu" aria-label={t('previz.audio.add')} className={MENU}>
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => {
                setMenuOpen(false);
                fileInput.current?.click();
              }}
            >
              {t('previz.audio.local')}
            </button>
            {/*
              上游那截包一层 group：role=menu 的孩子只能是 menuitem / group 一类，
              段落标题与空态提示直接摆进去是无效结构。标题交给 group 的 aria-label 念，
              视觉上那行字标成装饰，免得读屏念两遍。
            */}
            <div role="group" aria-label={t('previz.audio.upstream')} className="flex flex-col">
              <span aria-hidden="true" className="px-2 pb-0.5 pt-1 text-[10px] text-[#6d7585]">
                {t('previz.audio.upstream')}
              </span>
              {upstreamAudio.length === 0 && (
                <span className="px-2 py-1 text-[11px] text-[#6d7585]">
                  {t('previz.audio.noUpstream')}
                </span>
              )}
              {upstreamAudio.map((source) => (
                <button
                  key={source.nodeId}
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={() => {
                    setMenuOpen(false);
                    onAddUpstream(source);
                  }}
                >
                  {source.displayName}
                </button>
              ))}
            </div>
          </div>
        )}
        {/* 选完立刻清空 value，同一个文件才能再选一次——change 只在值变了时才发。 */}
        <input
          ref={fileInput}
          type="file"
          accept="audio/*"
          data-testid="previz-audio-file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) onAddFile(file);
          }}
        />
        <AudioLines className="h-3.5 w-3.5 shrink-0 text-[#37b39c]" />
        <span className="min-w-0 flex-1 truncate text-xs text-[#c7cedb]">
          {t('previz.audio.title')}
        </span>
        <span title={hint} className="flex shrink-0">
          <button
            type="button"
            className={ICON_BUTTON}
            aria-label={t('previz.audio.add')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            // 上传中也关掉：占位条还没落地，这时再加一段会挤掉它算好的空隙。
            disabled={full || pending !== null}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      <div className="relative shrink-0" style={{ width: laneWidthPx }}>
        {clips.map((clip) => (
          <ClipBar
            key={clip.id}
            clip={clip}
            pxPerFrame={pxPerFrame}
            selected={clip.id === selectedClipId}
            onSelect={() => onSelect(clip.id)}
            onTrim={(edge, frame) => onTrim(clip.id, edge, frame)}
            label={clip.sourceName}
            tone="audio"
          >
            <AudioWave
              clipId={clip.id}
              audioUrl={clip.audioUrl}
              offsetMs={clip.offsetMs}
              clipMs={framesToMs(clip.endFrame - clip.startFrame, fps)}
              // 与 ClipBar 给自己算的宽度同一个式子：波形铺满整条片段。
              widthPx={(clip.endFrame - clip.startFrame) * pxPerFrame}
            />
          </ClipBar>
        ))}
        {pending && (
          <div
            data-testid="previz-audio-pending"
            className={PENDING_BAR}
            style={{
              left: pending.startFrame * pxPerFrame,
              width: (pending.endFrame - pending.startFrame) * pxPerFrame,
            }}
          >
            <span className="truncate">
              {t('previz.audio.uploading')} · {pending.name}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

type WaveState = 'loading' | 'ready' | 'failed';

/** 波形高度的兜底：ClipBar 是 h-6。没排版时（jsdom、display:none）clientHeight 读到 0。 */
const WAVE_HEIGHT_PX = 24;

/**
 * 片段底下的波形。峰值按 120 桶/秒缓存在 audioPeaks 里，这里只按片段的偏移与长度取一段
 * 画到 canvas 上。灰=还在读，红=读不出来（多半是解不了码，播放也会静音）。
 */
function AudioWave({
  clipId,
  audioUrl,
  offsetMs,
  clipMs,
  widthPx,
}: {
  clipId: string;
  audioUrl: string;
  offsetMs: number;
  clipMs: number;
  widthPx: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [state, setState] = useState<WaveState>('loading');

  // 解码只认素材本身：整段峰值与片段裁在哪、时间线缩放到几倍都无关。
  // 跟着窗口一起重跑的话，每拖一下都要再解一次码，那层模块级缓存就白建了。
  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setPeaks(null);
    loadAudioPeaks(audioUrl)
      .then((loaded) => {
        if (cancelled) return;
        setPeaks(loaded);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [audioUrl]);

  /*
    画是另一件事，得跟着窗口和宽度重来。widthPx 不在依赖里的话，时间线一缩放，留在
    canvas 上的还是上一档分辨率的位图，浏览器直接拉伸：放大四倍，1px 的柱子糊成一片；
    缩小四倍，四根柱子挤成一根。
  */
  useEffect(() => {
    if (!peaks) return;
    drawPeaks(canvasRef.current, peaks, offsetMs, clipMs, widthPx);
  }, [peaks, offsetMs, clipMs, widthPx]);

  return (
    <canvas
      ref={canvasRef}
      data-testid={`previz-audio-wave-${clipId}`}
      data-state={state}
      className={`pointer-events-none absolute inset-0 h-full w-full ${
        state === 'failed' ? 'bg-[#8f2f31]/70' : state === 'loading' ? 'bg-white/10' : ''
      }`}
    />
  );
}

/**
 * 片段每一列像素画多高的柱子：整段峰值里按 `offsetMs` 起、`clipMs` 长截一窗，
 * 再重采样到画布宽度。单独拆出来是因为它是这块唯一有算术的地方，
 * 而 canvas 那套在 jsdom 里根本跑不起来，混在绘制里就没法验。
 */
export function peakBarHeights(
  peaks: Float32Array,
  offsetMs: number,
  clipMs: number,
  width: number,
  height: number,
): number[] {
  const first = (offsetMs / 1000) * PEAK_BUCKETS_PER_SEC;
  /*
    这一窗跨了多少桶，不取整。clipMs 是帧数换算来的浮点数，(clipMs / 1000) * 120 常常
    差在末位：fps=30、13 帧的片段整整 52 桶，算出来却是 51.99999999999999，先 floor
    一下就少画最后一桶——30fps 下大半的帧数都撞得上。
  */
  const span = (clipMs / 1000) * PEAK_BUCKETS_PER_SEC;
  const bars: number[] = [];
  for (let x = 0; x < width; x += 1) {
    const from = first + (x / width) * span;
    const to = first + ((x + 1) / width) * span;
    /*
      一列跨到的桶取最大值，不是挑其中一个采样。computePeaks 每桶存的本来就是那一段的
      峰值，这里再点采样一次等于把它扔了：2 秒的片段有 240 桶，画在 120px 上一半看不见，
      缩小到 30px 只剩八分之一——一句安静的台词里那一下爆音正好被丢掉，而那恰恰是摆音频
      时要找的东西。不足一桶时 to 与 from 同落一桶，下面的下界保证至少读一桶：短片段
      画成平的一条，正是想要的。
    */
    let peak = 0;
    for (let b = Math.floor(from); b < Math.max(Math.floor(from) + 1, Math.ceil(to)); b += 1) {
      // 片段比素材长时读到 undefined，按静音算。
      const value = peaks[b] ?? 0;
      if (value > peak) peak = value;
    }
    // 静音也留 1px，波形不至于断成一截一截。
    bars.push(Math.max(1, peak * height));
  }
  return bars;
}

/** 把柱子画成中线对称的一条波形。 */
function drawPeaks(
  canvas: HTMLCanvasElement | null,
  peaks: Float32Array,
  offsetMs: number,
  clipMs: number,
  widthPx: number,
): void {
  if (!canvas) return;
  // 宽度用算好的片段宽度，不读 clientWidth：那是布局量，缩放当帧未必已经量准。
  const width = Math.max(1, Math.round(widthPx));
  const height = Math.max(1, Math.round(canvas.clientHeight || WAVE_HEIGHT_PX));
  /*
    位图按设备像素铺，坐标系再缩回 CSS 像素来画：不这么做，2x 屏上每根 1px 的柱子都是
    浏览器放大出来的，整条波形发虚。倍数压到 2 封顶——3x 手机上不值那三倍显存。
  */
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 改 width 已经清空了画布，这里再清一次，免得押在「尺寸没变时也重置」这条实现细节上。
  context.clearRect(0, 0, width, height);
  context.fillStyle = 'rgba(255,255,255,0.55)';
  const middle = height / 2;
  peakBarHeights(peaks, offsetMs, clipMs, width, height).forEach((bar, x) => {
    context.fillRect(x, middle - bar / 2, 1, bar);
  });
}
