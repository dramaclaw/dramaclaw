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
import {
  PREVIZ_CHARACTER_COLORS,
  PREVIZ_HEIGHT_CM_RANGE,
} from "@/features/previz/domain/objects";
import { PREVIZ_POSES, PREVIZ_POSE_LABEL_KEYS } from "@/features/previz/domain/poses";
import {
  PREVIZ_POSE_ADJUST_RANGE,
  type BodyType,
  type HeightPolicy,
  type PrevizCharacter,
  type PrevizObject,
} from "@/features/previz/domain/scene";
import type { CameraPreviewCanvas } from "@/features/previz/engine/cameraPreview";
import { PREVIZ_CHARACTER_PREVIEW_SIZE } from "@/features/previz/engine/characterPreview";
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
/** 姿态那三个数值框：与 `FIELD` 同一套外观，但宽度固定，剩下的横向都留给滑杆。 */
const POSE_FIELD =
  "h-8 w-14 shrink-0 rounded-md border border-white/10 bg-white/[0.04] px-1 " +
  "text-center text-[12px] text-white/90 outline-none focus:border-white/25";
/** 八个色点末尾那个系统取色器，长得跟前面的色点一样大。 */
const CUSTOM_SWATCH =
  "size-6 shrink-0 cursor-pointer rounded-md border border-white/10 bg-transparent p-0.5";
const LABEL = "mb-1 block text-[11px] text-white/45";
const CARD = "rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 py-1.5";
/** 选位之前中右两栏各摆的那块灰字。虚线框是为了让它读起来像「这里还会有东西」。 */
const PLACEHOLDER =
  "flex h-[415px] items-center justify-center rounded-md border border-dashed " +
  "border-white/10 px-4 text-center text-[12px] text-white/35";

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
  /**
   * 三个姿态数值框各自正在敲的那串字。不留这份缓冲的话「-8」根本敲不进去：受控输入
   * 的 `onChange` 没落状态时 React 会把 DOM 还原成上一次的值，那个负号刚敲下就没了。
   * 敲成一个数就同步落进草稿，失焦时丢掉——半截的「-」于是还原成真值。
   */
  const [poseText, setPoseText] = useState<Partial<Record<PoseAdjustAxis, string>>>({});

  // 每次草稿变就重画一具木偶。画布尺寸是绘制缓冲的像素数，CSS 尺寸另外由 class 定。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) onRenderPreview(canvas, draft);
  }, [draft, onRenderPreview]);

  const patch = (next: Partial<PrevizCharacterDraft>) => setDraft((prev) => ({ ...prev, ...next }));

  /**
   * 函数式更新用不到任何外部值，依赖表恒空，包一层的代价是零。
   *
   * 但**不要**照着上面 `objects` 那条读：`onPick` 今天不在选位图的任何一张依赖表里。
   * 实测当前 `PrevizTopDownPicker` 只有两张——`useMemo(…, [objects, footprints, ratio])`
   * 与 `useEffect(…, [view, objects, footprints, value, ratio])`——`onPick` 一张都不在，
   * 它只被每次渲染都重建的 `handleClick` / `handleKeyDown` 调用，组件也没有 `React.memo`。
   * 换句话说这里稳不稳都不会多画一帧。留着只是让「传下去的东西引用稳定」这条不必等
   * 对面改结构时再回来重查。
   */
  const handlePick = useCallback((point: [number, number]) => {
    setDraft((prev) => ({ ...prev, spot: point }));
  }, []);

  const commitPoseAdjust = (axis: PoseAdjustAxis, raw: string) => {
    const value = readNumber(raw);
    if (value === null) return;
    // 必须整份展开再覆盖一轴：只传改动的那一轴会把另外两轴抹成 undefined。
    setDraft((prev) => ({ ...prev, poseAdjust: { ...prev.poseAdjust, [axis]: value } }));
  };

  /** 丢掉某一轴的编辑缓冲：`undefined` 表示这一轴没人在敲，框里读草稿。 */
  const forgetPoseText = (axis: PoseAdjustAxis) =>
    setPoseText((prev) => ({ ...prev, [axis]: undefined }));

  /** 拖滑杆：落数，并丢掉数值框那份缓冲，否则框里会停在用户上次敲的字上。 */
  const dragPoseAdjust = (axis: PoseAdjustAxis, raw: string) => {
    forgetPoseText(axis);
    commitPoseAdjust(axis, raw);
  };

  /** 敲数值框：字先留住（见 `poseText`），读得出数才落进草稿。 */
  const typePoseAdjust = (axis: PoseAdjustAxis, raw: string) => {
    setPoseText((prev) => ({ ...prev, [axis]: raw }));
    commitPoseAdjust(axis, raw);
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

          {/*
            中右两栏都等选位：人物的身高、姿态、朝向都只有落在场里的某一处才谈得上，
            先摆一整栏能改却改不出效果的字段，用户会以为自己已经建好了一个人。
          */}
          <div className="w-[230px] shrink-0">
            {placed ? (
              <canvas
                ref={canvasRef}
                data-testid="character-create-preview"
                aria-label={t("previz.characterCreate.preview")}
                width={PREVIZ_CHARACTER_PREVIEW_SIZE.width}
                height={PREVIZ_CHARACTER_PREVIEW_SIZE.height}
                className="h-[415px] w-[230px] rounded-md border border-white/10 bg-black"
              />
            ) : (
              <p className={PLACEHOLDER}>{t("previz.characterCreate.awaitPreview")}</p>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {placed ? (
              <>
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
                  <span className={LABEL}>{t("previz.characterCreate.color")}</span>
                  <div
                    role="radiogroup"
                    aria-label={t("previz.characterCreate.color")}
                    className="flex flex-wrap items-center gap-1.5"
                  >
                    {/*
                      八个色点是快捷方式，不是白名单：末尾那个系统取色器照旧收任何十六进制色
                      （`hexColor` 也不收敛到这八个），第九个人还得有得挑。

                      八个都留在 Tab 序里，不做 roving tabindex：只让选中的那个可聚焦的话，
                      没有方向键处理的情况下键盘用户根本换不了色。
                    */}
                    {PREVIZ_CHARACTER_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        role="radio"
                        aria-checked={draft.color === color}
                        aria-label={color}
                        className={`size-6 rounded-full border transition-colors ${
                          draft.color === color
                            ? "border-white/80 ring-2 ring-white/40"
                            : "border-white/10 hover:border-white/40"
                        }`}
                        style={{ backgroundColor: color }}
                        onClick={() => patch({ color })}
                      />
                    ))}
                    <input
                      className={CUSTOM_SWATCH}
                      type="color"
                      aria-label={t("previz.characterCreate.customColor")}
                      value={draft.color}
                      onChange={(event) => patch({ color: event.target.value })}
                    />
                  </div>
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
                          onChange={(event) => dragPoseAdjust(axis, event.target.value)}
                        />
                        {/*
                          数值框与滑杆共用 `patchPoseAdjust`，两边读的都是草稿里的同一个数。
                          只有滑杆的话「正好 15 度」只能拖着试，而这三个数最后是要落到人身上的。
                        */}
                        <input
                          className={POSE_FIELD}
                          type="number"
                          min={range.min}
                          max={range.max}
                          step={1}
                          aria-label={t("previz.characterCreate.poseValue", {
                            axis: t(`previz.inspector.poseAdjust.${axis}`),
                          })}
                          value={poseText[axis] ?? draft.poseAdjust[axis]}
                          onChange={(event) => typePoseAdjust(axis, event.target.value)}
                          onBlur={() => forgetPoseText(axis)}
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
              {/*
                移动辅助只在播放时生效：求值层按这两个开关决定要不要把人从道具里推开、
                要不要把他按在场地内。手工摆位时它们一动不动，所以那行说明必须挨着开关摆
                ——否则勾上了却推不动，用户只会以为功能坏了。属性面板上有同一对，建完
                之后改主意的人只会去那里找。
              */}
              <div>
                <span className={LABEL}>{t("previz.inspector.moveAssist")}</span>
                <label className="mb-1 flex items-center gap-2 text-[12px] text-white/80">
                  <input
                    type="checkbox"
                    checked={draft.avoidCollision}
                    onChange={(event) => patch({ avoidCollision: event.target.checked })}
                  />
                  {t("previz.inspector.avoidCollision")}
                </label>
                <label className="mb-1 flex items-center gap-2 text-[12px] text-white/80">
                  <input
                    type="checkbox"
                    checked={draft.stayInBounds}
                    onChange={(event) => patch({ stayInBounds: event.target.checked })}
                  />
                  {t("previz.inspector.stayInBounds")}
                </label>
                <p className="text-[11px] text-white/35">
                  {t("previz.inspector.moveAssistNote")}
                </p>
              </div>
              </>
            ) : (
              <p className={PLACEHOLDER}>{t("previz.characterCreate.awaitFields")}</p>
            )}
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
