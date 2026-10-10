// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import {
  axisGizmoDots,
  type PrevizAxisName,
  type PrevizAxisView,
} from "@/features/previz/domain/axisGizmo";
import type { PrevizViewDirection } from "@/features/previz/domain/view";
import { PrevizHoverTip } from "@/features/previz/ui/PrevizHoverTip";

/**
 * 视角的订阅源。给的是「订阅 + 取快照」而不是直接一个 pose：拖轨道时相机每帧都在变，
 * 把它做成上层的 state 等于每帧重渲整棵编辑器（轨迹面板、监看边框、检视面板全跟着
 * 走一遍）。`useSyncExternalStore` 让重渲只落在这颗小球上。
 *
 * `snapshot` 必须在没变化时返回同一个对象引用，否则 React 会判定「读到的值一直在变」
 * 而反复重渲——每次都新建一个字面量就会当场死循环。
 */
export interface PrevizViewSource {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => PrevizAxisView;
}

/** 三根轴的颜色，与建模软件的通行约定一致：X 红、Y 绿、Z 蓝。 */
const AXIS_COLOR: Record<PrevizAxisName, string> = {
  x: "#f87171",
  y: "#4ade80",
  z: "#60a5fa",
};

const AXIS_LETTER: Record<PrevizAxisName, string> = { x: "X", y: "Y", z: "Z" };

/** 小球面板的边长与「圆心到球心」的半径，单位 px。留出 10px 让球不被裁掉。 */
const PANEL_PX = 72;
const ORBIT_PX = 26;

/**
 * 背对观众的那几颗要暗下去，否则六颗一样亮，前后全靠位置猜。depth 是 [-1, 1]，映到
 * 0.45–1：最暗那颗仍看得见（它还是个可以点的按钮），只是让位给正面的。
 */
function depthOpacity(depth: number): number {
  return 0.45 + 0.55 * ((depth + 1) / 2);
}

/**
 * 视口左上角那颗坐标轴小球：显示当前从哪个方向在看，点某一颗切到那个方向的正视图。
 *
 * 投影全部由 [axisGizmoDots] 算好（含极点退化与前后遮挡顺序），这里只把算出来的位置
 * 摆成 DOM。数组本身是由远及近排好的，所以照顺序渲染，近的天然盖住远的，不必再排
 * z-index——那样每颗球都要背一个跟着相机变的层号，反而更难对。
 *
 * 六颗球是六个真按钮而不是画在 SVG 里的图形：键盘用户要能 Tab 过去，读屏要念得出
 * 「顶视图」。三根轴的连线才走 SVG，它不参与交互。
 */
export function PrevizAxisGizmo({
  view,
  onViewDirection,
}: {
  view: PrevizViewSource;
  onViewDirection: (direction: PrevizViewDirection) => void;
}) {
  const { t } = useTranslation();
  const pose = useSyncExternalStore(view.subscribe, view.snapshot);
  const dots = axisGizmoDots(pose);

  return (
    <div
      className="relative"
      style={{ width: PANEL_PX, height: PANEL_PX }}
      data-testid="previz-axis-gizmo"
    >
      {/*
        三根轴的连线：只从中心连到正半轴那颗，与三维软件里的画法一致——六根连线会在
        中心糊成一团，而正负两颗球本来就在一条直线的两端，一根线足够读出方向。
        aria-hidden：它说的事情六颗按钮已经说过一遍了。
      */}
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0"
        width={PANEL_PX}
        height={PANEL_PX}
      >
        {dots
          .filter((dot) => dot.positive)
          .map((dot) => (
            <line
              key={dot.axis}
              x1={PANEL_PX / 2}
              y1={PANEL_PX / 2}
              x2={PANEL_PX / 2 + dot.x * ORBIT_PX}
              y2={PANEL_PX / 2 + dot.y * ORBIT_PX}
              stroke={AXIS_COLOR[dot.axis]}
              strokeWidth={1.5}
              strokeLinecap="round"
              opacity={depthOpacity(dot.depth)}
            />
          ))}
      </svg>

      {dots.map((dot) => {
        const label = t(`previz.viewport.view.${dot.direction}`);
        const color = AXIS_COLOR[dot.axis];
        return (
          // 定位放在外面这层而不是按钮上：提示的锚点是 PrevizHoverTip 自己那层 <span>，
          // 按钮要是自己绝对定位，那层 span 就留在流里的原点，六条提示会一起从面板左上角
          // 弹出来，指不到任何一颗球。
          <div
            key={dot.direction}
            data-testid={`previz-axis-dot-${dot.direction}`}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{
              left: PANEL_PX / 2 + dot.x * ORBIT_PX,
              top: PANEL_PX / 2 + dot.y * ORBIT_PX,
              opacity: depthOpacity(dot.depth),
            }}
          >
            <PrevizHoverTip label={label} side="right">
              <button
                type="button"
                aria-label={label}
                onClick={() => onViewDirection(dot.direction)}
                className="flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10px] font-semibold leading-none transition hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
                style={{
                  // 正半轴实心带字母，负半轴空心：不这样的话顶视图与底视图长得一模一样。
                  backgroundColor: dot.positive ? color : "rgba(10, 12, 16, 0.72)",
                  border: dot.positive ? "none" : `1.5px solid ${color}`,
                  color: "#0b0d11",
                }}
              >
                {dot.positive ? AXIS_LETTER[dot.axis] : null}
              </button>
            </PrevizHoverTip>
          </div>
        );
      })}
    </div>
  );
}
