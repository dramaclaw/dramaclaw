// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CanvasFileDropOverlay } from '@/features/canvas/ui/CanvasFileDropOverlay';

describe('CanvasFileDropOverlay', () => {
  it('presents a compact, non-blocking drop target with supported media', () => {
    const { rerender } = render(<CanvasFileDropOverlay isVisible />);

    const status = screen.getByRole('status', { name: '释放文件以添加到画布' });
    expect(status).toHaveClass('pointer-events-none');
    expect(status).toHaveClass('opacity-100');
    expect(status).toHaveAttribute('aria-hidden', 'false');
    expect(status.children).toHaveLength(1);
    expect(status.querySelector('.border-dashed')).toBeNull();
    expect(screen.getByText('释放到画布')).toBeInTheDocument();
    expect(screen.getByText('将在当前位置自动创建对应节点')).toBeInTheDocument();
    expect(screen.getByText('图片')).toBeInTheDocument();
    expect(screen.getByText('视频')).toBeInTheDocument();
    expect(screen.getByText('音频')).toBeInTheDocument();

    rerender(<CanvasFileDropOverlay isVisible={false} />);
    expect(status).toHaveClass('opacity-0');
    expect(status).toHaveAttribute('aria-hidden', 'true');
  });
});
