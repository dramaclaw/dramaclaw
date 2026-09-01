// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultScene, type PrevizPathClip } from '@/features/previz/domain/scene';
import { usePrevizStore } from '@/features/previz/store';
import { PrevizClipInspector } from '@/features/previz/ui/PrevizClipInspector';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function seed(): { clipId: string; pointId: string } {
  usePrevizStore.getState().loadScene(createDefaultScene());
  const objectId = usePrevizStore.getState().addObject('character');
  if (!objectId) throw new Error('expected the character to be created');
  usePrevizStore.getState().drawPath(objectId, [
    [0, 0, 0],
    [6, 0, 0],
  ]);
  const clip = usePrevizStore.getState().scene.timeline.tracks[0].clips[0] as PrevizPathClip;
  usePrevizStore.getState().selectClip(clip.id);
  return { clipId: clip.id, pointId: clip.points[0].id };
}

function currentClip(): PrevizPathClip {
  return usePrevizStore.getState().scene.timeline.tracks[0].clips[0] as PrevizPathClip;
}

describe('PrevizClipInspector', () => {
  beforeEach(() => {
    usePrevizStore.getState().loadScene(createDefaultScene());
  });

  it('says nothing is selected when nothing is', () => {
    render(<PrevizClipInspector />);
    expect(screen.getByText('previz.clip.empty')).toBeInTheDocument();
  });

  it('shows the clip range', () => {
    seed();
    render(<PrevizClipInspector />);

    expect(screen.getByLabelText('previz.clip.startFrame')).toHaveValue(0);
    expect(screen.getByLabelText('previz.clip.endFrame')).toHaveValue(120);
  });

  it('moves the clip by typing a new start frame', async () => {
    const user = userEvent.setup();
    seed();
    // 新画出来的轨迹铺满整条时间轴，而平移是保长度的：不先把时间轴放长，
    // 往后挪这一步会被「片段不许越过末帧」原地夹回去，测不到平移本身。
    usePrevizStore.getState().setDurationFrames(200);
    render(<PrevizClipInspector />);

    const field = screen.getByLabelText('previz.clip.startFrame');
    await user.clear(field);
    await user.type(field, '30');
    await user.tab();

    // 改起点是整条平移，长度不变——不然「把这段挪后一秒」还得再改一次终点。
    expect([currentClip().startFrame, currentClip().endFrame]).toEqual([30, 150]);
  });

  it('trims the head to the playhead', async () => {
    const user = userEvent.setup();
    seed();
    usePrevizStore.getState().setTimelineFrame(40);
    render(<PrevizClipInspector />);

    await user.click(screen.getByRole('button', { name: 'previz.clip.trimStart' }));

    expect(currentClip().startFrame).toBe(40);
  });

  it('trims the tail to the playhead', async () => {
    const user = userEvent.setup();
    seed();
    usePrevizStore.getState().setTimelineFrame(90);
    render(<PrevizClipInspector />);

    await user.click(screen.getByRole('button', { name: 'previz.clip.trimEnd' }));

    expect(currentClip().endFrame).toBe(90);
  });

  it('deletes the clip', async () => {
    const user = userEvent.setup();
    seed();
    render(<PrevizClipInspector />);

    await user.click(screen.getByRole('button', { name: 'previz.clip.remove' }));

    expect(usePrevizStore.getState().scene.timeline.tracks[0].clips).toHaveLength(0);
  });

  it('edits the selected keyframe position', async () => {
    const user = userEvent.setup();
    const { pointId } = seed();
    usePrevizStore.getState().selectPathPoint(pointId);
    render(<PrevizClipInspector />);

    const field = screen.getByLabelText('previz.clip.point.y');
    await user.clear(field);
    await user.type(field, '1.5');
    await user.tab();

    expect(currentClip().points[0].position[1]).toBe(1.5);
  });

  it('marks a hand-turned keyframe as edited', async () => {
    const user = userEvent.setup();
    const { pointId } = seed();
    usePrevizStore.getState().selectPathPoint(pointId);
    render(<PrevizClipInspector />);

    const field = screen.getByLabelText('previz.clip.point.yaw');
    await user.clear(field);
    await user.type(field, '90');
    await user.tab();

    // 手改过的角不能再被切线朝向覆盖，否则改完一转身就被下一次求值抹平。
    expect(currentClip().points[0].rotationEdited).toBe(true);
  });

  it('hands a keyframe back to the tangent', async () => {
    const user = userEvent.setup();
    const { pointId } = seed();
    usePrevizStore.getState().selectPathPoint(pointId);
    usePrevizStore.getState().updateKeyframe(currentClip().id, pointId, { rotation: [0, 90, 0] });
    render(<PrevizClipInspector />);

    await user.click(screen.getByRole('button', { name: 'previz.clip.point.reface' }));

    expect(currentClip().points[0].rotationEdited).toBe(false);
  });

  it('deletes the selected keyframe', async () => {
    const user = userEvent.setup();
    const { pointId } = seed();
    const before = currentClip().points.length;
    usePrevizStore.getState().selectPathPoint(pointId);
    render(<PrevizClipInspector />);

    await user.click(screen.getByRole('button', { name: 'previz.clip.point.remove' }));

    expect(currentClip().points).toHaveLength(before - 1);
    expect(usePrevizStore.getState().selectedPointId).toBeNull();
  });

  it('inserts a keyframe at the playhead', async () => {
    const user = userEvent.setup();
    seed();
    const before = currentClip().points.length;
    usePrevizStore.getState().setTimelineFrame(37);
    render(<PrevizClipInspector />);

    await user.click(screen.getByRole('button', { name: 'previz.clip.insertPoint' }));

    expect(currentClip().points).toHaveLength(before + 1);
  });

  it('clears every keyframe', async () => {
    const user = userEvent.setup();
    seed();
    render(<PrevizClipInspector />);

    await user.click(screen.getByRole('button', { name: 'previz.clip.clearPoints' }));

    expect(currentClip().points).toHaveLength(0);
  });

  it('prompts to pick a keyframe when none is selected', () => {
    seed();
    render(<PrevizClipInspector />);

    expect(screen.getByText('previz.clip.point.empty')).toBeInTheDocument();
    expect(screen.queryByLabelText('previz.clip.point.y')).not.toBeInTheDocument();
  });
});
