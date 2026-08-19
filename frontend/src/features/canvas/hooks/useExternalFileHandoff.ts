// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef } from 'react';

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
 * onFile 由调用方自己做类型校验（VideoNode 只收视频等），这里不做过滤。它存在 ref
 * 里、不进 effect 依赖：调用方忘了 useCallback（或它的依赖每帧都变）时，订阅不该
 * 跟着退订重订 —— 那会在退订与重订之间留出丢事件的窗口，也会让「挂载补投」在每次
 * 渲染都跑一遍。
 */
export function useExternalFileHandoff(
  channel: ExternalFileChannel,
  nodeId: string,
  onFile: (file: File) => void,
): void {
  // useRef(onFile) 已经带上首帧的值，所以挂载时那次补投拿到的就是最新回调；
  // 这个 effect 声明在订阅 effect 之前，后续更新也总是先于它跑。
  const onFileRef = useRef(onFile);
  useEffect(() => {
    onFileRef.current = onFile;
  });

  useEffect(() => {
    const drain = () => {
      const file = takeExternalFile(channel, nodeId);
      if (file) onFileRef.current(file);
    };
    drain();
    return canvasEventBus.subscribe(channel, ({ nodeId: targetId }) => {
      if (targetId !== nodeId) return;
      drain();
    });
  }, [channel, nodeId]);
}
