// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PREVIZ_MAX_AUDIO_CLIPS } from '@/features/previz/domain/audioTrack';
import {
  createDefaultScene,
  type PrevizAudioClip,
  type PrevizScene,
} from '@/features/previz/domain/scene';
import { PrevizAudioTrack } from '@/features/previz/ui/PrevizAudioTrack';

const loadAudioPeaks = vi.fn<(src: string) => Promise<Float32Array>>();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/features/canvas/compose/audioPeaks', () => ({
  PEAK_BUCKETS_PER_SEC: 120,
  loadAudioPeaks: (src: string) => loadAudioPeaks(src),
}));

function audio(id: string, startFrame: number, endFrame: number): PrevizAudioClip {
  return {
    id,
    kind: 'audio',
    startFrame,
    endFrame,
    audioUrl: `/static/${id}.mp3`,
    sourceName: `${id}.mp3`,
    durationMs: 4000,
    offsetMs: 0,
    sourceNodeId: null,
  };
}

function sceneWith(clips: PrevizAudioClip[]): PrevizScene {
  const base = createDefaultScene();
  return { ...base, timeline: { ...base.timeline, audio: clips } };
}

function props(
  scene: PrevizScene,
  overrides: Partial<Parameters<typeof PrevizAudioTrack>[0]> = {},
) {
  return {
    scene,
    pxPerFrame: 2,
    laneWidthPx: 400,
    selectedClipId: null,
    onSelect: vi.fn(),
    onTrim: vi.fn(),
    upstreamAudio: [],
    pending: null,
    onAddFile: vi.fn(),
    onAddUpstream: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadAudioPeaks.mockImplementation(async () => new Float32Array(240).fill(0.5));
  // jsdom 没有 canvas 2D 上下文；波形绘制得能在 getContext 返回 null 时安静跳过。
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  // 别把打了桩的 getContext 留给别的测试文件——它挂在全局原型上。
  vi.restoreAllMocks();
});

describe('PrevizAudioTrack', () => {
  it('draws each clip with its source name and a waveform', async () => {
    render(<PrevizAudioTrack {...props(sceneWith([audio('a', 0, 60)]))} />);
    expect(screen.getByTestId('previz-audio-track')).toBeInTheDocument();
    expect(screen.getByTestId('previz-clip-a')).toHaveTextContent('a.mp3');
    const wave = screen.getByTestId('previz-audio-wave-a');
    expect(wave).toHaveAttribute('data-state', 'loading');
    await waitFor(() => {
      expect(wave).toHaveAttribute('data-state', 'ready');
    });
    expect(loadAudioPeaks).toHaveBeenCalledWith('/static/a.mp3');
  });

  it('paints the clips in the audio tone', () => {
    render(<PrevizAudioTrack {...props(sceneWith([audio('a', 0, 60)]))} />);
    expect(screen.getByTestId('previz-clip-a').className).toContain('bg-[#2a8c7a]');
  });

  it('marks the waveform failed when the peaks cannot be loaded', async () => {
    loadAudioPeaks.mockRejectedValueOnce(new Error('decode'));
    render(<PrevizAudioTrack {...props(sceneWith([audio('a', 0, 60)]))} />);
    await waitFor(() => {
      expect(screen.getByTestId('previz-audio-wave-a')).toHaveAttribute('data-state', 'failed');
    });
  });

  it('opens the add menu with a local file entry and the upstream hint', async () => {
    const user = userEvent.setup();
    render(<PrevizAudioTrack {...props(sceneWith([]))} />);
    await user.click(screen.getByRole('button', { name: 'previz.audio.add' }));
    expect(screen.getByRole('menuitem', { name: 'previz.audio.local' })).toBeInTheDocument();
    expect(screen.getByText('previz.audio.noUpstream')).toBeInTheDocument();
  });

  it('lists upstream nodes and hands the picked one back', async () => {
    const user = userEvent.setup();
    const onAddUpstream = vi.fn();
    const upstream = {
      nodeId: 'audio-1',
      displayName: '旁白',
      audioUrl: '/static/vo.mp3',
      durationMs: 3000,
    };
    render(
      <PrevizAudioTrack {...props(sceneWith([]), { upstreamAudio: [upstream], onAddUpstream })} />,
    );
    await user.click(screen.getByRole('button', { name: 'previz.audio.add' }));
    await user.click(screen.getByRole('menuitem', { name: '旁白' }));
    expect(onAddUpstream).toHaveBeenCalledWith(upstream);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('forwards a chosen local file', async () => {
    const user = userEvent.setup();
    const onAddFile = vi.fn();
    render(<PrevizAudioTrack {...props(sceneWith([]), { onAddFile })} />);
    await user.click(screen.getByRole('button', { name: 'previz.audio.add' }));
    await user.click(screen.getByRole('menuitem', { name: 'previz.audio.local' }));
    const file = new File(['x'], 'take.mp3', { type: 'audio/mpeg' });
    const input = screen.getByTestId('previz-audio-file') as HTMLInputElement;
    await user.upload(input, file);
    expect(onAddFile).toHaveBeenCalledWith(file);
    // 选完清空 value，同一个文件再选一次才会再触发 change。
    expect(input.value).toBe('');
  });

  it('closes the menu on Escape', async () => {
    const user = userEvent.setup();
    render(<PrevizAudioTrack {...props(sceneWith([]))} />);
    await user.click(screen.getByRole('button', { name: 'previz.audio.add' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes the menu when the pointer goes down outside it', async () => {
    const user = userEvent.setup();
    render(<PrevizAudioTrack {...props(sceneWith([]))} />);
    await user.click(screen.getByRole('button', { name: 'previz.audio.add' }));
    await user.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('disables the add button at the clip limit', () => {
    const clips = Array.from({ length: PREVIZ_MAX_AUDIO_CLIPS }, (_, i) =>
      audio(`a${i}`, i, i + 1),
    );
    render(<PrevizAudioTrack {...props(sceneWith(clips))} />);
    expect(screen.getByRole('button', { name: 'previz.audio.add' })).toBeDisabled();
  });

  it('disables the add button while an upload is running', () => {
    const pending = { startFrame: 0, endFrame: 10, name: 'take.mp3' };
    render(<PrevizAudioTrack {...props(sceneWith([]), { pending })} />);
    expect(screen.getByRole('button', { name: 'previz.audio.add' })).toBeDisabled();
  });

  it('shows the pending placeholder while an upload is running', () => {
    render(
      <PrevizAudioTrack
        {...props(sceneWith([]), { pending: { startFrame: 10, endFrame: 40, name: 'take.mp3' } })}
      />,
    );
    const placeholder = screen.getByTestId('previz-audio-pending');
    expect(placeholder).toHaveTextContent('previz.audio.uploading');
    expect(placeholder).toHaveStyle({ left: '20px', width: '60px' });
  });
});
