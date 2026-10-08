// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 重型可选节点的按需加载。
 *
 * 这两个节点各自拖着一个引擎：3D 世界 → playcanvas（预打包后 5.2MB），
 * 360 查看器 → @photo-sphere-viewer/core（1.37MB）。静态 import 会让**每一次打开
 * 画布**都把它们下载、解析、编译一遍 —— 实测 playcanvas 单独就占掉约 990ms 主
 * 线程，而绝大多数画布一个这类节点都没有。
 *
 * 引用身份必须稳定：React Flow 对 `nodeTypes` 的每个值做引用比较，换一个新函数
 * 就会把该类型的所有节点卸载重挂（这也是 [[nodes/index]] 原本坚持静态 import 的
 * 理由）。lazy() 与包装器都在模块加载期创建一次、之后永不变化，所以这条约束照样
 * 成立。
 *
 * 低缩放档还有一层便宜：这两个类型不在 LOD 豁免名单里，缩小时渲染的是轻量外壳，
 * 连 lazy 组件都不会被触发加载。
 */
import { Suspense, lazy, type ComponentType } from 'react';
import type { NodeProps } from '@xyflow/react';

import { preloadThreeDDirectorDialog } from '@/features/viewer-kit/three-d/ThreeDDirectorDialogLazy';
import { SHELL_FALLBACK_SIZES } from './LodShellNode';

// 各节点组件的 props 都是自家收窄过的 XxxNodeProps，和 React Flow 的宽 NodeProps
// 不互相兼容 —— 与 [[LodShellNode]] 的 AnyNodeComponent 同因同解，这里按宽类型接。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NodeComponent = ComponentType<any>;
type NodeLoader = () => Promise<{ default: NodeComponent }>;

/** 已登记的重型节点加载器，供 [[preloadCanvasNodeComponents]] 提前预热。 */
const lazyNodeLoaders = new Map<string, NodeLoader>();
/** 已经发起过加载的类型 —— 加载器只跑一次，重复调用直接忽略。 */
const preloadedNodeTypes = new Set<string>();

function LazyNodePlaceholder({ type, width, height }: {
  type: string;
  width: number | undefined;
  height: number | undefined;
}) {
  const fallback = SHELL_FALLBACK_SIZES[type] ?? { width: 400, height: 300 };
  // 复用 LOD 外壳的外观：加载中的盒子与随后出现的节点同尺寸同底色，chunk 到位
  // 时不会有一次跳版。
  return (
    <div
      className="dc-lod-shell"
      style={{ width: width ?? fallback.width, height: height ?? fallback.height }}
    />
  );
}

function lazyNode(type: string, load: NodeLoader): NodeComponent {
  lazyNodeLoaders.set(type, load);
  const Lazy = lazy(load);
  const Wrapped = (props: NodeProps) => (
    <Suspense
      fallback={<LazyNodePlaceholder type={type} width={props.width} height={props.height} />}
    >
      <Lazy {...props} />
    </Suspense>
  );
  Wrapped.displayName = `LazyNode(${type})`;
  return Wrapped;
}

export const Pano360ViewerNodeLazy = lazyNode('pano360ViewerNode', () =>
  import('./Pano360ViewerNode').then((m) => ({ default: m.Pano360ViewerNode })),
);

export const ThreeDWorldNodeLazy = lazyNode('threeDWorldNode', async () => {
  // 画布里已经有 3D 节点，说明用户多半要开导演弹窗 —— 引擎 chunk 与节点 chunk
  // 并行拉，点开时不用再等。见 ThreeDDirectorDialogLazy。
  preloadThreeDDirectorDialog();
  const m = await import('./ThreeDWorldNode');
  return { default: m.ThreeDWorldNode };
});

/**
 * 画布数据到位后，按「实际出现了哪些类型」预热对应 chunk。
 *
 * 等到组件真的要渲染才加载，用户会看见一次可见的空盒子；而画布 JSON 一到手就
 * 知道该拉哪几个，此时并行拉取不挡任何东西。没有这些类型的画布则一个字节都不会
 * 下载 —— 这正是这次改动的全部意义。
 */
export function preloadCanvasNodeComponents(types: Iterable<string>): void {
  for (const type of types) {
    if (preloadedNodeTypes.has(type)) continue;
    const load = lazyNodeLoaders.get(type);
    if (!load) continue;
    preloadedNodeTypes.add(type);
    // 预热失败不影响功能：真正渲染时 lazy() 会自己重试。
    void load().catch(() => undefined);
  }
}
