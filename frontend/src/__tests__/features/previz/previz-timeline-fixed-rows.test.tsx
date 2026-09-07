// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultScene } from '@/features/previz/domain/scene';
import { usePrevizStore } from '@/features/previz/store';
import { PrevizTimeline } from '@/features/previz/ui/PrevizTimeline';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/url-params', () => ({ readUrl: vi.fn(() => ({ project: 'demo' })) }));
vi.mock('@/api/ops', () => ({ uploadFreezoneAudio: vi.fn() }));
vi.mock('@/features/canvas/compose/audioPeaks', () => ({
  PEAK_BUCKETS_PER_SEC: 120,
  loadAudioPeaks: vi.fn(async () => new Float32Array(120)),
}));

function addCameraTrack(): string {
  const cameraId = usePrevizStore.getState().addObject('camera')!;
  usePrevizStore.getState().addObjectToTimeline(cameraId);
  return cameraId;
}

beforeEach(() => {
  vi.clearAllMocks();
  usePrevizStore.getState().loadScene(createDefaultScene());
});

describe('PrevizTimeline fixed rows', () => {
  it('mounts the program row above the tracks and the audio row below', () => {
    render(<PrevizTimeline />);
    const program = screen.getByTestId('previz-program-track');
    const audio = screen.getByTestId('previz-audio-track');
    // compareDocumentPosition 的 FOLLOWING 位：镜头轨在前，音频轨在后。
    expect(program.compareDocumentPosition(audio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('cuts to a camera from its track header and marks it live', async () => {
    const user = userEvent.setup();
    const cameraId = addCameraTrack();
    render(<PrevizTimeline />);
    await user.click(screen.getByRole('button', { name: 'previz.timeline.cutHere' }));
    expect(usePrevizStore.getState().scene.timeline.program).toMatchObject([
      { cameraId, startFrame: 0 },
    ]);
    expect(screen.getByTestId('previz-track-live')).toBeInTheDocument();
  });

  it('cuts to a camera from the program dropdown', async () => {
    const user = userEvent.setup();
    const cameraId = addCameraTrack();
    render(<PrevizTimeline />);
    const picker = screen.getByRole('combobox', { name: 'previz.program.cutTo' });
    await user.selectOptions(picker, cameraId);
    expect(usePrevizStore.getState().scene.timeline.program).toHaveLength(1);
  });

  it('selects a cut so the inspector can pick it up', async () => {
    const user = userEvent.setup();
    const cameraId = addCameraTrack();
    usePrevizStore.getState().cutToCamera(cameraId);
    const cutId = usePrevizStore.getState().scene.timeline.program[0]!.id;
    render(<PrevizTimeline />);
    await user.click(screen.getByTestId(`previz-clip-${cutId}`));
    expect(usePrevizStore.getState().selectedClipId).toBe(cutId);
  });

  it('shows no live badge on a camera the program is not on', () => {
    const first = addCameraTrack();
    addCameraTrack();
    usePrevizStore.getState().cutToCamera(first);
    render(<PrevizTimeline />);
    expect(screen.getAllByTestId('previz-track-live')).toHaveLength(1);
  });
});
