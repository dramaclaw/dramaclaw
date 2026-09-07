// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, renderHook, screen, within } from '@testing-library/react';
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

/** 场景里放一个人物：切镜选单只该列机位，非机位混进去要看得出来。机位排在前两位。 */
function sceneWithCameras() {
  const base = createDefaultScene();
  const camA = createPrevizObject('camera', base.objects);
  const camB = createPrevizObject('camera', [camA]);
  const hero = createPrevizObject('character', [camA, camB]);
  return {
    scene: { ...base, objects: [camA, camB, hero] },
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

  it('explains on the header why the dropdown is dead', () => {
    const { rerender } = render(<PrevizProgramTrack {...trackProps(createDefaultScene())} />);
    /*
      两个禁用原因都得说得出来，而且要说在包着下拉的那层上：禁用的表单控件不派发鼠标事件，
      title 写在 select 自己身上就永远看不到。所以这里查的是「带解释的祖先裹着那只下拉」。
    */
    const noCameras = within(screen.getByTitle('previz.program.noCamera'));
    expect(noCameras.getByRole('combobox', { name: 'previz.program.cutTo' })).toBeDisabled();

    const { scene, camA } = sceneWithCameras();
    const program: PrevizCutClip[] = Array.from({ length: PREVIZ_MAX_CUTS }, (_, i) => ({
      id: `c${i}`,
      kind: 'cut',
      startFrame: i,
      endFrame: i + 1,
      cameraId: camA,
    }));
    rerender(<PrevizProgramTrack {...trackProps(withProgram(scene, program))} />);
    const atLimit = within(screen.getByTitle('previz.program.limit'));
    expect(atLimit.getByRole('combobox', { name: 'previz.program.cutTo' })).toBeDisabled();

    // 能切的时候不挂 title：一只好用的下拉不需要解释自己为什么好用。
    rerender(<PrevizProgramTrack {...trackProps(scene)} />);
    expect(screen.queryByTitle('previz.program.noCamera')).toBeNull();
    expect(screen.queryByTitle('previz.program.limit')).toBeNull();
  });

  it('lists only the cameras in the dropdown', () => {
    const { scene } = sceneWithCameras();
    render(<PrevizProgramTrack {...trackProps(scene)} />);
    const picker = screen.getByRole('combobox', { name: 'previz.program.cutTo' });
    /*
      可选项只有两台机位：人物切不了镜。查询故意不带 hidden——带上的话，把机位也藏起来
      （一只对真人空空如也的下拉）照样能过。占位项则反过来钉住：它得在，但不可选。
    */
    const options = within(picker).queryAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      scene.objects[0]!.name,
      scene.objects[1]!.name,
    ]);
    // 藏起来的元素算不出可访问名，占位项只能按 DOM 顺序取第一个。
    const placeholder = within(picker).getAllByRole('option', { hidden: true })[0]!;
    expect(placeholder).toHaveTextContent('previz.program.cutTo');
    expect(placeholder).toBeDisabled();
  });

  it('ignores a change back to the placeholder', () => {
    const { scene, camB } = sceneWithCameras();
    const onCut = vi.fn();
    render(<PrevizProgramTrack {...trackProps(scene, { onCut })} />);
    const picker = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'previz.program.cutTo',
    });
    /*
      这条钉的是不变量，不是在复现用户操作：占位项带着 disabled hidden，真人选不回它。
      守卫防的是将来有人把 disabled hidden 去掉，空值一路走到 onCut('') 上。
      受控的 select 值恒为空，只能先用 React 改写过的 setter 把值顶到机位上（连它的值
      追踪器一起改），再派发一次回到空值的 change——改用 userEvent 驱动等于把覆盖删掉。
    */
    picker.value = camB;
    fireEvent.change(picker, { target: { value: '' } });
    expect(onCut).not.toHaveBeenCalled();
  });

  it('resets to the placeholder so one camera can be picked twice', async () => {
    const user = userEvent.setup();
    const { scene, camB } = sceneWithCameras();
    const onCut = vi.fn();
    render(<PrevizProgramTrack {...trackProps(scene, { onCut })} />);
    const picker = screen.getByRole('combobox', { name: 'previz.program.cutTo' });
    await user.selectOptions(picker, camB);
    // 选完弹回「切到…」：留着选中值的话，同一台机位在下一个播放头处就切不了第二刀。
    expect(picker).toHaveValue('');
    await user.selectOptions(picker, camB);
    expect(onCut).toHaveBeenCalledTimes(2);
    expect(onCut).toHaveBeenNthCalledWith(2, camB);
  });

  it('paints the cuts in the cut tone', () => {
    const { scene, camA } = sceneWithCameras();
    const program: PrevizCutClip[] = [
      { id: 'c1', kind: 'cut', startFrame: 0, endFrame: 30, cameraId: camA },
    ];
    render(<PrevizProgramTrack {...trackProps(withProgram(scene, program))} />);
    // 橙色是切片的颜色。退回蓝色的话，镜头轨看起来就跟一条普通的轨迹轨道一样。
    expect(screen.getByTestId('previz-clip-c1').className).toContain('bg-[#b8801f]');
  });

  it('marks the selected cut', () => {
    const { scene, camA, camB } = sceneWithCameras();
    const program: PrevizCutClip[] = [
      { id: 'c1', kind: 'cut', startFrame: 0, endFrame: 30, cameraId: camA },
      { id: 'c2', kind: 'cut', startFrame: 30, endFrame: 60, cameraId: camB },
    ];
    const props = trackProps(withProgram(scene, program), { selectedClipId: 'c2' });
    render(<PrevizProgramTrack {...props} />);
    expect(screen.getByTestId('previz-clip-c2').className).toContain('ring-1');
    expect(screen.getByTestId('previz-clip-c1').className).not.toContain('ring-1');
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
    const { scene, camA, camB } = sceneWithCameras();
    /*
      直接摆一条满员的镜头轨，不去循环切 60 刀：后者要靠「一刀正好多一段」「最小片段是 1 帧」
      这些 insertCut 的内部约定，约定一变，这条用例的失败信息会变成「段数不对」而不是
      「到上限了却不提示」。每段 6 帧也是为此——切在段中间分成 3+3，将来加最小长度也挡不住。
    */
    const program: PrevizCutClip[] = Array.from({ length: PREVIZ_MAX_CUTS }, (_, i) => ({
      id: `c${i}`,
      kind: 'cut',
      startFrame: i * 6,
      endFrame: i * 6 + 6,
      cameraId: i % 2 ? camA : camB,
    }));
    const full = withProgram(scene, program);
    usePrevizStore.getState().loadScene({
      ...full,
      settings: { ...full.settings, durationFrames: PREVIZ_MAX_CUTS * 6 },
    });
    expect(usePrevizStore.getState().scene.timeline.program).toHaveLength(PREVIZ_MAX_CUTS);
    expect(toast.error).not.toHaveBeenCalled();

    // 3 严格落在第 0 段内部，走的是「截断再新建后半段」那条分支；第 0 段是 camB。
    usePrevizStore.getState().setTimelineFrame(3);
    const { result } = renderHook(() => useCutToCamera());
    result.current(camA);
    expect(toast.error).toHaveBeenCalledWith('previz.program.limit');
    expect(usePrevizStore.getState().scene.timeline.program).toHaveLength(PREVIZ_MAX_CUTS);
  });

  it('stays quiet when the target is not a camera', () => {
    const hero = usePrevizStore.getState().addObject('character')!;
    const { result } = renderHook(() => useCutToCamera());
    // 数字键会打到任何一个对象上，人物身上按 1 只是没得切，不该弹一个错。
    result.current(hero);
    expect(toast.error).not.toHaveBeenCalled();
    expect(usePrevizStore.getState().scene.timeline.program).toHaveLength(0);
  });

  it('stays quiet when the same camera is already live', () => {
    const cam = usePrevizStore.getState().addObject('camera')!;
    const { result } = renderHook(() => useCutToCamera());
    result.current(cam);
    result.current(cam);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
