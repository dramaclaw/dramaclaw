// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { createCharacterDraft } from '@/features/previz/domain/characterDraft';
import type { PrevizStagedMotionImport } from '@/features/previz/motionImport';
import { PrevizMotionImportPanel } from '@/features/previz/ui/PrevizMotionImportPanel';

vi.mock('react-i18next', async () => {
  const { zhT: t } = await import('../../helpers/i18n-fixtures');
  return { useTranslation: () => ({ t }) };
});

type Staged = Extract<PrevizStagedMotionImport, { ok: true }>;

const single: Staged = {
  ok: true,
  format: 'glb',
  skeleton: 'mixamo',
  clips: [{ id: 'm1', clipIndex: 0, name: 'Wave', durationSec: 1.5, truncated: false, loop: false }],
};

const pair: Staged = {
  ...single,
  clips: [
    ...single.clips,
    { id: 'm2', clipIndex: 1, name: 'Bow', durationSec: 60, truncated: true, loop: true },
  ],
};

function setup(overrides: Partial<Parameters<typeof PrevizMotionImportPanel>[0]> = {}) {
  const onRenderPreview = vi.fn<Parameters<typeof PrevizMotionImportPanel>[0]['onRenderPreview']>();
  const props = {
    fileName: 'wave.glb',
    staged: single,
    room: 30,
    uploading: false,
    draft: createCharacterDraft([]),
    onRenderPreview,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
  render(<PrevizMotionImportPanel {...props} />);
  return { ...props, onRenderPreview };
}

const lastPreview = (mock: ReturnType<typeof setup>['onRenderPreview']) => {
  const calls = mock.mock.calls;
  return calls[calls.length - 1]![2];
};

describe('PrevizMotionImportPanel', () => {
  it('names the file and skeleton, previews the clip, and imports it with the edits', async () => {
    const user = userEvent.setup();
    const props = setup();
    const panel = screen.getByRole('region', { name: '导入动作' });
    expect(panel).toHaveTextContent('wave.glb · Mixamo 骨架');
    // 只有一条动画时没有什么可挑的，不出勾选框。
    expect(within(panel).queryByRole('checkbox', { name: 'Wave' })).toBeNull();
    expect(lastPreview(props.onRenderPreview)).toEqual({ primary: { ref: 'import:m1', time: 0 }, weight: 1 });

    const name = screen.getByRole('textbox', { name: '名称' });
    await user.clear(name);
    await user.type(name, '挥手');
    await user.click(screen.getByRole('checkbox', { name: '循环播放' }));
    await user.click(screen.getByRole('button', { name: '导入' }));
    expect(props.onConfirm).toHaveBeenCalledWith([{ id: 'm1', name: '挥手', loop: true }]);
  });

  it('lets you pick among several clips and previews the one you point at', async () => {
    const user = userEvent.setup();
    const props = setup({ staged: pair });
    expect(screen.getByText('选择要导入的动画')).toBeInTheDocument();
    expect(screen.getByText('超过 60 秒，将只保留前 60 秒')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '预览 Bow' }));
    expect(lastPreview(props.onRenderPreview)).toEqual({ primary: { ref: 'import:m2', time: 0 }, weight: 1 });

    await user.click(screen.getByRole('checkbox', { name: 'Wave' }));
    await user.click(screen.getByRole('button', { name: '导入' }));
    expect(props.onConfirm).toHaveBeenCalledWith([{ id: 'm2', name: 'Bow', loop: true }]);

    await user.click(screen.getByRole('checkbox', { name: 'Bow' }));
    expect(screen.getByRole('button', { name: '导入' })).toBeDisabled();
  });

  it('will not take more than the remaining room', () => {
    setup({ staged: pair, room: 1 });
    expect(screen.getByRole('button', { name: '导入' })).toBeDisabled();
    expect(screen.getByText('导入动作最多 30 条')).toBeInTheDocument();
  });

  it('locks itself while uploading', () => {
    setup({ uploading: true });
    // 传到一半取消没有意义：请求撤不回来，文件照样落盘。
    expect(screen.getByRole('button', { name: '正在上传…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '名称' })).toBeDisabled();
  });

  it('cancels', async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(props.onCancel).toHaveBeenCalled();
  });
});
