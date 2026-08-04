// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  Handle,
  Position,
  useStore,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { isLowDetailZoom } from '@/features/canvas/application/canvasLod';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowUp, Loader2, Orbit } from 'lucide-react';

import {
  uploadFreezoneImage,
  submitFreezoneImageTo3GS,
  type FreezoneImageTo3GSKind,
  type FreezoneGenerationHistoryRecord,
} from '@/api/ops';
import { awaitTaskCompletion, isTaskPollTimeoutError, type TaskState } from '@/api/tasks';
import { notifyTaskStillRunning } from '@/features/canvas/application/errorDialog';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import {
  uploadAndAutoCommitSelectedBackgroundCandidate,
} from '@/features/canvas/application/selectedBackgroundSlot';
import {
  getBeatDirectorStageManifest,
  getDirectorStagePalette,
} from '@/api/viewerManifests';
import { useUpstreamNodes } from '@/features/canvas/application/useUpstreamGraph';
import { useNodeGenerationTaskState } from '@/features/canvas/application/useNodeGenerationTaskState';
import { useNodeGenerationHistory } from '@/features/canvas/hooks/useNodeGenerationHistory';
import { NodeGenerationHistory } from '@/features/canvas/ui/NodeGenerationHistory';
import {
  resolveImageDisplayUrl,
  withImageCacheBust,
} from '@/features/canvas/application/imageData';
import { uploadLocalImageToBackend } from '@/features/canvas/application/uploadToolOutput';
import {
  directorPanoSourceFromCanvasNode,
  imageUrlFromCanvasNode,
  isPanoImageCanvasNode,
  mergeDirectorStageManifestSources,
  mergeDirectorSavedSceneMaps,
  mergeDirectorWorldSources,
  sourceFromImageTo3gsResult,
} from '@/features/canvas/domain/directorWorldSources';
import { setDirectorWorldSceneSaveHandler } from '@/features/canvas/domain/directorWorldSceneSaveRegistry';
import {
  ThreeDDirectorDialog,
  type ThreeDDirectorCaptureMeta,
} from '@/features/viewer-kit/three-d/ThreeDDirectorDialog';
import type { ThreeDSceneSnapshot } from '@/features/viewer-kit/three-d/engine/viewerApp';
import type {
  DirectorControlFrameBundle,
  DirectorStageManifest,
  DirectorWorldSource,
} from '@/features/viewer-kit/three-d/directorManifest';
import {
  CANVAS_NODE_TYPES,
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isStoryboardGenNode,
  isTextAnnotationNode,
  isUploadNode,
  type CanvasNode,
  type ThreeDWorldNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { NodeGenerationOverlay } from '@/features/canvas/ui/NodeGenerationOverlay';
import { CANVAS_NODE_OPS_PANEL_CLASS, canvasNodeFrameClass } from '@/features/canvas/ui/nodeFrameStyles';
import {
  NODE_CREDIT_PILL_FLAT_CLASS,
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
  NODE_INLINE_ERROR_MESSAGE_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import {
  hasMainlineContexts,
  NodeContextBadges,
  validMainlineContexts,
} from '@/features/freezone/context/NodeContextBadges';
import { ReferenceDetachButton } from '@/features/canvas/nodes/shared/ReferenceDetachButton';
import { ReferenceTextChip } from '@/features/canvas/nodes/shared/ReferenceTextChip';
import { useDetachUpstream } from '@/features/canvas/hooks/useDetachUpstream';
import { readUrl } from '@/lib/url-params';
import { BillingRuleNotConfiguredError } from '@/lib/api-errors';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import {
  CreditCostPill,
  type CreditPromotionDisplay,
} from '@/components/credits/credit-visual';
import { useCanvasStore } from '@/stores/canvasStore';

type ThreeDWorldNodeProps = NodeProps & {
  id: string;
  data: ThreeDWorldNodeData;
  selected?: boolean;
};

const PANEL_GAP_PX = 12;
const PANEL_OVERHANG_PX = 60;

interface UpstreamRef {
  nodeId: string;
  kind: 'image' | 'text';
  displayName: string;
  imageUrl?: string | null;
  textContent?: string | null;
}

function nodeLabel(node: CanvasNode): string {
  const dn = (node.data as { displayName?: unknown }).displayName;
  if (typeof dn === 'string' && dn.trim().length > 0) return dn;
  return node.type ?? '上游节点';
}

function upstreamRef(node: CanvasNode | undefined | null): UpstreamRef | null {
  if (!node) return null;
  if (isImageGenNode(node)) {
    const ref =
      typeof node.data.referenceImageUrl === 'string' && node.data.referenceImageUrl.length > 0
        ? node.data.referenceImageUrl
        : null;
    const url = node.data.imageUrl || ref;
    if (!url) return null;
    return { nodeId: node.id, kind: 'image', displayName: nodeLabel(node), imageUrl: url };
  }
  if (
    isUploadNode(node) ||
    isImageEditNode(node) ||
    isExportImageNode(node) ||
    isStoryboardGenNode(node)
  ) {
    if (!node.data.imageUrl) return null;
    return {
      nodeId: node.id,
      kind: 'image',
      displayName: nodeLabel(node),
      imageUrl: node.data.imageUrl,
    };
  }
  if (isTextAnnotationNode(node)) {
    const text = (node.data.content ?? '').trim();
    if (!text) return null;
    return { nodeId: node.id, kind: 'text', displayName: nodeLabel(node), textContent: text };
  }
  return null;
}

function pickPlyUrlFromResult(result: TaskState['result'] | undefined): string | null {
  if (!result) return null;
  const candidates: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof value === 'string') {
      if (/\.(ply|sog|splat|ksplat|spz)(\?|#|$)/i.test(value) || /scene_3gs|ply_fs|splat/i.test(value)) {
        candidates.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const preferredKeys = [
        'sog_url',
        'sogUrl',
        'sog_path',
        'sogPath',
        'splat_url',
        'splatUrl',
        'splat_path',
        'splatPath',
        'ply_url',
        'plyUrl',
        'master_ply_url',
        'masterPlyUrl',
        'scene_3gs_ply_fs',
        'scene_3gs_master_ply_fs',
        'output_url',
        'asset_url',
        'static_url',
        'url',
      ];
      for (const key of preferredKeys) {
        const v = obj[key];
        if (typeof v === 'string' && v.length > 0) {
          candidates.push(v);
        }
      }
      for (const key in obj) {
        if (!preferredKeys.includes(key)) visit(obj[key], depth + 1);
      }
    }
  };
  visit(result, 0);
  // Prefer compressed SOG / splat packages, then legacy raw PLY.
  const sog = candidates.find((c) => /\.sog(\?|#|$)/i.test(c));
  if (sog) return sog;
  const packaged = candidates.find((c) => /\.(ksplat|splat|spz)(\?|#|$)/i.test(c));
  if (packaged) return packaged;
  const ply = candidates.find((c) => /\.ply(\?|#|$)/i.test(c));
  if (ply) return ply;
  return candidates[0] ?? null;
}

function resolveNodeDimension(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) {
    return Math.round(value);
  }
  return fallback;
}

type LocalDirectorManifestSource = DirectorStageManifest['source'];
type DirectorImageSourceKind = 'master' | 'pano';

const DIRECTOR_IMAGE_SOURCE_OPTIONS: Array<{ value: DirectorImageSourceKind; labelKey: string }> = [
  { value: 'master', labelKey: 'nodeToolbar.normalImage' },
  { value: 'pano', labelKey: 'nodeToolbar.image360' },
];

const SCENE_DIRECTOR_SOURCE_ROLES = new Set([
  'scene_director_world',
  'scene_director_pano_360',
  'scene_3gs_master_ply',
  'scene_3gs_reverse_ply',
  'scene_3gs_pano_ply',
  'scene_3gs_custom_scene',
]);

function sourceKindForManifest(
  value: LocalDirectorManifestSource['source_kind'] | 'active' | undefined,
): LocalDirectorManifestSource['source_kind'] {
  return value && value !== 'active' ? value : 'custom';
}

function sourceFromDirectorWorldSource(
  source: NonNullable<ThreeDWorldNodeData['sources']>[number] | undefined,
): LocalDirectorManifestSource | null {
  if (!source || source.source_type === 'mesh') return null;
  return {
    source_type: source.source_type,
    ply_url: source.ply_url,
    url: source.url ?? source.ply_url ?? source.pano_url,
    pano_url: source.pano_url,
    pano_fs: source.pano_fs,
    collision_glb_url: source.collision_glb_url,
    source_kind: sourceKindForManifest(source.source_kind),
    transform: source.transform,
  };
}

function sourceFromLegacyData(data: ThreeDWorldNodeData): LocalDirectorManifestSource | null {
  if (!data.plyUrl && !data.panoUrl) return null;
  const sourceType = data.plyUrl ? 'sog' : 'pano360';
  const sourceKind =
    data.plyKind === 'master' || data.plyKind === 'reverse' || data.plyKind === 'pano'
      ? data.plyKind
      : 'custom';

  return {
    source_type: sourceType,
    ply_url: data.plyUrl ?? undefined,
    url: data.plyUrl ?? data.panoUrl ?? undefined,
    pano_url: data.panoUrl ?? undefined,
    source_kind: sourceKind,
  };
}

function directorSourceFromLegacyData(data: ThreeDWorldNodeData): DirectorWorldSource | null {
  const source = sourceFromLegacyData(data);
  if (!source) return null;
  const sourceType = data.plyUrl ? 'sog' : 'pano360';
  return {
    id: `node:${sourceType}:${source.url ?? source.ply_url ?? source.pano_url ?? 'source'}`,
    source_type: sourceType,
    source_kind: source.source_kind,
    label: sourceType === 'pano360' ? 'Pano 360' : source.source_kind,
    ply_url: source.ply_url,
    url: source.url,
    pano_url: source.pano_url,
    collision_glb_url: source.collision_glb_url,
    current: true,
  };
}

function sameDirectorSourceUrl(a: DirectorWorldSource, b: DirectorWorldSource): boolean {
  const aUrl = a.pano_url ?? a.ply_url ?? a.url;
  const bUrl = b.pano_url ?? b.ply_url ?? b.url;
  return Boolean(aUrl && bUrl && aUrl === bUrl);
}

function sourceRoleFromNode(data: ThreeDWorldNodeData): string | null {
  const source = (data as { __freezone_source?: unknown }).__freezone_source;
  if (!source || typeof source !== 'object') return null;
  const sourceRecord = source as Record<string, unknown>;
  if (typeof sourceRecord.role === 'string') return sourceRecord.role;
  const meta = sourceRecord.meta;
  const metaRole = meta && typeof meta === 'object'
    ? (meta as Record<string, unknown>).role
    : null;
  return typeof metaRole === 'string' ? metaRole : null;
}

function isImportedSceneDirectorWorldBundle(data: ThreeDWorldNodeData): boolean {
  if ((data as { user_spawned?: unknown }).user_spawned !== true) return false;
  return sourceRoleFromNode(data) === 'scene_director_world';
}

export function isCandidateDirectorWorldNode(data: ThreeDWorldNodeData): boolean {
  if ((data as { user_spawned?: unknown }).user_spawned === true) return true;
  return !hasMainlineContexts((data as { mainline_context?: unknown }).mainline_context);
}

export function directorSourcesForNode(
  data: ThreeDWorldNodeData,
  upstreamPanoSources: DirectorWorldSource[],
): DirectorWorldSource[] {
  const explicitSources = (data.sources ?? []).filter((source) => source.source_type !== 'mesh');
  const hasMainlineContext = hasMainlineContexts((data as { mainline_context?: unknown }).mainline_context);
  if (!hasMainlineContext || ((data as { user_spawned?: unknown }).user_spawned === true && !isImportedSceneDirectorWorldBundle(data))) {
    const activeSource =
      explicitSources.find((source) => source.id && source.id === data.activeSourceId) ??
      explicitSources.find((source) => source.current) ??
      explicitSources[0] ??
      directorSourceFromLegacyData(data);
    return activeSource ? [activeSource] : [];
  }
  const sources = explicitSources.length > 0 ? [...explicitSources] : [];
  const legacySource = directorSourceFromLegacyData(data);
  if (legacySource && sources.length === 0) {
    sources.push(legacySource);
  }
  for (const source of upstreamPanoSources) {
    if (!sources.some((item) => sameDirectorSourceUrl(item, source))) {
      sources.push(source);
    }
  }
  return sources;
}

function buildLocalDirectorManifest({
  project,
  data,
  contexts,
  beatContext,
  upstreamPanoSources,
  defaultPalette,
}: {
  project: string;
  data: ThreeDWorldNodeData;
  contexts: ReturnType<typeof validMainlineContexts>;
  beatContext: { episode: number; beat: number } | null;
  upstreamPanoSources: DirectorWorldSource[];
  defaultPalette: DirectorStageManifest['palette'] | null;
}): DirectorStageManifest | null {
  const directorSources = directorSourcesForNode(data, upstreamPanoSources);
  const activeSource =
    directorSources.find((source) => source.id && source.id === data.activeSourceId) ??
    directorSources.find((source) => source.current) ??
    directorSources[0];
  const manifestSource =
    sourceFromDirectorWorldSource(activeSource) ??
    sourceFromLegacyData(data) ??
    {
      source_type: 'sog' as const,
      source_kind: 'custom' as const,
      url: undefined,
      ply_url: undefined,
      pano_url: undefined,
    };

  const sceneContext = contexts.find((ctx) => ctx.kind === 'scene' && typeof ctx.sceneId === 'string');
  const sceneId =
    sceneContext && typeof sceneContext.sceneId === 'string' && sceneContext.sceneId.trim()
      ? sceneContext.sceneId
      : 'freezone-3gs';

  return {
    viewer_kind: 'three_d_director',
    mode: beatContext ? 'beat' : 'scene',
    project,
    scene_id: sceneId,
    display_name:
      typeof data.displayName === 'string' && data.displayName.trim()
        ? data.displayName
        : '导演世界',
    source: manifestSource,
    sources: directorSources.length > 0 ? directorSources : undefined,
    active_source_id: data.activeSourceId ?? activeSource?.id,
    beat_context: beatContext
      ? {
          episode: beatContext.episode,
          beat: beatContext.beat,
          detected_identities: [],
          detected_props: [],
        }
      : undefined,
    palette: {
      actors: [],
      props: [],
      anonymous_colors: beatContext ? [] : (defaultPalette?.anonymous_colors ?? []),
      anonymous_prop_colors: defaultPalette?.anonymous_prop_colors ?? [],
    },
    allowed_destinations: beatContext
      ? ['view', 'download', 'beat_selected_background', 'canvas_screenshot_node']
      : ['view', 'download', 'canvas_screenshot_node'],
  };
}

export function usableDirectorWorldPreviewUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const url = value.trim();
  const clean = url.split('?')[0].toLowerCase();
  if (
    clean.endsWith('.sog') ||
    clean.endsWith('.ply') ||
    clean.endsWith('.glb') ||
    clean.endsWith('.json')
  ) {
    return null;
  }
  return url;
}

export function isSceneDirectorWorldNode(data: ThreeDWorldNodeData): boolean {
  if ((data as { user_spawned?: unknown }).user_spawned === true) return false;
  if (!hasMainlineContexts((data as { mainline_context?: unknown }).mainline_context)) return false;
  const sourceRole = sourceRoleFromNode(data);
  return Boolean(sourceRole && SCENE_DIRECTOR_SOURCE_ROLES.has(sourceRole));
}

async function uploadDirectorCaptureBundle(
  projectId: string,
  nodeId: string,
  meta: NonNullable<ThreeDDirectorCaptureMeta["captureBundle"]>,
): Promise<DirectorControlFrameBundle> {
  const stamp = Date.now();
  const [combined, envOnly, frameMeta] = await Promise.all([
    uploadFreezoneImage(projectId, meta.combined, `director-world-${nodeId}-combined-${stamp}.png`, { timeoutMs: false }),
    uploadFreezoneImage(projectId, meta.env_only, `director-world-${nodeId}-env-only-${stamp}.png`, { timeoutMs: false }),
    uploadFreezoneImage(
      projectId,
      new Blob([JSON.stringify(meta.frame_meta)], { type: 'application/json' }),
      `director-world-${nodeId}-frame-meta-${stamp}.json`,
      { timeoutMs: false },
    ),
  ]);

  return {
    schema_version: "director_control_bundle_v1",
    dir: "freezone/director-world",
    paths: {
      combined: combined.filename,
      env_only: envOnly.filename,
      frame_meta: frameMeta.filename,
    },
    rel_paths: {
      combined: combined.filename,
      env_only: envOnly.filename,
      frame_meta: frameMeta.filename,
    },
    urls: {
      combined: combined.url,
      env_only: envOnly.url,
      frame_meta: frameMeta.url,
    },
    source: meta.frame_meta.source,
    frame_meta: meta.frame_meta,
  };
}

interface ReferenceImageRef {
  nodeId: string;
  url: string;
  displayName: string;
}

interface ReferenceTextRef {
  nodeId: string;
  text: string;
  displayName: string;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('无法读取 3GS 截图'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('无法读取 3GS 截图'));
    reader.readAsDataURL(blob);
  });
}

function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
    image.onerror = () => reject(new Error('无法解析 3GS 截图尺寸'));
    image.src = dataUrl;
  });
}

function imageTo3gsKindForSource(
  sourceNode: CanvasNode | null,
  visibleSourceKind: DirectorImageSourceKind,
): FreezoneImageTo3GSKind {
  if (visibleSourceKind === 'pano') return 'pano';
  const source = sourceNode?.data as { output_role?: unknown; __freezone_source?: unknown } | undefined;
  const outputRole = typeof source?.output_role === 'string' ? source.output_role : '';
  const sourceRole = typeof (source?.__freezone_source as { role?: unknown } | undefined)?.role === 'string'
    ? (source?.__freezone_source as { role?: string }).role
    : '';
  return outputRole === 'scene_reverse_master' || sourceRole === 'scene_reverse_master'
    ? 'reverse'
    : 'master';
}

function ReferenceImageThumb({
  item,
  onFocus,
  onDetach,
}: {
  item: ReferenceImageRef;
  onFocus: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [previewPos, setPreviewPos] = useState<{ left: number; top: number } | null>(null);
  const PREVIEW_W = 240;
  const PREVIEW_OFFSET = 10;

  const showPreview = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(
      8,
      Math.min(window.innerWidth - PREVIEW_W - 8, rect.left + rect.width / 2 - PREVIEW_W / 2),
    );
    const top = rect.top - PREVIEW_OFFSET;
    setPreviewPos({ left, top });
  }, []);

  const hidePreview = useCallback(() => {
    setPreviewPos(null);
  }, []);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onFocus(item.nodeId);
        }}
        onMouseEnter={showPreview}
        onMouseLeave={hidePreview}
        className="group nodrag relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-white/10 bg-white/[0.04] transition-colors hover:border-white/30"
        title="引用上游图片"
      >
        <img
          src={resolveImageDisplayUrl(item.url)}
          alt="上游图片引用"
          className="h-full w-full object-cover"
        />
        <ReferenceDetachButton nodeId={item.nodeId} onDetach={onDetach} />
      </button>
      {previewPos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[400] -translate-y-full"
            style={{ left: previewPos.left, top: previewPos.top, width: PREVIEW_W }}
          >
            <div className="overflow-hidden rounded-xl border border-white/15 bg-surface-dark/95 shadow-2xl backdrop-blur-sm">
              <img
                src={resolveImageDisplayUrl(item.url)}
                alt="上游图片引用预览"
                className="block h-auto w-full object-contain"
                draggable={false}
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

interface OpsPanelProps {
  isGenerating: boolean;
  hasUpstream: boolean;
  billingRuleMissing: boolean;
  creditCostDisplay: string | null;
  creditPromotion?: CreditPromotionDisplay | null;
  errorMessage?: string | null;
  sourceKind: DirectorImageSourceKind;
  referenceImages: ReferenceImageRef[];
  selectedReferenceNodeId: string | null;
  referenceImage: ReferenceImageRef | null;
  referenceText: ReferenceTextRef | null;
  onReferenceImageChange: (nodeId: string) => void;
  onSourceKindChange: (next: DirectorImageSourceKind) => void;
  onSubmit: () => void;
  onFocusUpstream: (nodeId: string) => void;
  onDetachUpstream: (nodeId: string) => void;
}

// 生成入口属于已连线的 ThreeDWorldNode：图片节点右侧 + 负责表达画布关系，
// 本节点负责把上游图片提交成 3DGS source。这里保留引用、错误和历史信息，
// 避免把 source 类型下拉误当成导演世界 source 选择器。
function OpsPanel({
  isGenerating,
  hasUpstream,
  billingRuleMissing,
  creditCostDisplay,
  creditPromotion,
  errorMessage,
  sourceKind,
  referenceImages,
  selectedReferenceNodeId,
  referenceImage,
  referenceText,
  onReferenceImageChange,
  onSourceKindChange,
  onSubmit,
  onFocusUpstream,
  onDetachUpstream,
}: OpsPanelProps) {
  const { t } = useTranslation();
  if (!referenceImage && !referenceText && !errorMessage) {
    return null;
  }
  return (
    <div
      className={`nodrag nopan nowheel flex flex-col gap-2 rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS} p-3 text-text-dark`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      {referenceImage || referenceText ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {referenceImages.length > 1 ? (
            <label
              className="inline-flex h-8 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[11px] text-text-muted"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <select
                value={selectedReferenceNodeId ?? referenceImage?.nodeId ?? ''}
                onChange={(event) => onReferenceImageChange(event.target.value)}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                className="nodrag max-w-[160px] bg-transparent text-[11px] text-text-muted focus:text-text-dark focus:outline-none"
              >
                {referenceImages.map((item, index) => (
                  <option key={item.nodeId} value={item.nodeId} className="bg-surface-dark text-text-dark">
                    {item.displayName || `图片 ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {referenceImage ? (
            <ReferenceImageThumb
              item={referenceImage}
              onFocus={onFocusUpstream}
              onDetach={onDetachUpstream}
            />
          ) : null}
          {referenceText ? (
            <ReferenceTextChip
              nodeId={referenceText.nodeId}
              text={referenceText.text}
              sourceLabel={referenceText.displayName}
              onDetach={onDetachUpstream}
              onFocus={onFocusUpstream}
            />
          ) : null}
        </div>
      ) : null}

      {errorMessage ? (
        <div className={`max-h-24 overflow-y-auto ${NODE_INLINE_ERROR_MESSAGE_CLASS}`}>
          {errorMessage}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <label
          className="inline-flex h-7 items-center gap-1 rounded-full border border-white/20 bg-white/[0.08] pl-2.5 pr-1 text-[11px] text-text-dark/90 transition-colors hover:border-white/30 hover:bg-white/[0.12] hover:text-text-dark"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <select
            value={sourceKind}
            onChange={(event) => onSourceKindChange(event.target.value as DirectorImageSourceKind)}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            className="nodrag bg-transparent pr-1 text-[11px] text-text-dark/90 focus:text-text-dark focus:outline-none"
          >
            {DIRECTOR_IMAGE_SOURCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value} className="bg-surface-dark text-text-dark">
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </label>
        <CreditCostPill
          display={creditCostDisplay}
          promotion={creditPromotion}
          disabled={isGenerating || !hasUpstream || billingRuleMissing}
          className={NODE_CREDIT_PILL_FLAT_CLASS}
        />
        <button
          type="button"
          disabled={isGenerating || !hasUpstream || billingRuleMissing}
          onClick={(event) => {
            event.stopPropagation();
            onSubmit();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          title={
            billingRuleMissing
              ? t('common.billingRuleNotConfiguredShort')
              : hasUpstream
                ? t('nodeToolbar.generateDirectorWorld')
                : t('nodeToolbar.connectImageSource')
          }
          aria-label={t('nodeToolbar.generateDirectorWorld')}
          className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
            isGenerating || !hasUpstream || billingRuleMissing
              ? NODE_GENERATE_BUTTON_DISABLED_CLASS
              : NODE_GENERATE_BUTTON_ENABLED_CLASS
          }`}
        >
          {isGenerating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ArrowUp className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
}

interface HistoryPanelProps {
  records: FreezoneGenerationHistoryRecord[];
  isLoading: boolean;
  onRestore: (record: FreezoneGenerationHistoryRecord) => void;
  onRefresh: () => void;
  currentPlyUrl?: string | null;
  previewThumbnailUrl?: string | null;
}

function HistoryPanel({
  records,
  isLoading,
  onRestore,
  onRefresh,
  currentPlyUrl,
  previewThumbnailUrl,
}: HistoryPanelProps) {
  if (!isLoading && records.length === 0) return null;
  return (
    <div
      className={`nodrag nopan nowheel rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS} p-3 text-text-dark`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <NodeGenerationHistory
        records={records}
        isLoading={isLoading}
        onRestore={onRestore}
        onRefresh={onRefresh}
        isActive={(record) => {
          const plyUrl = pickPlyUrlFromResult(record.result);
          return Boolean(plyUrl) && plyUrl === currentPlyUrl;
        }}
        fallbackThumbnailUrl={previewThumbnailUrl}
      />
    </div>
  );
}

export const ThreeDWorldNode = memo(({ id, data, selected, width, height }: ThreeDWorldNodeProps) => {
  const { t } = useTranslation();
  const worldCreditCost = useGenerationCreditCost(
    'feature',
    'freezone.image_to_3gs',
    {
      surface: 'canvas',
      params: {
        operation:
          data.plyKind === 'pano' || data.plyKind === 'master'
            ? data.plyKind
            : 'master',
      },
    },
  );
  const worldBillingRuleMissing =
    worldCreditCost.error instanceof BillingRuleNotConfiguredError;
  const worldCreditCostDisplay =
    worldCreditCost.data?.data.display ??
    (worldBillingRuleMissing
      ? t('common.billingRuleNotConfiguredShort')
      : null);
  const updateNodeInternals = useUpdateNodeInternals();
  // 入口按钮的循环动效在低缩放档下只有几十像素宽，看不出是动的，却要每帧上传
  // 一次视频纹理。选择器返回 boolean，只在跨过阈值那一次触发重渲染。
  const lowDetailZoom = useStore((state) => isLowDetailZoom(state.transform[2]));
  const entryMotionRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = entryMotionRef.current;
    if (!video) return;
    if (lowDetailZoom) video.pause();
    else void video.play().catch(() => {});
  }, [lowDetailZoom]);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addPanoCaptureGroup = useCanvasStore((state) => state.addPanoCaptureGroup);
  // Subscribe to ONLY one-hop upstream (not the whole nodes array) so unrelated
  // node drags don't re-render this node. See useUpstreamGraph.
  const upstreamNodes = useUpstreamNodes(id);
  const detachUpstream = useDetachUpstream(id);
  const captureCanvasNodeBusyRef = useRef(false);

  const resolvedWidth = resolveNodeDimension(width, 340);
  const resolvedHeight = resolveNodeDimension(height, 210);

  // Per-node history of image-to-3gs runs; only fetched while selected.
  const {
    records: historyRecords,
    isLoading: historyLoading,
    refresh: refreshHistory,
  } = useNodeGenerationHistory(id, { enabled: Boolean(selected) });

  const handleRestoreHistory = useCallback(
    (record: FreezoneGenerationHistoryRecord) => {
      // 3GS results nest the PLY url under various keys — reuse the same
      // extractor the live submit path uses.
      const plyUrl = pickPlyUrlFromResult(record.result);
      if (!plyUrl) return;
      updateNodeData(id, {
        plyUrl,
        isGenerating: false,
        taskKey: null,
        errorMessage: null,
      });
    },
    [id, updateNodeData],
  );

  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.threeDWorld, data),
    [data],
  );
  const headerTitle = resolvedTitle === '3D 世界'
    ? t('viewer.threeD.directorWorld')
    : resolvedTitle;

  const upstreamRefs = useMemo<UpstreamRef[]>(() => {
    const sources = [...upstreamNodes];
    sources.sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0));
    const refs: UpstreamRef[] = [];
    for (const node of sources) {
      const ref = upstreamRef(node);
      if (ref) refs.push(ref);
    }
    return refs;
  }, [upstreamNodes]);

  const upstreamImageRefs = useMemo(
    () => upstreamRefs.filter((ref) => ref.kind === 'image' && ref.imageUrl),
    [upstreamRefs],
  );
  const selectedUpstreamImageRef = useMemo<UpstreamRef | null>(() => {
    if (upstreamImageRefs.length === 0) return null;
    const selected = typeof data.sourceNodeId === 'string'
      ? upstreamImageRefs.find((ref) => ref.nodeId === data.sourceNodeId)
      : null;
    return selected ?? upstreamImageRefs[0] ?? null;
  }, [data.sourceNodeId, upstreamImageRefs]);
  const upstreamTextRef = useMemo(
    () => upstreamRefs.find((ref) => ref.kind === 'text' && ref.textContent) ?? null,
    [upstreamRefs],
  );
  const upstream = selectedUpstreamImageRef ?? upstreamTextRef;
  const referenceImages = useMemo<ReferenceImageRef[]>(
    () =>
      upstreamImageRefs
        .filter((ref): ref is UpstreamRef & { imageUrl: string } => typeof ref.imageUrl === 'string')
        .map((ref) => ({
          nodeId: ref.nodeId,
          url: ref.imageUrl,
          displayName: ref.displayName,
        })),
    [upstreamImageRefs],
  );

  const upstreamPanoSources = useMemo<DirectorWorldSource[]>(() => {
    const sources: DirectorWorldSource[] = [];
    for (const node of upstreamNodes) {
      const source = directorPanoSourceFromCanvasNode(node);
      if (source) sources.push(source);
    }
    return sources;
  }, [upstreamNodes]);

  const { isGenerating } = useNodeGenerationTaskState(data);

  // 节点未就绪时显示占位；hover/激活时整体高亮。
  const containerStyle: CSSProperties = {
    width: resolvedWidth,
    height: resolvedHeight,
  };

  const handleNodeClick = useCallback(() => {
    setSelectedNode(id);
  }, [id, setSelectedNode]);

  const contexts = useMemo(
    () => validMainlineContexts((data as { mainline_context?: unknown }).mainline_context),
    [data],
  );
  const sceneDirectorWorld = isSceneDirectorWorldNode(data);
  const beatContext = useMemo(() => {
    if (sceneDirectorWorld) return null;
    for (const ctx of contexts) {
      if (typeof ctx.episode === 'number' && typeof ctx.beat === 'number') {
        return { episode: ctx.episode, beat: ctx.beat };
      }
    }
    return null;
  }, [contexts, sceneDirectorWorld]);
  const [directorBusy, setDirectorBusy] = useState(false);
  const [directorDialogOpen, setDirectorDialogOpen] = useState(false);
  const [directorManifest, setDirectorManifest] = useState<DirectorStageManifest | null>(null);

  const handleOpenDirector = useCallback(async () => {
    const projectId = readUrl().project;
    if (!projectId) return;
    setDirectorBusy(true);
    try {
      let manifest: DirectorStageManifest | null = null;
      if (beatContext) {
        try {
          manifest = await getBeatDirectorStageManifest(projectId, beatContext.episode, beatContext.beat);
          manifest = mergeDirectorStageManifestSources(
            manifest,
            directorSourcesForNode(data, upstreamPanoSources),
          );
        } catch (error) {
          console.warn('[3d-world] beat director manifest unavailable, falling back to node PLY', error);
        }
      }
      let defaultPalette: DirectorStageManifest['palette'] | null = null;
      if (!manifest) {
        try {
          defaultPalette = await getDirectorStagePalette(projectId);
        } catch (error) {
          console.warn('[3d-world] default director palette unavailable', error);
        }
      }
      manifest ??= buildLocalDirectorManifest({
        project: projectId,
        data,
        contexts,
        beatContext,
        upstreamPanoSources,
        defaultPalette,
      });
      setDirectorManifest(manifest);
      setDirectorDialogOpen(Boolean(manifest));
    } catch (err) {
      console.error('[3d-world] director dialog open failed', err);
    } finally {
      setDirectorBusy(false);
    }
  }, [beatContext, contexts, data, upstreamPanoSources]);

  const sourceNodeForGeneration = useMemo(() => {
    if (upstream?.kind !== 'image') return null;
    return upstreamNodes.find((node) => node.id === upstream.nodeId) ?? null;
  }, [upstream, upstreamNodes]);
  const inferredImageSourceKind: DirectorImageSourceKind = (() => {
    if (!sourceNodeForGeneration) return 'master';
    if (isPanoImageCanvasNode(sourceNodeForGeneration)) return 'pano';
    return 'master';
  })();
  const selectedImageSourceKind: DirectorImageSourceKind =
    data.plyKind === 'pano' || data.plyKind === 'master'
      ? data.plyKind
      : inferredImageSourceKind;

  const handleSubmit = useCallback(async () => {
    const projectId = readUrl().project;
    const sourceNode = sourceNodeForGeneration;
    if (!projectId) {
      updateNodeData(id, { errorMessage: '无法识别当前项目' });
      return;
    }
    if (!upstream) return;
    if (isGenerating) return;
    if (upstream.kind === 'text') {
      updateNodeData(id, {
        errorMessage: '文生 3D 模型尚未对接，请连接图片节点',
      });
      return;
    }
    if (!sourceNode) return;
    const sourceUrl = imageUrlFromCanvasNode(sourceNode);
    if (!sourceUrl) return;

    const sourceKind = imageTo3gsKindForSource(sourceNode, selectedImageSourceKind);
    const rawPanoSource = sourceKind === 'pano'
      ? directorPanoSourceFromCanvasNode(sourceNode) ?? {
          id: `upstream-pano:${sourceNode.id}`,
          source_type: 'pano360' as const,
          source_kind: 'pano' as const,
          label: '360 图',
          url: sourceUrl,
          pano_url: sourceUrl,
          slot_kind: 'scene_director_pano_360' as const,
        }
      : null;

    updateNodeData(id, {
      isGenerating: true,
      generationStartedAt: Date.now(),
      errorMessage: null,
      sourceNodeId: sourceNode.id,
      sourceKind: 'image',
      plyKind: sourceKind,
      previewImageUrl: sourceUrl,
      ...(rawPanoSource
        ? {
            sources: mergeDirectorWorldSources(data.sources ?? [], rawPanoSource),
            activeSourceId: rawPanoSource.id ?? null,
            panoUrl: rawPanoSource.pano_url ?? rawPanoSource.url ?? null,
          }
        : {}),
    });

    try {
      const ref = await submitFreezoneImageTo3GS(projectId, {
        sourceUrl,
        sourceKind,
        canvasId: readUrl().canvas ?? 'default',
        nodeId: id,
      });
      updateNodeData(id, { taskKey: ref.task_key, ...generationTaskDescriptor(ref) });
      const completed = await awaitTaskCompletion(ref.task_key, projectId, { taskType: ref.task_type });
      const generatedSource = sourceFromImageTo3gsResult(completed.result, {
        id: `generated-sog:${sourceKind}:${Date.now()}`,
        sourceKind,
        label:
          sourceKind === 'pano'
            ? '360 3DGS'
            : '图片 3DGS',
      });
      if (!generatedSource) {
        throw new Error('未能在 task.result 中找到 3D 世界地址');
      }
      const currentWorld = useCanvasStore.getState().nodes.find((node) => node.id === id);
      const currentSources = (
        (currentWorld?.data as { sources?: DirectorWorldSource[] } | undefined)?.sources ?? []
      );
      updateNodeData(id, {
        sources: mergeDirectorWorldSources(currentSources, rawPanoSource, generatedSource),
        activeSourceId: generatedSource.id ?? null,
        plyUrl: generatedSource.ply_url ?? generatedSource.url ?? null,
        panoUrl: rawPanoSource?.pano_url ?? rawPanoSource?.url ?? null,
        isGenerating: false,
        taskKey: null,
        errorMessage: null,
      });
    } catch (error) {
      // 轮询超时 ≠ 生成失败：后端还在跑，节点上的任务句柄仍可续接。
      // 写错误横幅会把一个还活着的任务标成失败，并清掉句柄。
      if (isTaskPollTimeoutError(error)) {
        notifyTaskStillRunning(t);
        return;
      }
      updateNodeData(id, {
        isGenerating: false,
        taskKey: null,
        errorMessage: `生成失败: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      void refreshHistory();
    }
  }, [
    data.sources,
    id,
    isGenerating,
    refreshHistory,
    selectedImageSourceKind,
    sourceNodeForGeneration,
    t,
    updateNodeData,
    upstream,
  ]);

  const handleCaptureSelectedBackground = useCallback(
    async (blob: Blob) => {
      if (!beatContext) {
        throw new Error('当前不在镜头上下文中，不能设置当前背景');
      }
      await uploadAndAutoCommitSelectedBackgroundCandidate(
        { episode: beatContext.episode, beat: beatContext.beat },
        blob,
        `background_3gs_${Date.now()}.png`,
        {
          sourceNodeId: id,
          label: t("viewer.threeD.selectedBackgroundOutputLabel"),
          successMessage: t("viewer.threeD.selectedBackgroundCommitSuccess", {
            episode: beatContext.episode,
            beat: beatContext.beat,
          }),
        },
      );
      updateNodeData(id, { errorMessage: null });
    },
    [beatContext, id, t, updateNodeData],
  );

  const handleSubmitDirectorCombined = useCallback(
    async (_blob: Blob, meta: ThreeDDirectorCaptureMeta) => {
      if (!beatContext) return;
      const projectId = readUrl().project;
      if (!projectId) {
        throw new Error('缺少项目，无法保存画布导演合成图');
      }
      if (!meta.captureBundle) {
        throw new Error('导演合成图缺少 combined/env_only/frame_meta');
      }
      const bundle = await uploadDirectorCaptureBundle(projectId, id, meta.captureBundle);
      const imageUrl = bundle.urls?.combined ?? '';
      if (!imageUrl) throw new Error('画布导演合成图缺少图片地址');
      updateNodeData(id, {
        previewImageUrl: withImageCacheBust(imageUrl, Date.now()),
        director_control_bundle: bundle,
        slot_target: {
          kind: 'director_render',
          episode: beatContext.episode,
          beat: beatContext.beat,
        },
        scene: meta.snapshot,
        errorMessage: null,
      });
    },
    [beatContext, id, updateNodeData],
  );

  const handleCaptureCanvasNode = useCallback(
    async (blob: Blob, meta: ThreeDDirectorCaptureMeta) => {
      if (captureCanvasNodeBusyRef.current) return;
      captureCanvasNodeBusyRef.current = true;
      try {
        const projectId = readUrl().project;
        if (projectId && meta.captureBundle) {
          const bundle = await uploadDirectorCaptureBundle(projectId, id, meta.captureBundle);
          const [combinedDataUrl, envOnlyDataUrl] = await Promise.all([
            blobToDataUrl(meta.captureBundle.combined),
            blobToDataUrl(meta.captureBundle.env_only),
          ]);
          const [combinedSize, envOnlySize] = await Promise.all([
            imageSize(combinedDataUrl),
            imageSize(envOnlyDataUrl),
          ]);
          const baseMetadata = {
            viewer: 'director_world',
            source_kind: meta.source.source_kind,
            snapshot: meta.snapshot,
            director_control_bundle: bundle,
          };
          const groupId = addPanoCaptureGroup(
            id,
            [
              {
                dataUrl: combinedDataUrl,
                uploadedUrl: bundle.urls?.combined ?? '',
                width: combinedSize.width,
                height: combinedSize.height,
                label: '导演合成图',
                metadata: {
                  ...baseMetadata,
                  render_mode: 'combined',
                },
              },
              {
                dataUrl: envOnlyDataUrl,
                uploadedUrl: bundle.urls?.env_only ?? '',
                width: envOnlySize.width,
                height: envOnlySize.height,
                label: '纯背景图',
                metadata: {
                  ...baseMetadata,
                  render_mode: 'env_only',
                },
              },
            ],
            { cols: 2, groupName: '导演世界输出' },
          );
          updateNodeData(id, {
            scene: meta.snapshot,
            errorMessage: groupId ? null : '导演世界截图输出到画布失败',
          });
          if (groupId) {
            toast.success(t('viewer.threeD.outputToCanvasNodeSuccess'));
          }
          return;
        }
        const dataUrl = await blobToDataUrl(blob);
        const size = await imageSize(dataUrl);
        const uploadedUrl = await uploadLocalImageToBackend(
          dataUrl,
          `3gs-${id}-${meta.kind}-${Date.now()}.png`,
        );
        const groupId = addPanoCaptureGroup(id, [
          {
            dataUrl,
            uploadedUrl,
            width: size.width,
            height: size.height,
            label: `导演世界 ${meta.kind}`,
            metadata: {
              viewer: '3gs',
              render_mode: meta.kind,
              source_kind: meta.source.source_kind,
              snapshot: meta.snapshot,
            },
          },
        ]);
        updateNodeData(id, {
          scene: meta.snapshot,
          errorMessage: groupId ? null : '导演世界截图输出到画布失败',
        });
        if (groupId) {
          toast.success(t('viewer.threeD.outputToCanvasNodeSuccess'));
        }
      } finally {
        captureCanvasNodeBusyRef.current = false;
      }
    },
    [addPanoCaptureGroup, id, t, updateNodeData],
  );

  // 「保存 3D 世界」:把导演台摆好的场景快照写回本节点 data.scene(useCanvasSync 自动持久化)。
  const handleSaveScene = useCallback(
    async (snapshot: ThreeDSceneSnapshot, activeSourceId?: string) => {
      const snapshotSourceId = typeof snapshot.world?.activeSourceId === 'string'
        ? snapshot.world.activeSourceId
        : undefined;
      const nextActiveSourceId = activeSourceId || snapshotSourceId;
      const previousScenes = data.scenesBySourceId ?? {};
      const sourceTransform = snapshot.world?.sourceTransform;
      const nextDirectorSources = directorSourcesForNode(data, upstreamPanoSources);
      const nextSources = nextActiveSourceId && sourceTransform
        ? nextDirectorSources.map((source) =>
            source.id === nextActiveSourceId
              ? { ...source, transform: sourceTransform }
              : source,
          )
        : null;
      updateNodeData(id, {
        scene: snapshot,
        ...(nextActiveSourceId
          ? {
              scenesBySourceId: {
                ...previousScenes,
                [nextActiveSourceId]: snapshot,
              },
            }
          : {}),
        ...(nextActiveSourceId ? { activeSourceId: nextActiveSourceId } : {}),
        ...(nextSources ? { sources: nextSources } : {}),
      });
    },
    [data, id, updateNodeData, upstreamPanoSources],
  );

  const handleRegisterSaveSceneHandler = useCallback(
    (handler: (() => Promise<void>) | null) => {
      setDirectorWorldSceneSaveHandler(id, handler);
    },
    [id],
  );

  useEffect(() => {
    return () => setDirectorWorldSceneSaveHandler(id, null);
  }, [id]);

  const handleClearScene = useCallback(async (activeSourceId?: string) => {
    if (!activeSourceId) {
      updateNodeData(id, { scene: null, scenesBySourceId: {} });
      return;
    }
    const nextScenesBySourceId = { ...(data.scenesBySourceId ?? {}) };
    delete nextScenesBySourceId[activeSourceId];
    const currentScene = data.scene && typeof data.scene === 'object'
      ? data.scene as { world?: { activeSourceId?: unknown } }
      : null;
    const currentSceneSourceId = typeof currentScene?.world?.activeSourceId === 'string'
      ? currentScene.world.activeSourceId
      : undefined;
    updateNodeData(id, {
      scene: currentSceneSourceId === activeSourceId ? null : data.scene ?? null,
      scenesBySourceId: nextScenesBySourceId,
    });
  }, [data, id, updateNodeData]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  const hasUpstream = Boolean(upstream);
  const hasPly = Boolean(data.plyUrl);
  const hasPanoSource = Boolean(data.panoUrl);
  const hasDirectorSources = Boolean(data.sources?.length);
  const hasWorldSource = hasPly || hasPanoSource || hasDirectorSources || upstreamPanoSources.length > 0;
  const hasMainlineContext =
    (data as { user_spawned?: unknown }).user_spawned !== true &&
    hasMainlineContexts((data as { mainline_context?: unknown }).mainline_context);
  const upstreamThumb =
    hasWorldSource && upstream?.kind === 'image' && upstream.imageUrl
      ? upstream.imageUrl
      : null;
  const fallbackThumb = usableDirectorWorldPreviewUrl(data.previewImageUrl);
  const slotTarget = data.slot_target as { kind?: unknown } | null | undefined;
  const isDirectorRenderNode =
    Boolean((data as { director_control_bundle?: unknown }).director_control_bundle) ||
    slotTarget?.kind === 'director_render';
  const previewThumb = isDirectorRenderNode ? fallbackThumb ?? upstreamThumb : upstreamThumb ?? fallbackThumb;
  const hasPreviewThumb = Boolean(previewThumb);

  return (
    <div
      className={`
        director-world-node group relative overflow-visible rounded-[var(--node-radius)] border bg-[#0f0f0f] p-0 transition-colors duration-150
        ${canvasNodeFrameClass({ selected, mainline: hasMainlineContext })}
        ${selected ? '' : 'border-white/18 hover:border-white/26'}
      `}
      style={containerStyle}
      onClick={handleNodeClick}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Orbit className="h-4 w-4" />}
        titleText={headerTitle}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />
      <NodeContextBadges
        contexts={(data as { mainline_context?: unknown }).mainline_context}
      />

      {/* 预览区：PLY 就绪前显示 Saturn 占位（上游内容只以「引用」形式出现在 OpsPanel
          输入框上方）；PLY 就绪后用上游图片作为节点缩略图。生成中叠一层 spinner，
          风格对齐 ImageNode / VideoNode。Phase 2 接 inline 3D viewer 后再替换为内嵌渲染。 */}
      <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[var(--node-radius)] bg-[#0f0f0f] text-text-muted/60">
        {previewThumb ? (
          <img
            src={resolveImageDisplayUrl(previewThumb)}
            alt="导演世界缩略图"
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : null}
        {isGenerating ? (
          <NodeGenerationOverlay
            startedAt={data.generationStartedAt ?? null}
            hasBackground={hasPreviewThumb}
          />
        ) : null}
      </div>

      {/* Empty state keeps the cinematic entry; content state uses a compact corner action. */}
      {!hasPreviewThumb ? (
        <div className="nodrag absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void handleOpenDirector();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            className="director-entry-press-button inline-flex items-center justify-center bg-transparent p-0 disabled:opacity-70"
            style={{ width: 156 }}
            disabled={directorBusy}
            title={t('viewer.threeD.openDirectorWorldTitle')}
            aria-label={directorBusy ? t('viewer.threeD.openingDirectorWorld') : t('viewer.threeD.enterDirectorWorld')}
          >
            <video
              ref={entryMotionRef}
              src="/images/btnmotion.mp4"
              className="block h-auto select-none"
              style={{ width: '100%' }}
              autoPlay={!lowDetailZoom}
              loop
              muted
              playsInline
              aria-hidden="true"
            />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void handleOpenDirector();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          className="nodrag absolute right-2 top-2 z-20 inline-flex h-6 items-center rounded-full bg-black/45 px-2.5 text-[10px] font-medium text-white/90 backdrop-blur-md transition-colors hover:bg-black/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
          disabled={directorBusy}
          title={t('viewer.threeD.openDirectorWorldTitle')}
          aria-label={directorBusy ? t('viewer.threeD.openingDirectorWorld') : t('viewer.threeD.enterDirectorWorld')}
        >
          {directorBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
          <span>进入导演世界</span>
        </button>
      )}

      {selected ? (
        <div
          className="absolute z-10 flex flex-col gap-3"
          style={{
            top: `calc(100% + ${PANEL_GAP_PX}px)`,
            left: -PANEL_OVERHANG_PX,
            right: -PANEL_OVERHANG_PX,
          }}
        >
          <OpsPanel
            isGenerating={isGenerating}
            hasUpstream={hasUpstream}
            billingRuleMissing={worldBillingRuleMissing}
            creditCostDisplay={worldCreditCostDisplay}
            creditPromotion={worldCreditCost.data?.data.promotion}
            errorMessage={data.errorMessage}
            sourceKind={selectedImageSourceKind}
            referenceImages={referenceImages}
            selectedReferenceNodeId={selectedUpstreamImageRef?.nodeId ?? null}
            referenceImage={
              upstream?.kind === 'image' && upstream.imageUrl
                ? { nodeId: upstream.nodeId, url: upstream.imageUrl, displayName: upstream.displayName }
                : null
            }
            referenceText={
              upstream?.kind === 'text' && upstream.textContent
                ? {
                  nodeId: upstream.nodeId,
                  text: upstream.textContent,
                  displayName: upstream.displayName,
                }
                : null
            }
            onReferenceImageChange={(nodeId) => {
              const node = upstreamNodes.find((item) => item.id === nodeId) ?? null;
              const nextKind: DirectorImageSourceKind = node && isPanoImageCanvasNode(node)
                ? 'pano'
                : 'master';
              updateNodeData(id, { sourceNodeId: nodeId, plyKind: nextKind });
            }}
            onSourceKindChange={(next) => updateNodeData(id, { plyKind: next })}
            onSubmit={handleSubmit}
            onFocusUpstream={setSelectedNode}
            onDetachUpstream={detachUpstream}
          />
          <HistoryPanel
            records={historyRecords}
            isLoading={historyLoading}
            onRestore={handleRestoreHistory}
            currentPlyUrl={data.plyUrl ?? null}
            previewThumbnailUrl={usableDirectorWorldPreviewUrl(data.previewImageUrl)}
            onRefresh={() => void refreshHistory()}
          />
        </div>
      ) : null}

      <Handle
        type="target"
        id="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-[rgb(148,163,184)]"
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-[rgb(148,163,184)]"
      />
      <NodeResizeHandle
        minWidth={280}
        minHeight={170}
        maxWidth={1200}
        maxHeight={900}
      />
      <ThreeDDirectorDialog
        open={directorDialogOpen}
        onOpenChange={setDirectorDialogOpen}
        manifest={directorManifest}
        title={t('viewer.threeD.directorWorld')}
        viewerPurpose={beatContext ? 'beat' : 'freezone'}
        onCaptureSelectedBackground={beatContext ? handleCaptureSelectedBackground : undefined}
        onSubmitDirectorCombined={beatContext ? handleSubmitDirectorCombined : undefined}
        onCaptureCanvasNode={handleCaptureCanvasNode}
        initialScene={
          (data.scene as ThreeDSceneSnapshot | null) ??
          (directorManifest?.scene as ThreeDSceneSnapshot | null | undefined) ??
          null
        }
        initialScenesBySourceId={
          mergeDirectorSavedSceneMaps(
            data.scenesBySourceId as Record<string, ThreeDSceneSnapshot> | null | undefined,
            directorManifest?.scenes_by_source_id as Record<string, ThreeDSceneSnapshot> | null | undefined,
          )
        }
        onSaveScene={handleSaveScene}
        registerSaveSceneHandler={handleRegisterSaveSceneHandler}
        onClearScene={handleClearScene}
      />
    </div>
  );
});

ThreeDWorldNode.displayName = 'ThreeDWorldNode';
