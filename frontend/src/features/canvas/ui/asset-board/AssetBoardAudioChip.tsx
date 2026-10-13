// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState, type ReactElement } from 'react';
import { AlertCircle, Download, Loader2, Music } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/shadcn/dropdown-menu';
import { downloadAudioAs } from '@/features/canvas/application/audioDownload';
import type { AssetBoardItem } from '@/features/canvas/domain/assetBoard';
import {
  AUDIO_DOWNLOAD_FORMATS,
  canProduceFormat,
  getAudioExtFromUrl,
  type AudioDownloadFormat,
} from '@/lib/audioTranscode';

/** 时长角标格式：mm:ss（对齐参考图方块内「01:41」）。 */
function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const mm = Math.floor(s / 60)
    .toString()
    .padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * 音频 chip：大图标方块 + 下方标题（与关键元素/图片缩略图同款形态，对齐参考图）。
 * 方块点击 = 打开音频详情（波形播放器 + 生成表单，与图片/视频同一套主从详情）；
 * hover 时方块右上角出「下载/格式转换」按钮（复用 application/audioDownload 的
 * 透传/转码核心）。顶部音频条（总览态）与音频详情左侧切换器共用同一枚 chip。
 *
 * 失败指示：音频生成失败只写在 node.data.generationError 上，chip 此前只有生成中
 * spinner、没有任何失败痕迹——用户看到的是「转完圈就没动静了」。这里在方块角上补一个
 * 红色角标（title 带完整错误文案），完整错误文本在详情里的生成表单上。
 */
export function AssetBoardAudioChip({
  item,
  onOpen,
  selected = false,
}: {
  item: AssetBoardItem;
  /** 点击主体 → 打开该音频节点的详情面板。 */
  onOpen: (item: AssetBoardItem) => void;
  /** 顶部音频条（音频切换器）里当前详情项的选中高亮。 */
  selected?: boolean;
}): ReactElement {
  const [converting, setConverting] = useState<AudioDownloadFormat | null>(null);
  // 节点没记 durationMs 时（生成/上传路径大多不写），用一个隐藏 <audio preload="metadata">
  // 探测真实时长——否则 chip 上永远空着。
  // 只落本地 state、不回写节点：updateNodeData 会 pushSnapshot 进撤销栈并 trackEdit
  // 标脏，而这条探测是「打开故事板就自动跑」的被动行为——回写会让用户没做任何操作
  // 就被塞进 N 条撤销记录（Ctrl+Z 先撤销这些）并触发一次无意义的自动保存。
  // 与图片卡的自然尺寸兜底（AssetBoardCard 的 captureNaturalSize）同一口径。
  const [probedSec, setProbedSec] = useState<number | null>(null);
  const audioUrl = item.mediaUrl;
  const sourceExt = audioUrl ? getAudioExtFromUrl(audioUrl) : '';
  // 分离出的音频节点 title 可能不带扩展名；带了就剥掉，按所选格式重拼。
  const baseFileName =
    item.title.replace(/\.(mp3|m4a|aac|wav|flac|ogg|opus|mp4|m4b)$/i, '') ||
    `audio-${item.nodeId}`;

  const handleDownload = async (format: AudioDownloadFormat) => {
    if (!audioUrl || converting) return;
    if (!canProduceFormat(format, sourceExt)) {
      toast.error('源文件不是 m4a，无法转换为 m4a 格式');
      return;
    }
    try {
      await downloadAudioAs(format, {
        audioUrl,
        baseFileName,
        onConvertingChange: setConverting,
      });
    } catch (error) {
      console.error('[asset-board] audio download failed', error);
      toast.error('音频下载失败');
    }
  };

  // 生成中优先于失败：重试期间不该还挂着上一次的红标。
  const failure = !item.isGenerating && item.generationError ? item.generationError : null;
  const durationSec = item.durationSec ?? probedSec;
  const durationLabel = durationSec !== null ? formatDuration(durationSec) : null;

  return (
    <div className="group flex w-12 shrink-0 flex-col items-center gap-1">
      <div className="relative h-12 w-12">
        <button
          type="button"
          aria-label={item.title}
          title={item.title}
          onClick={() => onOpen(item)}
          className={cn(
            // 方块底色统一 #141414（用户指定的纯黑）：选中/hover 的反馈改走边框，
            // 免得再用白透明层把底色提亮、破坏这个纯黑。
            'flex h-full w-full items-center justify-center rounded-[6px] border bg-[#141414] transition-colors',
            failure
              ? 'border-red-500/40'
              : selected
                ? 'border-white/25'
                : 'border-transparent hover:border-white/15',
          )}
        >
          {/* 图标在上、时长在下并居中（对齐参考图），不再是压在左下角的小角标。 */}
          <span className="flex flex-col items-center gap-1">
            {item.isGenerating ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : (
              <Music className="h-5 w-5 text-muted-foreground" />
            )}
            {durationLabel && (
              <span className="text-[10px] leading-none text-white/50">{durationLabel}</span>
            )}
          </span>
        </button>

        {/* 探测用的隐藏音频：只在节点没记时长、且本地也还没探到时挂。 */}
        {audioUrl && item.durationSec === null && probedSec === null && (
          <audio
            src={audioUrl}
            preload="metadata"
            className="hidden"
            onLoadedMetadata={(event) => {
              const seconds = event.currentTarget.duration;
              if (!Number.isFinite(seconds) || seconds <= 0) return;
              setProbedSec(seconds);
            }}
          />
        )}

        {failure && (
          <span
            aria-label="生成失败"
            title={failure}
            className="pointer-events-none absolute left-1 top-1 inline-flex"
          >
            <AlertCircle className="h-3.5 w-3.5 text-red-400" />
          </span>
        )}

        {audioUrl && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`下载 ${item.title}`}
                title="下载 / 格式转换"
                disabled={converting !== null}
                className={cn(
                  'absolute right-1 top-1 rounded-md bg-black/50 p-1 text-white/80 transition-opacity hover:bg-black/70 disabled:cursor-not-allowed',
                  // 平时隐藏,hover/聚焦方块时露出;转码中常驻可见(带 spinner)。
                  converting ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
                )}
              >
                {converting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={6}
              className="z-50 min-w-[170px] border-white/10 bg-[#2e2e2e] text-white/85 shadow-xl"
            >
              {AUDIO_DOWNLOAD_FORMATS.map((format) => {
                const available = canProduceFormat(format, sourceExt);
                return (
                  <DropdownMenuItem
                    key={format}
                    disabled={!available || converting !== null}
                    className="gap-2 rounded-md text-white/80 focus:bg-white/[0.08] focus:text-white"
                    onSelect={() => void handleDownload(format)}
                  >
                    {converting === format ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    <span className="flex-1">下载为 {format.toUpperCase()}</span>
                    {!available && <span className="text-[10px] opacity-60">仅 m4a 源</span>}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <span className="block w-full truncate text-center text-[11px] text-white/80">{item.title}</span>
    </div>
  );
}
