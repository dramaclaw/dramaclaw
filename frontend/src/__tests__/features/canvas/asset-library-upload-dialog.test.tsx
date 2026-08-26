// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AssetLibraryUploadDialog } from '@/features/canvas/ui/AssetLibraryUploadDialog';

const FOLDERS = [
  {
    key: 'other' as const,
    label: '待分类资产',
    items: [],
    system: true,
    uploadable: true,
  },
];

const CATEGORIES = [
  { key: 'other' as const, label: '其它', media: ['image' as const, 'video' as const] },
];

function renderDialog(onSubmit = vi.fn()) {
  render(
    <AssetLibraryUploadDialog
      open
      folders={FOLDERS}
      categories={CATEGORIES}
      onCreateFolder={vi.fn()}
      onSubmit={onSubmit}
      onClose={vi.fn()}
    />,
  );
  return onSubmit;
}

describe('AssetLibraryUploadDialog', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('明确展示拖放入口与支持格式', () => {
    renderDialog();

    expect(screen.getByText('拖放文件到这里，或点击选择')).toBeInTheDocument();
    expect(screen.getByText(/jpg\/jpeg\/png\/webp/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传' })).toBeDisabled();
  });

  it('不支持的文件不会静默消失', () => {
    renderDialog();
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });

    fireEvent.change(screen.getByLabelText('选择本地文件'), {
      target: { files: [file] },
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      '1 个文件格式不受支持，已自动忽略',
    );
  });

  it('显示选择数量，并在选定保存位置后用明确文案提交', () => {
    const onSubmit = renderDialog();
    const file = new File(['image'], 'cover.png', { type: 'image/png' });

    fireEvent.change(screen.getByLabelText('选择本地文件'), {
      target: { files: [file] },
    });
    expect(screen.getByTitle('cover.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传 1 项' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '选择保存位置' }));
    fireEvent.click(screen.getByRole('button', { name: '待分类资产' }));
    fireEvent.click(screen.getByRole('button', { name: '上传 1 项' }));

    expect(onSubmit).toHaveBeenCalledWith(
      [{ file, media: 'image' }],
      'other',
      null,
    );
  });
});
