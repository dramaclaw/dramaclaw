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

/** 空轨提示：只是一行字，pointer-events-none 让点击穿过去落到轨道区上。 */
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
  const noCamera = cameras.length === 0;
  const nameOf = (cameraId: string) =>
    cameras.find((camera) => camera.id === cameraId)?.name ?? cameraId;
  const program = scene.timeline.program;
  const full = program.length >= PREVIZ_MAX_CUTS;
  /*
    两种禁用原因都挂在表头这层，不挂在 select 自己身上：禁用的表单控件不派发鼠标事件，
    title 写在它上面永远弹不出来，用户只看到一只点不动、也不说为什么的下拉。
  */
  const disabledHint = noCamera
    ? t('previz.program.noCamera')
    : full
      ? t('previz.program.limit')
      : undefined;

  return (
    <div
      data-testid="previz-program-track"
      className="flex h-8 items-stretch border-b border-[#1c202a]"
    >
      <div
        title={disabledHint}
        className="sticky left-0 z-30 flex shrink-0 items-center gap-1 bg-[#15181f] pl-1 pr-2"
        style={{ width: PREVIZ_TRACK_HEADER_PX }}
      >
        {/*
          补上对象轨道行那颗展开箭头的位置。镜头轨没有子轨道，但少了这 24px，
          图标与标题会比它下面的每一条轨道都往左错开一截。
        */}
        <span aria-hidden="true" className="h-6 w-6 shrink-0" />
        <SwitchCamera className="h-3.5 w-3.5 shrink-0 text-[#d69a24]" />
        <span className="min-w-0 flex-1 truncate text-xs text-[#c7cedb]">
          {t('previz.program.title')}
        </span>
        <select
          aria-label={t('previz.program.cutTo')}
          value=""
          disabled={noCamera || full}
          className={CUT_PICKER}
          onChange={(event) => {
            if (event.target.value) onCut(event.target.value);
          }}
        >
          {/* 占位项只是下拉收起时的标题，disabled hidden 让它不出现在可选项里。 */}
          <option value="" disabled hidden>
            {t('previz.program.cutTo')}
          </option>
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
