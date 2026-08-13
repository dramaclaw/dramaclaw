// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect } from 'react';

import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import {
  takeExternalFile,
  type ExternalFileChannel,
} from '@/features/canvas/application/pendingExternalFiles';

/**
 * 节点侧接收「外部注入的 File」。UploadNode / VideoNode / AudioNode 共用。
 *
 * 挂载时先补投一次、之后每收到事件再取一次 —— 两处都走消费性的
 * takeExternalFile，所以同一个 File 只会被处理一次。为什么必须有「挂载补投」这条
 * 路：低缩放档下新节点先以 LOD shell 挂载，完整组件晚于投递那一帧才挂上订阅，只订
 * 阅事件的话 File 会随总线的无重放语义一起丢（见 [[pendingExternalFiles]]）。
 *
 * onFile 由调用方自己做类型校验（VideoNode 只收视频等），这里不做过滤。它每次
 * 渲染换了引用也只会让 effect 重跑，重跑时暂存已空，不会重复处理。
 */
export function useExternalFileHandoff(
  channel: ExternalFileChannel,
  nodeId: string,
  onFile: (file: File) => void,
): void {
  useEffect(() => {
    const drain = () => {
      const file = takeExternalFile(channel, nodeId);
      if (file) onFile(file);
    };
    drain();
    return canvasEventBus.subscribe(channel, ({ nodeId: targetId }) => {
      if (targetId !== nodeId) return;
      drain();
    });
  }, [channel, nodeId, onFile]);
}
