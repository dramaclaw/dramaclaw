// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { StrictMode } from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VideoComposeWorkspace } from '@/features/canvas/compose/VideoComposeWorkspace';
import { BackendStatusError } from '@/lib/api-errors';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const openStudio = vi.hoisted(() =>
  vi.fn(
    async (
      _project: string,
      _payload: {
        lang?: string;
        hostBack?: string;
        hostBackLabel?: string;
        rebuild?: boolean;
      },
    ) => ({
      url: 'http://127.0.0.1:4747/open?key=k',
      origin: 'http://127.0.0.1:4747',
    }),
  ),
);

vi.mock('@/api/ops', () => ({
  openFreezoneVideoComposeStudio: openStudio,
}));

// t 必须跨渲染稳定（真实 react-i18next 就是这么做的）；否则 effect 依赖 t 会在
// 每次写入 store 后重跑，把「打开一次」测成几千次。
const translate = (key: string) => key;
const i18nState = vi.hoisted(() => ({ language: 'zh' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: i18nState }),
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
    i18nState.language = 'zh';
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

  it('hands the editor the app language instead of leaving it to browser sniffing', async () => {
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
    useCanvasStore.setState({
      nodes,
      edges: [
        { id: 'edge-a', source: 'video-a', target: 'compose' },
        { id: 'edge-b', source: 'video-b', target: 'compose' },
      ],
    });

    render(
      <VideoComposeWorkspace
        projectId="proj-demo"
        canvasId="canvas-1"
        nodeId="compose"
        onExit={() => {}}
      />,
    );

    // Studio 只按 navigator.languages 猜语言，而跨源 iframe 里浏览器会把这份列表
    // 降级成备用语言（en-US），嵌入态因此一律渲染英文。宿主必须把语言说给它。
    await waitFor(() => expect(openStudio).toHaveBeenCalledTimes(1));
    expect(openStudio.mock.calls[0][1].lang).toBe('zh');
  });

  it('reopens the editor in the language the app just switched to', async () => {
    useCanvasStore.setState({
      nodes: [
        videoNode('video-a', 5_000),
        {
          id: 'compose',
          type: CANVAS_NODE_TYPES.videoCompose,
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [{ id: 'edge-a', source: 'video-a', target: 'compose' }],
    });

    const { rerender } = render(
      <VideoComposeWorkspace
        projectId="proj-demo"
        canvasId="canvas-1"
        nodeId="compose"
        onExit={() => {}}
      />,
    );
    await waitFor(() => expect(openStudio).toHaveBeenCalledTimes(1));
    expect(openStudio.mock.calls[0][1].lang).toBe('zh');

    // 语言不在 openingKey 里时，切语言只是复用第一次的打开结果：iframe 的 ?lang=
    // 停在旧语言，而合成节点标题（默认名是本语言的一份译文）也会跟着旧语言入库。
    // 时间线不含语言，重开只会重写 <title>，不会把已剪好的片断重建掉。
    i18nState.language = 'en';
    rerender(
      <VideoComposeWorkspace
        projectId="proj-demo"
        canvasId="canvas-1"
        nodeId="compose"
        onExit={() => {}}
      />,
    );
    await waitFor(() => expect(openStudio).toHaveBeenCalledTimes(2));
    expect(openStudio.mock.calls[1][1].lang).toBe('en');
  });

  it('keeps the host loading surface over the iframe until the editor paints', async () => {
    useCanvasStore.setState({
      nodes: [
        videoNode('video-a', 5_000),
        videoNode('video-b', 4_000),
        {
          id: 'compose',
          type: CANVAS_NODE_TYPES.videoCompose,
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [
        { id: 'edge-a', source: 'video-a', target: 'compose' },
        { id: 'edge-b', source: 'video-b', target: 'compose' },
      ],
    });

    const { container, getByText, queryByText } = render(
      <VideoComposeWorkspace
        projectId="proj-demo"
        canvasId="canvas-1"
        nodeId="compose"
        onExit={() => {}}
      />,
    );

    // 会话地址一拿到就撤掉自家 loading，等于把编辑器的启动过程交给 OpenFilm 的
    // splash（它的标记和文案），刷新页面时会闪一下「另一个产品」的加载态。
    // 遮罩要压住 iframe 直到编辑器自己画出来。
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    expect(getByText('videoCompose.studio.loading')).toBeTruthy();

    fireEvent.load(container.querySelector('iframe')!);
    await waitFor(() =>
      expect(queryByText('videoCompose.studio.loading')).toBeNull(),
    );
  });

  it('asks before a canvas change replaces a cut made in the editor', async () => {
    useCanvasStore.setState({
      nodes: [
        videoNode('video-a', 5_000),
        {
          id: 'compose',
          type: CANVAS_NODE_TYPES.videoCompose,
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [{ id: 'edge-a', source: 'video-a', target: 'compose' }],
    });
    // 后端在「这次打开会重写一份用户在编辑器里改过的片」时回 409，而不是直接覆盖。
    openStudio.mockRejectedValueOnce(new BackendStatusError('Conflict', 409));

    const { container, getByText, queryByText } = render(
      <VideoComposeWorkspace
        projectId="proj-demo"
        canvasId="canvas-1"
        nodeId="compose"
        onExit={() => {}}
      />,
    );

    await waitFor(() =>
      expect(getByText('videoCompose.studio.editedTitle')).toBeTruthy(),
    );
    expect(queryByText('videoCompose.studio.loadFailed')).toBeNull();
    expect(container.textContent).not.toContain('Conflict');

    fireEvent.click(getByText('videoCompose.studio.editedRebuild'));
    await waitFor(() => expect(openStudio).toHaveBeenCalledTimes(2));
    expect(openStudio.mock.calls[1][1].rebuild).toBe(true);
  });

  it('lets the regenerate flag go once the overwrite succeeds', async () => {
    useCanvasStore.setState({
      nodes: [
        videoNode('video-a', 5_000),
        {
          id: 'compose',
          type: CANVAS_NODE_TYPES.videoCompose,
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [{ id: 'edge-a', source: 'video-a', target: 'compose' }],
    });
    openStudio.mockRejectedValueOnce(new BackendStatusError('Conflict', 409));

    const { getByText, rerender } = render(
      <VideoComposeWorkspace
        projectId="proj-demo"
        canvasId="canvas-1"
        nodeId="compose"
        onExit={() => {}}
      />,
    );
    await waitFor(() =>
      expect(getByText('videoCompose.studio.editedTitle')).toBeTruthy(),
    );
    fireEvent.click(getByText('videoCompose.studio.editedRebuild'));
    await waitFor(() => expect(openStudio).toHaveBeenCalledTimes(2));
    expect(openStudio.mock.calls[1][1].rebuild).toBe(true);

    // 覆盖已经成功，之后再重开（比如切语言）是复用刚生成的那份片，
    // rebuild 若还留着会把用户刚剪的内容再覆盖一遍。
    i18nState.language = 'en';
    rerender(
      <VideoComposeWorkspace
        projectId="proj-demo"
        canvasId="canvas-1"
        nodeId="compose"
        onExit={() => {}}
      />,
    );
    await waitFor(() => expect(openStudio).toHaveBeenCalledTimes(3));
    expect(openStudio.mock.calls[2][1].rebuild).toBe(false);
  });

  it('keeps rebuild on the retry that follows a failed regenerate', async () => {
    useCanvasStore.setState({
      nodes: [
        videoNode('video-a', 5_000),
        {
          id: 'compose',
          type: CANVAS_NODE_TYPES.videoCompose,
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [{ id: 'edge-a', source: 'video-a', target: 'compose' }],
    });
    // 第一次 409 等用户确认；确认后的那次打开又失败了（500），用户再点重试。
    openStudio
      .mockRejectedValueOnce(new BackendStatusError('Conflict', 409))
      .mockRejectedValueOnce(new BackendStatusError('Server Error', 500));

    const { getByText } = render(
      <VideoComposeWorkspace
        projectId="proj-demo"
        canvasId="canvas-1"
        nodeId="compose"
        onExit={() => {}}
      />,
    );
    await waitFor(() =>
      expect(getByText('videoCompose.studio.editedTitle')).toBeTruthy(),
    );
    fireEvent.click(getByText('videoCompose.studio.editedRebuild'));
    await waitFor(() =>
      expect(getByText('videoCompose.studio.loadFailed')).toBeTruthy(),
    );

    // 覆盖没成功，用户点重试时仍要带 rebuild；否则后端又按「手改过的片」回 409，
    // 用户就永远覆盖不掉。
    fireEvent.click(getByText('videoCompose.studio.retry'));
    await waitFor(() => expect(openStudio).toHaveBeenCalledTimes(3));
    expect(openStudio.mock.calls[2][1].rebuild).toBe(true);
  });

  it('returns to the canvas without touching the film when the cut is kept', async () => {
    useCanvasStore.setState({
      nodes: [
        videoNode('video-a', 5_000),
        {
          id: 'compose',
          type: CANVAS_NODE_TYPES.videoCompose,
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [{ id: 'edge-a', source: 'video-a', target: 'compose' }],
    });
    openStudio.mockRejectedValueOnce(new BackendStatusError('Conflict', 409));
    const onExit = vi.fn();

    const { getByText } = render(
      <VideoComposeWorkspace
        projectId="proj-demo"
        canvasId="canvas-1"
        nodeId="compose"
        onExit={onExit}
      />,
    );

    await waitFor(() =>
      expect(getByText('videoCompose.studio.editedTitle')).toBeTruthy(),
    );
    fireEvent.click(getByText('videoCompose.studio.backToCanvas'));
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(openStudio).toHaveBeenCalledTimes(1);
  });

  it('does not offer a retry that cannot help when the node is gone', async () => {
    useCanvasStore.setState({ nodes: [], edges: [] });

    const { getByText, queryByText } = render(
      <VideoComposeWorkspace
        projectId="proj-demo"
        canvasId="canvas-1"
        nodeId="missing"
        onExit={() => {}}
      />,
    );

    await waitFor(() =>
      expect(getByText('videoCompose.studio.missingNode')).toBeTruthy(),
    );
    expect(queryByText('videoCompose.studio.retry')).toBeNull();
    expect(getByText('videoCompose.studio.backToCanvas')).toBeTruthy();
  });

  it('tells the person to connect media instead of prefixing a failure', async () => {
    useCanvasStore.setState({
      nodes: [
        {
          id: 'compose',
          type: CANVAS_NODE_TYPES.videoCompose,
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [],
    });

    const { getByText, queryByText } = render(
      <VideoComposeWorkspace
        projectId="proj-demo"
        canvasId="canvas-1"
        nodeId="compose"
        onExit={() => {}}
      />,
    );

    await waitFor(() =>
      expect(getByText('videoCompose.studio.noMedia')).toBeTruthy(),
    );
    expect(getByText('videoCompose.studio.noMediaHint')).toBeTruthy();
    expect(queryByText('videoCompose.studio.loadFailed')).toBeNull();
    expect(queryByText('videoCompose.studio.retry')).toBeNull();
  });

  it('shows localized copy for a failed request and keeps the raw error out of it', async () => {
    useCanvasStore.setState({
      nodes: [
        videoNode('video-a', 5_000),
        {
          id: 'compose',
          type: CANVAS_NODE_TYPES.videoCompose,
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [{ id: 'edge-a', source: 'video-a', target: 'compose' }],
    });
    openStudio.mockRejectedValueOnce(new BackendStatusError('Not Found', 404));

    const { container, getByText } = render(
      <VideoComposeWorkspace
        projectId="proj-demo"
        canvasId="canvas-1"
        nodeId="compose"
        onExit={() => {}}
      />,
    );

    await waitFor(() =>
      expect(getByText('videoCompose.studio.errorNotFound')).toBeTruthy(),
    );
    expect(getByText('videoCompose.studio.loadFailed')).toBeTruthy();
    expect(container.textContent).not.toContain('Not Found');
    fireEvent.click(getByText('videoCompose.studio.retry'));
    await waitFor(() => expect(openStudio).toHaveBeenCalledTimes(2));
  });
});
