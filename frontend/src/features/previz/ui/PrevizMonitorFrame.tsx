// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useId } from "react";
import { Maximize2, Minimize2, Square, Tag, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { MonitorRect, MonitorSize } from "@/features/previz/engine/cameraRig";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { OutputAspect, PrevizCamera } from "@/features/previz/domain/scene";
import { PrevizHoverTip } from "@/features/previz/ui/PrevizHoverTip";
import { cn } from "@/lib/utils";

/** 画幅比是符号不是文案，中英两版长得一模一样，走 t() 只会多四个恒等 key。 */
const OUTPUT_ASPECTS: readonly OutputAspect[] = ["16:9", "9:16", "1:1", "4:3"];

export interface PrevizMonitorFrameProps {
  /** 监看画面在画布里的矩形，**原点在左下角**（与 WebGL 视口同一份计算）。 */
  rect: MonitorRect;
  camera: PrevizCamera;
  outputAspect: OutputAspect;
  size: MonitorSize;
  showOutline: boolean;
  showNamePlate: boolean;
  onOutputAspect: (aspect: OutputAspect) => void;
  onSize: (size: MonitorSize) => void;
  onShowOutline: (show: boolean) => void;
  onShowNamePlate: (show: boolean) => void;
  onClose: () => void;
}

const CHIP =
  "grid h-6 w-6 place-items-center rounded text-white/70 transition hover:bg-white/20 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none";
const CHIP_ON = "bg-white/25 text-white";

/**
 * 监看画中画的外框与控件。
 *
 * 画面本身是 WebGL 的第二趟 pass（见 `PrevizRenderer.renderMonitor`），这里只是浮在它
 * 上面的一层 DOM。位置直接吃渲染器同一个 `monitorViewportRect`：自己按比例拼一遍 CSS
 * 也能对上大多数情况，但竖幅画幅在矮画布上会走「改按高度回推宽度」那条分支，两套算法
 * 立刻错开，控件飘到画面外。`bottom` 而不是 `top`，因为那个 rect 的 y 是从底边量起的。
 *
 * 外层 `pointer-events-none`：整块框浮在 3D 画布上，若它吃指针事件，画面上这一片就成了
 * 看不见的挡板，在监看上按下拖拽会绕不动视角。只有控件那一簇打开指针事件。
 */
export function PrevizMonitorFrame({
  rect,
  camera,
  outputAspect,
  size,
  showOutline,
  showNamePlate,
  onOutputAspect,
  onSize,
  onShowOutline,
  onShowNamePlate,
  onClose,
}: PrevizMonitorFrameProps) {
  const { t } = useTranslation();
  const aspectId = useId();

  const enlarged = size === "large";
  const sizeLabel = t(enlarged ? "previz.monitor.restore" : "previz.monitor.enlarge");

  return (
    <div
      data-testid="previz-monitor-frame"
      className="pointer-events-none absolute rounded-sm ring-1 ring-white/15"
      style={{ left: rect.x, bottom: rect.y, width: rect.width, height: rect.height }}
    >
      {/*
        提示一律弹在上方：这排开关贴着画中画的右上角，往下弹会盖住监看画面本身——
        而用户来按这排开关，看的就是那块画面。
      */}
      <TooltipProvider delay={120}>
        <div className="pointer-events-auto absolute right-1 top-1 flex items-center gap-0.5 rounded-md bg-black/60 px-1 py-0.5 backdrop-blur-sm">
          <PrevizHoverTip label={t("previz.monitor.aspect")}>
            <span className="inline-flex">
              {/*
                无障碍名字只由这个 sr-only <label> 提供，不再额外挂一份 aria-label——两处真相
                改坏其中一处，另一处会把问题遮住。
              */}
              <label className="sr-only" htmlFor={aspectId}>
                {t("previz.monitor.aspect")}
              </label>
              <select
                id={aspectId}
                className="h-6 rounded bg-transparent px-0.5 text-[11px] text-white/80 outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                value={outputAspect}
                onChange={(event) => onOutputAspect(event.target.value as OutputAspect)}
              >
                {OUTPUT_ASPECTS.map((aspect) => (
                  <option key={aspect} value={aspect} className="text-black">
                    {aspect}
                  </option>
                ))}
              </select>
            </span>
          </PrevizHoverTip>

          <div className="mx-0.5 h-4 w-px bg-white/20" />

          <PrevizHoverTip label={t("previz.monitor.outline")}>
            <button
              type="button"
              data-testid="previz-monitor-outline"
              aria-pressed={showOutline}
              aria-label={t("previz.monitor.outline")}
              className={cn(CHIP, showOutline && CHIP_ON)}
              onClick={() => onShowOutline(!showOutline)}
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          </PrevizHoverTip>
          <PrevizHoverTip label={t("previz.monitor.namePlate")}>
            <button
              type="button"
              data-testid="previz-monitor-plate"
              aria-pressed={showNamePlate}
              aria-label={t("previz.monitor.namePlate")}
              className={cn(CHIP, showNamePlate && CHIP_ON)}
              onClick={() => onShowNamePlate(!showNamePlate)}
            >
              <Tag className="h-3.5 w-3.5" />
            </button>
          </PrevizHoverTip>

          <div className="mx-0.5 h-4 w-px bg-white/20" />

          <PrevizHoverTip label={sizeLabel}>
            <button
              type="button"
              data-testid="previz-monitor-size"
              aria-pressed={enlarged}
              aria-label={sizeLabel}
              className={CHIP}
              onClick={() => onSize(enlarged ? "normal" : "large")}
            >
              {enlarged ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </button>
          </PrevizHoverTip>
          <PrevizHoverTip label={t("previz.editor.hideMonitor")}>
            <button
              type="button"
              data-testid="previz-monitor-hide"
              aria-label={t("previz.editor.hideMonitor")}
              className={CHIP}
              onClick={onClose}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </PrevizHoverTip>
        </div>
      </TooltipProvider>

      {/*
        机位名 · 焦距 · 传感器。三样都是「这一格是谁拍的」的必要信息：同一场戏里两台
        50mm 只差在画幅上，只写机位名分不出来。
      */}
      <div className="absolute inset-x-1 bottom-1 truncate rounded bg-black/55 px-1.5 py-0.5 text-[11px] text-white/80">
        {t("previz.monitor.caption", {
          name: camera.name,
          focal: Math.round(camera.focalMm),
          sensor: t(`previz.inspector.sensors.${camera.sensor}`),
        })}
      </div>
    </div>
  );
}
