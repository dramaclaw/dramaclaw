// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { PREVIZ_GRID_CELL_SIZE } from "@/features/previz/engine/grid";
import type { PrevizObject, PrevizObjectKind } from "@/features/previz/domain/scene";
import {
  canvasToWorld,
  sceneTopDownBounds,
  topDownView,
  worldToCanvas,
  type PrevizTopDownView,
} from "@/features/previz/domain/topDownMap";

/**
 * 创建人物对话框左栏那张俯视选位图。
 *
 * 纯受控：自己不记落点，`value` 从上面来、`onPick` 往上面去。对话框还要拿这个落点去喂
 * 中间那个 3D 木偶预览，两处若各记一份，用户会看到左栏的环和中间的人站在不同地方。
 */

/**
 * 画布的 CSS 尺寸。
 *
 * 宽度取 320，与 `PrevizCameraCreateDialog` 左栏同宽——两个创建对话框并排打开时
 * 左栏对得齐。做成正方形是因为 `sceneTopDownBounds` 的默认地块是 12 m 见方，方画布
 * 装方地块正好没有黑边；换成 16:9 的话空场景一上来左右就各空一条。
 */
export const PREVIZ_TOP_DOWN_PICKER_SIZE = { width: 320, height: 320 } as const;

/**
 * 方向键一下走多远，米。
 *
 * 键盘是这张图上唯一不带坐标的输入，步长就是键盘用户能达到的全部精度。取 0.5 m 而不是
 * 跟着网格走 1 m：对手戏的两个人相隔一米上下，1 m 一档的话「面对面」和「贴着」之间
 * 一个可选值都没有。再细则相反——0.1 m 要按二十下才跨过一格网格，键盘用户没法从场地
 * 这头走到那头。
 */
export const PREVIZ_TOP_DOWN_KEY_STEP_M = 0.5;

/** 位图缩放的上限，与 `PrevizAudioTrack` / `PrevizRenderer` 同一个封顶。 */
const MAX_PIXEL_RATIO = 2;

/** 底色。比对话框面板（#14161b）再深一档，让这块画布读起来是「一片场地」而不是留白。 */
const BACKGROUND = "#0b0d12";
/** 米格线，取自主视口网格的 `PREVIZ_GRID_CELL_COLOR`（0x5d6574），两处看到的是同一张网。 */
const GRID_LINE = "#5d6574";

/**
 * 世界原点那个十字用轴色画：横线是 X 轴、竖线是 Z 轴。
 *
 * 与 `ui/PrevizAxisGizmo.tsx` 的 `AXIS_COLOR` 同值（X 红 Z 蓝，建模软件通行约定）。
 * 那边是模块私有 const，没有导出；重复写在这里的代价是改色要动两处，换来的是这个
 * 组件不必为两个颜色去依赖一个 SVG 小部件。
 */
const AXIS_X_LINE = "#f87171";
const AXIS_Z_LINE = "#60a5fa";

/** 已选站位那个高亮环的颜色。 */
const PICK_RING = "#ffd166";

/**
 * 非人物对象的参照点颜色，抄的是 3D 里同一件东西的本色：灯与物件取 `engine/sceneGraph.ts`
 * 的 `KIND_COLOR`（0xfff3b0 / 0x9ad0a0），机位取 `engine/cameraModel.ts` 的
 * `PREVIZ_CAMERA_COLOR.body`（0x3f6fb4）。
 *
 * 不 import 那两份常量有两个理由：一是它们一个是模块私有、一个挂在会 import three 的
 * 模块上，为三个色值把 three 拖进这张 2D 画布不划算；二是那边是 three 要的 number，
 * 这边是 canvas 要的 CSS 字符串，无论如何都要转一次。人物不在表里——人物用自己的
 * `color`，一颗固定的分类色会让四个人物在俯视图上变成四个一模一样的点，而认人正是
 * 这些参照点存在的全部意义。
 */
const KIND_DOT_COLOR: Record<Exclude<PrevizObjectKind, "character">, string> = {
  camera: "#3f6fb4",
  light: "#fff3b0",
  prop: "#9ad0a0",
};

/** 参照点与高亮环的半径，CSS 像素。环大一圈，两者重合时还分得出选中的是哪个。 */
const DOT_RADIUS_PX = 4;
const RING_RADIUS_PX = 9;

/** 网格线最密到多少 CSS 像素一格。再密就是一片灰糊，还白白多画几千条线。 */
const MIN_GRID_SPACING_PX = 8;

const TAU = Math.PI * 2;

/**
 * `p-0` 不是样式偏好：按钮默认自带内边距，那圈内边距上的点击照样触发 onClick，而落点
 * 是按画布的 rect 换算的，于是映射出画布之外——用户点在看得见的场地外面，人却真的
 * 放到了那儿。把内边距去掉，可点区域与画布就是同一块。
 */
const PICKER_CLASS = [
  "block cursor-crosshair rounded-md border border-white/10 p-0",
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-white/40",
].join(" ");

/** 方向键 → 世界 XZ 上的方向。「下」是 +Z：俯视图里 +Z 朝画布下方（见 topDownMap）。 */
const KEY_DELTA: Record<string, readonly [number, number] | undefined> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export interface PrevizTopDownPickerProps {
  /** 场里已有的对象，只用来画参照点与决定取景范围。 */
  objects: readonly PrevizObject[];
  /** 已选的世界 XZ；还没选时是 null。 */
  value: readonly [number, number] | null;
  onPick: (point: [number, number]) => void;
}

/**
 * 位图按设备像素铺开的倍数。
 *
 * 不铺的话，2× 屏上这张 320 px 的位图是被浏览器放大上去的，一像素宽的网格线和参照点的
 * 边缘都发虚——`PrevizAudioTrack` 给波形铺设备像素就是为了这个。这里代价近乎为零：
 * 点击换算本来就要乘 `位图宽 / rect 宽`，那个比值顺手就把 dpr 一起吃掉了，绘制端因此
 * 一个 transform 都不用设。封顶 2 是同一个取舍——3× 手机上不值那三倍显存。
 *
 * 读的是 effect / 渲染当下的值，把窗口拖到另一块不同 dpr 的屏上不会自己重铺。补这条要
 * 挂 matchMedia 监听，`PrevizAudioTrack` 也没做，留给真有人抱怨的时候。
 */
function pickerPixelRatio(): number {
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(MAX_PIXEL_RATIO, ratio);
}

/**
 * 网格该几米一格。
 *
 * 直接算而不是循环翻倍：跨度是从场景对象的坐标来的，那些数只被 `sceneTopDownBounds`
 * 筛掉了非有限值，1e300 这种量级进得来，`while (step * ppm < 阈值) step *= 2` 在那里
 * 要转上千圈。乘 2 的幂是为了让格子始终是整米数（1、2、4…），格线读起来仍然是尺子；
 * 用 `阈值 / ppm` 直接当步长的话会出现 2.7 m 一格，那张网就没法数了。
 */
function gridStepM(pixelsPerMeter: number, minSpacingPx: number): number {
  const needed = minSpacingPx / (pixelsPerMeter * PREVIZ_GRID_CELL_SIZE);
  const factor = needed <= 1 ? 1 : 2 ** Math.ceil(Math.log2(needed));
  return PREVIZ_GRID_CELL_SIZE * factor;
}

function dotColor(object: PrevizObject): string {
  return object.kind === "character" ? object.color : KIND_DOT_COLOR[object.kind];
}

/** 画一条从 (x0, y0) 到 (x1, y1) 的线。 */
function line(context: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  context.beginPath();
  context.moveTo(x0, y0);
  context.lineTo(x1, y1);
  context.stroke();
}

function drawGrid(context: CanvasRenderingContext2D, view: PrevizTopDownView, ratio: number) {
  // 可见范围对两个角各调一次逆映射就有，而不是拿 bounds 算：窄边等比之后，宽松那个
  // 方向上画布盖住的世界范围比 bounds 更大，按 bounds 画网格会在两侧各缺一截。
  const [leftX, topZ] = canvasToWorld(view, [0, 0]);
  const [rightX, bottomZ] = canvasToWorld(view, [view.width, view.height]);
  const step = gridStepM(view.pixelsPerMeter, MIN_GRID_SPACING_PX * ratio);

  context.strokeStyle = GRID_LINE;
  context.lineWidth = ratio;
  // 用序号乘步长而不是 `x += step` 累加：累加的舍入误差会让最后几条线偏出半个像素。
  for (let i = Math.ceil(leftX / step); i * step <= rightX; i += 1) {
    const px = worldToCanvas(view, [i * step, 0])[0];
    line(context, px, 0, px, view.height);
  }
  for (let i = Math.ceil(topZ / step); i * step <= bottomZ; i += 1) {
    const py = worldToCanvas(view, [0, i * step])[1];
    line(context, 0, py, view.width, py);
  }

  // 原点十字压在网格之上。落在画面外时这两条线自然被位图裁掉，不用另外判断。
  const [originX, originZ] = worldToCanvas(view, [0, 0]);
  context.lineWidth = ratio;
  context.strokeStyle = AXIS_X_LINE;
  line(context, 0, originZ, view.width, originZ);
  context.strokeStyle = AXIS_Z_LINE;
  line(context, originX, 0, originX, view.height);
}

function drawTopDown(
  canvas: HTMLCanvasElement | null,
  view: PrevizTopDownView,
  objects: readonly PrevizObject[],
  value: readonly [number, number] | null,
  ratio: number,
): void {
  if (!canvas) return;
  const context = canvas.getContext("2d");
  // 拿不到 2D 上下文（jsdom、个别隐私模式）时什么都不画，与 `engine/cameraPreview.ts`
  // 同一个处理。左栏空着还能靠键盘选位；从这里抛出去会把整个创建对话框带走。
  if (!context) return;

  context.clearRect(0, 0, view.width, view.height);
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, view.width, view.height);

  drawGrid(context, view, ratio);

  for (const object of objects) {
    const [px, py] = worldToCanvas(view, [
      object.transform.position[0],
      object.transform.position[2],
    ]);
    context.fillStyle = dotColor(object);
    context.beginPath();
    context.arc(px, py, DOT_RADIUS_PX * ratio, 0, TAU);
    context.fill();
  }

  if (!value) return;
  const [px, py] = worldToCanvas(view, [value[0], value[1]]);
  context.strokeStyle = PICK_RING;
  context.lineWidth = 2 * ratio;
  context.beginPath();
  context.arc(px, py, RING_RADIUS_PX * ratio, 0, TAU);
  context.stroke();
}

export function PrevizTopDownPicker({ objects, value, onPick }: PrevizTopDownPickerProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ratio = pickerPixelRatio();

  const view = useMemo(
    () =>
      topDownView(
        sceneTopDownBounds(objects),
        PREVIZ_TOP_DOWN_PICKER_SIZE.width * ratio,
        PREVIZ_TOP_DOWN_PICKER_SIZE.height * ratio,
      ),
    [objects, ratio],
  );

  useEffect(() => {
    drawTopDown(canvasRef.current, view, objects, value, ratio);
  }, [view, objects, value, ratio]);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // `detail` 是这次 click 的连击计数。指针点出来的 click 至少是 1，而键盘回车 / 空格、
    // 读屏软件的「激活」、`element.click()` 合成的那一下全是 0，且 clientX/Y 恒为 0
    // （已在 jsdom + userEvent 上实测）。不分开的话，键盘用户每按一次回车都会把人放到
    // 取景框左上角那一点——不报错的错答案，比报错难查得多。没有坐标时回到取景中心，
    // 已经选过则维持原样。
    if (event.detail === 0) {
      onPick(value ? [value[0], value[1]] : [view.centerX, view.centerZ]);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 量画布自己而不是按钮：按钮上有边框，两者的 rect 差着边框那几像素，按按钮算会让
    // 落点整体偏移。
    const rect = canvas.getBoundingClientRect();
    // 量不出尺寸（还没排版，或被折叠成 0 宽）时不认这一下：下面要除以 rect 宽高，0 会
    // 算出 Infinity 或 NaN，而 NaN 的站位在画面上没有任何提示——人放不下去还查不出原因。
    if (rect.width <= 0 || rect.height <= 0) return;
    // 乘 `位图尺寸 / rect 尺寸`：CSS 尺寸和位图尺寸本来就不一定相等（设备像素铺开占一份，
    // 预演台整个被画布节点 CSS 缩放过又占一份）。直接拿 CSS 像素当位图像素，缩放一变
    // 落点就跟着偏。
    onPick(
      canvasToWorld(view, [
        (event.clientX - rect.left) * (view.width / rect.width),
        (event.clientY - rect.top) * (view.height / rect.height),
      ]),
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const delta = KEY_DELTA[event.key];
    // 只拦方向键。一刀切 preventDefault 会把 Tab 也吃掉，焦点再也出不去这个按钮。
    if (!delta) return;
    // 拦掉浏览器的默认滚动：对话框是可滚的，不拦的话按一下方向键，落点动了的同时
    // 右栏的属性表也跟着滚走。
    event.preventDefault();
    const [fromX, fromZ] = value ?? [view.centerX, view.centerZ];
    onPick([
      fromX + delta[0] * PREVIZ_TOP_DOWN_KEY_STEP_M,
      fromZ + delta[1] * PREVIZ_TOP_DOWN_KEY_STEP_M,
    ]);
  };

  return (
    <button
      type="button"
      // 选过之后换一句话。这是这个按钮唯一的状态提示：读屏用户看不见那个高亮环，
      // 标签不换就分不出「还没选」与「选过了、再点一下改」。
      aria-label={t(
        value ? "previz.characterCreate.pickHintAgain" : "previz.characterCreate.pickHint",
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={PICKER_CLASS}
      style={PREVIZ_TOP_DOWN_PICKER_SIZE}
    >
      {/*
        位图尺寸走 JSX 属性，不在 `drawTopDown` 里赋值：拿不到 2D 上下文时那个函数会
        提前 return，尺寸若跟在它后面就停在 canvas 默认的 300×150，而点击换算除的正是
        这个宽度——画面全空的同时每一次落点都是错的。
      */}
      <canvas
        ref={canvasRef}
        data-testid="top-down-picker"
        width={view.width}
        height={view.height}
        className="block h-full w-full rounded-md"
      />
    </button>
  );
}
