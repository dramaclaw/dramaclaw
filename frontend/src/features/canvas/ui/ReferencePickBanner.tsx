// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 拾取参考时画布顶部的提示条。挂在画布容器上（不在 ReactFlow 的变换层里），
 * 所以不随缩放平移移动。
 *
 * 「返回节点」把视口还原到点 ＋参考 那一刻并退出拾取；「✕」原地退出。拾取本身
 * 不自动退出——一个节点常常要连好几个参考。
 */
import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Send, X } from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import { selectNodeExclusively } from '@/features/canvas/application/nodeSelection';
import { useReferencePickStore } from '@/features/canvas/application/referencePickStore';

export function ReferencePickBanner() {
  const request = useReferencePickStore((state) => state.request);
  const stop = useReferencePickStore((state) => state.stop);
  const reactFlowInstance = useReactFlow();

  // 目标节点被删掉（或切了画布）就没有拾取的意义了，自动退出，避免提示条挂死。
  const targetNodeId = request?.targetNodeId ?? null;
  const targetMissing = useCanvasStore((state) =>
    targetNodeId === null ? false : !state.nodes.some((node) => node.id === targetNodeId)
  );
  useEffect(() => {
    if (targetMissing) stop();
  }, [targetMissing, stop]);

  useEffect(() => {
    if (!targetNodeId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') stop();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [targetNodeId, stop]);

  if (!request) return null;

  const handleReturn = () => {
    // 顺手把目标节点重新选中：拾取途中多半点过画布空白，选中态早就丢了，
    // 而用户「返回节点」正是为了看刚挂上去的参考 chip——那要操作面板还在。
    selectNodeExclusively(request.targetNodeId);
    if (request.originViewport) {
      void reactFlowInstance.setViewport(request.originViewport, { duration: 420 });
    } else {
      const internals = reactFlowInstance.getInternalNode(request.targetNodeId)?.internals;
      if (internals) {
        const { x, y } = internals.positionAbsolute;
        void reactFlowInstance.setCenter(x, y, {
          zoom: reactFlowInstance.getZoom(),
          duration: 420,
        });
      }
    }
    stop();
  };

  return (
    <div className="pointer-events-none absolute left-1/2 top-4 z-[140] -translate-x-1/2">
      <div className="pointer-events-auto flex items-center gap-2 rounded-lg bg-[rgb(var(--accent-rgb))] py-1.5 pl-3 pr-1.5 text-[13px] leading-5 text-white shadow-[0_14px_34px_rgba(0,0,0,0.45)]">
        <Send className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">从画布选择参考</span>
        <button
          type="button"
          onClick={handleReturn}
          className="ml-1 inline-flex h-7 items-center rounded-md bg-white/[0.18] px-3 text-[12px] font-medium text-white transition-colors hover:bg-white/[0.3]"
        >
          返回节点
        </button>
        <button
          type="button"
          onClick={stop}
          title="退出选择"
          aria-label="退出选择"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-white/75 transition-colors hover:bg-white/[0.18] hover:text-white"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
