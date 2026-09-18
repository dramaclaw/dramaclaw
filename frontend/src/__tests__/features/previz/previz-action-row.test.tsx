// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { PrevizActionClip, PrevizImportedMotion, PrevizTrack } from '@/features/previz/domain/scene';
import { PREVIZ_FPS } from '@/features/previz/domain/scene';
import { actionClipMarks, PrevizActionRow } from '@/features/previz/ui/PrevizActionRow';

// 回显 key，带参数时把参数拼在后面：断言要看得出报错原因带没带上缺失的骨骼。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

function action(overrides: Partial<PrevizActionClip> = {}): PrevizActionClip {
  return { id: 'a1', kind: 'action', startFrame: 10, endFrame: 70, motionId: 'builtin:Walk_Loop', ...overrides };
}

const wave: PrevizImportedMotion = {
  id: 'm1',
  name: '挥手',
  url: 'https://example.test/wave.glb',
  sourceFileName: 'wave.glb',
  format: 'glb',
  skeleton: 'mixamo',
  clipIndex: 0,
  durationSec: 1,
  loop: false,
};

function rowProps(clips: PrevizTrack['clips'], overrides: Partial<Parameters<typeof PrevizActionRow>[0]> = {}) {
  return {
    track: { id: 't1', objectId: 'hero', clips } satisfies PrevizTrack,
    pxPerFrame: 2,
    laneWidthPx: 800,
    frame: 0,
    selectedClipId: null,
    motions: [wave],
    motionStatus: {},
    onSelectClip: vi.fn(),
    onTrimClip: vi.fn(),
    onSplit: vi.fn(),
    onAdd: vi.fn(),
    ...overrides,
  };
}

describe('actionClipMarks', () => {
  it('puts a divider at every full loop inside the clip', () => {
    // Walk_Loop 1.333 秒 ≈ 40 帧；10~140 里绕完 3 圈，第 4 圈没绕完不画线。
    const cycle = 1.333 * PREVIZ_FPS;
    const marks = actionClipMarks(action({ endFrame: 140 }), { durationSec: 1.333, loop: true }, 2);
    expect(marks.onceEnd).toBeNull();
    expect(marks.loops).toEqual([10 + cycle, 10 + 2 * cycle, 10 + 3 * cycle]);
  });

  it('drops the dividers when they would be closer than a few pixels', () => {
    const marks = actionClipMarks(action({ endFrame: 110 }), { durationSec: 1.333, loop: true }, 0.1);
    expect(marks.loops).toEqual([]);
  });

  it('marks where a one-shot motion ends, only when that is inside the clip', () => {
    const info = { durationSec: 1, loop: false };
    expect(actionClipMarks(action(), info, 2)).toEqual({ loops: [], onceEnd: 10 + PREVIZ_FPS });
    expect(actionClipMarks(action({ endFrame: 20 }), info, 2).onceEnd).toBeNull();
  });

  it('draws nothing for a motion it cannot resolve', () => {
    expect(actionClipMarks(action(), null, 2)).toEqual({ loops: [], onceEnd: null });
  });
});

describe('PrevizActionRow', () => {
  it('offers to add a motion on an empty row', async () => {
    const props = rowProps([]);
    render(<PrevizActionRow {...props} />);
    await userEvent.click(screen.getByRole('button', { name: 'previz.motion.add' }));
    expect(props.onAdd).toHaveBeenCalledOnce();
  });

  it('draws only the action clips, green and named after the motion', () => {
    const path = { id: 'p1', kind: 'path' as const, startFrame: 0, endFrame: 100, points: [] };
    render(<PrevizActionRow {...rowProps([path, action({ motionId: 'import:m1' })])} />);
    expect(screen.queryByTestId('previz-clip-p1')).toBeNull();
    const bar = screen.getByTestId('previz-clip-a1');
    expect(bar.className).toContain('bg-[#2f8a4a]');
    expect(bar).toHaveTextContent('挥手');
    expect(screen.queryByRole('button', { name: 'previz.motion.add' })).toBeNull();
  });

  it('draws the end of a one-shot motion and loop dividers', () => {
    render(
      <PrevizActionRow
        {...rowProps([
          action({ id: 'a1', motionId: 'import:m1', endFrame: 60 }),
          action({ id: 'a2', motionId: 'builtin:Walk_Loop', startFrame: 100, endFrame: 240 }),
        ])}
      />,
    );
    const once = within(screen.getByTestId('previz-clip-a1')).getByTestId('previz-action-once-end');
    expect(once).toHaveStyle({ left: `${PREVIZ_FPS * 2}px` });
    expect(within(screen.getByTestId('previz-clip-a2')).getAllByTestId('previz-action-loop')).toHaveLength(3);
  });

  it('stripes a clip whose imported motion failed and says why on hover', () => {
    render(
      <PrevizActionRow
        {...rowProps([action({ motionId: 'import:m1' })], {
          motionStatus: { m1: { state: 'error', error: { code: 'unsupported_skeleton', missing: ['Hips', 'Spine'] } } },
        })}
      />,
    );
    const stripes = screen.getByTestId('previz-action-error');
    expect(stripes.getAttribute('title')).toBe('previz.motion.error.unsupported_skeleton:{"bones":"Hips, Spine"}');
  });

  it('splits the action clip under the playhead, not a path clip', async () => {
    const path = { id: 'p1', kind: 'path' as const, startFrame: 0, endFrame: 100, points: [] };
    const props = rowProps([path, action()], { frame: 20 });
    render(<PrevizActionRow {...props} />);
    await userEvent.click(screen.getByRole('button', { name: 'previz.motion.razor' }));
    expect(props.onSplit).toHaveBeenCalledWith('a1');
  });

  it('turns the razor off when the playhead is not over an action clip', () => {
    render(<PrevizActionRow {...rowProps([action()], { frame: 90 })} />);
    expect(screen.getByRole('button', { name: 'previz.motion.razor' })).toBeDisabled();
  });

  it('selects and trims through the shared clip bar', async () => {
    const props = rowProps([action()]);
    render(<PrevizActionRow {...props} />);
    await userEvent.click(screen.getByTestId('previz-clip-a1'));
    expect(props.onSelectClip).toHaveBeenCalledWith('a1');
    const end = within(screen.getByTestId('previz-clip-a1')).getByRole('slider', { name: 'previz.timeline.trimEnd' });
    end.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(props.onTrimClip).toHaveBeenCalledWith('a1', 'end', 71);
  });
});
