// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import {
  RotateEditorToolbar,
  useRotateEditor,
} from '@/features/canvas/ui/rotateEditorContent';

interface AssetBoardRotateDialogProps {
  /** 旋转写回的目标节点 id（调用方进入前预建的「旋转结果」节点）。 */
  nodeId: string;
  imageSource: string;
  /** `committed=false` 时调用方需要回收预建的结果节点，见 useRotateEditor 的说明。 */
  onClose: (committed: boolean) => void;
  /** 提交起飞后把 completion 交给调用方挂 busy 态与失败反馈。 */
  onCommitted: (completion: Promise<void>) => void;
}

/**
 * 故事板详情里的旋转编辑器：大图实时预览 + 悬浮在图上的一条控制条（对齐 libtv）。
 *
 * 与工作流的 RotateEditorOverlay 是同一套内容层（rotateEditorContent），只是外壳
 * 不同——那边挂 React Flow 的 NodeToolbar，故事板详情没有 React Flow，走 portal 到
 * body 的 z-[300] 全屏层（同 RedrawOverlay / EraseOverlay 的层级与遮罩配方）。
 *
 * 取景框刻意做成**正方形**：图片 object-contain 进一个正方形框后，任意角度旋转的
 * 外接尺寸都不会超出这个框，于是不需要按实际宽高算缩放补偿，转 90° 也不会被裁。
 *
 * Esc 由 useRotateEditor 统一处理，这里不再另挂一份（否则一次 Esc 会关两遍）。
 */
export function AssetBoardRotateDialog({
  nodeId,
  imageSource,
  onClose,
  onCommitted,
}: AssetBoardRotateDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const controller = useRotateEditor({ nodeId, imageSource, onClose, onCommitted });

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('rotateEditor.title')}
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/72 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget && !controller.isSaving) {
          controller.onExit();
        }
      }}
    >
      {/* 不裁切：正方形取景框已经保证任意角度旋转都不出框，而控制条比窄图更宽时
          需要能溢出到图外，overflow-hidden 会把它两端切掉。 */}
      <div className="flex h-[min(72vh,76vw)] w-[min(72vh,76vw)] items-center justify-center">
        {/* 内层只包住图片本身：transform 不影响布局盒，所以这个 wrapper 始终是图片
            未旋转时的取景框，控制条锚在它上面就会贴着图走，不会因为外层是正方形而
            被甩到一片空白里。 */}
        <div className="relative">
          <img
            src={imageSource}
            alt=""
            draggable={false}
            className="block max-h-[min(72vh,76vw)] max-w-[min(72vh,76vw)] object-contain"
            style={{
              transform: controller.transform,
              transition: 'transform 120ms ease-out',
            }}
          />

          {/* 控制条浮在图片**上方**而不是压在图上——压上去会挡住画面顶部（用户反馈）。
              bottom-full 贴着图片上边缘往外放，取景框收到 72vh 就是为了给它留出这条
              空间（竖图撑满高度时也不会被顶出视口）。
              inset-x-0 + justify-center 而不是 left-1/2 + translate：后者会把绝对定位
              元素的可用宽度砍到一半，控制条被挤窄后文案会竖排。 */}
          <div className="absolute inset-x-0 bottom-full mb-3 flex justify-center">
            <RotateEditorToolbar controller={controller} showTitle />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
