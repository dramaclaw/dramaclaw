// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, type ReactElement, type RefObject } from 'react';
import { ChevronLeft, Copy, ImageIcon, Loader2, Music, Play, Trash2, X } from 'lucide-react';

import type {
  AssetBoardColumn,
  AssetBoardItem,
  AssetBoardReference,
} from '@/features/canvas/domain/assetBoard';
import {
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isVideoNode,
  type AudioNodeData,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { AddNodeToChatIconButton } from '@/features/canvas/ui/AddNodeToChatButton';
import { AudioWaveformPlayer } from '@/features/canvas/ui/AudioWaveformPlayer';
import { useEstimatedProgress } from '@/features/canvas/ui/useEstimatedProgress';
import { cn } from '@/lib/utils';
import { useCanvasStore } from '@/stores/canvasStore';

import { AssetBoardAudioGenForm } from './AssetBoardAudioGenForm';
import { Chip, EMPTY_MEDIA_PLACEHOLDER_TEXT, estimatedGenerationDurationMs } from './AssetBoardCard';
import {
  AssetBoardImageDetailToolbar,
  AssetBoardVideoDetailToolbar,
  DetailMoreMenu,
  hasImageDetailActions,
  hasVideoDetailActions,
  keyElementMenuEntry,
} from './AssetBoardDetailToolbar';
import { AssetBoardDetailTextSection } from './AssetBoardDetailTextSection';
import { AssetBoardImageGenForm } from './AssetBoardImageGenForm';
import { AssetBoardUpscaleForm } from './AssetBoardUpscaleForm';
import { AssetBoardVideoGenForm } from './AssetBoardVideoGenForm';
import { AssetBoardPromptText } from './AssetBoardPromptText';
import { AssetBoardReferenceThumbMenu } from './AssetBoardReferenceThumbMenu';

interface AssetBoardDetailProps {
  /** 故事板整体可见性：false 时冻结 store 订阅并暂停详情内的视频播放（保活挂载）。 */
  visible: boolean;
  /** 当前详情的画布节点 id（原始节点直接从 store 取，不经 AssetBoardItem 扩字段）。 */
  nodeId: string;
  /** 对应的故事板条目（徽标/参考/媒体地址已由 buildAssetBoard 解析）；null → 节点已不存在。 */
  item: AssetBoardItem | null;
  /** ← 返回：详情栈非空时弹栈回上一个详情，否则关闭（由 AssetBoardView 决定）。 */
  onBack: () => void;
  /** × 关闭：清空详情栈回三栏。 */
  onClose: () => void;
  /** 参考素材菜单「编辑」→ 跨栏 push 该节点详情（无详情可开时由父级退化为灯箱）。 */
  onOpenReference: (ref: AssetBoardReference) => void;
  /** 参考素材菜单「定位」→ 把故事板列表滚到该被引用节点的卡片处并高亮（非画布定位）。 */
  onLocateReference: (nodeId: string) => void;
  /** 点击大图 → 打开 ImageViewerModal 缩放查看。 */
  onZoomImage: (url: string) => void;
  /**
   * 「创建副本」建好新节点后把详情切过去。栏由这里给（副本与源同类型 → 同栏），
   * 父级不查表——刚建的节点还没进上一帧的索引。
   */
  onOpenNode: (nodeId: string, column: AssetBoardColumn) => void;
}

const HEADER_ICON_BUTTON_CLASS =
  'shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground';

function promptOf(node: CanvasNode): string | null {
  if (isImageGenNode(node) || isImageEditNode(node) || isVideoNode(node)) {
    const prompt = node.data.prompt;
    return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : null;
  }
  return null;
}

/** 图片高清结果节点：「编辑 → 高清」预建出来的 resultKind:'upscale' 占位/结果节点。 */
function isImageUpscaleNode(node: CanvasNode): boolean {
  return (
    isExportImageNode(node)
    && (node.data as { resultKind?: unknown }).resultKind === 'upscale'
  );
}

/**
 * 详情媒体区下方要挂哪种生成表单（null = 不挂，走只读展示）。
 *
 * 图片高清结果节点挂的是高清编辑器（模型/画质/放大倍数 + ↑），不是常规图片生成
 * 表单——它没有提示词，参数也持久化在自己的 node.data 上。
 *
 * 视频侧的排除项与工作流 VideoNode 的 `showVideoOpsPanel` 同口径：
 * - `videoCompose` 走剪辑合成，不是生成节点（isVideoNode 只认 video，天然不命中）；
 * - `referenceOnly`：资产库选进来的引用素材，本身不生成；
 * - `isUpscaleNode`：视频高清节点有自己的配置面板，不走常规生成表单。
 */
function generationFormKindOf(node: CanvasNode): 'image' | 'video' | 'upscale' | null {
  if (isImageGenNode(node)) return 'image';
  if (isImageUpscaleNode(node)) return 'upscale';
  if (isVideoNode(node)) {
    return node.data.referenceOnly || node.data.isUpscaleNode ? null : 'video';
  }
  return null;
}

function ReferencesRow({
  references,
  onOpenReference,
  onLocateReference,
}: {
  references: AssetBoardReference[];
  onOpenReference: (ref: AssetBoardReference) => void;
  onLocateReference: (nodeId: string) => void;
}) {
  if (references.length === 0) return null;
  // role=group + aria-label：给这一组一个可定位的容器，让「点参考缩略图」的
  // 编辑/定位交互有明确落点。底部行现在只在「无生成表单」的只读详情里渲染
  // （见 MediaBody 的 !showGenerationForm 守卫），不会再与生成表单的引用 chip
  // 并存，因此也不会出现同名缩略图两处歧义的问题。
  return (
    <div role="group" aria-label="参考素材" className="flex flex-col gap-1.5">
      <span className="text-[12px] text-white/40">参考素材</span>
      <div className="flex flex-wrap gap-2">
        {references.map((ref) => {
          const refNodeId = ref.nodeId;
          return (
            <AssetBoardReferenceThumbMenu
              // 自带参考图 nodeId=null（无上游节点），用 url 兜底 key；同一节点最多一张自带图，不会撞。
              key={refNodeId ?? `own:${ref.thumbnailUrl}`}
              reference={ref}
              onEdit={() => onOpenReference(ref)}
              // 自带图无处可定位（无对应画布节点/卡片）→ 不给「定位」项，而不是给一个点了没反应的。
              onLocate={refNodeId ? () => onLocateReference(refNodeId) : null}
            />
          );
        })}
      </div>
    </div>
  );
}

/** 图片/视频详情正文：大媒体 + 胶囊徽标 + 提示词 + 参考素材。 */
function MediaBody({
  item,
  node,
  videoRef,
  fill,
  onOpenReference,
  onLocateReference,
  onZoomImage,
}: {
  item: AssetBoardItem;
  node: CanvasNode;
  /** 视频元素引用：故事板隐藏时由 AssetBoardDetail 强制 pause（保活挂载）。 */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** 媒体撑满剩余高度、生成条钉底、整块不滚（见 AssetBoardDetail 的 mediaFillsBody）。 */
  fill: boolean;
  onOpenReference: (ref: AssetBoardReference) => void;
  onLocateReference: (nodeId: string) => void;
  onZoomImage: (url: string) => void;
}): ReactElement {
  const prompt = promptOf(node);
  // 图片/视频生成节点在详情里挂完整生成表单（空节点直接出图出片 / 已有产物改参数
  // 重生成）。表单自带提示词输入框，因此这类节点不再另渲染只读提示词块——同一段
  // prompt 出现两次（一个能编辑一个不能）会让人以为是两份数据。其余节点类型维持
  // 只读展示。
  const generationFormKind = generationFormKindOf(node);
  const showGenerationForm = generationFormKind !== null;
  // 时长/分辨率徽标只给没有生成表单的节点（上传视频、成片等）——挂了表单的节点，
  // 表单底部那行本来就写着「模型 · 16:9 · 720P · 4s」，正文再挂一个「4秒」是同一
  // 信息的第二份，且位置在表单下方更像是漏掉的碎片（用户要求去掉）。
  const badges: ReactElement[] = [];
  if (!showGenerationForm) {
    if (item.durationSec !== null) badges.push(<Chip key="dur">{`${item.durationSec}秒`}</Chip>);
    if (item.widthPx !== null && item.heightPx !== null) {
      badges.push(<Chip key="dim">{`${item.widthPx} × ${item.heightPx}`}</Chip>);
    }
  }

  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-3xl flex-col gap-4',
        // fill：不再限宽居中——媒体与生成条一起铺满面板（用户要求输入框占满面板，
        // 富余空间给内容区）；min-h-full 让内容超高时能被父级滚动兜住。
        fill && 'min-h-full max-w-none gap-3',
      )}
    >
      {/* 生成中：已有媒体（重新生成原地保留旧 url）只叠遮罩不换占位——用户正看
          的图不该在点「重新生成」的瞬间消失；仅首次生成（无 mediaUrl）用全占位。 */}
      <div
        className={cn(
          'flex items-center justify-center',
          // 媒体区吃掉剩余高度；min-h 是下限，矮视口下不会被生成条压没
          // （压到下限后由父级滚动兜底）。媒体自身按比例定宽、居中留边——生成条
          // 铺满面板，内容框不铺满（用户要求）。
          fill && 'min-h-[180px] flex-1',
        )}
      >
        {item.column === 'video' ? (
          item.mediaUrl ? (
            <div className={cn('relative', fill ? 'h-full' : 'w-full')}>
              <video
                ref={videoRef}
                src={item.mediaUrl}
                poster={item.thumbnailUrl ?? undefined}
                controls={!item.isGenerating}
                playsInline
                // fill：高度吃满这块区域，宽度由片子自身比例决定（w-auto + max-w-full
                // → 内容框不铺满面板、左右自然留边）；非 fill：正文可滚，用 62vh 兜高。
                className={cn(
                  'rounded-lg bg-black object-contain',
                  fill ? 'h-full w-auto max-w-full' : 'max-h-[62vh] w-full',
                )}
              />
              {item.isGenerating && <GeneratingOverlay />}
            </div>
          ) : (
            <MediaPlaceholder kind="video" item={item} fill={fill} />
          )
        ) : item.mediaUrl ? (
          <div className={cn('relative', fill && 'h-full')}>
            <button
              type="button"
              aria-label="放大查看"
              title="放大查看"
              disabled={item.isGenerating}
              onClick={() => onZoomImage(item.mediaUrl as string)}
              className={cn('cursor-zoom-in disabled:cursor-not-allowed', fill && 'block h-full')}
            >
              <img
                src={item.mediaUrl}
                alt={item.title}
                className={cn(
                  'rounded-lg object-contain',
                  fill ? 'h-full w-auto max-w-full' : 'max-h-[62vh] w-full',
                )}
              />
            </button>
            {item.isGenerating && <GeneratingOverlay />}
          </div>
        ) : (
          <MediaPlaceholder kind="image" item={item} fill={fill} />
        )}
      </div>

      {/* key={node.id}：切换详情项时强制换实例——表单持有 prompt 草稿 / 输入法合成态，
          复用同位实例会把 A 的草稿带进 B。
          与头部那条视频工具条（剪辑/高清/下载/全屏）分工明确：工具条只处理「已有片子」
          的后期操作，挂在头部；生成表单负责「再出一条」，挂在媒体区下方，两者不重叠。 */}
      {/* fill 布局下表单钉底不压缩：高度不够时先让上面的媒体区缩（shrink），
          而不是把生成条挤变形。 */}
      {generationFormKind === 'image' && (
        <div className={cn(fill && 'shrink-0')}>
          <AssetBoardImageGenForm key={node.id} nodeId={node.id} />
        </div>
      )}
      {generationFormKind === 'video' && (
        <div className={cn(fill && 'shrink-0')}>
          <AssetBoardVideoGenForm key={node.id} nodeId={node.id} />
        </div>
      )}
      {/* 高清结果节点：下方挂高清编辑器——「编辑 → 高清」建好节点就把详情切到这里，
          选完模型/画质/倍数按 ↑ 才提交（对标 liblib）。提交前媒体区是「待确认后生成」
          空态，不拿待放大的源图充数（见 isPendingUpscaleNode）。 */}
      {generationFormKind === 'upscale' && (
        <div className={cn(fill && 'shrink-0')}>
          <AssetBoardUpscaleForm key={node.id} nodeId={node.id} />
        </div>
      )}

      {badges.length > 0 && <div className="flex flex-wrap gap-1.5">{badges}</div>}

      {prompt && !showGenerationForm && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-white/40">提示词</span>
          {/* @图片N / @视频N / @音频N 渲染成带缩略图的只读 chip（hover 出大图），
              编号复用工作流那份映射；解析不到的引用原样留作纯文本。 */}
          <AssetBoardPromptText
            node={node}
            prompt={prompt}
            onOpenReference={(target) => {
              if (!target.nodeId || !target.thumbnailUrl) return;
              onOpenReference({
                nodeId: target.nodeId,
                label: target.label,
                thumbnailUrl: target.thumbnailUrl,
              });
            }}
          />
        </div>
      )}

      {/* 底部「参考素材」只读行只在无生成表单的详情里渲染（upload / imageEdit /
          exportImage / videoCompose 等只读节点——它们没有表单 chip 承载引用）。
          imageGen / video 生成节点的引用已由表单 chips 呈现：上游连线引用 → 表单
          chip；imageGen 自带 referenceImageUrl → 宿主 AssetBoardImageGenForm 里补的
          自带参考 chip。这里再渲一遍会与表单 chip 重复（image-cache/64、65 的重复
          即此），故用 !showGenerationForm 守卫收掉。 */}
      {!showGenerationForm && (
        <ReferencesRow
          references={item.references}
          onOpenReference={onOpenReference}
          onLocateReference={onLocateReference}
        />
      )}
    </div>
  );
}

/**
 * 音频详情正文：中间大波形播放器（AudioWaveformPlayer）+ 下方音频生成表单
 * （AssetBoardAudioGenForm）。空音频节点（无 audioUrl）中间显示占位、
 * 下方照旧挂表单，可从零生成，对齐图片/视频空节点体验。
 *
 * 波形不走 GeneratingOverlay + 已有 url 保留的那套（图片/视频「重新生成原地保留旧
 * 图」）：音频重生成拿到新 url 前旧音频仍能播，遮罩挡住播放反而更差；生成中反馈由
 * 表单自身的 spinner 承载。
 */
function AudioBody({
  item,
  node,
  visible,
  fill,
}: {
  item: AssetBoardItem;
  node: CanvasNode;
  /** 故事板整体可见性：false 时命令波形播放器暂停（保活隐藏，与视频同款处理）。 */
  visible: boolean;
  /** 内容区撑满剩余高度、生成条钉底铺满、整块不滚（与图片/视频详情同款）。 */
  fill: boolean;
}): ReactElement {
  const data = node.data as AudioNodeData;
  const audioUrl = item.mediaUrl;
  const durationMs =
    typeof data.durationMs === 'number' && data.durationMs > 0 ? data.durationMs : null;
  // 内容框：撑满剩余高度但宽度只占 3/4 居中（与视频详情一致——生成条铺满面板，
  // 内容框不铺满）。非 fill 时退回原来的固定 200px。
  const mediaBoxClass = cn(
    'mx-auto flex w-3/4 items-center justify-center overflow-hidden rounded-lg bg-[#141414]',
    fill ? 'min-h-[180px] flex-1' : 'h-[200px]',
  );

  return (
    // 播放器/占位在上、生成表单在下（与图片/视频详情同款「媒体 + 生成条」结构）。
    // fill：不再限宽居中，表单铺满面板；min-h-full 让内容超高时被父级滚动兜住。
    <div className={cn('mx-auto flex w-full max-w-5xl flex-col gap-4', fill && 'min-h-full max-w-none gap-3')}>
      {audioUrl ? (
        <div className={mediaBoxClass}>
          <AudioWaveformPlayer
            // key={node.id}：切换详情项时强制换实例——播放器自持 <audio> 与 isPlaying
            // 状态，A→B 复用同实例时换 src 不触发 pause 事件，会让 isPlaying 卡在 true
            // （暂停图标点了反而开始播 B）。与本文件其它子组件同款隔离。
            key={node.id}
            src={audioUrl}
            durationMs={durationMs}
            // 保活隐藏（点「在画布中定位」切回工作流）时停掉音频，与视频侧 videoRef
            // 强制 pause 同款——播放器自持 <audio>，隐藏后无法再手动停。
            paused={!visible}
            // 刻意不把解出的时长回写节点：updateNodeData 会推撤销快照并标脏，而「打开
            // 详情」不是一次编辑——回写会污染用户的撤销栈、触发无意义的自动保存。
            // chip 侧要显示时长时自己探测（AssetBoardAudioChip 的 probedSec），同口径。
          />
        </div>
      ) : (
        <AudioPlaceholder item={item} className={mediaBoxClass} />
      )}

      {/* 生成表单常挂（与图片/视频详情一致）：空节点从零生成；已有音频则可编辑合成文本、
          换声线/音色、改音乐设置后「重新生成」（按钮语义见 AssetBoardAudioGenForm 的
          hasAudio 分支）。对齐 liblib——音频详情底部同样是一条可编辑的生成条。
          fill 时钉底不压缩：高度不够先让上面的内容区缩。
          key={node.id}：切换详情项时强制换实例——表单持有草稿/输入法合成态，复用同位
          实例会把 A 的草稿带进 B。防重复提交登记表是模块级的，跨重挂存活。 */}
      <div className={cn(fill && 'shrink-0')}>
        <AssetBoardAudioGenForm key={node.id} nodeId={node.id} data={data} />
      </div>
    </div>
  );
}

/**
 * 生成中占位的百分比文案：与卡片同款「生成中 X%...」（时间估算，非后端真实
 * 进度，算法/预估时长表见 useEstimatedProgress / estimatedGenerationDurationMs）。
 * 拆成独立子组件，让 120ms 轮询定时器只在真正生成中的占位上才挂载。
 */
function GeneratingPlaceholderLabel({ item }: { item: AssetBoardItem }) {
  const percent = useEstimatedProgress(item.generationStartedAt, estimatedGenerationDurationMs(item.column));
  return <span className="text-[12px] text-muted-foreground">{`生成中 ${percent}%...`}</span>;
}

function AudioPlaceholder({ item, className }: { item: AssetBoardItem; className: string }) {
  return (
    // 尺寸与播放器框完全同款（见 AudioBody 的 mediaBoxClass）：内容区不跟着铺满
    // 面板的生成条一起拉宽。
    <div className={cn(className, 'flex-col gap-2')}>
      {item.isGenerating ? (
        <>
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <GeneratingPlaceholderLabel item={item} />
        </>
      ) : (
        <>
          <Music className="h-8 w-8 text-muted-foreground" />
          <span className="text-[12px] text-muted-foreground">{EMPTY_MEDIA_PLACEHOLDER_TEXT}</span>
        </>
      )}
    </div>
  );
}

function MediaPlaceholder({
  kind,
  item,
  fill,
}: {
  kind: 'image' | 'video';
  item: AssetBoardItem;
  /** 撑满父级剩余高度（详情挂了生成表单时）；否则按 16:9 占位。 */
  fill?: boolean;
}) {
  const Icon = kind === 'video' ? Play : ImageIcon;
  return (
    // 空节点（还没出图/出片）媒体区用纯黑底，与已有媒体的黑背景一致、留白更干净。
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg bg-black',
        // fill：高度吃满、按 16:9 定宽（空节点没有真实媒体比例），左右自然留边；
        // 否则按容器宽度走 16:9。
        fill ? 'aspect-video h-full max-w-full' : 'aspect-video w-full',
      )}
    >
      {item.isGenerating ? (
        <>
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <GeneratingPlaceholderLabel item={item} />
        </>
      ) : (
        <>
          <Icon className="h-8 w-8 text-muted-foreground" />
          {/* 空态明说「还没出图/出片、确认参数后才生成」（对齐 liblib 空节点），
              而不是一个没有说明的灰图标；下方的生成表单就是那个确认入口。 */}
          <span className="text-[12px] text-muted-foreground">{EMPTY_MEDIA_PLACEHOLDER_TEXT}</span>
        </>
      )}
    </div>
  );
}

/** 已有媒体上的生成中遮罩：半透明 + 居中 spinner，同时挡掉下层交互（放大/播放器）。 */
function GeneratingOverlay() {
  return (
    <span
      role="status"
      aria-label="生成中"
      className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/40"
    >
      <Loader2 className="h-6 w-6 animate-spin text-white" />
    </span>
  );
}

/**
 * 故事板主从布局的右侧详情面板（只读展示，对齐 liblib 参考图）。
 * 头部 ←/标题/×；正文按被点栏分派：文本 → Markdown 阅读页/行表（左上对齐），
 * 图片/视频 → 大媒体 + 徽标 + 提示词 + 参考素材。
 */
export function AssetBoardDetail({
  visible,
  nodeId,
  item,
  onBack,
  onClose,
  onOpenReference,
  onLocateReference,
  onZoomImage,
  onOpenNode,
}: AssetBoardDetailProps): ReactElement {
  // 直接从 store 取原始节点（详情要渲染完整内容，AssetBoardItem 只有卡片摘要字段）。
  // 隐藏时 selector 恒返回 undefined（Object.is 相等）→ 冻结重渲染，与 AssetBoardView
  // 的 liveNodes 冻结模式一致；undefined=冻结、null=可见但节点已被删除。
  const liveNode = useCanvasStore((state) =>
    visible ? (state.nodes.find((candidate) => candidate.id === nodeId) ?? null) : undefined,
  );
  // 渲染期直接写 ref：幂等的最近非冻结缓存（同 AssetBoardView dataRef 的说明）。
  const nodeRef = useRef<CanvasNode | null>(null);
  if (liveNode !== undefined && nodeRef.current !== liveNode) {
    nodeRef.current = liveNode;
  }
  const node = nodeRef.current;

  // 保活挂载下故事板被 visibility 隐藏后，<video controls> 仍会继续播放出声
  // （点卡片/音频条的「在画布中定位」切回工作流即触发）→ 隐藏瞬间强制暂停。
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!visible) {
      videoRef.current?.pause();
    }
  }, [visible]);

  // 头部「...」菜单要用的节点级动作（关键元素标记 / 创建副本 / 删除）。
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const duplicateNodeAsSibling = useCanvasStore((state) => state.duplicateNodeAsSibling);
  const deleteNode = useCanvasStore((state) => state.deleteNode);

  const missing = !item || !node;
  // 文本详情标题走正文里的大标题（对齐 liblib 阅读页），头部只留 ←/×。
  const showHeaderTitle = !missing && item.column !== 'text';
  // 「媒体撑满 + 生成条钉底」布局：挂了生成表单的图片/视频详情不滚动——媒体区吃掉
  // 剩余高度（按比例缩放，不裁切），表单固定在下方。原来整块正文是滚动的，媒体用
  // max-h-62vh，加上表单就超过一屏：用户想去下面写提示词时得往下滚，视频区被推出
  // 视野一截（用户反馈）。对标 liblib 的详情页同样是「上图下生成条、整页不滚」。
  // 音频详情的生成表单是常挂的（空节点从零合成、已有音频改参数重生成），所以整栏
  // 一律走这套布局，与图片/视频详情同一个观感（用户要求「风格跟视频一样」）。
  const mediaFillsBody =
    !missing &&
    (item.column === 'audio' ||
      ((item.column === 'image' || item.column === 'video') && generationFormKindOf(node) !== null));

  return (
    <section
      aria-label="资产详情"
      // group/detail：头部那条视频工具条「hover 到详情才浮现」的悬停源。**具名** group
      // 是必须的——详情子树里已经有一堆匿名 group-hover 的消费者（图片操作 chip、音频
      // 条、卡片……），挂匿名 group 会让它们在鼠标进详情任意位置时一起误触发。
      className="group/detail flex min-h-0 min-w-0 flex-1 flex-col rounded-lg rounded-b-none border border-white/5 bg-[#262626]"
    >
      <header className="flex shrink-0 items-center gap-1.5 px-3 py-2.5">
        <button type="button" aria-label="返回" title="返回" onClick={onBack} className={HEADER_ICON_BUTTON_CLASS}>
          <ChevronLeft className="h-4 w-4" />
        </button>
        {showHeaderTitle && (
          <h3 className="min-w-0 truncate text-sm font-medium text-foreground">{item.title}</h3>
        )}
        {/* 视频那四颗操作（剪辑/高清/下载/全屏）落在头部标题与右侧图标之间这段空白里，
            而不是压在画面上——浮在播放器上方会把视频挡掉一截（用户反馈）。
            key={node.id}：左列切换详情项时强制换实例——工具条持有本地 state（高清参数、
            busy 态），复用同位实例会把 A 的状态带到 B。 */}
        {!missing && item.column === 'video' && hasVideoDetailActions(node) ? (
          <div className="flex min-w-0 flex-1 justify-center px-2">
            <AssetBoardVideoDetailToolbar key={node.id} node={node} playerRef={videoRef} />
          </div>
        ) : (
          <div className="flex-1" />
        )}
        {/* 「添加到对话」：与卡片右上角、画布节点同一个入口（只发事件，选中 + 展开
            聊天由 FreezoneShell 统一落地）。挂头部而不是下面那条工具条——四栏一视
            同仁，且引用一个空节点也成立，不该被「有没有出图出片」的门槛挡掉。 */}
        {!missing && (
          // side=bottom：按钮贴着详情面板顶边，提示朝上会被面板裁掉。
          <AddNodeToChatIconButton
            nodeId={node.id}
            className={HEADER_ICON_BUTTON_CLASS}
            side="bottom"
          />
        )}
        {/* 节点级操作（对标 liblib 详情右上角的「...」）：设置关键元素 / 创建副本 /
            删除。四栏（文本/图片/视频/音频）一视同仁——这三项与「有没有出图出片」
            无关，所以挂在头部而不是那条要素材才成立的工具条上，空节点同样点得到。
            图片侧的「设置关键元素」已从工具条那颗「...」里收掉，统一走这里。 */}
        {!missing && (
          <DetailMoreMenu
            key={node.id}
            triggerClassName={HEADER_ICON_BUTTON_CLASS}
            triggerLabel="节点操作"
            entries={[
              keyElementMenuEntry(node, updateNodeData),
              {
                kind: 'action',
                key: 'duplicate',
                icon: Copy,
                label: '创建副本',
                // 复制到源节点下方一格并克隆上游连线（与工作流多选工具条同一个 store
                // 动作）；建好直接把详情切到副本，否则用户看不出发生了什么。
                onSelect: () => {
                  const cloneId = duplicateNodeAsSibling(node.id, 1);
                  if (cloneId) onOpenNode(cloneId, item.column);
                },
              },
              {
                kind: 'action',
                key: 'delete',
                icon: Trash2,
                label: '删除',
                // 节点没了详情也就没了对象——先关详情再删，避免详情闪一下「节点已不存在」。
                onSelect: () => {
                  onClose();
                  deleteNode(node.id);
                },
              },
            ]}
          />
        )}
        <button
          type="button"
          aria-label="关闭详情"
          title="关闭详情"
          onClick={onClose}
          className={HEADER_ICON_BUTTON_CLASS}
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      {/* 失败横条：节点带失败原因且不在重试中时，头部下方（工具条上方）常驻展示——
          此前失败原因只写在节点 data 上，切到故事板就看不到（质量审查 I2）。 */}
      {!missing && !item.isGenerating && item.generationError && (
        <div className="shrink-0 px-4 pb-2">
          <div className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
            {item.generationError}
          </div>
        </div>
      )}
      {/* 操作工具条：详情头部下方一条操作链（对标 liblib）；文本详情的操作在正文
          分派组件里（只读阅读页，见 AssetBoardDetailTextSection）。
          key={node.id}：左列切换详情项时强制换实例——工具条/编辑器持有本地
          state（编辑草稿、busy 态），复用同位实例会把 A 的草稿/spinner 带到 B
          （最坏路径：blur 把 A 草稿写进 B 的 content）。代价是同节点切走再切回
          丢 busy 展示（在途任务仍正确回写节点），第二批考虑在途态落 node data。 */}
      {/* 空内容节点（还没出图/出片）整条工具条不渲染——上面的操作全都要素材才
          成立，一排灰按钮只是噪音（用户要求）。判定见 has*DetailActions。 */}
      {!missing && item.column === 'image' && hasImageDetailActions(node) && (
        <div className="shrink-0 px-4 pb-2">
          {/* onOpenNode：宫格模板点完会建一个空的功能节点，详情要跟着切过去
              （同「创建副本」的处理）——新节点一定落在图片栏。 */}
          <AssetBoardImageDetailToolbar
            key={node.id}
            node={node}
            onOpenNode={(newNodeId) => onOpenNode(newNodeId, 'image')}
          />
        </div>
      )}
      {/* 视频没有这条槽位：它那四颗操作（剪辑/高清/下载/全屏）已改成浮在播放器
          上方、hover 才出现的胶囊，挂在正文的媒体区里（见 MediaBody）。 */}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-2',
          // 媒体撑满布局：正文变 flex 列，媒体区吃掉剩余高度、生成条钉底。仍留
          // overflow-y-auto 作兜底——矮视口下媒体缩到下限后总高会超出，这时宁可
          // 滚动也不能把生成条裁掉（overflow-hidden 会让提交按钮点不到）。
          mediaFillsBody && 'flex flex-col',
        )}
      >
        {missing ? (
          <p className="py-16 text-center text-[13px] text-muted-foreground">节点已不存在</p>
        ) : item.column === 'text' ? (
          // 左对齐、顶起：正文从详情区左上角开始（对齐 liblib 阅读页），不再水平居中。
          // 正文占面板 90% 宽（原来卡在 max-w-3xl=768px，面板一宽就只用了半边，
          // 一行没几个字就折行）。留 10% 是不让文字直接贴到面板边缘。
          <div className="flex w-[90%] flex-col gap-4">
            <AssetBoardDetailTextSection key={node.id} node={node} title={item.title} />
          </div>
        ) : item.column === 'audio' ? (
          <AudioBody item={item} node={node} visible={visible} fill={mediaFillsBody} />
        ) : (
          <MediaBody
            item={item}
            node={node}
            videoRef={videoRef}
            fill={mediaFillsBody}
            onOpenReference={onOpenReference}
            onLocateReference={onLocateReference}
            onZoomImage={onZoomImage}
          />
        )}
      </div>
    </section>
  );
}
