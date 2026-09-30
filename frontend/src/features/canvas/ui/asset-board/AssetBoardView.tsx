// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Check, ChevronDown, ImageIcon, Maximize2, Minimize2, Play } from 'lucide-react';

import {
  buildAssetBoard,
  // 别名：本文件同时导入了同名的栏壳组件 ./AssetBoardColumn。
  type AssetBoardColumn as BoardColumnKind,
  type AssetBoardItem,
  type AssetBoardReference,
} from '@/features/canvas/domain/assetBoard';
import type {
  CanvasEdge,
  CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { ImageViewerModal } from '@/features/canvas/ui/ImageViewerModal';
import { useCanvasStore } from '@/stores/canvasStore';
import { cn } from '@/lib/utils';

import { AssetBoardCard, VideoThumb } from './AssetBoardCard';
import { AssetBoardColumn } from './AssetBoardColumn';
import { AssetBoardColumns } from './AssetBoardColumns';
import { AssetBoardDetail } from './AssetBoardDetail';
import { KeyElementsBar } from './KeyElementsBar';

type VideoFilter = 'all' | 'final' | 'clip';

/** 图片灯箱状态（视频不再走弹窗——详情面板里内联 <video controls> 播放）。 */
type ViewerState = { urls: string[]; index: number } | null;

/** 主从详情栈条目：column 决定左侧窄列表切到哪一栏（音频与图片/视频同款进详情栈）。 */
interface DetailEntry {
  column: 'text' | 'image' | 'video' | 'audio';
  nodeId: string;
}

interface AssetBoardViewProps {
  /** false 时保持挂载但不可见（Shell 用 visibility 隐藏），数据源同时冻结。 */
  visible: boolean;
  /** 「在画布中定位」：由 Shell 切回工作流并 requestFocusNode。 */
  onLocateNode: (nodeId: string) => void;
}

// 详情栈安全网：互相引用的节点（A→B→A→B…）理论上可以无限 push，50 层封顶
// 只是兜底，不影响正常使用——正常路径靠下面 openReference 的去重截断收敛。
const DETAIL_STACK_MAX = 50;

/** 放大态网格里「定位」高亮的持续时长（与卡片侧 LOCATE_HIGHLIGHT_MS 同值）。 */
const GRID_LOCATE_HIGHLIGHT_MS = 1200;

const VIDEO_FILTERS: ReadonlyArray<{ value: VideoFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'final', label: '成片' },
  { value: 'clip', label: '片段' },
];

// 冻结时 item 引用稳定，memo 让隐藏→显示切换外的重渲染跳过整卡子树。
const MemoAssetBoardCard = memo(AssetBoardCard);

export function AssetBoardView({ visible, onLocateNode }: AssetBoardViewProps): ReactElement {
  // 隐藏时 selector 恒返回 null（Object.is 相等）→ 画布拖拽/生成进度不会重渲染隐藏的故事板。
  const liveNodes = useCanvasStore((state) => (visible ? state.nodes : null));
  const liveEdges = useCanvasStore((state) => (visible ? state.edges : null));
  // 渲染期直接写 ref（非 effect）：这是有意的 last-non-null 缓存，不是遗留的
  // 副作用误用。写入前的比较是幂等的——同一渲染只会把 dataRef.current 收敛到
  // 与 liveNodes/liveEdges 一致的值，StrictMode 的双调用第二次进来时条件已为
  // false，不会重复赋值或产生可观察差异。若未来引入 React Compiler，这类
  // "读 props 派生、写自身 ref 缓存" 的模式需要人工复核是否仍然安全，不要机械
  // 套用自动优化的 memo 化改写。
  const dataRef = useRef<{ nodes: CanvasNode[]; edges: CanvasEdge[] }>({ nodes: [], edges: [] });
  if (liveNodes !== null && liveEdges !== null) {
    if (dataRef.current.nodes !== liveNodes || dataRef.current.edges !== liveEdges) {
      dataRef.current = { nodes: liveNodes, edges: liveEdges };
    }
  }
  const { nodes, edges } = dataRef.current;
  const board = useMemo(() => buildAssetBoard(nodes, edges), [nodes, edges]);

  const [videoFilter, setVideoFilter] = useState<VideoFilter>('all');
  // 放大态：把图片/视频栏摊成右半边的宽幅网格（左边只留关键元素 + 文本栏），
  // 再点收起按钮回三栏。详情打开时优先渲染详情，关掉详情仍回到放大态。
  const [expandedColumn, setExpandedColumn] = useState<'image' | 'video' | null>(null);
  const [viewer, setViewer] = useState<ViewerState>(null);
  // 主从详情栈：点卡片/音频 chip=置 [item]；详情内参考跳转=push；←=pop；×/Esc=清空。
  // 切换视图模式（visible 翻转）不清空——故事板保活语义。
  const [detailStack, setDetailStack] = useState<DetailEntry[]>([]);
  // 「定位」滚动请求：详情里参考素材点「定位」时置 { nodeId, token }，token 单调自增
  // （即便重复定位同一节点也换令牌，保证目标卡片能再次触发滚动+高亮）。传给列/卡片，
  // 只有被引用节点那张卡拿到非 null 令牌，其余恒 null（不打断 memo）。这里是故事板
  // 列表内定位（滚到卡片位置），与 onLocateNode 的「跳回画布聚焦」是两回事。
  const [scrollRequest, setScrollRequest] = useState<{ nodeId: string; token: number } | null>(
    null,
  );

  const filteredVideos = useMemo(
    () => (videoFilter === 'all' ? board.video : board.video.filter((i) => i.videoRole === videoFilter)),
    [board.video, videoFilter],
  );

  // 关键元素：四栏里所有被标记（keyElementCategory 非空）的条目，跨栏收集，供顶部
  // 关键元素栏常驻展示。按栏顺序（文本/图片/视频/音频，各栏内已是创建序新→旧）拼接。
  const keyElements = useMemo(
    () =>
      [...board.text, ...board.image, ...board.video, ...board.audio].filter(
        (item) => item.keyElementCategory !== null,
      ),
    [board.text, board.image, board.video, board.audio],
  );

  // 图片灯箱的翻页列表：图片栏全部有图卡片。
  const imageUrls = useMemo(
    () => board.image.map((i) => i.mediaUrl).filter((u): u is string => u !== null),
    [board.image],
  );

  // nodeId → 故事板条目（详情面板与参考跨栏跳转的查找表）。
  const itemById = useMemo(() => {
    const map = new Map<string, AssetBoardItem>();
    for (const list of [board.text, board.image, board.video, board.audio]) {
      for (const item of list) map.set(item.nodeId, item);
    }
    return map;
  }, [board.text, board.image, board.video, board.audio]);

  // 点击语义：任意卡片/音频 chip（文本/图片/视频/音频）→ 打开详情面板。「跳画布」
  // 只保留卡片准星按钮与详情内「在画布中定位」。
  const openItem = useCallback((item: AssetBoardItem) => {
    setDetailStack([{ column: item.column, nodeId: item.nodeId }]);
  }, []);

  // 详情内点参考缩略图：被引用节点有故事板详情可开 → push（左栏自动切栏）；
  // 否则（参考图无对应画布节点详情，如已不入板的类型）退化为灯箱单图。
  // 去重语义（面包屑）：互相引用的节点 A→B→A→B… 会让栈无界增长——若目标
  // (column, nodeId) 已经在栈里出现过，不再重复 push，而是截断回那一层
  // （视为「回到已经打开过的那一级」），栈深因此收敛，不会无限增长。
  // 50 层封顶是防御性兜底，正常情况下走不到。
  const openReference = useCallback(
    (ref: AssetBoardReference) => {
      // 自带参考图（nodeId=null）无对应画布节点详情 → 直接退化为灯箱看图。
      const target = ref.nodeId ? itemById.get(ref.nodeId) : undefined;
      if (target && target.column !== 'audio') {
        // 提出 const：属性收窄不会穿透进 setState 回调闭包。
        const column = target.column;
        const nodeId = target.nodeId;
        setDetailStack((stack) => {
          const existingIndex = stack.findIndex(
            (entry) => entry.column === column && entry.nodeId === nodeId,
          );
          if (existingIndex >= 0) {
            return stack.slice(0, existingIndex + 1);
          }
          const next = [...stack, { column, nodeId }];
          return next.length > DETAIL_STACK_MAX
            ? next.slice(next.length - DETAIL_STACK_MAX)
            : next;
        });
        return;
      }
      setViewer({ urls: [ref.thumbnailUrl], index: 0 });
    },
    [itemById],
  );

  // 详情内参考素材点「定位」：把故事板列表滚到被引用节点的卡片处并短暂高亮（非画布定位）。
  // - 同栏（如图片详情引用图片，左侧窄列表就是图片栏）：保留详情，滚窄列表到该卡片。
  // - 跨栏（如视频详情引用图片）：退回三栏总览（清空详情栈），滚到该节点所在栏的卡片。
  // 令牌单调自增，保证连续两次定位同一节点也能重新触发目标卡片的滚动+高亮。
  const locateInBoard = useCallback(
    (nodeId: string) => {
      const target = itemById.get(nodeId);
      if (!target) return; // 不在故事板里（无对应卡片）→ 无处可滚，静默忽略。
      setDetailStack((stack) => {
        const active = stack.length > 0 ? stack[stack.length - 1] : null;
        return active && active.column === target.column ? stack : [];
      });
      setScrollRequest((prev) => ({ nodeId, token: (prev?.token ?? 0) + 1 }));
    },
    [itemById],
  );

  // 按 (栏, nodeId) 打开详情（详情头部「创建副本」建好节点后切过去）。
  // 栏由调用方给，不查 itemById：副本是在事件处理器里刚写进 store 的，此刻还没
  // 重渲染，闭包里的 itemById 仍是上一帧的快照，查不到它——查表会让「创建副本」
  // 变成静默无事发生。副本与源节点同类型，栏必然相同，调用方直接把 column 带过来。
  const openNodeDetail = useCallback((nodeId: string, column: BoardColumnKind) => {
    setDetailStack([{ column, nodeId }]);
  }, []);

  const detailBack = useCallback(() => {
    setDetailStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : []));
  }, []);
  const detailClose = useCallback(() => setDetailStack([]), []);

  const previewImage = useCallback(
    (url: string) => {
      const index = imageUrls.indexOf(url);
      // 参考图可能不在图片栏（如节点自带的本地参考图）→ 单图预览。
      setViewer(index >= 0 ? { urls: imageUrls, index } : { urls: [url], index: 0 });
    },
    [imageUrls],
  );

  const activeDetail = detailStack.length > 0 ? detailStack[detailStack.length - 1] : null;
  const activeItem = activeDetail ? (itemById.get(activeDetail.nodeId) ?? null) : null;
  const detailOpen = activeDetail !== null;
  const viewerOpen = viewer !== null;

  // 音频切换器始终在顶栏的音频标签里（对标 liblib，总览与音频详情两态一致）。音频详情
  // 打开时把节点 id 传给顶栏 → 自动切到音频标签并高亮该 chip；左栏则退回可切换的文本
  // 列表（见下方主从分支），不再单挂一条音频条。
  const activeAudioNodeId = activeDetail?.column === 'audio' ? activeDetail.nodeId : null;

  // 详情态左窄列表「显示哪一栏」——与右侧 activeDetail 解耦：头部下拉切栏只改这个，
  // 右侧详情面板始终跟 activeDetail 不变。默认（及每次 activeDetail 切到新节点）回到
  // 该节点所在栏；用户从下拉手动切栏后保持其选择，直到 activeDetail 再次变化。
  const [leftListColumn, setLeftListColumn] = useState<'text' | 'image' | 'video'>('image');
  // 渲染期同步派生 state（非 effect）：每当 activeDetail 切到新的(栏,节点)——打开卡片、
  // 参考跳转 push、← 弹栈——把左列表重置回该栏。用 last-key ref 守卫，保证「同一详情内
  // 用户手动下拉切栏」不会被这条同步覆盖（activeDetail 未变→key 未变→不重置）。
  // React 支持在渲染期为「派生自其它 state」的 state 调用 setState：它会就地丢弃本次
  // 渲染输出并立刻用新值重渲，不提交中间帧，故不会闪现旧栏（对齐本文件 dataRef 的
  // 幂等渲染期写法；StrictMode 双调用第二次 key 已等于 ref，不重复置数）。
  const lastDetailKeyRef = useRef<string | null>(null);
  if (activeDetail !== null) {
    const detailKey = `${activeDetail.column}:${activeDetail.nodeId}`;
    if (detailKey !== lastDetailKeyRef.current) {
      lastDetailKeyRef.current = detailKey;
      // 音频详情左栏没有对应栏（音频切换器在顶栏）→ 默认落到文本栏；其余落到该节点所在栏。
      const target = activeDetail.column === 'audio' ? 'text' : activeDetail.column;
      if (leftListColumn !== target) {
        setLeftListColumn(target);
      }
    }
  } else {
    // 详情关闭：清空追踪，下次开详情必定重新同步。
    lastDetailKeyRef.current = null;
  }

  // Esc = 关闭详情。灯箱开着时不注册监听——灯箱自己的 Esc 先关灯箱，
  // 避免一次按键连关两层（ImageViewerModal 的监听见其内部实现）。
  useEffect(() => {
    if (!visible || !detailOpen || viewerOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      // 原生全屏（如详情视频的全屏播放）里的 Esc 是「退出全屏」，浏览器退出后
      // 仍会派发 keydown——此时不能顺手把详情也关掉。
      if (document.fullscreenElement) return;
      if (event.key === 'Escape') setDetailStack([]);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visible, detailOpen, viewerOpen]);

  // 灯箱常驻挂载（open 布尔控制），关闭时 viewer 变 null，但内容 props
  // 需要在 320-400ms 淡出期间维持最后一次的值，否则图片会跟着 viewer
  // 一起瞬间清空（跟随 CanvasHistoryAssetsModal / Canvas.tsx 的常驻惯例）。
  // 渲染期直接写 ref：与上面 dataRef 同理，是幂等的最近非空缓存。
  const lastViewerRef = useRef<Exclude<ViewerState, null> | null>(null);
  if (viewer !== null) {
    lastViewerRef.current = viewer;
  }
  const displayViewer = viewer ?? lastViewerRef.current;

  // 关键元素 + 音频并进一条、标签切换。总览态横在三栏上方通栏，详情态挂进左列
  // （位置变、实例不变，切换详情不会重挂丢掉分类筛选/音频标签的选中态）。
  // 两类都空则不渲染、不占位。
  const keyElementsBar =
    keyElements.length > 0 || board.audio.length > 0 ? (
      <KeyElementsBar
        keyItems={keyElements}
        audioItems={board.audio}
        activeAudioNodeId={activeAudioNodeId}
        onOpen={openItem}
      />
    ) : null;

  // 三栏与主从布局共用的栏渲染（主从时只渲染被点栏的窄列表 + 选中高亮）。
  // 音频不走这里——它的切换器在顶栏音频标签里（KeyElementsBar）。
  // titleSlot：详情态左窄列表传入「文本/图片/视频」切换下拉替换默认标题（见 return 内主从分支）。
  const renderBoardColumn = (
    column: 'text' | 'image' | 'video',
    titleSlot?: ReactNode,
    // 「放大」按钮只在总览三栏里有意义：详情态右半边被详情面板占着，放大态右半边
    // 被网格占着，两种布局下点它都不会有任何变化（只会埋下「关掉详情后突然变成
    // 放大态」的意外）。所以左窄列表/放大态左列一律不给。
    { expandable = false }: { expandable?: boolean } = {},
  ): ReactElement => {
    const selectedNodeId = activeDetail?.nodeId;
    switch (column) {
      case 'text':
        return (
          <BoardColumn
            title="文本"
            titleSlot={titleSlot}
            items={board.text}
            emptyText="画布中还没有文本类节点"
            onOpen={openItem}
            onLocate={onLocateNode}
            onPreviewImage={previewImage}
            onOpenReference={openReference}
            onLocateReference={locateInBoard}
            selectedNodeId={selectedNodeId}
            scrollRequest={scrollRequest}
            paused={!visible}
            // 文本卡只有一行图标+标题，本来就是一条条列表，不需要分割线（用户要求）；
            // 分割线只给图片/视频这种「一个节点一大块内容」的栏。
          />
        );
      case 'image':
        return (
          <BoardColumn
            title="图片"
            titleSlot={titleSlot}
            items={board.image}
            emptyText="画布中还没有图片节点"
            onOpen={openItem}
            onLocate={onLocateNode}
            onPreviewImage={previewImage}
            onOpenReference={openReference}
            onLocateReference={locateInBoard}
            selectedNodeId={selectedNodeId}
            scrollRequest={scrollRequest}
            paused={!visible}
            dividedItems
            headerExtra={
              expandable ? <ExpandColumnButton column="image" onToggle={setExpandedColumn} /> : undefined
            }
          />
        );
      case 'video':
        return (
          <BoardColumn
            title="视频"
            titleSlot={titleSlot}
            items={filteredVideos}
            emptyText={videoFilter === 'all' ? '画布中还没有视频节点' : '没有匹配当前筛选的视频'}
            onOpen={openItem}
            onLocate={onLocateNode}
            onPreviewImage={previewImage}
            onOpenReference={openReference}
            onLocateReference={locateInBoard}
            selectedNodeId={selectedNodeId}
            scrollRequest={scrollRequest}
            paused={!visible}
            dividedItems
            headerExtra={
              <div className="flex items-center gap-1.5">
                {/* 三项并排改成下拉（用户要求，对标 liblib）：默认「全部」，展开才看到
                    成片/片段。菜单右对齐——触发器在栏头右上角，左对齐会顶出栏外。 */}
                <BoardSelect
                  value={videoFilter}
                  options={VIDEO_FILTERS}
                  onSelect={setVideoFilter}
                  menuLabel="筛选视频"
                  menuClassName="right-0"
                  triggerClassName="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[12px] text-white/80 transition-colors hover:bg-white/[0.08] hover:text-white"
                />
                {expandable && <ExpandColumnButton column="video" onToggle={setExpandedColumn} />}
              </div>
            }
          />
        );
    }
  };

  // 放大态的宽幅网格：只留缩略图 + 标题（徽标/参考素材那些细节留给窄栏与详情），
  // 一屏能扫到更多素材。点卡片照常开详情。
  const renderExpandedColumn = (column: 'image' | 'video'): ReactElement => {
    const items = column === 'image' ? board.image : filteredVideos;
    return (
      <AssetBoardColumn
        title={column === 'image' ? '图片' : '视频'}
        count={items.length}
        emptyText={
          column === 'image'
            ? '画布中还没有图片节点'
            : videoFilter === 'all'
              ? '画布中还没有视频节点'
              : '没有匹配当前筛选的视频'
        }
        headerExtra={
          <div className="flex items-center gap-1.5">
            {column === 'video' && (
              <BoardSelect
                value={videoFilter}
                options={VIDEO_FILTERS}
                onSelect={setVideoFilter}
                menuLabel="筛选视频"
                menuClassName="right-0"
                triggerClassName="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[12px] text-white/80 transition-colors hover:bg-white/[0.08] hover:text-white"
              />
            )}
            <ExpandColumnButton column={column} expanded onToggle={setExpandedColumn} />
          </div>
        }
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-4 gap-y-5 px-2 py-1">
          {items.map((item) => (
            <AssetBoardGridCard
              key={item.nodeId}
              item={item}
              onOpen={openItem}
              scrollTargetToken={
                scrollRequest && scrollRequest.nodeId === item.nodeId ? scrollRequest.token : null
              }
            />
          ))}
        </div>
      </AssetBoardColumn>
    );
  };

  return (
    <div
      aria-hidden={!visible}
      className={cn(
        // pt-12: 给 Shell 顶部居中的视图切换开关(top-1.5, h-8 → 底沿距根顶 38px)留空间。
        // 取 48px 让内容与开关只隔 ~10px（原 pt-16=64px 会空出 26px，用户嫌太远）。
        // pb-0: 三栏面板贴到底部、与任务中心状态栏之间不留空隙（对标 liblib，
        // 栏壳底部配 rounded-b-none 直角贴边，见 AssetBoardColumn）。
        // 根背景保持语义 token bg-background：比 #262626 面板更暗，让三栏/音频条
        // 呈现"浮起"的层次（面板色见 AssetBoardColumn 与下方音频条）。
        'absolute inset-0 z-30 flex flex-col gap-3 bg-background px-4 pt-12 pb-0',
        visible ? 'visible' : 'invisible',
      )}
    >
      {/* 三栏总览态：关键元素栏横在最上方通栏（对标 liblib「关键元素 · 全部 ▾ 音频」）。
          详情态/放大态它改挂到左列里，把右半边整个让给详情面板或宽幅网格。 */}
      {activeDetail === null && expandedColumn === null && keyElementsBar}

      {activeDetail !== null ? (
        // 主从布局：右 = 详情面板；左 = 关键元素栏 + 可切换的窄列表（文本/图片/视频下拉）。
        // 四类详情（文本/图片/视频/音频）统一走这一套：音频的切换器已并入关键元素栏的
        // 音频标签，音频详情左栏默认落到文本栏（leftListColumn 同步见上方）。
        // 详情优先于放大态——放大态点开卡片走这里，关掉详情仍回到放大的网格。
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="flex w-[340px] shrink-0 flex-col gap-3">
            {/* 详情态关键元素栏缩进左列（用户要求，对标 liblib）：右半边从顶到底
                都是详情面板，媒体区能吃到的高度也跟着变多。 */}
            {keyElementsBar}
            {renderBoardColumn(
              leftListColumn,
              <LeftColumnSwitcher current={leftListColumn} onSelect={setLeftListColumn} />,
            )}
          </div>
          <AssetBoardDetail
            visible={visible}
            nodeId={activeDetail.nodeId}
            item={activeItem}
            onBack={detailBack}
            onClose={detailClose}
            onOpenReference={openReference}
            onLocateReference={locateInBoard}
            onZoomImage={previewImage}
            onOpenNode={openNodeDetail}
          />
        </div>
      ) : expandedColumn !== null ? (
        // 放大态：左边只留关键元素栏 + 文本栏，右半边整个给被放大的那栏（宽幅网格）。
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="flex w-[340px] shrink-0 flex-col gap-3">
            {keyElementsBar}
            {renderBoardColumn('text')}
          </div>
          {renderExpandedColumn(expandedColumn)}
        </div>
      ) : (
        // 三栏可拖拽调宽：分隔条拖动改各栏占比，松手落库（AssetBoardColumns）。
        <AssetBoardColumns
          text={renderBoardColumn('text')}
          image={renderBoardColumn('image', undefined, { expandable: true })}
          video={renderBoardColumn('video', undefined, { expandable: true })}
        />
      )}

      <ImageViewerModal
        open={viewer !== null}
        imageUrl={displayViewer ? (displayViewer.urls[displayViewer.index] ?? displayViewer.urls[0] ?? '') : ''}
        imageList={displayViewer ? displayViewer.urls : []}
        currentIndex={displayViewer ? displayViewer.index : 0}
        onClose={() => setViewer(null)}
        onNavigate={(direction) =>
          setViewer((current) => {
            if (current === null) return current;
            const next = direction === 'next' ? current.index + 1 : current.index - 1;
            // 边界钳制而非取模回绕：与 ImageViewerModal 自身在 index 0/末尾
            // 禁用 prev/next 按钮的行为保持一致（对齐 CanvasHistoryAssetsModal）。
            if (next < 0 || next >= current.urls.length) return current;
            return { ...current, index: next };
          })
        }
      />
    </div>
  );
}

interface BoardColumnProps {
  title: string;
  items: AssetBoardItem[];
  emptyText: string;
  headerExtra?: ReactNode;
  /** 替换默认标题的自定义节点（详情态左窄列表传入切栏下拉，见 LeftColumnSwitcher）。 */
  titleSlot?: ReactNode;
  onOpen: (item: AssetBoardItem) => void;
  onLocate: (nodeId: string) => void;
  onPreviewImage: (url: string) => void;
  /** 参考素材 hover「编辑」→ 打开被引用节点详情。 */
  onOpenReference: (ref: AssetBoardReference) => void;
  /** 参考素材 hover「定位」→ 滚到被引用节点的卡片并高亮。 */
  onLocateReference: (nodeId: string) => void;
  /** 主从模式下当前详情项的 nodeId（窄列表选中高亮）。 */
  selectedNodeId?: string;
  /** 「定位」滚动请求（{ nodeId, token }）：命中的卡片滚进视野并短暂高亮，其余卡片恒 null。 */
  scrollRequest?: { nodeId: string; token: number } | null;
  /** 条目间加极淡分隔线（目前仅视频栏对齐 liblib 参考图使用）。 */
  dividedItems?: boolean;
  /** 故事板整体不可见（保活隐藏）：卡片停掉生成进度轮询。 */
  paused?: boolean;
}

// 内部薄封装：把 items 铺进栏壳，避免三栏重复 JSX。
function BoardColumn({
  title,
  items,
  emptyText,
  headerExtra,
  titleSlot,
  onOpen,
  onLocate,
  onPreviewImage,
  onOpenReference,
  onLocateReference,
  selectedNodeId,
  scrollRequest,
  dividedItems,
  paused,
}: BoardColumnProps) {
  return (
    <AssetBoardColumn
      title={title}
      count={items.length}
      emptyText={emptyText}
      headerExtra={headerExtra}
      titleSlot={titleSlot}
      dividedItems={dividedItems}
    >
      {items.map((item) => (
        <MemoAssetBoardCard
          key={item.nodeId}
          item={item}
          onOpen={onOpen}
          onLocate={onLocate}
          onPreviewImage={onPreviewImage}
          onOpenReference={onOpenReference}
          onLocateReference={onLocateReference}
          selected={item.nodeId === selectedNodeId}
          paused={paused}
          // 只有被定位的那张卡拿到非 null 令牌，其余恒 null（memo 稳定，不被逐次定位打断）。
          scrollTargetToken={
            scrollRequest && scrollRequest.nodeId === item.nodeId ? scrollRequest.token : null
          }
        />
      ))}
    </AssetBoardColumn>
  );
}

type LeftColumn = 'text' | 'image' | 'video';

const LEFT_COLUMN_OPTIONS: ReadonlyArray<{ value: LeftColumn; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
];

/**
 * 栏头右上角的「放大 / 收起」按钮：把图片或视频栏摊成右半边的宽幅网格，再点收回
 * 三栏（对标 liblib）。放大态左边只留关键元素栏与文本栏。
 */
function ExpandColumnButton({
  column,
  expanded = false,
  onToggle,
}: {
  column: 'image' | 'video';
  expanded?: boolean;
  onToggle: (column: 'image' | 'video' | null) => void;
}): ReactElement {
  const label = expanded ? '收起' : '放大';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={expanded}
      onClick={() => onToggle(expanded ? null : column)}
      className="rounded-md p-1 text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white"
    >
      {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
    </button>
  );
}

/**
 * 放大态网格里的一张卡：缩略图 + 标题，点开详情。刻意比 AssetBoardCard 精简——
 * 网格一屏铺十几张，再带上徽标/参考素材行就没有「一眼扫完」的效果了。
 */
function AssetBoardGridCard({
  item,
  onOpen,
  scrollTargetToken = null,
}: {
  item: AssetBoardItem;
  onOpen: (item: AssetBoardItem) => void;
  /** 「定位」滚动令牌：与卡片同款语义（非 null 即滚进视野并短暂高亮）。 */
  scrollTargetToken?: number | null;
}): ReactElement {
  const cardRef = useRef<HTMLButtonElement | null>(null);
  const [locateHighlighted, setLocateHighlighted] = useState(false);
  // 与 AssetBoardCard 同一套：令牌变化 → 滚进视野 + 亮一下；回 null → 清高亮。
  // 网格态也要接，否则详情里点参考素材的「定位」在放大态是静默无反应的。
  useEffect(() => {
    if (scrollTargetToken === null) {
      setLocateHighlighted(false);
      return;
    }
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setLocateHighlighted(true);
    const timer = setTimeout(() => setLocateHighlighted(false), GRID_LOCATE_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [scrollTargetToken]);

  return (
    <button
      ref={cardRef}
      type="button"
      onClick={() => onOpen(item)}
      title={item.title}
      data-locate-highlight={locateHighlighted ? 'true' : undefined}
      // min-w-0：标题用 truncate 需要可收缩的容器，否则超长标题（视频标题常是整段
      // 提示词）配 white-space:nowrap 会把 grid item 撑出轨道、盖住相邻卡片。
      className={cn(
        'group flex min-w-0 flex-col gap-1.5 rounded-lg text-left',
        locateHighlighted && 'animate-pulse ring-2 ring-primary',
      )}
    >
      <span className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-[#141414] ring-1 ring-inset ring-transparent transition-[box-shadow] group-hover:ring-white/20">
        {item.column === 'video' ? (
          // 视频走与常规卡片同一份缩略图逻辑：没封面时用 <video> 取首帧，
          // 否则大量没记封面的视频在网格里全是黑框。
          <VideoThumb item={item} />
        ) : item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt=""
            loading="lazy"
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : (
          <ImageIcon className="h-6 w-6 text-muted-foreground" />
        )}
        {item.column === 'video' && item.videoRole === 'final' && (
          <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-0.5 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur-sm">
            成片
          </span>
        )}
        {item.column === 'video' && (item.thumbnailUrl || item.mediaUrl) && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm">
              <Play className="h-4 w-4 fill-white text-white" />
            </span>
          </span>
        )}
      </span>
      <span className="w-full truncate text-[12px] text-white/60 transition-colors group-hover:text-white/90">
        {item.title}
      </span>
    </button>
  );
}

/**
 * 故事板里的小型选择下拉（左窄列表的「文本/图片/视频」切栏、视频栏的「全部/成片/片段」
 * 筛选共用）：触发器显示当前项 + ⌄，点击展开菜单，当前项打勾（lucide Check）。
 *
 * 交互按需求「点击展开即可（不必 hover）」：click 切换开合；点击外部（焦点离开 wrapper）
 * 或 Esc 收起（对齐 AssetBoardDetailToolbar / 参考素材菜单的 onBlur/Esc 收起惯例）。
 * 样式对齐本分支体系（面板 rounded-lg、项 hover bg-white/5）；触发器外观由调用方给，
 * 因为两处一个是栏标题、一个是右上角的小筛选胶囊。
 */
function BoardSelect<T extends string>({
  value,
  options,
  onSelect,
  menuLabel,
  triggerClassName,
  menuClassName,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onSelect: (value: T) => void;
  /** 菜单的可及名称（读屏与测试用它定位这一组）。 */
  menuLabel: string;
  triggerClassName: string;
  menuClassName?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const currentLabel = options.find((option) => option.value === value)?.label ?? '';

  const handleBlur = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    // 焦点整体离开 wrapper（下一焦点不在内）→ 收起（点击外部/Tab 走开）。
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setOpen(false);
    }
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation(); // 不让 Esc 冒泡去关整个详情面板。
        setOpen(false);
        triggerRef.current?.focus();
      }
    },
    [open],
  );

  return (
    <div className="relative" onBlur={handleBlur} onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className={triggerClassName}
      >
        {currentLabel}
        <ChevronDown
          className={cn('h-3.5 w-3.5 text-white/40 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={menuLabel}
          className={cn(
            'absolute top-full z-50 mt-1.5 min-w-[140px] rounded-lg border border-white/10 bg-[#2e2e2e] p-1 text-white/85 shadow-xl',
            menuClassName ?? 'left-0',
          )}
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onSelect(option.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-white/5 hover:text-white',
                  active ? 'text-white' : 'text-white/80',
                )}
              >
                <Check
                  className={cn('h-3.5 w-3.5 shrink-0', active ? 'opacity-100' : 'opacity-0')}
                />
                <span className="flex-1">{option.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 详情态左窄列表头部的「文本/图片/视频」切换下拉（切栏只改左列表，右侧详情不受影响）。 */
function LeftColumnSwitcher({
  current,
  onSelect,
}: {
  current: LeftColumn;
  onSelect: (column: LeftColumn) => void;
}): ReactElement {
  return (
    <BoardSelect
      value={current}
      options={LEFT_COLUMN_OPTIONS}
      onSelect={onSelect}
      menuLabel="切换栏目"
      triggerClassName="-mx-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm font-medium text-foreground transition-colors hover:bg-white/5"
    />
  );
}
