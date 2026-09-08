// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { type ComponentProps } from "react";
import {
  Blend,
  Crosshair,
  Cuboid,
  Grid2x2,
  Redo2,
  RotateCcw,
  Shapes,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DisplayMode } from "@/features/previz/domain/scene";
import type { PrevizViewDirection } from "@/features/previz/domain/view";
import { PrevizAxisGizmo, type PrevizViewSource } from "@/features/previz/ui/PrevizAxisGizmo";
import { PrevizHoverTip } from "@/features/previz/ui/PrevizHoverTip";
import { PrevizKeyCap } from "@/features/previz/ui/PrevizKeyCap";
import { cn } from "@/lib/utils";

const DISPLAY_ICON: Record<DisplayMode, LucideIcon> = {
  solid: Cuboid,
  translucent: Blend,
  clay: Shapes,
};

/**
 * `Object.keys` 对非整数字符串键保持书写顺序，所以键序就是按钮从左到右的顺序。写成
 * `Record` 而不是数组字面量：新增一种显示模式时这里编译期报错，不会静默少一颗按钮。
 */
const DISPLAY_MODES = Object.keys(DISPLAY_ICON) as DisplayMode[];

export interface PrevizViewportControlsProps {
  canUndo: boolean;
  canRedo: boolean;
  displayMode: DisplayMode;
  /** 画笔一笔画出来每隔多少米落一个轨迹点。 */
  pathSpacingM: number;
  /** 画笔按多快的速度走，米/秒。决定一笔画出来的片段在时间轴上占多长。 */
  pathSpeedMps: number;
  /** 左上角那颗坐标轴小球跟着的视角。见 [PrevizViewSource]。 */
  view: PrevizViewSource;
  /** 没有选中对象时「聚焦」无从聚起，禁用而不是点了没反应。 */
  hasSelection: boolean;
  /** 四视图（右侧那两块俯视 / 侧视预览）是否开着。 */
  quadView: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDisplayMode: (mode: DisplayMode) => void;
  onResetView: () => void;
  onPathSpacing: (metres: number) => void;
  onPathSpeed: (metresPerSecond: number) => void;
  onViewDirection: (direction: PrevizViewDirection) => void;
  onFocus: () => void;
  onQuadView: (open: boolean) => void;
}

/** 半透明底 + 毛玻璃：底下是三维视口，不铺底的话图标压在浅色模型上就看不见了。 */
const CLUSTER =
  "pointer-events-auto flex items-center gap-0.5 rounded-lg border border-white/10 bg-black/55 p-1 backdrop-blur-sm";

const ITEM = cn(
  // `relative` 放进基础类而不是按有没有 `shortcut` 现加：没有绝对定位子元素时它是个
  // 空操作，加一条条件反而多一处要跟 `shortcut` 保持同步的地方。
  "relative h-7 w-7 text-white/80 hover:bg-white/10 hover:text-white",
  // 禁用的原因只写在提示里，而 pointer-events: none 的元素连 hover 都收不到，用户就只
  // 剩一个没有解释的灰按钮。原生 `disabled` 仍然拦住点击，放开指针事件是安全的。
  "disabled:pointer-events-auto disabled:cursor-not-allowed",
);

const ITEM_ON = "bg-white/15 text-white hover:bg-white/20";

/**
 * 带文字的浮层按钮。「聚焦」「四视图」不给图标配文字的话，两颗方块图标谁是谁只能点开
 * 试——而这两颗一颗会搬相机、一颗会改右侧面板，试错的代价都不小。
 */
const TEXT_ITEM = cn(
  "h-7 w-full justify-start gap-1.5 px-2 text-[11px] font-normal",
  "text-white/80 hover:bg-white/10 hover:text-white",
  "disabled:pointer-events-auto disabled:cursor-not-allowed",
);

/**
 * 绘制那一簇里的数字输入框（间距、速度）：跟同簇的按钮同高（28px），圆角比按钮再收
 * 一档，免得这么小一块看着像颗胶囊。
 *
 * 上下箭头收掉。默认的 spinner 在 28px 高、深色半透的浮层上就是两个糊掉的小三角，宽度
 * 还被它吃掉一半；步进本来就在（聚焦后 ↑↓ 按 step 走），只是不再画出来。
 */
const DRAW_FIELD = cn(
  "h-7 w-14 rounded-sm border-white/15 bg-white/10 px-1.5 text-center text-[11px] text-white/90",
  "md:text-[11px] dark:bg-white/10 dark:hover:bg-white/15",
  "focus-visible:border-white/40 focus-visible:ring-2 focus-visible:ring-white/30",
  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
);

/** 一颗浮层按钮：图标 + 弹在下方的悬停提示（见 [PrevizHoverTip]）。 */
function ControlButton({
  icon: Icon,
  label,
  on,
  shortcut,
  ...props
}: {
  icon: LucideIcon;
  label: string;
  on?: boolean;
  /** 快捷键字母；给了就在右上角画一个小键帽，并写进 aria-keyshortcuts。 */
  shortcut?: string;
} & ComponentProps<typeof Button>) {
  return (
    <PrevizHoverTip label={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(ITEM, on && ITEM_ON)}
        aria-label={label}
        aria-keyshortcuts={shortcut}
        {...props}
      >
        <Icon className="h-4 w-4" />
        {shortcut && <PrevizKeyCap className="absolute -right-1 -top-1">{shortcut}</PrevizKeyCap>}
      </Button>
    </PrevizHoverTip>
  );
}

/**
 * 浮在视口自己两个上角的一组控件：左上角撤销/重做，右上角显示模式与重置视角。
 *
 * 这几样原先挂在左侧菜单列上。挪出来是因为它们和栏上那些不是一类动作：建对象、选工具
 * 是「去拿一件工具」，眼睛本来就要离开画面；而撤销和显示模式是「对着画面调画面」——
 * 按下去要立刻看画面变成什么样。放在 56px 宽的栏子最下面，等于每调一次都要把视线从
 * 构图上拽到左边角落再拽回来。贴着视口的角就没有这个来回。
 *
 * 左右分家也是按这个分的：撤销重做是编辑历史，跟着 Ctrl+Z 的肌肉记忆待在左上，坐标轴
 * 小球与聚焦 / 四视图接在它下面（这三样是「站到哪儿看」）；显示模式、重置视角与轨迹点
 * 间距是「怎么看这幅画面、往里画什么」，待在右上，与下方的监看画中画同一侧。
 */
export function PrevizViewportControls({
  canUndo,
  canRedo,
  displayMode,
  pathSpacingM,
  pathSpeedMps,
  view,
  hasSelection,
  quadView,
  onUndo,
  onRedo,
  onDisplayMode,
  onResetView,
  onPathSpacing,
  onPathSpeed,
  onViewDirection,
  onFocus,
  onQuadView,
}: PrevizViewportControlsProps) {
  const { t } = useTranslation();
  const spacingLabel = t("previz.viewport.pathSpacing");
  const speedLabel = t("previz.viewport.pathSpeed");
  const focusLabel = t("previz.viewport.focus");
  const quadLabel = t("previz.viewport.quadView");

  return (
    <TooltipProvider delay={120}>
      {/*
        左上与右上各自定位，中间那段画面不铺任何东西：外面套一个横跨整条顶边的容器的话，
        那条透明带会把视口顶部的拾取与轨迹绘制全吃掉。
      */}
      <div
        role="group"
        aria-label={t("previz.viewport.group.history")}
        className={cn(CLUSTER, "absolute left-4 top-4 z-20")}
      >
        <ControlButton
          icon={Undo2}
          label={t("previz.viewport.undo")}
          disabled={!canUndo}
          onClick={onUndo}
        />
        <ControlButton
          icon={Redo2}
          label={t("previz.viewport.redo")}
          disabled={!canRedo}
          onClick={onRedo}
        />
      </div>

      {/*
        坐标轴小球与它下面那两颗按钮，跟撤销重做叠成左侧一列。

        这三样原先在左侧菜单列上（一层「正交视角」浮层 + 一颗聚焦）。搬过来是因为它们
        全是「先看画面、再决定按哪一下」：小球本身就在报告当前朝向，看着它才知道该点哪
        一颗；聚焦要先在画面里选中对象。放回 56px 宽的栏子里，那六个方向只能收进浮层，
        点开还会盖住刚要看的那块画面。

        外面这层不吃指针事件、宽度只到内容为止：绝对定位的容器铺开一片透明区，视口的
        拾取与轨迹绘制就在这一片里失灵。
      */}
      <div className="pointer-events-none absolute left-4 top-16 z-20 flex w-24 flex-col items-start gap-2">
        <div
          role="group"
          aria-label={t("previz.viewport.group.axis")}
          className={cn(CLUSTER, "justify-center p-1.5")}
        >
          <PrevizAxisGizmo view={view} onViewDirection={onViewDirection} />
        </div>

        <div
          role="group"
          aria-label={t("previz.viewport.group.view")}
          className={cn(CLUSTER, "w-full flex-col items-stretch")}
        >
          <PrevizHoverTip
            label={hasSelection ? focusLabel : t("previz.viewport.focusHint")}
            side="right"
          >
            <Button
              type="button"
              variant="ghost"
              className={TEXT_ITEM}
              disabled={!hasSelection}
              aria-keyshortcuts="F"
              onClick={onFocus}
            >
              <Crosshair className="h-3.5 w-3.5" />
              {focusLabel}
              <PrevizKeyCap className="ml-0.5">F</PrevizKeyCap>
            </Button>
          </PrevizHoverTip>

          <PrevizHoverTip label={quadLabel} side="right">
            <Button
              type="button"
              variant="ghost"
              className={cn(TEXT_ITEM, quadView && ITEM_ON)}
              aria-pressed={quadView}
              onClick={() => onQuadView(!quadView)}
            >
              <Grid2x2 className="h-3.5 w-3.5" />
              {quadLabel}
            </Button>
          </PrevizHoverTip>
        </div>
      </div>

      {/*
        顶上那条留给关闭键（右）与录制/截帧（左），这两簇往下让一格，不去挤它们。录制
        选单也是横着从录制键右边展开、留在同一条带子里，就是为了别落到这两簇头上。

        外面这层只是把两簇排成一行，自己不吃指针事件也不铺满顶边：绝对定位的 flex 容器
        宽度只到内容为止，加上 `pointer-events-none`，两簇之间与右侧那片画面照样能拾取
        和画轨迹。
      */}
      <div className="pointer-events-none absolute right-4 top-16 z-20 flex items-center gap-2">
        {/*
          间距与速度决定一笔画出来落几个轨迹点、这一笔在时间轴上占多久，所以它们跟着
          落点走，摆在画面这一侧而不是左栏：两者都得跟着场景尺度改（室内走位 0.3 米
          一个点、慢慢走，外景赶路 2 米一个点、走得快），而「够不够密」「快不快」
          只有看着画面里那串点才判断得出来。
        */}
        <div role="group" aria-label={t("previz.viewport.group.draw")} className={CLUSTER}>
          <PrevizHoverTip label={spacingLabel} side="bottom">
            <label className="flex items-center gap-1 pr-1 text-[11px] text-white/55">
              <span className="sr-only">{spacingLabel}</span>
              <Input
                type="number"
                aria-label={spacingLabel}
                className={DRAW_FIELD}
                min={0.05}
                max={5}
                step={0.05}
                // 上层没接受这次改动时（超界被夹回去）要退回 prop：受控写法会在每次
                // 按键都回写，输到一半的 "0." 当场被抹平，根本打不出 0.3。
                key={pathSpacingM}
                defaultValue={pathSpacingM}
                onBlur={(event) => onPathSpacing(Number(event.target.value))}
              />
              m
            </label>
          </PrevizHoverTip>

          <PrevizHoverTip label={speedLabel} side="bottom">
            <label className="flex items-center gap-1 pr-1 text-[11px] text-white/55">
              <span className="sr-only">{speedLabel}</span>
              <Input
                type="number"
                aria-label={speedLabel}
                className={DRAW_FIELD}
                min={0.1}
                max={20}
                step={0.1}
                key={pathSpeedMps}
                defaultValue={pathSpeedMps}
                onBlur={(event) => onPathSpeed(Number(event.target.value))}
              />
              m/s
            </label>
          </PrevizHoverTip>
        </div>

        <div role="group" aria-label={t("previz.viewport.group.display")} className={CLUSTER}>
          {DISPLAY_MODES.map((mode) => (
            <ControlButton
              key={mode}
              icon={DISPLAY_ICON[mode]}
              label={t(`previz.viewport.display.${mode}`)}
              on={mode === displayMode}
              aria-pressed={mode === displayMode}
              onClick={() => onDisplayMode(mode)}
            />
          ))}

          <div className="mx-0.5 h-5 w-px bg-white/15" />

          <ControlButton
            icon={RotateCcw}
            label={t("previz.viewport.resetView")}
            shortcut="H"
            onClick={onResetView}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}
