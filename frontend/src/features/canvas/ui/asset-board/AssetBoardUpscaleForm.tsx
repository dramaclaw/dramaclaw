// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { type ReactElement } from 'react';

import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';
import {
  UpscaleEditorPanel,
  useUpscaleEditor,
} from '@/features/canvas/ui/upscaleEditorContent';
import { useCanvasStore } from '@/stores/canvasStore';

/**
 * 故事板详情里的「高清放大」编辑器：挂在媒体区下方，与图片/视频/音频详情的生成
 * 表单同一个位置、同一套「上面看图、下面调参数、按 ↑ 提交」的节奏（对齐 liblib）。
 *
 * 走的是「先建节点、按 ↑ 才提交」：点工具条「编辑 → 高清」时就已经在源图下游建好
 * 这个 resultKind:'upscale' 的占位节点并把详情切了过来（见 AssetBoardImageOps 的
 * handleOpenHd），所以这里只负责改参数与提交，不再管建节点。
 *
 * 卡片本体与工作流的 UpscaleEditorOverlay 共用 `upscaleEditorContent`，只是外壳从
 * 「节点下方的浮层」换成「详情面板里铺满的表单」，并且不给「取消」——详情头部已经
 * 有返回与删除，卡片里再放一颗会和它们语义打架。
 */
export function AssetBoardUpscaleForm({ nodeId }: { nodeId: string }): ReactElement | null {
  const node = useCanvasStore((state) => state.nodes.find((n) => n.id === nodeId) ?? null);
  // 节点在详情打开期间被删（头部「...」→ 删除）时优雅退场，而不是让下面的 hook
  // 拿着一个 null 节点跑。
  if (!node) return null;
  return <UpscaleFormBody key={node.id} node={node} />;
}

/** 拆一层只为让 useUpscaleEditor 拿到非空 node —— hook 不能写在早退分支之后。 */
function UpscaleFormBody({ node }: { node: CanvasNode }): ReactElement {
  const controller = useUpscaleEditor({ node });
  return (
    <UpscaleEditorPanel
      controller={controller}
      className={`w-full rounded-[var(--node-radius)] p-4 ${CANVAS_NODE_OPS_PANEL_CLASS}`}
    />
  );
}
