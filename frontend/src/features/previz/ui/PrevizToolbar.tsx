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
  Waypoints,
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
 * 视口里的工具，照 Blender 的模型做成**一条互斥列表**：任意时刻只有一颗亮。
 *
 * 这条栏原先在显示两份互不相干的 state——工具（选择/导航/绘制/标记）一份、手柄模式
 * （移动/旋转/缩放）一份，各算各的按下态，于是 W 和 R 永远同时亮着，用户根本读不出
 * 「现在到底在什么模式里」。合并之后按下态只有一个来源，同时亮两颗在结构上就不可能了。
 *
 * 前四颗是指针工具：选择是拾取；导航下左键拖拽只环绕视口、点击不改选中（给没有中键的
 * 触控板用）；绘制是按住左键在地面上拖出一条轨迹；标记是逐点单击放点、自动与前一点连线
 * （Esc 退出）。这四颗底下视口里**没有**变换手柄。后三颗按下才在选中物体上支起对应的手柄。
 *
 * 拆成两个常量而不是一个七元数组：左栏中间那条分隔线正照着这个界把按钮分成两段，两段
 * 各有各的 `role="group"` 名字。`PREVIZ_TOOLS` 由它们拼出来，分界线只有一处真相。
 */
export const PREVIZ_POINTER_TOOLS = ["select", "navigate", "draw", "mark"] as const;
export const PREVIZ_TRANSFORM_TOOLS = ["translate", "rotate", "scale"] as const;
export const PREVIZ_TOOLS = [...PREVIZ_POINTER_TOOLS, ...PREVIZ_TRANSFORM_TOOLS] as const;
export type PrevizTool = (typeof PREVIZ_TOOLS)[number];

/**
 * 没有别的理由时该落在哪一颗工具上。三处使用点：编辑器的初始状态、画完一笔之后的回落、
 * 以及 Esc 退出标记工具之后的回落。
 *
 * 两处回落各自只有一条硬约束——画完一笔要求「不是 draw」，否则下一次点击又画出一条；
 * Esc 退出标记要求「不是 mark」，否则那一下 Esc 等于没按。落在移动上是这条约束之外的选择：
 * 用户收完尾选中物体就直接能拖，比落回「选择」少按一次键。
 *
 * 放在这里而不是各写各的字面量：三处分头改会让「刚打开」「画完一笔」「Esc 完」停在不同的
 * 工具上，用户读不出这里面有什么道理，只会觉得手柄时有时无。
 */
export const PREVIZ_DEFAULT_TOOL: PrevizTool = "translate";

/**
 * 图标写成 Record 而不是数组字面量：新增一种取值时这里编译期报错，不会静默塌成一个
 * 通用图标、或者干脆少一个按钮。对象类型那张还兼着排序——`Object.keys` 对非整数字符串
 * 键保持书写顺序，所以键序就是按钮从上到下的顺序；工具的顺序另有 `PREVIZ_*_TOOLS`
 * 两条列表说了算，那里还要分段，靠不了一张表的键序。
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
  mark: Waypoints,
  translate: Move3d,
  rotate: Rotate3d,
  scale: Scaling,
};

/**
 * 每颗按钮的文案键。后三颗留在 `previz.toolbar.gizmo.*` 下而不是跟着搬进 `tool.*`：
 * 合并的是「按下态怎么算」，不是文案；改键要动两份 locale、i18n 用例和翻译记忆，
 * 换来的只是键名好看一点。用一张显式的表把这层不对齐写明白，比让读者去猜哪几颗
 * 走哪个前缀强。
 */
const TOOL_LABEL_KEY: Record<PrevizTool, string> = {
  select: "previz.toolbar.tool.select",
  navigate: "previz.toolbar.tool.navigate",
  draw: "previz.toolbar.tool.draw",
  mark: "previz.toolbar.tool.mark",
  translate: "previz.toolbar.gizmo.translate",
  rotate: "previz.toolbar.gizmo.rotate",
  scale: "previz.toolbar.gizmo.scale",
};

/**
 * 工具的快捷键，画成按钮角上的小键帽。键位本身在 PrevizEditor 的 keydown 里绑定；
 * 这里只负责把它显示出来——没有角标的话用户根本不知道有快捷键。
 *
 * 写成 `Record<PrevizTool, string | undefined>` 而不是 `Partial<...>`：新增一种工具
 * 时少写一行会在这里编译期报错，而不是悄悄漏掉一个角标（同 `TOOL_ICON` 那份注释）。
 */
const TOOL_KEY: Record<PrevizTool, string | undefined> = {
  select: "W",
  navigate: "Q",
  draw: undefined, // 绘制没有键位
  mark: undefined, // 标记也没有
  translate: "G",
  rotate: "R",
  scale: "S",
};
/**
 * 悬停提示用哪条文案；不给就用工具名。标记轨迹的用法光看名字看不出来（逐点单击、Esc
 * 收手），所以单独一条。同样写成完整的 Record，新增工具时逼着这里表态。
 */
const TOOL_TIP_KEY: Record<PrevizTool, string | undefined> = {
  select: undefined,
  navigate: undefined,
  draw: undefined,
  mark: "previz.toolbar.markHint",
  translate: undefined,
  rotate: undefined,
  scale: undefined,
};

function inOrder<T extends string>(icons: Record<T, LucideIcon>): readonly T[] {
  return Object.keys(icons) as T[];
}

const KINDS = inOrder(KIND_ICON);


export interface PrevizToolbarProps {
  /** 每种对象是否还能再加（数量上限）。false 时按钮禁用而不是点了没反应。 */
  canAdd: Record<PrevizObjectKind, boolean>;
  /** 当前工具，七颗按钮共用的**唯一**按下态来源。 */
  tool: PrevizTool;
  timelineOpen: boolean;
  onAdd: (kind: PrevizObjectKind) => void;
  onImportProp: (file: File) => void;
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
  /**
   * 当前是否是选中态。高亮的类和 `aria-pressed` 都从它派生，不接受调用方另传一份：
   * 两处各写各的表达式，改坏其中一处的话，要么读屏说「按下」而画面没亮，要么反过来，
   * 而工具栏的用例正是靠 `aria-pressed` 断言的——高亮丢了它也照样绿。
   */
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
        aria-pressed={on}
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
 * 编辑器的左侧菜单列：建对象、指针工具、变换工具，最后是收起/展开轨迹面板。
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
  tool,
  timelineOpen,
  onAdd,
  onImportProp,
  onTool,
  onTimelineOpen,
}: PrevizToolbarProps) {
  const { t } = useTranslation();
  const fileInputId = useId();

  /*
    两段按钮走同一个渲染函数，按下态一律拿同一个 `tool` 去比——互斥性是这么保证的，
    不是靠哪条断言。各段自己算一遍按下态（原来就是那样：一段读 tool、一段读 gizmoMode）
    的话，两颗同时亮又会长回来，而且这次连「有两个 state」这个显眼的线索都没有了。
  */
  const toolButton = (option: PrevizTool) => (
    <RailButton
      key={option}
      icon={TOOL_ICON[option]}
      label={t(TOOL_LABEL_KEY[option])}
      tip={TOOL_TIP_KEY[option] && t(TOOL_TIP_KEY[option])}
      on={option === tool}
      shortcut={TOOL_KEY[option]}
      onClick={() => onTool(option)}
    />
  );

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
            {PREVIZ_POINTER_TOOLS.map(toolButton)}
          </RailGroup>

          {/*
            分隔线和两个分组留着，虽然七颗按钮现在是一条互斥列表：「按下它视口里会多出
            一副手柄」是用户唯一需要提前知道的区别，混排的话这条界就只能靠图标去猜了。
          */}
          <RailDivider />

          <RailGroup label={t("previz.toolbar.group.gizmo")}>
            {PREVIZ_TRANSFORM_TOOLS.map(toolButton)}
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
