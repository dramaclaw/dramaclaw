// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Check, ChevronDown, Maximize2, Minimize2, Radio, Square, Tag, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { MonitorRect, MonitorSize } from "@/features/previz/engine/cameraRig";
import { TooltipProvider } from "@/components/ui/tooltip";
import { aspectRatio } from "@/features/previz/domain/camera";
import {
  PREVIZ_OUTPUT_ASPECT_PRESETS,
  isPresetOutputAspect,
  outputAspectFrom,
  snapOutputAspect,
  type OutputAspect,
  type PrevizCamera,
} from "@/features/previz/domain/scene";
import { PrevizHoverTip } from "@/features/previz/ui/PrevizHoverTip";
import { cn } from "@/lib/utils";

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
  /** 监看正跟着镜头轨走；按钮变成灰的「跟随中」。 */
  following: boolean;
  /** 手选过机位之后点它回到跟随。 */
  onFollow: () => void;
  onClose: () => void;
}

const CHIP =
  "grid h-6 w-6 place-items-center rounded text-white/70 transition hover:bg-white/20 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none";
const CHIP_ON = "bg-white/25 text-white";
const ASPECT_TRIGGER =
  "flex h-6 items-center gap-0.5 rounded pl-1.5 pr-1 text-[11px] tabular-nums text-white/80 transition hover:bg-white/20 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none";
const ASPECT_PANEL =
  "absolute left-0 top-full z-40 mt-1.5 w-40 rounded-md border border-white/10 bg-[#1d222b]/95 p-1 text-white/80 shadow-lg backdrop-blur-sm";
const ASPECT_ITEM =
  "flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs tabular-nums hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none";
const ASPECT_INPUT =
  "h-6 w-0 min-w-0 flex-1 rounded bg-white/10 px-1 text-center text-xs tabular-nums text-white/90 outline-none ring-1 ring-transparent [appearance:textfield] focus-visible:ring-white/50 aria-invalid:ring-red-400/70 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

function aspectTerms(aspect: OutputAspect): { width: string; height: string } {
  const [width = "", height = ""] = aspect.split(":");
  return { width, height };
}

/** 画幅的小示意框：一眼分出横竖，比读数字快。长边恒为 12px。 */
function AspectShape({ aspect }: { aspect: OutputAspect }) {
  const ratio = aspectRatio(aspect);
  const width = ratio >= 1 ? 12 : 12 * ratio;
  const height = ratio >= 1 ? 12 / ratio : 12;
  return (
    <span aria-hidden="true" className="grid h-3 w-3 shrink-0 place-items-center">
      <span className="rounded-[1px] border border-current" style={{ width, height }} />
    </span>
  );
}

/**
 * 画幅比选择：一颗显示当前比例的小按钮，点开是预设列表加一行自定义的「宽 : 高」。
 *
 * 不用原生 `<select>`：它弹的是系统菜单，深色画面上一块浅色原生面板，还压着视口顶上
 * 那排控件；聚焦框也是浏览器画的，鼠标点一下就留一圈白边。自定义输入也收进面板里，
 * 不在工具条上常驻——竖幅监看本来就窄，工具条多两格输入框就伸出画面外了。
 *
 * 面板没有走 base-ui 的 Popover：它会传送到 body 并各自接管焦点与 Esc，和预演台外层
 * Dialog 抢同一下按键（同样的理由见 `PrevizAudioTrack` 的菜单）。这里就地绝对定位，
 * Esc 在面板上自己接住并吞掉，不让外层弹窗把整个编辑器关了。
 *
 * 自定义只在「应用」（或回车）时提交，关掉面板即放弃：宽改完还没改高时，场景里不该
 * 先落一个半成品比例、白白多一次重取景和一条撤销记录。
 */
function AspectPicker({
  outputAspect,
  onOutputAspect,
}: {
  outputAspect: OutputAspect;
  onOutputAspect: (aspect: OutputAspect) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    // 打开即把焦点放到当前选中那一项上（自定义时是宽度输入框），键盘用户接着就能操作。
    panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const dismiss = (event: PointerEvent) => {
      // 落在按钮自己身上交给它的 onClick 去切，不然这里先关、按钮再开，像是点了没反应。
      if (root.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const pick = (aspect: OutputAspect) => {
    if (aspect !== outputAspect) onOutputAspect(aspect);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (!open) return;
    if (event.key === "Escape") {
      // base-ui 的 Dialog 在 document 上冒泡阶段听 Esc，这里停住它就收不到。
      event.stopPropagation();
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const radios = [...(panel.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
    const index = radios.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    radios[(index + step + radios.length) % radios.length]?.focus();
  };

  const custom = !isPresetOutputAspect(outputAspect);

  return (
    <span ref={root} className="relative inline-flex" onKeyDown={onKeyDown}>
      <PrevizHoverTip label={t("previz.monitor.aspect")}>
        <button
          ref={trigger}
          type="button"
          data-testid="previz-monitor-aspect"
          aria-label={t("previz.monitor.aspect")}
          aria-haspopup="true"
          aria-expanded={open}
          className={cn(ASPECT_TRIGGER, open && CHIP_ON)}
          onClick={() => setOpen((value) => !value)}
        >
          {outputAspect}
          <ChevronDown className={cn("h-3 w-3 opacity-60 transition", open && "rotate-180")} />
        </button>
      </PrevizHoverTip>

      {open && (
        <div
          ref={panel}
          role="group"
          aria-label={t("previz.monitor.aspect")}
          data-testid="previz-monitor-aspect-panel"
          className={ASPECT_PANEL}
        >
          <div role="radiogroup" aria-label={t("previz.monitor.aspect")} className="flex flex-col">
            {PREVIZ_OUTPUT_ASPECT_PRESETS.map((aspect) => {
              const checked = aspect === outputAspect;
              return (
                <button
                  key={aspect}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  data-autofocus={checked || undefined}
                  className={cn(ASPECT_ITEM, checked && "text-white")}
                  onClick={() => pick(aspect)}
                >
                  <AspectShape aspect={aspect} />
                  <span className="flex-1">{aspect}</span>
                  {checked && <Check aria-hidden="true" className="h-3.5 w-3.5" />}
                </button>
              );
            })}
          </div>
          <CustomAspectForm outputAspect={outputAspect} custom={custom} onApply={pick} />
        </div>
      )}
    </span>
  );
}

function CustomAspectForm({
  outputAspect,
  custom,
  onApply,
}: {
  outputAspect: OutputAspect;
  custom: boolean;
  onApply: (aspect: OutputAspect) => void;
}) {
  const { t } = useTranslation();
  // 每次打开面板都重新挂载，草稿自然从当前画幅起步，上次没应用的填法不会残留。
  const [draft, setDraft] = useState(() => aspectTerms(outputAspect));
  const blank = draft.width.trim() === "" || draft.height.trim() === "";
  const next = blank ? null : outputAspectFrom(Number(draft.width), Number(draft.height));
  const invalid = !blank && next === null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (next) onApply(next);
  };

  const field = (key: "width" | "height", label: string) => (
    <input
      type="number"
      inputMode="decimal"
      min={0}
      step="any"
      aria-label={label}
      aria-invalid={invalid || undefined}
      data-autofocus={(custom && key === "width") || undefined}
      data-testid={`previz-monitor-aspect-${key}`}
      className={ASPECT_INPUT}
      value={draft[key]}
      onChange={(event) => setDraft((prev) => ({ ...prev, [key]: event.target.value }))}
    />
  );

  return (
    <form
      aria-label={t("previz.monitor.customAspect")}
      className="mt-1 border-t border-white/10 px-2 pb-1.5 pt-2"
      onSubmit={submit}
    >
      <div className={cn("mb-1.5 flex items-center text-[11px]", custom ? "text-white" : "text-white/50")}>
        <span className="flex-1">{t("previz.monitor.customAspect")}</span>
        {custom && <Check aria-hidden="true" className="h-3.5 w-3.5" />}
      </div>
      <div className="flex items-center gap-1">
        {field("width", t("previz.monitor.aspectWidth"))}
        <span aria-hidden="true" className="text-xs text-white/40">
          :
        </span>
        {field("height", t("previz.monitor.aspectHeight"))}
        <button
          type="submit"
          aria-label={t("previz.monitor.applyAspect")}
          disabled={next === null}
          className="grid h-6 w-6 shrink-0 place-items-center rounded bg-white/15 text-white/90 transition hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none disabled:opacity-35 disabled:hover:bg-white/15"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className={cn("mt-1.5 text-[10px]", invalid ? "text-red-300/90" : "text-white/35")}>
        {t("previz.monitor.customAspectRange")}
      </p>
    </form>
  );
}

/** 拖拽预览框的最小边长，CSS 像素：再小就连中间那枚比例标签都放不下了。 */
const DRAG_MIN_EDGE = 48;

type DragEdge = "left" | "top" | "corner";

interface DragStart {
  edge: DragEdge;
  pointerX: number;
  pointerY: number;
  width: number;
  height: number;
  maxWidth: number;
  maxHeight: number;
}

function aspectValue(aspect: OutputAspect): number {
  const [width, height] = aspect.split(":").map(Number);
  return width / height;
}

/**
 * 拖监看框的左边、上边或左上角直接改画幅比。
 *
 * 只动这三处：监看钉在画布右下角（见 `monitorViewportRect`），右边和底边是锚点，拖它们
 * 等于要把框挪出画布。拖动中只画一个虚线预览框和比例标签，**松手才写进场景**——
 * `applyScene` 每调一次压一条撤销记录，逐帧写的话一次拖动能把撤销栈灌满。
 *
 * 松手后框的大小回到档位决定的尺寸（宽度仍是画布的固定比例），变的只是比例：拖的是
 * 「画幅」，不是「监看窗口大小」，后者归放大 / 还原那颗按钮管。
 */
function AspectDragHandles({
  rect,
  outputAspect,
  onOutputAspect,
}: {
  rect: MonitorRect;
  outputAspect: OutputAspect;
  onOutputAspect: (aspect: OutputAspect) => void;
}) {
  const start = useRef<DragStart | null>(null);
  const [draft, setDraft] = useState<{
    edge: DragEdge;
    width: number;
    height: number;
    aspect: OutputAspect;
  } | null>(null);

  const onPointerDown = (edge: DragEdge) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 同 PrevizEditor 的 capturePointer：捕获不上就退化成不捕获，拖出框外那段丢了而已。
    }
    const canvas = event.currentTarget.closest("[data-testid='previz-monitor-frame']")?.parentElement;
    // 画布还没布局（尺寸 0）时不设上限，交给比例区间去收。
    const canvasHeight = canvas?.clientHeight ?? 0;
    start.current = {
      edge,
      pointerX: event.clientX,
      pointerY: event.clientY,
      width: rect.width,
      height: rect.height,
      maxWidth: Math.max(DRAG_MIN_EDGE, rect.x + rect.width),
      maxHeight: canvasHeight > 0 ? Math.max(DRAG_MIN_EDGE, canvasHeight - rect.y) : Infinity,
    };
    setDraft({ edge, width: rect.width, height: rect.height, aspect: outputAspect });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (!from) return;
    const clamp = (value: number, max: number) => Math.min(max, Math.max(DRAG_MIN_EDGE, value));
    let width = from.edge === "top" ? from.width : clamp(from.width - (event.clientX - from.pointerX), from.maxWidth);
    let height =
      from.edge === "left" ? from.height : clamp(from.height - (event.clientY - from.pointerY), from.maxHeight);
    const aspect = snapOutputAspect(width / height);
    // 预览框按吸附后的比例画，标签和框的形状才说的是同一件事。被拖的那条边让步。
    const ratio = aspectValue(aspect);
    if (from.edge === "top") height = width / ratio;
    else width = height * ratio;
    setDraft({ edge: from.edge, width, height, aspect });
  };

  const finish = (commit: boolean) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (commit && draft && draft.aspect !== outputAspect) onOutputAspect(draft.aspect);
    setDraft(null);
  };

  const handle = (edge: DragEdge, className: string) => (
    <div
      aria-hidden="true"
      data-testid={`previz-monitor-resize-${edge}`}
      className={cn("group pointer-events-auto absolute touch-none", className)}
      onPointerDown={onPointerDown(edge)}
      onPointerMove={onPointerMove}
      onPointerUp={finish(true)}
      onPointerCancel={finish(false)}
      // 捕获被系统收走（切窗口、弹出系统对话框）不算用户松手，按取消处理。
      onLostPointerCapture={finish(false)}
    >
      <span
        className={cn(
          "absolute rounded-full bg-white/0 transition group-hover:bg-white/50",
          draft?.edge === edge && "bg-white/60",
          edge === "left" && "inset-y-0 left-1/2 w-0.5 -translate-x-1/2",
          edge === "top" && "inset-x-0 top-1/2 h-0.5 -translate-y-1/2",
          edge === "corner" && "inset-0.5 bg-white/35 group-hover:bg-white/80",
        )}
      />
    </div>
  );

  return (
    <>
      {handle("left", "-left-1.5 top-4 bottom-4 w-3 cursor-ew-resize")}
      {handle("top", "-top-1.5 left-4 right-4 h-3 cursor-ns-resize")}
      {handle("corner", "-left-1.5 -top-1.5 h-3 w-3 cursor-nwse-resize")}
      {draft && (
        <div
          data-testid="previz-monitor-resize-preview"
          className="pointer-events-none absolute bottom-0 right-0 grid place-items-center rounded-sm border border-dashed border-white/80 bg-white/5"
          style={{ width: draft.width, height: draft.height }}
        >
          <span className="rounded bg-black/70 px-1.5 py-0.5 text-xs tabular-nums text-white">
            {draft.aspect}
          </span>
        </div>
      )}
    </>
  );
}

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
  following,
  onFollow,
  onClose,
}: PrevizMonitorFrameProps) {
  const { t } = useTranslation();

  const enlarged = size === "large";
  const sizeLabel = t(enlarged ? "previz.monitor.restore" : "previz.monitor.enlarge");
  const followLabel = t(following ? "previz.monitor.following" : "previz.monitor.follow");

  return (
    <div
      data-testid="previz-monitor-frame"
      className="pointer-events-none absolute rounded-sm ring-1 ring-white/15"
      style={{ left: rect.x, bottom: rect.y, width: rect.width, height: rect.height }}
    >
      <AspectDragHandles rect={rect} outputAspect={outputAspect} onOutputAspect={onOutputAspect} />

      {/*
        提示一律弹在上方：这排开关贴着画中画的右上角，往下弹会盖住监看画面本身——
        而用户来按这排开关，看的就是那块画面。
      */}
      <TooltipProvider delay={120}>
        <div className="pointer-events-auto absolute right-1 top-1 flex items-center gap-0.5 rounded-md bg-black/60 px-1 py-0.5 backdrop-blur-sm">
          <AspectPicker outputAspect={outputAspect} onOutputAspect={onOutputAspect} />

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
          {/*
            跟随中就把按钮禁掉：它此刻是个状态灯而不是开关，按下去也只会把已经是 true 的
            跟随再设一遍。要脱离跟随得去点某台机位——那才是「我要看这一台」的真实意图。
          */}
          <PrevizHoverTip label={followLabel}>
            <button
              type="button"
              data-testid="previz-monitor-follow"
              aria-label={followLabel}
              className={cn(CHIP, following && CHIP_ON)}
              disabled={following}
              onClick={onFollow}
            >
              <Radio className="h-3.5 w-3.5" />
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
