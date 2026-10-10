// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, type ReactElement } from 'react';

import {
  isScriptNode,
  isVideoStoryNode,
  type CanvasNode,
  type CanvasNodeData,
  type ScriptNodeData,
  type VideoStoryRow,
} from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

import {
  AssetBoardDetailTextBody,
  scriptRowsOf,
  type TextBodyCellCommit,
} from './AssetBoardDetailTextBody';
/**
 * 文本详情正文分派（纯只读阅读页——按用户要求，文本类详情不挂任何功能按钮，
 * 生成/派生/解析一律回工作流侧的节点上做）：
 * - script → 只读脚本表 + 行表单元格编辑（生成中不给改）；
 * - videoStory → 只读分镜表 + 行表单元格编辑（解析中不给改）；
 * - 其余文本类节点（textAnnotation / beatContext）直接落只读正文。
 */
export function AssetBoardDetailTextSection({
  node,
  title,
}: {
  node: CanvasNode;
  title: string;
}): ReactElement {
  if (isScriptNode(node)) {
    return <ScriptDetail node={node} title={title} />;
  }
  if (isVideoStoryNode(node)) {
    return <VideoStoryDetail node={node} title={title} />;
  }
  return <AssetBoardDetailTextBody node={node} title={title} />;
}

function ScriptDetail({ node, title }: { node: CanvasNode; title: string }): ReactElement {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const data = node.data as ScriptNodeData;
  // 生成/历史入口已从故事板文本详情移除（只读阅读页，生成仍在工作流 ScriptNode 上做），
  // 因此不再挂 useScriptStorySubmit / useNodeGenerationHistory 及其上游 references 推导。
  // 这里只需要「是否生成中」来禁用行内编辑——直接读节点数据即可。
  const isGenerating = data.isGenerating === true;

  // 行表单元格回写：结果整体是 unknown（后端 { title, rows[] }），只换 rows 那一项，
  // 其余字段（title 等）原样带过去。生成中不给改——回填会把编辑覆盖掉。
  const handleCellCommit = useCallback<TextBodyCellCommit>(
    (rowIndex, colKey, nextValue) => {
      const result = data.scriptResult;
      const rows = scriptRowsOf(result);
      const existing = rows[rowIndex];
      if (!existing) return;
      const prevRaw = existing[colKey];
      const prev = typeof prevRaw === 'string' ? prevRaw : prevRaw == null ? '' : String(prevRaw);
      if (prev === nextValue) return;
      const nextRows = rows.map((row, index) =>
        index === rowIndex ? { ...row, [colKey]: nextValue } : row,
      );
      updateNodeData(node.id, {
        scriptResult: { ...(result as Record<string, unknown>), rows: nextRows },
      } as Partial<CanvasNodeData>);
    },
    [data.scriptResult, node.id, updateNodeData],
  );

  const generationError =
    typeof data.generationError === 'string' && data.generationError.trim().length > 0
      ? data.generationError
      : null;

  return (
    // 只读阅读页：不出「生成分镜脚本 / 历史」等功能按钮（用户要求，生成仍在工作流侧
    // 的 ScriptNode 上做）；这里只展示脚本表 + 允许行内单元格编辑。
    <div className="flex w-full flex-col gap-3">
      {generationError && (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-200">
          {generationError}
        </p>
      )}
      <AssetBoardDetailTextBody
        node={node}
        title={title}
        onCellCommit={isGenerating ? undefined : handleCellCommit}
      />
    </div>
  );
}

function VideoStoryDetail({ node, title }: { node: CanvasNode; title: string }): ReactElement {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const data = node.data as Record<string, unknown>;
  // 解析中：结果回填会覆盖行内编辑，所以这期间不给改（下方 onCellCommit 守卫）。
  const isAnalyzing = data.isAnalyzing === true;
  const analysisError =
    typeof data.analysisError === 'string' && data.analysisError.trim().length > 0
      ? data.analysisError
      : null;

  // 行表单元格回写：与 VideoStoryNode.handleCellCommit 同一形态（同值不写、
  // 整行浅拷贝后替换那一列）。
  const handleCellCommit = useCallback<TextBodyCellCommit>(
    (rowIndex, colKey, nextValue) => {
      const rows = (Array.isArray(data.rows) ? data.rows : []) as VideoStoryRow[];
      const existing = rows[rowIndex];
      if (!existing) return;
      const prevRaw = existing[colKey as keyof VideoStoryRow];
      const prev = typeof prevRaw === 'string' ? prevRaw : prevRaw == null ? '' : String(prevRaw);
      if (prev === nextValue) return;
      const nextRows = rows.map((row, index) =>
        index === rowIndex ? { ...row, [colKey]: nextValue } : row,
      );
      updateNodeData(node.id, { rows: nextRows } as Partial<CanvasNodeData>);
    },
    [data.rows, node.id, updateNodeData],
  );

  return (
    // 只读阅读页：文本类详情一律不挂功能按钮（用户要求），生成/解析仍在工作流侧做。
    <div className="flex w-full flex-col gap-3">
      {analysisError && (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-200">
          {analysisError}
        </p>
      )}
      <AssetBoardDetailTextBody
        node={node}
        title={title}
        // 解析中不给改——结果回填会把编辑覆盖掉。
        onCellCommit={isAnalyzing ? undefined : handleCellCommit}
      />
    </div>
  );
}
