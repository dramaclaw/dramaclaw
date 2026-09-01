// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from 'react-i18next';

import type { PrevizPathPoint, Vec3 } from '../domain/scene';
import { clipById, isPathClip } from '../domain/timeline';
import { usePrevizStore } from '../store';

const FIELD =
  'w-16 rounded bg-[#1d222b] px-1 py-0.5 text-right text-xs text-[#c7cedb] outline-none';
const ACTION = 'rounded bg-[#242a35] px-2 py-1 text-xs text-[#c7cedb] hover:bg-[#2f3644]';

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

  // clipById 交出的是 { track, clip }，这里只要片段本身。
  const clip = selectedClipId ? clipById(scene, selectedClipId)?.clip : undefined;
  if (!clip) {
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
        <button type="button" className={ACTION} onClick={() => insertKeyframe(clip.id)}>
          {t('previz.clip.insertPoint')}
        </button>
        <button type="button" className={ACTION} onClick={() => clearPath(clip.id)}>
          {t('previz.clip.clearPoints')}
        </button>
        <button type="button" className={ACTION} onClick={() => removeClipById(clip.id)}>
          {t('previz.clip.remove')}
        </button>
      </div>

      {!point && (
        <div className="text-[11px] text-[#6d7585]">{t('previz.clip.point.empty')}</div>
      )}

      {point && (
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
