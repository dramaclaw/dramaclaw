// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useRef, useState, type ReactElement } from 'react';
import { ChevronDown, ImageIcon, MessageSquarePlus } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/shadcn/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { AssetBoardItem } from '@/features/canvas/domain/assetBoard';
import { ADD_NODE_TO_CHAT_LABEL, addNodesToChat } from '@/features/canvas/ui/AddNodeToChatButton';
import {
  KEY_ELEMENT_CATEGORY_KEYS,
  KEY_ELEMENT_CATEGORY_LABEL,
  type KeyElementCategory,
} from '@/features/canvas/domain/keyElements';
import { cn } from '@/lib/utils';

import { AssetBoardAudioChip } from './AssetBoardAudioChip';

/** 「全部」+ 四个分类；关键元素标签内的分类下拉用它。 */
type CategoryFilter = 'all' | KeyElementCategory;

const FILTER_LABEL: Record<CategoryFilter, string> = {
  all: '全部',
  ...KEY_ELEMENT_CATEGORY_LABEL,
};

const FILTER_OPTIONS: readonly CategoryFilter[] = ['all', ...KEY_ELEMENT_CATEGORY_KEYS];

/** 顶栏两个标签：关键元素（带分类下拉）/ 音频。 */
type BarTab = 'keyElements' | 'audio';

/**
 * 故事板顶部栏（对标 liblib 顶部「关键元素 · 全部 ▾   音频」）：把两类常驻内容并进
 * 一条栏、用标签切换——
 *   - 关键元素：用户手动标记的画布节点（keyElementCategory 非空），带分类下拉筛选；
 *   - 音频：画布里的音频节点（复用 AssetBoardAudioChip，点开进音频详情）。
 *
 * 标签按内容存在与否显示：只有关键元素 → 只显示关键元素标签；只有音频 → 只显示音频
 * 标签（等价旧的独立音频条）；两者都有 → 双标签。宿主在「音频详情态」把 audioItems
 * 传空来隐藏音频标签（音频切换器那时搬到详情左栏，避免重复）。
 */
export function KeyElementsBar({
  keyItems,
  audioItems,
  activeAudioNodeId,
  onOpen,
}: {
  /** keyElementCategory 非空的条目（宿主跨栏收集）。 */
  keyItems: AssetBoardItem[];
  /** 音频条目（音频切换器就在这条音频标签里，含总览与音频详情两态）。 */
  audioItems: AssetBoardItem[];
  /** 当前打开的音频详情节点 id：非空 → 顶栏自动切到音频标签并高亮该 chip。 */
  activeAudioNodeId?: string | null;
  /** 点 chip 打开该节点详情（关键元素与音频共用）。 */
  onOpen: (item: AssetBoardItem) => void;
}): ReactElement {
  const hasKey = keyItems.length > 0;
  const hasAudio = audioItems.length > 0;
  const [tab, setTab] = useState<BarTab>(hasKey ? 'keyElements' : 'audio');
  const [filter, setFilter] = useState<CategoryFilter>('all');
  // 音频详情打开（activeAudioNodeId 指向某音频）→ 顶栏切到音频标签。渲染期派生同步
  // （同本仓 dataRef/leftListColumn 惯例），lastRef 守卫只在它变化时切一次，之后用户
  // 仍可手动切回关键元素。
  const lastActiveAudioRef = useRef<string | null | undefined>(undefined);
  if (activeAudioNodeId !== lastActiveAudioRef.current) {
    lastActiveAudioRef.current = activeAudioNodeId;
    if (activeAudioNodeId && tab !== 'audio') setTab('audio');
  }
  // 选中的标签若内容已空 → 回落到另一个有内容的标签，保证 activeTab 始终有效。
  const activeTab: BarTab =
    tab === 'audio' && !hasAudio ? 'keyElements' : tab === 'keyElements' && !hasKey ? 'audio' : tab;
  const visibleKey =
    filter === 'all' ? keyItems : keyItems.filter((item) => item.keyElementCategory === filter);

  const tabClass = (active: boolean) =>
    cn(
      'text-sm font-medium transition-colors',
      active ? 'text-foreground' : 'text-white/45 hover:text-white/70',
    );

  return (
    // 这条栏只是常驻索引，不该吃掉三栏的高度：缩略图 48px、上下 py-2.5、行距 gap-2
    // （原来 64px + py-3 + gap-3 高出一截，用户要求收窄）。
    <div className="flex shrink-0 flex-col gap-2 rounded-lg border border-white/5 bg-[#262626] px-4 py-2.5">
      <div className="flex items-center gap-4">
        {hasKey && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={() => setTab('keyElements')}
                className={cn(
                  '-mx-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-white/5',
                  tabClass(activeTab === 'keyElements'),
                )}
              >
                关键元素 · {FILTER_LABEL[filter]}
                <ChevronDown className="h-3.5 w-3.5 text-white/40" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={6}
              className="z-50 min-w-[120px] border-white/10 bg-[#2e2e2e] text-white/85 shadow-xl"
            >
              {FILTER_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option}
                  className={cn(
                    'rounded-[6px] text-white/80 focus:bg-white/[0.08] focus:text-white',
                    option === filter && 'text-white',
                  )}
                  onSelect={() => {
                    setFilter(option);
                    setTab('keyElements');
                  }}
                >
                  {FILTER_LABEL[option]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {hasAudio && (
          <button type="button" onClick={() => setTab('audio')} className={tabClass(activeTab === 'audio')}>
            音频
          </button>
        )}
      </div>

      {activeTab === 'audio' ? (
        <div className="flex items-start gap-3 overflow-x-auto">
          {audioItems.map((item) => (
            <AssetBoardAudioChip
              key={item.nodeId}
              item={item}
              onOpen={onOpen}
              selected={item.nodeId === activeAudioNodeId}
            />
          ))}
        </div>
      ) : visibleKey.length > 0 ? (
        // hoverable 浮层承载「添加到对话」pill：TooltipContent 走 Portal，不受这条
        // overflow-x-auto 裁剪；hover 缩略图即在其正上方浮出，点 pill 把该节点 @ 进虾导。
        <TooltipProvider delay={120}>
          <div className="flex items-start gap-3 overflow-x-auto">
            {visibleKey.map((item) => (
              <Tooltip key={item.nodeId}>
                <TooltipTrigger
                  render={
                    // 不再挂原生 title：与浮层提示并存会同时冒两个；可及名称由下方标题 span 提供。
                    <button
                      type="button"
                      onClick={() => onOpen(item)}
                      className="flex w-12 shrink-0 flex-col items-center gap-1"
                    >
                      <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-black/20 transition-colors hover:border-white/25">
                        {item.thumbnailUrl ? (
                          // alt="" 让缩略图是装饰性的：按钮可及名称由下方标题 span 提供。
                          <img
                            src={item.thumbnailUrl}
                            alt=""
                            loading="lazy"
                            draggable={false}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <ImageIcon className="h-5 w-5 text-white/30" />
                        )}
                      </span>
                      <span className="w-full truncate text-center text-[11px] text-white/60">
                        {item.title}
                      </span>
                    </button>
                  }
                />
                <TooltipContent
                  side="top"
                  sideOffset={6}
                  showArrow={false}
                  className="border-0 bg-transparent p-0 shadow-none"
                >
                  <button
                    type="button"
                    onClick={(event) => {
                      // 不冒泡到缩略图：它的 onClick 会打开详情，这里只要把节点 @ 进虾导。
                      event.stopPropagation();
                      addNodesToChat([item.nodeId]);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-md bg-[#2e2e2e] px-2.5 py-1.5 text-xs font-medium text-white/90 shadow-xl ring-1 ring-white/10 transition-colors hover:bg-[#3a3a3a] hover:text-white"
                  >
                    <MessageSquarePlus className="h-3.5 w-3.5" />
                    {ADD_NODE_TO_CHAT_LABEL}
                  </button>
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </TooltipProvider>
      ) : (
        // 关键元素标签下、当前分类为空（切了个空分类）：占位而不塌成没有内容。
        <p className="py-1 text-[12px] text-white/40">该分类下暂无关键元素</p>
      )}
    </div>
  );
}
