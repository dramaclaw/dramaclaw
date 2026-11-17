// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

const mocks = vi.hoisted(() => ({ update: vi.fn(), probe: vi.fn(), quote: vi.fn(), submit: vi.fn(), complete: vi.fn() }));
vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: (selector: (state: { updateNodeData: typeof mocks.update }) => unknown) =>
    selector({ updateNodeData: mocks.update }),
}));
vi.mock('@/api/ops', () => ({
  probeFreezoneVideoUpscale: mocks.probe,
  quoteFreezoneVideoUpscale: mocks.quote,
  submitFreezoneVideoUpscale: mocks.submit,
  fetchFreezoneJobResult: vi.fn(),
}));
vi.mock('@/api/tasks', () => ({ awaitTaskCompletion: mocks.complete, isTaskPollTimeoutError: vi.fn() }));
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


it('quotes and submits the independent local group with the same explicit bindings', async () => {
  mocks.probe.mockResolvedValue({
    width: 1280, height: 720, fps: 30, duration: 70,
    enhancement_models: ['standard', 'topaz', 'local_gpu'],
    enhancement_bindings: { local_gpu: { upscale_catalog_id: 'local-up', frame_rate_catalog_id: 'local-fps' } },
    upscale_resolutions: ['1080p', '2k', '4k'], frame_rate_resolutions: ['1080p'],
  });
  mocks.submit.mockResolvedValue({ task_key: 'local-task', task_type: 'freezone_video_upscale', job_id: 'local-job' });
  mocks.complete.mockResolvedValue({ result: { output_url: '/local-result.mp4' } });
  const view = render(<VideoUpscaleEditorOverlay node={node({ upscaleEnhancementModel: 'local_gpu', upscaleTargetFps: 60 })} />);
  const expected = { enhancementModel: 'local_gpu', resolution: '1080p', targetFps: 60 };
  mocks.quote.mockResolvedValue({display:'10',plan_fingerprint:'frozen-plan'});
  await waitFor(() => expect(mocks.quote).toHaveBeenCalledWith('project', expect.objectContaining(expected)));
  const submit = screen.getByTitle('node.videoUpscale.panel.submit');
  await waitFor(() => expect(submit).not.toBeDisabled());
  fireEvent.click(submit);
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledWith('project', expect.objectContaining({...expected,planFingerprint:'frozen-plan'})));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('upscale', expect.objectContaining({ videoUrl: '/local-result.mp4', isGenerating: false })));
  // A parameter change must wait for its own quote, even while the previous price is visible.
  mocks.quote.mockImplementation(() => new Promise(() => {}));
  view.rerender(<VideoUpscaleEditorOverlay node={node({ upscaleEnhancementModel: 'local_gpu', upscaleTargetFps: 'auto', upscaleResolution: '2k' })} />);
  expect(screen.getByTitle('node.videoUpscale.panel.submit')).toBeDisabled();
});


it('blocks a new paid retry when the original submission is unresolved',async()=>{
  render(<VideoUpscaleEditorOverlay node={node({upscaleEnhancementModel:'standard',upscaleSubmissionPending:true,generationError:'LOCAL_VIDEO_SUBMISSION_PENDING',generationTaskKey:'original-task'})}/>);
  await waitFor(()=>expect(mocks.quote).toHaveBeenCalled());
  expect(screen.getByTitle('node.videoUpscale.panel.submit')).toBeDisabled();
  fireEvent.click(screen.getByTitle('node.videoUpscale.panel.submit'));
  expect(mocks.submit).not.toHaveBeenCalled();
});
