// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 点提示词里某个 @ 引用上的替换图标后弹出的选单：把这处 @ 改指到别的素材。
 *
 * 分两段，因为「换成什么」有两种来源，代价不一样：
 * - 已引用：本节点当前就连着的素材，换过去只改这处 @ 的指向，引用行不动；
 * - 素材引用：画布上还没连过来的素材，选中会先把它连成上游（引用行多一条），
 *   再把这处 @ 换成它。用户拿到的是「换了指向，且新素材也进了参考」。
 *
 * 素材按图片 / 视频 / 音频分组、悬停展开右侧列表：画布大了以后这份清单可以有几十
 * 条，一次全铺开会把选单拉成一根长条，而用户心里通常已经知道自己要找的是哪一类。
 * 一旦开始搜索就拉平成一个列表——搜的时候按种类翻反而碍事。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ChevronRight, Film, Image as ImageIcon, Search } from 'lucide-react';

import type {
  ReferenceMaterialOption,
  ReferenceMediaKind,
} from '@/features/canvas/application/referencePick';
import { placeAnchoredMenu } from '@/features/canvas/nodes/shared/anchoredMenuPlacement';

import { mentionChipLabel, type MentionCandidate } from './PromptMentionEditor';

const POPOVER_WIDTH = 236;
const SUBMENU_WIDTH = 208;
const LIST_MAX_HEIGHT = 268;
const SUBMENU_MAX_HEIGHT = 300;
const EDGE_GAP = 8;
const ANCHOR_GAP = 4;
/** 搜索框那一行（含选单自身的 padding 与它下方的间距）占掉的高度。 */
const SEARCH_ROW_HEIGHT = 46;

const KIND_ORDER: readonly ReferenceMediaKind[] = ['image', 'video', 'audio'];
const KIND_LABEL: Record<ReferenceMediaKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
};

export interface MentionReplacePopoverProps {
  /** 被点击的那颗 chip 的位置，选单贴着它下沿展开。 */
  anchorRect: DOMRect;
  /** 「已引用」段：本节点当前的引用素材。 */
  referenced: readonly MentionCandidate[];
  /** 「素材引用」段：画布上还没被引用的素材。 */
  materials: readonly ReferenceMaterialOption[];
  onPickReferenced: (candidate: MentionCandidate) => void;
  onPickMaterial: (material: ReferenceMaterialOption) => void;
  /** Escape 关闭。选单一打开焦点就在搜索框上，编辑器那边收不到这颗键。 */
  onClose: () => void;
}

/**
 * 行首的方形缩略图。取不到图时按 kind 画占位图标——早先一律画 ♪，结果是「还没
 * 出图的图片素材」顶着一个音符，连它所在的分组行都被带偏。
 */
function RowThumb({
  imageUrl,
  videoUrl,
  kind,
}: {
  imageUrl?: string;
  videoUrl?: string;
  kind?: ReferenceMediaKind;
}) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt=""
        className="h-7 w-7 shrink-0 rounded object-cover"
        draggable={false}
      />
    );
  }
  if (videoUrl) {
    return (
      <video
        src={videoUrl}
        className="h-7 w-7 shrink-0 rounded object-cover"
        muted
        playsInline
        preload="metadata"
        draggable={false}
      />
    );
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-white/[0.06] text-[13px] text-accent">
      {kind === 'image' ? (
        <ImageIcon className="h-3.5 w-3.5" aria-hidden />
      ) : kind === 'video' ? (
        <Film className="h-3.5 w-3.5" aria-hidden />
      ) : (
        '♪'
      )}
    </span>
  );
}

const ROW_CLASS =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-white/[0.08] hover:text-text-dark';

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-1.5 text-[10px] uppercase tracking-wide text-text-muted/60">
      {children}
    </div>
  );
}

export function MentionReplacePopover({
  anchorRect,
  referenced,
  materials,
  onPickReferenced,
  onPickMaterial,
  onClose,
}: MentionReplacePopoverProps) {
  const [query, setQuery] = useState('');
  // 展开中的种类分组 + 它那一行的位置（右侧列表用 fixed 定位，避开选单自身的滚动裁切）。
  const [openGroup, setOpenGroup] = useState<{
    kind: ReferenceMediaKind;
    top: number;
    left: number;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    // 选单自己消化键盘事件：它是 portal 出去的兄弟节点，冒泡上去也到不了编辑器，
    // 而编辑器的方向键 / Enter 候选导航更不该被这里的输入喂到。
    event.stopPropagation();
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (openGroup) {
      // 先收起展开的种类列表，再按一次才关整个选单。
      setOpenGroup(null);
      return;
    }
    onClose();
  };

  const q = query.trim().toLowerCase();
  const matchedReferenced = useMemo(
    () =>
      q
        ? referenced.filter((c) => mentionChipLabel(c).toLowerCase().includes(q))
        : referenced,
    [q, referenced],
  );
  const matchedMaterials = useMemo(
    () => (q ? materials.filter((m) => m.label.toLowerCase().includes(q)) : materials),
    [q, materials],
  );
  const groups = useMemo(
    () =>
      KIND_ORDER.map((kind) => ({
        kind,
        items: matchedMaterials.filter((m) => m.kind === kind),
      })).filter((group) => group.items.length > 0),
    [matchedMaterials],
  );

  // 搜索时不再分组：这时用户是在按名字找一个具体的东西，多一层展开只是挡路。
  const flattenMaterials = q.length > 0;

  // chip 常常就在贴着视口下沿的操作面板里：只往下开的话整个选单落到屏幕外，用户
  // 看到的是「点了替换没反应」。空间不够就翻到 chip 上方，仍然不够就收缩内部滚动。
  const { top, left, maxHeight } = placeAnchoredMenu({
    anchorRect,
    width: POPOVER_WIDTH,
    preferredHeight: SEARCH_ROW_HEIGHT + LIST_MAX_HEIGHT,
    gap: ANCHOR_GAP,
    edgeGap: EDGE_GAP,
  });
  const listMaxHeight = Math.max(72, maxHeight - SEARCH_ROW_HEIGHT);

  const openGroupItems =
    openGroup === null
      ? []
      : (groups.find((group) => group.kind === openGroup.kind)?.items ?? []);

  return (
    <>
      <div
        className="canvas-node-transient-ui fixed z-[10000] flex flex-col rounded-lg border border-white/10 bg-surface-dark/95 p-1 shadow-xl backdrop-blur-sm"
        style={{ top, left, width: POPOVER_WIDTH, maxHeight }}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-1.5 rounded-md bg-white/[0.06] px-2 py-1.5">
          <Search className="h-3 w-3 shrink-0 text-text-muted/70" aria-hidden />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpenGroup(null);
            }}
            // 编辑器把方向键 / Enter 用于候选导航，别让这里的输入冒泡上去。
            // Escape 例外：焦点在这颗输入框上，不在这儿处理就没人处理了。
            onKeyDown={handleKeyDown}
            placeholder="搜索"
            className="min-w-0 flex-1 bg-transparent text-xs text-text-dark outline-none placeholder:text-text-muted/60"
          />
        </div>

        <div
          className="ui-scrollbar mt-1 min-h-0 overflow-y-auto"
          style={{ maxHeight: listMaxHeight }}
          onScroll={() => setOpenGroup(null)}
        >
          {matchedReferenced.length > 0 && (
            <>
              <SectionLabel>已引用</SectionLabel>
              {matchedReferenced.map((candidate) => (
                <button
                  key={candidate.key}
                  type="button"
                  onMouseEnter={() => setOpenGroup(null)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onPickReferenced(candidate);
                  }}
                  className={ROW_CLASS}
                >
                  <RowThumb
                    imageUrl={candidate.imageUrl || undefined}
                    videoUrl={candidate.videoUrl}
                  />
                  <span className="flex-1 truncate">{mentionChipLabel(candidate)}</span>
                  <span className="text-[10px] text-text-muted/70">@{candidate.index}</span>
                </button>
              ))}
            </>
          )}

          {groups.length > 0 && (
            <>
              <SectionLabel>素材引用</SectionLabel>
              {flattenMaterials
                ? matchedMaterials.map((material) => (
                    <button
                      key={material.nodeId}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onPickMaterial(material);
                      }}
                      className={ROW_CLASS}
                    >
                      <RowThumb
                        imageUrl={material.imageUrl}
                        videoUrl={material.videoUrl}
                        kind={material.kind}
                      />
                      <span className="flex-1 truncate">{material.label}</span>
                    </button>
                  ))
                : groups.map((group) => (
                    <button
                      key={group.kind}
                      type="button"
                      // 行内文字只有「图片」，和已引用段里同名的引用标签分不开；
                      // 给个明确的可读名，读屏和测试都能指到这一行。
                      aria-label={`${KIND_LABEL[group.kind]}素材`}
                      onMouseEnter={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setOpenGroup({
                          kind: group.kind,
                          top: rect.top - 4,
                          left: rect.right + 4,
                        });
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      className={`${ROW_CLASS} ${
                        openGroup?.kind === group.kind
                          ? 'bg-white/[0.08] text-text-dark'
                          : ''
                      }`}
                    >
                      <RowThumb
                        imageUrl={group.items[0]?.imageUrl}
                        videoUrl={group.items[0]?.videoUrl}
                        kind={group.kind}
                      />
                      <span className="flex-1 truncate">{KIND_LABEL[group.kind]}</span>
                      <span className="text-[10px] text-text-muted/70">
                        {group.items.length}
                      </span>
                      <ChevronRight className="h-3 w-3 shrink-0 text-text-muted/70" />
                    </button>
                  ))}
            </>
          )}

          {matchedReferenced.length === 0 && groups.length === 0 && (
            <div className="px-2 py-3 text-center text-[11px] text-text-muted/70">
              没有可替换的素材
            </div>
          )}
        </div>
      </div>

      {openGroup && openGroupItems.length > 0 && (
        <div
          className="canvas-node-transient-ui ui-scrollbar fixed z-[10001] overflow-y-auto rounded-lg border border-white/10 bg-surface-dark/95 p-1 shadow-xl backdrop-blur-sm"
          style={{
            top: Math.max(
              EDGE_GAP,
              Math.min(openGroup.top, window.innerHeight - SUBMENU_MAX_HEIGHT - EDGE_GAP),
            ),
            left: Math.max(
              EDGE_GAP,
              Math.min(openGroup.left, window.innerWidth - SUBMENU_WIDTH - EDGE_GAP),
            ),
            width: SUBMENU_WIDTH,
            maxHeight: SUBMENU_MAX_HEIGHT,
          }}
        >
          {openGroupItems.map((material) => (
            <button
              key={material.nodeId}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onPickMaterial(material);
              }}
              className={ROW_CLASS}
            >
              <RowThumb
                imageUrl={material.imageUrl}
                videoUrl={material.videoUrl}
                kind={material.kind}
              />
              <span className="flex-1 truncate">{material.label}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
