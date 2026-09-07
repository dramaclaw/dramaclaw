// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

import { PREVIZ_MAX_CUTS } from '@/features/previz/domain/program';
import { createPrevizObject } from '@/features/previz/domain/objects';
import {
  createDefaultScene,
  type PrevizCutClip,
  type PrevizScene,
} from '@/features/previz/domain/scene';
import { usePrevizStore } from '@/features/previz/store';
import { PrevizProgramTrack } from '@/features/previz/ui/PrevizProgramTrack';
import { useCutToCamera } from '@/features/previz/ui/useCutToCamera';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

function sceneWithCameras(
  program: PrevizCutClip[] = [],
): { scene: PrevizScene; camA: string; camB: string } {
  const base = createDefaultScene();
  const camA = createPrevizObject('camera', base.objects);
  const camB = createPrevizObject('camera', [camA]);
  return {
    scene: { ...base, objects: [camA, camB], timeline: { ...base.timeline, program } },
    camA: camA.id,
    camB: camB.id,
  };
}

function trackProps(
  scene: PrevizScene,
  overrides: Partial<Parameters<typeof PrevizProgramTrack>[0]> = {},
) {
  return {
    scene,
    pxPerFrame: 2,
    laneWidthPx: 400,
    selectedClipId: null,
    onSelect: vi.fn(),
    onTrim: vi.fn(),
    onCut: vi.fn(),
    ...overrides,
  };
}

function withProgram(scene: PrevizScene, program: PrevizCutClip[]): PrevizScene {
  return { ...scene, timeline: { ...scene.timeline, program } };
}

describe('PrevizProgramTrack', () => {
  it('lists the cuts with their camera names', () => {
    const { scene, camA, camB } = sceneWithCameras();
    const program: PrevizCutClip[] = [
      { id: 'c1', kind: 'cut', startFrame: 0, endFrame: 30, cameraId: camA },
      { id: 'c2', kind: 'cut', startFrame: 30, endFrame: 60, cameraId: camB },
    ];
    render(<PrevizProgramTrack {...trackProps(withProgram(scene, program))} />);
    expect(screen.getByTestId('previz-program-track')).toBeInTheDocument();
    expect(screen.getByTestId('previz-clip-c1')).toHaveTextContent(scene.objects[0]!.name);
    expect(screen.getByTestId('previz-clip-c2')).toHaveTextContent(scene.objects[1]!.name);
    expect(screen.queryByText('previz.program.empty')).toBeNull();
  });

  it('shows the hint when the program is empty', () => {
    const { scene } = sceneWithCameras();
    render(<PrevizProgramTrack {...trackProps(scene)} />);
    expect(screen.getByText('previz.program.empty')).toBeInTheDocument();
  });

  it('cuts to the camera picked from the header dropdown', async () => {
    const user = userEvent.setup();
    const { scene, camB } = sceneWithCameras();
    const onCut = vi.fn();
    render(<PrevizProgramTrack {...trackProps(scene, { onCut })} />);
    const picker = screen.getByRole('combobox', { name: 'previz.program.cutTo' });
    await user.selectOptions(picker, camB);
    expect(onCut).toHaveBeenCalledWith(camB);
  });

  it('disables the dropdown without cameras and at the cut limit', () => {
    const { rerender } = render(<PrevizProgramTrack {...trackProps(createDefaultScene())} />);
    expect(screen.getByRole('combobox', { name: 'previz.program.cutTo' })).toBeDisabled();
    const { scene, camA } = sceneWithCameras();
    const program = Array.from({ length: PREVIZ_MAX_CUTS }, (_, i) => ({
      id: `c${i}`,
      kind: 'cut' as const,
      startFrame: i,
      endFrame: i + 1,
      cameraId: camA,
    }));
    rerender(<PrevizProgramTrack {...trackProps(withProgram(scene, program))} />);
    expect(screen.getByRole('combobox', { name: 'previz.program.cutTo' })).toBeDisabled();
  });

  it('selects and trims through the callbacks', async () => {
    const user = userEvent.setup();
    const { scene, camA } = sceneWithCameras();
    const program: PrevizCutClip[] = [
      { id: 'c1', kind: 'cut', startFrame: 0, endFrame: 30, cameraId: camA },
    ];
    const onSelect = vi.fn();
    const onTrim = vi.fn();
    const props = trackProps(withProgram(scene, program), { onSelect, onTrim });
    render(<PrevizProgramTrack {...props} />);
    await user.click(screen.getByTestId('previz-clip-c1'));
    expect(onSelect).toHaveBeenCalledWith('c1');
    const endHandle = screen.getByRole('slider', { name: 'previz.timeline.trimEnd' });
    endHandle.focus();
    await user.keyboard('{ArrowRight}');
    expect(onTrim).toHaveBeenCalledWith('c1', 'end', 31);
  });
});

describe('useCutToCamera', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePrevizStore.getState().loadScene(createDefaultScene());
  });

  it('inserts a cut through the store', () => {
    const cam = usePrevizStore.getState().addObject('camera')!;
    const { result } = renderHook(() => useCutToCamera());
    result.current(cam);
    expect(usePrevizStore.getState().scene.timeline.program).toHaveLength(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts when there is no room at the end', () => {
    const cam = usePrevizStore.getState().addObject('camera')!;
    const { durationFrames } = usePrevizStore.getState().scene.settings;
    usePrevizStore.getState().setTimelineFrame(durationFrames);
    const { result } = renderHook(() => useCutToCamera());
    result.current(cam);
    expect(toast.error).toHaveBeenCalledWith('previz.program.noRoom');
  });

  it('toasts when the program is already at the cut limit', () => {
    const camA = usePrevizStore.getState().addObject('camera')!;
    const camB = usePrevizStore.getState().addObject('camera')!;
    const { result } = renderHook(() => useCutToCamera());
    /*
      逐帧交替切镜把上限逼出来：每切一次都落在当前段内部，段被截成两半，段数正好 +1。
      两台机位轮流是必须的——连切同一台会被 same-camera 挡掉，段数永远涨不上去。
    */
    for (let frame = 0; frame < PREVIZ_MAX_CUTS; frame += 1) {
      usePrevizStore.getState().setTimelineFrame(frame);
      result.current(frame % 2 === 0 ? camA : camB);
    }
    expect(usePrevizStore.getState().scene.timeline.program).toHaveLength(PREVIZ_MAX_CUTS);
    expect(toast.error).not.toHaveBeenCalled();

    usePrevizStore.getState().setTimelineFrame(PREVIZ_MAX_CUTS);
    result.current(camA);
    expect(toast.error).toHaveBeenCalledWith('previz.program.limit');
    expect(usePrevizStore.getState().scene.timeline.program).toHaveLength(PREVIZ_MAX_CUTS);
  });

  it('stays quiet when the same camera is already live', () => {
    const cam = usePrevizStore.getState().addObject('camera')!;
    const { result } = renderHook(() => useCutToCamera());
    result.current(cam);
    result.current(cam);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
