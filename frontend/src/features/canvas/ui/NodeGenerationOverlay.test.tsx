// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeGenerationOverlay } from './NodeGenerationOverlay';

describe('NodeGenerationOverlay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('shows elapsed waiting beyond five minutes without inventing progress', () => {
    render(<NodeGenerationOverlay mode="waiting" startedAt={Date.now()} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在生成文本');
    act(() => vi.advanceTimersByTime(301_000));
    expect(screen.getByRole('status')).toHaveTextContent('5:01');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText('%')).not.toBeInTheDocument();
  });

  it('uses the persisted start time and stops its timer when the node finishes', () => {
    const { unmount } = render(<NodeGenerationOverlay mode="waiting" startedAt={Date.now() - 80_000} />);
    expect(screen.getByRole('status')).toHaveTextContent('1:20');
    unmount();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps media estimated and actual progress unchanged', () => {
    const { rerender } = render(<NodeGenerationOverlay startedAt={Date.now() - 300_000} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '99');
    rerender(<NodeGenerationOverlay percent={42} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
  });
});
