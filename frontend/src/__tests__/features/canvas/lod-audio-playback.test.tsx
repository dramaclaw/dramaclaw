// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 回归：播放中的音频节点不能被低缩放档的 shell 换掉。
 *
 * 音频节点不在 LOD_SHELL_EXEMPT_TYPES 里，播放态又是 AudioWaveformPlayer 的组件
 * 内部 state，shell 决策（withLodShell）在组件外层读不到。播放按钮还会
 * stopPropagation，节点不会被选中，也就吃不到「选中豁免」。三者叠加的结果是：
 * 未选中状态点播放 → 缩小过阈值 → <audio> 随组件卸载 → 播放中断且进度归零。
 *
 * 这里锁两件事：
 *   1. 播放器把播放态抛给了调用方（AudioNode 据此写 setNodeMediaActive）；
 *   2. media 活跃的节点跨阈值时不换壳，且 DOM 实例是同一个（进度不会重置）。
 */
import { render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AudioWaveformPlayer } from '@/features/canvas/ui/AudioWaveformPlayer';
import {
  isNodeMediaActive,
  setCanvasGestureActive,
  setNodeMediaActive,
} from '@/features/canvas/application/canvasLod';

// ---- @xyflow/react：只需要 useStore 能读到 transform[2]，Handle 渲染成空节点 ----
let currentZoom = 1;
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, currentZoom] }),
}));

// 画布 store：这些用例里节点始终不被选中（正是播放按钮 stopPropagation 的后果）。
vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: (selector: (state: { selectedNodeId: string | null }) => unknown) =>
    selector({ selectedNodeId: null }),
}));

const { withLodShell } = await import('@/features/canvas/nodes/LodShellNode');

const NODE_ID = 'audio-1';

function AudioStub() {
  return <div data-testid="full-audio-node">waveform</div>;
}

const WrappedAudioNode = withLodShell('audioNode', AudioStub);

function renderAudioNode() {
  return render(
    <WrappedAudioNode
      id={NODE_ID}
      type="audioNode"
      data={{}}
      selected={false}
      width={420}
      height={220}
      dragging={false}
      zIndex={0}
      isConnectable
      positionAbsoluteX={0}
      positionAbsoluteY={0}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {...({} as any)}
    />,
  );
}

describe('AudioWaveformPlayer 播放态外抛', () => {
  beforeEach(() => {
    // jsdom 没有 ResizeObserver / canvas 2d / AudioContext，波形那条线在这些
    // 用例里不是关注点，给足最小桩让组件挂得起来即可。
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in test')));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('播放/暂停都会通知调用方', async () => {
    const onPlayingChange = vi.fn();
    const { container } = render(
      <AudioWaveformPlayer src="blob:audio" onPlayingChange={onPlayingChange} />,
    );
    // 挂载时先同步一次「未播放」。
    expect(onPlayingChange).toHaveBeenLastCalledWith(false);

    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();

    // jsdom 不实现 play()，直接驱动组件监听的 pause/ended 事件与播放入口。
    const playButton = container.querySelector('button[aria-label="play"]');
    expect(playButton).not.toBeNull();
    // jsdom 的 paused 恒为 true，togglePlay 会走 play() 分支。
    await act(async () => {
      (playButton as HTMLButtonElement).click();
    });
    expect(onPlayingChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      audio!.dispatchEvent(new Event('pause'));
    });
    expect(onPlayingChange).toHaveBeenLastCalledWith(false);
  });

  it('播放中被卸载时补发 false —— <audio> 卸载不会派发 pause 事件', async () => {
    const onPlayingChange = vi.fn();
    const { container, unmount } = render(
      <AudioWaveformPlayer src="blob:audio" onPlayingChange={onPlayingChange} />,
    );
    await act(async () => {
      (container.querySelector('button[aria-label="play"]') as HTMLButtonElement).click();
    });
    expect(onPlayingChange).toHaveBeenLastCalledWith(true);

    onPlayingChange.mockClear();
    unmount();
    expect(onPlayingChange).toHaveBeenCalledWith(false);
  });
});

describe('播放中的音频节点跨低缩放档不换壳', () => {
  beforeEach(() => {
    currentZoom = 1;
    setCanvasGestureActive(false);
    setNodeMediaActive(NODE_ID, false);
  });

  afterEach(() => {
    setNodeMediaActive(NODE_ID, false);
    vi.restoreAllMocks();
  });

  it('没在播放时，缩到阈值以下会换成 shell（对照组）', () => {
    const { queryByTestId, rerender } = renderAudioNode();
    expect(queryByTestId('full-audio-node')).not.toBeNull();

    currentZoom = 0.2;
    act(() => {
      rerender(
        <WrappedAudioNode
          id={NODE_ID}
          type="audioNode"
          data={{}}
          selected={false}
          width={420}
          height={220}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {...({} as any)}
        />,
      );
    });
    expect(queryByTestId('full-audio-node')).toBeNull();
  });

  it('播放中缩到阈值以下仍保留完整组件，且 DOM 实例没被重建（进度不丢）', () => {
    const { queryByTestId, rerender } = renderAudioNode();
    const before = queryByTestId('full-audio-node');
    expect(before).not.toBeNull();

    // 未选中状态下点播放：AudioNode 把播放态写进模块级注册表。
    setNodeMediaActive(NODE_ID, true);
    expect(isNodeMediaActive(NODE_ID)).toBe(true);

    currentZoom = 0.2;
    act(() => {
      rerender(
        <WrappedAudioNode
          id={NODE_ID}
          type="audioNode"
          data={{}}
          selected={false}
          width={420}
          height={220}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {...({} as any)}
        />,
      );
    });

    const after = queryByTestId('full-audio-node');
    expect(after).not.toBeNull();
    // 同一个 DOM 节点 —— 组件没卸载重挂，<audio> 的 currentTime 自然还在。
    expect(after).toBe(before);
  });
});
