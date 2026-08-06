// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 画布低缩放档（zoom < LOW_DETAIL_ZOOM_THRESHOLD）的节点轻量外壳。
 *
 * 为什么存在：实测（300 节点 / zoom 0.1）快速平移只有 ~20fps，且主线程时间不在
 * JS、不在绘制（图片全部隐藏帧率不变、节点整体 visibility:hidden 也不变），而在
 * 「每帧 transform 变更后，渲染管线要遍历移动子树下全部 ~13.5k 个活元素」——成本
 * 与渲染树规模成正比，与画什么无关。把每个节点的 ~45 个元素换成这里的 ~4 个后，
 * 同一画布实测回到满帧（75fps）。
 *
 * 为什么是「替换渲染」而不是 CSS content-visibility：挂载时就处于隐藏态的节点，
 * React Flow 首测会把 handle 的 getBoundingClientRect 全零写成「存在但错误」的
 * handleBounds（@xyflow/system getHandleBounds），边会集体锚到视口左上角且永不
 * 自愈（ResizeObserver 只看根盒子尺寸）。shell 渲染的是真实 <Handle>，位置与完整
 * 组件完全一致（Left/Right + 垂直居中，id 恒为 'target'/'source'，全局 CSS 本来
 * 就 opacity:0），首测天然正确，跨档切换也无需强制重测。
 *
 * 豁免见 [[canvasLod]] 的 LOD_SHELL_EXEMPT_TYPES 与媒体活跃信号。
 */
import {
  memo,
  useEffect,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
} from 'react';
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react';

import {
  LOD_SHELL_EXEMPT_TYPES,
  isCanvasGestureActive,
  isLowDetailZoom,
  isNodeMediaActive,
  requestShellUpgrade,
} from '@/features/canvas/application/canvasLod';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  getLodStill,
  requestLodStill,
  subscribeLodStills,
} from '@/features/canvas/application/videoFrameCapture';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import {
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';
import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';

/**
 * 未测量且未显式设尺寸的节点（首屏恢复在低缩放档、且从未被渲染过）的兜底尺寸。
 * 与各组件的 DEFAULT_WIDTH/HEIGHT 对齐；只影响首帧盒子大小，放大跨档后完整组件
 * 渲染会触发 ResizeObserver 重测自动纠正。
 */
const SHELL_FALLBACK_SIZES: Partial<Record<string, { width: number; height: number }>> = {
  uploadNode: { width: 320, height: 350 },
  imageNode: { width: 580, height: 360 },
  imageGenNode: { width: 580, height: 360 },
  exportImageNode: { width: 533, height: 300 },
  videoNode: { width: 580, height: 380 },
  textAnnotationNode: { width: 440, height: 320 },
  scriptNode: { width: 480, height: 320 },
  audioNode: { width: 480, height: 210 },
  videoStoryNode: { width: 720, height: 360 },
  videoComposeNode: { width: 240, height: 136 },
  pano360ViewerNode: { width: 900, height: 540 },
  threeDWorldNode: { width: 340, height: 210 },
  storyboardNode: { width: 800, height: 600 },
  storyboardGenNode: { width: 800, height: 600 },
};

const DEFAULT_SHELL_SIZE = { width: 400, height: 300 };

type ShellData = {
  imageUrl?: string | null;
  previewImageUrl?: string | null;
  referenceImageUrl?: string | null;
  videoUrl?: string | null;
  isGenerating?: boolean;
  isUploading?: boolean;
};

/** 每种类型能当缩略图用的字段（回落顺序与各组件的展示逻辑一致）。 */
function resolveShellImage(type: string, data: ShellData): string | null {
  const pick = (...candidates: Array<string | null | undefined>) => {
    for (const c of candidates) if (c) return resolveImageDisplayUrl(c);
    return null;
  };
  switch (type) {
    case 'imageGenNode':
      return pick(data.imageUrl, data.previewImageUrl, data.referenceImageUrl);
    case 'uploadNode':
    case 'imageNode':
    case 'exportImageNode':
      return pick(data.imageUrl, data.previewImageUrl);
    case 'videoNode':
      // 优先离屏抓帧的静态首帧（见 videoFrameCapture），没有再回落封面字段。
      return null; // 视频走 lodStill 订阅，在组件里处理
    default:
      return pick(data.previewImageUrl);
  }
}

function LodShell({ type, id, data, selected, width, height }: {
  type: string;
  id: string;
  data: ShellData;
  selected: boolean | undefined;
  width: number | undefined;
  height: number | undefined;
}) {
  const fallback = SHELL_FALLBACK_SIZES[type] ?? DEFAULT_SHELL_SIZE;
  const w = width ?? fallback.width;
  const h = height ?? fallback.height;

  // 视频缩略图：订阅模块级抓帧缓存；节点从未挂载过完整组件时（首屏即低缩放），
  // 这里负责把抓帧任务排进空闲队列，不依赖完整组件出现过。
  const videoSource =
    type === 'videoNode' && data.videoUrl ? resolveImageDisplayUrl(data.videoUrl) : null;
  const lodStill = useSyncExternalStore(subscribeLodStills, () =>
    getLodStill(videoSource)
  );
  useEffect(() => {
    requestLodStill(videoSource);
  }, [videoSource]);

  const imageSrc =
    type === 'videoNode'
      ? (lodStill ?? (data.previewImageUrl ? resolveImageDisplayUrl(data.previewImageUrl) : null))
      : resolveShellImage(type, data);

  const busy = Boolean(data.isGenerating || data.isUploading);

  const style: CSSProperties = { width: w, height: h };

  return (
    <div className={`dc-lod-shell${selected ? ' dc-lod-shell--selected' : ''}`} style={style}>
      {nodeHasTargetHandle(type as CanvasNodeType) && (
        <Handle type="target" position={Position.Left} id="target" />
      )}
      {nodeHasSourceHandle(type as CanvasNodeType) && (
        <Handle type="source" position={Position.Right} id="source" />
      )}
      {imageSrc ? (
        <img src={imageSrc} alt="" draggable={false} className="dc-lod-shell__thumb" />
      ) : null}
      {busy ? <span className="dc-lod-shell__busy" data-node-id={id} /> : null}
    </div>
  );
}

const lowDetailSelector = (state: { transform: [number, number, number] }) =>
  isLowDetailZoom(state.transform[2]);

/**
 * 把节点组件包成「低缩放档渲染 shell、其余渲染原组件」。
 *
 * selector 返回 boolean，平移中 transform[0]/[1] 每帧变但返回值不变，不会造成
 * 每帧重渲染；只在缩放跨过阈值那一次全体切换。切换即完整组件的 mount/unmount，
 * 与 onlyRenderVisibleElements 的视口裁剪同构——组件早已被要求把重要状态放
 * store/模块级缓存（各组件内注释多处言明），此处不引入新的状态丢失面。
 */
// 各节点组件的 props 都是自家收窄过的 XxxNodeProps（interface data 不满足
// Record<string, unknown> 的结构约束），这里与 React Flow 的 NodeTypes 一样按
// 宽类型接收；运行期 React Flow 传入的本来就是完整 NodeProps。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNodeComponent = ComponentType<any>;

export function withLodShell(
  type: string,
  Component: AnyNodeComponent
): ComponentType<NodeProps> {
  const exempt = LOD_SHELL_EXEMPT_TYPES.has(type);
  const Wrapped = (props: NodeProps) => {
    const lowDetail = useStore(lowDetailSelector);
    // 画布单选中的节点（canvasStore.selectedNodeId）不 shell：
    //   - 低缩放下新建节点（放置流程会 setSelectedNode(newNodeId)）要立即以完整
    //     组件出现——shell 是无标题的小灰块，10% 下用户会以为「没创建上」；
    //   - 低缩放下点选节点（React Flow 选中经 onSelectionChange 同步回
    //     selectedNodeId）要能唤出完整组件和操作面板，与拆分前行为一致。
    // 框选/全选不会写 selectedNodeId（多选时同步为 null），不会击穿降级。
    // selector 返回 boolean 且只在自己被选中/取消时翻转，无重渲染风暴。
    const isActiveSelection = useCanvasStore(
      (state) => state.selectedNodeId === props.id
    );
    const wantShell =
      lowDetail && !exempt && !isActiveSelection && !isNodeMediaActive(props.id);

    // shell → 完整组件的切换永远经过升级队列（每帧限量放行，手势中不放行）：
    //   - 手势进行中新挂载的节点（视口裁剪把它换进来的）从 shell 起步，避免
    //     快速平移时每秒几十次完整挂载造成的稳态掉帧尖刺；
    //   - 缩放升档时视口内的所有 shell 分批升级，摊平原先单次提交的长帧。
    // 反方向（完整 → shell）立即生效：降档必须与裁剪开关同一提交（见 Canvas
    // 的 applyLowDetailClass 注释），且换成 shell 本身就便宜。
    const [heldShell, setHeldShell] = useState(
      () =>
        wantShell ||
        (!exempt && !isActiveSelection && isCanvasGestureActive())
    );
    if (wantShell && !heldShell) {
      // render 阶段同组件 setState 是 React 认可的「派生状态」写法，立即重渲染。
      setHeldShell(true);
    }
    useEffect(() => {
      if (!heldShell || wantShell) return;
      // 返回的取消函数在卸载/重新降档时把自己撤出队列。
      return requestShellUpgrade(() => setHeldShell(false));
    }, [heldShell, wantShell]);

    if (heldShell) {
      return (
        <LodShell
          type={type}
          id={props.id}
          data={props.data as ShellData}
          selected={props.selected}
          width={props.width}
          height={props.height}
        />
      );
    }
    return <Component {...props} />;
  };
  Wrapped.displayName = `withLodShell(${type})`;
  return memo(Wrapped);
}
