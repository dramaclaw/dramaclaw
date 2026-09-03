// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PREVIZ_RIG_DISTANCE_RANGE } from '@/features/previz/domain/closeup';
import {
  createDefaultScene,
  type PrevizPathClip,
  type PrevizRigClip,
} from '@/features/previz/domain/scene';
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

/** 同 `seed`，但把对象的名字也交出来——「看向」下拉列的是名字。 */
function seedNamed(): { objectId: string; clipId: string } {
  const { clipId } = seed();
  const objectId = usePrevizStore.getState().scene.timeline.tracks[0].objectId;
  return { objectId, clipId };
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

  it('aims the path at another object', async () => {
    const user = userEvent.setup();
    seed();
    const cameraId = usePrevizStore.getState().addObject('camera');
    render(<PrevizClipInspector />);

    await user.selectOptions(screen.getByLabelText('previz.clip.aim'), cameraId!);
    expect(currentClip().aimObjectId).toBe(cameraId);

    // 「不指定」是回到沿切线自动朝向，不是把朝向冻在最后看的那个方向上。
    await user.selectOptions(screen.getByLabelText('previz.clip.aim'), '');
    expect(currentClip().aimObjectId).toBeNull();
  });

  it('keeps the object itself out of its own aim list', () => {
    const { objectId } = seedNamed();
    render(<PrevizClipInspector />);

    // 自己看自己解不出方向。列在下拉里等于摆一个选了没用的选项。
    const options = Array.from(
      screen.getByLabelText('previz.clip.aim').querySelectorAll('option'),
    ).map((option) => option.value);
    expect(options).not.toContain(objectId);
  });

  it('prompts to pick a keyframe when none is selected', () => {
    seed();
    render(<PrevizClipInspector />);

    expect(screen.getByText('previz.clip.point.empty')).toBeInTheDocument();
    expect(screen.queryByLabelText('previz.clip.point.y')).not.toBeInTheDocument();
  });
});

/** 一个人物、一个配角、一台跟着人物的机位。返回的是机位那条特写片段。 */
function seedCloseup(): { clipId: string; leadId: string; sideId: string; cameraId: string } {
  usePrevizStore.getState().loadScene(createDefaultScene());
  const store = () => usePrevizStore.getState();
  const leadId = store().addObject('character');
  const sideId = store().addObject('character');
  const cameraId = store().addObject('camera');
  if (!leadId || !sideId || !cameraId) throw new Error('expected three objects');
  store().updateObject(leadId, { name: '女主' });
  store().updateObject(sideId, { name: '配角' });
  store().addObjectToTimeline(cameraId);
  store().addCloseup(cameraId, { objectId: leadId, name: '女主', startFrame: 0, endFrame: 120 });
  const clipId = store().selectedClipId;
  if (!clipId) throw new Error('expected the new closeup to be selected');
  return { clipId, leadId, sideId, cameraId };
}

function currentRig(): PrevizRigClip {
  const clip = usePrevizStore
    .getState()
    .scene.timeline.tracks.flatMap((track) => track.clips)
    .find((entry) => entry.kind === 'rig');
  if (!clip) throw new Error('expected a rig clip');
  return clip as PrevizRigClip;
}

describe('PrevizClipInspector closeup clips', () => {
  beforeEach(() => {
    usePrevizStore.getState().loadScene(createDefaultScene());
  });

  it('shows framing controls instead of keyframe ones', () => {
    seedCloseup();
    render(<PrevizClipInspector />);

    expect(screen.getByLabelText('previz.clip.closeup.distance')).toHaveValue(2.75);
    // 特写片段身上没有关键帧。这两个按钮按下去本来就是空转，摆着只会让人以为坏了。
    expect(screen.queryByRole('button', { name: 'previz.clip.insertPoint' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'previz.clip.clearPoints' })).toBeNull();
  });

  it('retargets the closeup at another character', async () => {
    const user = userEvent.setup();
    const { sideId } = seedCloseup();
    render(<PrevizClipInspector />);

    await user.selectOptions(screen.getByLabelText('previz.clip.closeup.target'), sideId);

    expect(currentRig().anchorObjectId).toBe(sideId);
    // 「看向」原本跟着目标走，换人之后不该还盯着上一个人。
    expect(currentRig().aimObjectId).toBe(sideId);
  });

  it('moves the anchor up to the head', async () => {
    const user = userEvent.setup();
    seedCloseup();
    render(<PrevizClipInspector />);

    await user.selectOptions(screen.getByLabelText('previz.clip.closeup.anchor'), 'chest');

    expect(currentRig().anchorPart).toBe('chest');
  });

  it('lets the camera keep its own aim', async () => {
    const user = userEvent.setup();
    seedCloseup();
    render(<PrevizClipInspector />);

    await user.selectOptions(screen.getByLabelText('previz.clip.closeup.aim'), 'free');

    // 只定机位不定朝向：位置照样跟着人走，构图留给自己转。
    expect(currentRig().aimObjectId).toBeNull();
  });

  it('wraps a horizontal angle typed past a full turn', async () => {
    const user = userEvent.setup();
    seedCloseup();
    render(<PrevizClipInspector />);

    const field = screen.getByLabelText('previz.clip.closeup.azimuth');
    await user.clear(field);
    await user.type(field, '390');
    await user.tab();

    // 方位是角度不是距离：370° 就是 10°，夹在上限上会让机位停在一个错的方位。
    expect(currentRig().azimuth).toBeCloseTo(30, 6);
  });

  it('clamps a distance typed past the limit', async () => {
    const user = userEvent.setup();
    seedCloseup();
    render(<PrevizClipInspector />);

    const field = screen.getByLabelText('previz.clip.closeup.distance');
    await user.clear(field);
    await user.type(field, '999');
    await user.tab();

    expect(currentRig().distance).toBe(PREVIZ_RIG_DISTANCE_RANGE.max);
  });

  it('switches the camera move to an orbit', async () => {
    const user = userEvent.setup();
    seedCloseup();
    render(<PrevizClipInspector />);

    await user.selectOptions(screen.getByLabelText('previz.clip.closeup.motion'), 'orbit');

    expect(currentRig().motion).toBe('orbit');
  });

  it('bakes the closeup into a path clip', async () => {
    const user = userEvent.setup();
    const { clipId } = seedCloseup();
    render(<PrevizClipInspector />);

    await user.click(screen.getByRole('button', { name: 'previz.clip.closeup.bake' }));

    const clip = usePrevizStore
      .getState()
      .scene.timeline.tracks.flatMap((track) => track.clips)
      .find((entry) => entry.id === clipId);
    // 烤完还是同一条片段，只是从此不再跟着人走——选中不断，属性面板原地换一副面孔。
    expect(clip?.kind).toBe('path');
    expect(usePrevizStore.getState().selectedClipId).toBe(clipId);
    expect(screen.getByText('previz.clip.point.empty')).toBeInTheDocument();
  });
});
