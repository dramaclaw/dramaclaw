// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useId, type ReactNode } from "react";
import { Crosshair, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type { DisplayMode, OutputAspect } from "@/features/previz/domain/scene";
import { PREVIZ_VIEW_DIRECTIONS, type PrevizViewDirection } from "@/features/previz/domain/view";
import { cn } from "@/lib/utils";

/**
 * **临时定义，`GizmoMode` 落进 `domain/scene.ts` 时必须整块删掉**，把下面四个使用点
 * （`GIZMO_MODES` 的类型参数、props 里的 `gizmoMode` 与 `onGizmoMode`）改成 import。
 *
 * 计划书让这个类型从 `engine/gizmo.ts` 来，但那个模块还没落地，而 HUD 只是把用户选的
 * 模式原样交出去、不需要 three。这里刻意**不导出**：结构相同的两个联合类型互相可赋值，
 * 真身建起来之后这份副本继续留着也**一个编译错误都不会有**，而 `Record<PrevizGizmoMode, true>`
 * 的穷尽性守卫会安安静静地守着这份过时的定义——给手柄加第四种模式时真身那边全绿、
 * HUD 这边静默少一个按钮。不导出至少保证它长不出第二个消费者，删除永远是单文件改动。
 * 外部要引用这几个 prop 的类型，走 `PrevizViewportHudProps["gizmoMode"]`。
 */
type PrevizGizmoMode = "translate" | "rotate" | "scale";

/**
 * Record 而不是数组字面量：漏写或写错一个成员在这里编译期就报错，不会静默少一个 chip。
 * `Object.keys` 对非整数字符串键保持字面量的书写顺序，所以左边的顺序就是屏幕上的顺序。
 * （`domain/scene.ts` 的校验表用的是同一套 `Record<T, true>` 写法。）
 */
function inOrder<T extends string>(members: Record<T, true>): readonly T[] {
  return Object.keys(members) as T[];
}

const DISPLAY_MODES = inOrder<DisplayMode>({ solid: true, translucent: true, clay: true });
const GIZMO_MODES = inOrder<PrevizGizmoMode>({ translate: true, rotate: true, scale: true });
const OUTPUT_ASPECTS = inOrder<OutputAspect>({
  "16:9": true,
  "9:16": true,
  "1:1": true,
  "4:3": true,
});

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
 * 每一组都要有名字：HUD 是浮在画布上的一条散装控件，读屏顺着读下来是「实体 半透 粘土
 * 前 后 左 右 上 下 聚焦 重置 移动 旋转 缩放」——十四个按钮连成一串，"缩放" 到底是手柄
 * 模式还是画幅缩放全靠猜。`role="group"` + 名字把这四段分开，与 `PrevizLayerPanel` 里
 * 按对象类型分组的做法同源。
 *
 * 写成组件而不是在四个 `<div>` 上各挂一遍 `role` / `aria-label`：漏挂一处没有任何编译期
 * 或运行期信号，只有读屏用户会撞上，而这正是最不可能有人手测的那条路径。
 */
function HudGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className={GROUP}>
      {children}
    </div>
  );
}

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
      <HudGroup label={t("previz.hud.group.display")}>
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
      </HudGroup>

      <HudGroup label={t("previz.hud.group.view")}>
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
      </HudGroup>

      <HudGroup label={t("previz.hud.group.gizmo")}>
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
      </HudGroup>

      <HudGroup label={t("previz.hud.group.aspect")}>
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
      </HudGroup>
    </div>
  );
}
