// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
} from 'react';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { AlertTriangle, Music2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  CANVAS_NODE_TYPES,
  type AudioNodeData,
  type AudioVoiceRef,
} from '@/features/canvas/domain/canvasNodes';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { NodeGenerationOverlay } from '@/features/canvas/ui/NodeGenerationOverlay';
import { AudioWaveformPlayer } from '@/features/canvas/ui/AudioWaveformPlayer';
import { setNodeMediaActive } from '@/features/canvas/application/canvasLod';
import { useNodeGenerationTaskState } from '@/features/canvas/application/useNodeGenerationTaskState';
import { CANVAS_NODE_PANEL_SURFACE_CLASS, canvasNodeFrameClass } from '@/features/canvas/ui/nodeFrameStyles';
import { useCanvasStore, useIsBoxSelecting } from '@/stores/canvasStore';
import { AudioOperationsPanel } from '@/features/canvas/nodes/AudioOperationsPanel';
import { useAudioGeneration } from '@/features/canvas/nodes/useAudioGeneration';
import { RegenerateButton } from '@/features/canvas/ui/RegenerateButton';
import {
  hasMainlineContexts,
  NodeContextBadges,
} from '@/features/freezone/context/NodeContextBadges';
import { fetchFreezoneAudioReferences, uploadFreezoneImage } from '@/api/ops';
import { readUrl } from '@/lib/url-params';

type AudioNodeProps = NodeProps & {
  id: string;
  data: AudioNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 210;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 190;
const MAX_WIDTH = 900;
const MAX_HEIGHT = 360;

// 仅允许音频文件。`accept="audio/*"` 只是选择器提示，用户选「所有文件」或拖拽
// 仍能塞进 mp4 等非音频；这里按 mime + 扩展名硬校验（mp4 等视频被拒，m4a 等
// 仍放行——含 mime 为空/异常的音频用扩展名兜底）。
const AUDIO_UPLOAD_EXTENSIONS = new Set([
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba', 'wma',
  'aiff', 'aif', 'caf', 'amr',
]);

function isAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return AUDIO_UPLOAD_EXTENSIONS.has(ext);
}

// 模块级 references 缓存：同一 project 下所有音频节点共享一次拉取。
// 用 Promise 而不是 result，保证多个节点同时挂载时也只发一次请求
// （都 await 同一个 in-flight promise），不会出现并发风暴。
const audioReferencesPromiseCache = new Map<
  string,
  Promise<Awaited<ReturnType<typeof fetchFreezoneAudioReferences>>>
>();

function getCachedAudioReferences(project: string) {
  let p = audioReferencesPromiseCache.get(project);
  if (!p) {
    p = fetchFreezoneAudioReferences(project).catch((err) => {
      // 失败时把 promise 从缓存里清掉，下一次挂载有机会重试。
      audioReferencesPromiseCache.delete(project);
      throw err;
    });
    audioReferencesPromiseCache.set(project, p);
  }
  return p;
}

export const AudioNode = memo(({ id, data, selected, width, height }: AudioNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const isBoxSelecting = useIsBoxSelecting();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const { isGenerating, task } = useNodeGenerationTaskState(data);
  // 重试用与面板提交同一套生成逻辑（hook）。
  const { generate } = useAudioGeneration(id, data);

  // 任务流(SSE)回报失败时把错误持久化进节点数据 + 清 isGenerating——覆盖刷新后、
  // 节点未选中、handleSubmit promise 已随旧页面销毁等 catch 没跑到的情况。
  useEffect(() => {
    if (task && task.status === 'failed' && task.error) {
      if (data.generationError !== task.error || data.isGenerating) {
        updateNodeData(id, {
          generationError: task.error,
          isGenerating: false,
        });
      }
    }
  }, [task, data.generationError, data.isGenerating, id, updateNodeData]);

  const generationError =
    typeof data.generationError === 'string' ? data.generationError.trim() : '';
  // 仅在「未生成 + 无音频 + 有错误」时作为失败态展示，避免遮住成功结果。
  const hasGenerationError =
    !isGenerating && !data.audioUrl && generationError.length > 0;

  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.audio, data),
    [data],
  );
  const resolvedWidth = Math.max(MIN_WIDTH, Math.round(width ?? DEFAULT_WIDTH));
  const resolvedHeight = Math.max(MIN_HEIGHT, Math.round(height ?? DEFAULT_HEIGHT));

  const audioSource = useMemo(() => {
    if (!data.audioUrl) return null;
    return resolveImageDisplayUrl(data.audioUrl);
  }, [data.audioUrl]);
  const hasMainlineContext = hasMainlineContexts(
    (data as { mainline_context?: unknown }).mainline_context,
  );

  // 上传一份本地音频到后端 freezone — 复用通用 upload 端点（后端不区分 mime）。
  // 上传成功后落 audioUrl/sourceFileName 进 store，AudioOperationsPanel 那边
  // 也会自动 pick 到这份音频做后续处理。
  const processFile = useCallback(
    async (file: File) => {
      if (!isAudioFile(file)) {
        toast.error(t('node.audio.uploadTypeError'));
        return;
      }
      const projectId = readUrl().project;
      if (!projectId) {
        console.error('[audio-node] no project in URL — cannot upload');
        return;
      }
      updateNodeData(id, { isUploading: true });
      try {
        const uploaded = await uploadFreezoneImage(projectId, file, file.name);
        updateNodeData(id, {
          audioUrl: uploaded.url,
          sourceFileName: file.name,
          // 重置 duration —— 让 <audio onLoadedMetadata> 在新文件加载时重新写入。
          durationMs: null,
          isUploading: false,
        });
      } catch (error) {
        console.error('[audio-node] upload failed', error);
        updateNodeData(id, { isUploading: false });
      }
    },
    [id, t, updateNodeData],
  );

  // 「上传资源」菜单上传音频时，UploadNode 会先把自己转成音频节点，再通过事件
  // 总线把 File 投递过来。这里订阅并复用上传流程。
  useEffect(() => {
    return canvasEventBus.subscribe('audio-node/external-file', ({ nodeId, file }) => {
      if (nodeId !== id) return;
      // 类型校验统一交给 processFile（含非音频拒绝 + toast 提示）。
      void processFile(file);
    });
  }, [id, processFile]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  // 节点挂载后若没有显式音色，则拉一次音色库 references 并落到第一条。
  // 放在 AudioNode 而非 AudioOperationsPanel 里，是因为 panel 只在
  // `selected && !audioUrl` 才挂载——新建后若没立刻被点中，panel 不会渲染，
  // 初始化 effect 永远跑不到。AudioNode 一进画布就 mount，能稳定触发。
  //
  // "没有显式音色" = voiceRef 缺失 *或* 仍是历史工厂兜底（纯
  // `{ scope: 'project_narrator' }`，无 characterName/identityId/slot/voiceId），
  // 兼容 2026-05-19 之前持久化的旧节点。
  //
  // 不要在外面拿 useRef 守"只跑一次"——StrictMode 下第一遍 effect 起 fetch、
  // cleanup 把 cancelled 翻 true，第二遍 effect 见 ref 已置位直接 bail，第一遍
  // 闭包等回来又被 cancelled 挡住，结果谁都写不进 store。请求级去重交给
  // `getCachedAudioReferences` 的 promise cache。
  useEffect(() => {
    const v = data.voiceRef;
    const isFactoryFallback =
      v != null &&
      v.scope === 'project_narrator' &&
      !v.characterName &&
      !v.identityId &&
      !v.slot &&
      !v.voiceId;
    if (v != null && !isFactoryFallback) return;
    const project = readUrl().project;
    if (!project) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await getCachedAudioReferences(project);
        if (cancelled) return;
        const first = (res.available ?? [])[0];
        if (!first) return;
        const fresh = useCanvasStore.getState().nodes.find((n) => n.id === id);
        if (!fresh) return;
        const freshData = fresh.data as AudioNodeData;
        const cur = freshData.voiceRef;
        const curIsFactory =
          cur != null &&
          cur.scope === 'project_narrator' &&
          !cur.characterName &&
          !cur.identityId &&
          !cur.slot &&
          !cur.voiceId;
        if (cur != null && !curIsFactory) return;
        const ref: AudioVoiceRef = {
          scope: first.scope,
          characterName: first.character_name ?? undefined,
          identityId: first.identity_id ?? undefined,
          slot: first.slot ?? undefined,
          voiceId: first.voice_id ?? undefined,
        };
        const nextLabel = first.label ?? '';
        const nextLanguage = first.language ?? '';
        // 若算出来的默认音色跟当前已经一致就跳过：当首条 reference 本身就是裸
        // project_narrator（与"工厂兜底"同形）时，写入会再次触发本 effect，而两道
        // 守卫都把这种形状当成"仍需初始化"，于是每次渲染都写一个新对象 →
        // 无限重渲染把浏览器卡死。这道相等性判断是断开死循环的关键。
        if (
          cur != null &&
          cur.scope === ref.scope &&
          cur.characterName === ref.characterName &&
          cur.identityId === ref.identityId &&
          cur.slot === ref.slot &&
          cur.voiceId === ref.voiceId &&
          freshData.voiceLabel === nextLabel &&
          freshData.voiceLanguage === nextLanguage
        ) {
          return;
        }
        updateNodeData(id, {
          voiceRef: ref,
          voiceLabel: nextLabel,
          voiceLanguage: nextLanguage,
        });
      } catch (err) {
        console.warn('[audio-node] init default voice failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data.voiceRef, id, updateNodeData]);

  const cardToneClass = canvasNodeFrameClass({
    selected,
    mainline: hasMainlineContext,
  });

  return (
    <div
      className="group relative h-full w-full overflow-visible"
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="target"
        className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="source"
        className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
      />

      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Music2 className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />
      <NodeContextBadges
        contexts={(data as { mainline_context?: unknown }).mainline_context}
      />

      <NodeResizeHandle
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        maxWidth={MAX_WIDTH}
        maxHeight={MAX_HEIGHT}
      />

      {/* 音频节点不再作为上传入口（空状态/替换均移除）：上传音频请通过「上传节点」
          或把音频文件拖入画布；外部投递仍走 canvasEventBus 'audio-node/external-file'。 */}

      <div
        className={`relative flex h-full w-full items-center justify-center ${audioSource ? 'overflow-hidden' : 'overflow-visible'} rounded-[var(--node-radius)] border ${CANVAS_NODE_PANEL_SURFACE_CLASS} transition-colors ${cardToneClass}`}
      >
        {isGenerating ? (
          <NodeGenerationOverlay
            startedAt={data.generationStartedAt ?? null}
            hasBackground={false}
          />
        ) : audioSource ? (
          <AudioWaveformPlayer
            src={audioSource}
            durationMs={data.durationMs}
            onLoadedDuration={(ms) => {
              if (data.durationMs !== ms) {
                updateNodeData(id, { durationMs: ms });
              }
            }}
            onPlayingChange={(playing) => setNodeMediaActive(id, playing)}
          />
        ) : hasGenerationError ? (
          // 失败态：与 ImageGenNode/VideoNode 一致（headline + 可滚动错误文本 + 共用重试按钮）。
          <div className="nodrag flex flex-col items-center px-5 text-center">
            <div className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-red-200">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-300/90" />
              <span>生成失败</span>
            </div>
            <div
              className="mt-1 max-h-12 max-w-full overflow-y-auto break-words text-[11px] leading-4 text-red-100/76 [overflow-wrap:anywhere]"
              title={generationError}
            >
              {generationError}
            </div>
            <div className="mt-2 flex justify-center">
              <RegenerateButton
                onClick={() => void generate()}
                busy={isGenerating}
                label="重试"
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-text-muted/70">
            <Music2 className="h-7 w-7 opacity-60" />
            <span className="text-[12px]">暂无音频</span>
          </div>
        )}
      </div>

      {/* 节点一旦有音频内容（手动上传 or TTS 合成），就不再展示底部操作区 ——
          这条规则覆盖手动上传 / TTS 合成完成两种情况。
          想要重新合成只能先清掉音频（暂时通过删节点重建）。 */}
      {selected && !isBoxSelecting && !data.audioUrl && (
        <AudioOperationsPanel nodeId={id} data={data} />
      )}
    </div>
  );
});

AudioNode.displayName = 'AudioNode';
