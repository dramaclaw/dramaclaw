// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useId } from "react";
import { Crosshair, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type { DisplayMode, OutputAspect } from "@/features/previz/domain/scene";
import { PREVIZ_VIEW_DIRECTIONS, type PrevizViewDirection } from "@/features/previz/domain/view";
import { cn } from "@/lib/utils";

/**
 * 计划书把这个类型放在 `engine/gizmo.ts`（TransformControls 接线），但那个模块还没落地，
 * 而 HUD 只是把用户选的模式原样交出去，不需要 three。先在这里定义，等 `engine/gizmo.ts`
 * 建起来后由它 re-export 或反过来 import 这里——总之只保留一份定义。
 */
export type PrevizGizmoMode = "translate" | "rotate" | "scale";

const DISPLAY_MODES: readonly DisplayMode[] = ["solid", "translucent", "clay"];
const GIZMO_MODES: readonly PrevizGizmoMode[] = ["translate", "rotate", "scale"];
const OUTPUT_ASPECTS: readonly OutputAspect[] = ["16:9", "9:16", "1:1", "4:3"];

export interface PrevizViewportHudProps {
  displayMode: DisplayMode;
  outputAspect: OutputAspect;
  gizmoMode: PrevizGizmoMode;
  /** 没有选中对象时「聚焦」无从聚起，禁用而不是点了没反应。 */
  hasSelection: boolean;
  onDisplayMode: (mode: DisplayMode) => void;
  onOutputAspect: (aspect: OutputAspect) => void;
  onGizmoMode: (mode: PrevizGizmoMode) => void;
  onViewDirection: (direction: PrevizViewDirection) => void;
  onFocus: () => void;
  onResetView: () => void;
}

const CHIP = "text-white/70 hover:bg-white/10 hover:text-white";
const CHIP_ON = "bg-white/15 text-white hover:bg-white/20";
const GROUP = "pointer-events-auto flex items-center gap-1 rounded-lg bg-black/50 p-1 backdrop-blur-sm";

/**
 * `disabled:pointer-events-auto` 是故意覆盖 buttonVariants 的 `disabled:pointer-events-none`：
 * 禁用的原因只写在 `title` 里，而 pointer-events: none 的元素不参与命中测试，浏览器不会
 * 派 hover，原生 tooltip 永远弹不出来，用户就只剩一个没有解释的灰按钮。原生 `disabled`
 * 仍然拦得住点击，放开指针事件不引入可点击风险。
 */
const CHIP_DISABLED = "disabled:pointer-events-auto disabled:cursor-not-allowed";

export function PrevizViewportHud({
  displayMode,
  outputAspect,
  gizmoMode,
  hasSelection,
  onDisplayMode,
  onOutputAspect,
  onGizmoMode,
  onViewDirection,
  onFocus,
  onResetView,
}: PrevizViewportHudProps) {
  const { t } = useTranslation();
  const aspectId = useId();

  const focusLabel = t("previz.hud.focus");

  return (
    /*
      外层 pointer-events-none、每个 GROUP 再打开 pointer-events-auto：HUD 是浮在 3D 画布
      上的一整条，若整条都吃指针事件，chip 之间的空档就变成了看不见的挡板，用户在那里
      按下拖拽会绕不动视角。
    */
    <div className="pointer-events-none absolute inset-x-0 top-3 flex flex-wrap items-center justify-center gap-2 px-4">
      <div className={GROUP}>
        {DISPLAY_MODES.map((mode) => (
          <Button
            key={mode}
            type="button"
            variant="ghost"
            size="xs"
            className={cn(CHIP, mode === displayMode && CHIP_ON)}
            aria-pressed={mode === displayMode}
            onClick={() => onDisplayMode(mode)}
          >
            {t(`previz.hud.display.${mode}`)}
          </Button>
        ))}
      </div>

      <div className={GROUP}>
        {PREVIZ_VIEW_DIRECTIONS.map((direction) => (
          <Button
            key={direction}
            type="button"
            variant="ghost"
            size="xs"
            className={CHIP}
            onClick={() => onViewDirection(direction)}
          >
            {t(`previz.hud.view.${direction}`)}
          </Button>
        ))}

        <div className="mx-0.5 h-4 w-px bg-white/15" />

        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(CHIP, CHIP_DISABLED)}
          disabled={!hasSelection}
          aria-label={focusLabel}
          title={hasSelection ? focusLabel : t("previz.hud.focusHint")}
          onClick={onFocus}
        >
          <Crosshair className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={CHIP}
          aria-label={t("previz.hud.resetView")}
          title={t("previz.hud.resetView")}
          onClick={onResetView}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className={GROUP}>
        {GIZMO_MODES.map((mode) => (
          <Button
            key={mode}
            type="button"
            variant="ghost"
            size="xs"
            className={cn(CHIP, mode === gizmoMode && CHIP_ON)}
            aria-pressed={mode === gizmoMode}
            onClick={() => onGizmoMode(mode)}
          >
            {t(`previz.hud.gizmo.${mode}`)}
          </Button>
        ))}
      </div>

      <div className={GROUP}>
        {/*
          无障碍名字只由这个 sr-only <label> 提供，不再额外挂一份 aria-label——两处真相
          改坏其中一处，另一处会把问题遮住。
        */}
        <label className="sr-only" htmlFor={aspectId}>
          {t("previz.hud.outputAspect")}
        </label>
        <select
          id={aspectId}
          className="h-6 rounded-[6px] bg-transparent px-1 text-xs text-white/80 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          value={outputAspect}
          onChange={(event) => onOutputAspect(event.target.value as OutputAspect)}
        >
          {/* 画幅比是符号不是文案，中英两版长得一模一样，走 t() 只会多四个恒等 key。 */}
          {OUTPUT_ASPECTS.map((aspect) => (
            <option key={aspect} value={aspect} className="text-black">
              {aspect}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
