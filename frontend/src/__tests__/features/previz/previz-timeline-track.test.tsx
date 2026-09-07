// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  PrevizPathClip,
  PrevizRigClip,
  PrevizCutClip,
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
        <span data-testid="wave" />
      </ClipBar>,
    );
    const bar = screen.getByTestId('previz-clip-c1');
    // 波形必须排在标签之前：排到后面就盖在字上，「画在标签底下」就成了空话。
    expect(bar.firstElementChild).toBe(screen.getByTestId('wave'));
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

  it('labels each kind from its own key, and never calls a cut a path clip', () => {
    expect(renderBar()).toHaveTextContent('previz.timeline.clipLabel');
    expect(renderBar({ clip: rig })).toHaveTextContent('previz.timeline.closeupLabel');
    const bar = renderBar({ clip: cut });
    expect(bar).not.toHaveTextContent('previz.timeline.clipLabel');
    expect(bar).toHaveTextContent('10~40');
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
});
