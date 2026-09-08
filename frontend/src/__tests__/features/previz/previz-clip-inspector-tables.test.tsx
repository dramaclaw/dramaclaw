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

/**
 * 在 `at` 处切一刀，切片从那里铺到时间轴末尾，默认 40..120。
 *
 * 默认值特意不是 0：那样片段长度正好等于时间轴总长，`moveClip` 的 `maxFrame - span`
 * 会把它钉死在 0，平移类的断言会在没动过的片段上「通过」。要那条退化的片段就显式传 0。
 */
function seedCut(at = 40): { cutId: string; camA: string; camB: string } {
  const [camA, camB] = twoCameras();
  usePrevizStore.getState().setTimelineFrame(at);
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

  it('translates the whole cut when the start frame is edited', async () => {
    const user = userEvent.setup();
    // 40..120 往前挪 30 帧。留出的空隙与 span 都不贴着 120，夹取不会替平移把 endFrame
    // 定下来；帧号也和音频那条用例不同，抄错了不会碰巧过。
    seedCut(40);
    render(<PrevizClipInspector />);
    const start = screen.getByRole('spinbutton', { name: 'previz.clip.startFrame' });
    await user.clear(start);
    await user.type(start, '10');
    await user.tab();
    // 切片身上没有素材偏移，长度不变是平移唯一看得见的证据：拉左沿只动 startFrame。
    expect(usePrevizStore.getState().scene.timeline.program[0]).toMatchObject({
      startFrame: 10,
      endFrame: 90,
    });
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
    const offset = screen.getByLabelText('previz.clip.audio.offset');
    expect(offset).toHaveValue('0');
    // 只读不是装饰：偏移是裁起点算出来的，能敲进去就等于允许波形和声音错位。
    expect(offset).toHaveAttribute('readonly');
    await user.click(screen.getByRole('button', { name: 'previz.clip.audio.relocate' }));
    expect(usePrevizStore.getState().scene.timeline.audio[0]).toMatchObject({
      id: clipId,
      startFrame: 40,
    });
  });

  it('translates the whole clip when the start frame is edited', async () => {
    const user = userEvent.setup();
    seedAudio();
    render(<PrevizClipInspector />);
    const start = screen.getByRole('spinbutton', { name: 'previz.clip.startFrame' });
    await user.clear(start);
    await user.type(start, '25');
    await user.tab();
    // 10..40 整条右移 15 帧。`endFrame` 跟着走说明这是平移而不是把左沿拉过去，
    // `offsetMs` 还是 0 说明素材入点没被动过——拉左沿会把这 15 帧折算进偏移里。
    expect(usePrevizStore.getState().scene.timeline.audio[0]).toMatchObject({
      startFrame: 25,
      endFrame: 55,
      offsetMs: 0,
    });
  });

  it('shortens the clip when the end frame is edited', async () => {
    const user = userEvent.setup();
    seedAudio();
    render(<PrevizClipInspector />);
    const end = screen.getByRole('spinbutton', { name: 'previz.clip.endFrame' });
    await user.clear(end);
    await user.type(end, '30');
    await user.tab();
    // 10..40 收到 10..30。起点不动才说明改的是长度：这是这个框和上面那个的分工。
    expect(usePrevizStore.getState().scene.timeline.audio[0]).toMatchObject({
      startFrame: 10,
      endFrame: 30,
    });
  });

  it('reads the offset off the clip', async () => {
    const clipId = seedAudio();
    usePrevizStore.getState().setTimelineFrame(25);
    // 每条新片段的偏移都是 0（`insertAudioClip` 写死的），只断言 0 分不出框里是接了
    // 线还是印了个常量。裁一次起点把 15 帧折算成 500 毫秒，这才是那条注释说的事。
    usePrevizStore.getState().trimClipToPlayhead(clipId, 'start');
    render(<PrevizClipInspector />);
    expect(screen.getByLabelText('previz.clip.audio.offset')).toHaveValue('500');
  });

  it('removes the audio clip', async () => {
    const user = userEvent.setup();
    seedAudio();
    render(<PrevizClipInspector />);
    await user.click(screen.getByRole('button', { name: 'previz.clip.remove' }));
    expect(usePrevizStore.getState().scene.timeline.audio).toEqual([]);
  });
});
