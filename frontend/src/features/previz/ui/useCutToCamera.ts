// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { usePrevizStore } from '../store';

/**
 * 三个切镜入口（镜头轨下拉、机位轨表头按钮、数字键）共用的一层：调 store，
 * 把「没空间」「到上限」翻成 toast。同机位与非机位静默——连按两下 1 不该弹窗。
 */
export function useCutToCamera(): (cameraId: string) => void {
  const { t } = useTranslation();
  const cutToCamera = usePrevizStore((state) => state.cutToCamera);
  return useCallback(
    (cameraId: string) => {
      const rejection = cutToCamera(cameraId);
      if (rejection === 'no-room') toast.error(t('previz.program.noRoom'));
      else if (rejection === 'limit') toast.error(t('previz.program.limit'));
    },
    [cutToCamera, t],
  );
}
