// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { AlertTriangle, Expand, FileVideo2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  type VideoStoryNodeData,
  type VideoStoryRow,
} from '@/features/canvas/domain/canvasNodes';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { localizeNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { NodeGenerationOverlay } from '@/features/canvas/ui/NodeGenerationOverlay';
import { EditableTableCell } from '@/features/canvas/ui/EditableTableCell';
import { CANVAS_NODE_PANEL_SURFACE_CLASS, canvasNodeFrameClass } from '@/features/canvas/ui/nodeFrameStyles';
import { useCanvasStore } from '@/stores/canvasStore';

type VideoStoryNodeProps = NodeProps & {
  id: string;
  data: VideoStoryNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 360;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 240;
const MAX_WIDTH = 1600;
const MAX_HEIGHT = 1200;

interface ColumnDef {
  key: keyof VideoStoryRow;
  label: string;
  /** Tailwind min-width class for the table cell. */
  widthClass: string;
  /** True for narrative-style long text columns. */
  wide?: boolean;
}

const COLUMNS: ColumnDef[] = [
  { key: 'shotNumber', label: '镜号', widthClass: 'min-w-[60px]' },
  { key: 'startTime', label: '开始时间', widthClass: 'min-w-[90px]' },
  { key: 'endTime', label: '结束时间', widthClass: 'min-w-[90px]' },
  { key: 'duration', label: '时长', widthClass: 'min-w-[70px]' },
  { key: 'visualDescription', label: '画面描述', widthClass: 'min-w-[220px]', wide: true },
  { key: 'narrative', label: '叙事内容', widthClass: 'min-w-[220px]', wide: true },
  { key: 'shotSize', label: '景别', widthClass: 'min-w-[80px]' },
  { key: 'cameraAngle', label: '摄影机角度', widthClass: 'min-w-[100px]' },
  { key: 'cameraMovement', label: '摄影机运动', widthClass: 'min-w-[120px]' },
  { key: 'focalAndDof', label: '焦距与景深', widthClass: 'min-w-[120px]' },
  { key: 'lighting', label: '光线', widthClass: 'min-w-[120px]' },
  { key: 'backgroundMusic', label: '背景音乐', widthClass: 'min-w-[140px]' },
  { key: 'voiceAndSfx', label: '人声/音效', widthClass: 'min-w-[140px]' },
  { key: 'imagePrompt', label: '图像生成提示词', widthClass: 'min-w-[260px]', wide: true },
  { key: 'videoMotionPrompt', label: '视频运动提示词', widthClass: 'min-w-[240px]', wide: true },
  { key: 'keyframeUrl', label: '关键帧', widthClass: 'min-w-[120px]' },
];

interface StoryCellProps {
  row: VideoStoryRow;
  col: ColumnDef;
  onCommit?: (nextValue: string) => void;
}

function StoryCell({ row, col, onCommit }: StoryCellProps) {
  const value = row[col.key];

  if (col.key === 'keyframeUrl') {
    // 关键帧是图片列，沿用只读 —— 替换需要文件选择器 / URL 输入，是另一
    // 条交互，等用户后续提（同 scriptNode 角色图列的处理）。
    const url = typeof value === 'string' ? value : null;
    if (!url) return <span className="text-text-muted/60">—</span>;
    return (
      <img
        src={resolveImageDisplayUrl(url)}
        alt="keyframe"
        className="h-16 w-auto rounded border border-[rgba(255,255,255,0.08)] object-cover"
        draggable={false}
      />
    );
  }

  const initialText =
    value == null
      ? ''
      : typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : JSON.stringify(value);

  if (!onCommit) {
    if (initialText.length === 0) {
      return <span className="text-text-muted/60">—</span>;
    }
    return (
      <span className={col.wide ? 'whitespace-pre-wrap' : ''}>{initialText}</span>
    );
  }

  return <EditableTableCell value={initialText} onCommit={onCommit} emptyPlaceholder="—" />;
}

interface StoryTableProps {
  rows: VideoStoryRow[];
  compact?: boolean;
  onCellCommit?: (rowIndex: number, colKey: keyof VideoStoryRow, nextValue: string) => void;
}

function StoryTable({ rows, compact, onCellCommit }: StoryTableProps) {
  return (
    <div className="ui-scrollbar h-full w-full overflow-auto rounded border border-[rgba(255,255,255,0.08)]">
      <table className="min-w-full border-collapse text-left text-[12px] text-text-dark">
        <thead className="sticky top-0 z-10 bg-bg-dark/95 backdrop-blur">
          <tr>
            {COLUMNS.map((col) => (
              <th
                key={col.key as string}
                className={`${col.widthClass} border-b border-[rgba(255,255,255,0.1)] px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-text-muted`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr
              key={idx}
              className="border-b border-[rgba(255,255,255,0.06)] align-top hover:bg-bg-dark/40"
            >
              {COLUMNS.map((col) => (
                <td
                  key={col.key as string}
                  className={`${col.widthClass} px-3 ${compact ? 'py-2' : 'py-3'} align-top`}
                >
                  <StoryCell
                    row={row}
                    col={col}
                    onCommit={
                      onCellCommit
                        ? (next) => onCellCommit(idx, col.key, next)
                        : undefined
                    }
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyStoryState({ rawResult }: { rawResult?: Record<string, unknown> | null }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="flex max-w-[460px] flex-col items-center gap-3 text-center">
        <div className="text-sm font-medium text-text-dark">未识别出分镜</div>
        <div className="text-[12px] leading-5 text-text-muted/80">
          返回内容中没有可用分镜行。原始返回已保留为辅助信息，可用于排查接口结果。
        </div>
        <details className="w-full rounded-md border border-white/[0.08] bg-bg-dark/45 text-left">
          <summary className="cursor-pointer list-none px-3 py-2 text-[11px] font-medium text-text-dark/82 transition-colors hover:text-text-dark">
            查看原始返回
          </summary>
          <pre className="ui-scrollbar max-h-[120px] overflow-auto border-t border-white/[0.06] p-3 text-[11px] leading-5 text-text-muted/86">
{rawResult ? JSON.stringify(rawResult, null, 2) : '(空)'}
          </pre>
        </details>
      </div>
    </div>
  );
}

function ErrorStoryState({ message }: { message: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="flex max-w-[420px] flex-col items-center gap-3 text-center">
        <AlertTriangle className="h-7 w-7 text-red-300/90" />
        <div className="text-sm font-medium text-red-200">解析失败</div>
        <div className="max-h-[88px] overflow-auto break-words text-[12px] leading-5 text-red-200/82 [overflow-wrap:anywhere]">
          {message}
        </div>
      </div>
    </div>
  );
}

export const VideoStoryNode = memo(({ id, data, selected, width, height }: VideoStoryNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const resolvedTitle = useMemo(
    () => localizeNodeDisplayName(CANVAS_NODE_TYPES.videoStory, data, t),
    [data, t],
  );
  const resolvedWidth = Math.max(MIN_WIDTH, Math.round(width ?? DEFAULT_WIDTH));
  const resolvedHeight = Math.max(MIN_HEIGHT, Math.round(height ?? DEFAULT_HEIGHT));

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  // Esc to exit fullscreen.
  useEffect(() => {
    if (!isFullscreen) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isFullscreen]);

  const cardToneClass = canvasNodeFrameClass({ selected });

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const isAnalyzing = Boolean(data.isAnalyzing);
  const hasError = Boolean(data.analysisError);
  const hasRows = rows.length > 0;

  // 表格单元格编辑：把编辑后的值写回 data.rows[idx][colKey]。
  // keyframeUrl 列在 StoryCell 里走只读分支，不会调到这里。
  const handleCellCommit = useCallback(
    (rowIndex: number, colKey: keyof VideoStoryRow, nextValue: string) => {
      const existing = rows[rowIndex];
      if (!existing) return;
      const prevRaw = existing[colKey];
      const prev = typeof prevRaw === 'string' ? prevRaw : prevRaw == null ? '' : String(prevRaw);
      if (prev === nextValue) return;
      const nextRows = rows.map((row, index) =>
        index === rowIndex ? { ...row, [colKey]: nextValue } : row,
      );
      updateNodeData(id, { rows: nextRows });
    },
    [id, rows, updateNodeData],
  );

  return (
    <div
      className="group relative h-full w-full overflow-visible"
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="target"
        className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
      />

      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<FileVideo2 className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <NodeResizeHandle
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        maxWidth={MAX_WIDTH}
        maxHeight={MAX_HEIGHT}
      />

      <div
        className={`relative flex h-full w-full flex-col overflow-hidden rounded-[var(--node-radius)] border ${CANVAS_NODE_PANEL_SURFACE_CLASS} transition-colors ${cardToneClass}`}
      >
        <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.08)] px-3 py-2">
          <div className="flex items-center gap-2 text-[12px] text-text-muted">
            {isAnalyzing ? (
              <span>解析中…</span>
            ) : hasError ? (
              <span className="text-red-300">解析失败</span>
            ) : hasRows ? (
              <span>{rows.length} 条分镜</span>
            ) : (
              <span>未识别出分镜</span>
            )}
          </div>
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded border border-[rgba(255,255,255,0.18)] bg-bg-dark/60 px-2 text-[11px] text-text-dark hover:border-[rgba(255,255,255,0.32)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-[rgba(255,255,255,0.18)]"
            onClick={(event) => {
              event.stopPropagation();
              setIsFullscreen(true);
            }}
            disabled={!hasRows}
          >
            <Expand className="h-3 w-3" />
            全屏
          </button>
        </div>
        <div className="flex-1 overflow-hidden p-2">
          {isAnalyzing ? (
            <div className="h-full w-full" />
          ) : hasError ? (
            <ErrorStoryState message={data.analysisError ?? '未知错误'} />
          ) : hasRows ? (
            <StoryTable rows={rows} compact onCellCommit={handleCellCommit} />
          ) : (
            <EmptyStoryState rawResult={data.rawResult ?? null} />
          )}
        </div>

        {isAnalyzing && (
          <NodeGenerationOverlay
            startedAt={data.analysisStartedAt ?? null}
            durationMs={90000}
            hasBackground={false}
            messageKey="canvas.analysisProgress"
          />
        )}
      </div>

      {typeof document !== 'undefined' && isFullscreen && createPortal(
        <div
          className="fixed inset-0 z-[220] flex flex-col bg-black/85 p-6"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-3 flex items-center justify-between text-text-dark">
            <div className="flex items-center gap-3">
              <FileVideo2 className="h-5 w-5" />
              <span className="text-base font-medium">{resolvedTitle}</span>
              <span className="text-sm text-text-muted">共 {rows.length} 条分镜</span>
            </div>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1 rounded border border-[rgba(255,255,255,0.2)] bg-bg-dark/60 px-3 text-sm text-text-dark hover:border-[rgba(255,255,255,0.36)]"
              onClick={() => setIsFullscreen(false)}
            >
              <X className="h-4 w-4" />
              关闭
            </button>
          </div>
          <div className="flex-1 overflow-hidden rounded-lg border border-[rgba(255,255,255,0.12)] bg-surface-dark/95">
            <StoryTable rows={rows} onCellCommit={handleCellCommit} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
});

VideoStoryNode.displayName = 'VideoStoryNode';
