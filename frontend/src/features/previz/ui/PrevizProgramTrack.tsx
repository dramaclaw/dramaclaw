// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { SwitchCamera } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PREVIZ_MAX_CUTS } from '../domain/program';
import type { PrevizScene } from '../domain/scene';
import { ClipBar, PREVIZ_TRACK_HEADER_PX } from './PrevizTimelineTrack';

/** 表头那只下拉。样式串太长，拆到行内会把 JSX 挤过 100 列，提成常量。 */
const CUT_PICKER =
  'h-6 max-w-[104px] rounded border border-white/10 bg-white/[0.04] px-1 text-[11px] ' +
  'text-white/80 outline-none focus:border-white/25 disabled:opacity-40';

/** 空轨提示：压在轨道区左边，不能挡住片段条的点击。 */
const EMPTY_HINT =
  'pointer-events-none absolute inset-y-0 left-2 flex items-center text-[11px] text-white/30';

export interface PrevizProgramTrackProps {
  scene: PrevizScene;
  pxPerFrame: number;
  laneWidthPx: number;
  selectedClipId: string | null;
  onSelect: (clipId: string) => void;
  onTrim: (clipId: string, edge: 'start' | 'end', frame: number) => void;
  onCut: (cameraId: string) => void;
}

/**
 * 镜头轨：一条固定行，摆在对象轨道上面。表头的下拉是切镜的第一个入口，
 * 选中即在播放头处切；下拉本身不保持选中值，每次都从「切到…」开始。
 */
export function PrevizProgramTrack({
  scene,
  pxPerFrame,
  laneWidthPx,
  selectedClipId,
  onSelect,
  onTrim,
  onCut,
}: PrevizProgramTrackProps) {
  const { t } = useTranslation();
  const cameras = scene.objects.filter((object) => object.kind === 'camera');
  const nameOf = (cameraId: string) =>
    cameras.find((camera) => camera.id === cameraId)?.name ?? cameraId;
  const program = scene.timeline.program;
  const full = program.length >= PREVIZ_MAX_CUTS;

  return (
    <div
      data-testid="previz-program-track"
      aria-label={t('previz.program.title')}
      className="flex h-8 items-stretch border-b border-[#1c202a]"
    >
      <div
        className="sticky left-0 z-30 flex shrink-0 items-center gap-1 bg-[#15181f] pl-2 pr-2"
        style={{ width: PREVIZ_TRACK_HEADER_PX }}
      >
        <SwitchCamera className="h-3.5 w-3.5 shrink-0 text-[#d69a24]" />
        <span className="min-w-0 flex-1 truncate text-xs text-[#c7cedb]">
          {t('previz.program.title')}
        </span>
        <select
          aria-label={t('previz.program.cutTo')}
          title={full ? t('previz.program.limit') : undefined}
          value=""
          disabled={cameras.length === 0 || full}
          className={CUT_PICKER}
          onChange={(event) => {
            if (event.target.value) onCut(event.target.value);
          }}
        >
          <option value="">{t('previz.program.cutTo')}</option>
          {cameras.map((camera) => (
            <option key={camera.id} value={camera.id}>
              {camera.name}
            </option>
          ))}
        </select>
      </div>

      <div className="relative shrink-0" style={{ width: laneWidthPx }}>
        {program.length === 0 && <span className={EMPTY_HINT}>{t('previz.program.empty')}</span>}
        {program.map((cut) => (
          <ClipBar
            key={cut.id}
            clip={cut}
            pxPerFrame={pxPerFrame}
            selected={cut.id === selectedClipId}
            onSelect={() => onSelect(cut.id)}
            onTrim={(edge, frame) => onTrim(cut.id, edge, frame)}
            label={nameOf(cut.cameraId)}
            tone="cut"
          />
        ))}
      </div>
    </div>
  );
}
