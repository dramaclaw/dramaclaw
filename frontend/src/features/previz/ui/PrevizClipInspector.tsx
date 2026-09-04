// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  PREVIZ_RIG_ANCHOR_FRACTION,
  PREVIZ_RIG_DISTANCE_RANGE,
  PREVIZ_RIG_ELEVATION_RANGE,
  PREVIZ_RIG_HEIGHT_RANGE,
} from '../domain/closeup';
import type {
  PrevizPathClip,
  PrevizPathPoint,
  PrevizRigClip,
  RigAnchorPart,
  RigBearing,
  RigMotion,
  Vec3,
} from '../domain/scene';
import { clipById, isPathClip, isRigClip } from '../domain/timeline';
import { usePrevizStore } from '../store';

/*
  版式：一行一件事，左边一列定宽标签，右边把剩下的宽度让给控件。
  之前是 `flex-wrap` 铺一片「标签+小方框」，一行塞得下几个全看文案长度——中英文一切
  就重排，标签和输入框也对不成列；这一列只有 288px，wrap 到最后干脆把最宽那排挤出可视区，
  「删除片段」被切在屏幕外。定宽标签 + `flex-1` 控件没有这个问题，长文案由标签自己截断。
*/
const ROW = 'flex items-center gap-2';
const ROW_LABEL = 'w-12 shrink-0 truncate text-[11px] text-white/45';
const FIELD =
  'h-7 min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[12px] text-white/90 outline-none focus:border-white/25';
/** 滑杆右边那个跟读数字的小框。定宽，好让三行角度的数字对齐成一列。 */
const NUMBER =
  'h-7 w-16 shrink-0 rounded-md border border-white/10 bg-white/[0.04] px-1 text-center text-[12px] text-white/90 outline-none focus:border-white/25';
const ACTION =
  'h-7 truncate rounded-md border border-white/10 bg-white/[0.04] px-2 text-[12px] text-white/80 outline-none hover:bg-white/[0.08] focus:border-white/25';
// 删除是这里唯一一个不可逆地少掉东西的动作，单独给一个红，免得跟「裁到播放头」这类
// 可以反复调的动作混在同一片灰里误点。
const DANGER =
  'h-8 w-full rounded-md border border-red-400/25 bg-red-500/10 text-[12px] text-red-200/90 outline-none hover:bg-red-500/20 focus:border-red-400/50';
const SECTION = 'text-[11px] uppercase tracking-wide text-white/35';
const ICON_BUTTON =
  'grid h-6 w-6 shrink-0 place-items-center rounded-md text-white/35 outline-none hover:bg-white/10 hover:text-white/80 focus:bg-white/10';

/** 姿态角三根轴都按整圈给区间：滑杆比落盘允许的范围窄的话，合法值就够不着了。 */
const ANGLE_RANGE = { min: -180, max: 180 } as const;
const AZIMUTH_RANGE = { min: -180, max: 180 } as const;

/** 锚点从低到高。顺序照身体来，下拉里才好按「往上挪一格」读。 */
const ANCHOR_PARTS = Object.keys(PREVIZ_RIG_ANCHOR_FRACTION) as RigAnchorPart[];
const MOTIONS: RigMotion[] = ['static', 'orbit', 'push', 'pull'];
const BEARINGS: RigBearing[] = ['front', 'custom'];

/** `Vec3` 里三根姿态角的下标。屏幕上按水平、俯仰、横滚排——先转身再抬头，跟人调机位的顺序一致。 */
const ANGLE_AXES = [
  { key: 'yaw', index: 1 },
  { key: 'pitch', index: 0 },
  { key: 'roll', index: 2 },
] as const;

/** 一行：定宽标签 + 控件。标签截断并挂 `title`，长文案不许把控件挤没。 */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={ROW}>
      <span className={ROW_LABEL} title={label}>
        {label}
      </span>
      {children}
    </div>
  );
}

/** 下拉框。选项的字全部走 i18n，值才是存进片段里的东西。 */
function SelectField<T extends string>({
  label,
  value,
  options,
  onCommit,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onCommit: (next: T) => void;
}) {
  return (
    <Row label={label}>
      <select
        aria-label={label}
        className={FIELD}
        value={value}
        onChange={(event) => onCommit(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

/**
 * 数字输入框。`key` 挂当前值：外部改动（撤销、拖手柄、旁边的滑杆）要能把框里的字刷新掉。
 *
 * onBlur 而不是 onChange：每敲一个字符都提交的话，"1.5" 会先经过 "1."
 * （Number("1.") 是 1）再到 1.5，中间那步是一次白白进 undo 栈的编辑。
 *
 * 显示到两位小数。这些数多半不是人敲进去的——朝向是切线算出来的（75.763917…）、
 * 位置是拖手柄拖出来的，原样铺开在这么窄一个框里只会被切掉半截，读到的是错的。
 * 配套地，字没动过就不提交：否则光是点进去再点出来，就会拿被截短的读数覆盖真值，
 * 顺手把这个点标成「手改过朝向」，从此不再跟着切线转。
 */
function NumberInput({
  label,
  value,
  step,
  className,
  onCommit,
}: {
  label: string;
  value: number;
  step: number;
  className: string;
  onCommit: (next: number) => void;
}) {
  const shown = String(Math.round(value * 100) / 100);
  return (
    <input
      type="number"
      step={step}
      aria-label={label}
      className={className}
      key={shown}
      defaultValue={shown}
      onBlur={(event) => {
        if (event.target.value === shown) return;
        onCommit(Number(event.target.value));
      }}
    />
  );
}

function NumberField({
  label,
  value,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  step: number;
  onCommit: (next: number) => void;
}) {
  return (
    <Row label={label}>
      <NumberInput label={label} value={value} step={step} className={FIELD} onCommit={onCommit} />
    </Row>
  );
}

/**
 * 一行：标签 + 滑杆 + 跟读的数字框，右边可以再挂一个复位之类的小按钮。
 *
 * 滑杆和数字框读同一个值、写同一个 `onCommit`，但**只有数字框**顶着 `label` 这个
 * 无障碍名：两个控件同名的话 `getByLabelText` 会一次命中两个直接报错，测试里所有
 * 数值断言都是照着这个名字取的。滑杆自己带一个 `xxx 滑杆` 的名字。
 */
function SliderField({
  label,
  value,
  min,
  max,
  step,
  onCommit,
  trailing,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (next: number) => void;
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Row label={label}>
      {trailing}
      <input
        type="range"
        className="min-w-0 flex-1 accent-sky-400"
        aria-label={t('previz.clip.slider', { name: label })}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onCommit(Number(event.target.value))}
      />
      <NumberInput label={label} value={value} step={step} className={NUMBER} onCommit={onCommit} />
    </Row>
  );
}

/**
 * 特写片段的取景面板。机位不自己走位，调的是「跟着谁、离多远、从哪个方位看」，
 * 所以这里一个关键帧都没有。
 */
function CloseupPanel({ clip, cameraObjectId }: { clip: PrevizRigClip; cameraObjectId: string }) {
  const { t } = useTranslation();
  const objects = usePrevizStore((state) => state.scene.objects);
  const updateCloseup = usePrevizStore((state) => state.updateCloseup);
  const bakeCloseup = usePrevizStore((state) => state.bakeCloseup);

  // 机位自己不在候选里：自己跟自己没有不动点，求值器也只会原地跳过。
  const targets = objects.filter((object) => object.id !== cameraObjectId);
  const aiming = clip.aimObjectId !== null;

  return (
    <>
      <section className="flex flex-col gap-2">
        <div className={SECTION}>{t('previz.clip.closeup.sectionTracking')}</div>
        <SelectField
          label={t('previz.clip.closeup.target')}
          value={clip.anchorObjectId}
          options={targets.map((object) => ({ value: object.id, label: object.name }))}
          // 「看向」跟着目标走：换了人还盯着上一个，画面里就只剩一个后脑勺。
          onCommit={(next) =>
            updateCloseup(clip.id, {
              anchorObjectId: next,
              ...(aiming ? { aimObjectId: next } : {}),
            })
          }
        />
        <SelectField
          label={t('previz.clip.closeup.anchor')}
          value={clip.anchorPart}
          options={ANCHOR_PARTS.map((part) => ({
            value: part,
            label: t(`previz.clip.closeup.part.${part}`),
          }))}
          onCommit={(next) => updateCloseup(clip.id, { anchorPart: next })}
        />
      </section>

      <section className="flex flex-col gap-2">
        <div className={SECTION}>{t('previz.clip.closeup.sectionFraming')}</div>
        <SelectField
          label={t('previz.clip.closeup.aim')}
          value={aiming ? 'track' : 'free'}
          options={[
            { value: 'track', label: t('previz.clip.closeup.aimTrack') },
            { value: 'free', label: t('previz.clip.closeup.aimFree') },
          ]}
          onCommit={(next) =>
            updateCloseup(clip.id, { aimObjectId: next === 'track' ? clip.anchorObjectId : null })
          }
        />
        <SelectField
          label={t('previz.clip.closeup.bearing')}
          value={clip.bearing}
          options={BEARINGS.map((bearing) => ({
            value: bearing,
            label: t(`previz.clip.closeup.bearing_${bearing}`),
          }))}
          onCommit={(next) => updateCloseup(clip.id, { bearing: next })}
        />
        <SliderField
          label={t('previz.clip.closeup.azimuth')}
          value={clip.azimuth}
          min={AZIMUTH_RANGE.min}
          max={AZIMUTH_RANGE.max}
          step={1}
          onCommit={(next) => updateCloseup(clip.id, { azimuth: next })}
        />
        <SliderField
          label={t('previz.clip.closeup.elevation')}
          value={clip.elevation}
          min={PREVIZ_RIG_ELEVATION_RANGE.min}
          max={PREVIZ_RIG_ELEVATION_RANGE.max}
          step={1}
          onCommit={(next) => updateCloseup(clip.id, { elevation: next })}
        />
      </section>

      <section className="flex flex-col gap-2">
        <div className={SECTION}>{t('previz.clip.closeup.sectionMotion')}</div>
        <SliderField
          label={t('previz.clip.closeup.distance')}
          value={clip.distance}
          min={PREVIZ_RIG_DISTANCE_RANGE.min}
          max={PREVIZ_RIG_DISTANCE_RANGE.max}
          step={0.05}
          onCommit={(next) => updateCloseup(clip.id, { distance: next })}
        />
        <SliderField
          label={t('previz.clip.closeup.height')}
          value={clip.height}
          min={PREVIZ_RIG_HEIGHT_RANGE.min}
          max={PREVIZ_RIG_HEIGHT_RANGE.max}
          step={0.05}
          onCommit={(next) => updateCloseup(clip.id, { height: next })}
        />
        <SelectField
          label={t('previz.clip.closeup.motion')}
          value={clip.motion}
          options={MOTIONS.map((motion) => ({
            value: motion,
            label: t(`previz.clip.closeup.motion_${motion}`),
          }))}
          onCommit={(next) => updateCloseup(clip.id, { motion: next })}
        />
        <button
          type="button"
          className={`${ACTION} h-8 w-full`}
          onClick={() => bakeCloseup(clip.id)}
        >
          {t('previz.clip.closeup.bake')}
        </button>
      </section>
    </>
  );
}

/**
 * 选中轨迹点的属性卡。单独裱一层边框、自带标题与关掉的叉：它跟上面那些是两码事——
 * 上面调的是整条片段，这里调的是片段上的一个点，混在同一片行里读不出「现在改的是谁」。
 */
function PointCard({ clip, point }: { clip: PrevizPathClip; point: PrevizPathPoint }) {
  const { t } = useTranslation();
  const selectPathPoint = usePrevizStore((state) => state.selectPathPoint);
  const updateKeyframe = usePrevizStore((state) => state.updateKeyframe);
  const removeKeyframe = usePrevizStore((state) => state.removeKeyframe);

  // 点存的是 `u`（0..1 的弧长参数），不是帧号。标题上报帧号是因为时间轴上找它只能按帧找。
  const frame = Math.round(clip.startFrame + point.u * (clip.endFrame - clip.startFrame));

  const patchPoint = (patch: { position?: Vec3; rotation?: Vec3 | null }) =>
    updateKeyframe(clip.id, point.id, patch);

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
      <header className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-white/85">
          {t('previz.clip.point.section')}
        </span>
        <span className="flex-1 text-[11px] text-white/40">
          {t('previz.clip.point.frame', { frame })}
        </span>
        <button
          type="button"
          className={ICON_BUTTON}
          aria-label={t('previz.clip.point.deselect')}
          title={t('previz.clip.point.deselect')}
          onClick={() => selectPathPoint(null)}
        >
          ✕
        </button>
      </header>

      <Row label={t('previz.clip.point.position')}>
        {(['x', 'y', 'z'] as const).map((axis, index) => (
          // 轴名印在框里而不是每根轴自成一行：三根轴是一个量，摊成三行读起来像三件事。
          <label
            key={axis}
            className="flex h-7 min-w-0 flex-1 items-center gap-0.5 rounded-md border border-white/10 bg-white/[0.04] px-1 focus-within:border-white/25"
          >
            <span className="shrink-0 text-[10px] uppercase text-white/30">{axis}</span>
            <NumberInput
              label={t(`previz.clip.point.${axis}`)}
              value={point.position[index]}
              step={0.1}
              className="w-full min-w-0 bg-transparent text-[11px] text-white/90 outline-none"
              onCommit={(next) => {
                const position: Vec3 = [...point.position];
                position[index] = next;
                patchPoint({ position });
              }}
            />
          </label>
        ))}
      </Row>

      {ANGLE_AXES.map(({ key, index }) => (
        <SliderField
          key={key}
          label={t(`previz.clip.point.${key}`)}
          value={point.rotation[index]}
          min={ANGLE_RANGE.min}
          max={ANGLE_RANGE.max}
          step={1}
          // 交还给自动朝向：`rotationEdited` 一旦置上，这个点的角就固定了，没有这个
          // 按钮，手滑改过一次之后只能删掉重插。三根轴共用一个——手改过的是整个朝向，
          // domain 里没有「只把这一根轴还给切线」这回事。
          trailing={
            index === 1 ? (
              <button
                type="button"
                className={ICON_BUTTON}
                aria-label={t('previz.clip.point.reface')}
                title={t('previz.clip.point.reface')}
                onClick={() => patchPoint({ rotation: null })}
              >
                ↺
              </button>
            ) : (
              <span className="h-6 w-6 shrink-0" aria-hidden />
            )
          }
          onCommit={(next) => {
            const rotation: Vec3 = [...point.rotation];
            rotation[index] = next;
            patchPoint({ rotation });
          }}
        />
      ))}

      <button
        type="button"
        className={DANGER}
        onClick={() => removeKeyframe(clip.id, point.id)}
      >
        {t('previz.clip.point.remove')}
      </button>
    </section>
  );
}

/**
 * 片段与轨迹点属性面板。挂在右侧属性面板下方，只在选中片段时出现。
 *
 * 所有编辑都走数值输入框与按钮，而不是在时间轴条上拖：jsdom 没有布局，拖拽的命中
 * 测试只能对着 mock 的 getBoundingClientRect 断言，等于没测。条上拖拽是 P4 的事。
 */
export function PrevizClipInspector() {
  const { t } = useTranslation();
  const scene = usePrevizStore((state) => state.scene);
  const selectedClipId = usePrevizStore((state) => state.selectedClipId);
  const selectedPointId = usePrevizStore((state) => state.selectedPointId);
  const moveClipBy = usePrevizStore((state) => state.moveClipBy);
  const trimClipToPlayhead = usePrevizStore((state) => state.trimClipToPlayhead);
  const removeClipById = usePrevizStore((state) => state.removeClipById);
  const insertKeyframe = usePrevizStore((state) => state.insertKeyframe);
  const clearPath = usePrevizStore((state) => state.clearPath);
  const setClipEnd = usePrevizStore((state) => state.setClipEnd);
  const setClipAim = usePrevizStore((state) => state.setClipAim);

  const found = selectedClipId ? clipById(scene, selectedClipId) : undefined;
  const clip = found?.clip;
  if (!clip || !found) {
    return (
      <div className="border-t border-white/10 px-3 py-3 text-[12px] text-white/45">
        {t('previz.clip.empty')}
      </div>
    );
  }

  const point: PrevizPathPoint | undefined = isPathClip(clip)
    ? clip.points.find((entry) => entry.id === selectedPointId)
    : undefined;

  // 提示只对机位说：人物走位本来就是朝行进方向走，「保持画轨迹那一刻的朝向」对它是假的。
  const mover = scene.objects.find((object) => object.id === found.track.objectId);
  const aimHint =
    isPathClip(clip) && mover?.kind === 'camera'
      ? clip.aimObjectId
        ? 'previz.clip.aimHintLocked'
        : 'previz.clip.aimHintFree'
      : null;

  return (
    <div className="flex flex-col gap-2 border-t border-white/10 p-3">
      <NumberField
        label={t('previz.clip.startFrame')}
        value={clip.startFrame}
        step={1}
        // 改起点是整条平移：不然「把这段挪后一秒」得改两个框，改错顺序还会先被
        // 最小长度夹一次。
        onCommit={(next) => moveClipBy(clip.id, Math.round(next) - clip.startFrame)}
      />
      <NumberField
        label={t('previz.clip.endFrame')}
        value={clip.endFrame}
        step={1}
        // 终点改的是长度，不是平移，所以走 setClipEnd 而不是 moveClipBy。
        onCommit={(next) => setClipEnd(clip.id, next)}
      />

      {isPathClip(clip) && (
        <>
          <SelectField
            label={t('previz.clip.aim')}
            value={clip.aimObjectId ?? ''}
            // 空串代表「不指定」：`null` 进不了 option 的 value，DOM 会把它变成字符串 "null"。
            options={[
              { value: '', label: t('previz.clip.aimNone') },
              ...scene.objects
                .filter((object) => object.id !== found.track.objectId)
                .map((object) => ({ value: object.id, label: object.name })),
            ]}
            onCommit={(next) => setClipAim(clip.id, next === '' ? null : next)}
          />
          {aimHint && <p className="text-[11px] leading-relaxed text-white/35">{t(aimHint)}</p>}
        </>
      )}

      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          className={ACTION}
          onClick={() => trimClipToPlayhead(clip.id, 'start')}
        >
          {t('previz.clip.trimStart')}
        </button>
        <button type="button" className={ACTION} onClick={() => trimClipToPlayhead(clip.id, 'end')}>
          {t('previz.clip.trimEnd')}
        </button>
        {/* 特写片段身上没有关键帧，这两个按钮按下去只是空转。 */}
        {isPathClip(clip) && (
          <>
            <button type="button" className={ACTION} onClick={() => insertKeyframe(clip.id)}>
              {t('previz.clip.insertPoint')}
            </button>
            <button type="button" className={ACTION} onClick={() => clearPath(clip.id)}>
              {t('previz.clip.clearPoints')}
            </button>
          </>
        )}
      </div>
      <button type="button" className={DANGER} onClick={() => removeClipById(clip.id)}>
        {t('previz.clip.remove')}
      </button>

      {isRigClip(clip) && <CloseupPanel clip={clip} cameraObjectId={found.track.objectId} />}

      {isPathClip(clip) && !point && (
        <p className="text-[11px] text-white/35">{t('previz.clip.point.empty')}</p>
      )}

      {isPathClip(clip) && point && <PointCard clip={clip} point={point} />}
    </div>
  );
}
