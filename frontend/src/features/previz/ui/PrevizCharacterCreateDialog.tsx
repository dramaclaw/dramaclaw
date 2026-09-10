// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  createCharacterDraft,
  isPlacedCharacterDraft,
  type PrevizCharacterDraft,
  type PrevizPlacedCharacterDraft,
} from "@/features/previz/domain/characterDraft";
import { PREVIZ_HEIGHT_CM_RANGE } from "@/features/previz/domain/objects";
import { PREVIZ_POSES, PREVIZ_POSE_LABEL_KEYS } from "@/features/previz/domain/poses";
import {
  PREVIZ_POSE_ADJUST_RANGE,
  type BodyType,
  type HeightPolicy,
  type PrevizCharacter,
  type PrevizObject,
} from "@/features/previz/domain/scene";
import {
  PREVIZ_PREVIEW_SIZE,
  type CameraPreviewCanvas,
} from "@/features/previz/engine/cameraPreview";
import type {
  PrevizTopDownFootprint,
  PrevizTopDownView,
} from "@/features/previz/domain/topDownMap";
import { PrevizTopDownPicker } from "@/features/previz/ui/PrevizTopDownPicker";

export interface PrevizCharacterCreateDialogProps {
  open: boolean;
  /**
   * 场里已有的对象。三处都要它：左栏画参照点、决定俯视图的取景范围，以及给新人物
   * 算下一个编号与下一个没人用的辨识色。
   *
   * **引用要稳**：`PrevizTopDownPicker` 拿它当 `useMemo` / `useEffect` 的依赖，每渲染
   * 一次换一个新数组的话，取景与整张图会跟着重算重画。
   */
  objects: readonly PrevizObject[];
  /**
   * 道具在地面上占的那几块地，原样转给左栏的选位图（只用来算取景范围）。
   *
   * 本组件不碰它的内容，只负责别把引用弄丢——理由同 `objects`：选位图拿它当 `useMemo`
   * / `useEffect` 的依赖，每渲染一次换一个新数组的话，取景与整张图会跟着重算重画。
   */
  footprints?: readonly PrevizTopDownFootprint[];
  /**
   * 把真几何体从上往下画进左栏那块画布，并回传它用的取景框；画不了就回 `null`，
   * 选位图自己回落到 2D 示意图。同样**引用要稳**（选位图拿它当 effect 的依赖）。
   */
  onRenderTopDown?: (canvas: HTMLCanvasElement) => PrevizTopDownView | null;
  /** 把草稿画到木偶预览画布上。接线交给编辑器，本组件只吃 props，好用纯 props 测。 */
  onRenderPreview: (canvas: CameraPreviewCanvas, draft: PrevizCharacterDraft) => void;
  /** 收窄成「已选位」的草稿：没点过俯视图的草稿在这里编译期就递不出去。 */
  onCreate: (draft: PrevizPlacedCharacterDraft) => void;
  onClose: () => void;
}

type PoseAdjustAxis = keyof PrevizCharacter["poseAdjust"];

/** 外观与 `PrevizCameraCreateDialog` 共用一套值，两个创建对话框看起来该是同一个东西。 */
const FIELD =
  "h-8 w-full rounded-md border border-white/10 bg-white/[0.04] px-2 text-[12px] text-white/90 outline-none focus:border-white/25";
const LABEL = "mb-1 block text-[11px] text-white/45";
const CARD = "rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 py-1.5";

/**
 * 体型与高度策略两张表都从 `Record<T, true>` 取键，理由同 `PrevizInspector` 的那三张：
 * 联合类型多一项时这里编译期就红，不会静默少一个下拉项——少掉的那一档用户永远选不到。
 * 顺序也照抄类型的书写顺序，同一份枚举在类型里和屏幕上各排各的会让人以为是两张表。
 */
const BODY_TYPES = Object.keys({
  capsule: true,
  slim: true,
  average: true,
  heavy: true,
  tall: true,
} satisfies Record<BodyType, true>) as readonly BodyType[];
const HEIGHT_POLICIES = Object.keys({
  follow: true,
  ground: true,
  plane: true,
} satisfies Record<HeightPolicy, true>) as readonly HeightPolicy[];
const POSE_ADJUST_AXES = Object.keys({
  pitch: true,
  turn: true,
  lean: true,
} satisfies Record<PoseAdjustAxis, true>) as readonly PoseAdjustAxis[];

/** 见 `PrevizInspector.readNumber`：空串是「正在编辑」，不是「设成 0」。 */
function readNumber(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * 创建人物对话框。三栏：左边俯视选位、中间木偶预览、右边属性表。
 *
 * 关掉就整个卸载（`open` 为假时返回 null），草稿因此活在内层组件的 `useState` 里——
 * 「关掉再打开是重新建一个人」不需要额外的重置副作用来保证。理由与结构都同
 * `PrevizCameraCreateDialog`，包括不再套一层 base-ui Dialog：预演台本身已经是全屏
 * Dialog，嵌套会把焦点陷阱和 Esc 各劫持一遍。
 */
export function PrevizCharacterCreateDialog(props: PrevizCharacterCreateDialogProps) {
  if (!props.open) return null;
  return <CharacterCreatePanel {...props} />;
}

function CharacterCreatePanel({
  objects,
  footprints,
  onRenderTopDown,
  onRenderPreview,
  onCreate,
  onClose,
}: PrevizCharacterCreateDialogProps) {
  const { t } = useTranslation();
  const prefix = useId();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [draft, setDraft] = useState<PrevizCharacterDraft>(() => createCharacterDraft(objects));

  // 每次草稿变就重画一具木偶。画布尺寸是绘制缓冲的像素数，CSS 尺寸另外由 class 定。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) onRenderPreview(canvas, draft);
  }, [draft, onRenderPreview]);

  const patch = (next: Partial<PrevizCharacterDraft>) => setDraft((prev) => ({ ...prev, ...next }));

  // `onPick` 要引用稳定，理由同 `objects`：选位图把它当依赖。
  const handlePick = useCallback((point: [number, number]) => {
    setDraft((prev) => ({ ...prev, spot: point }));
  }, []);

  const patchPoseAdjust = (axis: PoseAdjustAxis, raw: string) => {
    const value = readNumber(raw);
    if (value === null) return;
    // 必须整份展开再覆盖一轴：只传改动的那一轴会把另外两轴抹成 undefined。
    setDraft((prev) => ({ ...prev, poseAdjust: { ...prev.poseAdjust, [axis]: value } }));
  };

  /**
   * 「创建」的闸门走守卫而不是手写 `spot !== null`：守卫才是把收窄结果交给
   * `characterDraftOverrides` 的那道门，两处各判一次迟早会有一处漏掉。
   * 漏掉的表现不是报错，而是人静静地站在世界原点。
   */
  const placed = isPlacedCharacterDraft(draft) ? draft : null;

  return (
    <section
      role="dialog"
      aria-label={t("previz.characterCreate.title")}
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6"
    >
      <div className="flex w-full max-w-[1040px] flex-col gap-4 rounded-xl border border-white/10 bg-[#14161b] p-4 shadow-2xl">
        <h4 className="text-[13px] font-medium text-white/90">
          {t("previz.characterCreate.title")}
        </h4>

        <div className="flex gap-4">
          <div className="w-[320px] shrink-0">
            <PrevizTopDownPicker
              objects={objects}
              footprints={footprints}
              renderTopDown={onRenderTopDown}
              value={draft.spot}
              onPick={handlePick}
            />
            <div className="mt-2 flex items-center gap-2">
              <span className="shrink-0 text-[11px] text-white/45">
                {t("previz.characterCreate.spot")}
              </span>
              {/*
                读数报出来给读屏用户：那个高亮环他看不见，而点完之后焦点还留在选位图
                按钮上（按钮的无障碍名字只在「选过 / 没选过」之间换一次，第二次点到
                别处不会再念）。`polite` 而不是 `assertive`——连点几下改站位时，
                每一下都打断当前朗读会让人根本听不完一句。
              */}
              <span
                aria-label={t("previz.characterCreate.spotLabel")}
                aria-live="polite"
                className={`${CARD} min-w-0 flex-1 text-center text-[12px] tabular-nums text-white/85`}
              >
                {draft.spot
                  ? `${draft.spot[0].toFixed(2)} / ${draft.spot[1].toFixed(2)}`
                  : "— / —"}
              </span>
            </div>
          </div>

          <div className="w-[320px] shrink-0">
            <canvas
              ref={canvasRef}
              data-testid="character-create-preview"
              aria-label={t("previz.characterCreate.preview")}
              width={PREVIZ_PREVIEW_SIZE.width}
              height={PREVIZ_PREVIEW_SIZE.height}
              className="h-[180px] w-[320px] rounded-md border border-white/10 bg-black"
            />
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div>
              <label className={LABEL} htmlFor={`${prefix}-name`}>
                {t("previz.characterCreate.name")}
              </label>
              <input
                id={`${prefix}-name`}
                className={FIELD}
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </div>
            <div>
              {/*
                辨识颜色排在身高体型之前，同 `PrevizInspector`：这一栏回答的是「这是谁」。
                场上所有人共用同一份角色模型，颜色是唯一分得清谁是谁的东西。
              */}
              <label className={LABEL} htmlFor={`${prefix}-color`}>
                {t("previz.characterCreate.color")}
              </label>
              <input
                id={`${prefix}-color`}
                className={`${FIELD} p-1`}
                type="color"
                value={draft.color}
                onChange={(event) => patch({ color: event.target.value })}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor={`${prefix}-body`}>
                {t("previz.inspector.bodyType")}
              </label>
              <select
                id={`${prefix}-body`}
                className={FIELD}
                value={draft.bodyType}
                onChange={(event) => patch({ bodyType: event.target.value as BodyType })}
              >
                {BODY_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`previz.inspector.bodyTypes.${type}`)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor={`${prefix}-height`}>
                {t("previz.inspector.heightCm")}
              </label>
              {/*
                这里**不**夹取，与属性面板那个框刻意不同：夹取推迟到
                `characterDraftOverrides` 那个出口（见它的注释）。逐键夹的话，用户
                想输 175 时刚敲下的 `1` 会当场变成下界 120，第二个数字再也接不上去。
              */}
              <input
                id={`${prefix}-height`}
                className={FIELD}
                type="number"
                min={PREVIZ_HEIGHT_CM_RANGE.min}
                max={PREVIZ_HEIGHT_CM_RANGE.max}
                value={draft.heightCm}
                onChange={(event) => {
                  const value = readNumber(event.target.value);
                  if (value === null) return;
                  patch({ heightCm: value });
                }}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor={`${prefix}-pose`}>
                {t("previz.inspector.basePose")}
              </label>
              <select
                id={`${prefix}-pose`}
                className={FIELD}
                value={draft.basePoseId}
                onChange={(event) => patch({ basePoseId: event.target.value })}
              >
                {/* 标签走 `PREVIZ_POSE_LABEL_KEYS`，不另起一套：同一个姿势在预演台和
                    3D 导演里必须同名，`poses.test.ts` 有棘轮盯着两张表逐字相等。 */}
                {PREVIZ_POSES.map((pose) => (
                  <option key={pose} value={pose}>
                    {t(PREVIZ_POSE_LABEL_KEYS[pose])}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span className={LABEL}>{t("previz.inspector.poseAdjust.label")}</span>
              {POSE_ADJUST_AXES.map((axis) => {
                // 三轴的区间各不对称（人向前屈得比向后仰得多），逐轴取 domain 的那份，
                // 不要拍一对 ±30 了事——滑杆比落盘校验还窄的话，合法值就够不着了。
                const range = PREVIZ_POSE_ADJUST_RANGE[axis];
                return (
                  <div key={axis} className="mb-1 flex items-center gap-2">
                    <span className="w-8 shrink-0 text-[11px] text-white/40">
                      {t(`previz.inspector.poseAdjust.${axis}`)}
                    </span>
                    <input
                      className="flex-1"
                      type="range"
                      min={range.min}
                      max={range.max}
                      step={1}
                      aria-label={t(`previz.inspector.poseAdjust.${axis}`)}
                      value={draft.poseAdjust[axis]}
                      onChange={(event) => patchPoseAdjust(axis, event.target.value)}
                    />
                  </div>
                );
              })}
            </div>
            <div>
              <label className={LABEL} htmlFor={`${prefix}-height-policy`}>
                {t("previz.inspector.heightPolicy")}
              </label>
              {/*
                没有「锁定高度」那一栏：新建的人物脚底就落在 `planeY` 那一层
                （`characterDraftOverrides` 里 `transform.position[1]` 与 `planeY` 是
                同一个常量），此刻选「锁定平面」锁的正好是他将要站的这一层，多一个输入框
                只能填出一个与落点不符的数。要改那一层，去属性面板。
              */}
              <select
                id={`${prefix}-height-policy`}
                className={FIELD}
                value={draft.heightPolicy}
                onChange={(event) =>
                  patch({ heightPolicy: event.target.value as HeightPolicy })
                }
              >
                {HEIGHT_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>
                    {t(`previz.inspector.heightPolicies.${policy}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-white/10 pt-3">
          <button
            type="button"
            className="h-8 shrink-0 rounded-md border border-white/10 px-3 text-[12px] text-white/70 transition-colors hover:bg-white/10 hover:text-white/90"
            onClick={onClose}
          >
            {t("previz.characterCreate.cancel")}
          </button>
          <button
            type="button"
            disabled={!placed}
            className="h-8 shrink-0 rounded-md bg-white/90 px-3 text-[12px] font-medium text-black transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-white/25 disabled:text-black/40"
            onClick={() => {
              if (placed) onCreate(placed);
            }}
          >
            {t("previz.characterCreate.create")}
          </button>
        </footer>
      </div>
    </section>
  );
}
