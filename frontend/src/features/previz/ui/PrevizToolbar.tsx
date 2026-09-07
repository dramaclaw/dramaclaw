// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useId, type ComponentProps, type ReactNode } from "react";
import {
  Box,
  Camera,
  Lightbulb,
  Move3d,
  MousePointer2,
  Orbit,
  PanelBottomClose,
  PanelBottomOpen,
  PenLine,
  Rotate3d,
  Scaling,
  Upload,
  User,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button, buttonVariants } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PREVIZ_OBJECT_LIMITS } from "@/features/previz/domain/limits";
import type { PrevizObjectKind } from "@/features/previz/domain/scene";
import { PrevizHoverTip } from "@/features/previz/ui/PrevizHoverTip";
import { PrevizKeyCap } from "@/features/previz/ui/PrevizKeyCap";
import { cn } from "@/lib/utils";

/**
 * **临时定义，`GizmoMode` 落进 `domain/scene.ts` 时必须整块删掉**，把下面两个使用点
 * （`GIZMO_ICON` 的类型参数、props 里的 `gizmoMode` 与 `onGizmoMode`）改成 import。
 *
 * 计划书让这个类型从 `engine/gizmo.ts` 来，但那个模块还没落地，而工具栏只是把用户选的
 * 模式原样交出去、不需要 three。这里刻意**不导出**：结构相同的两个联合类型互相可赋值，
 * 真身建起来之后这份副本继续留着也**一个编译错误都不会有**，而下面 `Record<…, LucideIcon>`
 * 的穷尽性守卫会安安静静地守着这份过时的定义——给手柄加第四种模式时真身那边全绿、
 * 工具栏这边静默少一个按钮。不导出至少保证它长不出第二个消费者，删除永远是单文件改动。
 * 外部要引用这几个 prop 的类型，走 `PrevizToolbarProps["gizmoMode"]`。
 */
type PrevizGizmoMode = "translate" | "rotate" | "scale";

/**
 * 视口里的鼠标工具。选择是默认；导航模式下左键拖拽只环绕视口，点击不改选中（给没有
 * 中键的触控板用）；绘制是按住左键在地面上拖出一条轨迹。
 */
export const PREVIZ_TOOLS = ["select", "navigate", "draw"] as const;
export type PrevizTool = (typeof PREVIZ_TOOLS)[number];

/**
 * 三张 Record 而不是数组字面量：新增一种取值时这里编译期报错，不会静默塌成一个通用
 * 图标、或者干脆少一个按钮。`Object.keys` 对非整数字符串键保持书写顺序，所以键序就是
 * 按钮从上到下的顺序。
 */
const KIND_ICON: Record<PrevizObjectKind, LucideIcon> = {
  character: User,
  camera: Camera,
  light: Lightbulb,
  prop: Box,
};

const TOOL_ICON: Record<PrevizTool, LucideIcon> = {
  select: MousePointer2,
  navigate: Orbit,
  draw: PenLine,
};

const GIZMO_ICON: Record<PrevizGizmoMode, LucideIcon> = {
  translate: Move3d,
  rotate: Rotate3d,
  scale: Scaling,
};

/**
 * 工具与手柄的快捷键，画成按钮角上的小键帽。键位本身在 PrevizEditor 的 keydown 里绑定；
 * 这里只负责把它显示出来——没有角标的话用户根本不知道有快捷键。
 *
 * 写成 `Record<PrevizTool, string | undefined>` 而不是 `Partial<...>`：新增第四种工具
 * 时少写一行会在这里编译期报错，而不是悄悄漏掉一个角标（同 `TOOL_ICON` 那份注释）。
 */
const TOOL_KEY: Record<PrevizTool, string | undefined> = {
  select: "W",
  navigate: "Q",
  draw: undefined, // 绘制没有键位
};
const GIZMO_KEY: Record<PrevizGizmoMode, string> = { translate: "G", rotate: "R", scale: "S" };

function inOrder<T extends string>(icons: Record<T, LucideIcon>): readonly T[] {
  return Object.keys(icons) as T[];
}

const KINDS = inOrder(KIND_ICON);
const TOOLS = inOrder(TOOL_ICON);
const GIZMO_MODES = inOrder(GIZMO_ICON);


export interface PrevizToolbarProps {
  /** 每种对象是否还能再加（数量上限）。false 时按钮禁用而不是点了没反应。 */
  canAdd: Record<PrevizObjectKind, boolean>;
  gizmoMode: PrevizGizmoMode;
  tool: PrevizTool;
  timelineOpen: boolean;
  onAdd: (kind: PrevizObjectKind) => void;
  onImportProp: (file: File) => void;
  onGizmoMode: (mode: PrevizGizmoMode) => void;
  onTool: (tool: PrevizTool) => void;
  onTimelineOpen: (open: boolean) => void;
}

const RAIL_ITEM = "text-white/80 hover:bg-white/10 hover:text-white";
const RAIL_ON = "bg-white/15 text-white hover:bg-white/20";

/**
 * `disabled:pointer-events-auto` 是故意覆盖 buttonVariants 的 `disabled:pointer-events-none`：
 * 禁用的原因只写在提示里，而 pointer-events: none 的元素连 hover 都收不到，用户就只剩
 * 一个没有解释的灰按钮。原生 `disabled` 仍然拦住点击，放开指针事件是安全的。
 *
 * `relative` 放进基础类而不是按有没有 `shortcut` 现加：没有绝对定位子元素时它是个空操作，
 * 加一条条件反而多一处要跟 `shortcut` 保持同步的地方。
 */
const RAIL_BUTTON = cn(
  RAIL_ITEM,
  "relative disabled:pointer-events-auto disabled:cursor-not-allowed",
);

/** 竖栏上的一颗按钮：图标 + 弹在右侧的悬停提示（见 [PrevizHoverTip]）。 */
function RailButton({
  icon: Icon,
  label,
  tip,
  on,
  shortcut,
  className,
  ...props
}: {
  icon: LucideIcon;
  /** 无障碍名字，同时是默认提示文案。 */
  label: string;
  /** 提示文案；只在与无障碍名字不同（比如解释禁用原因）时才给。 */
  tip?: string;
  /** 当前是否是选中态。 */
  on?: boolean;
  /** 快捷键字母；给了就在右上角画一个小键帽，并写进 aria-keyshortcuts。 */
  shortcut?: string;
} & ComponentProps<typeof Button>) {
  return (
    <PrevizHoverTip label={tip ?? label} side="right">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(RAIL_BUTTON, on && RAIL_ON, className)}
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
 * 每一段都要有名字：这条竖栏是一串纯图标按钮，读屏顺着读下来是「添加人物 添加机位 …
 * 选择 绘制轨迹 移动 旋转 缩放 …」——十几个按钮连成一条，「缩放」到底是
 * 手柄模式还是画面缩放全靠猜。`role="group"` + 名字把它切成几段，与 `PrevizLayerPanel`
 * 里按对象类型分组的做法同源。
 *
 * 写成组件而不是在每个 `<div>` 上各挂一遍 `role` / `aria-label`：漏挂一处没有任何编译期
 * 或运行期信号，只有读屏用户会撞上，而这正是最不可能有人手测的那条路径。
 */
function RailGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col items-center gap-1">
      {children}
    </div>
  );
}

function RailDivider() {
  return <div className="my-1 h-px w-8 shrink-0 bg-white/10" />;
}

/**
 * 编辑器的左侧菜单列：建对象、鼠标工具、手柄，最后是收起/展开轨迹面板。
 *
 * 这条栏只收「摆场景用的工具」。撤销重做、显示模式、重置视角不在这里——那三样是
 * 「对着画面调画面」的动作，手和眼都在视口里，跑到左边角落去按一下再跑回来看效果，
 * 一个来回就断一次注意力；它们浮在视口自己那一角（`PrevizViewportControls`）。出片
 * 画幅同理，归在监看画中画上（`PrevizMonitorFrame`）：改画幅要看的就是那块画面被裁
 * 成什么样，在这里改等于盲调。轨迹点间距也跟着画笔的落点走，去了视口右上角。切视角
 * 与聚焦同样搬走了：它们现在是视口左上角那颗坐标轴球的两个邻居，按哪个轴、往哪聚焦
 * 都得看着画面里的朝向定。
 *
 * 中间那段可以纵向滚动，轨迹面板开关钉在最底下不跟着滚：栏子被挤矮时最先滚出视野的
 * 是最下面那一项，而那一项恰恰是唯一一个「用来腾地方」的开关——它自己被挤没了，用户
 * 就再也腾不出地方来。
 */
export function PrevizToolbar({
  canAdd,
  gizmoMode,
  tool,
  timelineOpen,
  onAdd,
  onImportProp,
  onGizmoMode,
  onTool,
  onTimelineOpen,
}: PrevizToolbarProps) {
  const { t } = useTranslation();
  const fileInputId = useId();

  const timelineLabel = t(
    timelineOpen ? "previz.toolbar.collapseTimeline" : "previz.toolbar.expandTimeline",
  );

  return (
    <TooltipProvider delay={120}>
      <div className="flex w-14 shrink-0 flex-col items-center border-r border-white/10 bg-black/30 py-3">
        {/*
          `self-stretch`：角标探出按钮右上角 4px，而 CSS Overflow 规定 overflow-y 一旦不是
          visible，overflow-x 会跟着变成 auto——这一层本来靠 `items-center` 收缩到跟按钮一样
          宽（32px），4px 的探出正好落在这条框的滚动裁切线外面，右边角标被裁掉、整条栏子还
          多出 4px 的横向可滚动区。撑满父级 56px 宽（`w-14`）之后按钮两侧各留 12px，角标那
          4px 远远够不到裁切线；子元素照样靠自己的 `items-center` 居中，视觉上不挪位置。
        */}
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1 self-stretch overflow-y-auto">
          <RailGroup label={t("previz.toolbar.group.create")}>
            {KINDS.map((kind) => {
              const addLabel = t(`previz.toolbar.add.${kind}`);
              return (
                <RailButton
                  key={kind}
                  icon={KIND_ICON[kind]}
                  label={addLabel}
                  tip={
                    canAdd[kind]
                      ? undefined
                      : t("previz.toolbar.limitReached", { count: PREVIZ_OBJECT_LIMITS[kind] })
                  }
                  disabled={!canAdd[kind]}
                  onClick={() => onAdd(kind)}
                />
              );
            })}

            {/*
              input 是 `sr-only` 而不是 `hidden`：display:none 的控件拿不到焦点，键盘用户就
              再也够不着导入入口了。视觉上的按钮是它的 <label>，焦点环靠 peer-* 从 input 转过来。
              无障碍名字只由 <label> 里的 sr-only 文本提供——再挂一份 aria-label 是两处真相，
              改坏其中一处另一处会把问题遮住。
              下面 label 上那三个 peer-focus-visible:* 是 buttonVariants 基类里 focus-visible:*
              的同值翻版（Tailwind 无法给现成的变体换前缀）；设计系统改焦点环时这里要跟着改。
            */}
            <input
              id={fileInputId}
              type="file"
              accept=".glb,.gltf,.obj"
              className="peer sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onImportProp(file);
                // 清空 value：不清的话选同一个文件第二次不会触发 change。
                event.target.value = "";
              }}
            />
            <PrevizHoverTip label={t("previz.toolbar.importProp")} side="right">
              <label
                htmlFor={fileInputId}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "icon" }),
                  RAIL_ITEM,
                  "cursor-pointer peer-focus-visible:border-ring peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50",
                )}
              >
                <Upload className="h-4 w-4" />
                <span className="sr-only">{t("previz.toolbar.importProp")}</span>
              </label>
            </PrevizHoverTip>
          </RailGroup>

          <RailDivider />

          <RailGroup label={t("previz.toolbar.group.tool")}>
            {TOOLS.map((option) => (
              <RailButton
                key={option}
                icon={TOOL_ICON[option]}
                label={t(`previz.toolbar.tool.${option}`)}
                on={option === tool}
                shortcut={TOOL_KEY[option]}
                aria-pressed={option === tool}
                onClick={() => onTool(option)}
              />
            ))}
          </RailGroup>

          <RailDivider />

          <RailGroup label={t("previz.toolbar.group.gizmo")}>
            {GIZMO_MODES.map((mode) => (
              <RailButton
                key={mode}
                icon={GIZMO_ICON[mode]}
                label={t(`previz.toolbar.gizmo.${mode}`)}
                on={mode === gizmoMode}
                shortcut={GIZMO_KEY[mode]}
                aria-pressed={mode === gizmoMode}
                onClick={() => onGizmoMode(mode)}
              />
            ))}
          </RailGroup>
        </div>

        {/*
          轨迹面板开关钉在最底下，紧挨着它要收起的那块面板——按下去时视线不用离开那条
          边界。同一颗按钮既收也展（图标跟着换），收起后原地不动，不会出现「收起来之后
          找不到怎么开回去」。
        */}
        <div className="mt-2 flex shrink-0 flex-col items-center border-t border-white/10 pt-2">
          <RailButton
            icon={timelineOpen ? PanelBottomClose : PanelBottomOpen}
            label={timelineLabel}
            data-testid="previz-timeline-toggle"
            aria-expanded={timelineOpen}
            onClick={() => onTimelineOpen(!timelineOpen)}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}
