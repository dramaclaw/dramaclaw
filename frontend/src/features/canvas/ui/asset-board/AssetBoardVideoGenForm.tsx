// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useState, type ReactElement } from 'react';

import { VideoGenerationForm } from '@/features/canvas/nodes/shared/VideoGenerationForm';
import { useVideoGenerationForm } from '@/features/canvas/nodes/shared/useVideoGenerationForm';
import { spawnVideoAssetLibraryReferences } from '@/features/canvas/nodes/shared/assetLibraryReferenceSpawn';
import {
  AssetLibraryModal,
  type AssetLibrarySelection,
} from '@/features/canvas/ui/AssetLibraryModal';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';
import { readUrl } from '@/lib/url-params';

import { AssetBoardReferenceDropZone } from './AssetBoardReferenceDropZone';

/**
 * 表单在详情里的固定高度。比图片侧（184px）再高一档：视频表单的参数行多一整排
 * （模式 / 时长 / 场景优化 / 音频 / 真人审核 / 数量），矮了会把提示词区挤成一行。
 * 从 268 收到 204（用户要求）：提示词区仍有 5 行左右，省下的高度让给上方的
 * 视频内容框——详情现在是「媒体撑满 + 生成条钉底」，表单占多高就等于内容区少多高。
 */
const FORM_HEIGHT_PX = 204;

/**
 * 故事板详情里的视频生成条：媒体区下方挂 `VideoGenerationForm`，让**空视频节点**
 * 能从零出片、已有产物的节点能改参数重生成（与工作流走同一个
 * `useVideoGenerationForm`，因此提示词/参数/引用素材三边共用节点 data，两个视图
 * 天然同步）。
 *
 * `onOpenCharacterLibrary` 接的是真弹窗，不是死按钮：选中的图/视频/音频会在画布上
 * 生成对应类型的上游节点并连线到本节点（编排与工作流共用
 * `spawnVideoAssetLibraryReferences`），回流后表现为表单 chips 行里的引用素材。
 * 三类媒体全开（不像图片侧只收 image）——视频的 genMode 状态机正是靠上游类型驱动的。
 */
export function AssetBoardVideoGenForm({ nodeId }: { nodeId: string }): ReactElement {
  const { formProps } = useVideoGenerationForm(nodeId);
  const [isAssetLibraryOpen, setIsAssetLibraryOpen] = useState(false);

  const handleAssetLibraryConfirm = useCallback(
    (selections: ReadonlyArray<AssetLibrarySelection>) => {
      spawnVideoAssetLibraryReferences(nodeId, selections);
    },
    [nodeId],
  );

  return (
    <div className="flex w-full flex-col">
      {/* 参考区放置层：从左列表把图/视/音节点卡片拖进来 → addEdge 接成当前节点的上游
          引用，回流后经表单既有 upstream 派生显示为引用素材 chip（工作流零改动）。 */}
      <AssetBoardReferenceDropZone nodeId={nodeId}>
        <div
          className={`flex w-full flex-col rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS}`}
          style={{ height: FORM_HEIGHT_PX }}
        >
          {/* compact：详情里没有工作流那个叠在右上角的「放大」按钮，收掉 chips 行
              为它预留的 pr-10，否则第一行右侧凭空缺一块。 */}
          <VideoGenerationForm
            {...formProps}
            compact
            onOpenCharacterLibrary={() => setIsAssetLibraryOpen(true)}
          />
        </div>
      </AssetBoardReferenceDropZone>
      <AssetLibraryModal
        mode="pick"
        open={isAssetLibraryOpen}
        project={readUrl().project ?? null}
        onClose={() => setIsAssetLibraryOpen(false)}
        onConfirm={handleAssetLibraryConfirm}
      />
    </div>
  );
}
