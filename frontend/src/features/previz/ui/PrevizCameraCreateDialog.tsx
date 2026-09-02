// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useId, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Hand, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  PREVIZ_APERTURE_STOPS,
  PREVIZ_FOCAL_STOPS,
  clampToRange,
  depthOfFieldClass,
  focalClass,
  sensorVerticalFovDeg,
  stepStop,
} from "@/features/previz/domain/camera";
import {
  PREVIZ_PITCH_RANGE,
  PREVIZ_ROLL_RANGE,
  clampCameraDraft,
  createCameraDraft,
  normalizeYawDeg,
  type PrevizCameraDraft,
  type PrevizCameraPlacement,
} from "@/features/previz/domain/cameraDraft";
import type { OutputAspect, PrevizCamera } from "@/features/previz/domain/scene";
import {
  PREVIZ_PREVIEW_SIZE,
  type CameraPreviewCanvas,
} from "@/features/previz/engine/cameraPreview";

export interface PrevizCameraCreateDialogProps {
  open: boolean;
  /** 打开那一刻的导演视角。关掉再打开就是重新取一次，不接着上次的编辑。 */
  viewPose: PrevizCameraPlacement;
  /** 场景当前的出片画幅：预览要按它留黑边，视场角也要按它算。 */
  outputAspect: OutputAspect;
  /** 把草稿画到预览画布上。接线交给编辑器，本组件只吃 props，好用纯 props 测。 */
  onRenderPreview: (canvas: CameraPreviewCanvas, draft: PrevizCameraDraft) => void;
  onCreate: (draft: PrevizCameraDraft) => void;
  onClose: () => void;
}

/** 在预览上拖一像素转多少度。320 px 拖满一屏是 80°，与视口的手感接近。 */
export const PREVIZ_PREVIEW_DRAG_DEG_PER_PX = 0.25;

/**
 * 输入框与下拉的外观，**不含宽度**：宽度一律由调用处单独给。写在一起被咬过——类名
 * 字符串里的先后不决定胜负，Tailwind 生成的样式表里 `w-full` 排在 `w-16` 之后，
 * 于是 `${FIELD} w-16` 实际生效的是 `w-full`；数字框吃满整行又 `shrink-0`，会把整列
 * 撑得比弹窗还宽，控件溢出到面板外面。
 */
const FIELD_BASE =
  "h-8 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[12px] text-white/90 outline-none focus:border-white/25";
const LABEL = "text-[11px] text-white/45";
/** 分档器与读数的外框：极淡的描边 + 一层比面板亮一点的底，圆角比输入框大一档。 */
const CARD = "rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 py-1.5";
/** 箭头按钮不描边，只在悬停时浮起来一层底色，免得四个分档器变成一片框中框。 */
const STEP_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-white/45 transition-colors hover:bg-white/10 hover:text-white/90";
/** 时间轴的播放头用的也是这个蓝，滑杆跟着它走，整个预演台只有一种强调色。 */
const SLIDER = "h-1 min-w-0 flex-1 accent-[#5b8cff]";
/**
 * 角度数字框。原生的上下微调箭头要去掉：框只有 64 px 宽，箭头一占就把「-10.4」挤成
 * 「-10.」，而这一位小数正是拖预览转出来的角度。
 */
const NUMBER_FIELD =
  "w-16 shrink-0 px-1 text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

/**
 * 两张「只是标签」的列表。写成 `Record<T, true>` 取键而不是裸数组：机身或镜头系列
 * 将来多一项时这里编译期就红，不会静默漏掉一个选项——漏掉的那项用户永远选不到。
 * （非整数字符串键的 `Object.keys` 保持书写顺序，所以左边的顺序就是 stepper 的顺序。）
 */
const CAMERA_BODIES = Object.keys({
  cine: true,
  virtual: true,
  handheld: true,
} satisfies Record<PrevizCamera["cameraBody"], true>) as readonly PrevizCamera["cameraBody"][];
const LENS_SERIES = Object.keys({
  prime: true,
  zoom: true,
  anamorphic: true,
} satisfies Record<PrevizCamera["lensSeries"], true>) as readonly PrevizCamera["lensSeries"][];

/** 循环取下一项。机身与镜头系列没有「到头了」的物理含义，所以是循环而不是夹住。 */
function cycle<T>(list: readonly T[], value: T, direction: -1 | 1): T {
  const index = list.indexOf(value);
  if (index < 0) return list[0];
  return list[(index + direction + list.length) % list.length];
}

/** 角度显示到 0.1°。种下去时就先圆掉，好让受控输入框里显示的和存着的是同一个数。 */
function roundAngle(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 见 `PrevizInspector.readNumber`：空串是「正在编辑」，不是「设成 0」。 */
function readNumber(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

interface StepperProps {
  label: string;
  value: string;
  note?: string;
  testId: string;
  prevLabel: string;
  nextLabel: string;
  onPrev: () => void;
  onNext: () => void;
}

/** 「← 值 →」那一格。四个 stepper 只在取值与文案上不同，行为完全一样。 */
function Stepper({
  label,
  value,
  note,
  testId,
  prevLabel,
  nextLabel,
  onPrev,
  onNext,
}: StepperProps) {
  return (
    <div className={CARD}>
      <span className={`block text-center ${LABEL}`}>{label}</span>
      <div className="flex items-center gap-1">
        <button type="button" className={STEP_BUTTON} aria-label={prevLabel} onClick={onPrev}>
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span
          data-testid={testId}
          className="min-w-0 flex-1 truncate text-center text-[13px] font-medium text-white/90 tabular-nums"
        >
          {value}
        </span>
        <button type="button" className={STEP_BUTTON} aria-label={nextLabel} onClick={onNext}>
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
      {note ? (
        <div
          data-testid={`${testId}-note`}
          className="text-center text-[11px] text-white/40 tabular-nums"
        >
          {note}
        </div>
      ) : null}
    </div>
  );
}

interface AngleRowProps {
  label: string;
  sliderLabel: string;
  inputLabel: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

/** 「滑杆 + 数字」那一行。三根角度滑杆只在区间与文案上不同。 */
function AngleRow({ label, sliderLabel, inputLabel, value, min, max, onChange }: AngleRowProps) {
  const handle = (raw: string) => {
    const next = readNumber(raw);
    if (next === null) return;
    onChange(next);
  };
  return (
    <div className="flex items-center gap-2">
      <span className={`w-8 shrink-0 ${LABEL}`}>{label}</span>
      <input
        type="range"
        aria-label={sliderLabel}
        className={SLIDER}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => handle(event.target.value)}
      />
      <input
        type="number"
        aria-label={inputLabel}
        className={`${FIELD_BASE} ${NUMBER_FIELD}`}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => handle(event.target.value)}
      />
    </div>
  );
}

/**
 * 摄影机创建对话框。
 *
 * 关掉就整个卸载（`open` 为假时返回 null），草稿因此活在内层组件的 `useState` 里——
 * 「关掉再打开是重新建一台」这件事不需要额外的重置副作用来保证。
 *
 * 不套 `@base-ui/react` 的 Dialog：预演台本身已经是一个全屏 Dialog，再嵌一层要处理
 * Portal 与层级，而这块面板本来就该盖在预演台里面。焦点与 Esc 由外层那个 Dialog 管。
 */
export function PrevizCameraCreateDialog(props: PrevizCameraCreateDialogProps) {
  if (!props.open) return null;
  return <CameraCreatePanel {...props} />;
}

function CameraCreatePanel({
  viewPose,
  outputAspect,
  onRenderPreview,
  onCreate,
  onClose,
}: PrevizCameraCreateDialogProps) {
  const { t } = useTranslation();
  const prefix = useId();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragFrom = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState<PrevizCameraDraft>(() => {
    const seeded = createCameraDraft(viewPose);
    return {
      ...seeded,
      yawDeg: roundAngle(seeded.yawDeg),
      pitchDeg: roundAngle(seeded.pitchDeg),
    };
  });

  // 每次草稿变就重画一帧。画布尺寸是绘制缓冲的像素数，CSS 尺寸另外由 class 定。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) onRenderPreview(canvas, draft);
  }, [draft, outputAspect, onRenderPreview]);

  // 监听挂在 window 上而不是画布上：手拖出画布外之后还得跟着转，松手也得收得住。
  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const from = dragFrom.current;
      if (!from) return;
      const dx = event.clientX - from.x;
      const dy = event.clientY - from.y;
      dragFrom.current = { x: event.clientX, y: event.clientY };
      setDraft((prev) => ({
        ...prev,
        // 抓着画面拖：往右拖等于把世界往右推，机位向左转（+Y 是从上往下看的逆时针），
        // 往下拖等于把世界往下推，镜头抬起来。与视口里 OrbitControls 的手感一致。
        yawDeg: normalizeYawDeg(prev.yawDeg + dx * PREVIZ_PREVIEW_DRAG_DEG_PER_PX),
        pitchDeg: clampToRange(
          prev.pitchDeg + dy * PREVIZ_PREVIEW_DRAG_DEG_PER_PX,
          PREVIZ_PITCH_RANGE,
        ),
      }));
    };
    const stop = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging]);

  const patch = (next: Partial<PrevizCameraDraft>) => setDraft((prev) => ({ ...prev, ...next }));

  const angleOfView = sensorVerticalFovDeg(draft.focalMm, draft.sensor).toFixed(1);
  const focalNote = `${t(`previz.cameraCreate.focalClasses.${focalClass(draft.focalMm)}`)} · ${angleOfView}°`;

  return (
    <section
      role="dialog"
      aria-label={t("previz.cameraCreate.title")}
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6"
    >
      <div className="flex w-full max-w-[960px] flex-col gap-4 rounded-xl border border-white/10 bg-[#14161b] p-4 shadow-2xl">
        <header className="flex items-center justify-between">
          <h4 className="text-[13px] font-medium text-white/90">
            {t("previz.cameraCreate.title")}
          </h4>
          <button
            type="button"
            className={STEP_BUTTON}
            aria-label={t("previz.cameraCreate.close")}
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="flex gap-4">
          <div className="w-[320px] shrink-0">
            <div className="relative">
              <canvas
                ref={canvasRef}
                data-testid="camera-create-preview"
                aria-label={t("previz.cameraCreate.previewLabel")}
                width={PREVIZ_PREVIEW_SIZE.width}
                height={PREVIZ_PREVIEW_SIZE.height}
                className={`h-[180px] w-[320px] rounded-md border border-white/10 bg-black ${
                  dragging ? "cursor-grabbing" : "cursor-grab"
                }`}
                onPointerDown={(event) => {
                  dragFrom.current = { x: event.clientX, y: event.clientY };
                  setDragging(true);
                }}
              />
              <span className="pointer-events-none absolute left-2 top-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white/70">
                <Hand className="h-3 w-3" />
                {t("previz.cameraCreate.dragHint")}
              </span>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-white/40">
              {t("previz.cameraCreate.previewCaption")}
            </p>
          </div>

          <div className="grid min-w-0 flex-1 grid-cols-2 gap-4">
            <section
              aria-label={t("previz.cameraCreate.properties")}
              className="flex min-w-0 flex-col gap-2"
            >
              <h5 className="text-[12px] text-white/70">{t("previz.cameraCreate.properties")}</h5>
              <div className="grid grid-cols-2 gap-2">
              <Stepper
                label={t("previz.cameraCreate.body")}
                value={t(`previz.cameraCreate.bodies.${draft.cameraBody}`)}
                testId="camera-create-body"
                prevLabel={t("previz.cameraCreate.bodyPrev")}
                nextLabel={t("previz.cameraCreate.bodyNext")}
                onPrev={() => patch({ cameraBody: cycle(CAMERA_BODIES, draft.cameraBody, -1) })}
                onNext={() => patch({ cameraBody: cycle(CAMERA_BODIES, draft.cameraBody, 1) })}
              />
              <Stepper
                label={t("previz.cameraCreate.lens")}
                value={t(`previz.cameraCreate.lenses.${draft.lensSeries}`)}
                testId="camera-create-lens"
                prevLabel={t("previz.cameraCreate.lensPrev")}
                nextLabel={t("previz.cameraCreate.lensNext")}
                onPrev={() => patch({ lensSeries: cycle(LENS_SERIES, draft.lensSeries, -1) })}
                onNext={() => patch({ lensSeries: cycle(LENS_SERIES, draft.lensSeries, 1) })}
              />
              <Stepper
                label={t("previz.cameraCreate.focal")}
                value={`${draft.focalMm}mm`}
                note={focalNote}
                testId="camera-create-focal"
                prevLabel={t("previz.cameraCreate.focalDown")}
                nextLabel={t("previz.cameraCreate.focalUp")}
                onPrev={() => patch({ focalMm: stepStop(PREVIZ_FOCAL_STOPS, draft.focalMm, -1) })}
                onNext={() => patch({ focalMm: stepStop(PREVIZ_FOCAL_STOPS, draft.focalMm, 1) })}
              />
              <Stepper
                label={t("previz.cameraCreate.aperture")}
                value={`f/${draft.aperture}`}
                note={t(`previz.cameraCreate.depthOfField.${depthOfFieldClass(draft.aperture)}`)}
                testId="camera-create-aperture"
                prevLabel={t("previz.cameraCreate.apertureDown")}
                nextLabel={t("previz.cameraCreate.apertureUp")}
                onPrev={() =>
                  patch({ aperture: stepStop(PREVIZ_APERTURE_STOPS, draft.aperture, -1) })
                }
                onNext={() =>
                  patch({ aperture: stepStop(PREVIZ_APERTURE_STOPS, draft.aperture, 1) })
                }
              />
              </div>
              <div className="flex items-center gap-2">
                <label className={`shrink-0 ${LABEL}`} htmlFor={`${prefix}-sensor`}>
                  {t("previz.cameraCreate.sensor")}
                </label>
                <select
                  id={`${prefix}-sensor`}
                  className={`${FIELD_BASE} min-w-0 flex-1`}
                  value={draft.sensor}
                  onChange={(event) =>
                    patch({ sensor: event.target.value as PrevizCamera["sensor"] })
                  }
                >
                  <option value="ff">{t("previz.inspector.sensors.ff")}</option>
                  <option value="s35">{t("previz.inspector.sensors.s35")}</option>
                </select>
              </div>
            </section>

            <section
              aria-label={t("previz.cameraCreate.position")}
              className="flex min-w-0 flex-col gap-2"
            >
              <h5 className="text-[12px] text-white/70">{t("previz.cameraCreate.position")}</h5>
              <div className="flex items-center gap-2">
                <span className={`shrink-0 ${LABEL}`}>{t("previz.cameraCreate.viewReadout")}</span>
                <div
                  aria-label={t("previz.cameraCreate.viewReadoutLabel")}
                  className={`${CARD} min-w-0 flex-1 text-center text-[12px] tabular-nums text-white/85`}
                >
                  {viewPose.position.map((value) => value.toFixed(1)).join(" / ")}
                </div>
              </div>
              <AngleRow
                label={t("previz.cameraCreate.yaw")}
                sliderLabel={t("previz.cameraCreate.yawSlider")}
                inputLabel={t("previz.cameraCreate.yawInput")}
                value={draft.yawDeg}
                min={0}
                max={360}
                onChange={(value) => patch({ yawDeg: value })}
              />
              <AngleRow
                label={t("previz.cameraCreate.pitch")}
                sliderLabel={t("previz.cameraCreate.pitchSlider")}
                inputLabel={t("previz.cameraCreate.pitchInput")}
                value={draft.pitchDeg}
                min={PREVIZ_PITCH_RANGE.min}
                max={PREVIZ_PITCH_RANGE.max}
                onChange={(value) => patch({ pitchDeg: value })}
              />
              <AngleRow
                label={t("previz.cameraCreate.roll")}
                sliderLabel={t("previz.cameraCreate.rollSlider")}
                inputLabel={t("previz.cameraCreate.rollInput")}
                value={draft.rollDeg}
                min={PREVIZ_ROLL_RANGE.min}
                max={PREVIZ_ROLL_RANGE.max}
                onChange={(value) => patch({ rollDeg: value })}
              />
            </section>
          </div>
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-white/10 pt-3">
          <p className="text-[11px] text-white/40">{t("previz.cameraCreate.footerHint")}</p>
          <button
            type="button"
            className="h-8 shrink-0 rounded-md bg-white/90 px-3 text-[12px] font-medium text-black transition-colors hover:bg-white"
            onClick={() => onCreate(clampCameraDraft(draft))}
          >
            {t("previz.cameraCreate.submit")}
          </button>
        </footer>
      </div>
    </section>
  );
}
