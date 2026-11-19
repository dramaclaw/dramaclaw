// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useLayoutEffect, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FreezoneGenerationHistoryRecord } from '@/api/ops';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

const mocks = vi.hoisted(() => ({
  update: vi.fn(), probe: vi.fn(), quote: vi.fn(), history: vi.fn(), openViewer: vi.fn(),
}));
vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: (selector: (state: { updateNodeData: typeof mocks.update }) => unknown) =>
    selector({ updateNodeData: mocks.update }),
}));
vi.mock('@/api/ops', () => ({
  probeFreezoneVideoUpscale: mocks.probe,
  quoteFreezoneVideoUpscale: mocks.quote,
  submitFreezoneVideoUpscale: vi.fn(),
  fetchFreezoneJobResult: vi.fn(),
  fetchNodeGenerationHistory: mocks.history,
}));
vi.mock('@/api/tasks', () => ({ awaitTaskCompletion: vi.fn(), isTaskPollTimeoutError: vi.fn() }));
vi.mock('@/lib/url-params', () => ({ readUrl: () => ({ project: 'project' }) }));
vi.mock('@/features/canvas/application/errorDialog', () => ({ notifyTaskStillRunning: vi.fn() }));
vi.mock('@/features/canvas/application/resumeGeneration', () => ({ generationTaskDescriptor: vi.fn() }));
vi.mock('@/features/canvas/application/nodeMediaViewer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/canvas/application/nodeMediaViewer')>()),
  openNodeVideoViewer: mocks.openViewer,
}));
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
  mocks.history.mockResolvedValue([]);
  mocks.quote.mockResolvedValue({ display: '10' });
  mocks.probe.mockResolvedValue({
    width: 1280, height: 720, fps: 24, duration: 10,
    enhancement_models: ['topaz', 'standard'],
    upscale_resolutions: ['1080p', '2k'], frame_rate_resolutions: ['1080p'],
  });
});
afterEach(cleanup);

describe('video enhancement history', () => {
  function record(id: string, url: string, timestamp: string): FreezoneGenerationHistoryRecord {
    return {
      schema_version: 1,
      id: `freezone_video_upscale:${id}`,
      canvas_id: 'default',
      node_id: 'upscale',
      task_key: `freezone_video_upscale:${id}`,
      task_type: 'freezone_video_upscale',
      job_id: id,
      recorded_at: timestamp,
      status: 'completed',
      media_type: 'video',
      result: { output_url: url, source_url: '/source.mp4' },
    };
  }

  const old = record('first', '/first.mp4', '2026-11-18T01:01:00Z');
  const latest = record('second', '/second.mp4', '2026-11-18T01:02:00Z');

  it('loads completed outputs on selection and restores an older result without changing the source', async () => {
    mocks.history.mockResolvedValue([latest, old, { ...latest, id: 'failed', status: 'failed' }]);
    render(<VideoUpscaleEditorOverlay node={node({ videoUrl: '/second.mp4' })} />);
    const title = await screen.findByText('canvas.nodeHistory.compactTitle · 2');
    const rail = title.closest('[data-node-history-rail]') as HTMLElement;
    expect(mocks.history).toHaveBeenCalledWith('project', 'default', 'upscale', 100);
    expect(within(rail).getByRole('button', { pressed: true })).toBeTruthy();
    fireEvent.click(within(rail).getByRole('button', { pressed: false }));
    expect(mocks.update).toHaveBeenCalledWith('upscale', expect.objectContaining({ videoUrl: '/first.mp4' }));
    expect(mocks.update.mock.lastCall?.[1]).not.toHaveProperty('upscaleSourceUrl');
    expect(mocks.history).toHaveBeenCalledTimes(1);
  });

  it('refreshes only the selected node history when the completed result arrives', async () => {
    mocks.history.mockResolvedValueOnce([old]).mockResolvedValueOnce([latest, old]);
    const { rerender } = render(<VideoUpscaleEditorOverlay node={node({
      isGenerating: true, videoUrl: '/first.mp4',
    })} />);
    const title = await screen.findByText('canvas.nodeHistory.compactTitle · 1');
    const rail = title.closest('[data-node-history-rail]') as HTMLElement;
    fireEvent.click(within(rail).getByRole('button', { pressed: false }));
    expect(mocks.openViewer).toHaveBeenCalledWith('/first.mp4', 'upscale', ['/first.mp4'], undefined);
    expect(mocks.update).not.toHaveBeenCalled();

    rerender(<VideoUpscaleEditorOverlay node={node({ isGenerating: false, videoUrl: '/second.mp4' })} />);
    await screen.findByText('canvas.nodeHistory.compactTitle · 2');
    expect(mocks.history.mock.calls).toEqual([
      ['project', 'default', 'upscale', 100], ['project', 'default', 'upscale', 100],
    ]);
  });
});

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

  it('offers Claymore as a third workflow with only its supported options', async () => {
    mocks.probe.mockResolvedValue({
      width: 720, height: 1280, fps: 24, duration: 10,
      enhancement_models: ['topaz', 'standard', 'claymore'],
      upscale_resolutions: ['1080p', '2k', '4k'], frame_rate_resolutions: ['1080p'],
    });
    render(<VideoUpscaleEditorOverlay node={node({ upscaleEnhancementModel: 'claymore' })} />);
    await waitFor(() => expect(mocks.quote).toHaveBeenCalledWith('project', expect.objectContaining({
      enhancementModel: 'claymore', slowdown: 'auto', faceEnhance: false,
    })));
    expect(screen.queryByRole('button', { name: 'node.videoUpscale.panel.scene' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'node.videoUpscale.panel.slowdown' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'node.videoUpscale.panel.faceEnhance' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'node.videoUpscale.panel.targetFps' }));
    expect(screen.getByRole('option', { name: '60fps' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: '30fps' })).toBeNull();
    expect(screen.queryByRole('option', { name: '90fps' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'node.videoUpscale.panel.targetFps' }));
    fireEvent.click(screen.getByRole('button', { name: 'node.videoUpscale.panel.model' }));
    expect(screen.getByRole('option', { name: 'node.videoUpscale.panel.claymoreModel' })).toBeTruthy();
  });

  it('keeps pure Claymore upscale available when interpolation is not configured', async () => {
    mocks.probe.mockResolvedValue({
      width: 854, height: 480, fps: 24, duration: 10,
      enhancement_models: ['claymore'], upscale_resolutions: ['1080p', '2k'], frame_rate_resolutions: [],
    });
    render(<VideoUpscaleEditorOverlay node={node({ upscaleEnhancementModel: 'claymore' })} />);
    await waitFor(() => expect((screen.getByTitle('node.videoUpscale.panel.submit') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'node.videoUpscale.panel.targetFps' }));
    expect(screen.queryByRole('option', { name: '60fps' })).toBeNull();
    expect(screen.getByRole('option', { name: 'node.videoUpscale.panel.targetFpsAuto' })).toBeTruthy();
  });

  it.each([
    ['claymore', 'claymore', true],
    ['claymore', 'standard', true],
    ['claymore', 'topaz', true],
    ['standard', 'claymore', true],
    ['topaz', 'claymore', true],
    ['standard', 'standard', false],
    ['topaz', 'topaz', false],
  ])('applies immediate quote matching only for Claymore (%s to %s)', async (before, after, immediatelyDisabled) => {
    mocks.probe.mockResolvedValue({
      width: 1280, height: 720, fps: 24, duration: 10,
      enhancement_models: ['topaz', 'standard', 'claymore'],
      upscale_resolutions: ['1080p', '2k'], frame_rate_resolutions: ['1080p'],
    });
    const submitDisabled = () => (screen.getByTitle('node.videoUpscale.panel.submit') as HTMLButtonElement).disabled;
    let disabledBeforeEffects: boolean | undefined;
    function ObserveQuote({ model, resolution }: { model: string; resolution: string }) {
      useLayoutEffect(() => { disabledBeforeEffects = submitDisabled(); }, [model, resolution]);
      return <VideoUpscaleEditorOverlay node={node({ upscaleEnhancementModel: model, upscaleResolution: resolution })} />;
    }
    const { rerender } = render(<ObserveQuote model={before} resolution="1080p" />);
    await waitFor(() => expect(submitDisabled()).toBe(false));
    mocks.quote.mockImplementation(() => new Promise(() => {}));
    rerender(<ObserveQuote model={after} resolution="2k" />);
    expect(disabledBeforeEffects).toBe(immediatelyDisabled);
    expect(submitDisabled()).toBe(true);
  });
});
