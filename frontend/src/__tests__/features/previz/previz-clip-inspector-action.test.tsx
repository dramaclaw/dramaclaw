// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultScene, type PrevizImportedMotion } from '@/features/previz/domain/scene';
import { clipById } from '@/features/previz/domain/timeline';
import { usePrevizStore } from '@/features/previz/store';
import { PrevizClipInspector } from '@/features/previz/ui/PrevizClipInspector';

// 真中文词条：面板上的「48 帧 · 1.6 秒」这类拼接要对着用户看见的字测。
vi.mock('react-i18next', async () => {
  const { zhT: t } = await import('../../helpers/i18n-fixtures');
  return { useTranslation: () => ({ t }) };
});

const wave: PrevizImportedMotion = {
  id: 'm1',
  name: '挥手打招呼',
  url: '/static/wave.glb',
  sourceFileName: 'wave_hello.glb',
  format: 'glb',
  skeleton: 'mixamo',
  clipIndex: 0,
  durationSec: 1.5,
  loop: false,
};

/** 人物身上第 10 帧起放一段动作并选中它。 */
function seedAction(motionId: string): { clipId: string; heroId: string } {
  const store = usePrevizStore.getState();
  store.importMotions([wave]);
  const heroId = store.addObject('character')!;
  store.setTimelineFrame(10);
  expect(usePrevizStore.getState().addActionClip(heroId, motionId)).toBeNull();
  const clipId = usePrevizStore.getState().selectedClipId!;
  return { clipId, heroId };
}

const actionClip = (clipId: string) => clipById(usePrevizStore.getState().scene, clipId)!.clip;

beforeEach(() => {
  usePrevizStore.getState().loadScene(createDefaultScene());
});

describe('PrevizClipInspector action panel', () => {
  it('names the motion and opens the library to replace it', async () => {
    const user = userEvent.setup();
    const { clipId } = seedAction('builtin:Walk_Loop');
    render(<PrevizClipInspector />);
    expect(screen.getByText('走路')).toBeInTheDocument();
    expect(screen.getByText('内置')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '更换动作' }));
    expect(usePrevizStore.getState().motionDialog).toEqual({ mode: 'replace', clipId });
  });

  it('shows the length and fits the clip to one pass of the motion', async () => {
    const user = userEvent.setup();
    const { clipId } = seedAction('import:m1');
    // 单次动作插进来就是自身时长（45 帧）；先拉长到 60 帧，再对齐回去。
    usePrevizStore.getState().setClipEnd(clipId, 70);
    render(<PrevizClipInspector />);
    expect(screen.getByText('60 帧 · 2.0 秒')).toBeInTheDocument();
    expect(screen.getByText('wave_hello.glb · Mixamo')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '对齐动作时长' }));
    expect(actionClip(clipId)).toMatchObject({ startFrame: 10, endFrame: 55 });
    expect(screen.getByText('45 帧 · 1.5 秒')).toBeInTheDocument();
  });

  it('edits the frame range like any other clip', async () => {
    const user = userEvent.setup();
    const { clipId } = seedAction('builtin:Walk_Loop');
    render(<PrevizClipInspector />);
    const start = screen.getByRole('spinbutton', { name: '起始帧' });
    await user.clear(start);
    await user.type(start, '20');
    await user.tab();
    expect(actionClip(clipId).startFrame).toBe(20);
  });

  it('says why an imported motion is not playing', () => {
    seedAction('import:m1');
    usePrevizStore.getState().setMotionStatus({ m1: { state: 'error', error: { code: 'no_animation' } } });
    render(<PrevizClipInspector />);
    expect(screen.getByRole('alert')).toHaveTextContent('文件里没有动画');
  });

  it('removes the clip', async () => {
    const user = userEvent.setup();
    const { clipId } = seedAction('builtin:Walk_Loop');
    render(<PrevizClipInspector />);
    await user.click(screen.getByRole('button', { name: '删除片段' }));
    expect(clipById(usePrevizStore.getState().scene, clipId)).toBeUndefined();
  });
});
