// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

const mocks = vi.hoisted(() => ({ update: vi.fn(), probe: vi.fn(), quote: vi.fn() }));
vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: (selector: (state: { updateNodeData: typeof mocks.update }) => unknown) =>
    selector({ updateNodeData: mocks.update }),
}));
vi.mock('@/api/ops', () => ({
  probeFreezoneVideoUpscale: mocks.probe,
  quoteFreezoneVideoUpscale: mocks.quote,
  submitFreezoneVideoUpscale: vi.fn(),
  fetchFreezoneJobResult: vi.fn(),
}));
vi.mock('@/api/tasks', () => ({ awaitTaskCompletion: vi.fn(), isTaskPollTimeoutError: vi.fn() }));
vi.mock('@/lib/url-params', () => ({ readUrl: () => ({ project: 'project' }) }));
vi.mock('@/features/canvas/application/errorDialog', () => ({ notifyTaskStillRunning: vi.fn() }));
vi.mock('@/features/canvas/application/resumeGeneration', () => ({ generationTaskDescriptor: vi.fn() }));
vi.mock('@xyflow/react', () => ({
  NodeToolbar: ({ children }: { children: ReactNode }) => <>{children}</>,
  Position: { Bottom: 'bottom' },
}));
vi.mock('@/features/canvas/ui/ZoomScaledToolbar', () => ({
  ZoomScaledToolbar: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/credits/credit-visual', () => ({ CreditCostPill: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { VideoUpscaleEditorOverlay } from '@/features/canvas/ui/VideoUpscaleEditorOverlay';

function node(data: Record<string, unknown>): CanvasNode {
  return { id: 'upscale', type: 'videoNode', position: { x: 0, y: 0 }, data: {
    isUpscaleNode: true, upscaleSourceUrl: '/source.mp4', upscaleResolution: '1080p', ...data,
  } } as CanvasNode;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.quote.mockResolvedValue({ display: '10' });
  mocks.probe.mockResolvedValue({
    width: 1280, height: 720, fps: 24, duration: 10,
    enhancement_models: ['topaz', 'standard'],
    upscale_resolutions: ['1080p', '2k'], frame_rate_resolutions: ['1080p'],
  });
});
afterEach(cleanup);

describe('saved video enhancement selection', () => {
  it.each([
    ['standard', 'topaz'], ['topaz', 'standard'], [undefined, 'topaz'],
  ])('preserves saved %s when only %s is available', async (saved, available) => {
    mocks.probe.mockResolvedValue({
      width: 1280, height: 720, fps: 24, duration: 10,
      enhancement_models: [available], upscale_resolutions: ['1080p'], frame_rate_resolutions: ['1080p'],
    });
    render(<VideoUpscaleEditorOverlay node={node({ upscaleEnhancementModel: saved, videoUrl: '/completed.mp4' })} />);
    await screen.findByText('node.videoUpscale.panel.modelUnavailable');
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.quote).not.toHaveBeenCalled();
    expect((screen.getByTitle('node.videoUpscale.panel.submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'node.videoUpscale.panel.model' }));
    fireEvent.click(screen.getByRole('option', { name: available === 'topaz' ? 'Topaz Labs' : 'node.videoUpscale.panel.standardModel' }));
    expect(mocks.update).toHaveBeenCalledWith('upscale', expect.objectContaining({
      upscaleEnhancementModel: available, upscaleModelPendingInitialization: false,
    }));
  });

  it('falls back only while a new node is initializing', async () => {
    mocks.probe.mockResolvedValue({
      width: 1280, height: 720, fps: 24, duration: 10,
      enhancement_models: ['standard'], upscale_resolutions: [], frame_rate_resolutions: [],
    });
    render(<VideoUpscaleEditorOverlay node={node({
      upscaleEnhancementModel: 'topaz', upscaleModelPendingInitialization: true,
    })} />);
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('upscale', {
      upscaleEnhancementModel: 'standard', upscaleModelPendingInitialization: false,
    }));
  });

  it('offers valid Topaz FPS presets and requires an Apollo-compatible resolution above 60 FPS', async () => {
    render(<VideoUpscaleEditorOverlay node={node({
      upscaleEnhancementModel: 'topaz', upscaleTargetFps: 90,
    })} />);
    await waitFor(() => expect(mocks.quote).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'node.videoUpscale.panel.targetFps' }));
    expect(screen.queryByRole('option', { name: '10fps' })).toBeNull();
    expect(screen.queryByRole('option', { name: '12fps' })).toBeNull();
    expect(screen.getByRole('option', { name: '16fps' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '90fps' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '120fps' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'node.videoUpscale.panel.targetFps' }));
    fireEvent.click(screen.getByRole('button', { name: 'node.videoUpscale.panel.resolution' }));
    expect(screen.queryByRole('option', { name: '2K' })).toBeNull();
  });
});
