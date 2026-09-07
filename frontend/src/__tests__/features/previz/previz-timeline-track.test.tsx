// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { PrevizCutClip, PrevizTrack } from '@/features/previz/domain/scene';
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
    expect(screen.getByTestId('wave')).toBeInTheDocument();
    expect(screen.getByTestId('previz-clip-c1').className).toContain('bg-[#37b39c]');
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
