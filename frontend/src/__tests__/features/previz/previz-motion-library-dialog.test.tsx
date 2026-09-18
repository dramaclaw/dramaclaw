// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { insertActionClip } from '@/features/previz/domain/actionClips';
import { PREVIZ_MOTION_LIMITS } from '@/features/previz/domain/limits';
import { PREVIZ_BUILTIN_MOTIONS } from '@/features/previz/domain/motionLibrary';
import { createPrevizObject } from '@/features/previz/domain/objects';
import { createDefaultScene, type PrevizImportedMotion, type PrevizScene } from '@/features/previz/domain/scene';
import type { PrevizStagedMotionImport } from '@/features/previz/motionImport';
import {
  PrevizMotionLibraryDialog,
  filterMotionCards,
  motionCards,
} from '@/features/previz/ui/PrevizMotionLibraryDialog';
import { zhT } from '../../helpers/i18n-fixtures';

// 用真中文词条：搜索要对着用户看见的名字测，回显 key 的假 t 会让「搜『走路』」没法写。
vi.mock('react-i18next', async () => {
  const { zhT: t } = await import('../../helpers/i18n-fixtures');
  return { useTranslation: () => ({ t }) };
});

const wave: PrevizImportedMotion = {
  id: 'm1',
  name: '挥手打招呼',
  url: 'https://example.test/wave.glb',
  sourceFileName: 'wave_hello.glb',
  format: 'glb',
  skeleton: 'mixamo',
  clipIndex: 0,
  durationSec: 1.5,
  loop: false,
};

function sceneWithHero(): { scene: PrevizScene; heroId: string } {
  const hero = createPrevizObject('character', [], { name: '女主', color: '#ff8800', heightCm: 165 });
  return { scene: { ...createDefaultScene(), objects: [hero], motions: [wave] }, heroId: hero.id };
}

function setup(overrides: Partial<Parameters<typeof PrevizMotionLibraryDialog>[0]> = {}) {
  const { scene, heroId } = sceneWithHero();
  const onRenderPreview = vi.fn<Parameters<typeof PrevizMotionLibraryDialog>[0]['onRenderPreview']>();
  const props = {
    request: { mode: 'add' as const, objectId: heroId },
    scene,
    frame: 0,
    motionStatus: {},
    onRenderPreview,
    onAdd: vi.fn(() => null),
    onReplace: vi.fn(),
    onClose: vi.fn(),
    onStageImport: vi.fn(async (): Promise<PrevizStagedMotionImport> => staged),
    onCommitImport: vi.fn(async () => true),
    onDiscardImport: vi.fn(),
    onRenameMotion: vi.fn(),
    onRemoveMotion: vi.fn(),
    ...overrides,
  };
  render(<PrevizMotionLibraryDialog {...props} />);
  return { ...props, onRenderPreview, heroId };
}

const staged: PrevizStagedMotionImport = {
  ok: true,
  format: 'bvh',
  skeleton: 'mixamo',
  clips: [{ id: 'm9', clipIndex: 0, name: 'bow', durationSec: 2, truncated: false, loop: false }],
};

const bowFile = new File(['HIERARCHY'], 'bow.bvh');

async function openImported(user: ReturnType<typeof userEvent.setup>) {
  const nav = screen.getByRole('navigation', { name: '动作分类' });
  await user.click(within(nav).getByRole('button', { name: /^已导入/ }));
}

function card(name: RegExp): HTMLElement {
  return within(screen.getByRole('list', { name: '动作列表' })).getByRole('button', { name });
}

describe('motionCards / filterMotionCards', () => {
  const cards = motionCards(zhT, [wave]);

  it('lists every built-in motion plus the imported ones', () => {
    expect(cards).toHaveLength(PREVIZ_BUILTIN_MOTIONS.length + 1);
    expect(cards.find((entry) => entry.id === 'import:m1')).toMatchObject({
      name: '挥手打招呼',
      category: 'imported',
      loop: false,
      durationSec: 1.5,
    });
  });

  it('keeps to the category while the search box is empty', () => {
    const daily = filterMotionCards(cards, 'daily', '');
    expect(daily.length).toBeGreaterThan(0);
    expect(daily.every((entry) => entry.category === 'daily')).toBe(true);
  });

  it('searches every category by the localized name and the English clip name', () => {
    expect(filterMotionCards(cards, 'combat', '走路').map((entry) => entry.id)).toContain('builtin:Walk_Loop');
    expect(filterMotionCards(cards, 'daily', 'walk loop').map((entry) => entry.id)).toContain('builtin:Walk_Loop');
    expect(filterMotionCards(cards, 'daily', 'HELLO').map((entry) => entry.id)).toEqual(['import:m1']);
  });
});

describe('PrevizMotionLibraryDialog', () => {
  it('renders nothing without a request', () => {
    setup({ request: null });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders nothing when the character it was opened for is gone', () => {
    setup({ request: { mode: 'add', objectId: 'nobody' } });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens on the everyday category, with a duration and loop tag on each card', () => {
    setup();
    expect(screen.getByRole('dialog', { name: '添加动作' })).toBeInTheDocument();
    const idle = card(/^站立待机/);
    expect(idle).toHaveTextContent('2.5 秒');
    expect(idle).toHaveTextContent('循环');
    expect(card(/^起身/)).toHaveTextContent('单次');
  });

  it('previews the picked motion on this character and adds it at the playhead', async () => {
    const user = userEvent.setup();
    const props = setup();
    const confirm = screen.getByRole('button', { name: '添加' });
    expect(confirm).toBeDisabled();

    await user.click(card(/^站立待机/));

    const calls = props.onRenderPreview.mock.calls;
    const [, draft, motion] = calls[calls.length - 1]!;
    expect(draft).toMatchObject({ name: '女主', color: '#ff8800', heightCm: 165 });
    expect(motion).toEqual({ primary: { ref: 'builtin:Idle_Loop', time: 0 }, weight: 1 });
    await user.click(confirm);
    expect(props.onAdd).toHaveBeenCalledWith(props.heroId, 'builtin:Idle_Loop');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('says why a motion cannot be added and keeps the button off', async () => {
    const user = userEvent.setup();
    const { scene, heroId } = sceneWithHero();
    // 默认时间轴 120 帧，播放头压在 110：两秒半的循环动作放不下。
    setup({ scene, request: { mode: 'add', objectId: heroId }, frame: 110 });
    await user.click(card(/^站立待机/));
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled();
    expect(screen.getByText('播放头之后放不下这段动作')).toBeInTheDocument();
  });

  it('shows the imported motions in their own category, with the load error', async () => {
    const user = userEvent.setup();
    setup({
      motionStatus: { m1: { state: 'error', error: { code: 'no_animation' } } },
    });
    const nav = screen.getByRole('navigation', { name: '动作分类' });
    await user.click(within(nav).getByRole('button', { name: /^已导入/ }));
    expect(card(/^挥手打招呼/)).toHaveTextContent('文件里没有动画');
  });

  it('replaces the motion of an existing clip, starting on its current motion', async () => {
    const user = userEvent.setup();
    const { scene, heroId } = sceneWithHero();
    const inserted = insertActionClip(scene, heroId, 'import:m1', 0);
    if (!inserted.ok) throw new Error('expected the clip to fit');
    const props = setup({ scene: inserted.scene, request: { mode: 'replace', clipId: inserted.clipId } });

    expect(screen.getByRole('dialog', { name: '更换动作' })).toBeInTheDocument();
    // 从当前那条动作所在的分类开始，并且它已经选中——没换之前「更换」按不下去。
    expect(card(/^挥手打招呼/)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '更换' })).toBeDisabled();

    const nav = screen.getByRole('navigation', { name: '动作分类' });
    await user.click(within(nav).getByRole('button', { name: /^移动/ }));
    await user.click(card(/^走路/));
    await user.click(screen.getByRole('button', { name: '更换' }));
    expect(props.onReplace).toHaveBeenCalledWith(inserted.clipId, 'builtin:Walk_Loop');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('checks a motion file before anything is uploaded, then imports what you confirm', async () => {
    const user = userEvent.setup();
    const props = setup();
    await openImported(user);
    await user.upload(screen.getByLabelText('导入动作文件'), bowFile);
    expect(props.onStageImport).toHaveBeenCalledWith(bowFile);

    const panel = await screen.findByRole('region', { name: '导入动作' });
    expect(panel).toHaveTextContent('bow.bvh · Mixamo 骨架');
    await user.click(within(panel).getByRole('button', { name: '导入' }));
    expect(props.onCommitImport).toHaveBeenCalledWith(bowFile, staged, [{ id: 'm9', name: 'bow', loop: false }]);
    // 导完回到卡片网格，不把刚 prime 的 clip 丢掉——它们已经进场景了。
    expect(await screen.findByRole('list', { name: '动作列表' })).toBeInTheDocument();
    expect(props.onDiscardImport).not.toHaveBeenCalled();
  });

  it('says why a file cannot be imported', async () => {
    const user = userEvent.setup();
    const props = setup({
      onStageImport: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'unsupported_skeleton' as const, missing: ['Hips', 'Spine'] },
      })),
    });
    await openImported(user);
    await user.upload(screen.getByLabelText('导入动作文件'), bowFile);
    expect(await screen.findByRole('alert')).toHaveTextContent('不支持的骨架（支持 UAL / Mixamo / SMPL），缺少：Hips, Spine');
    expect(screen.queryByRole('region', { name: '导入动作' })).toBeNull();
    expect(props.onCommitImport).not.toHaveBeenCalled();
  });

  it('stays on the confirmation when the upload fails, and discards the staged clips on cancel', async () => {
    const user = userEvent.setup();
    const props = setup({ onCommitImport: vi.fn(async () => false) });
    await openImported(user);
    await user.upload(screen.getByLabelText('导入动作文件'), bowFile);
    const panel = await screen.findByRole('region', { name: '导入动作' });
    await user.click(within(panel).getByRole('button', { name: '导入' }));
    expect(await within(panel).findByRole('button', { name: '导入' })).toBeEnabled();

    await user.click(within(panel).getByRole('button', { name: '取消' }));
    expect(props.onDiscardImport).toHaveBeenCalledWith(['m9']);
    expect(screen.getByRole('list', { name: '动作列表' })).toBeInTheDocument();
  });

  it('discards the staged clips when the library closes mid-import', async () => {
    const user = userEvent.setup();
    const props = setup();
    await openImported(user);
    await user.upload(screen.getByLabelText('导入动作文件'), bowFile);
    await screen.findByRole('region', { name: '导入动作' });
    await user.click(screen.getByRole('button', { name: '关闭动作库' }));
    expect(props.onDiscardImport).toHaveBeenCalledWith(['m9']);
    expect(props.onClose).toHaveBeenCalled();
  });

  it('stops offering imports at the limit', async () => {
    const user = userEvent.setup();
    const { scene, heroId } = sceneWithHero();
    const motions = Array.from({ length: PREVIZ_MOTION_LIMITS.imported }, (_, index) => ({ ...wave, id: `m${index}` }));
    setup({ scene: { ...scene, motions }, request: { mode: 'add', objectId: heroId } });
    await openImported(user);
    expect(screen.getByRole('button', { name: '导入动作文件' })).toBeDisabled();
    expect(screen.getByText('导入动作最多 30 条')).toBeInTheDocument();
  });

  it('renames an imported motion in place', async () => {
    const user = userEvent.setup();
    const props = setup();
    await openImported(user);
    const item = card(/^挥手打招呼/).closest('li')!;
    await user.click(within(item).getByRole('button', { name: '重命名' }));
    const input = within(item).getByRole('textbox', { name: '名称' });
    await user.clear(input);
    await user.type(input, '打招呼{Enter}');
    expect(props.onRenameMotion).toHaveBeenCalledWith('m1', '打招呼');
  });

  it('asks before deleting an imported motion and counts the clips that go with it', async () => {
    const user = userEvent.setup();
    const { scene, heroId } = sceneWithHero();
    const inserted = insertActionClip(scene, heroId, 'import:m1', 0);
    if (!inserted.ok) throw new Error('expected the clip to fit');
    const props = setup({ scene: inserted.scene, request: { mode: 'add', objectId: heroId } });
    await openImported(user);
    await user.click(within(card(/^挥手打招呼/).closest('li')!).getByRole('button', { name: '删除' }));

    const confirm = screen.getByRole('alertdialog', { name: '删除「挥手打招呼」？' });
    expect(confirm).toHaveTextContent('1 个片段会一并删除。');
    await user.click(within(confirm).getByRole('button', { name: '删除' }));
    expect(props.onRemoveMotion).toHaveBeenCalledWith('m1');
  });

  it('closes from the close button', async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole('button', { name: '关闭动作库' }));
    expect(props.onClose).toHaveBeenCalled();
  });
});
