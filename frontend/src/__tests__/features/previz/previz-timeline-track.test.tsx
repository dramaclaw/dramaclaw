// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  PrevizActionClip,
  PrevizAudioClip,
  PrevizCutClip,
  PrevizPathClip,
  PrevizRigClip,
  PrevizTrack,
} from '@/features/previz/domain/scene';
import { ClipBar, PrevizTimelineTrack } from '@/features/previz/ui/PrevizTimelineTrack';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const cut: PrevizCutClip = {
  id: 'c1',
  kind: 'cut',
  startFrame: 10,
  endFrame: 40,
  cameraId: 'cam',
};

const path: PrevizPathClip = { id: 'c1', kind: 'path', startFrame: 10, endFrame: 40, points: [] };

const action: PrevizActionClip = {
  id: 'c1',
  kind: 'action',
  startFrame: 10,
  endFrame: 40,
  motionId: 'builtin:Walk_Loop',
};

const audio: PrevizAudioClip = {
  id: 'c1',
  kind: 'audio',
  startFrame: 10,
  endFrame: 40,
  audioUrl: 'https://example.test/a.mp3',
  sourceName: 'a.mp3',
  durationMs: 1000,
  offsetMs: 0,
  sourceNodeId: null,
};

const rig: PrevizRigClip = {
  id: 'c1',
  kind: 'rig',
  startFrame: 10,
  endFrame: 40,
  anchorObjectId: 'hero',
  anchorPart: 'face',
  aimObjectId: 'hero',
  azimuth: 0,
  elevation: 0,
  distance: 3,
  height: 0,
  bearing: 'custom',
  motion: 'static',
};

/**
 * 只改 clip / selected / tone，其余保持默认——这一组用例全在验配色与兜底文案。
 * 查询限定在自己这次 render 的容器里：一个用例里画好几条，片段 id 是重的。
 */
function renderBar(props: Partial<Parameters<typeof ClipBar>[0]> = {}) {
  const { container } = render(
    <ClipBar
      clip={path}
      pxPerFrame={2}
      selected={false}
      onSelect={vi.fn()}
      onTrim={vi.fn()}
      {...props}
    />,
  );
  return within(container).getByTestId('previz-clip-c1');
}

function trackProps(overrides: Partial<Parameters<typeof PrevizTimelineTrack>[0]> = {}) {
  const track: PrevizTrack = { id: 't1', objectId: 'cam', clips: [] };
  return {
    track,
    name: '机位 1',
    kind: 'camera' as const,
    pxPerFrame: 2,
    laneWidthPx: 400,
    frame: 0,
    expanded: false,
    selectedClipId: null,
    selectedPointId: null,
    onToggleExpand: vi.fn(),
    onSelectClip: vi.fn(),
    onSelectPoint: vi.fn(),
    onTrimClip: vi.fn(),
    onSplit: vi.fn(),
    onAppend: vi.fn(),
    onPin: vi.fn(),
    onRemove: vi.fn(),
    onInsertKeyframe: vi.fn(),
    onClearPath: vi.fn(),
    onSeek: vi.fn(),
    closeupTargets: [],
    onAddCloseup: vi.fn(),
    ...overrides,
  };
}

describe('ClipBar', () => {
  it('shows the given label instead of the frame range and paints the tone', () => {
    render(
      <ClipBar
        clip={cut}
        pxPerFrame={2}
        selected={false}
        onSelect={vi.fn()}
        onTrim={vi.fn()}
        label="机位 1"
        tone="cut"
      />,
    );
    const bar = screen.getByTestId('previz-clip-c1');
    expect(bar).toHaveTextContent('机位 1');
    expect(bar).not.toHaveTextContent('previz.timeline.clipLabel');
    expect(bar.className).toContain('bg-[#b8801f]');
    expect(bar).toHaveStyle({ left: '20px', width: '60px' });
  });

  it('renders children under the label', () => {
    render(
      <ClipBar clip={cut} pxPerFrame={2} selected onSelect={vi.fn()} onTrim={vi.fn()} tone="audio">
        <span data-testid="wave" className="absolute inset-0" />
      </ClipBar>,
    );
    const bar = screen.getByTestId('previz-clip-c1');
    expect(bar.firstElementChild).toBe(screen.getByTestId('wave'));
    /*
      光排在前面盖不住：children 是 absolute，标签不定位的话，按 CSS 2.1 附录 E.2 的
      绘制顺序（在流内容第 7 步、z-index 为 auto 的定位元素第 8 步）波形就画在字上面，
      DOM 顺序完全不管用。标签得自己也定位，同为 auto 层级时才轮到「谁在后面谁在上」。
    */
    expect(screen.getByText('10-40').className).toContain('relative');
    expect(bar.className).toContain('bg-[#37b39c]');
  });
});

describe('ClipBar default tone and label', () => {
  it('keeps the path colours when no tone is given', () => {
    expect(renderBar().className).toContain('bg-[#3560ba]');
    expect(renderBar({ selected: true }).className).toContain('bg-[#4a7de0] ring-1 ring-[#a8c4ff]');
  });

  it('keeps the closeup colours for a rig clip with no tone', () => {
    expect(renderBar({ clip: rig }).className).toContain('bg-[#6c43ae]');
    const selected = renderBar({ clip: rig, selected: true });
    expect(selected.className).toContain('bg-[#8a5cd6] ring-1 ring-[#d5bcff]');
  });

  it('paints a cut clip orange even without a tone', () => {
    expect(renderBar({ clip: cut }).className).toContain('bg-[#b8801f]');
  });

  /*
    动作与音频这两行查表没有别的用例经过：动作片段有了自己那一行，得是绿的，和同一条
    人物轨道上的路径蓝分得开；音频得是青的，否则音频轨会带着一条画错色的行静悄悄发出去。
  */
  it('paints action clips green and audio clips teal', () => {
    expect(renderBar({ clip: action }).className).toContain('bg-[#2f8a4a]');
    expect(renderBar({ clip: action })).toHaveTextContent('previz.timeline.clipLabel');
    expect(renderBar({ clip: audio }).className).toContain('bg-[#2a8c7a]');
  });

  it('labels each kind from its own key, and never calls a cut a path clip', () => {
    expect(renderBar()).toHaveTextContent('previz.timeline.clipLabel');
    expect(renderBar({ clip: rig })).toHaveTextContent('previz.timeline.closeupLabel');
    const bar = renderBar({ clip: cut });
    expect(bar).not.toHaveTextContent('previz.timeline.clipLabel');
    expect(bar).toHaveTextContent('10-40');
  });
});

describe('PrevizTimelineTrack camera header', () => {
  it('offers a cut button on camera tracks only', async () => {
    const user = userEvent.setup();
    const onCut = vi.fn();
    render(
      <ul>
        <PrevizTimelineTrack {...trackProps({ onCut })} />
      </ul>,
    );
    await user.click(screen.getByRole('button', { name: 'previz.timeline.cutHere' }));
    expect(onCut).toHaveBeenCalledTimes(1);
  });

  it('hides the cut button on other kinds', () => {
    render(
      <ul>
        <PrevizTimelineTrack {...trackProps({ kind: 'character', onCut: vi.fn() })} />
      </ul>,
    );
    expect(screen.queryByRole('button', { name: 'previz.timeline.cutHere' })).toBeNull();
  });

  it('shows the live badge when told to', () => {
    const { rerender } = render(
      <ul>
        <PrevizTimelineTrack {...trackProps({ live: true })} />
      </ul>,
    );
    expect(screen.getByTestId('previz-track-live')).toHaveTextContent('previz.timeline.live');
    rerender(
      <ul>
        <PrevizTimelineTrack {...trackProps({ live: false })} />
      </ul>,
    );
    expect(screen.queryByTestId('previz-track-live')).toBeNull();
  });

  it('keeps the live badge off non-camera tracks', () => {
    render(
      <ul>
        <PrevizTimelineTrack {...trackProps({ kind: 'character', live: true })} />
      </ul>,
    );
    expect(screen.queryByTestId('previz-track-live')).toBeNull();
  });
});

describe('PrevizTimelineTrack action clips', () => {
  const walk: PrevizActionClip = { ...action, id: 'a1' };
  const route: PrevizPathClip = { ...path, id: 'p1', startFrame: 0, endFrame: 100 };

  it('leaves action clips to their own row and keeps the razor on the path clip', async () => {
    const onSplit = vi.fn();
    const track: PrevizTrack = { id: 't1', objectId: 'hero', clips: [walk, route] };
    render(
      <ul>
        <PrevizTimelineTrack {...trackProps({ track, kind: 'character', frame: 20, onSplit })} />
      </ul>,
    );
    expect(screen.queryByTestId('previz-clip-a1')).toBeNull();
    expect(screen.getByTestId('previz-clip-p1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'previz.timeline.razor' }));
    expect(onSplit).toHaveBeenCalledWith('p1');
  });

  it('does not let an action clip push the append button along', () => {
    const track: PrevizTrack = { id: 't1', objectId: 'hero', clips: [route, { ...walk, endFrame: 180 }] };
    render(
      <ul>
        <PrevizTimelineTrack {...trackProps({ track, kind: 'character' })} />
      </ul>,
    );
    expect(screen.getByRole('button', { name: 'previz.timeline.appendClip' })).toHaveStyle({ left: '204px' });
  });

  it('renders the action row it is given even when collapsed', () => {
    render(
      <ul>
        <PrevizTimelineTrack
          {...trackProps({ kind: 'character', expanded: false, actionRow: <div data-testid="row" /> })}
        />
      </ul>,
    );
    expect(screen.getByTestId('row')).toBeInTheDocument();
  });
});

describe('PrevizTimelineTrack motion path row', () => {
  const closeup: PrevizRigClip = { ...rig, id: 'r1', startFrame: 0, endFrame: 100 };
  const drawn: PrevizPathClip = {
    ...path,
    id: 'p1',
    startFrame: 0,
    endFrame: 100,
    points: [
      { id: 'pt1', u: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { id: 'pt2', u: 1, position: [3, 0, 0], rotation: [0, 0, 0] },
    ],
  };

  /** 表头两个按钮：插入关键帧、清空轨迹。两者都只对路径片段有意义。 */
  function pathButtons() {
    return {
      insert: screen.getByRole('button', { name: 'previz.timeline.insertKeyframe' }),
      clear: screen.getByRole('button', { name: 'previz.timeline.clearPath' }),
    };
  }

  it('greys the buttons out when the playhead sits on a closeup and nothing else', () => {
    const track: PrevizTrack = { id: 't1', objectId: 'cam', clips: [closeup] };
    render(
      <ul>
        <PrevizTimelineTrack {...trackProps({ track, frame: 20, expanded: true })} />
      </ul>,
    );
    const { insert, clear } = pathButtons();
    expect(insert).toBeDisabled();
    expect(clear).toBeDisabled();
  });

  it('acts on the path clip even when a closeup covers the same frame', async () => {
    const onInsertKeyframe = vi.fn();
    const onClearPath = vi.fn();
    const track: PrevizTrack = { id: 't1', objectId: 'cam', clips: [closeup, drawn] };
    render(
      <ul>
        <PrevizTimelineTrack
          {...trackProps({ track, frame: 20, expanded: true, onInsertKeyframe, onClearPath })}
        />
      </ul>,
    );
    const { insert, clear } = pathButtons();
    await userEvent.click(insert);
    await userEvent.click(clear);
    expect(onInsertKeyframe).toHaveBeenCalledWith('p1');
    expect(onClearPath).toHaveBeenCalledWith('p1');
  });

  it('greys the buttons out on a path clip nobody has drawn yet', () => {
    const track: PrevizTrack = { id: 't1', objectId: 'cam', clips: [{ ...drawn, points: [] }] };
    render(
      <ul>
        <PrevizTimelineTrack {...trackProps({ track, frame: 20, expanded: true })} />
      </ul>,
    );
    const { insert, clear } = pathButtons();
    expect(insert).toBeDisabled();
    expect(clear).toBeDisabled();
  });

  it('keeps the razor on whatever clip the playhead is over', async () => {
    const onSplit = vi.fn();
    const track: PrevizTrack = { id: 't1', objectId: 'cam', clips: [closeup] };
    render(
      <ul>
        <PrevizTimelineTrack {...trackProps({ track, frame: 20, expanded: true, onSplit })} />
      </ul>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'previz.timeline.razor' }));
    expect(onSplit).toHaveBeenCalledWith('r1');
  });
});
