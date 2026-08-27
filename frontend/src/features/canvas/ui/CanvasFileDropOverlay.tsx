// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Image, Music2, Upload, Video } from 'lucide-react';

const MEDIA_TYPES = [
  { label: '图片', icon: Image },
  { label: '视频', icon: Video },
  { label: '音频', icon: Music2 },
] as const;

/** 画布接收到可用拖拽载荷时的居中落点提示。 */
export function CanvasFileDropOverlay({ isVisible }: { isVisible: boolean }) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 z-[120] flex items-center justify-center overflow-hidden transition-opacity duration-[220ms] ease-[var(--ease-out-quint)] motion-reduce:transition-none ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
      role="status"
      aria-live="polite"
      aria-label="释放文件以添加到画布"
      aria-hidden={!isVisible}
    >
      <div className="relative w-[min(350px,calc(100%-48px))] overflow-hidden rounded-[18px] border border-white/[0.12] bg-[#11151a]/96 px-6 py-5 text-center shadow-[0_18px_48px_rgba(0,0,0,0.42)] backdrop-blur-lg">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-100/38 to-transparent" />

        <div className="relative mx-auto grid size-10 place-items-center rounded-[12px] border border-cyan-100/16 bg-cyan-200/[0.07] text-cyan-100">
          <Upload className="size-5" aria-hidden="true" />
        </div>
        <div className="relative mt-3.5 text-base font-semibold tracking-[-0.01em] text-text-dark">
          释放到画布
        </div>
        <div className="relative mt-1.5 text-xs leading-5 text-text-muted/86">
          将在当前位置自动创建对应节点
        </div>

        <div className="relative mt-3.5 flex items-center justify-center gap-2">
          {MEDIA_TYPES.map(({ label, icon: Icon }) => (
            <span
              key={label}
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 text-[11px] font-medium text-white/62"
            >
              <Icon className="size-3 text-cyan-100/72" aria-hidden="true" />
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
