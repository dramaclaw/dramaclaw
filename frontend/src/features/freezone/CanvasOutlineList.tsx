// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AudioLines,
  Box,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Copy,
  Download,
  FileText,
  Film,
  Folder,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  LayoutGrid,
  ListCollapse,
  ListFilter,
  ListTree,
  MoreHorizontal,
  Navigation,
  Palette,
  Pencil,
  Play,
  ScrollText,
  Search,
  Sparkles,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";

import {
  CANVAS_NODE_TYPES,
  isGroupNode,
  resolveNodeSourceImageUrl,
  type CanvasNode,
  type CanvasNodeType,
} from "@/features/canvas/domain/canvasNodes";
import { resolveNodePrimaryAsset } from "@/features/canvas/domain/canvasAssets";
import {
  localizeDefaultNodeDisplayName,
  localizeNodeDisplayName,
  resolveNodeDisplayName,
} from "@/features/canvas/domain/nodeDisplay";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { downloadUrlAsFile } from "@/lib/browserDownload";
import { useCanvasStore } from "@/stores/canvasStore";

export type CanvasOutlineItem = {
  id: string;
  kind: "node" | "group";
  /** 组用组名，普通节点用节点显示名。 */
  name: string;
  type: CanvasNodeType;
  thumbUrl: string | null;
  /** 下载用的原始资源地址；没有可下载内容时为 null。 */
  mediaUrl: string | null;
  /** 名字之外的一行副信息（类型 · 生成时间）；没什么可说的时候是 null。 */
  meta: string | null;
  children: CanvasOutlineItem[];
};

const NODE_TYPE_ICON: Record<CanvasNodeType, LucideIcon> = {
  [CANVAS_NODE_TYPES.upload]: Upload,
  [CANVAS_NODE_TYPES.imageEdit]: ImageIcon,
  [CANVAS_NODE_TYPES.imageGen]: ImageIcon,
  [CANVAS_NODE_TYPES.exportImage]: ImageIcon,
  [CANVAS_NODE_TYPES.beatContext]: Clapperboard,
  [CANVAS_NODE_TYPES.textAnnotation]: FileText,
  [CANVAS_NODE_TYPES.group]: Folder,
  [CANVAS_NODE_TYPES.storyboardSplit]: LayoutGrid,
  [CANVAS_NODE_TYPES.storyboardGen]: LayoutGrid,
  [CANVAS_NODE_TYPES.video]: Play,
  [CANVAS_NODE_TYPES.audio]: AudioLines,
  [CANVAS_NODE_TYPES.videoStory]: Film,
  [CANVAS_NODE_TYPES.videoCompose]: Film,
  [CANVAS_NODE_TYPES.script]: ScrollText,
  [CANVAS_NODE_TYPES.pano360Viewer]: Globe,
  [CANVAS_NODE_TYPES.threeDWorld]: Box,
  [CANVAS_NODE_TYPES.previz]: Clapperboard,
  [CANVAS_NODE_TYPES.skill]: Sparkles,
  [CANVAS_NODE_TYPES.style]: Palette,
};

/** 缩略图取节点自己的画面；视频/音频这类没有静帧的走图标兜底。 */
function outlineThumbUrl(node: CanvasNode): string | null {
  const imageUrl = resolveNodeSourceImageUrl(node);
  if (imageUrl) {
    return imageUrl;
  }
  const preview = (node.data as { previewImageUrl?: unknown }).previewImageUrl;
  if (typeof preview === "string" && preview) {
    return preview;
  }
  // 全景查看器这类不是「图片节点」但原件就是一张图的，直接拿它的原件当缩略图。
  const asset = resolveNodePrimaryAsset(node);
  return asset?.kind === "image" ? asset.url : null;
}

/**
 * 下载拿的是原件，走全局那张「节点 → 原始资产」映射（`resolveNodePrimaryAsset`），
 * 不在这里自己认字段：视频合成的成片在 `resultVideoUrl`、视频故事的源片在
 * `sourceVideoUrl`、3D 世界的包在 `plyUrl`，而它们身上都同时挂着封面图，自己认一遍
 * 就会把海报当成片下载给用户。没有原件的节点（文本、脚本等）回落到画面本身。
 */
function outlineMediaUrl(node: CanvasNode): string | null {
  return resolveNodePrimaryAsset(node)?.url ?? outlineThumbUrl(node);
}

/**
 * 副信息只补名字没说的那部分：
 * 名字被用户改过（或本来就是提示词）时补类型，名字本身就是默认类型名时不重复一遍；
 * 再补一个创建时刻，用来区分「同一条提示词生成三次」这种连名字带类型都一样的行。
 *
 * 时刻读的是 `createdAt` 而**不是** `generationStartedAt`：后者是临时字段，每条生成
 * 链路在成功和失败时都会把它写回 null（见 VideoNode / ImageGenNode / 各 Overlay），
 * 只在转圈那几十秒里看得见，跑完就蒸发——恰恰在事后回头找「谁是谁」的那一刻什么
 * 都不剩。`createdAt` 由 nodeFactory 在建节点时落一次，之后没人改。
 *
 * 用绝对时刻而不是「3 分钟前」：相对时间要么算 Date.now() 污染纯函数，要么显示的是
 * 上次渲染那一刻的旧值。加字段之前存的老画布没有 createdAt，那些行退回只显示类型。
 */
function outlineMeta(
  node: CanvasNode,
  type: CanvasNodeType,
  name: string,
  t: TFunction,
): string | null {
  const parts: string[] = [];
  const typeLabel = localizeDefaultNodeDisplayName(type, node.data, t);
  if (typeLabel && typeLabel !== name) {
    parts.push(typeLabel);
  }
  const createdAt = (node.data as { createdAt?: unknown }).createdAt;
  if (typeof createdAt === "number" && Number.isFinite(createdAt) && createdAt > 0) {
    parts.push(formatOutlineStamp(createdAt));
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatOutlineStamp(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toOutlineItem(node: CanvasNode, t: TFunction): CanvasOutlineItem {
  const type = node.type as CanvasNodeType;
  const group = isGroupNode(node);
  const name = localizeNodeDisplayName(type, node.data, t);
  return {
    id: node.id,
    kind: group ? "group" : "node",
    name,
    type,
    thumbUrl: group ? null : outlineThumbUrl(node),
    mediaUrl: group ? null : outlineMediaUrl(node),
    meta: group ? null : outlineMeta(node, type, name, t),
    children: [],
  };
}

/**
 * 把画布节点压成一棵大纲树：组变成文件夹（名字就是组名），组内成员挂在它下面，
 * 其余节点平铺在顶层。父节点找不到（或父节点不是组）的一律回到顶层，不丢节点。
 */
export function buildCanvasOutline(nodes: CanvasNode[], t: TFunction): CanvasOutlineItem[] {
  const items = new Map<string, CanvasOutlineItem>();
  for (const node of nodes) {
    items.set(node.id, toOutlineItem(node, t));
  }

  const roots: CanvasOutlineItem[] = [];
  for (const node of nodes) {
    const item = items.get(node.id);
    if (!item) continue;
    const parent = node.parentId ? items.get(node.parentId) : undefined;
    if (parent && parent !== item && parent.kind === "group") {
      parent.children.push(item);
    } else {
      roots.push(item);
    }
  }
  return roots;
}

/** 组里可能还套着组，计数要把深层成员也算进去。 */
export function countOutlineNodes(items: CanvasOutlineItem[]): number {
  return items.reduce(
    (total, item) => total + (item.kind === "node" ? 1 : 0) + countOutlineNodes(item.children),
    0,
  );
}

/**
 * 前序展开成 id 列表：父一定排在自己的成员前面。
 * duplicateNodesAsSiblings 靠这个顺序把成员的 parentId 重指到新克隆的组上。
 */
export function collectOutlineIds(item: CanvasOutlineItem): string[] {
  return [item.id, ...item.children.flatMap(collectOutlineIds)];
}

/** 下载一个组＝下载它所有层级里带资源的成员。 */
export function collectOutlineDownloads(item: CanvasOutlineItem): CanvasOutlineItem[] {
  const self = item.kind === "node" && item.mediaUrl ? [item] : [];
  return [...self, ...item.children.flatMap(collectOutlineDownloads)];
}

export type CanvasOutlineRowEntry = { item: CanvasOutlineItem; depth: number };

/**
 * 按当前折叠状态把树压成「屏幕上从上到下的行」。
 * 虚拟化只能按下标取行，递归渲染的结构在这里走不通。
 */
export function flattenCanvasOutline(
  items: CanvasOutlineItem[],
  collapsedGroupIds: ReadonlySet<string>,
  depth = 0,
  out: CanvasOutlineRowEntry[] = [],
): CanvasOutlineRowEntry[] {
  for (const item of items) {
    out.push({ item, depth });
    if (item.kind === "group" && !collapsedGroupIds.has(item.id)) {
      flattenCanvasOutline(item.children, collapsedGroupIds, depth + 1, out);
    }
  }
  return out;
}

/** 展开/收起全部要知道树里有哪些组，含嵌套组。 */
export function collectOutlineGroupIds(items: CanvasOutlineItem[]): string[] {
  return items.flatMap((item) =>
    item.kind === "group" ? [item.id, ...collectOutlineGroupIds(item.children)] : [],
  );
}

export type CanvasOutlineFilterKey =
  | "all"
  | "text"
  | "image"
  | "video"
  | "storyboard"
  | "beat"
  | "audio"
  | "script"
  | "world"
  | "skill";

/**
 * 类型筛选按「用户眼里的东西」分档，不是逐个节点类型列出来——
 * 图片生成/编辑/导出在列表里长得一样，拆开只会让菜单变成一面墙。
 * 组不在这里：文件夹是容器，筛类型时只看它装了什么。
 */
export const CANVAS_OUTLINE_FILTERS: ReadonlyArray<{
  key: CanvasOutlineFilterKey;
  types: readonly CanvasNodeType[];
}> = [
  { key: "all", types: [] },
  { key: "text", types: [CANVAS_NODE_TYPES.textAnnotation] },
  {
    key: "image",
    types: [
      CANVAS_NODE_TYPES.upload,
      CANVAS_NODE_TYPES.imageEdit,
      CANVAS_NODE_TYPES.imageGen,
      CANVAS_NODE_TYPES.exportImage,
      // 风格节点不独立存在，它是图片节点所选风格的投影，跟着图片一起筛。
      CANVAS_NODE_TYPES.style,
    ],
  },
  {
    key: "video",
    types: [
      CANVAS_NODE_TYPES.video,
      CANVAS_NODE_TYPES.videoStory,
      CANVAS_NODE_TYPES.videoCompose,
    ],
  },
  {
    key: "storyboard",
    types: [CANVAS_NODE_TYPES.storyboardSplit, CANVAS_NODE_TYPES.storyboardGen],
  },
  { key: "beat", types: [CANVAS_NODE_TYPES.beatContext] },
  { key: "audio", types: [CANVAS_NODE_TYPES.audio] },
  { key: "script", types: [CANVAS_NODE_TYPES.script] },
  {
    key: "world",
    types: [
      CANVAS_NODE_TYPES.pano360Viewer,
      CANVAS_NODE_TYPES.threeDWorld,
      CANVAS_NODE_TYPES.previz,
    ],
  },
  { key: "skill", types: [CANVAS_NODE_TYPES.skill] },
];

export function outlineFilterTypes(key: CanvasOutlineFilterKey): readonly CanvasNodeType[] {
  return CANVAS_OUTLINE_FILTERS.find((filter) => filter.key === key)?.types ?? [];
}

/**
 * 模糊匹配：先看是不是子串，不是就退化成「按顺序出现即可」的子序列匹配，
 * 这样 "img107" 也能命中 "Image 107 - 副本"。空关键词一律算命中。
 *
 * 子序列还额外要求命中位置挤在一起：不然拿整段提示词当名字的节点里，
 * 随便两个字都能在几百字里前后凑出来，一搜就全中，等于没筛。
 */
export function matchesOutlineQuery(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  const haystack = name.toLowerCase();
  if (haystack.includes(needle)) {
    return true;
  }
  const chars = [...needle].filter((char) => char !== " ");
  let cursor = 0;
  let first = -1;
  for (const char of chars) {
    const index = haystack.indexOf(char, cursor);
    if (index < 0) {
      return false;
    }
    if (first < 0) {
      first = index;
    }
    cursor = index + 1;
  }
  return cursor - first <= chars.length * 4 + 8;
}

/**
 * 按类型 + 关键词过滤大纲。组只要还剩成员就保留（只留下命中的成员）；
 * 没成员命中但组名自己命中时整组保留，这样搜文件夹名能一次看到里面全部东西。
 */
export function filterCanvasOutline(
  items: CanvasOutlineItem[],
  options: { query: string; types: readonly CanvasNodeType[] },
): CanvasOutlineItem[] {
  const queryOff = options.query.trim() === "";
  const typesOff = options.types.length === 0;
  if (queryOff && typesOff) {
    return items;
  }
  const allowed = new Set(options.types);

  const walk = (list: CanvasOutlineItem[]): CanvasOutlineItem[] =>
    list.flatMap((item) => {
      if (item.kind === "node") {
        const typeHit = typesOff || allowed.has(item.type);
        return typeHit && matchesOutlineQuery(item.name, options.query) ? [item] : [];
      }
      const children = walk(item.children);
      if (children.length > 0) {
        return [{ ...item, children }];
      }
      return typesOff && !queryOff && matchesOutlineQuery(item.name, options.query) ? [item] : [];
    });

  return walk(items);
}

/**
 * 大纲只关心「有哪些节点、叫什么、挂在谁下面、缩略图是什么」，不关心坐标。
 * 拖动画布时 nodes 每帧换新引用，直接订阅 nodes 会让这张几百行的表跟着每帧重渲；
 * 订阅这个签名后，只有真正影响列表的字段变了才会重渲。
 */
export function canvasOutlineSignature(nodes: CanvasNode[]): string {
  return nodes
    .map((node) => {
      const type = node.type as CanvasNodeType;
      return [
        node.id,
        type,
        node.parentId ?? "",
        resolveNodeDisplayName(type, node.data),
        (isGroupNode(node) ? null : outlineThumbUrl(node)) ?? "",
        (isGroupNode(node) ? null : outlineMediaUrl(node)) ?? "",
        // 签名只用来判「画布变了没」，不进界面，所以取语言无关的原始值 ——
        // 换语言不该让签名变，那是 useMemo 的 t 依赖去管的事。
        String((node.data as { createdAt?: unknown }).createdAt ?? ""),
      ].join("\u0001");
    })
    .join("\u0002");
}

const FILE_EXTENSION_PATTERN = /\.([a-z0-9]{2,5})$/i;

/** 下载文件名：先用上传时的原名，其次「显示名 + 从 URL 猜到的后缀」。 */
function outlineDownloadFilename(item: CanvasOutlineItem, url: string): string {
  const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === item.id);
  const sourceFileName = (node?.data as { sourceFileName?: unknown } | undefined)?.sourceFileName;
  if (typeof sourceFileName === "string" && sourceFileName.trim()) {
    return sourceFileName.trim();
  }
  const path = url.split(/[?#]/, 1)[0] ?? "";
  const extension = FILE_EXTENSION_PATTERN.exec(path)?.[1]?.toLowerCase() ?? "png";
  return `${item.name}.${extension}`;
}

export function CanvasOutlineList({
  collapsed = false,
  leading,
}: {
  collapsed?: boolean;
  /** 塞在工具栏最左边的东西（画布选择器）。给了就顶掉「画布元素」那个标签。 */
  leading?: ReactNode;
} = {}) {
  const { t } = useTranslation();
  // 抽屉收起是纯 CSS 位移，组件不卸载 —— 不短路的话，用户收起抽屉拖画布时，这条
  // 签名照样每帧把几百个节点(含可能几百字符的提示词名)拼成大字符串然后丢掉。
  // 返回常量 "" 时 zustand 判等不重渲；展开那一拍再重新算一次即可。
  const signature = useCanvasStore((state) =>
    collapsed ? "" : canvasOutlineSignature(state.nodes),
  );
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<ReadonlySet<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [filterKey, setFilterKey] = useState<CanvasOutlineFilterKey>("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  const outline = useMemo(
    // signature 变了才重建；节点从 store 现取，免得把 nodes 也订阅进来。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => buildCanvasOutline(useCanvasStore.getState().nodes, t),
    [signature, t],
  );

  const filtering = filterKey !== "all" || query.trim() !== "";
  const visible = useMemo(
    () => filterCanvasOutline(outline, { query, types: outlineFilterTypes(filterKey) }),
    [outline, query, filterKey],
  );
  const total = useMemo(() => countOutlineNodes(visible), [visible]);

  // 筛选/搜索时无视折叠状态，否则命中的东西可能藏在收起的组里。
  const effectiveCollapsed = filtering ? NO_COLLAPSED_GROUPS : collapsedGroupIds;
  const rows = useMemo(
    () => flattenCanvasOutline(visible, effectiveCollapsed),
    [visible, effectiveCollapsed],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  // 小画布照常整棵渲染：jsdom 里滚动容器高度恒为 0，虚拟化会一行都不渲染，
  // 门槛之下走原路才不会把渲染测试和「打开就能截到内容」一起废掉。
  const virtualized = rows.length > OUTLINE_VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: virtualized ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => OUTLINE_ROW_STRIDE_PX,
    overscan: 8,
  });

  const groupIds = useMemo(() => collectOutlineGroupIds(outline), [outline]);
  const allCollapsed =
    groupIds.length > 0 && groupIds.every((groupId) => collapsedGroupIds.has(groupId));

  const toggleAllGroups = useCallback(() => {
    setCollapsedGroupIds((previous) => {
      const everyCollapsed = groupIds.length > 0 && groupIds.every((id) => previous.has(id));
      return everyCollapsed ? new Set<string>() : new Set(groupIds);
    });
  }, [groupIds]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroupIds((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  // 选中走 ReactFlow 的 select change：canvasStore 会把它同步成 selectedNodeId，
  // 直接改 selectedNodeId 会被 Canvas 的反向同步覆盖掉。
  const focusNode = useCallback((nodeId: string) => {
    const store = useCanvasStore.getState();
    store.onNodesChange(
      store.nodes.map((node) => ({
        type: "select" as const,
        id: node.id,
        selected: node.id === nodeId,
      })),
    );
    store.requestFocusNode(nodeId);
  }, []);

  // 复制组时要连成员一起给，而且父必须排在成员前面（collectOutlineIds 是前序）。
  const duplicateItem = useCallback((item: CanvasOutlineItem) => {
    useCanvasStore.getState().duplicateNodesAsSiblings(collectOutlineIds(item));
  }, []);

  const commitRename = useCallback((item: CanvasOutlineItem, rawName: string) => {
    setRenamingId(null);
    const name = rawName.trim();
    if (!name || name === item.name) {
      return;
    }
    // 组框的名字历史上写在 label 上，两处都写才不会改完又被旧字段盖回去。
    useCanvasStore
      .getState()
      .updateNodeData(item.id, item.kind === "group" ? { displayName: name, label: name } : { displayName: name });
  }, []);

  // 组下载没有打包接口，就按成员顺序一个个存；某个失败不影响后面的。
  const downloadItem = useCallback(async (item: CanvasOutlineItem) => {
    const targets = collectOutlineDownloads(item);
    for (const target of targets) {
      if (!target.mediaUrl) continue;
      try {
        await downloadUrlAsFile(target.mediaUrl, outlineDownloadFilename(target, target.mediaUrl));
      } catch (error) {
        console.error("Failed to download canvas node", target.id, error);
      }
    }
  }, []);

  // 两条渲染路径（整棵 / 开窗）共用同一组回调，别在两处各写一遍。
  const rowProps = {
    collapsedGroupIds: effectiveCollapsed,
    selectedNodeId,
    renamingId,
    onToggleGroup: toggleGroup,
    onFocusNode: focusNode,
    onDuplicate: duplicateItem,
    onStartRename: setRenamingId,
    onCommitRename: commitRename,
    onDownload: downloadItem,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 pb-1.5 pl-2 pr-3 pt-2.5">
        {searchOpen ? (
          <OutlineSearchInput value={query} onChange={setQuery} onClose={closeSearch} />
        ) : (
          <>
            {/* 有画布选择器时它就是这行的身份，再挂一个「画布元素」是同义反复 */}
            {leading ?? (
              <span className="shrink-0 text-[10px] font-semibold tracking-[0.09em] text-text-muted/85">
                {t("freezone.canvasOutline.title")}
              </span>
            )}
            {groupIds.length > 0 && (
              <OutlineIconButton
                label={t(
                  allCollapsed
                    ? "freezone.canvasOutline.expandAll"
                    : "freezone.canvasOutline.collapseAll",
                )}
                onClick={toggleAllGroups}
              >
                {/* 收起态露出树枝（点了会展开），展开态露出收拢的箭头 */}
                {allCollapsed ? (
                  <ListTree className="h-3.5 w-3.5" />
                ) : (
                  <ListCollapse className="h-3.5 w-3.5" />
                )}
              </OutlineIconButton>
            )}
            <span className="flex-1" />
            {filtering && (
              <span className="shrink-0 text-[11px] tabular-nums text-text-muted/70">
                {t("freezone.canvasOutline.matched", { count: total })}
              </span>
            )}
          </>
        )}
        <OutlineTypeFilter compact={searchOpen} value={filterKey} onChange={setFilterKey} />
        {searchOpen ? (
          <OutlineIconButton
            label={t("freezone.canvasOutline.closeSearch")}
            onClick={closeSearch}
          >
            <X className="h-3.5 w-3.5" />
          </OutlineIconButton>
        ) : (
          <OutlineIconButton
            label={t("freezone.canvasOutline.search")}
            onClick={() => setSearchOpen(true)}
          >
            <Search className="h-3.5 w-3.5" />
          </OutlineIconButton>
        )}
      </div>
      {/* 横向留白挪到行上（见 ROW_INSET_PX），行才能铺满容器宽度——
          hover 的底色是画在行上的，容器留白会把它从左边削掉一块。 */}
      <div
        ref={scrollRef}
        className="ui-scrollbar-vertical min-h-0 flex-1 overflow-y-auto pb-2 pl-1 pr-2"
      >
        {outline.length === 0 ? (
          <div className="px-1 py-6 text-center text-xs text-text-muted/70">
            {t("freezone.canvasOutline.empty")}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-1 py-6 text-center text-xs text-text-muted/70">
            {t("freezone.canvasOutline.noMatch")}
          </div>
        ) : virtualized ? (
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const entry = rows[virtualRow.index];
              return (
                <div
                  key={entry.item.id}
                  className="absolute inset-x-0 top-0"
                  style={{ height: OUTLINE_ROW_STRIDE_PX, transform: `translateY(${virtualRow.start}px)` }}
                >
                  <CanvasOutlineRow {...rowProps} item={entry.item} depth={entry.depth} />
                </div>
              );
            })}
          </div>
        ) : (
          rows.map((entry) => (
            <CanvasOutlineRow
              {...rowProps}
              key={entry.item.id}
              item={entry.item}
              depth={entry.depth}
            />
          ))
        )}
      </div>
    </div>
  );
}

const NO_COLLAPSED_GROUPS: ReadonlySet<string> = new Set();

/**
 * 行高写死，虚拟化才能不量高度直接按下标定位。
 * stride 比行高多 1px，那 1px 就是行与行之间的缝——hover 底色不会和上下黏成一片。
 */
/** 对应行上的 `h-11`（44px）+ `mb-px`（1px）。改一处就要同步另一处。 */
const OUTLINE_ROW_STRIDE_PX = 45;
/** 这个数量以下整棵渲染：开窗的收益抵不过它在 jsdom / 首帧上的那点别扭。 */
const OUTLINE_VIRTUALIZE_THRESHOLD = 60;

const HEADER_ICON_BUTTON_CLASS =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted transition hover:bg-[rgb(var(--text-rgb)/0.1)] hover:text-text-dark";

const TOOLTIP_CONTENT_CLASS =
  "z-[130] rounded-md border border-[var(--ui-border-soft)] bg-surface-dark px-2 py-1 text-[11px] text-text-dark shadow-lg";

/** 工具条上的图标按钮：hover 弹自绘 tooltip，不用浏览器那个慢半拍的原生 title。 */
function OutlineIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <TooltipProvider delay={120}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              onClick={onClick}
              className={HEADER_ICON_BUTTON_CLASS}
            />
          }
        >
          {children}
        </TooltipTrigger>
        <TooltipContent side="bottom" showArrow={false} className={TOOLTIP_CONTENT_CLASS}>
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const FILTER_MENU_CONTENT_CLASS =
  "z-[120] min-w-[132px] border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.95)] text-text-dark shadow-none backdrop-blur-3xl";

/** 类型筛选：搜索框展开时收成一个图标，让位给输入框。 */
function OutlineTypeFilter({
  compact,
  value,
  onChange,
}: {
  compact: boolean;
  value: CanvasOutlineFilterKey;
  onChange: (key: CanvasOutlineFilterKey) => void;
}) {
  const { t } = useTranslation();
  const active = value !== "all";
  const label = t(`freezone.canvasOutline.types.${value}`);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t("freezone.canvasOutline.filter")}
            title={compact ? `${t("freezone.canvasOutline.filter")}：${label}` : undefined}
            className={
              "inline-flex h-6 shrink-0 items-center gap-1 px-1 text-[11px] transition-colors hover:text-text-dark " +
              (active
                ? "text-primary"
                : "text-text-muted")
            }
          />
        }
      >
        {compact ? (
          <ListFilter className="h-3.5 w-3.5" />
        ) : (
          <>
            <span className="max-w-[72px] truncate">{label}</span>
            <ChevronDown className="h-3 w-3 opacity-60" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent className={FILTER_MENU_CONTENT_CLASS} align="end">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as CanvasOutlineFilterKey)}
        >
          {CANVAS_OUTLINE_FILTERS.map((filter) => (
            <DropdownMenuRadioItem
              key={filter.key}
              value={filter.key}
              // base-ui 的单选项默认不关菜单，这里选完就该收起来
              closeOnClick
              className="rounded-[var(--ui-radius-lg)] text-xs text-text-dark focus:bg-[rgb(var(--text-rgb)/0.075)] focus:text-text-dark"
            >
              {t(`freezone.canvasOutline.types.${filter.key}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OutlineSearchInput({
  value,
  onChange,
  onClose,
}: {
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="relative flex min-w-0 flex-1 items-center">
      <input
        value={value}
        autoFocus
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // 画布层监听全局按键，搜索框里的输入不能漏过去。
          event.stopPropagation();
          if (event.key === "Escape") onClose();
        }}
        placeholder={t("freezone.canvasOutline.search")}
        className="h-6 w-full rounded-md border border-[var(--ui-border-soft)] bg-[rgb(var(--text-rgb)/0.04)] pl-2 pr-6 text-[11px] text-text-dark outline-none transition placeholder:text-text-muted/70 focus:border-[var(--ui-border-strong)]"
      />
      <Search className="pointer-events-none absolute right-2 h-3 w-3 text-text-muted/70" />
    </div>
  );
}

const MENU_CONTENT_CLASS =
  "z-[120] min-w-[140px] border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.95)] text-text-dark shadow-none backdrop-blur-3xl";
const MENU_ITEM_CLASS =
  "gap-2 rounded-[var(--ui-radius-lg)] text-xs text-text-dark focus:bg-[rgb(var(--text-rgb)/0.075)] focus:text-text-dark";

type OutlineRowProps = {
  item: CanvasOutlineItem;
  depth: number;
  collapsedGroupIds: ReadonlySet<string>;
  selectedNodeId: string | null;
  renamingId: string | null;
  onToggleGroup: (groupId: string) => void;
  onFocusNode: (nodeId: string) => void;
  onDuplicate: (item: CanvasOutlineItem) => void;
  onStartRename: (itemId: string | null) => void;
  onCommitRename: (item: CanvasOutlineItem, name: string) => void;
  onDownload: (item: CanvasOutlineItem) => void;
};

/** 行内左侧留白：缩略图照旧离面板 8px，hover 底色能多往左铺 4px 包住它。 */
const ROW_INSET_PX = 4;

const THUMB_CLASS =
  // ring 而不是 border：border 会把 36px 撑成 38px，和空缩略图的图标框对不齐。
  "relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-[rgb(var(--text-rgb)/0.05)] ring-1 ring-inset ring-[rgb(var(--text-rgb)/0.09)]";

/** 缩略图本身就是内容的类型，再叠一个「图片」角标纯属噪音。 */
const PLAIN_IMAGE_TYPES: ReadonlySet<CanvasNodeType> = new Set([
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.exportImage,
]);



const CanvasOutlineRow = memo(function CanvasOutlineRow(props: OutlineRowProps) {
  const {
    item,
    depth,
    collapsedGroupIds,
    selectedNodeId,
    renamingId,
    onToggleGroup,
    onFocusNode,
  } = props;
  const { t } = useTranslation();
  const indent = { paddingLeft: `${ROW_INSET_PX + depth * 14}px` };
  const selected = selectedNodeId === item.id;
  const renaming = renamingId === item.id;
  const collapsed = collapsedGroupIds.has(item.id);

  const rowClass =
    // h-11 / mb-px 必须和 OUTLINE_ROW_STRIDE_PX 对上：虚拟化不量高度，直接按 stride 定位。
    // 这里不能写 `h-[${...}px]` 之类的模板串——Tailwind 扫的是源码里的字面量，
    // 运行时拼出来的类名不会进产物（和 mask-image 那次同一个坑）。
    "ui-outline-row group/row relative mb-px flex h-11 w-full items-center gap-2 rounded-[8px] pr-1.5 transition-colors duration-150 " +
    // 选中使用产品主色的低透明度层，hover 保持中性，不用额外竖线重复表达状态。
    (selected
      ? "bg-primary/[0.14] ring-1 ring-inset ring-primary/20"
      : "hover:bg-[rgb(var(--text-rgb)/0.05)]");
  const leadClass = "flex h-full min-w-0 flex-1 items-center gap-2 text-left";

  const lead =
    item.kind === "group" ? (
      <>
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted/70" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted/70" />
        )}
        <span className={THUMB_CLASS}>
          {collapsed ? (
            <Folder className="h-3.5 w-3.5 text-text-muted" />
          ) : (
            <FolderOpen className="h-3.5 w-3.5 text-text-muted" />
          )}
        </span>
      </>
    ) : (
      <>
        <span className={THUMB_CLASS}>
          {item.thumbUrl ? (
            <img src={item.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <OutlineNodeIcon type={item.type} />
          )}
          {/* 有画面的节点光看缩略图分不出是视频还是 3D——而兜底图标只在没画面时才露脸，
              恰好是最不需要提示的那一档。 */}
          {item.thumbUrl && !PLAIN_IMAGE_TYPES.has(item.type) ? (
            <OutlineTypeBadge type={item.type} />
          ) : null}
        </span>
      </>
    );

  const body = renaming ? (
    // 改名时整行不能再是 <button>，输入框不允许嵌在按钮里。
    <div className={leadClass}>
      {lead}
      <OutlineRenameInput
        item={item}
        onCommit={props.onCommitRename}
        onCancel={props.onStartRename}
      />
    </div>
  ) : (
    <button
      type="button"
      title={item.name}
      aria-expanded={item.kind === "group" ? !collapsed : undefined}
      onClick={() => (item.kind === "group" ? onToggleGroup(item.id) : onFocusNode(item.id))}
      className={leadClass}
    >
      {lead}
      <span className="ui-outline-row-name flex min-w-0 flex-1 flex-col justify-center gap-px">
        <span
          className={
            "truncate text-xs leading-4 transition-colors" +
            (item.kind === "group" ? " pr-7 font-medium" : "") +
            (selected ? " font-medium text-text-dark" : " text-text-dark/85")
          }
        >
          {item.name}
        </span>
        {/* 名字撞车时（同一条提示词生成三次）靠这行分辨谁是谁——见 outlineMeta，
            时刻来自持久的 createdAt，别改回跑完就被清空的 generationStartedAt */}
        {item.meta && (
          <span className="truncate text-xs leading-4 text-text-muted/75">{item.meta}</span>
        )}
      </span>
    </button>
  );

  const row = (
    <div style={indent} className={rowClass}>
      {body}
      {item.kind === "group" && !renaming && (
        <span className="pointer-events-none absolute right-2 text-[10px] tabular-nums text-text-muted/70 transition-opacity group-hover/row:opacity-0">
          {t("freezone.canvasOutline.groupMembers", { count: countOutlineNodes(item.children) })}
        </span>
      )}
      {!renaming && <OutlineRowActions {...props} />}
    </div>
  );

  return row;
});

function OutlineNodeIcon({ type }: { type: CanvasNodeType }) {
  const Icon = NODE_TYPE_ICON[type] ?? ImageIcon;
  return <Icon className="h-3.5 w-3.5 text-text-muted" />;
}

/** 缩略图右下角的类型角标，压在画面上所以要自带一层底。 */
function OutlineTypeBadge({ type }: { type: CanvasNodeType }) {
  const Icon = NODE_TYPE_ICON[type] ?? ImageIcon;
  return (
    <span className="pointer-events-none absolute bottom-0 right-0 flex h-3.5 w-3.5 items-center justify-center rounded-tl-[5px] bg-[rgb(var(--surface-rgb)/0.85)] backdrop-blur-[2px]">
      <Icon className="h-2.5 w-2.5 text-text-dark/75" />
    </span>
  );
}

/** hover 才露出来的那组操作：更多菜单 + 定位，参照 libtv 的行尾布局。 */
function OutlineRowActions({ item, onFocusNode, onDuplicate, onStartRename, onDownload }: OutlineRowProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  // 菜单关闭时 base-ui 会把焦点抢回触发按钮，所以改名要等它关干净了再挂输入框。
  const renameQueuedRef = useRef(false);
  const downloadable = collectOutlineDownloads(item).length > 0;
  const iconButtonClass =
    "inline-flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition hover:bg-[rgb(var(--text-rgb)/0.1)] hover:text-text-dark";

  return (
    <div
      className={
        // 浮在名字上而不是挤开它，配合 NAME_FADE_CLASS 的淡出，hover 时行内一格都不动。
        "absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 transition-opacity duration-150 group-hover/row:opacity-100 " +
        (menuOpen ? "opacity-100" : "pointer-events-none opacity-0 group-hover/row:pointer-events-auto")
      }
    >
      <DropdownMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onOpenChangeComplete={(open) => {
          if (open || !renameQueuedRef.current) return;
          renameQueuedRef.current = false;
          onStartRename(item.id);
        }}
      >
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={t("freezone.canvasOutline.moreActions")}
              title={t("freezone.canvasOutline.moreActions")}
              className={iconButtonClass}
            />
          }
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className={MENU_CONTENT_CLASS} align="end">
          <DropdownMenuItem className={MENU_ITEM_CLASS} onClick={() => onDuplicate(item)}>
            <Copy className="h-3.5 w-3.5" />
            <span>{t("freezone.canvasOutline.duplicate")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className={MENU_ITEM_CLASS}
            onClick={() => {
              renameQueuedRef.current = true;
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
            <span>{t("freezone.canvasOutline.rename")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className={MENU_ITEM_CLASS}
            disabled={!downloadable}
            onClick={() => void onDownload(item)}
          >
            <Download className="h-3.5 w-3.5" />
            <span>{t("freezone.canvasOutline.download")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        onClick={() => onFocusNode(item.id)}
        aria-label={t("freezone.canvasOutline.locate")}
        title={t("freezone.canvasOutline.locate")}
        className={iconButtonClass}
      >
        <Navigation className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function OutlineRenameInput({
  item,
  onCommit,
  onCancel,
}: {
  item: CanvasOutlineItem;
  onCommit: (item: CanvasOutlineItem, name: string) => void;
  onCancel: (itemId: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // 挂载后的第一拍不认失焦：这时候的 blur 只可能是别处在抢焦点，不是用户点走了。
  const readyRef = useRef(false);
  const [value, setValue] = useState(item.name);

  useEffect(() => {
    inputRef.current?.select();
    const timer = window.setTimeout(() => {
      readyRef.current = true;
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <input
      ref={inputRef}
      value={value}
      autoFocus
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        if (!readyRef.current) {
          inputRef.current?.focus();
          return;
        }
        onCommit(item, value);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          onCommit(item, value);
        } else if (event.key === "Escape") {
          onCancel(null);
        }
      }}
      className="min-w-0 flex-1 rounded-md border border-[var(--ui-border-soft)] bg-[rgb(var(--text-rgb)/0.06)] px-1.5 py-0.5 text-xs text-text-dark outline-none focus:border-[var(--ui-border-strong)]"
    />
  );
}
