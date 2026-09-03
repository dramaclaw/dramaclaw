// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from 'react-i18next';
import { Image, Music2, Upload, Video } from 'lucide-react';

const MEDIA_TYPES = [
  { key: 'image', labelKey: 'canvas.assetLibrary.media.image', icon: Image },
  { key: 'video', labelKey: 'canvas.assetLibrary.media.video', icon: Video },
  { key: 'audio', labelKey: 'canvas.assetLibrary.media.audio', icon: Music2 },
] as const;

/**
 * 画布接收到可用拖拽载荷时的居中落点提示。
 *
 * 为了做淡入淡出，本组件常驻挂载、只切透明度——但卡片带 `backdrop-blur-lg` 和大
 * 面积投影，而它是 `.dc-canvas` 的直接子节点，**不在** `.react-flow__viewport` 里，
 * 所以 LOD 那两条降级规则（`.dc-canvas--panning/-low-detail .react-flow__viewport *`
 * 关 backdrop-filter/box-shadow，见 index.css「画布 LOD」段）一条都命中不了它。
 * 单靠 `opacity: 0` 不保证浏览器跳过绘制：backdrop-filter 会强制建独立合成层，
 * 每帧重采样背景的成本可能照付，正好是 #241 实测里最贵的那一项。
 *
 * 因此隐藏态额外挂 `visibility: hidden` —— 该状态下元素完全不参与绘制，合成层
 * 不成立。visibility 的插值规则天然配合淡出：hidden→visible 立刻生效（淡入正常
 * 起步），visible→hidden 要等整段 transition 结束才翻转（淡出不会被截断）。
 */
export function CanvasFileDropOverlay({ isVisible }: { isVisible: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      className={`pointer-events-none absolute inset-0 z-[120] flex items-center justify-center overflow-hidden transition-[opacity,visibility] duration-[220ms] ease-[var(--ease-out-quint)] motion-reduce:transition-none ${
        isVisible ? 'visible opacity-100' : 'invisible opacity-0'
      }`}
      role="status"
      aria-live="polite"
      aria-label={t('canvas.fileDrop.aria')}
      aria-hidden={!isVisible}
    >
      <div className="relative w-[min(350px,calc(100%-48px))] overflow-hidden rounded-[18px] border border-white/[0.12] bg-[#11151a]/96 px-6 py-5 text-center shadow-[0_18px_48px_rgba(0,0,0,0.42)] backdrop-blur-lg">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-100/38 to-transparent" />

        <div className="relative mx-auto grid size-10 place-items-center rounded-[12px] border border-cyan-100/16 bg-cyan-200/[0.07] text-cyan-100">
          <Upload className="size-5" aria-hidden="true" />
        </div>
        <div className="relative mt-3.5 text-base font-semibold tracking-[-0.01em] text-text-dark">
          {t('canvas.fileDrop.title')}
        </div>
        <div className="relative mt-1.5 text-xs leading-5 text-text-muted/86">
          {t('canvas.fileDrop.hint')}
        </div>

        <div className="relative mt-3.5 flex items-center justify-center gap-2">
          {MEDIA_TYPES.map(({ key, labelKey, icon: Icon }) => (
            <span
              key={key}
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 text-[11px] font-medium text-white/62"
            >
              <Icon className="size-3 text-cyan-100/72" aria-hidden="true" />
              {t(labelKey)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
