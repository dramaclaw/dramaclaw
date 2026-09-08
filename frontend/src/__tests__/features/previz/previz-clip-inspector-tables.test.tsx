// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultScene } from '@/features/previz/domain/scene';
import { usePrevizStore } from '@/features/previz/store';
import { PrevizClipInspector } from '@/features/previz/ui/PrevizClipInspector';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function twoCameras(): [string, string] {
  const store = usePrevizStore.getState();
  const camA = store.addObject('camera');
  const camB = store.addObject('camera');
  if (!camA || !camB) throw new Error('expected both cameras to be created');
  return [camA, camB];
}

function seedCut(): { cutId: string; camA: string; camB: string } {
  const [camA, camB] = twoCameras();
  usePrevizStore.getState().cutToCamera(camA);
  const cutId = usePrevizStore.getState().scene.timeline.program[0]!.id;
  usePrevizStore.getState().selectClip(cutId);
  return { cutId, camA, camB };
}

/**
 * 一秒（30 帧）的素材放在第 10 帧。素材短是有意的：片段铺满到时间轴末尾的话，
 * `moveClip` 会把它夹在原地，「重新定位到播放头」看起来就像没接线。
 */
function seedAudio(): string {
  usePrevizStore
    .getState()
    .addAudioClip(
      { audioUrl: '/static/vo.mp3', sourceName: 'vo.mp3', durationMs: 1000, sourceNodeId: null },
      10,
    );
  const clipId = usePrevizStore.getState().scene.timeline.audio[0]!.id;
  usePrevizStore.getState().selectClip(clipId);
  return clipId;
}

beforeEach(() => {
  usePrevizStore.getState().loadScene(createDefaultScene());
});

describe('PrevizClipInspector cut panel', () => {
  it('lets the cut be retargeted to another camera', async () => {
    const user = userEvent.setup();
    const { cutId, camB } = seedCut();
    render(<PrevizClipInspector />);
    const camera = screen.getByRole('combobox', { name: 'previz.clip.cut.camera' });
    await user.selectOptions(camera, camB);
    expect(usePrevizStore.getState().scene.timeline.program[0]).toMatchObject({
      id: cutId,
      cameraId: camB,
    });
  });

  it('edits the frame range and removes the cut', async () => {
    const user = userEvent.setup();
    const { cutId } = seedCut();
    render(<PrevizClipInspector />);
    // 数字框只在失焦时提交，敲完得挪走焦点，见 `NumberInput` 的说明。
    const end = screen.getByRole('spinbutton', { name: 'previz.clip.endFrame' });
    await user.clear(end);
    await user.type(end, '45');
    await user.tab();
    expect(usePrevizStore.getState().scene.timeline.program[0]).toMatchObject({
      id: cutId,
      endFrame: 45,
    });
    await user.click(screen.getByRole('button', { name: 'previz.clip.remove' }));
    expect(usePrevizStore.getState().scene.timeline.program).toEqual([]);
  });

  it('does not offer the object-clip controls on a cut', () => {
    seedCut();
    render(<PrevizClipInspector />);
    expect(screen.queryByRole('combobox', { name: 'previz.clip.aim' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'previz.clip.insertPoint' })).toBeNull();
  });
});

describe('PrevizClipInspector audio panel', () => {
  it('shows the source, the offset and moves the clip to the playhead', async () => {
    const user = userEvent.setup();
    const clipId = seedAudio();
    usePrevizStore.getState().setTimelineFrame(40);
    render(<PrevizClipInspector />);
    expect(screen.getByText('vo.mp3')).toBeInTheDocument();
    expect(screen.getByLabelText('previz.clip.audio.offset')).toHaveValue('0');
    await user.click(screen.getByRole('button', { name: 'previz.clip.audio.relocate' }));
    expect(usePrevizStore.getState().scene.timeline.audio[0]).toMatchObject({
      id: clipId,
      startFrame: 40,
    });
  });

  it('removes the audio clip', async () => {
    const user = userEvent.setup();
    seedAudio();
    render(<PrevizClipInspector />);
    await user.click(screen.getByRole('button', { name: 'previz.clip.remove' }));
    expect(usePrevizStore.getState().scene.timeline.audio).toEqual([]);
  });
});
