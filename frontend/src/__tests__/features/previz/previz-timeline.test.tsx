// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultScene } from '@/features/previz/domain/scene';
import { usePrevizStore } from '@/features/previz/store';
import {
  PREVIZ_TIMELINE_HEIGHT,
  PrevizTimeline,
  clampTimelineHeight,
} from '@/features/previz/ui/PrevizTimeline';

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
    // 4 米、1 m/s = 120 帧，正好铺满默认时间轴：片段长度现在由笔画长度定，
    // 而速度是 store 上的全局设置，loadScene 不复位，得自己钉一遍。
    usePrevizStore.getState().setPathSpeed(1);
    usePrevizStore.getState().drawPath(objectId, [
      [0, 0, 0],
      [4, 0, 0],
    ]);
    return { objectId, clipId: usePrevizStore.getState().scene.timeline.tracks[0].clips[0].id };
  }

  it('lists one row per track, named after the object', () => {
    const { objectId } = seedWalk();
    usePrevizStore.getState().updateObject(objectId, { name: '女主' });
    render(<PrevizTimeline />);

    expect(screen.getByRole('listitem', { name: '女主' })).toBeInTheDocument();
  });

  it('offers to create something when the scene is still empty', () => {
    render(<PrevizTimeline />);

    // 场景里一个对象都没有时，「暂无轨道」是废话——没东西可编排，得先建对象。
    expect(screen.getByText('previz.timeline.emptyNoObjects')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'previz.timeline.createCharacter' }),
    ).toBeInTheDocument();
  });

  it('says the timeline is empty once objects exist', () => {
    usePrevizStore.getState().addObject('character');
    render(<PrevizTimeline />);

    expect(screen.getByText('previz.timeline.empty')).toBeInTheDocument();
    expect(screen.queryByText('previz.timeline.emptyNoObjects')).toBeNull();
  });

  it('hands object creation to the editor so cameras still get their dialog', async () => {
    const user = userEvent.setup();
    const onCreateObject = vi.fn();
    render(<PrevizTimeline onCreateObject={onCreateObject} />);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.createCamera' }));

    // 机位在编辑器里要先过创建对话框，直接调 addObject 就少了取景那一步。
    expect(onCreateObject).toHaveBeenCalledWith('camera');
    expect(usePrevizStore.getState().scene.objects).toHaveLength(0);
  });

  it('places the clip bar by frame', () => {
    const { objectId } = seedWalk();
    const clipId = usePrevizStore.getState().scene.timeline.tracks[0].clips[0].id;
    usePrevizStore.getState().trimClipToPlayhead(clipId, 'start');
    usePrevizStore.getState().setTimelineFrame(30);
    usePrevizStore.getState().trimClipToPlayhead(clipId, 'start');
    render(<PrevizTimeline />);

    const bar = screen.getByTestId(`previz-clip-${clipId}`);
    // 默认比例 120px 每秒、30fps，一帧 4px：30~120 的片段从 120px 开始、占 360px。
    expect(bar).toHaveStyle({ left: '120px', width: '360px' });
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
    seedWalk();
    usePrevizStore.getState().setTimelineFrame(48);
    render(<PrevizTimeline />);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.razor' }));

    expect(usePrevizStore.getState().scene.timeline.tracks[0].clips).toHaveLength(2);
  });

  it('disables the razor when the playhead is off the clip', () => {
    const { clipId } = seedWalk();
    usePrevizStore.getState().setClipEdge(clipId, 'end', 60);
    usePrevizStore.getState().setTimelineFrame(90);
    render(<PrevizTimeline />);

    // 剃刀按轨道走，不按选中走：播放头压不到片段时切在哪儿都没有答案。
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

describe('PrevizTimeline scale', () => {
  beforeEach(() => {
    usePrevizStore.getState().loadScene(createDefaultScene());
  });

  function seedWalk(): string {
    const objectId = usePrevizStore.getState().addObject('character');
    if (!objectId) throw new Error('expected the character to be created');
    // 4 米、1 m/s = 120 帧，正好铺满默认时间轴：片段长度现在由笔画长度定，
    // 而速度是 store 上的全局设置，loadScene 不复位，得自己钉一遍。
    usePrevizStore.getState().setPathSpeed(1);
    usePrevizStore.getState().drawPath(objectId, [
      [0, 0, 0],
      [4, 0, 0],
    ]);
    return objectId;
  }

  it('rules the lane in seconds', () => {
    render(<PrevizTimeline />);

    // 尺子是这次改造的起点：以前整条时间轴只有一根滑块，读不出任何时间位置。
    const ruler = screen.getByTestId('previz-ruler');
    expect(ruler).toHaveTextContent('0s');
    expect(ruler).toHaveTextContent('4s');
  });

  it('puts the playhead where the frame is', () => {
    usePrevizStore.getState().setTimelineFrame(60);
    render(<PrevizTimeline />);

    // 默认 120px 每秒、30fps：第 60 帧是第 2 秒，落在 240px。
    expect(screen.getByTestId('previz-playhead')).toHaveStyle({ left: '240px' });
  });

  it('zooms the scale in and out', async () => {
    const user = userEvent.setup();
    render(<PrevizTimeline />);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.zoomIn' }));
    const zoomedIn = usePrevizStore.getState().timelineZoom;
    expect(zoomedIn).toBeGreaterThan(120);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.zoomOut' }));
    expect(usePrevizStore.getState().timelineZoom).toBeLessThan(zoomedIn);
  });

  it('keeps the keyframes on their own sub-track', async () => {
    const user = userEvent.setup();
    seedWalk();
    render(<PrevizTimeline />);

    expect(screen.getByText('previz.timeline.motionPath')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^previz-keyframe-/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.collapseTrack' }));

    // 折叠起来是为了同时看很多条轨道的片段排布，子轨道跟着收走。
    expect(screen.queryAllByTestId(/^previz-keyframe-/)).toHaveLength(0);
  });

  it('walks the playhead between keyframes', async () => {
    const user = userEvent.setup();
    seedWalk();
    usePrevizStore.getState().setTimelineFrame(0);
    render(<PrevizTimeline />);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.nextKeyframe' }));
    const forward = usePrevizStore.getState().timelineFrame;
    expect(forward).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.prevKeyframe' }));
    expect(usePrevizStore.getState().timelineFrame).toBeLessThan(forward);
  });

  it('trims a clip by dragging its end handle', () => {
    seedWalk();
    render(<PrevizTimeline />);

    const handle = screen.getByRole('slider', { name: 'previz.timeline.trimEnd' });
    fireEvent.pointerDown(handle, { clientX: 480, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 360, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 360, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 0, pointerId: 1 });

    // 一帧 4px：往回拖 120px 就是砍掉 30 帧，120 变 90。松手之后再动不该继续跟。
    expect(usePrevizStore.getState().scene.timeline.tracks[0].clips[0].endFrame).toBe(90);
  });

  it('appends a clip into the gap after the last one', async () => {
    const user = userEvent.setup();
    const objectId = seedWalk();
    const clipId = usePrevizStore.getState().scene.timeline.tracks[0].clips[0].id;
    usePrevizStore.getState().setClipEdge(clipId, 'end', 60);
    render(<PrevizTimeline />);

    await user.click(screen.getByRole('button', { name: 'previz.timeline.appendClip' }));

    expect(usePrevizStore.getState().scene.timeline.tracks[0].clips).toHaveLength(2);
    expect(objectId).toBeTruthy();
  });

  it('opens a closeup on a camera track and names what it can track', async () => {
    const user = userEvent.setup();
    const objectId = seedWalk();
    usePrevizStore.getState().updateObject(objectId, { name: '女主' });
    const cameraId = usePrevizStore.getState().addObject('camera');
    usePrevizStore.getState().addObjectToTimeline(cameraId!);
    render(<PrevizTimeline />);

    await user.click(screen.getAllByRole('button', { name: 'previz.timeline.addCloseup' })[0]!);
    // 挑的是「跟谁」，所以列的是对象的名字与它在时间轴上占到的那一段。
    await user.click(screen.getByRole('button', { name: /女主/ }));

    const cameraTrack = usePrevizStore
      .getState()
      .scene.timeline.tracks.find((track) => track.objectId === cameraId);
    const closeup = cameraTrack?.clips.find((clip) => clip.kind === 'rig');
    expect(closeup).toMatchObject({ anchorObjectId: objectId, startFrame: 0, endFrame: 120 });
    // 新建完直接选中：接下来要调的就是取景那几个数。
    expect(usePrevizStore.getState().selectedClipId).toBe(closeup?.id);
  });

  it('keeps the closeup button off tracks that are not cameras', () => {
    seedWalk();
    render(<PrevizTimeline />);

    // 特写是机位的属性。人物轨道上摆一个按下去没反应的按钮，比没有更糟。
    expect(screen.queryByRole('button', { name: 'previz.timeline.addCloseup' })).toBeNull();
  });

  it('has nothing to track when the camera is alone in the scene', async () => {
    const user = userEvent.setup();
    const cameraId = usePrevizStore.getState().addObject('camera');
    usePrevizStore.getState().addObjectToTimeline(cameraId!);
    render(<PrevizTimeline />);

    const button = screen.getByRole('button', { name: 'previz.timeline.addCloseup' });
    expect(button).toBeDisabled();
    await user.click(button);
    // 没得跟的时候不该弹出一个空菜单。
    expect(screen.queryByTestId('previz-closeup-menu')).toBeNull();
  });

  it('pins a track to the top', async () => {
    const user = userEvent.setup();
    const first = seedWalk();
    const second = usePrevizStore.getState().addObject('character');
    usePrevizStore.getState().addObjectToTimeline(second!);
    render(<PrevizTimeline />);

    await user.click(screen.getAllByRole('button', { name: 'previz.timeline.pinTrack' })[1]);

    expect(usePrevizStore.getState().scene.timeline.tracks[0].objectId).toBe(second);
    expect(first).toBeTruthy();
  });
});

describe('PrevizTimeline 面板高度', () => {
  beforeEach(() => {
    usePrevizStore.getState().loadScene(createDefaultScene());
  });

  /** 拖把手：监听挂在 window 上，所以 move / up 都得发给 window。 */
  function dragHandleBy(deltaPx: number) {
    const handle = screen.getByTestId('previz-timeline-resize');
    fireEvent.pointerDown(handle, { clientY: 500 });
    // 往上拖是拉高，所以 clientY 减去 delta。
    fireEvent.pointerMove(window, { clientY: 500 - deltaPx });
    fireEvent.pointerUp(window);
  }

  it('只把默认高度当上限用，不一上来就撑满', () => {
    render(<PrevizTimeline />);

    // 一条轨道的场景本来就该只占两行；先撑到 224 再说等于白白吃掉视口。
    expect(screen.getByTestId('previz-timeline-tracks')).toHaveStyle({
      maxHeight: `${PREVIZ_TIMELINE_HEIGHT.default}px`,
    });
  });

  it('拖过之后按拖出来的高度钉死', () => {
    render(<PrevizTimeline />);

    dragHandleBy(100);

    const tracks = screen.getByTestId('previz-timeline-tracks');
    // 用户亲手拖出来的空白是他自己要的（腾地方往里加轨道），不该再被内容高度收回去。
    expect(tracks).toHaveStyle({ height: '324px' });
    expect(tracks.style.maxHeight).toBe('');
  });

  it('拖得再狠也停在上下限上', () => {
    render(<PrevizTimeline />);

    // jsdom 的窗口高 768，六成是 460.8——上限由窗口这条管着，不是那个 560。
    dragHandleBy(4000);
    expect(screen.getByTestId('previz-timeline-tracks')).toHaveStyle({ height: '461px' });

    dragHandleBy(-4000);
    expect(screen.getByTestId('previz-timeline-tracks')).toHaveStyle({
      height: `${PREVIZ_TIMELINE_HEIGHT.min}px`,
    });
  });

  it('松手之后不再跟着指针跑', () => {
    render(<PrevizTimeline />);

    dragHandleBy(100);
    fireEvent.pointerMove(window, { clientY: 0 });

    // 监听没摘干净的话，松手后指针每动一下面板还在长——而这时用户以为自己在操作别处。
    expect(screen.getByTestId('previz-timeline-tracks')).toHaveStyle({ height: '324px' });
  });

  it('上下键也能调，触控板上精确到几像素太难受', async () => {
    const user = userEvent.setup();
    render(<PrevizTimeline />);

    const handle = screen.getByTestId('previz-timeline-resize');
    handle.focus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByTestId('previz-timeline-tracks')).toHaveStyle({ height: '248px' });

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByTestId('previz-timeline-tracks')).toHaveStyle({ height: '200px' });
  });

  it('上限由窗口高度与绝对值一起管', () => {
    // 矮屏：只写绝对值 560 的话，面板能把 3D 视口整个挤没——而拉高轨道正是为了对着
    // 画面看哪根关键帧对应哪一步。
    expect(clampTimelineHeight(500, 600)).toBe(360);
    // 超宽屏：只按比例的话六成是七八百像素，轨道再多也用不上，剩下全是空白。
    expect(clampTimelineHeight(1000, 2000)).toBe(PREVIZ_TIMELINE_HEIGHT.max);
    // 下界：再矮连一条轨道加它下面那行运动路径都露不全。
    expect(clampTimelineHeight(0, 900)).toBe(PREVIZ_TIMELINE_HEIGHT.min);
  });
});

describe('PrevizTimeline 动作行', () => {
  beforeEach(() => {
    usePrevizStore.getState().loadScene(createDefaultScene());
  });

  it('只给人物轨道画动作行，点「+ 添加动作」为这个人物打开动作库', async () => {
    const user = userEvent.setup();
    const characterId = usePrevizStore.getState().addObject('character')!;
    usePrevizStore.getState().addObjectToTimeline(characterId);
    const cameraId = usePrevizStore.getState().addObject('camera')!;
    usePrevizStore.getState().addObjectToTimeline(cameraId);
    render(<PrevizTimeline />);

    expect(screen.getAllByTestId('previz-action-row')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'previz.motion.add' }));
    expect(usePrevizStore.getState().motionDialog).toEqual({ mode: 'add', objectId: characterId });
  });

  it('把片段画进动作行，点它选中', async () => {
    const user = userEvent.setup();
    const characterId = usePrevizStore.getState().addObject('character')!;
    expect(usePrevizStore.getState().addActionClip(characterId, 'builtin:Wave_Loop')).toBe('unknown-motion');
    expect(usePrevizStore.getState().addActionClip(characterId, 'builtin:Walk_Loop')).toBeNull();
    const clipId = usePrevizStore.getState().selectedClipId!;
    usePrevizStore.getState().selectClip(null);
    render(<PrevizTimeline />);

    const row = screen.getByTestId('previz-action-row');
    await user.click(within(row).getByTestId(`previz-clip-${clipId}`));
    expect(usePrevizStore.getState().selectedClipId).toBe(clipId);
  });
});
