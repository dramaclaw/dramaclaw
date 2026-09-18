// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PrevizCharacterDraft } from '../domain/characterDraft';
import { PREVIZ_MOTION_LIMITS } from '../domain/limits';
import { importMotionRef } from '../domain/motionLibrary';
import { PREVIZ_CHARACTER_PREVIEW_SIZE } from '../engine/characterPreview';
import type { PrevizMotionPick, PrevizStagedMotionImport } from '../motionImport';
import { useMotionPreview, type PrevizMotionPreviewRender } from './useMotionPreview';

const PRIMARY =
  'inline-flex h-8 items-center rounded-md bg-[#3fae5f] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#4cc26d] disabled:cursor-not-allowed disabled:opacity-40';
const SECONDARY =
  'inline-flex h-8 items-center rounded-md px-3 text-[12px] text-white/60 transition-colors hover:bg-white/10 hover:text-white/90 disabled:cursor-not-allowed disabled:opacity-40';

interface Row extends PrevizMotionPick {
  checked: boolean;
}

export interface PrevizMotionImportPanelProps {
  fileName: string;
  staged: Extract<PrevizStagedMotionImport, { ok: true }>;
  /** 还能再导入几条。勾选超过它就不让确认，免得传上去了又被场景上限丢掉。 */
  room: number;
  uploading: boolean;
  draft: PrevizCharacterDraft;
  onRenderPreview: PrevizMotionPreviewRender;
  onCancel: () => void;
  onConfirm: (picks: PrevizMotionPick[]) => void;
}

/**
 * 导入确认框：文件已经在本地解析、重定向完（候选 clip 已 prime 进渲染器），这里决定导哪几条、
 * 叫什么、循不循环，确认之后才上传。
 */
export function PrevizMotionImportPanel({
  fileName,
  staged,
  room,
  uploading,
  draft,
  onRenderPreview,
  onCancel,
  onConfirm,
}: PrevizMotionImportPanelProps) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>(() =>
    staged.clips.map((clip) => ({ id: clip.id, name: clip.name, loop: clip.loop, checked: true })),
  );
  const [previewId, setPreviewId] = useState(staged.clips[0]!.id);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewClip = staged.clips.find((clip) => clip.id === previewId)!;
  useMotionPreview(canvasRef, draft, importMotionRef(previewId), previewClip.durationSec, onRenderPreview);

  const several = staged.clips.length > 1;
  // 只有一条时标签就是「名称」「循环播放」；多条时带上 clip 原名，读屏才分得清是哪一行的。
  const rowLabel = (base: string, clipName: string) => (several ? `${base} · ${clipName}` : base);
  const update = (id: string, patch: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const picked = rows.filter((row) => row.checked);
  const overLimit = picked.length > room;
  const title = t('previz.motion.import.title');

  return (
    <section aria-label={title} className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
          <div>
            <h5 className="text-[13px] font-medium text-white/90">{title}</h5>
            <p className="text-[12px] text-white/45">
              {t('previz.motion.import.fileInfo', {
                file: fileName,
                skeleton: t(`previz.motion.skeleton.${staged.skeleton}`),
              })}
            </p>
          </div>
          {several && <p className="text-[12px] text-white/60">{t('previz.motion.import.clips')}</p>}
          <ul className="flex flex-col gap-2">
            {staged.clips.map((clip) => {
              const row = rows.find((entry) => entry.id === clip.id)!;
              return (
                <li
                  key={clip.id}
                  className={`flex flex-col gap-2 rounded-lg border p-2 ${
                    clip.id === previewId ? 'border-[#3fae5f]' : 'border-white/[0.06]'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {several && (
                      <input
                        type="checkbox"
                        aria-label={clip.name}
                        checked={row.checked}
                        disabled={uploading}
                        onChange={(event) => update(clip.id, { checked: event.target.checked })}
                      />
                    )}
                    <input
                      type="text"
                      aria-label={rowLabel(t('previz.motion.import.name'), clip.name)}
                      value={row.name}
                      disabled={uploading}
                      onChange={(event) => update(clip.id, { name: event.target.value })}
                      className="h-7 min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[12px] text-white/90 outline-none focus:border-white/25"
                    />
                    {several && (
                      <button
                        type="button"
                        aria-pressed={clip.id === previewId}
                        className={SECONDARY}
                        onClick={() => setPreviewId(clip.id)}
                      >
                        {t('previz.motion.import.previewClip', { name: clip.name })}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-white/45">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        aria-label={rowLabel(t('previz.motion.import.loop'), clip.name)}
                        checked={row.loop}
                        disabled={uploading}
                        onChange={(event) => update(clip.id, { loop: event.target.checked })}
                      />
                      <span aria-hidden>{t('previz.motion.import.loop')}</span>
                    </label>
                    <span className="tabular-nums">
                      {t('previz.motion.seconds', { value: clip.durationSec.toFixed(1) })}
                    </span>
                  </div>
                  {clip.truncated && (
                    <p className="text-[11px] text-[#faad14]">
                      {t('previz.motion.import.truncated', { max: PREVIZ_MOTION_LIMITS.durationSec })}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <canvas
          ref={canvasRef}
          aria-label={t('previz.motion.library.preview')}
          width={PREVIZ_CHARACTER_PREVIEW_SIZE.width}
          height={PREVIZ_CHARACTER_PREVIEW_SIZE.height}
          className="h-[415px] w-[230px] shrink-0 rounded-md border border-white/10 bg-black"
        />
      </div>
      <footer className="flex items-center justify-end gap-3 border-t border-white/10 pt-3">
        {overLimit && (
          <p role="status" className="min-w-0 flex-1 truncate text-[12px] text-[#ff7875]">
            {t('previz.motion.import.limit', { max: PREVIZ_MOTION_LIMITS.imported })}
          </p>
        )}
        <button type="button" className={SECONDARY} disabled={uploading} onClick={onCancel}>
          {t('previz.motion.import.cancel')}
        </button>
        <button
          type="button"
          className={PRIMARY}
          disabled={uploading || picked.length === 0 || overLimit}
          onClick={() => onConfirm(picked.map(({ id, name, loop }) => ({ id, name, loop })))}
        >
          {t(uploading ? 'previz.motion.import.uploading' : 'previz.motion.import.confirm')}
        </button>
      </footer>
    </section>
  );
}
