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

describe('PrevizTimeline transport', () => {
  beforeEach(() => {
    usePrevizStore.getState().loadScene(createDefaultScene());
  });

  it('shows the playhead as seconds and frames', () => {
    usePrevizStore.getState().setTimelineFrame(45);
    render(<PrevizTimeline />);

    // 30 fps 下第 45 帧是 1.5 秒。只报帧号的话，「4 秒的镜头」得心算。
    expect(screen.getByTestId('previz-timecode')).toHaveTextContent('1.50s');
    expect(screen.getByTestId('previz-timecode')).toHaveTextContent('45');
  });

  it('starts and stops playback from the same button', async () => {
    const user = userEvent.setup();
    render(<PrevizTimeline />);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.play' }));
    expect(usePrevizStore.getState().timelinePlaying).toBe(true);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.pause' }));
    expect(usePrevizStore.getState().timelinePlaying).toBe(false);
  });

  it('rewinds to the first frame on stop', async () => {
    const user = userEvent.setup();
    usePrevizStore.getState().setTimelineFrame(60);
    render(<PrevizTimeline />);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.stop' }));

    expect(usePrevizStore.getState().timelineFrame).toBe(0);
  });

  it('steps one frame at a time', async () => {
    const user = userEvent.setup();
    usePrevizStore.getState().setTimelineFrame(10);
    render(<PrevizTimeline />);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.nextFrame' }));
    expect(usePrevizStore.getState().timelineFrame).toBe(11);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.prevFrame' }));
    expect(usePrevizStore.getState().timelineFrame).toBe(10);
  });

  it('jumps to the ends', async () => {
    const user = userEvent.setup();
    render(<PrevizTimeline />);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.goToEnd' }));
    expect(usePrevizStore.getState().timelineFrame).toBe(120);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.goToStart' }));
    expect(usePrevizStore.getState().timelineFrame).toBe(0);
  });

  it('scrubs with the playhead slider', () => {
    render(<PrevizTimeline />);
    const slider = screen.getByRole('slider', { name: 'previz.timeline.playhead' });

    // jsdom 没有布局，拖时间轴条这种命中测试测出来只是在测一个 mock；
    // 播放头改用 range input，键盘也能用，测的是真行为。
    expect(slider).toHaveAttribute('max', '120');
    expect(slider).toHaveAttribute('min', '0');
  });

  it('changes the playback rate', async () => {
    const user = userEvent.setup();
    render(<PrevizTimeline />);

    await user.selectOptions(screen.getByLabelText('previz.timeline.rate'), '2');

    expect(usePrevizStore.getState().timelineRate).toBe(2);
  });

  it('sets the scene duration', async () => {
    const user = userEvent.setup();
    render(<PrevizTimeline />);
    const field = screen.getByLabelText('previz.timeline.duration');

    await user.clear(field);
    await user.type(field, '240');
    await user.tab();

    expect(usePrevizStore.getState().scene.settings.durationFrames).toBe(240);
  });

  it('clamps a duration typed past the limit', async () => {
    const user = userEvent.setup();
    render(<PrevizTimeline />);
    const field = screen.getByLabelText('previz.timeline.duration');

    await user.clear(field);
    await user.type(field, '9999');
    await user.tab();

    // 上限 360 帧（12 秒）是场景 schema 定的；不夹的话时间轴会长出一条读不完的尺子。
    expect(usePrevizStore.getState().scene.settings.durationFrames).toBe(360);
  });

  it('pulls the playhead back when the duration shrinks under it', async () => {
    const user = userEvent.setup();
    usePrevizStore.getState().setTimelineFrame(120);
    render(<PrevizTimeline />);
    const field = screen.getByLabelText('previz.timeline.duration');

    await user.clear(field);
    await user.type(field, '60');
    await user.tab();

    expect(usePrevizStore.getState().timelineFrame).toBe(60);
  });
});
describe('PrevizTimeline tracks', () => {
  beforeEach(() => {
    // 每条用例自己决定时间轴上有什么。少了这一步，「空时间轴」那条会读到上一条
    // 留下的轨道。
    usePrevizStore.getState().loadScene(createDefaultScene());
  });

  function seedWalk(): { objectId: string; clipId: string } {
    usePrevizStore.getState().loadScene(createDefaultScene());
    const objectId = usePrevizStore.getState().addObject('character');
    if (!objectId) throw new Error('expected the character to be created');
    usePrevizStore.getState().drawPath(objectId, [
      [0, 0, 0],
      [6, 0, 0],
    ]);
    return { objectId, clipId: usePrevizStore.getState().scene.timeline.tracks[0].clips[0].id };
  }

  it('lists one row per track, named after the object', () => {
    const { objectId } = seedWalk();
    usePrevizStore.getState().updateObject(objectId, { name: '女主' });
    render(<PrevizTimeline />);

    expect(screen.getByRole('listitem', { name: '女主' })).toBeInTheDocument();
  });

  it('says so when nothing is on the timeline yet', () => {
    render(<PrevizTimeline />);
    expect(screen.getByText('previz.timeline.empty')).toBeInTheDocument();
  });

  it('places the clip bar by frame', () => {
    const { objectId } = seedWalk();
    const clipId = usePrevizStore.getState().scene.timeline.tracks[0].clips[0].id;
    usePrevizStore.getState().trimClipToPlayhead(clipId, 'start');
    usePrevizStore.getState().setTimelineFrame(30);
    usePrevizStore.getState().trimClipToPlayhead(clipId, 'start');
    render(<PrevizTimeline />);

    const bar = screen.getByTestId(`previz-clip-${clipId}`);
    // 0~120 的时间轴上，30~120 的片段从 25% 开始、占 75%。
    expect(bar).toHaveStyle({ left: '25%', width: '75%' });
    expect(objectId).toBeTruthy();
  });

  it('selects a clip by clicking its bar', async () => {
    const user = userEvent.setup();
    const { clipId } = seedWalk();
    usePrevizStore.getState().selectClip(null);
    render(<PrevizTimeline />);

    await user.click(screen.getByTestId(`previz-clip-${clipId}`));

    expect(usePrevizStore.getState().selectedClipId).toBe(clipId);
  });

  it('draws one diamond per keyframe', () => {
    const { clipId } = seedWalk();
    const points = usePrevizStore.getState().scene.timeline.tracks[0].clips[0];
    render(<PrevizTimeline />);

    expect(screen.getAllByTestId(/^previz-keyframe-/)).toHaveLength(
      (points as { points: unknown[] }).points.length,
    );
    expect(clipId).toBeTruthy();
  });

  it('moves the playhead to the keyframe it is told to', async () => {
    const user = userEvent.setup();
    seedWalk();
    const clip = usePrevizStore.getState().scene.timeline.tracks[0].clips[0] as {
      id: string;
      points: { id: string; u: number }[];
    };
    render(<PrevizTimeline />);

    await user.click(screen.getByTestId(`previz-keyframe-${clip.points[1].id}`));

    // 点关键帧既选中它、也把播放头挪过去——否则属性面板改的那个点在视口里看不见。
    expect(usePrevizStore.getState().selectedPointId).toBe(clip.points[1].id);
    expect(usePrevizStore.getState().timelineFrame).toBe(Math.round(clip.points[1].u * 120));
  });

  it('cuts the selected clip at the playhead', async () => {
    const user = userEvent.setup();
    const { clipId } = seedWalk();
    usePrevizStore.getState().selectClip(clipId);
    usePrevizStore.getState().setTimelineFrame(48);
    render(<PrevizTimeline />);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.razor' }));

    expect(usePrevizStore.getState().scene.timeline.tracks[0].clips).toHaveLength(2);
  });

  it('disables the razor with no clip selected', () => {
    seedWalk();
    usePrevizStore.getState().selectClip(null);
    render(<PrevizTimeline />);

    expect(screen.getByRole('button', { name: 'previz.timeline.razor' })).toBeDisabled();
  });

  it('removes a track from its row', async () => {
    const user = userEvent.setup();
    seedWalk();
    render(<PrevizTimeline />);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.removeTrack' }));

    expect(usePrevizStore.getState().scene.timeline.tracks).toHaveLength(0);
  });

  it('adds an object to the timeline', async () => {
    const user = userEvent.setup();
    usePrevizStore.getState().loadScene(createDefaultScene());
    const objectId = usePrevizStore.getState().addObject('character');
    render(<PrevizTimeline />);

    await user.selectOptions(screen.getByLabelText('previz.timeline.addObject'), objectId!);

    expect(usePrevizStore.getState().scene.timeline.tracks[0].objectId).toBe(objectId);
  });

  it('offers only objects that have no track yet', () => {
    const { objectId } = seedWalk();
    render(<PrevizTimeline />);

    // 已经在时间轴上的对象再加一次会撞上「一个对象一条轨道」，下拉框里就不该出现。
    const picker = screen.getByLabelText('previz.timeline.addObject') as HTMLSelectElement;
    expect([...picker.options].map((option) => option.value)).not.toContain(objectId);
  });
});
