// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { XYPosition } from '@xyflow/react';

import type { CanvasNode, CanvasNodeData, CanvasNodeType } from '../domain/canvasNodes';
import type { IdGenerator, NodeCatalog, NodeFactory } from './ports';

export class CanvasNodeFactory implements NodeFactory {
  constructor(
    private readonly idGenerator: IdGenerator,
    private readonly nodeCatalog: NodeCatalog
  ) {}

  createNode(
    type: CanvasNodeType,
    position: XYPosition,
    data: Partial<CanvasNodeData> = {}
  ): CanvasNode {
    const definition = this.nodeCatalog.getDefinition(type);
    // createdAt 压在 ...data 之后是有意的：duplicateNodeAsSibling 会把源节点的整份
    // data 摊进来，放前面的话复制出来的节点会继承源节点的创建时刻——而「复制三份」
    // 恰好就是大纲要靠时刻区分的那个场景。工厂只在真正新建节点时被调用（加载画布
    // 是直接 set(nodes)，撤销走快照），所以这里覆盖不到从服务端读回来的节点。
    const nodeData = {
      ...definition.createDefaultData(),
      ...data,
      createdAt: Date.now(),
    } as CanvasNodeData;

    return {
      id: this.idGenerator.next(),
      type,
      position,
      data: nodeData,
    };
  }
}
