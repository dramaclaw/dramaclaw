// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState, type ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import {
  isBeatContextNode,
  isScriptNode,
  isTextAnnotationNode,
  isVideoStoryNode,
  type CanvasNode,
  type VideoStoryRow,
} from '@/features/canvas/domain/canvasNodes';

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * 表格单元格回写（与 VideoStoryNode.handleCellCommit 同形态）：行下标 + 列字段名 +
 * 新值，由宿主决定写回 data.rows 还是 data.scriptResult.rows。
 */
export type TextBodyCellCommit = (
  rowIndex: number,
  colKey: string,
  nextValue: string,
) => void;

/** 文本详情的 Markdown 阅读页（对齐 TextAnnotationNode 的 ReactMarkdown 配置）。 */
function MarkdownBody({ content }: { content: string }): ReactElement {
  return (
    <div className="text-sm leading-6 text-white/80">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          h1: ({ ...props }) => <h1 className="mb-2 mt-4 text-lg font-semibold text-foreground" {...props} />,
          h2: ({ ...props }) => <h2 className="mb-2 mt-4 text-base font-semibold text-foreground" {...props} />,
          h3: ({ ...props }) => <h3 className="mb-1 mt-3 text-sm font-semibold text-foreground" {...props} />,
          p: ({ ...props }) => <p className="my-1.5" {...props} />,
          strong: ({ ...props }) => <strong className="font-semibold text-foreground" {...props} />,
          em: ({ ...props }) => <em className="italic" {...props} />,
          ul: ({ ...props }) => <ul className="my-1.5 ml-5 list-disc" {...props} />,
          ol: ({ ...props }) => <ol className="my-1.5 ml-5 list-decimal" {...props} />,
          li: ({ ...props }) => <li className="my-0.5" {...props} />,
          code: ({ ...props }) => <code className="rounded bg-white/10 px-1 py-0.5 text-xs" {...props} />,
          hr: () => <hr className="my-3 border-white/10" />,
          table: ({ ...props }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[13px]" {...props} />
            </div>
          ),
          th: ({ ...props }) => (
            <th className="border-b border-white/10 px-2 py-1.5 text-left font-medium text-white/60" {...props} />
          ),
          td: ({ ...props }) => <td className="border-b border-white/5 px-2 py-1.5 align-top" {...props} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** 一格：展示值 + 该格对应的行/列坐标（有坐标才可编辑）。 */
interface RowCell {
  value: string;
  /** 回写用的列字段名；null → 该列只读（如镜号这种由数组顺序兜底的展示值）。 */
  colKey: string | null;
}

function cell(value: string, colKey: string | null = null): RowCell {
  return { value, colKey };
}

interface RowTableProps {
  headers: string[];
  rows: RowCell[][];
  /** 传了才可编辑：点击单元格进入编辑，失焦回写，Esc 放弃。 */
  onCellCommit?: TextBodyCellCommit;
}

/** 分镜/脚本的简单行表：镜号等窄列 + 内容宽列。 */
function RowTable({ headers, rows, onCellCommit }: RowTableProps): ReactElement {
  // 同一时刻只有一格在编辑（坐标 + 草稿），与 VideoStoryNode 的表格编辑同语义。
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const [draft, setDraft] = useState('');

  const commit = (rowIndex: number, colKey: string) => {
    onCellCommit?.(rowIndex, colKey, draft);
    setEditing(null);
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px] text-white/80">
        <thead>
          <tr>
            {headers.map((header) => (
              <th
                key={header}
                className="whitespace-nowrap border-b border-white/10 px-2 py-2 text-left font-medium text-white/50"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, rowIndex) => (
            <tr key={rowIndex}>
              {cells.map((item, cellIndex) => {
                const editable = Boolean(onCellCommit) && item.colKey !== null;
                const isEditing =
                  editing !== null && editing.row === rowIndex && editing.col === cellIndex;
                if (isEditing && item.colKey) {
                  const colKey = item.colKey;
                  return (
                    <td key={cellIndex} className="border-b border-white/5 px-1 py-1 align-top">
                      <textarea
                        value={draft}
                        autoFocus
                        rows={Math.min(6, Math.max(1, draft.split('\n').length))}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={() => commit(rowIndex, colKey)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            setEditing(null);
                          }
                        }}
                        className="w-full min-w-[80px] resize-y rounded border border-white/25 bg-white/[0.06] px-1.5 py-1 text-[13px] leading-5 text-white/90 outline-none"
                      />
                    </td>
                  );
                }
                return (
                  <td
                    key={cellIndex}
                    // 只读列保持原样式；可编辑列给出可点提示（hover 高亮 + 文本光标）。
                    className={`border-b border-white/5 px-2 py-2 align-top leading-5 ${
                      editable ? 'cursor-text rounded transition-colors hover:bg-white/[0.06]' : ''
                    }`}
                    title={editable ? '点击编辑' : undefined}
                    onClick={
                      editable
                        ? () => {
                            // 展示值里的 '-' 是「空」的占位，进编辑时不该被当成正文。
                            setDraft(item.value === '-' ? '' : item.value);
                            setEditing({ row: rowIndex, col: cellIndex });
                          }
                        : undefined
                    }
                  >
                    {item.value}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** scriptNode.scriptResult 是 unknown（后端 { title, rows[] }）——软取行记录。 */
export function scriptRowsOf(result: unknown): Array<Record<string, unknown>> {
  if (!result || typeof result !== 'object') return [];
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
}

/**
 * 「内容摘要」列眼下展示的是哪个字段——编辑要写回**正在展示的那个**，否则用户改的
 * 是 narrative、值却落进空的 visualDescription，表面上看像没生效。
 */
export function videoStorySummaryField(row: VideoStoryRow): 'visualDescription' | 'narrative' {
  return str(row.visualDescription) !== null || str(row.narrative) === null
    ? 'visualDescription'
    : 'narrative';
}

function videoStorySummary(row: VideoStoryRow): string {
  return str(row.visualDescription) ?? str(row.narrative) ?? '-';
}

interface AssetBoardDetailTextBodyProps {
  node: CanvasNode;
  /** 故事板条目标题（详情阅读页顶部的大标题，对齐 liblib 文本详情）。 */
  title: string;
  /**
   * script / videoStory 行表的单元格回写。传了才可编辑；宿主负责把
   * (rowIndex, colKey, value) 落回对应的 store 字段。
   */
  onCellCommit?: TextBodyCellCommit;
}

/**
 * 文本栏详情正文：textAnnotation / beatContext 渲染 Markdown；
 * scriptNode 渲染 scriptTitle + 行表；videoStoryNode 渲染镜头行表。
 */
export function AssetBoardDetailTextBody({
  node,
  title,
  onCellCommit,
}: AssetBoardDetailTextBodyProps): ReactElement {
  let body: ReactElement;
  if (isTextAnnotationNode(node) || isBeatContextNode(node)) {
    const content = str(node.data.content);
    body = content ? (
      <MarkdownBody content={content} />
    ) : (
      <p className="py-8 text-center text-[13px] text-muted-foreground">暂无文本内容</p>
    );
  } else if (isScriptNode(node)) {
    const rows = scriptRowsOf(node.data.scriptResult);
    const scriptTitle = str(node.data.scriptTitle);
    body = (
      <div className="flex flex-col gap-3">
        {scriptTitle && <h2 className="text-base font-semibold text-foreground">{scriptTitle}</h2>}
        {rows.length > 0 ? (
          <RowTable
            headers={['镜号', '时长', '画面描述', '对白']}
            onCellCommit={onCellCommit}
            rows={rows.map((row, index) => [
              cell(str(row.shot_no) ?? String(index + 1), 'shot_no'),
              cell(str(row.duration) ?? '-', 'duration'),
              cell(str(row.visual_description) ?? '-', 'visual_description'),
              cell(str(row.dialogue) ?? '-', 'dialogue'),
            ])}
          />
        ) : (
          <p className="py-8 text-center text-[13px] text-muted-foreground">暂无脚本内容</p>
        )}
      </div>
    );
  } else if (isVideoStoryNode(node)) {
    const rows = Array.isArray(node.data.rows) ? node.data.rows : [];
    body =
      rows.length > 0 ? (
        <RowTable
          headers={['镜号', '时长', '内容摘要']}
          onCellCommit={onCellCommit}
          rows={rows.map((row, index) => [
            cell(
              row.shotNumber !== null && row.shotNumber !== undefined && `${row.shotNumber}`.trim().length > 0
                ? `${row.shotNumber}`
                : String(index + 1),
              'shotNumber',
            ),
            cell(str(row.duration) ?? '-', 'duration'),
            cell(videoStorySummary(row), videoStorySummaryField(row)),
          ])}
        />
      ) : (
        <p className="py-8 text-center text-[13px] text-muted-foreground">暂无镜头行</p>
      );
  } else {
    // 文本栏兜底（未知文本类节点）：无结构化渲染路径。
    body = <p className="py-8 text-center text-[13px] text-muted-foreground">暂无可展示的内容</p>;
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      {body}
    </div>
  );
}
