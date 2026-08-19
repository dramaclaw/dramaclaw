// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 回归：低缩放档（zoom < LOW_DETAIL_ZOOM_THRESHOLD）从外部拖入图片，新建的 upload
 * 节点不能是个空节点。
 *
 * 现场表现是「放大后发现加进来的是一个跟拖入的图毫不相干的上传节点」。链路：
 * 投递方先 addNode、下一帧才把 File 发到 canvasEventBus，而低缩放档下新节点先以
 * LOD shell 挂载（withLodShell），完整组件要等 requestShellUpgrade 的升级队列放行，
 * 必然晚于投递那一帧 —— 总线无重放，File 当场就没了。
 *
 * 这里锁的是「File 的载体与订阅时机解耦」：投递时 stash，消费侧挂载时补投一次。
 */
import { render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- @xyflow/react：只需要 useStore 能读到 transform[2]，Handle 渲染成空节点 ----
let currentZoom = 1;
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, currentZoom] }),
}));

// 画布 store：只有 withLodShell 的「选中豁免」读它。这些用例里节点不被选中 ——
// 拖入落点在空白画布时 React Flow 的选中同步会把 selectedNodeId 复位，豁免吃不到，
// 与现场一致。
vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: (selector: (state: { selectedNodeId: string | null }) => unknown) =>
    selector({ selectedNodeId: null }),
}));

const { withLodShell } = await import('@/features/canvas/nodes/LodShellNode');
const { useExternalFileHandoff } = await import(
  '@/features/canvas/hooks/useExternalFileHandoff'
);
const { canvasEventBus } = await import('@/features/canvas/application/canvasServices');
const {
  stashExternalFile,
  takeExternalFile,
  resetPendingExternalFilesForTest,
} = await import('@/features/canvas/application/pendingExternalFiles');
const { setCanvasGestureActive } = await import(
  '@/features/canvas/application/canvasLod'
);

const NODE_ID = 'upload-1';

const received: string[] = [];

/**
 * 冒充 UploadNode：把收到的 File 交给 handleMediaFile 的位置，换成记一笔。
 * 接收侧用的是生产代码里的 useExternalFileHandoff，与三个节点组件同一条路径。
 */
function UploadStub({ id }: { id: string }) {
  useExternalFileHandoff('upload-node/external-file', id, (file) => {
    received.push(file.name);
  });
  return <div data-testid="full-upload-node" />;
}

const WrappedUploadNode = withLodShell('uploadNode', UploadStub);

function renderNode() {
  return render(
    <WrappedUploadNode
      id={NODE_ID}
      type="uploadNode"
      data={{}}
      selected={false}
      width={320}
      height={350}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {...({} as any)}
    />,
  );
}

/** 复刻 Canvas.handleCanvasDrop 的文件分支：暂存 + 延后一帧发事件。 */
function dropFile(nodeId: string, name: string) {
  const file = new File(['x'], name, { type: 'image/png' });
  stashExternalFile('upload-node/external-file', nodeId, file);
  requestAnimationFrame(() => {
    canvasEventBus.publish('upload-node/external-file', { nodeId });
  });
}

/** 逐帧等待（必须串行：一次性注册 n 个 rAF 只会等到一帧）。 */
async function nextFrames(count: number) {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
}

describe('低缩放档拖入文件的投递', () => {
  beforeEach(() => {
    received.length = 0;
    currentZoom = 1;
    setCanvasGestureActive(false);
    resetPendingExternalFilesForTest();
  });

  afterEach(() => {
    resetPendingExternalFilesForTest();
  });

  it('常用缩放下节点直接以完整组件挂载，当帧就收到 File（对照组）', async () => {
    const { queryByTestId } = renderNode();
    expect(queryByTestId('full-upload-node')).not.toBeNull();

    await act(async () => {
      dropFile(NODE_ID, 'a.png');
      await nextFrames(2);
    });

    expect(received).toEqual(['a.png']);
  });

  it('shell 期间投递的 File 不丢：完整组件挂上来时补投', async () => {
    currentZoom = 0.2;
    const { queryByTestId, rerender } = renderNode();
    // 前提：低缩放档下确实是 shell，完整组件没挂 —— 也就没有订阅者。
    expect(queryByTestId('full-upload-node')).toBeNull();

    await act(async () => {
      dropFile(NODE_ID, 'b.png');
      await nextFrames(2);
    });
    // 投递已经发生过了，节点还是 shell，事件没人接。
    expect(received).toEqual([]);

    // 放大跨过阈值：shell 经升级队列换成完整组件。
    currentZoom = 1;
    await act(async () => {
      rerender(
        <WrappedUploadNode
          id={NODE_ID}
          type="uploadNode"
          data={{}}
          selected={false}
          width={320}
          height={350}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {...({} as any)}
        />,
      );
    });
    // 升级排队发生在 rerender 的 effect 里，必须等它落定后再推帧，否则泵会先于
    // 入队跑掉一次。
    await act(async () => {
      await nextFrames(3);
    });

    expect(queryByTestId('full-upload-node')).not.toBeNull();
    expect(received).toEqual(['b.png']);
  });

  it('同一个 File 只会被消费一次（挂载补投与事件投递不重复）', async () => {
    const { queryByTestId } = renderNode();
    expect(queryByTestId('full-upload-node')).not.toBeNull();

    await act(async () => {
      dropFile(NODE_ID, 'c.png');
      await nextFrames(3);
    });

    expect(received).toEqual(['c.png']);
    // 暂存已被取空，重挂载不会再处理一遍。
    expect(takeExternalFile('upload-node/external-file', NODE_ID)).toBeNull();
  });

  it('多文件拖入：每个新节点各拿到自己的 File', async () => {
    currentZoom = 0.2;
    const files = ['d1.png', 'd2.png', 'd3.png'];
    files.forEach((name, index) => {
      dropFile(`upload-multi-${index}`, name);
    });

    currentZoom = 1;
    await act(async () => {
      render(
        <>
          {files.map((_, index) => (
            <WrappedUploadNode
              key={index}
              id={`upload-multi-${index}`}
              type="uploadNode"
              data={{}}
              selected={false}
              width={320}
              height={350}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              {...({} as any)}
            />
          ))}
        </>,
      );
      await nextFrames(2);
    });

    expect(received.sort()).toEqual(files);
  });
});
