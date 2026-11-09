// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

/** `chunk`：编辑器代码块（含 three）在下载；`assets`：编辑器已挂上，在等人物 / 物件模型。 */
export type PrevizBootPhase = "chunk" | "assets";

/**
 * 入场遮罩最多盖多久。到点就撤，放用户进去先看占位胶囊：一次网络卡死不该把人关在
 * 转圈里，而编辑器在模型到齐之前本来就可用（能摆位、能画轨迹），模型到了会自己换进来。
 */
export const PREVIZ_BOOT_TIMEOUT_MS = 20_000;

/** 撤场淡出的时长，与下面的 `duration-200` 对齐。 */
const FADE_OUT_MS = 200;

interface PrevizBootOverlayProps {
  /** `null` = 不盖（或已就绪）；从有值变成 `null` 时先淡出再卸载。 */
  phase: PrevizBootPhase | null;
}

/**
 * 打开预演台时的全屏遮罩。
 *
 * 由画布节点渲染而不是编辑器：它要盖住的第一段等待正是编辑器这个懒加载模块在下载。
 * 走 portal 挂到 body 上——节点在 React Flow 带 transform 的容器里，`fixed` 在那里面
 * 是相对画布定位的，盖不住整屏。
 */
export function PrevizBootOverlay({ phase }: PrevizBootOverlayProps) {
  const { t } = useTranslation();
  // 淡出那 200ms 里 `phase` 已经是 null，文案要停在最后一个阶段上，不能闪成原始 key。
  const [shown, setShown] = useState(phase);
  if (phase !== null && phase !== shown) setShown(phase);

  useEffect(() => {
    if (phase !== null) return undefined;
    const timer = window.setTimeout(() => setShown(null), FADE_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  if (shown === null) return null;
  const leaving = phase === null;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      aria-label={t("previz.boot.title")}
      // 淡出期间对读屏器已经不存在：遮罩在语义上撤掉了，只是视觉上还有 200ms 的尾巴。
      aria-hidden={leaving || undefined}
      data-testid="previz-boot-overlay"
      data-state={leaving ? "closed" : "open"}
      // z-60：压过编辑器 Dialog（z-50），但低于 sonner 的 toast——超时那条提示要看得见。
      className={`previz-boot-overlay fixed inset-0 z-[60] flex items-center justify-center bg-[#101216] transition-opacity duration-200 ${
        leaving ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      <div className="flex flex-col items-center gap-6 px-6 text-center">
        {/* 取景框：四个角标加一道来回扫的线，和监看画幅框是同一套视觉语言。 */}
        <div aria-hidden="true" className="relative h-[72px] w-[128px]">
          <span className="absolute left-0 top-0 h-3.5 w-3.5 rounded-tl-[3px] border-l-2 border-t-2 border-white/70" />
          <span className="absolute right-0 top-0 h-3.5 w-3.5 rounded-tr-[3px] border-r-2 border-t-2 border-white/70" />
          <span className="absolute bottom-0 left-0 h-3.5 w-3.5 rounded-bl-[3px] border-b-2 border-l-2 border-white/70" />
          <span className="absolute bottom-0 right-0 h-3.5 w-3.5 rounded-br-[3px] border-b-2 border-r-2 border-white/70" />
          <span className="previz-boot-scan absolute inset-x-3 top-1.5 h-px bg-gradient-to-r from-transparent via-white/80 to-transparent" />
          <span className="previz-boot-rec absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500" />
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="text-[14px] font-medium text-white/90">{t("previz.boot.title")}</p>
          <p className="text-[12px] text-white/50">{t(`previz.boot.${shown}`)}</p>
        </div>

        {/* 不给百分比：GLB 的 onProgress 在多数 CDN 上拿不到总长，假进度条比没有更糟。 */}
        <div aria-hidden="true" className="h-[2px] w-40 overflow-hidden rounded-full bg-white/10">
          <div className="previz-boot-bar h-full w-1/3 rounded-full bg-white/70" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
