// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react';

interface AssetBoardColumnProps {
  title: string;
  count: number;
  /** header 右侧的附加控件（如视频栏的筛选按钮组）。 */
  headerExtra?: ReactNode;
  /**
   * 替换 header 左侧默认标题（<h3>{title}+count）的自定义节点。详情态左窄列表用它
   * 挂「文本/图片/视频」切换下拉；不传则退回默认标题（三栏总览态、音频详情文本栏）。
   */
  titleSlot?: ReactNode;
  emptyText: string;
  children: ReactNode;
  /** 条目间加极淡分隔线（对齐 liblib 参考图的视频栏）。 */
  dividedItems?: boolean;
}

/**
 * 在条目之间插入真实的分隔线元素。
 *
 * 刻意不用 Tailwind 的 `divide-y`：v4 的 divide 规则包在 `:where()` 里（特指度 0），
 * 而卡片自己带 `border border-transparent`（hover 才变白）——卡片的 border-color
 * 稳赢，分隔线颜色被刷成透明，线等于没画。分隔线是独立元素就与卡片边框无关了。
 */
function withDividers(children: ReactNode): ReactNode {
  const items = Children.toArray(children);
  return items.map((child, index) => (
    // key 取子节点自己的 key（卡片按 nodeId keyed），不能用下标：栏内按创建顺序
    // 新→旧排，新建节点插在最前面，用下标当 key 会让每个 Fragment 位置上的子节点
    // key 整体错位，React 逐个卸载重挂整栏卡片——卡片本地态（图片自然尺寸缓存、
    // 定位高亮）全丢，没封面的视频还会重新拉一遍元数据。
    <Fragment key={isValidElement(child) && child.key !== null ? child.key : index}>
      {index > 0 && (
        <div aria-hidden data-testid="asset-board-item-divider" className="h-px shrink-0 bg-white/10" />
      )}
      {child}
    </Fragment>
  ));
}

export function AssetBoardColumn({
  title,
  count,
  headerExtra,
  titleSlot,
  emptyText,
  children,
  dividedItems = false,
}: AssetBoardColumnProps): ReactElement {
  // rounded-b-none: 故事板根容器 pb-0 让栏壳贴到底部，底边直角贴边（对标 liblib）。
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg rounded-b-none border border-white/5 bg-[#262626]">
      <header className="flex items-center justify-between gap-2 px-4 py-3">
        {titleSlot ?? (
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            {title}
            <span className="text-[10px] font-normal text-white/30">{count}</span>
          </h3>
        )}
        {headerExtra}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {count === 0 ? (
          <p className="px-2 py-8 text-center text-[12px] text-muted-foreground">{emptyText}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {dividedItems ? withDividers(children) : children}
          </div>
        )}
      </div>
    </section>
  );
}
