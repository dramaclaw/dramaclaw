// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  nextAutoTitleIndex,
  resolveNodeDisplayName,
  localizeNodeDisplayName,
} from '@/features/canvas/domain/nodeDisplay';
import { useCanvasStore } from '@/stores/canvasStore';
import { enT, zhT } from '@/__tests__/helpers/i18n-fixtures';

describe('numbered node title localization', () => {
  it.each([
    [CANVAS_NODE_TYPES.textAnnotation, '文本7', 7, 'Text7'],
    [CANVAS_NODE_TYPES.imageGen, '图片节点16', 16, 'Image node16'],
  ])('localizes the default %s title without changing saved data', (type, displayName, index, english) => {
    const data = { displayName: String(displayName), autoTitleIndex: Number(index) };
    expect(localizeNodeDisplayName(type as typeof CANVAS_NODE_TYPES.imageGen, data, enT)).toBe(english);
    expect(localizeNodeDisplayName(type as typeof CANVAS_NODE_TYPES.imageGen, data, zhT)).toBe(displayName);
    expect(data.displayName).toBe(displayName);
  });

  it('localizes an empty title while keeping its automatic number', () => {
    expect(localizeNodeDisplayName(CANVAS_NODE_TYPES.imageGen, { autoTitleIndex: 16 }, enT))
      .toBe('Image node16');
  });

  it('keeps custom titles and legacy titles without numbering metadata unchanged', () => {
    for (const data of [
      { displayName: '我的图片16', autoTitleIndex: 16 },
      { displayName: '图片节点42', autoTitleIndex: 16 },
      { displayName: '图片节点16' },
    ]) {
      expect(localizeNodeDisplayName(CANVAS_NODE_TYPES.imageGen, data, enT)).toBe(data.displayName);
    }
    expect(localizeNodeDisplayName(CANVAS_NODE_TYPES.group, { label: '我的自定义分组' }, enT))
      .toBe('我的自定义分组');
    // A title that is another type's default is still a custom title here.
    expect(localizeNodeDisplayName(CANVAS_NODE_TYPES.imageEdit, { displayName: '图片节点' }, enT))
      .toBe('图片节点');
  });
});

function nodeOf(id: string, type: string, data: Record<string, unknown> = {}): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data } as unknown as CanvasNode;
}

/** 取某节点当前渲染出来的标题（默认名 + 自动序号）。 */
function titleOf(nodeId: string): string {
  const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node?.type) throw new Error(`node ${nodeId} not found`);
  return resolveNodeDisplayName(node.type, node.data);
}

describe('未命名节点自动编号', () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it('nextAutoTitleIndex：空画布从 1 开始，按同类型已用序号递增', () => {
    expect(nextAutoTitleIndex(CANVAS_NODE_TYPES.textAnnotation, [])).toBe(1);
    const nodes = [
      nodeOf('t1', CANVAS_NODE_TYPES.textAnnotation, { autoTitleIndex: 1 }),
      nodeOf('t2', CANVAS_NODE_TYPES.textAnnotation, { autoTitleIndex: 2 }),
      // 其它类型不参与本类型的发号。
      nodeOf('i1', CANVAS_NODE_TYPES.imageGen, { autoTitleIndex: 7 }),
    ];
    expect(nextAutoTitleIndex(CANVAS_NODE_TYPES.textAnnotation, nodes)).toBe(3);
    expect(nextAutoTitleIndex(CANVAS_NODE_TYPES.imageGen, nodes)).toBe(8);
  });

  it('nextAutoTitleIndex：删掉中间节点也不重号（按已用最大值 +1）', () => {
    const nodes = [nodeOf('t2', CANVAS_NODE_TYPES.textAnnotation, { autoTitleIndex: 2 })];
    // 1 号已被删除，但下一个仍取 3，不回收 1。
    expect(nextAutoTitleIndex(CANVAS_NODE_TYPES.textAnnotation, nodes)).toBe(3);
  });

  it('nextAutoTitleIndex：老画布节点没有序号 → 用同类型个数抬高起点，避开无序号默认名', () => {
    const legacy = [
      nodeOf('t1', CANVAS_NODE_TYPES.textAnnotation, {}),
      nodeOf('t2', CANVAS_NODE_TYPES.textAnnotation, {}),
    ];
    expect(nextAutoTitleIndex(CANVAS_NODE_TYPES.textAnnotation, legacy)).toBe(3);
  });

  it('连续新建同类型节点 → 标题带递增序号，互不重名', () => {
    const store = useCanvasStore.getState();
    const a = store.addNode(CANVAS_NODE_TYPES.textAnnotation, { x: 0, y: 0 });
    const b = store.addNode(CANVAS_NODE_TYPES.textAnnotation, { x: 0, y: 100 });
    const img = store.addNode(CANVAS_NODE_TYPES.imageGen, { x: 200, y: 0 });

    expect(titleOf(a)).toBe('文本1');
    expect(titleOf(b)).toBe('文本2');
    // 图片自己一套序号，不受文本影响。
    expect(titleOf(img)).toBe('图片节点1');
  });

  it('调用方自带 displayName（如各类结果节点）→ 不发序号，标题原样', () => {
    const store = useCanvasStore.getState();
    const id = store.addNode(CANVAS_NODE_TYPES.imageGen, { x: 0, y: 0 }, { displayName: '抠图' });

    expect(titleOf(id)).toBe('抠图');
    const node = useCanvasStore.getState().nodes.find((n) => n.id === id);
    expect(node?.data.autoTitleIndex).toBeUndefined();
  });

  it('用户改了标题 → 序号不再露出；改回空白则回落到带序号的默认名', () => {
    const store = useCanvasStore.getState();
    const id = store.addNode(CANVAS_NODE_TYPES.textAnnotation, { x: 0, y: 0 });
    expect(titleOf(id)).toBe('文本1');

    useCanvasStore.getState().updateNodeData(id, { displayName: '开场白' });
    expect(titleOf(id)).toBe('开场白');

    // displayName 清空 → 回到默认名（序号仍在 data 上，没被覆盖）。
    useCanvasStore.getState().updateNodeData(id, { displayName: '' });
    expect(titleOf(id)).toBe('文本1');
  });

  it('复制未命名节点 → 副本重新发号，不与源节点重名', () => {
    const store = useCanvasStore.getState();
    const source = store.addNode(CANVAS_NODE_TYPES.textAnnotation, { x: 0, y: 0 });
    expect(titleOf(source)).toBe('文本1');

    const copy = useCanvasStore.getState().duplicateNodeAsSibling(source, 1);
    expect(copy).not.toBeNull();
    expect(titleOf(copy as string)).toBe('文本2');
  });
});
