// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { StrictMode } from 'react';
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VideoComposeWorkspace } from '@/features/canvas/compose/VideoComposeWorkspace';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const openStudio = vi.hoisted(() =>
  vi.fn(async () => ({
    url: 'http://127.0.0.1:4747/open?key=k',
    origin: 'http://127.0.0.1:4747',
  })),
);

vi.mock('@/api/ops', () => ({
  openFreezoneVideoComposeStudio: openStudio,
}));

// t 必须跨渲染稳定（真实 react-i18next 就是这么做的）；否则 effect 依赖 t 会在
// 每次写入 store 后重跑，把「打开一次」测成几千次。
const translate = (key: string) => key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

function videoNode(id: string, durationMs: number): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 },
    data: {
      videoUrl: `/freezone/_uploads/${id}.mp4`,
      aspectRatio: '16:9',
      durationMs,
    },
  };
}

describe('VideoComposeWorkspace', () => {
  const previous = useCanvasStore.getState();

  afterEach(() => {
    useCanvasStore.setState({ nodes: previous.nodes, edges: previous.edges });
    openStudio.mockClear();
  });

  it('stores the first timeline draft so reopening keeps clip ids stable', async () => {
    const nodes: CanvasNode[] = [
      videoNode('video-a', 5_000),
      videoNode('video-b', 4_000),
      {
        id: 'compose',
        type: CANVAS_NODE_TYPES.videoCompose,
        position: { x: 0, y: 0 },
        data: {},
      },
    ];
    const edges: CanvasEdge[] = [
      { id: 'edge-a', source: 'video-a', target: 'compose' },
      { id: 'edge-b', source: 'video-b', target: 'compose' },
    ];
    useCanvasStore.setState({ nodes, edges });

    render(
      <VideoComposeWorkspace
        projectId="proj-demo"
        canvasId="canvas-1"
        nodeId="compose"
        onExit={() => {}}
      />,
    );

    await waitFor(() => expect(openStudio).toHaveBeenCalledTimes(1));

    const compose = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === 'compose');
    const draft = compose?.data.draftTimeline as {
      tracks: { clips: { id: string; nodeId: string }[] }[];
    };
    const clipIds = draft.tracks.flatMap((track) =>
      track.clips.map((clip) => clip.id),
    );
    expect(clipIds).toHaveLength(2);
    expect(new Set(clipIds).size).toBe(2);
    expect(draft.tracks.flatMap((track) => track.clips.map((clip) => clip.nodeId))).toEqual([
      'video-a',
      'video-b',
    ]);
  });

  it('opens Studio once under StrictMode double effects', async () => {
    const nodes: CanvasNode[] = [
      videoNode('video-a', 5_000),
      videoNode('video-b', 4_000),
      {
        id: 'compose',
        type: CANVAS_NODE_TYPES.videoCompose,
        position: { x: 0, y: 0 },
        data: {},
      },
    ];
    const edges: CanvasEdge[] = [
      { id: 'edge-a', source: 'video-a', target: 'compose' },
      { id: 'edge-b', source: 'video-b', target: 'compose' },
    ];
    useCanvasStore.setState({ nodes, edges });

    render(
      <StrictMode>
        <VideoComposeWorkspace
          projectId="proj-demo"
          canvasId="canvas-1"
          nodeId="compose"
          onExit={() => {}}
        />
      </StrictMode>,
    );

    // 开发态 StrictMode 会 setup→cleanup→setup；两次都建片会让随机 clip id
    // 各建一套素材，Studio 素材库里同一条片段出现两份。
    await waitFor(() => expect(openStudio).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(openStudio).toHaveBeenCalledTimes(1);
  });
});
