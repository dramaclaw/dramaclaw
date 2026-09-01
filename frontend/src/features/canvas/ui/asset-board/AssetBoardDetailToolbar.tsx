// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  ChevronRight,
  Download,
  FastForward,
  Film,
  Grid2x2,
  Grid3x3,
  ImageUpscale,
  LayoutDashboard,
  LayoutGrid,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Mountain,
  Package,
  RefreshCw,
  Rewind,
  Scissors,
  Star,
  User,
  Users,
  Wand2,
  type LucideIcon,
} from 'lucide-react';

import type {
  FreezoneVideoUpscaleDenoise,
  FreezoneVideoUpscaleResolution,
} from '@/api/ops';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/shadcn/dropdown-menu';
import { spawnAssetBoardImageOpNode } from '@/features/canvas/application/assetBoardImageOps';
import { type GridActionKey } from '@/features/canvas/application/gridTemplateAction';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import {
  canRegenerateExportImageNode,
  regenerateExportImageNode,
} from '@/features/canvas/application/regenerateExportNode';
import {
  createVideoUpscaleResultNode,
  submitVideoUpscale,
  VIDEO_UPSCALE_DENOISE_OPTIONS,
  VIDEO_UPSCALE_RESOLUTIONS,
  VIDEO_UPSCALE_RESOLUTION_LABEL,
} from '@/features/canvas/application/videoUpscale';
import {
  CANVAS_NODE_TYPES,
  isAudioNode,
  isImageEditNode,
  isPendingUpscaleNode,
  isVideoComposeNode,
  isVideoNode,
  resolveNodeSourceImageUrl,
  type CanvasNode,
  type CanvasNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  KEY_ELEMENT_CATEGORY_KEYS,
  KEY_ELEMENT_CATEGORY_LABEL,
  readKeyElementCategory,
} from '@/features/canvas/domain/keyElements';
import { CANVAS_NODE_TOOLBAR_SURFACE_CLASS } from '@/features/canvas/ui/nodeFrameStyles';
import {
  AssetBoardImageOps,
  useAssetBoardImageEditActions,
} from './AssetBoardImageEditMenu';
import {
  DetailToolbarButton,
  DETAIL_TOOLBAR_BUTTON_CLASS,
} from './AssetBoardToolbarButton';
import { VideoComposeModal } from '@/features/canvas/compose/VideoComposeModal';
import type { ComposeTimelineState } from '@/features/canvas/compose/timelineModel';
import { downloadUrlAsFile } from '@/lib/browserDownload';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

// 按钮组件本体在 AssetBoardToolbarButton（打断与 AssetBoardImageEditMenu 的循环
// import）；这里再导出一次，保持既有 import 路径（文本/视频工具条等）不变。
export { DetailToolbarButton };

// 「...」更多菜单的项样式（面板 rounded-lg、项 hover bg-white/5，与本分支体系一致）。
const MORE_MENU_ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-45';

/** 「...」更多菜单里的叶子动作项（图片是高清/裁剪/旋转，视频头部是节点操作）。 */
interface MoreMenuAction {
  kind: 'action';
  key: string;
  icon: LucideIcon;
  label: string;
  /** 进行中：图标换 spinner 并禁用（与工具条按钮同款反馈，如抠图在途）。 */
  busy?: boolean;
  /** 处于「已展开/已激活」态（如历史列表打开时高亮该项）。 */
  active?: boolean;
  onSelect: () => void;
}

/** 「...」更多菜单里的展开型子菜单项（宫格模板：点/悬停展开 9 个模板）。 */
interface MoreMenuSubmenu {
  kind: 'submenu';
  key: string;
  icon: LucideIcon;
  label: string;
  /** 有在途提交时展示的替代文案（如「多机位九宫格」）；非空即显示 spinner。 */
  pendingLabel?: string | null;
  disabled?: boolean;
  /** 子项只有文字 + 右侧灰字：飞出面板窄（140px），再塞图标会把标签挤成两行。 */
  children: Array<{
    key: string;
    label: string;
    /** 右侧灰字（如「当前」）。 */
    hint?: string;
    onSelect: () => void;
  }>;
}

export type MoreMenuEntry = MoreMenuAction | MoreMenuSubmenu;

const MORE_MENU_CLOSE_DELAY_MS = 140;

/** 二级菜单飞出面板的最小宽度与它跟父项之间的缝（算坐标要用，所以是数字不是 class）。 */
const SUBMENU_MIN_WIDTH = 140;
const SUBMENU_GAP = 6;

/** 展开中的二级菜单：哪一项 + 飞出面板的 fixed 坐标。 */
interface SubmenuPlacement {
  key: string;
  top: number;
  left: number;
}

/**
 * 算二级菜单飞出面板的位置：顶边与父项对齐，默认往**右**开（用户指定的方向）。
 *
 * 之所以要算而不是 `absolute left-full`：故事板 overlay 自己是 z-30 的定位层，
 * 里面再高的 z-index 也翻不过右侧 z-45 的对话抽屉——纯 CSS 定位的面板一开到右边
 * 就被抽屉盖住（用户反馈「被挡住了」）。所以面板 portal 到 body、用 fixed 坐标摆，
 * 才能浮在抽屉之上。
 *
 * 右边真的顶到视口边（窄窗口）时翻到左边，宁可换向也不要半截露在屏幕外。
 */
function placeSubmenu(key: string, anchor: HTMLElement): SubmenuPlacement {
  const rect = anchor.getBoundingClientRect();
  const right = rect.right + SUBMENU_GAP;
  const left =
    right + SUBMENU_MIN_WIDTH > window.innerWidth
      ? Math.max(SUBMENU_GAP, rect.left - SUBMENU_GAP - SUBMENU_MIN_WIDTH)
      : right;
  return { key, top: rect.top, left };
}

/**
 * 「设置关键元素」子菜单项：把本节点标记为关键元素并归类（人物/场景/物品/其他）
 * 或取消。标记只写节点 data.keyElementCategory（见 domain/keyElements），故事板
 * 顶部关键元素栏据此常驻。图片工具条的「...」与视频详情头部的「...」共用这一份，
 * 保证两处的文案、当前态标记与取消项完全一致。
 */
export function keyElementMenuEntry(
  node: CanvasNode,
  updateNodeData: (nodeId: string, patch: Partial<CanvasNodeData>) => void,
): MoreMenuSubmenu {
  const current = readKeyElementCategory(node.data as Record<string, unknown>);
  return {
    kind: 'submenu',
    key: 'keyElement',
    icon: Star,
    label: current ? `关键元素 · ${KEY_ELEMENT_CATEGORY_LABEL[current]}` : '设置关键元素',
    children: [
      ...KEY_ELEMENT_CATEGORY_KEYS.map((category) => ({
        key: `key-${category}`,
        label: KEY_ELEMENT_CATEGORY_LABEL[category],
        hint: current === category ? '当前' : undefined,
        onSelect: () =>
          updateNodeData(node.id, { keyElementCategory: category } as Partial<CanvasNodeData>),
      })),
      ...(current
        ? [
            {
              key: 'key-clear',
              label: '取消关键元素',
              onSelect: () =>
                updateNodeData(node.id, { keyElementCategory: null } as Partial<CanvasNodeData>),
            },
          ]
        : []),
    ],
  };
}

/**
 * 详情里的「...」更多菜单：把低频操作从常显按钮收进一个悬停展开的下拉面板。图片工具条
 * 那颗装编辑三项（高清/裁剪/旋转），详情头部那颗装节点级操作（设置关键元素等）。宫格
 * 模板不在此列——它是常显工具条上的独立下拉按钮（用户要求）。
 *
 * - hover 为主：移入图标或面板都保持打开，移出延迟 {@link MORE_MENU_CLOSE_DELAY_MS}ms
 *   收起（防抖，避免掠过即闪）；点击图标也可切换开关。
 * - 键盘可达：focus 落到触发器/任一项即展开（onFocus 冒泡），焦点整体离开则收起，
 *   Esc 收起并把焦点还给触发器。
 * - 面板绝对定位于触发器下方、右对齐，z-50 高于详情正文；样式对齐本分支体系。
 * - 二级菜单（submenu）向**右侧**飞出成独立面板、顶边与父项对齐，而不是就地把子项撑
 *   在父项下面（用户指定的参照样式与方向）。面板 portal 到 body 用 fixed 坐标摆，
 *   见 {@link placeSubmenu}——留在这棵树里会被右侧对话抽屉盖住。
 * - 叶子项点击后不主动关闭（悬停菜单惯例：移开/Esc 才收），保证连续操作与在途反馈可见。
 */
export function DetailMoreMenu({
  entries,
  triggerClassName,
  triggerLabel = '更多',
}: {
  entries: MoreMenuEntry[];
  /** 触发器样式：默认工具条按钮；详情头部那颗传 header 图标按钮的类。 */
  triggerClassName?: string;
  /**
   * 触发器的可及名称。图片详情里头部与工具条各有一颗「...」（前者是节点操作、
   * 后者是素材操作），叫同一个名字会让读屏与测试都分不清，所以头部那颗传
   * 「节点操作」。
   */
  triggerLabel?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<SubmenuPlacement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const openNow = useCallback(() => {
    clearCloseTimer();
    setOpen(true);
  }, [clearCloseTimer]);
  const closeNow = useCallback(() => {
    clearCloseTimer();
    setOpen(false);
    setSubmenu(null);
  }, [clearCloseTimer]);
  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      setSubmenu(null);
    }, MORE_MENU_CLOSE_DELAY_MS);
  }, [clearCloseTimer]);
  // 卸载时清掉未触发的收起定时器（详情按 key={node.id} 整体重挂载会走这里）。
  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  /** 展开某个二级菜单，并按锚点当场算好它的 fixed 坐标（见 placeSubmenu）。 */
  const openSubmenu = useCallback((key: string, anchor: HTMLElement) => {
    setSubmenu(placeSubmenu(key, anchor));
  }, []);

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      // 焦点整体离开菜单（下一焦点既不在 wrapper 内、也不在飞出的二级面板内）→
      // 收起。二级面板 portal 到了 body，DOM 上不再是 wrapper 的后代，所以要单独问
      // 它一句，否则 Tab 进子项的瞬间菜单就自己关了。
      const next = event.relatedTarget as Node | null;
      if (event.currentTarget.contains(next)) return;
      if (submenuRef.current?.contains(next)) return;
      closeNow();
    },
    [closeNow],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation();
        closeNow();
        triggerRef.current?.focus();
      }
    },
    [closeNow, open],
  );

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
      onFocus={openNow}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={triggerLabel}
        aria-haspopup="true"
        aria-expanded={open}
        title={triggerLabel}
        onClick={() => (open ? closeNow() : openNow())}
        className={triggerClassName ?? DETAIL_TOOLBAR_BUTTON_CLASS}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          aria-label="更多操作"
          className="absolute right-0 top-full z-50 mt-1.5 min-w-[210px] rounded-lg border border-white/10 bg-[#2e2e2e] p-1 text-white/85 shadow-xl"
        >
          {entries.map((entry) => {
            if (entry.kind === 'submenu') {
              const Icon = entry.icon;
              const placement = submenu?.key === entry.key ? submenu : null;
              const pending = Boolean(entry.pendingLabel);
              return (
                <div
                  key={entry.key}
                  onMouseEnter={(event) => !entry.disabled && openSubmenu(entry.key, event.currentTarget)}
                >
                  <button
                    type="button"
                    aria-haspopup="true"
                    aria-expanded={placement !== null}
                    disabled={entry.disabled}
                    onClick={(event) =>
                      placement
                        ? setSubmenu(null)
                        : openSubmenu(entry.key, event.currentTarget)
                    }
                    className={`${MORE_MENU_ITEM_CLASS} ${placement ? 'bg-white/5 text-white' : ''}`}
                  >
                    {pending ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                    ) : (
                      <Icon className="h-4 w-4 shrink-0" />
                    )}
                    <span className="flex-1">{entry.pendingLabel ?? entry.label}</span>
                    {/* 箭头不随展开转 90°：面板是侧边飞出的，朝右的箭头本来就指着它去的方向。 */}
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/40" />
                  </button>
                  {placement &&
                    createPortal(
                      // portal 到 body + fixed 坐标：故事板 overlay 是 z-30 的定位层，
                      // 留在里面的面板翻不过右侧 z-45 的对话抽屉（见 placeSubmenu）。
                      // 鼠标从父项横穿那道缝进面板会先触发 wrapper 的 onMouseLeave，
                      // 所以这里自己接住 enter/leave，把收起定时器按掉。
                      <div
                        ref={submenuRef}
                        aria-label={entry.label}
                        onMouseEnter={clearCloseTimer}
                        onMouseLeave={scheduleClose}
                        style={{
                          top: placement.top,
                          left: placement.left,
                          minWidth: SUBMENU_MIN_WIDTH,
                        }}
                        className="fixed z-[60] rounded-lg border border-white/10 bg-[#2e2e2e] p-1 text-white/85 shadow-xl"
                      >
                        {entry.children.map((child) => (
                          <button
                            key={child.key}
                            type="button"
                            onClick={child.onSelect}
                            className={MORE_MENU_ITEM_CLASS}
                          >
                            <span className="flex-1">{child.label}</span>
                            {child.hint && (
                              <span className="text-[10px] text-white/40">{child.hint}</span>
                            )}
                          </button>
                        ))}
                      </div>,
                      document.body,
                    )}
                </div>
              );
            }
            const Icon = entry.icon;
            return (
              <button
                key={entry.key}
                type="button"
                disabled={entry.busy}
                onClick={entry.onSelect}
                className={`${MORE_MENU_ITEM_CLASS} ${entry.active ? 'bg-white/[0.06] text-white' : ''}`}
              >
                {entry.busy ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                ) : (
                  <Icon className="h-4 w-4 shrink-0" />
                )}
                <span className="flex-1">{entry.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// 宫格模板清单（与 NodeActionToolbar.gridActions 同源：label 即 zh 翻译值，提交时
// label 同时作为展示 prompt 下发——真正的模板由 key→mode 映射决定）。
// 这里不挂算力：点一项只是**建节点**，不花钱；价钱在新节点的 ↑ 按钮上按当前
// 模型/参数活价显示（AssetBoardImageGenForm），在这儿标价反而像是点了就扣。
const GRID_ACTION_DEFS: Array<{
  key: GridActionKey;
  icon: LucideIcon;
  label: string;
}> = [
  { key: 'multiCameraGrid', icon: Grid3x3, label: '多机位九宫格' },
  { key: 'plotFourGrid', icon: Grid2x2, label: '剧情推演四宫格' },
  { key: 'faceThreeView', icon: User, label: '角色脸部三视图' },
  { key: 'productThreeView', icon: Package, label: '产品三视图' },
  { key: 'serialStoryboard25', icon: LayoutDashboard, label: '25宫格连贯分镜' },
  { key: 'cinematicLightCorrection', icon: Film, label: '电影级光影校正' },
  { key: 'characterThreeView', icon: Users, label: '角色三视图生成' },
  { key: 'sceneSettingSheet', icon: Mountain, label: '场景设定图' },
  { key: 'frameProjection3sLater', icon: FastForward, label: '画面推演 - 3秒后' },
  { key: 'frameProjection5sEarlier', icon: Rewind, label: '画面推演 - 5秒前' },
];

/**
 * 图片详情工具条。常显：下载 / 失败重试 / 全景 / 多角度 / 重打光 / 宫格模板；
 * **高清 / 裁剪 / 旋转** 收进最右那颗「...」更多菜单（悬停展开）。
 *
 * 用户拍板的两处删减：
 * - 原来那颗「编辑」下拉没了，它的三项就是现在「...」里的内容；
 * - 原来「...」里的 抠图 / 裁剪(工具弹窗) / 标注 / 分格抽取 / 历史 全部移除。
 *   注意「历史」一并没了 —— 生成失败的节点从此没有「回到上一次成功结果」的入口。
 *
 * @param onOpenNode 建出新节点后把详情切过去（同头部「创建副本」那条路径）。
 *   宫格模板与「... → 高清」都是「先建节点、按 ↑ 才提交」，不切详情用户就
 *   看不出发生了什么。
 */
export function AssetBoardImageDetailToolbar({
  node,
  onOpenNode,
}: {
  node: CanvasNode;
  onOpenNode?: (nodeId: string) => void;
}): ReactElement {
  const data = node.data as Record<string, unknown>;
  const imageSource = useMemo(() => resolveNodeSourceImageUrl(node), [node]);
  const isImageEdit = isImageEditNode(node);
  const isGenerating = data.isGenerating === true;
  const canRegenerate = canRegenerateExportImageNode(data);
  const [isDownloading, setIsDownloading] = useState(false);

  // 编辑三项（高清/裁剪/旋转）：条目进下面的「...」，编辑器弹窗随 overlays 挂出。
  // imageEdit 节点不给图片编辑入口（同工作流 NodeActionToolbar 的显隐语义）。
  const { entries: editEntries, overlays: editOverlays } = useAssetBoardImageEditActions({
    node,
    imageSource: isImageEdit ? null : imageSource,
    onOpenNode,
  });

  // 文件名推断沿用 NodeActionToolbar.resolveImageDownloadFilename 的规则。
  const handleDownload = useCallback(async () => {
    if (!imageSource || isDownloading) return;
    const sourceFileName =
      typeof data.sourceFileName === 'string' ? data.sourceFileName.trim() : '';
    const displayName = typeof data.displayName === 'string' ? data.displayName.trim() : '';
    const filename = sourceFileName || (displayName ? `${displayName}.png` : `node-${node.id}.png`);
    setIsDownloading(true);
    try {
      await downloadUrlAsFile(resolveImageDisplayUrl(imageSource), filename);
    } catch (error) {
      console.error('[asset-board] image download failed', error);
    } finally {
      setIsDownloading(false);
    }
  }, [data.displayName, data.sourceFileName, imageSource, isDownloading, node.id]);

  // 点功能 = **先建节点、不提交**（对标 liblib）：在下游建一个空的图片生成节点，
  // 节点名 = 功能名，输入框里带一枚可关可切的功能 chip；详情随即切到新节点，
  // 用户改完提示词/参考图/比例（或在功能框里换个功能）按 ↑ 才真正提交。
  //
  // 这条只改故事板的交互形态：工作流侧的「确认即提交」（GridActionConfirmOverlay
  // + submitGridTemplateAction）一行没动，能力完全一样。
  const handleGridAction = useCallback(
    (def: (typeof GRID_ACTION_DEFS)[number]) => {
      if (!imageSource) return;
      const newNodeId = spawnAssetBoardImageOpNode(node.id, imageSource, def.key);
      if (!newNodeId) return;
      // 低成本视口预定位（M7）：保活挂载的 Canvas 先把视口对准新节点，用户切回
      // 工作流时不用自己找。
      useCanvasStore.getState().requestFocusNode(newNodeId);
      onOpenNode?.(newNodeId);
    },
    [imageSource, node.id, onOpenNode],
  );

  // 「...」更多菜单的条目就是编辑三项（高清/裁剪/旋转），全部来自
  // useAssetBoardImageEditActions。原来住在这里的 抠图 / 裁剪(工具弹窗) / 标注 /
  // 分格抽取 / 历史 已按用户要求整体移除（能力本身仍在工作流侧 NodeActionToolbar）。
  // 宫格模板是常显下拉按钮，不进菜单；「设置关键元素」是节点级操作，在详情头部那颗
  // 「...」里（四栏一致，见 AssetBoardDetail）。

  return (
    <div className="flex flex-col gap-2">
      {/* 居中：工具条是详情的操作行，媒体本身也是居中的，左对齐会让这行孤零零
          吊在左上角（用户要求）。 */}
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <DetailToolbarButton
          icon={Download}
          label="下载"
          busy={isDownloading}
          disabled={!imageSource}
          onClick={() => void handleDownload()}
        />
        {canRegenerate && (
          <DetailToolbarButton
            icon={RefreshCw}
            label="重新生成"
            busy={isGenerating}
            title="重新提交这次生成（失败重试）"
            onClick={() => void regenerateExportImageNode(node.id)}
          />
        )}
        {/* 常显第二批图片操作（全景 / 多角度 / 重打光）。按钮落在本行，失败兜底文案
            用 w-full 自动换到下一行。显隐与工作流 NodeActionToolbar 同源：imageEdit
            节点不给图片编辑入口，无图源不显示。 */}
        {!isImageEdit && imageSource && (
          <AssetBoardImageOps node={node} imageSource={imageSource} />
        )}
        {/* 宫格模板：常显下拉按钮（从「...」菜单挪出来，用户要求）。点开列 9 个模板，
            选中即在下游建一个同名的空图片节点并把详情切过去——不再当场提交，
            用户在新节点的输入框里确认（或换功能）后按 ↑ 才真正生成。 */}
        {!isImageEdit && imageSource && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title="基于本图套用宫格 / 多视图模板生成"
                className={DETAIL_TOOLBAR_BUTTON_CLASS}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                宫格模板
                <ChevronDown className="h-3 w-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={6}
              className="z-50 min-w-[200px] border-white/10 bg-[#2e2e2e] text-white/85 shadow-xl"
            >
              {GRID_ACTION_DEFS.map((def) => {
                const Icon = def.icon;
                return (
                  <DropdownMenuItem
                    key={def.key}
                    className="gap-2 rounded-[6px] text-white/80 focus:bg-white/[0.08] focus:text-white"
                    onSelect={() => handleGridAction(def)}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{def.label}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {/* 「...」更多菜单：高清 / 裁剪 / 旋转（悬停展开，见组件注释）。
            条目被 preset_managed 过滤到一个不剩、或本身没图可编辑时整颗不渲染
            ——否则点开是个空面板。 */}
        {editEntries.length > 0 && <DetailMoreMenu entries={editEntries} />}
      </div>
      {/* 裁剪 / 旋转编辑器（portal 弹窗），跟着上面那三项一起来自同一个 hook。 */}
      {editOverlays}
    </div>
  );
}

/** 节点片源：videoUrl 优先，其次高清/去字幕等写回的 resultVideoUrl。 */
function videoSourceUrlOf(node: CanvasNode): string | null {
  const data = node.data as Record<string, unknown>;
  if (typeof data.videoUrl === 'string' && data.videoUrl) return data.videoUrl;
  if (typeof data.resultVideoUrl === 'string' && data.resultVideoUrl) return data.resultVideoUrl;
  return null;
}

/** 生成失败过的节点。 */
function hasFailedGeneration(node: CanvasNode): boolean {
  const data = node.data as Record<string, unknown>;
  return typeof data.generationError === 'string' && data.generationError.trim().length > 0;
}

/**
 * 图片详情工具条有没有可用操作。没有就别渲染整条——空节点（还没出图）上的
 * 下载/编辑/宫格全要图源，摆一排灰按钮只是噪音（用户要求）。
 * 两个例外：
 * - 导出图节点生成失败时没图源，但「重新生成」正是这时候要点的；
 * - 其余生成失败的节点同样留着整条，让「重新生成」一类不吃图源的入口有地方待。
 *   注意「历史」已随「...」菜单改版整体移除（用户要求），失败节点从此没有
 *   「回到上一次成功结果」的入口——同视频侧的取舍。
 */
export function hasImageDetailActions(node: CanvasNode): boolean {
  // 还没出图的高清结果节点：resolveNodeSourceImageUrl 会摸到它存的**源图**
  // （previewImageUrl），据此摆出一排「下载/编辑/全景…」等于把待放大的原图当成
  // 这个节点的产物在操作。这里先短路——它眼下唯一该做的事是下方那张卡片按 ↑。
  if (isPendingUpscaleNode(node)) return false;
  return (
    Boolean(resolveNodeSourceImageUrl(node)) ||
    canRegenerateExportImageNode(node.data as Record<string, unknown>) ||
    hasFailedGeneration(node)
  );
}

/**
 * 视频详情工具条有没有可用操作。同上：没片源的视频节点整条不渲染。
 * 唯一的例外是合成节点——它的「剪辑」靠上游素材而非自身片源，自己还没出片也留着
 * （素材不够时按钮自带「需要至少 2 个已就绪的上游视频素材」的说明）。
 *
 * 生成失败的节点不再是例外：工具条砍到「剪辑/高清/下载/全屏」四项后（用户要求），
 * 不要求片源的「历史」没了，留下来也只是四颗全灰的按钮。
 */
export function hasVideoDetailActions(node: CanvasNode): boolean {
  return Boolean(videoSourceUrlOf(node)) || isVideoComposeNode(node);
}

/**
 * 工具条外壳：与画布节点工具条同一表面（CANVAS_NODE_TOOLBAR_SURFACE_CLASS），只是
 * 内边距收一档——它要塞进详情头部那行。圆角同样按 10px 走，不做全胶囊（用户反馈）。
 */
const VIDEO_FLOAT_PILL_CLASS =
  `flex items-center gap-0.5 rounded-[10px] p-1 ${CANVAS_NODE_TOOLBAR_SURFACE_CLASS}`;

/** 工具条里的按钮：无边框（外壳已提供表面），图标可单独成键；h-6 让整条贴着头部行高。 */
const VIDEO_FLOAT_BUTTON_CLASS =
  'inline-flex h-6 items-center gap-1.5 rounded-[7px] px-2.5 text-[12px] text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40';

/** 浮动工具条上的一颗按钮（label 只在 showLabel 时出字，否则退化成纯图标键）。 */
function VideoFloatButton({
  icon: Icon,
  label,
  showLabel = false,
  busy = false,
  disabled = false,
  title,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  showLabel?: boolean;
  busy?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      // 纯图标键没有可见文案，aria-label 兜住读屏与测试的可及名。
      aria-label={label}
      title={title ?? label}
      disabled={disabled || busy}
      onClick={onClick}
      className={VIDEO_FLOAT_BUTTON_CLASS}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {showLabel && label}
    </button>
  );
}

/**
 * 视频详情的浮动工具条：**剪辑 / 高清 / 下载 / 全屏** 四项（用户要求砍到这四个，
 * 其余视频功能——智能去字幕 / 翻译提示词 / 历史 / 剪辑轨道 / 解析 / 分离音视频 /
 * 截帧 / 替换视频 / 框选擦除——已从故事板移除，工作流侧 NodeActionToolbar 不受影响）。
 *
 * 形态也跟着换了：不再是详情头部下方那条常显按钮行，而是一颗居中的胶囊
 * （对齐 liblib），**hover 到视频详情才浮现**。它落在详情头部标题与右侧图标之间那段
 * 空白里——压在画面上会把视频挡掉一截（用户反馈）。悬停上下文由 AssetBoardDetail
 * 的根 `group/detail` 给（具名 group：详情里还有别的 group-hover，共用匿名 group
 * 会互相误触发）；配置面板或合成弹窗开着时钉住不隐藏，否则鼠标一移开，正在填的
 * 高清参数就跟着消失。
 */
export function AssetBoardVideoDetailToolbar({
  node,
  playerRef,
}: {
  node: CanvasNode;
  /** 详情正文里那个活的 <video>：「全屏」直接对它发 requestFullscreen。 */
  playerRef?: RefObject<HTMLVideoElement | null>;
}): ReactElement {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const data = node.data as Record<string, unknown>;
  const isVideo = isVideoNode(node);
  const isCompose = isVideoComposeNode(node);
  const videoUrl = videoSourceUrlOf(node);

  const [upscaleOpen, setUpscaleOpen] = useState(false);
  const [upscaleResolution, setUpscaleResolution] =
    useState<FreezoneVideoUpscaleResolution>('1080p');
  const [upscaleDenoise, setUpscaleDenoise] = useState<FreezoneVideoUpscaleDenoise>('1x');
  const [isDownloading, setIsDownloading] = useState(false);
  const [isSubmittingUpscale, setIsSubmittingUpscale] = useState(false);
  const [composeSeeds, setComposeSeeds] = useState<string[] | null>(null);

  const project = readUrl().project;
  const canvasId = readUrl().canvas ?? 'default';

  // 视频合成入口的可用性：合成节点沿用工作流「≥2 个有片源的上游视频」门槛；
  // 普通视频节点以自身为素材种子，只要有片源即可。
  // 用响应式 selector 取代 useMemo 里的 getState() 快照 —— 后者只在依赖
  // （isCompose/node.id）变化时重算，上游视频在详情打开期间才生成完成不会
  // 触发重渲染，「剪辑」按钮会一直卡在禁用态。selector 返回 number，
  // Zustand 用 Object.is 去重，值不变不会多渲染；只订阅这一个派生值，
  // 不会因为 store 里其它无关字段变化而多渲染。
  const composeUpstreamVideoCount = useCanvasStore((state) => {
    if (!isCompose) return 0;
    const byId = new Map(state.nodes.map((candidate) => [candidate.id, candidate]));
    return state.edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => byId.get(edge.source))
      .filter((upstream): upstream is CanvasNode => Boolean(upstream))
      .filter((upstream) => isVideoNode(upstream) && Boolean(upstream.data.videoUrl)).length;
  });
  const canOpenCompose = isCompose ? composeUpstreamVideoCount >= 2 : Boolean(videoUrl);

  const openCompose = useCallback(() => {
    if (!project || !canOpenCompose) return;
    if (!isCompose) {
      setComposeSeeds([node.id]);
      return;
    }
    // 与 VideoComposeNode 相同的种子推导：上游有片源的视频/音频节点按 y 排序。
    const state = useCanvasStore.getState();
    const byId = new Map(state.nodes.map((candidate) => [candidate.id, candidate]));
    const seeds = state.edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => byId.get(edge.source))
      .filter((upstream): upstream is CanvasNode => Boolean(upstream))
      .filter(
        (upstream) =>
          (isVideoNode(upstream) && Boolean(upstream.data.videoUrl)) ||
          (isAudioNode(upstream) && Boolean(upstream.data.audioUrl)),
      )
      .sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0))
      .map((upstream) => upstream.id);
    setComposeSeeds(seeds);
  }, [canOpenCompose, isCompose, node.id, project]);

  const handleComposed = useCallback(
    (url: string, coverUrl: string | null) => {
      // 与 VideoComposeNode.onComposed 同语义：下游建视频节点承载结果并连边；
      // 合成节点还会聚焦新节点并回写 resultVideoUrl/previewImageUrl。
      const store = useCanvasStore.getState();
      const position = store.findNodePosition(node.id, 580, 380);
      const newId = store.addNode(CANVAS_NODE_TYPES.video, position, {
        videoUrl: url,
        previewImageUrl: coverUrl,
        displayName: '合成视频',
        sourceFileName: null,
      } as Partial<CanvasNodeData>);
      store.addEdge(node.id, newId);
      if (isCompose) {
        store.setSelectedNode(newId);
        store.requestFocusNode(newId);
        store.updateNodeData(node.id, {
          resultVideoUrl: url,
          previewImageUrl: coverUrl,
        } as Partial<CanvasNodeData>);
      }
      setComposeSeeds(null);
    },
    [isCompose, node.id],
  );

  const handleDownload = useCallback(async () => {
    if (!videoUrl || isDownloading) return;
    // 文件名推断沿用 NodeActionToolbar 视频下载的规则。
    const sourceFileName =
      typeof data.sourceFileName === 'string' && data.sourceFileName.trim().length > 0
        ? data.sourceFileName
        : typeof data.displayName === 'string' && data.displayName.trim().length > 0
          ? `${data.displayName}.mp4`
          : `video-${node.id}.mp4`;
    setIsDownloading(true);
    try {
      await downloadUrlAsFile(resolveImageDisplayUrl(videoUrl), sourceFileName);
    } catch (error) {
      console.error('[asset-board] video download failed', error);
    } finally {
      setIsDownloading(false);
    }
  }, [data.displayName, data.sourceFileName, isDownloading, node.id, videoUrl]);

  const handleUpscaleSubmit = useCallback(() => {
    if (!videoUrl || isSubmittingUpscale) return;
    // 沿用工作流「先建 isUpscaleNode 结果节点」语义，配置在详情选好后直接提交。
    const displayName = `高清（${VIDEO_UPSCALE_RESOLUTION_LABEL[upscaleResolution]}）`;
    const upscaleNodeId = createVideoUpscaleResultNode(node.id, {
      sourceUrl: videoUrl,
      displayName,
      resolution: upscaleResolution,
      denoise: upscaleDenoise,
    });
    if (!upscaleNodeId) return;
    // 配置行收起后，工具条「高清」按钮转为 spinner 直到 submit settle——
    // 与翻译/去字幕/宫格的进行中反馈风格一致（结果落新建的画布节点）。
    setUpscaleOpen(false);
    setIsSubmittingUpscale(true);
    // 低成本视口预定位（M7）：结果节点已同步建好，立即对焦（见 handleMatte 注释）。
    useCanvasStore.getState().requestFocusNode(upscaleNodeId);
    void submitVideoUpscale(upscaleNodeId, {
      sourceUrl: videoUrl,
      resolution: upscaleResolution,
      denoise: upscaleDenoise,
    }).finally(() => setIsSubmittingUpscale(false));
  }, [isSubmittingUpscale, node.id, upscaleDenoise, upscaleResolution, videoUrl]);

  // 全屏：直接对正文那个活的播放器发 requestFullscreen（不是把详情面板整块放大——
  // 用户要的是「看片」）。iOS Safari 的 <video> 没有标准 API，退到它自家的
  // webkitEnterFullscreen。
  const handleFullscreen = useCallback(() => {
    const player = playerRef?.current;
    if (!player) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (typeof player.requestFullscreen === 'function') {
      void player.requestFullscreen().catch((error: unknown) => {
        console.error('[asset-board] video fullscreen failed', error);
      });
      return;
    }
    (player as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen?.();
  }, [playerRef]);

  // 配置面板 / 合成弹窗开着时，工具条从「hover 才出现」切成钉住常显。
  const pinned = upscaleOpen || composeSeeds !== null;

  return (
    <>
      {/* 默认透明 + 不吃指针，鼠标移进详情面板或键盘焦点落进来才浮现。opacity 而非
          hidden——visibility:hidden 会让按钮 Tab 不到，键盘用户就再也够不着这四个功能；
          也正因为占位不变，浮现/隐藏不会把头部撑一下。 */}
      <div
        className={`relative shrink-0 transition-opacity duration-150 ${
          pinned
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/detail:pointer-events-auto group-hover/detail:opacity-100'
        }`}
      >
        <div className={VIDEO_FLOAT_PILL_CLASS}>
          <VideoFloatButton
            icon={Scissors}
            label="剪辑"
            showLabel
            disabled={!project || !canOpenCompose}
            title={
              isCompose && !canOpenCompose
                ? '需要至少 2 个已就绪的上游视频素材'
                : '打开视频合成时间线'
            }
            onClick={openCompose}
          />
          {isVideo && (
            <VideoFloatButton
              icon={ImageUpscale}
              label="高清"
              showLabel
              busy={isSubmittingUpscale}
              disabled={!videoUrl}
              title="放大分辨率（在画布上新建高清结果节点）"
              onClick={() => setUpscaleOpen((open) => !open)}
            />
          )}
          <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-white/12" />
          <VideoFloatButton
            icon={Download}
            label="下载"
            busy={isDownloading}
            disabled={!videoUrl}
            onClick={() => void handleDownload()}
          />
          <VideoFloatButton
            icon={Maximize2}
            label="全屏"
            disabled={!videoUrl}
            title="全屏播放"
            onClick={handleFullscreen}
          />
        </div>

        {/* 高清配置：吊在胶囊正下方的浮层（原来是详情里独占一行的配置行——工具条
            挪进头部之后，那一行没地方摆了）。z-50 压过下方正文。 */}
        {upscaleOpen && isVideo && (
          <div className="absolute left-1/2 top-full z-50 mt-2 flex -translate-x-1/2 flex-wrap items-center justify-center gap-3 whitespace-nowrap rounded-xl border border-white/10 bg-[#282828] px-3 py-2 shadow-[0_10px_24px_rgba(0,0,0,0.32)]">
            <span className="text-[12px] text-white/40">分辨率</span>
            <div className="inline-flex items-center gap-0.5 rounded-md border border-white/10 bg-white/[0.04] p-0.5">
              {VIDEO_UPSCALE_RESOLUTIONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setUpscaleResolution(value)}
                  className={`rounded px-2 py-0.5 text-[12px] transition-colors ${
                    upscaleResolution === value
                      ? 'bg-white/15 text-white'
                      : 'text-white/50 hover:bg-white/5 hover:text-white/80'
                  }`}
                >
                  {VIDEO_UPSCALE_RESOLUTION_LABEL[value]}
                </button>
              ))}
            </div>
            <span className="text-[12px] text-white/40">降噪</span>
            <div className="inline-flex items-center gap-0.5 rounded-md border border-white/10 bg-white/[0.04] p-0.5">
              {VIDEO_UPSCALE_DENOISE_OPTIONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setUpscaleDenoise(value)}
                  className={`rounded px-2 py-0.5 text-[12px] transition-colors ${
                    upscaleDenoise === value
                      ? 'bg-white/15 text-white'
                      : 'text-white/50 hover:bg-white/5 hover:text-white/80'
                  }`}
                >
                  {value === 'none' ? '无' : value}
                </button>
              ))}
            </div>
            <DetailToolbarButton
              icon={Wand2}
              label="提交高清"
              busy={isSubmittingUpscale}
              disabled={!videoUrl}
              title="在画布上新建高清结果节点并提交任务"
              onClick={handleUpscaleSubmit}
            />
          </div>
        )}
      </div>

      {/* 弹窗留在悬停层之外：它是全屏 portal 级的东西，跟着工具条一起淡入淡出
          没有意义，也不该被 pointer-events 的开关波及。 */}
      {composeSeeds !== null && project && (
        <VideoComposeModal
          project={project}
          canvasId={canvasId}
          seedNodeIds={composeSeeds}
          // 与 VideoComposeNode.tsx 同语义（不再按 isCompose 分叉）：普通视频节点
          // 打开「剪辑」也在自己的 node.data.draftTimeline 上读写草稿——
          // VideoNodeData 本就带 [key: string]: unknown 索引签名，此前普通视频节点
          // 走的是「关闭即丢草稿」的降级路径（M4）。onPersistDraft 在弹窗卸载时
          // 无条件调用（见 VideoComposeModal 的 unmount effect），故这里始终注入。
          initialTimeline={(data.draftTimeline as ComposeTimelineState | undefined) ?? null}
          onPersistDraft={(timeline) =>
            updateNodeData(node.id, { draftTimeline: timeline } as Partial<CanvasNodeData>)
          }
          onClose={() => setComposeSeeds(null)}
          onComposed={handleComposed}
        />
      )}
    </>
  );
}
