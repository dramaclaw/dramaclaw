// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useId } from "react";
import { useTranslation } from "react-i18next";

import {
  PREVIZ_APERTURE,
  PREVIZ_FOCAL_MM,
  clampAperture,
  clampFocalMm,
  clampToRange,
  sensorVerticalFovDeg,
} from "@/features/previz/domain/camera";
import {
  PREVIZ_HEIGHT_CM_RANGE,
  type PrevizObjectPatch,
} from "@/features/previz/domain/objects";
import { PREVIZ_POSES, PREVIZ_POSE_LABEL } from "@/features/previz/domain/poses";
import {
  PREVIZ_INTENSITY_RANGE,
  PREVIZ_POSE_ADJUST_RANGE,
  type BodyType,
  type PrevizCharacter,
  type PrevizObject,
  type PrevizTransform,
  type Vec3,
} from "@/features/previz/domain/scene";

export interface PrevizInspectorProps {
  object: PrevizObject | null;
  onChange: (patch: PrevizObjectPatch) => void;
}

const FIELD =
  "h-8 w-full rounded-md border border-white/10 bg-white/[0.04] px-2 text-[12px] text-white/90 outline-none focus:border-white/25";
const LABEL = "mb-1 block text-[11px] text-white/45";

type PoseAdjustAxis = keyof PrevizCharacter["poseAdjust"];

/**
 * 三张列表都从 `Record<T, true>` 取键，而不是写成裸数组字面量：`BodyType` 多一个体型、
 * `PrevizTransform` 多一个通道、`poseAdjust` 多一根轴时，这里编译期就红，不会静默少一个
 * 下拉项 / 少一组输入框——少掉的那个字段在界面上根本不存在，用户改不到，落盘的值也就
 * 永远停在默认值上，没有任何报错。（`PrevizViewportHud` 的 `inOrder`、工具栏与图层面板的
 * `Record<Kind, Icon>` 是同一套写法；非整数字符串键的 `Object.keys` 保持书写顺序，
 * 所以左边的顺序就是屏幕上的顺序。）
 */
const CHANNELS = Object.keys({
  position: true,
  rotation: true,
  scale: true,
} satisfies Record<keyof PrevizTransform, true>) as readonly (keyof PrevizTransform)[];
const BODY_TYPES = Object.keys({
  slim: true,
  average: true,
  heavy: true,
} satisfies Record<BodyType, true>) as readonly BodyType[];
const POSE_ADJUST_AXES = Object.keys({
  pitch: true,
  turn: true,
  lean: true,
} satisfies Record<PoseAdjustAxis, true>) as readonly PoseAdjustAxis[];

/** 三根轴的书写顺序就是 `Vec3` 的下标顺序，`patchTransform` 靠这个把 index 当轴用。 */
const AXES = ["x", "y", "z"] as const;

/**
 * 空串是「正在编辑」而不是「设成 0」：`Number("")` 是 0，逐键放行会在用户删完最后一个
 * 数字的瞬间就把字段改掉——位置跳回原点、身高压到下界 120、焦距跳回默认 50。
 * 非有限值同理，喂给 three 的 fov / 矩阵一旦沾上 NaN，画面全黑，而病因离故障点隔着
 * 好几个文件。
 *
 * 这道守卫只保证「删空的那一瞬间不改数据」，**不**等于「清空再重输就能输对」。这些框
 * 全是受控的，本组件也不留编辑中的字符串，于是被守卫拦下的那次 change 之后 React 会把
 * DOM 值还原成 prop，接着敲的字符是**追加**在旧值后面的。实测（身高默认 175）：清空再
 * 敲 `130` 得到的是 220。全选覆盖输入正常，逐位退格也正常，只有「先删空再重输」会走偏。
 * 要修得让面板自己存一份编辑中的原始字符串（聚焦期间不从 prop 回灌），那是另一件事，
 * 不是这道守卫能顺手办掉的。
 */
function readNumber(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * 选中对象的属性面板。只吃 props、不读 store——store 接线全在 `PrevizEditor` 那一层，
 * 这样面板本身可以用纯 props 测。
 *
 * 控件用原生 `<select>` 与 `<input type="range">`，与 `ThreeDDirectorDialog.tsx` 一致：
 * `@base-ui/react` 的 Select 要开 Portal，嵌在这个全屏 Dialog 里有额外的层级坑，
 * 为几个下拉不值当。
 */
export function PrevizInspector({ object, onChange }: PrevizInspectorProps) {
  const { t } = useTranslation();
  const prefix = useId();

  if (!object) {
    return (
      <div className="flex w-72 shrink-0 items-center justify-center border-l border-white/10 bg-black/30 px-4 text-center text-[12px] text-white/45">
        {t("previz.inspector.empty")}
      </div>
    );
  }

  // 取成 const 再用：闭包里的收窄对 const 绑定才是稳的，对形参会随 TS 版本变。
  const selected = object;
  const character = selected.kind === "character" ? selected : null;
  const camera = selected.kind === "camera" ? selected : null;
  const light = selected.kind === "light" ? selected : null;
  const prop = selected.kind === "prop" ? selected : null;

  /**
   * 三个通道共用一份：只把改动的那一轴换掉，另外两轴与另外两个通道原样带回去。
   * 这里**不**夹取——`scale` 在 domain 里是有区间的（`PREVIZ_SCALE_RANGE`，1e-4..100），
   * 但夹取由 store 的 `normalizeObject`（走 `parseObject`）统一做，面板不重复一份：
   * 两份夹取迟早会对边界值给出不同答案，而 store 那份是所有写入路径（手柄拖拽、
   * 撤销重做、读盘）都必经的，面板这份只覆盖键盘输入这一条。
   */
  const patchTransform = (channel: keyof PrevizTransform, axis: 0 | 1 | 2, raw: string) => {
    const value = readNumber(raw);
    if (value === null) return;
    const next = [...selected.transform[channel]] as Vec3;
    next[axis] = value;
    onChange({ transform: { ...selected.transform, [channel]: next } });
  };

  const patchPoseAdjust = (source: PrevizCharacter, axis: PoseAdjustAxis, raw: string) => {
    const value = readNumber(raw);
    if (value === null) return;
    // 必须整份展开再覆盖一轴：只传改动的那一轴会把另外两轴抹成 undefined。
    const next = { ...source.poseAdjust };
    next[axis] = value;
    onChange({ poseAdjust: next });
  };

  return (
    <div className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l border-white/10 bg-black/30 p-3">
      <div>
        <label className={LABEL} htmlFor={`${prefix}-name`}>
          {t("previz.inspector.name")}
        </label>
        <input
          id={`${prefix}-name`}
          className={FIELD}
          value={selected.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </div>

      {CHANNELS.map((channel) => (
        <div key={channel}>
          <span className={LABEL}>{t(`previz.inspector.${channel}.label`)}</span>
          <div className="grid grid-cols-3 gap-1.5">
            {AXES.map((axis, index) => (
              <input
                key={axis}
                className={FIELD}
                type="number"
                step={channel === "rotation" ? 1 : 0.1}
                aria-label={t(`previz.inspector.${channel}.${axis}`)}
                value={selected.transform[channel][index]}
                onChange={(event) => patchTransform(channel, index as 0 | 1 | 2, event.target.value)}
              />
            ))}
          </div>
        </div>
      ))}

      {character && (
        <>
          <div>
            <label className={LABEL} htmlFor={`${prefix}-height`}>
              {t("previz.inspector.heightCm")}
            </label>
            <input
              id={`${prefix}-height`}
              className={FIELD}
              type="number"
              min={PREVIZ_HEIGHT_CM_RANGE.min}
              max={PREVIZ_HEIGHT_CM_RANGE.max}
              value={character.heightCm}
              onChange={(event) => {
                const value = readNumber(event.target.value);
                if (value === null) return;
                onChange({ heightCm: clampToRange(value, PREVIZ_HEIGHT_CM_RANGE) });
              }}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor={`${prefix}-body`}>
              {t("previz.inspector.bodyType")}
            </label>
            <select
              id={`${prefix}-body`}
              className={FIELD}
              value={character.bodyType}
              onChange={(event) => onChange({ bodyType: event.target.value as BodyType })}
            >
              {BODY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`previz.inspector.bodyTypes.${type}`)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor={`${prefix}-pose`}>
              {t("previz.inspector.basePose")}
            </label>
            <select
              id={`${prefix}-pose`}
              className={FIELD}
              value={character.basePoseId}
              onChange={(event) => onChange({ basePoseId: event.target.value })}
            >
              {/* 标签是硬编码中文，不走 i18n：`PREVIZ_POSE_LABEL` 与 viewer-kit 的
                  `POSE_LABELS` 有棘轮对齐（`poses.test.ts` 盯着），两边必须逐字一致。
                  代价是英文界面下这个下拉框里也是中文——这是已知取舍，不是 i18n 漏了，
                  别顺手改成 `t()`。 */}
              {PREVIZ_POSES.map((pose) => (
                <option key={pose} value={pose}>
                  {PREVIZ_POSE_LABEL[pose]}
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
                    value={character.poseAdjust[axis]}
                    onChange={(event) => patchPoseAdjust(character, axis, event.target.value)}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}

      {camera && (
        <>
          <div>
            <label className={LABEL} htmlFor={`${prefix}-focal`}>
              {t("previz.inspector.focalMm")}
            </label>
            <input
              id={`${prefix}-focal`}
              className={FIELD}
              type="number"
              min={PREVIZ_FOCAL_MM.min}
              max={PREVIZ_FOCAL_MM.max}
              value={camera.focalMm}
              onChange={(event) => {
                const value = readNumber(event.target.value);
                if (value === null) return;
                onChange({ focalMm: clampFocalMm(value) });
              }}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor={`${prefix}-aperture`}>
              {t("previz.inspector.aperture")}
            </label>
            <input
              id={`${prefix}-aperture`}
              className={FIELD}
              type="number"
              step={0.1}
              min={PREVIZ_APERTURE.min}
              max={PREVIZ_APERTURE.max}
              value={camera.aperture}
              onChange={(event) => {
                const value = readNumber(event.target.value);
                if (value === null) return;
                onChange({ aperture: clampAperture(value) });
              }}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor={`${prefix}-sensor`}>
              {t("previz.inspector.sensor")}
            </label>
            <select
              id={`${prefix}-sensor`}
              className={FIELD}
              value={camera.sensor}
              onChange={(event) => onChange({ sensor: event.target.value as "ff" | "s35" })}
            >
              <option value="ff">{t("previz.inspector.sensors.ff")}</option>
              <option value="s35">{t("previz.inspector.sensors.s35")}</option>
            </select>
          </div>
          {/* 视场角是算出来的读数，不是可编辑字段：数字单独占一个节点，好让它跟着
              焦距与机身走，而不是跟着文案模板走。
              读的是镜头自身的纵向角（见 `sensorVerticalFovDeg` 的注释），与摄影机创建
              对话框那条「标准 · 27.0°」是同一个数——同一台机位在两处显示不同的视场角，
              用户只会当成 bug。 */}
          <div className="text-[11px] text-white/45">
            {t("previz.inspector.angleOfView")}
            <span data-testid="previz-inspector-fov" className="ml-1 tabular-nums text-white/70">
              {sensorVerticalFovDeg(camera.focalMm, camera.sensor).toFixed(1)}°
            </span>
          </div>
        </>
      )}

      {light && (
        <>
          <div>
            <label className={LABEL} htmlFor={`${prefix}-light-type`}>
              {t("previz.inspector.lightType")}
            </label>
            <select
              id={`${prefix}-light-type`}
              className={FIELD}
              value={light.lightType}
              onChange={(event) =>
                onChange({ lightType: event.target.value as "key" | "point" | "spot" })
              }
            >
              <option value="key">{t("previz.inspector.lightTypes.key")}</option>
              <option value="point">{t("previz.inspector.lightTypes.point")}</option>
              <option value="spot">{t("previz.inspector.lightTypes.spot")}</option>
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor={`${prefix}-color`}>
              {t("previz.inspector.color")}
            </label>
            <input
              id={`${prefix}-color`}
              className={`${FIELD} p-1`}
              type="color"
              value={light.color}
              onChange={(event) => onChange({ color: event.target.value })}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor={`${prefix}-intensity`}>
              {t("previz.inspector.intensity")}
            </label>
            <input
              id={`${prefix}-intensity`}
              className="w-full"
              type="range"
              min={PREVIZ_INTENSITY_RANGE.min}
              max={PREVIZ_INTENSITY_RANGE.max}
              step={0.1}
              value={light.intensity}
              onChange={(event) => {
                const value = readNumber(event.target.value);
                if (value === null) return;
                onChange({ intensity: value });
              }}
            />
          </div>
        </>
      )}

      {prop && (
        <div>
          <label className={LABEL} htmlFor={`${prefix}-asset`}>
            {t("previz.inspector.assetUrl")}
          </label>
          {/* 只读：手打 URL 只会打错，换模型走工具栏的导入。 */}
          <input id={`${prefix}-asset`} className={FIELD} readOnly value={prop.assetUrl} />
        </div>
      )}
    </div>
  );
}
