// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import {
  CropEditorSurface,
  CropEditorToolbar,
  useCropEditor,
} from '@/features/canvas/ui/cropEditorContent';

interface AssetBoardCropDialogProps {
  /** 裁剪写回的目标节点 id（调用方进入前预建的「裁剪结果」节点）。 */
  nodeId: string;
  imageSource: string;
  /** `committed=false` 时调用方需要回收预建的结果节点，见 useCropEditor 的说明。 */
  onClose: (committed: boolean) => void;
  /** 提交起飞后把 completion 交给调用方挂 busy 态与失败反馈。 */
  onCommitted: (completion: Promise<void>) => void;
}

/**
 * 故事板详情里的裁剪编辑器：大图 + 取景框 + 悬浮在图上方的一条控制条（对齐 liblib）。
 *
 * 外壳与 AssetBoardRotateDialog 同配方（portal 到 body 的 z-[300] 全屏遮罩），差别
 * 只在取景框不需要正方形容器——裁剪不旋转，图按自身比例 object-contain 铺开即可，
 * 取景框用百分比落在图上（见 cropEditorContent 的坐标系说明）。
 *
 * Esc 由 useCropEditor 统一处理，这里不再另挂一份（否则一次 Esc 会关两遍）。
 */
export function AssetBoardCropDialog({
  nodeId,
  imageSource,
  onClose,
  onCommitted,
}: AssetBoardCropDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const controller = useCropEditor({ nodeId, imageSource, onClose, onCommitted });

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('cropEditor.title')}
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/72 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget && !controller.isSaving) {
          controller.onExit();
        }
      }}
    >
      {/* 只包住图片本身：控制条锚在它上边缘外侧（bottom-full），窄图也会贴着图走。
          图高收到 72vh 就是为了给控制条留出这条空间。 */}
      <div className="relative">
        <CropEditorSurface
          controller={controller}
          imageSource={imageSource}
          className="max-h-[72vh] max-w-[86vw]"
        />

        <div className="absolute inset-x-0 bottom-full mb-3 flex justify-center">
          <CropEditorToolbar controller={controller} showTitle />
        </div>
      </div>
    </div>,
    document.body,
  );
}
