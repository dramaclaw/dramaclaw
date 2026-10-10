// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';

import {
  applyColumnResize,
  useAssetBoardColumnFractions,
  type ColumnFractions,
} from './useAssetBoardColumnFractions';

/** 单栏最小宽度：拖到底不塌陷（对标 liblib 的栏宽下限）。 */
const MIN_COLUMN_PX = 200;

interface AssetBoardColumnsProps {
  /** 三栏内容（文本 / 图片 / 视频）。音频条不参与，独立在上方全宽渲染。 */
  text: ReactNode;
  image: ReactNode;
  video: ReactNode;
}

/** 拖拽会话：pointerdown 时快照起点，move/up 从事件 clientX 重算，避免闭包读到陈旧 state。 */
interface DragSession {
  handleIndex: 0 | 1;
  startX: number;
  startFractions: ColumnFractions;
  width: number;
}

/** jsdom / 老浏览器可能没有 pointer capture —— 存在才调用，且吞掉激活态异常。 */
function safeSetPointerCapture(el: Element, pointerId: number): void {
  if (typeof el.setPointerCapture !== 'function') return;
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // pointer 未激活等边界，忽略即可。
  }
}

function safeReleasePointerCapture(el: Element, pointerId: number): void {
  if (typeof el.releasePointerCapture !== 'function') return;
  try {
    el.releasePointerCapture(pointerId);
  } catch {
    // 同上。
  }
}

/**
 * 总览态三栏容器：文本 / 图片 / 视频 之间挂两条可拖拽分隔条，实时调宽并把比例
 * 持久化到 localStorage（松手落库）。仅总览态使用——进详情态时本组件整体卸载，
 * 退回时重挂载并从 localStorage 恢复比例（故详情态天然不受 fractions 影响）。
 */
export function AssetBoardColumns({ text, image, video }: AssetBoardColumnsProps): ReactElement {
  const { fractions, setFractions, commitFractions } = useAssetBoardColumnFractions();
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  const [dragging, setDragging] = useState(false);

  // 拖拽期禁用文本选中并统一光标，松手/卸载还原（SSR 无 document 时 effect 本就不跑）。
  useEffect(() => {
    if (!dragging) return;
    const { body } = document;
    const prevUserSelect = body.style.userSelect;
    const prevCursor = body.style.cursor;
    body.style.userSelect = 'none';
    body.style.cursor = 'col-resize';
    return () => {
      body.style.userSelect = prevUserSelect;
      body.style.cursor = prevCursor;
    };
  }, [dragging]);

  const handlePointerDown = useCallback(
    (handleIndex: 0 | 1) => (event: ReactPointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;
      const width = container.getBoundingClientRect().width;
      // SSR/未布局/零宽兜底：拿不到有效宽度就不进入拖拽（换算会除以 0）。
      if (!(width > 0)) return;
      event.preventDefault();
      dragRef.current = { handleIndex, startX: event.clientX, startFractions: fractions, width };
      setDragging(true);
      safeSetPointerCapture(event.currentTarget, event.pointerId);
    },
    [fractions],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const session = dragRef.current;
      if (!session) return;
      const next = applyColumnResize(
        session.startFractions,
        session.handleIndex,
        event.clientX - session.startX,
        session.width,
        MIN_COLUMN_PX,
      );
      setFractions(next);
    },
    [setFractions],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const session = dragRef.current;
      if (!session) return;
      // 从 pointerup/cancel 的 clientX 重算最终比例（= 最后一次 move 的位置），
      // 无需额外 ref 镜像 state，规避 setState 异步导致的陈旧闭包。
      const next = applyColumnResize(
        session.startFractions,
        session.handleIndex,
        event.clientX - session.startX,
        session.width,
        MIN_COLUMN_PX,
      );
      dragRef.current = null;
      setDragging(false);
      safeReleasePointerCapture(event.currentTarget, event.pointerId);
      commitFractions(next); // 松手落库
    },
    [commitFractions],
  );

  const renderHandle = (handleIndex: 0 | 1): ReactElement => (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整栏宽"
      data-testid={`asset-board-resizer-${handleIndex}`}
      onPointerDown={handlePointerDown(handleIndex)}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      // w-3 命中区（12px），内嵌 w-1 细条视觉；hover / 拖拽中提亮，克制对齐面板 token。
      className="group relative flex w-3 shrink-0 cursor-col-resize touch-none items-stretch justify-center"
    >
      <div
        className={cn(
          'my-1 w-1 rounded-full transition-colors',
          dragging ? 'bg-white/10' : 'bg-white/5 group-hover:bg-white/10',
        )}
      />
    </div>
  );

  const columnStyle = (fraction: number) => ({
    flexGrow: fraction,
    flexBasis: 0,
    minWidth: MIN_COLUMN_PX,
  });

  return (
    <div
      ref={containerRef}
      data-testid="asset-board-columns"
      className={cn('flex min-h-0 flex-1', dragging && 'select-none')}
    >
      <div
        data-testid="asset-board-column-wrapper-text"
        className="flex min-h-0 min-w-0"
        style={columnStyle(fractions[0])}
      >
        {text}
      </div>
      {renderHandle(0)}
      <div
        data-testid="asset-board-column-wrapper-image"
        className="flex min-h-0 min-w-0"
        style={columnStyle(fractions[1])}
      >
        {image}
      </div>
      {renderHandle(1)}
      <div
        data-testid="asset-board-column-wrapper-video"
        className="flex min-h-0 min-w-0"
        style={columnStyle(fractions[2])}
      >
        {video}
      </div>
    </div>
  );
}
