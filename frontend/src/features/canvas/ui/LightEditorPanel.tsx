// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Move,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";

import { CreditCostPill } from "@/components/credits/credit-visual";
import { UiTextArea } from "@/components/ui";
import { Slider } from "@/components/shadcn/slider";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { BillingRuleNotConfiguredError } from "@/lib/api-errors";
import { useFreezoneImageModels } from "@/features/canvas/hooks/useFreezoneImageModels";
import { FREEZONE_IMAGE_FEATURES } from "@/features/canvas/application/freezoneImageFeatureBilling";
import { buildImageFeatureBillingParams } from "@/features/canvas/domain/imageBilling";
import {
  NODE_CREDIT_PILL_FLAT_CLASS,
  NODE_FLOATING_PANEL_SURFACE_CLASS,
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
} from "@/features/canvas/ui/nodeControlStyles";
import {
  CANVAS_NODE_TOOLBAR_CARD_CLASS,
} from "@/features/canvas/ui/nodeFrameStyles";

export type LightDirectionKey =
  | "left"
  | "top"
  | "right"
  | "front"
  | "bottom"
  | "back";

export type LightPresetKey =
  | "overexposedFilm"
  | "blueBacklight"
  | "rembrandt"
  | "cyberpunk"
  | "psychedelicSunset"
  | "mysteriousDark"
  | "goldenHour"
  | "nolanCool";

export type LightPreviewMode = "perspective" | "front";

export type LightDepth = "front" | "back";

export interface LightVector {
  x: number;
  y: number;
  depth: LightDepth;
}

const LIGHT_DIRECTIONS: LightDirectionKey[] = [
  "left",
  "top",
  "right",
  "front",
  "bottom",
  "back",
];

const DIRECTION_PRESETS: Record<LightDirectionKey, LightVector> = {
  left: { x: -0.7, y: 0, depth: "front" },
  right: { x: 0.7, y: 0, depth: "front" },
  top: { x: 0, y: -0.7, depth: "front" },
  bottom: { x: 0, y: 0.7, depth: "front" },
  front: { x: 0, y: 0, depth: "front" },
  back: { x: 0, y: 0, depth: "back" },
};

const DEFAULT_BRIGHTNESS = 60;
// 色温（开尔文）。后端 `color_temperature_kelvin`，范围 1500-10000，默认 5600。
const MIN_KELVIN = 1500;
const MAX_KELVIN = 10000;
const DEFAULT_KELVIN = 5600;
const KELVIN_STEP = 50;
const DEFAULT_VECTOR: LightVector = { x: 0, y: 0, depth: "front" };
const DEFAULT_RIM_LIGHT = false;
const DEFAULT_SMART_MODE = false;
const EDITOR_PROMPT_TEXTAREA_CLASS =
  "mb-5 h-20 rounded-xl !border-white/[0.14] !bg-bg-dark/45 px-3 py-2 text-xs !text-text-dark placeholder:!text-text-dark/52 shadow-inner";

function imageModelSupportsQuality(apiModel: string | null | undefined): boolean {
  const normalized = String(apiModel ?? "").trim().toLowerCase();
  return (
    normalized === "gpt-image-2"
    || normalized === "image-2"
    || normalized === "image-2-official"
    || normalized.includes("gpt-image")
  );
}

// 开尔文色温 → 近似 RGB（Tanner Helland 近似，适用 ~1000-40000K）。用于色温滑块
// 的暖冷渐变轨道、手柄颜色与 3D 光球预览着色；提交给后端的是开尔文整数本身。
function kelvinToRgb(kelvin: number): [number, number, number] {
  const temp = clamp(kelvin, 1000, 40000) / 100;
  const channel = (v: number) => Math.round(clamp(v, 0, 255));
  let r: number;
  let g: number;
  let b: number;
  if (temp <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(temp) - 161.1195681661;
    b = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
    b = 255;
  }
  return [channel(r), channel(g), channel(b)];
}

function kelvinToHex(kelvin: number): string {
  const [r, g, b] = kelvinToRgb(kelvin);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// 暖→冷渐变（色温滑块轨道背景）。
const KELVIN_GRADIENT = `linear-gradient(to right, ${[
  1500, 2700, 4000, 5600, 7000, 8500, 10000,
]
  .map((k) => kelvinToHex(k))
  .join(", ")})`;

export type LightProviderId = "huimeng" | "openrouter" | "openai";

export const LIGHT_IMAGE_SIZES = ["1K", "2K", "4K"] as const;
export type LightImageSize = (typeof LIGHT_IMAGE_SIZES)[number];
const DEFAULT_LIGHT_IMAGE_SIZE: LightImageSize = "2K";

export interface LightMainLightDescriptor {
  vector: { x: number; y: number };
  depth: LightDepth;
  nearestPreset: LightDirectionKey | null;
  label: string;
}

export interface LightSmartModeDescriptor {
  enabled: boolean;
  prompt: string;
  preset: LightPresetKey | null;
  presetLabel: string | null;
  presetPrompt: string | null;
}

export interface LightEditorSubmitPayload {
  prompt: string;
  displayName: string;
  brightness: number;
  /** 主光源色调 hex（由色温派生，用于预览与后端 color_hex）。 */
  color: string;
  /** 色温（开尔文，1500-10000），提交给后端 color_temperature_kelvin。 */
  colorTemperatureKelvin: number;
  mainLight: LightMainLightDescriptor;
  rimLight: boolean;
  smartMode: LightSmartModeDescriptor;
  apiModel: string;
  providerId: LightProviderId;
  imageSize: LightImageSize;
}

interface LightEditorPanelProps {
  imageSource: string;
  onClose: () => void;
  onSubmit: (payload: LightEditorSubmitPayload) => void;
}

interface LightSpherePreviewProps {
  brightness: number;
  color: string;
  vector: LightVector;
  rimLight: boolean;
  imageSource: string;
  mode: LightPreviewMode;
  onVectorChange: (next: LightVector) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clampToUnitCircle(x: number, y: number): { x: number; y: number } {
  const r = Math.hypot(x, y);
  if (r <= 1) {
    return { x, y };
  }
  return { x: x / r, y: y / r };
}

function describeVector(vector: LightVector, t: (k: string) => string): string {
  if (vector.depth === "back") {
    return t("lightEditor.directions.back");
  }
  const r = Math.hypot(vector.x, vector.y);
  if (r < 0.18) {
    return t("lightEditor.directions.front");
  }
  const horiz =
    vector.x < -0.25
      ? t("lightEditor.directions.left")
      : vector.x > 0.25
        ? t("lightEditor.directions.right")
        : null;
  const vert =
    vector.y < -0.25
      ? t("lightEditor.directions.top")
      : vector.y > 0.25
        ? t("lightEditor.directions.bottom")
        : null;
  return (
    [vert, horiz].filter(Boolean).join(" · ") ||
    t("lightEditor.directions.front")
  );
}

function nearestPreset(vector: LightVector): LightDirectionKey | null {
  let best: { key: LightDirectionKey; dist: number } | null = null;
  for (const key of LIGHT_DIRECTIONS) {
    const preset = DIRECTION_PRESETS[key];
    if (preset.depth !== vector.depth) continue;
    const dist = Math.hypot(preset.x - vector.x, preset.y - vector.y);
    if (!best || dist < best.dist) {
      best = { key, dist };
    }
  }
  if (best && best.dist < 0.12) {
    return best.key;
  }
  return null;
}

function LightSpherePreview({
  brightness,
  color,
  vector,
  rimLight,
  imageSource,
  mode,
  onVectorChange,
}: LightSpherePreviewProps) {
  const sphereRef = useRef<HTMLDivElement>(null);
  const orbDepthScale =
    vector.depth === "back" ? 0.2 : 1.4 - Math.hypot(vector.x, vector.y) * 0.4;

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      const rect = target.getBoundingClientRect();
      const apply = (clientX: number, clientY: number) => {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const rawX = (clientX - cx) / (rect.width / 2);
        const rawY = (clientY - cy) / (rect.height / 2);
        const clamped = clampToUnitCircle(
          clamp(rawX, -1, 1),
          clamp(rawY, -1, 1),
        );
        onVectorChange({ x: clamped.x, y: clamped.y, depth: "front" });
      };
      apply(event.clientX, event.clientY);
      const handleMove = (ev: PointerEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        apply(ev.clientX, ev.clientY);
      };
      const handleUp = (ev: PointerEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        target.releasePointerCapture(ev.pointerId);
        target.removeEventListener("pointermove", handleMove);
        target.removeEventListener("pointerup", handleUp);
      };
      target.addEventListener("pointermove", handleMove);
      target.addEventListener("pointerup", handleUp);
    },
    [onVectorChange],
  );

  const orbX = 50 + vector.x * 40;
  const orbY = 50 + vector.y * 40;
  const orbSize = 22 + orbDepthScale * 8;
  const orbBlur = 16 + (1.4 - orbDepthScale) * 10;
  const intensity = brightness / 100;
  const innerIntensity = 0.4 + intensity * 0.7;
  const lightHandleSize = Math.max(28, orbSize + 12);

  const cardPx = mode === "perspective" ? { w: 86, h: 56 } : { w: 110, h: 72 };
  const cardHalfW = (cardPx.w / 220) * 100 * 0.5;
  const cardHalfH = (cardPx.h / 220) * 100 * 0.5;

  const dxOrb = orbX - 50;
  const dyOrb = orbY - 50;
  let cone1: [number, number];
  let cone2: [number, number];
  if (Math.abs(dxOrb) >= Math.abs(dyOrb)) {
    const xEdge = dxOrb >= 0 ? 50 + cardHalfW : 50 - cardHalfW;
    cone1 = [xEdge, 50 - cardHalfH];
    cone2 = [xEdge, 50 + cardHalfH];
  } else {
    const yEdge = dyOrb >= 0 ? 50 + cardHalfH : 50 - cardHalfH;
    cone1 = [50 - cardHalfW, yEdge];
    cone2 = [50 + cardHalfW, yEdge];
  }
  const conePoints = `${orbX},${orbY} ${cone1[0]},${cone1[1]} ${cone2[0]},${cone2[1]}`;
  const showCone = vector.depth !== "back";

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        ref={sphereRef}
        className="group relative cursor-grab select-none touch-none active:cursor-grabbing"
        style={{ width: 220, height: 220 }}
        onPointerDown={handlePointerDown}
      >
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background:
              mode === "perspective"
                ? `radial-gradient(circle at ${orbX}% ${orbY}%, rgba(255,255,255,${innerIntensity}) 0%, rgba(80,84,96,0.45) 38%, rgba(15,17,24,0.96) 72%)`
                : `radial-gradient(circle at 50% 50%, rgba(255,255,255,${innerIntensity * 0.58}) 0%, rgba(80,84,96,0.34) 42%, rgba(15,17,24,0.96) 76%)`,
            boxShadow: "inset 0 0 30px rgba(0,0,0,0.68)",
            border: "1px solid rgba(255,255,255,0.12)",
          }}
        />
        <svg
          className="pointer-events-none absolute inset-0"
          viewBox="0 0 100 100"
        >
          <defs>
            <radialGradient id="light-cone-gradient" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(255,255,255,0.55)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0)" />
            </radialGradient>
          </defs>
          {mode === "perspective" ? (
            <>
              {[20, 35, 50, 65, 80].map((lat) => (
                <ellipse
                  key={`lat-${lat}`}
                  cx={50}
                  cy={lat}
                  rx={Math.sqrt(50 * 50 - (lat - 50) * (lat - 50))}
                  ry={Math.max(
                    2,
                    Math.sqrt(50 * 50 - (lat - 50) * (lat - 50)) * 0.18,
                  )}
                  fill="none"
                  stroke="rgba(255,255,255,0.095)"
                  strokeWidth="0.4"
                />
              ))}
              {[15, 30, 45, 60, 75].map((lon) => (
                <ellipse
                  key={`lon-${lon}`}
                  cx={50}
                  cy={50}
                  rx={Math.max(2, Math.abs(50 - lon))}
                  ry={50}
                  fill="none"
                  stroke="rgba(255,255,255,0.07)"
                  strokeWidth="0.4"
                />
              ))}
            </>
          ) : (
            <>
              {[12, 24, 36, 48].map((r) => (
                <circle
                  key={`ring-${r}`}
                  cx={50}
                  cy={50}
                  r={r}
                  fill="none"
                  stroke="rgba(255,255,255,0.07)"
                  strokeWidth="0.4"
                />
              ))}
              <line
                x1={2}
                y1={50}
                x2={98}
                y2={50}
                stroke="rgba(255,255,255,0.11)"
                strokeWidth="0.4"
              />
              <line
                x1={50}
                y1={2}
                x2={50}
                y2={98}
                stroke="rgba(255,255,255,0.11)"
                strokeWidth="0.4"
              />
            </>
          )}
          {showCone && (
            <polygon
              points={conePoints}
              fill="rgba(255,255,255,0.12)"
              stroke="rgba(255,255,255,0.18)"
              strokeWidth="0.3"
              strokeLinejoin="round"
            />
          )}
          {showCone && (
            <>
              <line
                x1={orbX}
                y1={orbY}
                x2={50}
                y2={50}
                stroke={color}
                strokeOpacity="0.3"
                strokeWidth="0.95"
                strokeLinecap="round"
                strokeDasharray="1.7 2.4"
              />
              <line
                x1={orbX}
                y1={orbY}
                x2={50}
                y2={50}
                stroke="rgba(255,255,255,0.58)"
                strokeWidth="0.48"
                strokeLinecap="round"
                strokeDasharray="1.7 2.4"
              />
            </>
          )}
        </svg>
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          style={{ zIndex: 1 }}
        >
          <div
            className="overflow-hidden rounded-[8px] border border-white/26 shadow-[0_10px_30px_rgba(0,0,0,0.48)]"
            style={{
              width: cardPx.w,
              height: cardPx.h,
              transform:
                mode === "perspective"
                  ? `perspective(360px) rotateY(${vector.x * 22}deg) rotateX(${-vector.y * 22}deg)`
                  : "none",
              transformStyle: "preserve-3d",
            }}
          >
            <img
              src={imageSource}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          </div>
        </div>
        <div
          className="pointer-events-none absolute"
          style={{
            left: `${orbX}%`,
            top: `${orbY}%`,
            width: orbSize,
            height: orbSize,
            transform: "translate(-50%, -50%)",
            borderRadius: "50%",
            background: `radial-gradient(circle, ${color} 0%, ${color}cc 40%, transparent 70%)`,
            filter: `blur(${orbBlur * 0.15}px)`,
            boxShadow: `0 0 ${orbBlur}px ${color}, 0 0 ${orbBlur * 2}px ${color}88`,
            opacity: vector.depth === "back" ? 0.35 : 0.7 + intensity * 0.3,
            zIndex: 2,
          }}
        />
        <div
          className="pointer-events-none absolute"
          style={{
            left: `${orbX}%`,
            top: `${orbY}%`,
            width: lightHandleSize,
            height: lightHandleSize,
            transform: "translate(-50%, -50%)",
            zIndex: 3,
          }}
        >
          <div
            className="flex h-full w-full items-center justify-center rounded-full border border-white/50 bg-black/24 text-white/92 transition-transform duration-150 group-hover:scale-110 group-active:scale-95"
            style={{
              boxShadow: `0 0 18px rgba(255,255,255,0.2), 0 0 28px ${color}55`,
            }}
          >
            <Move className="h-3.5 w-3.5" aria-hidden="true" />
          </div>
        </div>
        {rimLight && (
          <div
            className="pointer-events-none absolute inset-0 rounded-full"
            style={{
              boxShadow: `inset 0 0 0 2px ${color}55, 0 0 22px ${color}aa`,
            }}
          />
        )}
      </div>
    </div>
  );
}

interface DirectionPickerProps {
  value: LightDirectionKey | null;
  onChange: (next: LightDirectionKey) => void;
  t: (k: string) => string;
}

function DirectionPicker({ value, onChange, t }: DirectionPickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [isOpen]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="inline-flex h-7 w-[76px] items-center justify-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 text-[11px] text-text-dark transition-colors hover:bg-white/[0.08]"
      >
        <span className="whitespace-nowrap font-medium">{t("lightEditor.mainLight")}</span>
        <ChevronDown className="h-2.5 w-2.5 text-text-dark/55" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className={`absolute left-0 top-full z-50 mt-2 w-[132px] p-1.5 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {LIGHT_DIRECTIONS.map((dir) => {
            const isActive = value === dir;
            return (
              <button
                key={dir}
                type="button"
                onClick={() => {
                  onChange(dir);
                  setIsOpen(false);
                }}
                className={`flex h-8 w-full items-center gap-2 rounded-lg border px-2.5 text-left text-xs transition-colors ${
                  isActive
                    ? "border-white/[0.16] bg-white/[0.12] text-text-dark"
                    : "border-transparent text-text-dark/50 hover:bg-white/[0.07] hover:text-text-dark/78"
                }`}
              >
                {isActive ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-text-dark" />
                ) : (
                  <span className="h-3.5 w-3.5 shrink-0" />
                )}
                <span>{t(`lightEditor.directions.${dir}`)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ValueInputProps {
  value: number;
  min: number;
  max: number;
  suffix: string;
  onChange: (value: number) => void;
  inputWidthClass?: string;
}

// 滑块旁可手动输入的数值框：聚焦可编辑、回车/失焦提交并夹取到 [min,max]（取整，
// 不强制滑块的 step，方便精确设置）；Esc 放弃。未编辑时实时跟随外部值（拖动滑块）。
function ValueInput({
  value,
  min,
  max,
  suffix,
  onChange,
  inputWidthClass = "w-10",
}: ValueInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft.trim());
    if (Number.isFinite(parsed)) {
      onChange(clamp(Math.round(parsed), min, max));
    }
    setDraft(null);
  };
  return (
    <span className="inline-flex shrink-0 items-center justify-end gap-0.5 text-xs text-text-dark/58">
      <input
        type="text"
        inputMode="numeric"
        value={draft ?? String(value)}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => {
          setDraft(String(value));
          event.currentTarget.select();
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
        className={`${inputWidthClass} rounded bg-transparent text-right tabular-nums text-text-dark/58 outline-none transition-colors hover:text-text-dark/78 focus:bg-white/[0.06] focus:text-text-dark`}
      />
      <span>{suffix}</span>
    </span>
  );
}

interface SliderRowProps {
  label: string;
  trailing: React.ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}

function SliderRow({
  label,
  trailing,
  value,
  min,
  max,
  step = 1,
  onChange,
}: SliderRowProps) {
  return (
    <div className="flex items-center gap-2.5 py-2.5">
      <span className="w-14 shrink-0 text-right text-xs text-text-dark/86">{label}</span>
      <Slider
        className="flex-1"
        trackClassName="h-1 bg-white/24"
        rangeClassName="bg-[#5b8df6]"
        thumbClassName="h-3 w-3 border-0 bg-[#5b8df6] shadow-none focus-visible:ring-[#5b8df6]/45"
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]) => onChange(next)}
      />
      <span className="flex w-10 shrink-0 justify-end text-right text-[11px] text-text-dark/58">
        {trailing}
      </span>
    </div>
  );
}

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
}

interface QualityPickerProps {
  value: LightImageSize;
  onChange: (value: LightImageSize) => void;
}

interface ColorTemperatureSliderProps {
  /** 当前色温（开尔文，1500-10000）。 */
  valueKelvin: number;
  onChange: (kelvin: number) => void;
}

// 色温滑块：一根暖↔冷渐变轨道 + 可拖动手柄（不是任意取色，而是光感冷暖度）。
// 直接用指针事件驱动（轨道按下/拖动→换算开尔文），渲染在面板内、不 portal，
// 不会触发面板「点外部即关闭」。
function ColorTemperatureSlider({
  valueKelvin,
  onChange,
}: ColorTemperatureSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const ratio = (valueKelvin - MIN_KELVIN) / (MAX_KELVIN - MIN_KELVIN);
  const percent = clamp(ratio * 100, 0, 100);

  const applyFromClientX = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const r = clamp((clientX - rect.left) / rect.width, 0, 1);
      const raw = MIN_KELVIN + r * (MAX_KELVIN - MIN_KELVIN);
      const stepped = Math.round(raw / KELVIN_STEP) * KELVIN_STEP;
      onChange(clamp(stepped, MIN_KELVIN, MAX_KELVIN));
    },
    [onChange],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.stopPropagation();
      event.preventDefault();
      applyFromClientX(event.clientX);
      const onMove = (ev: PointerEvent) => applyFromClientX(ev.clientX);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [applyFromClientX],
  );

  return (
    <div className="flex flex-1 items-center gap-2.5">
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        className="relative h-1 flex-1 cursor-pointer rounded-full"
        style={{ background: KELVIN_GRADIENT }}
      >
        <div
          className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white shadow"
          style={{ left: `${percent}%`, backgroundColor: kelvinToHex(valueKelvin) }}
        />
      </div>
      <ValueInput
        value={valueKelvin}
        min={MIN_KELVIN}
        max={MAX_KELVIN}
        suffix="K"
        onChange={onChange}
        inputWidthClass="w-10"
      />
    </div>
  );
}

function QualityPicker({ value, onChange }: QualityPickerProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [isOpen]);

  const title = t("lightEditor.qualityPicker.title");

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="inline-flex h-7 w-[86px] items-center justify-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 text-[11px] text-text-dark transition-colors hover:bg-white/[0.08]"
      >
        <Sparkles className="h-3 w-3 text-text-dark/55" />
        <span className="whitespace-nowrap font-medium">{title}</span>
        <span className="text-text-dark/35">·</span>
        <span className="text-text-dark/50">{value}</span>
        <ChevronDown className="h-2.5 w-2.5 text-text-dark/55" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className={`absolute left-0 top-full z-50 mt-2 w-[206px] p-2 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="mb-1 text-[11px] uppercase tracking-wide text-text-dark/50">
            {title}
          </div>
          <div className="flex gap-1.5">
            {LIGHT_IMAGE_SIZES.map((size) => {
              const isActive = value === size;
              return (
                <button
                  key={size}
                  type="button"
                  onClick={() => {
                    onChange(size);
                    setIsOpen(false);
                  }}
                  className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors ${
                    isActive
                      ? "border-white/[0.16] bg-white/[0.12] text-text-dark"
                      : "border-transparent bg-transparent text-text-dark/50 hover:bg-white/[0.07] hover:text-text-dark/78"
                  }`}
                >
                  {isActive && <Check className="h-3 w-3" />}
                  {size}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ checked, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent-rgb))] focus-visible:ring-offset-2 focus-visible:ring-offset-surface-dark ${
        checked ? "bg-[rgb(var(--accent-rgb))]" : "bg-white/15"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function LightEditorPanel({
  imageSource,
  onClose,
  onSubmit,
}: LightEditorPanelProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);

  const [previewMode, setPreviewMode] =
    useState<LightPreviewMode>("perspective");
  const [brightness, setBrightness] = useState<number>(DEFAULT_BRIGHTNESS);
  const [colorTemperatureKelvin, setColorTemperatureKelvin] =
    useState<number>(DEFAULT_KELVIN);
  // 主光源色调 hex 由色温派生 —— 光球预览/提示词仍按 hex 走，提交另发开尔文值。
  const color = useMemo(
    () => kelvinToHex(colorTemperatureKelvin),
    [colorTemperatureKelvin],
  );
  const [vector, setVector] = useState<LightVector>(DEFAULT_VECTOR);
  const [rimLight, setRimLight] = useState<boolean>(DEFAULT_RIM_LIGHT);
  const [smartMode, setSmartMode] = useState<boolean>(DEFAULT_SMART_MODE);
  const [smartPrompt, setSmartPrompt] = useState<string>("");
  const [activePreset, setActivePreset] = useState<LightPresetKey | null>(null);
  const [imageSize, setImageSize] = useState<LightImageSize>(
    DEFAULT_LIGHT_IMAGE_SIZE,
  );
  const { models: imageModels } = useFreezoneImageModels();
  const selectedModel = imageModels[0];
  const creditCost = useGenerationCreditCost(
    "feature",
    selectedModel ? FREEZONE_IMAGE_FEATURES.relight : null,
    {
      surface: "canvas",
      params: buildImageFeatureBillingParams(selectedModel, {
        size: imageSize,
        ...(imageModelSupportsQuality(selectedModel?.apiModel)
          ? { quality: "medium" }
          : {}),
        operation: "relight",
      }),
    },
  );
  const billingRuleMissing =
    creditCost.error instanceof BillingRuleNotConfiguredError;
  const costDisplay =
    creditCost.data?.data.display ??
    (billingRuleMissing ? t("common.billingRuleNotConfiguredShort") : null);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (panelRef.current?.contains(event.target as Node)) {
        return;
      }
      onClose();
    };
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
    };
  }, [onClose]);

  const handlePickDirection = useCallback((dir: LightDirectionKey) => {
    setVector(DIRECTION_PRESETS[dir]);
  }, []);

  const handleReset = useCallback(() => {
    setPreviewMode("perspective");
    setBrightness(DEFAULT_BRIGHTNESS);
    setColorTemperatureKelvin(DEFAULT_KELVIN);
    setVector(DEFAULT_VECTOR);
    setRimLight(DEFAULT_RIM_LIGHT);
    setSmartMode(DEFAULT_SMART_MODE);
    setSmartPrompt("");
    setActivePreset(null);
  }, []);

  const directionLabel = useMemo(() => describeVector(vector, t), [vector, t]);
  const activeDirectionPreset = useMemo(() => nearestPreset(vector), [vector]);

  const handleSubmit = useCallback(() => {
    const lines: string[] = [];
    lines.push(t("lightEditor.promptIntro"));
    lines.push(
      t("lightEditor.promptBrightness", { value: Math.round(brightness) }),
    );
    lines.push(t("lightEditor.promptColor", { color }));
    lines.push(t("lightEditor.promptMainLight", { direction: directionLabel }));
    if (rimLight) {
      lines.push(t("lightEditor.promptRimLight"));
    }
    const trimmedSmartPrompt = smartPrompt.trim();
    const presetLabel = activePreset
      ? t(`lightEditor.presets.${activePreset}`)
      : null;
    const presetPrompt = activePreset
      ? t(`lightEditor.presetPrompts.${activePreset}`)
      : null;
    if (smartMode) {
      if (trimmedSmartPrompt) {
        lines.push(t("lightEditor.promptSmart", { text: trimmedSmartPrompt }));
      }
      if (presetPrompt) {
        lines.push(t("lightEditor.promptSmart", { text: presetPrompt }));
      }
    }
    lines.push(t("lightEditor.promptOutro"));
    const prompt = lines.join("\n");
    const displayName =
      smartMode && presetLabel
        ? `${t("nodeToolbar.relight")} · ${presetLabel}`
        : `${t("nodeToolbar.relight")} · ${directionLabel}`;
    const mainLight: LightMainLightDescriptor = {
      vector: { x: vector.x, y: vector.y },
      depth: vector.depth,
      nearestPreset: activeDirectionPreset,
      label: directionLabel,
    };
    const smart: LightSmartModeDescriptor = {
      enabled: smartMode,
      prompt: smartMode ? trimmedSmartPrompt : "",
      preset: smartMode ? activePreset : null,
      presetLabel: smartMode ? presetLabel : null,
      presetPrompt: smartMode ? presetPrompt : null,
    };
    // No model picker in this panel — just use the first model from the
    // shared API store. The store falls back to SHARED_MODELS on failure,
    // so this is only ever undefined if the URL has no project.
    if (!selectedModel) return;
    onSubmit({
      prompt,
      displayName,
      brightness: Math.round(brightness),
      color,
      colorTemperatureKelvin,
      mainLight,
      rimLight,
      smartMode: smart,
      apiModel: selectedModel.apiModel,
      providerId: selectedModel.providerId as LightProviderId,
      imageSize,
    });
  }, [
    activeDirectionPreset,
    activePreset,
    brightness,
    color,
    colorTemperatureKelvin,
    directionLabel,
    imageSize,
    onSubmit,
    rimLight,
    smartMode,
    smartPrompt,
    t,
    vector,
    selectedModel,
  ]);

  return (
    <div
      ref={panelRef}
      className={`w-[600px] ${CANVAS_NODE_TOOLBAR_CARD_CLASS}`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between pl-6 pr-4 pt-5">
        <h2 className="text-lg font-semibold text-text-dark">
          {t("lightEditor.title")}
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-text-dark/55 transition-colors hover:text-text-dark/82"
            onClick={handleReset}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("lightEditor.reset")}
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-white/10 hover:text-text-dark"
            onClick={onClose}
            aria-label="close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex gap-6 px-6 pb-6 pt-4">
        <div className="flex h-[254px] w-[254px] shrink-0 flex-col items-center justify-center rounded-[14px] border border-white/[0.08] bg-[#191b20]/58 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
          <LightSpherePreview
            brightness={brightness}
            color={color}
            vector={vector}
            rimLight={rimLight}
            imageSource={imageSource}
            mode={previewMode}
            onVectorChange={setVector}
          />
        </div>

        <div className="flex min-h-[254px] flex-1 flex-col">
          <div className="mb-7 flex items-center gap-3">
            <div className="inline-flex h-7 w-[70px] shrink-0 rounded-full border border-white/10 bg-white/[0.04] p-0.5 text-[11px]">
              {(["perspective", "front"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPreviewMode(mode)}
                  className={`flex-1 rounded-full px-1 transition-colors ${
                    previewMode === mode
                      ? "bg-white/[0.12] text-text-dark"
                      : "text-text-dark/50 hover:text-text-dark/78"
                  }`}
                >
                  {t(`lightEditor.previewMode.${mode}`)}
                </button>
              ))}
            </div>
            <DirectionPicker
              value={activeDirectionPreset}
              onChange={handlePickDirection}
              t={t}
            />
            <QualityPicker value={imageSize} onChange={setImageSize} />
          </div>

          <div className="mb-3.5 flex items-center gap-2.5">
            <span className="w-14 shrink-0 text-right text-xs text-text-dark/86">
              {t("lightEditor.smartToggle")}
            </span>
            <Toggle checked={smartMode} onChange={setSmartMode} />
          </div>

          {!smartMode ? (
            <>
              <div className="flex items-center gap-2.5 py-2.5">
                <span className="w-14 shrink-0 text-right text-xs text-text-dark/86">
                  {t("lightEditor.rimLight")}
                </span>
                <Toggle checked={rimLight} onChange={setRimLight} />
              </div>
              <SliderRow
                label={t("lightEditor.brightness")}
                value={brightness}
                min={0}
                max={100}
                onChange={setBrightness}
                trailing={
                  <ValueInput
                    value={Math.round(brightness)}
                    min={0}
                    max={100}
                    suffix="%"
                    onChange={setBrightness}
                    inputWidthClass="w-8"
                  />
                }
              />
              <div className="flex items-center gap-2.5 py-2.5">
                <span className="w-14 shrink-0 text-right text-xs text-text-dark/86">
                  {t("lightEditor.color")}
                </span>
                <ColorTemperatureSlider
                  valueKelvin={colorTemperatureKelvin}
                  onChange={setColorTemperatureKelvin}
                />
              </div>
            </>
          ) : (
            <>
              <UiTextArea
                className={EDITOR_PROMPT_TEXTAREA_CLASS}
                value={smartPrompt}
                onChange={(event) => setSmartPrompt(event.target.value)}
                placeholder={t("lightEditor.smartPlaceholder")}
              />
            </>
          )}

          <div className="mt-auto flex items-center justify-end gap-5">
            <CreditCostPill
              display={costDisplay}
              promotion={creditCost.data?.data.promotion}
              className={NODE_CREDIT_PILL_FLAT_CLASS}
            />
            <button
              type="button"
              disabled={billingRuleMissing || !selectedModel}
              className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
                billingRuleMissing || !selectedModel
                  ? NODE_GENERATE_BUTTON_DISABLED_CLASS
                  : NODE_GENERATE_BUTTON_ENABLED_CLASS
              }`}
              onClick={handleSubmit}
              aria-label={t("lightEditor.submit")}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
