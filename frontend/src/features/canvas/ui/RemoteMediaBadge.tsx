// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 「这是网络素材，没存到本地」角标（withLodShell 注入，shell 档和完整组件都有）。
 *
 * LibTV 导入时镜像不下来的素材会保留远端地址。这类节点在画布上**看着完全正常**——
 * 图能显示——但它和本地素材有本质区别：
 *   - 喂不进本地模型（生成/编辑要的是本地可读的文件）
 *   - 不能当作参考图
 *   - LibTV 一撤下就变裂图
 * 所以要和本地素材区分开，并且把**具体原因**说出来：用户得据此判断是重试、换素材，
 * 还是改配置，只说「未本地保存」等于没说。
 *
 * 刻意做成角标而不是 ForeignMediaNodeOverlay 那样的全覆盖遮罩：那个场景是图根本
 * 打不开（403 裂图），必须挡住并给修复入口；这里图是好的，挡住反而帮倒忙。
 */
import { useTranslation } from 'react-i18next';
import { CloudOff } from 'lucide-react';

import {
  readRemoteMediaRefs,
  remoteMediaReasonKey,
} from '@/features/canvas/domain/canvasRemoteMedia';

export function RemoteMediaBadge({ data }: { data: unknown }) {
  const { t } = useTranslation();
  const refs = readRemoteMediaRefs(data);
  if (refs.length === 0) return null;

  // 同一节点里多条素材可能因为不同原因落空，原因去重后一起说明。
  const reasons = [...new Set(refs.map((ref) => t(remoteMediaReasonKey(ref.reason))))];
  const title = [
    t('canvas.remoteMedia.title', { count: refs.length }),
    ...reasons,
    t('canvas.remoteMedia.consequence'),
  ].join('\n');

  return (
    <div
      className="pointer-events-auto absolute bottom-1.5 left-1.5 z-[40] flex items-center gap-1 rounded-md bg-[#1b1b1b]/92 px-1.5 py-0.5 text-[10px] font-medium text-amber-300/95 ring-1 ring-amber-400/35 backdrop-blur-sm"
      title={title}
    >
      <CloudOff aria-hidden className="h-3 w-3" />
      <span>{t('canvas.remoteMedia.badge')}</span>
      {refs.length > 1 ? <span className="opacity-70">×{refs.length}</span> : null}
    </div>
  );
}
