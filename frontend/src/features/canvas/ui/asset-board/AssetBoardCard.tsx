// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { AlertCircle, ChevronRight, FileText, MapPin, ImageIcon, Loader2, Play } from 'lucide-react';

import {
  modelBadgeLabel,
  type AssetBoardColumn,
  type AssetBoardItem,
  type AssetBoardReference,
} from '@/features/canvas/domain/assetBoard';
import { AddNodeToChatIconButton } from '@/features/canvas/ui/AddNodeToChatButton';
import { cn } from '@/lib/utils';

import { useEstimatedProgress } from '../useEstimatedProgress';
import { AssetBoardReferenceThumbMenu } from './AssetBoardReferenceThumbMenu';
import { writeBoardReferenceDragPayload } from './boardReferenceDrag';

interface AssetBoardCardProps {
  item: AssetBoardItem;
  /** 点击卡片主体（打开预览）。 */
  onOpen: (item: AssetBoardItem) => void;
  /** 「在画布中定位」——切回工作流并聚焦节点。 */
  onLocate: (nodeId: string) => void;
  /** 点击参考素材缩略图 → 灯箱预览该图。 */
  onPreviewImage: (url: string) => void;
  /** 参考素材 hover「编辑」→ 打开被引用节点的详情，用户在那里改（与详情面板同语义）。 */
  onOpenReference?: (ref: AssetBoardReference) => void;
  /** 参考素材 hover「定位」→ 把故事板列表滚到被引用节点的卡片处并高亮（非画布定位）。 */
  onLocateReference?: (nodeId: string) => void;
  /** 主从模式左侧窄列表里的选中项高亮。 */
  selected?: boolean;
  /** 故事板整体不可见（保活隐藏）：停掉生成进度的轮询，别在后台空转。 */
  paused?: boolean;
  /**
   * 「定位」滚动请求令牌：当详情里的参考素材点「定位」、且本卡片正是被引用节点时，
   * 父级把一个单调自增的令牌透传给这张卡（其余卡片恒为 null，保持 memo 不被打断）。
   * 令牌每次变化（含重复定位同一节点）→ 卡片滚动进视野并短暂高亮；null → 清掉高亮。
   */
  scrollTargetToken?: number | null;
}

/** 「定位」高亮的持续时长（毫秒）：边框脉冲一下即收，只为把视线引到卡片。 */
const LOCATE_HIGHLIGHT_MS = 1200;

/**
 * 媒体空态文案：节点还没出图/出片（参数、提示词已就位，等用户在生成条上确认提交）。
 * 图片与视频、卡片与详情四处共用同一句，避免有的地方有说明、有的地方只有灰图标。
 */
export const EMPTY_MEDIA_PLACEHOLDER_TEXT = '待确认后生成';

/**
 * 各栏生成耗时的经验预估（毫秒）——不是后端真实进度，后端不下发逐步进度事件，
 * 这里只是给 useEstimatedProgress 的时间线性插值一个量级参考：图片最快、视频
 * 最慢，文本（脚本/分镜表等）介于两者之间偏快。用户如果对某栏的观感耗时有
 * 更准的数字，改这张表即可，不影响估算算法本身。
 */
const ESTIMATED_GENERATION_DURATION_MS: Record<AssetBoardColumn, number> = {
  text: 10_000,
  image: 20_000,
  audio: 30_000,
  video: 60_000,
};

/** 供 AssetBoardDetail 等其它文件复用同一份预估时长（保持卡片与详情口径一致）。 */
export function estimatedGenerationDurationMs(column: AssetBoardColumn): number {
  return ESTIMATED_GENERATION_DURATION_MS[column];
}

/**
 * 「生成中 X%...」小标签：X 由 useEstimatedProgress 按 generationStartedAt + 上表
 * 预估时长做时间估算（非后端真实进度）。拆成独立子组件是为了让 120ms 轮询
 * 定时器只在卡片真正处于生成中时才挂载——非生成态的卡片不会被这条 effect
 * 拖慢（AssetBoardCard 按 item.isGenerating 条件渲染它）。
 * className 可覆盖默认样式：媒体卡把进度叠在缩略图蒙层上（大一号、白 85%），
 * 文本卡没有媒体区，退回标题行内联小标签（默认样式）。
 */
function GeneratingLabel({
  item,
  className,
  paused,
}: {
  item: AssetBoardItem;
  className?: string;
  /** 故事板被保活隐藏时停表（见 useEstimatedProgress 的 paused 说明）。 */
  paused?: boolean;
}): ReactElement {
  const percent = useEstimatedProgress(
    item.generationStartedAt,
    estimatedGenerationDurationMs(item.column),
    paused,
  );
  return <span className={cn('text-[11px] text-white/40', className)}>{`生成中 ${percent}%...`}</span>;
}

// 时长/分辨率徽标：胶囊形 + 细边框 + 极淡底色，对齐 liblib 参考图。
// 「成片」不再走这里——它挪到视频缩略图左上角做叠加角标（见下方 VideoThumb 调用处）。
// AssetBoardDetail 的徽标行复用同一枚 Chip（导出）。
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] leading-4 text-white/70">
      {children}
    </span>
  );
}

/**
 * 视频缩略图：有封面用封面，没封面用 <video preload="metadata"> 取首帧（#t=0.1）。
 * 导出给放大态的网格卡复用——大量视频节点没记封面，只认 thumbnailUrl 的话满屏
 * 都是黑框（用户反馈）。
 */
export function VideoThumb({ item }: { item: AssetBoardItem }) {
  if (item.thumbnailUrl) {
    return <img src={item.thumbnailUrl} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />;
  }
  if (item.mediaUrl) {
    return (
      <video
        src={`${item.mediaUrl}#t=0.1`}
        preload="metadata"
        muted
        playsInline
        draggable={false}
        className="h-full w-full object-cover"
      />
    );
  }
  // 既无封面也无片源 = 还没生成的空视频节点：与图片空态一样明说「待确认后生成」，
  // 而不是一个没有说明的灰图标（详情里那条视频生成表单就是它的确认入口）。
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Play className="h-6 w-6 text-muted-foreground" />
      <span className="text-[11px] text-muted-foreground">{EMPTY_MEDIA_PLACEHOLDER_TEXT}</span>
    </div>
  );
}

export function AssetBoardCard({
  item,
  onOpen,
  onLocate,
  onPreviewImage,
  onOpenReference,
  onLocateReference,
  selected = false,
  paused = false,
  scrollTargetToken = null,
}: AssetBoardCardProps): ReactElement {
  const cardRef = useRef<HTMLDivElement | null>(null);
  // 缩略图容器：拖拽时用它当自定义拖拽虚影，只显示内容缩略图，不带标题/参考素材面板。
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const [locateHighlighted, setLocateHighlighted] = useState(false);
  // 图片实际加载出来的原始尺寸：只在节点没记 widthPx/heightPx 时兜底分辨率徽标。
  // 带 url 一起存，换图（同一张卡换节点/换结果）后旧尺寸立即失效，不会串号。
  const [loadedSize, setLoadedSize] = useState<{
    url: string;
    width: number;
    height: number;
  } | null>(null);
  const naturalSize =
    loadedSize && loadedSize.url === item.thumbnailUrl ? loadedSize : null;
  // 节点已记尺寸就不必读图（也就不挂 ref/onLoad）。
  const needsNaturalSize = item.widthPx === null || item.heightPx === null;
  // ref 与 onLoad 两条路都走：新图走 onLoad；已在缓存里的图挂载时就 complete 了，
  // load 事件不会再来，只能在 ref 回调里当场读。相同 url 返回原 state，React 直接
  // bail out，不会因为 ref 每次渲染都调用而反复重渲。
  const captureNaturalSize = useCallback((img: HTMLImageElement | null) => {
    if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return;
    const url = img.getAttribute('src') ?? '';
    setLoadedSize((prev) =>
      prev && prev.url === url && prev.width === img.naturalWidth
        ? prev
        : { url, width: img.naturalWidth, height: img.naturalHeight },
    );
  }, []);

  // 「定位」滚动 + 高亮：令牌非 null（本卡是被引用节点）→ 滚进视野、亮一下再收；
  // 令牌回到 null（定位切到别的卡片）→ 立即清掉本卡的残留高亮。effect 依赖
  // 只有令牌，非目标卡片恒 null，不会因为无关重渲染反复触发。
  useEffect(() => {
    if (scrollTargetToken === null) {
      setLocateHighlighted(false);
      return;
    }
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setLocateHighlighted(true);
    const timer = setTimeout(() => setLocateHighlighted(false), LOCATE_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [scrollTargetToken]);

  const isFinalVideo = item.column === 'video' && item.videoRole === 'final';
  const badges: ReactElement[] = [];
  // 模型只在视频卡显示，且只在节点确实记了模型时显示（上传/剪辑出来的视频没有
  // model 字段 → 不占位）。图片卡按用户要求只留分辨率，不挂模型。
  if (item.column === 'video' && item.model) {
    badges.push(
      <Chip key="model">
        <span className="max-w-[160px] truncate" title={item.model}>
          {modelBadgeLabel(item.model)}
        </span>
      </Chip>,
    );
  }
  if (item.durationSec !== null) badges.push(<Chip key="dur">{`${item.durationSec}秒`}</Chip>);
  // 分辨率优先用节点记的尺寸；上传图等没记尺寸的节点退回图片实际加载出来的
  // 原始尺寸（卡片展示的就是原图，naturalWidth 即真实分辨率）。
  // 整对取舍而不是逐项回退：半残数据（只记了 widthPx）逐项回退会把存储的宽配上
  // 探测的高，拼出一个两边都不对的尺寸。
  const hasStoredSize = item.widthPx !== null && item.heightPx !== null;
  const width = hasStoredSize ? item.widthPx : (naturalSize?.width ?? null);
  const height = hasStoredSize ? item.heightPx : (naturalSize?.height ?? null);
  if (width !== null && height !== null) {
    badges.push(<Chip key="dim">{`${width} × ${height}`}</Chip>);
  }

  // hover 用低透明度白而非 border-border/bg-muted：语义 token 在 #262626 面板上
  // 呈现为刺眼浅色描边，这里对标 liblib 的柔和高亮。
  return (
    <div
      ref={cardRef}
      data-locate-highlight={locateHighlighted ? 'true' : undefined}
      onClick={() => onOpen(item)}
      // 整张卡片作拖拽源：拖进详情生成表单的参考区 → 把本节点接成当前详情节点的上游
      // 引用（AssetBoardReferenceDropZone 落 addEdge）。payload 只带 nodeId（既有节点，
      // 非新建）；内部 <img>/<video> 设 draggable=false，保证拖拽从卡片本体发起而不是
      // 变成浏览器默认的图片拖拽。点击语义不受影响（无位移的点击不触发 dragstart）。
      draggable
      onDragStart={(event) => {
        writeBoardReferenceDragPayload(event.dataTransfer, { nodeId: item.nodeId });
        // 自定义拖拽虚影：只截缩略图那块，而不是浏览器默认的「整张卡截图」（会把标题、
        // 徽标、参考素材面板一起带上）。偏移钳到缩略图范围内，保证光标始终落在虚影上。
        // 文本卡没有缩略图容器（thumbRef 为空）→ 保持默认整卡虚影。
        const thumb = thumbRef.current;
        if (thumb) {
          const rect = thumb.getBoundingClientRect();
          const offsetX = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
          const offsetY = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);
          event.dataTransfer.setDragImage(thumb, offsetX, offsetY);
        }
      }}
      className={cn(
        'group relative flex cursor-pointer flex-col gap-2 rounded-md border p-2 transition-colors',
        // hover 反馈分栏（用户要求）：
        // - 文本卡是一行行的列表，整行浅底 + 描边就是标准列表手感，保留；
        // - 图片/视频卡整块几乎都是媒体，再罩一层灰底会变成一大块脏灰板（尤其
        //   分割线加上之后），所以卡片本体不动，反馈只落在媒体区（见下方 ring）
        //   和标题提亮上。
        selected
          ? 'border-white/10 bg-white/[0.06]'
          : cn(
              'border-transparent',
              item.column === 'text' && 'hover:border-white/10 hover:bg-white/[0.04]',
            ),
        // 「定位」命中：青色 ring + 脉冲，短暂把视线引到这张卡（LOCATE_HIGHLIGHT_MS 后收）。
        locateHighlighted && 'animate-pulse ring-2 ring-primary',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {/* 标题色分栏（用户拍板）：文本卡纯白（连同文件图标，去掉自己的 muted 色继承白），
            图片/视频卡走灰——它们下面就是缩略图，标题只作次级说明。 */}
        <div
          className={cn(
            'flex min-w-0 items-center gap-1.5 text-[13px] transition-colors',
            // 图片/视频卡的标题平时压到 60% 灰（下面就是缩略图，标题只作次级说明），
            // hover 提亮，与媒体区的描边一起构成「这张卡被指到了」。
            item.column === 'text' ? 'text-white' : 'text-white/60 group-hover:text-white/90',
          )}
        >
          {item.column === 'text' && <FileText className="h-3.5 w-3.5 shrink-0" />}
          <button
            type="button"
            className="min-w-0 truncate text-left"
            onClick={(event) => {
              event.stopPropagation();
              onOpen(item);
            }}
          >
            {item.title}
          </button>
          {/* 文本卡没有媒体区，生成进度只能挂在标题行；图片/视频卡的进度改叠到
              下方缩略图蒙层上（不再跟在标题后面，见媒体区 isGenerating 分支）。 */}
          {item.column === 'text' && item.isGenerating && (
            <GeneratingLabel item={item} className="shrink-0" paused={paused} />
          )}
          {/* 文本卡没有媒体区可挂失败角标（script 等也会带 generationError）——
              在标题旁给内联小指示，媒体卡仍走下方媒体区角标。 */}
          {item.column === 'text' && !item.isGenerating && item.generationError && (
            <span
              title={item.generationError}
              className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-red-400"
            >
              <AlertCircle className="h-3 w-3" />
              失败
            </span>
          )}
        </div>
        {/* 悬停才浮出的卡片动作组。故事板和画布是同一份节点数据的两种投影，
            「添加到对话」的行为必须一致——所以直接用共用组件（发事件、由 FreezoneShell
            统一落地选中 + 展开聊天），只把样式换成本视图的图标按钮语言。 */}
        <div className="invisible flex shrink-0 items-center gap-0.5 group-hover:visible group-focus-within:visible">
          <AddNodeToChatIconButton
            nodeId={item.nodeId}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            iconClassName="h-3.5 w-3.5"
          />
          <button
            type="button"
            aria-label="在画布中定位"
            title="在画布中定位"
            onClick={(event) => {
              event.stopPropagation();
              onLocate(item.nodeId);
            }}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <MapPin className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 文本卡只显示图标 + 标题（上方标题行），正文不进列表——去详情里看（用户要求）。 */}
      {item.column === 'text' ? null : (
        <div
          ref={thumbRef}
          // hover 时媒体区套一圈内描边（不改底色、不缩放）——反馈落在内容本身，
          // 比整卡刷灰底克制得多。
          className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-[#141414] ring-1 ring-inset ring-transparent transition-[box-shadow] group-hover:ring-white/20"
        >
          {item.column === 'video' ? (
            <>
              <VideoThumb item={item} />
              {isFinalVideo && (
                <span className="absolute left-1.5 top-1.5 z-10 inline-flex items-center gap-0.5 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur-sm">
                  成片
                  <ChevronRight className="h-3 w-3" />
                </span>
              )}
              {(item.thumbnailUrl || item.mediaUrl) && (
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm">
                    <Play className="h-4 w-4 fill-white text-white" />
                  </span>
                </span>
              )}
            </>
          ) : item.thumbnailUrl ? (
            <img
              src={item.thumbnailUrl}
              alt=""
              loading="lazy"
              draggable={false}
              ref={needsNaturalSize ? captureNaturalSize : undefined}
              onLoad={
                needsNaturalSize ? (event) => captureNaturalSize(event.currentTarget) : undefined
              }
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex flex-col items-center gap-1.5">
              <ImageIcon className="h-6 w-6 text-muted-foreground" />
              <span className="text-[11px] text-muted-foreground">
                {EMPTY_MEDIA_PLACEHOLDER_TEXT}
              </span>
            </div>
          )}
          {/* 生成中：遮罩 + 居中 spinner + 「生成中 X%...」进度（盖过播放按钮等叠层，
              z 最高）。进度直接叠在卡片缩略图上，不再跟在节点标题后面。
              底下有媒体（重新生成）才用半透明——让用户还看得见正在被替换的那张；
              底下是空态占位（首次生成）时遮罩必须不透明，否则「待确认后生成」的
              图标与文案会从遮罩后透出来，跟 spinner、百分比叠成一团糊字。 */}
          {item.isGenerating && (
            <span
              role="status"
              aria-label="生成中"
              className={cn(
                'absolute inset-0 z-20 flex flex-col items-center justify-center gap-1.5',
                item.thumbnailUrl || item.mediaUrl ? 'bg-black/50' : 'bg-[#141414]',
              )}
            >
              <Loader2 className="h-5 w-5 animate-spin text-white" />
              <GeneratingLabel item={item} className="text-[12px] text-white/85" paused={paused} />
            </span>
          )}
          {/* 失败角标：非生成中才显示（重试中以 spinner 为准），hover 看错误全文。 */}
          {!item.isGenerating && item.generationError && (
            <span
              title={item.generationError}
              className="absolute left-1.5 top-1.5 z-20 inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-400 backdrop-blur-sm"
            >
              <AlertCircle className="h-3 w-3" />
              失败
            </span>
          )}
        </div>
      )}

      {badges.length > 0 && <div className="flex flex-wrap gap-1">{badges}</div>}

      {item.references.length > 0 && (
        // 参考素材：不描边框、不铺底色（用户要求），仅靠上边距 + 「参考素材」标题
        // 与上方内容图区隔。
        <div className="mt-3 flex flex-col gap-1.5">
          {/* 不再写「参考素材」标题——缩略图本身已足够表意（用户要求）。 */}
          <div className="flex flex-wrap gap-1">
            {item.references.map((ref) => {
              const refNodeId = ref.nodeId;
              // 无参考回调（如详情左侧窄列表这种纯导航场景）→ 退回「点开灯箱」的
              // 光缩略图，不挂菜单。
              if (!onOpenReference) {
                return (
                  <button
                    key={refNodeId ?? `own:${ref.thumbnailUrl}`}
                    type="button"
                    aria-label={ref.label}
                    title={ref.label}
                    onClick={(event) => {
                      event.stopPropagation();
                      onPreviewImage(ref.thumbnailUrl);
                    }}
                    // 圆角 5px：3px 近乎直角偏硬，8px(rounded-lg) 又过圆；取 5px 有一点柔和
                    // 圆角但不发圆，是用户拍板的手感。
                    className="h-10 w-10 shrink-0 overflow-hidden rounded-[5px] border border-border"
                  >
                    <img src={ref.thumbnailUrl} alt={ref.label} loading="lazy" draggable={false} className="h-full w-full object-cover" />
                  </button>
                );
              }
              return (
                <AssetBoardReferenceThumbMenu
                  // 自带参考图 nodeId=null（无上游节点），用 url 兜底 key。
                  key={refNodeId ?? `own:${ref.thumbnailUrl}`}
                  reference={ref}
                  onEdit={() => onOpenReference(ref)}
                  // 自带图无处可定位（无对应画布节点/卡片）→ 不给「定位」项。
                  onLocate={
                    onLocateReference && refNodeId ? () => onLocateReference(refNodeId) : null
                  }
                  // 卡片里的参考缩略图 40px（详情是 48px）；点击仍是开灯箱看大图，
                  // 编辑/定位交给 hover 出的菜单。
                  className="h-10 w-10 rounded-[5px]"
                  onThumbClick={() => onPreviewImage(ref.thumbnailUrl)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
