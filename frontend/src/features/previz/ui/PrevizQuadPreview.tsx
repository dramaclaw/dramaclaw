// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { CameraPreviewCanvas } from "@/features/previz/engine/cameraPreview";
import type { PrevizScene } from "@/features/previz/domain/scene";
import type { PrevizViewDirection } from "@/features/previz/domain/view";
import { cn } from "@/lib/utils";

/**
 * 每块预览的绘制缓冲长边上限，单位像素。CSS 尺寸由布局决定，超过这个数就让 CSS 放大。
 *
 * 这几块不是直接上屏的：每画一格都要开一张离屏 target、把像素同步读回来再
 * `putImageData`（见 `blitCameraToCanvas`）。回读是一次 GPU 同步等待，代价随像素数走，
 * 而拖手柄期间这三格每帧都重画一轮。照布局尺寸开缓冲的话，一块 530×700 的格子每帧就是
 * 三十多万像素的回读、乘三。参照图要读的是「谁在哪、隔多远」，不是画面细节。
 */
const PREVIZ_QUAD_MAX_EDGE = 480;

/**
 * 画布还没进布局时（宽高都是 0）用的缓冲尺寸。16:9，够画出个大概。
 *
 * 不能是 0：`WebGLRenderTarget(0, 0)` 与 `createImageData(0, 0)` 都会抛。
 */
const PREVIZ_QUAD_FALLBACK_SIZE = { width: 480, height: 270 } as const;

/**
 * 右边那一列是哪两个正交视角。`side` 取右视：右手系里 +X 是舞台右侧，与俯视图的 +X
 * 朝向同一边，两张图上下摞着看时左右不会互相拧着。
 */
const ORTHO_PANES = [
  { key: "top", direction: "top" },
  { key: "side", direction: "right" },
] as const satisfies readonly { key: string; direction: PrevizViewDirection }[];

type OrthoKey = (typeof ORTHO_PANES)[number]["key"];

export interface PrevizQuadPreviewProps {
  /** 只用来判断「画面里的东西变了没有」，不读内容：对象一动就是个新的引用。 */
  scene: PrevizScene;
  /** 播放头。带轨迹的对象每帧站的位置不同，几张图要跟着走。 */
  frame: number;
  /**
   * 活动机位的 id 与名字，没设监看机位时都是 null。
   *
   * 拆成两个标量而不是一个对象：对象字面量每次渲染都是新引用，做重画依赖会每渲一次
   * 就重跑一轮离屏渲染。id 进依赖（换机位要重画），名字只喂标题。
   */
  cameraId: string | null;
  cameraName: string | null;
  /**
   * 订阅「有东西正被手柄拖着走」，返回退订。
   *
   * 拖拽中的位置要到松手才写回 `scene`，光看上面几个 prop 的话这几张图会僵在原地。
   */
  subscribeDrag: (listener: () => void) => () => void;
  onRenderOrtho: (canvas: CameraPreviewCanvas, direction: PrevizViewDirection) => void;
  onRenderCamera: (canvas: CameraPreviewCanvas) => void;
}

/**
 * 把画布的绘制缓冲对到它的布局尺寸上，长边封在 [PREVIZ_QUAD_MAX_EDGE]。
 *
 * 每次重画前都对一遍，而不是只在 ResizeObserver 里对：这几格的尺寸跟着窗口、侧栏、
 * 时间轴一起变，而它们不一定都会走到那个观察者。
 */
function syncBuffer(canvas: HTMLCanvasElement): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const scale =
    width > 0 && height > 0 ? Math.min(1, PREVIZ_QUAD_MAX_EDGE / Math.max(width, height)) : 0;
  const buffer =
    scale > 0
      ? {
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
        }
      : PREVIZ_QUAD_FALLBACK_SIZE;

  // 写 width/height 会把画布清空，值没变就别写：不然每次重画都要先闪一下黑。
  if (canvas.width !== buffer.width) canvas.width = buffer.width;
  if (canvas.height !== buffer.height) canvas.height = buffer.height;
}

/**
 * 四视图：透视视口之外的另外三格——机位眼里的画面，加上俯视与侧视两张正交参照图。
 *
 * 分布照着参照实现来：视口、机位各占一列，俯视与侧视上下摞在最右那一列。三块合起来
 * 与视口等宽两倍（`flex-[2]` 对 `flex-1`），四格大小相当。
 *
 * 后两格用正交投影而不是把相机转到俯视角度：透视的画面回答不了「这两个人到底谁在前面、
 * 差多少」——近大远小把距离揉进了画面里。正交没有透视缩放，图上量到的比例就是场上的
 * 比例，这正是走位图与灯位图历来用它的原因。
 *
 * 画的是全场景而不是选中的那个：换一次选中就换一次比例尺的话，几张图之间没法互相参照。
 *
 * 机位那格跟着监看机位走（在图层面板上设），没设就摆一句提示——那一格是「镜头里的
 * 画面」，没有镜头时留一块黑画布只会让人以为是坏了。
 */
export function PrevizQuadPreview({
  scene,
  frame,
  cameraId,
  cameraName,
  subscribeDrag,
  onRenderOrtho,
  onRenderCamera,
}: PrevizQuadPreviewProps) {
  const { t } = useTranslation();
  const root = useRef<HTMLElement | null>(null);
  const cameraCanvas = useRef<HTMLCanvasElement | null>(null);
  const orthoCanvases = useRef<Partial<Record<OrthoKey, HTMLCanvasElement | null>>>({});

  const draw = useCallback(() => {
    const camera = cameraCanvas.current;
    // 没设监看机位时那一格摆的是提示文字，画布根本不在 DOM 里。
    if (camera) {
      syncBuffer(camera);
      onRenderCamera(camera);
    }
    for (const pane of ORTHO_PANES) {
      const canvas = orthoCanvases.current[pane.key];
      if (!canvas) continue;
      syncBuffer(canvas);
      onRenderOrtho(canvas, pane.direction);
    }
  }, [onRenderCamera, onRenderOrtho]);

  // 场景、播放头或监看机位一变就重画。晚到的模型（GLB 是异步加载的）不在这条路径上，
  // 要等下一次场景变动才补上——几块参照图慢一步，比每帧都重跑几趟离屏渲染划算。
  useEffect(() => {
    draw();
  }, [draw, scene, frame, cameraId]);

  // 尺寸也得跟：缓冲是按布局尺寸开的，不重画就会被 CSS 拉着放大糊、或者挤扁。
  useEffect(() => {
    const node = root.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => draw());
    observer.observe(node);
    return () => observer.disconnect();
  }, [draw]);

  // 拖手柄期间还要再跟一条实时信号（见 props 上的 `subscribeDrag`）。按帧合并：那条
  // 信号是跟着鼠标采样率来的，一次拖拽几百下，而每一下都是几趟离屏渲染——图跟手就够了，
  // 不需要跟上鼠标。
  useEffect(() => {
    let handle = 0;
    const unsubscribe = subscribeDrag(() => {
      if (handle) return;
      handle = requestAnimationFrame(() => {
        handle = 0;
        draw();
      });
    });
    return () => {
      if (handle) cancelAnimationFrame(handle);
      unsubscribe();
    };
  }, [draw, subscribeDrag]);

  const cameraLabel = t("previz.viewport.quad.camera");

  return (
    <aside
      ref={root}
      aria-label={t("previz.viewport.quadView")}
      className="flex min-w-0 flex-[2] border-l border-white/10 bg-black"
    >
      <figure className="relative m-0 min-w-0 flex-1">
        {cameraId ? (
          <canvas
            ref={(node) => {
              cameraCanvas.current = node;
            }}
            data-testid="previz-quad-camera"
            aria-label={cameraLabel}
            width={PREVIZ_QUAD_FALLBACK_SIZE.width}
            height={PREVIZ_QUAD_FALLBACK_SIZE.height}
            className="block h-full w-full"
          />
        ) : (
          <p className="flex h-full w-full items-center justify-center px-3 text-center text-[11px] text-white/40">
            {t("previz.viewport.quadNoCamera")}
          </p>
        )}
        <figcaption className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white/70">
          {cameraName ? `${cameraLabel} · ${cameraName}` : cameraLabel}
        </figcaption>
      </figure>

      <div className="flex min-w-0 flex-1 flex-col border-l border-white/10">
        {ORTHO_PANES.map((pane, index) => {
          const label = t(`previz.viewport.quad.${pane.key}`);
          return (
            <figure
              key={pane.key}
              className={cn(
                "relative m-0 min-h-0 flex-1",
                index > 0 && "border-t border-white/10",
              )}
            >
              <canvas
                ref={(node) => {
                  orthoCanvases.current[pane.key] = node;
                }}
                data-testid={`previz-quad-${pane.key}`}
                aria-label={label}
                width={PREVIZ_QUAD_FALLBACK_SIZE.width}
                height={PREVIZ_QUAD_FALLBACK_SIZE.height}
                className="block h-full w-full"
              />
              <figcaption className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white/70">
                {label}
              </figcaption>
            </figure>
          );
        })}
      </div>
    </aside>
  );
}
