// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from 'react-i18next';

import { PREVIZ_RIG_ANCHOR_FRACTION } from '../domain/closeup';
import type {
  PrevizPathPoint,
  PrevizRigClip,
  RigAnchorPart,
  RigBearing,
  RigMotion,
  Vec3,
} from '../domain/scene';
import { clipById, isPathClip, isRigClip } from '../domain/timeline';
import { usePrevizStore } from '../store';

const FIELD =
  'w-16 rounded bg-[#1d222b] px-1 py-0.5 text-right text-xs text-[#c7cedb] outline-none';
const ACTION = 'rounded bg-[#242a35] px-2 py-1 text-xs text-[#c7cedb] hover:bg-[#2f3644]';
const SELECT = 'rounded bg-[#1d222b] px-1 py-0.5 text-xs text-[#c7cedb] outline-none';
const SECTION = 'text-[10px] uppercase tracking-wide text-[#6d7585]';

/** 锚点从低到高。顺序照身体来，下拉里才好按「往上挪一格」读。 */
const ANCHOR_PARTS = Object.keys(PREVIZ_RIG_ANCHOR_FRACTION) as RigAnchorPart[];
const MOTIONS: RigMotion[] = ['static', 'orbit', 'push', 'pull'];
const BEARINGS: RigBearing[] = ['front', 'custom'];

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
    <label className="flex items-center gap-1 text-[11px] text-[#8b93a3]">
      {label}
      <select
        aria-label={label}
        className={SELECT}
        value={value}
        onChange={(event) => onCommit(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 数字输入框。`key` 挂当前值：外部改动（撤销、拖手柄）要能把框里的字刷新掉。 */
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
    <label className="flex items-center gap-1 text-[11px] text-[#8b93a3]">
      {label}
      <input
        type="number"
        step={step}
        aria-label={label}
        className={FIELD}
        key={value}
        defaultValue={value}
        // onBlur 而不是 onChange：每敲一个字符都提交的话，"1.5" 会先经过 "1."
        // （Number("1.") 是 1）再到 1.5，中间那步是一次白白进 undo 栈的编辑。
        onBlur={(event) => onCommit(Number(event.target.value))}
      />
    </label>
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
    <div className="flex flex-col gap-2">
      <div className={SECTION}>{t('previz.clip.closeup.sectionTracking')}</div>
      <div className="flex flex-wrap items-center gap-2">
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
      </div>

      <div className={SECTION}>{t('previz.clip.closeup.sectionFraming')}</div>
      <div className="flex flex-wrap items-center gap-2">
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
        <NumberField
          label={t('previz.clip.closeup.azimuth')}
          value={clip.azimuth}
          step={1}
          onCommit={(next) => updateCloseup(clip.id, { azimuth: next })}
        />
        <NumberField
          label={t('previz.clip.closeup.elevation')}
          value={clip.elevation}
          step={1}
          onCommit={(next) => updateCloseup(clip.id, { elevation: next })}
        />
      </div>

      <div className={SECTION}>{t('previz.clip.closeup.sectionMotion')}</div>
      <div className="flex flex-wrap items-center gap-2">
        <NumberField
          label={t('previz.clip.closeup.distance')}
          value={clip.distance}
          step={0.05}
          onCommit={(next) => updateCloseup(clip.id, { distance: next })}
        />
        <NumberField
          label={t('previz.clip.closeup.height')}
          value={clip.height}
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
      </div>

      <div className="flex flex-wrap gap-1">
        <button type="button" className={ACTION} onClick={() => bakeCloseup(clip.id)}>
          {t('previz.clip.closeup.bake')}
        </button>
      </div>
    </div>
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
  const updateKeyframe = usePrevizStore((state) => state.updateKeyframe);
  const removeKeyframe = usePrevizStore((state) => state.removeKeyframe);
  const clearPath = usePrevizStore((state) => state.clearPath);
  const setClipEnd = usePrevizStore((state) => state.setClipEnd);

  const found = selectedClipId ? clipById(scene, selectedClipId) : undefined;
  const clip = found?.clip;
  if (!clip || !found) {
    return <div className="px-3 py-2 text-xs text-[#6d7585]">{t('previz.clip.empty')}</div>;
  }

  const point: PrevizPathPoint | undefined = isPathClip(clip)
    ? clip.points.find((entry) => entry.id === selectedPointId)
    : undefined;

  const patchPoint = (patch: { position?: Vec3; rotation?: Vec3 | null }) => {
    if (point) updateKeyframe(clip.id, point.id, patch);
  };

  return (
    <div className="flex flex-col gap-2 border-t border-[#232833] px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
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
      </div>

      <div className="flex flex-wrap gap-1">
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
        <button type="button" className={ACTION} onClick={() => removeClipById(clip.id)}>
          {t('previz.clip.remove')}
        </button>
      </div>

      {isRigClip(clip) && <CloseupPanel clip={clip} cameraObjectId={found.track.objectId} />}

      {isPathClip(clip) && !point && (
        <div className="text-[11px] text-[#6d7585]">{t('previz.clip.point.empty')}</div>
      )}

      {isPathClip(clip) && point && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {(['x', 'y', 'z'] as const).map((axis, index) => (
              <NumberField
                key={axis}
                label={t(`previz.clip.point.${axis}`)}
                value={point.position[index]}
                step={0.1}
                onCommit={(next) => {
                  const position: Vec3 = [...point.position];
                  position[index] = next;
                  patchPoint({ position });
                }}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {(['pitch', 'yaw', 'roll'] as const).map((axis, index) => (
              <NumberField
                key={axis}
                label={t(`previz.clip.point.${axis}`)}
                value={point.rotation[index]}
                step={1}
                onCommit={(next) => {
                  const rotation: Vec3 = [...point.rotation];
                  rotation[index] = next;
                  patchPoint({ rotation });
                }}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              className={ACTION}
              // 交还给自动朝向：`rotationEdited` 一旦置上，这个点的角就固定了，
              // 没有这个按钮，手滑改过一次之后只能删掉重插。
              onClick={() => updateKeyframe(clip.id, point.id, { rotation: null })}
            >
              {t('previz.clip.point.reface')}
            </button>
            <button
              type="button"
              className={ACTION}
              onClick={() => removeKeyframe(clip.id, point.id)}
            >
              {t('previz.clip.point.remove')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
