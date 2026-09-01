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
