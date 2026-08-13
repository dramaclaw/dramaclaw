// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { Boxes, Camera, Crop, FileText, Loader2, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { uploadFreezoneImage } from '@/api/ops';
import {
  getSceneAssetsForBeat,
  type SceneAssetsForBeat,
} from '@/api/sceneAssets';
import { getBeatDirectorStageManifest } from '@/api/viewerManifests';
import {
  getSkillRegistry,
  getSkillRunResult,
  runSkill,
  type SkillErrorEnvelope,
  type SkillRunOutput,
  type SkillRunResult,
} from '@/api/skills';
import { awaitTaskCompletion } from '@/api/tasks';
import {
  stageSelectedBackgroundOutputForSkill,
} from '@/features/canvas/application/selectedBackgroundSlot';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import {
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
  type SkillNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { isSystemManagedNodeData } from '@/features/canvas/domain/mainlineNodeFlags';
import { BackgroundCropperDialog } from '@/features/canvas/ui/BackgroundCropperDialog';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NODE_INLINE_ERROR_MESSAGE_CLASS } from '@/features/canvas/ui/nodeControlStyles';
import {
  normalizedSkillParameters,
  skillParameterEntries,
} from '@/features/canvas/nodes/skillNodeParameters';
import {
  ThreeDDirectorDialog,
  type ThreeDDirectorCaptureMeta,
} from '@/features/viewer-kit/three-d/ThreeDDirectorDialog';
import type {
  DirectorControlFrameBundle,
  DirectorStageManifest,
  DirectorWorldSource,
} from '@/features/viewer-kit/three-d/directorManifest';
import { isSkillReadyToSubmit, resolveInputsForSkill } from '@/features/freezone/context/skillNodeInputs';
import { getCurrentBeatContextFromNode } from '@/features/freezone/context/currentBeatContext';
import {
  nodeDataForOutput,
  nodeTypeForOutput,
  outputLabel,
  outputText,
} from '@/features/freezone/context/skillNodeOutputs';
import type {
  SkillDefinition,
  SkillInputRole,
  SkillProvider,
} from '@/features/freezone/context/skillRoles';
import {
  translateSkillDescription,
  translateSkillCardinality,
  translateSkillInputLabel,
  translateSkillName,
  translateSkillOutputLabel,
  translateSkillParameterLabel,
  translateSkillParameterOption,
  translateSkillRequirement,
} from '@/features/freezone/context/skillI18n';
import type { MainlineContext } from '@/features/freezone/context/mainlineContext';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';
import { useShallow } from 'zustand/react/shallow';
import { isActive as isActiveTask } from '@/task-center/derivations';
import { useTaskCenterStore } from '@/task-center/store';
import type { TaskState } from '@/task-center/types';

type SkillNodeProps = NodeProps & {
  id: string;
  data: SkillNodeData;
  selected?: boolean;
};

type DirectorWorldDestination = 'selected_background' | 'director_combined';

const DEFAULT_WIDTH = 380;
const OUTPUT_X_OFFSET = 460;
const OUTPUT_Y_SPACING = 260;
const RESULT_POLL_DELAY_MS = 700;
const RESULT_POLL_ATTEMPTS = 30;
const TASK_RECORD_GRACE_MS = 5000;
const SELECTED_BACKGROUND_CROP_ASPECT_OPTIONS = ['2:3', '16:9'] as const;
const PROVIDER_LABELS: Record<SkillProvider, string> = {
  freezone_mainline: '主线技能',
  agent: 'Agent 技能',
  tool: '工具技能',
  workflow: '工作流技能',
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function skillInputSignature(inputs: unknown): string {
  return hashString(stableStringify(inputs));
}

function createSkillRunNonce(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function skillRunIdempotencyKey(
  canvasId: string,
  nodeId: string,
  skillId: string,
  inputSignature: string,
  runNonce: string,
): string {
  return `skill:${canvasId}:${nodeId}:${skillId}:${inputSignature}:${runNonce}`;
}

function taskStatusLabelKey(task: TaskState | null, submitting: boolean, waitingForTaskRecord: boolean): string {
  if (submitting) {
    return 'viewer.threeD.skillStatus.generating';
  }
  if (waitingForTaskRecord) {
    return 'viewer.threeD.skillStatus.generating';
  }
  if (!task) {
    return 'viewer.threeD.skillStatus.submit';
  }
  if (task.status === 'queued' || task.status === 'pending') {
    return 'viewer.threeD.skillStatus.queued';
  }
  if (task.status === 'starting') {
    return 'viewer.threeD.skillStatus.starting';
  }
  if (task.status === 'running' || task.status === 'submitting') {
    return 'viewer.threeD.skillStatus.running';
  }
  return 'viewer.threeD.skillStatus.submit';
}

function handleTop(index: number, count: number): string {
  return `${((index + 1) / (count + 1)) * 100}%`;
}

function roleFromEdge(edge: CanvasEdge): string | null {
  const handleRole = typeof edge.targetHandle === 'string' ? edge.targetHandle.trim() : '';
  if (handleRole) {
    return handleRole.split(':', 1)[0];
  }
  const dataRole = (edge.data as { role?: unknown } | undefined)?.role;
  return typeof dataRole === 'string' && dataRole.trim() ? dataRole.trim() : null;
}

function outputRoleFromEdge(edge: CanvasEdge): string | null {
  const handleRole = typeof edge.sourceHandle === 'string' ? edge.sourceHandle.trim() : '';
  if (handleRole) {
    return handleRole;
  }
  const dataRole = (edge.data as { role?: unknown } | undefined)?.role;
  return typeof dataRole === 'string' && dataRole.trim() ? dataRole.trim() : null;
}

function resolvePreviewUrl(node: CanvasNode | undefined): string | null {
  if (!node) return null;
  const data = node.data as {
    imageUrl?: unknown;
    previewImageUrl?: unknown;
    referenceImageUrl?: unknown;
  };
  for (const value of [data.imageUrl, data.previewImageUrl, data.referenceImageUrl]) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return null;
}

function resolveSourceLabel(node: CanvasNode | undefined, missingLabel: string): string {
  if (!node) return missingLabel;
  const data = node.data as { displayName?: unknown; label?: unknown; content?: unknown; prompt?: unknown };
  for (const value of [data.displayName, data.label, data.content, data.prompt]) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return node.type;
}

function findBoundEdges(edges: CanvasEdge[], role: SkillInputRole): CanvasEdge[] {
  return edges.filter((edge) => roleFromEdge(edge) === role);
}

function nonEmptyHandleId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isReferenceInputRole(role: string): role is 'identity' | 'prop' {
  return role === 'identity' || role === 'prop';
}

function isNoReferenceHandle(handleId: string | null, role?: 'identity' | 'prop'): boolean {
  if (!handleId) return false;
  return (
    (handleId === 'identity:__NO_CHARACTER__' && (!role || role === 'identity')) ||
    (handleId === 'prop:__NO_PROP__' && (!role || role === 'prop'))
  );
}

function isNoReferenceEdge(edge: CanvasEdge, role: SkillInputRole): boolean {
  if (!isReferenceInputRole(role)) return false;
  const handleId = nonEmptyHandleId(edge.targetHandle);
  if (isNoReferenceHandle(handleId, role)) {
    return true;
  }
  const referenceTarget = (
    edge.data && typeof edge.data === 'object' && !Array.isArray(edge.data)
      ? (edge.data as Record<string, unknown>).reference_target
      : undefined
  );
  if (!referenceTarget || typeof referenceTarget !== 'object' || Array.isArray(referenceTarget)) {
    return false;
  }
  const target = referenceTarget as Record<string, unknown>;
  return role === 'identity'
    ? target.identity_id === '__NO_CHARACTER__'
    : target.prop_id === '__NO_PROP__';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isDoneStatus(status: string): boolean {
  return ['done', 'completed', 'succeeded', 'success'].includes(status.toLowerCase());
}

function isFailureStatus(status: string): boolean {
  return ['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status.toLowerCase());
}

async function awaitSkillRunResult(projectId: string, runId: string): Promise<SkillRunResult> {
  let latest: SkillRunResult | null = null;
  for (let attempt = 0; attempt < RESULT_POLL_ATTEMPTS; attempt += 1) {
    latest = await getSkillRunResult(projectId, runId);
    if (isDoneStatus(latest.status) || isFailureStatus(latest.status)) {
      return latest;
    }
    await delay(RESULT_POLL_DELAY_MS);
  }
  throw new Error(`Skill run ${runId} did not finish; latest status: ${latest?.status ?? 'unknown'}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function skillErrorMessage(error: SkillRunResult['error']): string | null {
  if (!error) {
    return null;
  }
  if (typeof error === 'string') {
    return error;
  }
  const envelope = error as SkillErrorEnvelope;
  return envelope.user_action_hint
    ? `${envelope.message} ${envelope.user_action_hint}`
    : envelope.message;
}

function selectedBackgroundTarget(output: SkillRunOutput): { episode?: unknown; beat?: unknown } | null {
  const target = output.slot_target;
  if (!target || target.kind !== 'selected_background') {
    return null;
  }
  return target;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function numericField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resolveBeatTargetFromNode(node: CanvasNode | undefined): { episode: number; beat: number } | null {
  const data = (node?.data ?? {}) as Record<string, unknown>;
  const snapshot = data.snapshot && typeof data.snapshot === 'object'
    ? data.snapshot as Record<string, unknown>
    : undefined;
  const episode =
    numericField(data.episode) ??
    numericField(snapshot?.episode) ??
    numericField(snapshot?.episode_number);
  const beat =
    numericField(data.beat) ??
    numericField(data.beat_number) ??
    numericField(snapshot?.beat) ??
    numericField(snapshot?.beat_number);
  return episode && beat ? { episode, beat } : null;
}

function beatContextListsFromNode(node: CanvasNode | undefined): {
  identities: string[];
  props: string[];
  noCharacter: boolean;
  noProp: boolean;
  visualDescription?: string;
} {
  const beatContext = getCurrentBeatContextFromNode(node);
  const uniq = (items: string[]) => Array.from(new Set(items));
  const identityItems = uniq(stringArray(beatContext?.detected_identities));
  const propItems = uniq(stringArray(beatContext?.detected_props));
  const realIdentities = (items: string[]) => items.filter((item) => item !== '__NO_CHARACTER__');
  const realProps = (items: string[]) => items.filter((item) => item !== '__NO_PROP__');
  const visual = String(beatContext?.visual_description ?? '').trim();
  return {
    identities: realIdentities(identityItems),
    props: realProps(propItems),
    noCharacter: identityItems.includes('__NO_CHARACTER__'),
    noProp: propItems.includes('__NO_PROP__'),
    visualDescription: visual || undefined,
  };
}

function referenceHandleId(role: 'identity' | 'prop', id: string): string {
  return `${role}:${id}`;
}

function labelFromReferenceHandle(handleId: string): string {
  const separator = handleId.indexOf(':');
  return separator >= 0 ? handleId.slice(separator + 1).trim() : handleId;
}

function mergeManifestWithCanvasBeatContext(
  manifest: DirectorStageManifest,
  beatContextNode: CanvasNode | undefined,
): DirectorStageManifest {
  const target = resolveBeatTargetFromNode(beatContextNode);
  const context = beatContextListsFromNode(beatContextNode);
  if (!target || (context.identities.length === 0 && context.props.length === 0 && !context.visualDescription)) {
    return manifest;
  }
  const identities = context.identities.length > 0
    ? context.identities
    : (manifest.beat_context?.detected_identities ?? []);
  const props = context.props.length > 0
    ? context.props
    : (manifest.beat_context?.detected_props ?? []);
  return {
    ...manifest,
    mode: 'beat',
    beat_context: {
      episode: target.episode,
      beat: target.beat,
      visual_description: context.visualDescription ?? manifest.beat_context?.visual_description,
      detected_identities: identities,
      detected_props: props,
    },
    palette: {
      ...manifest.palette,
      anonymous_colors: [],
    },
  };
}

function sceneAssetsFromSkillData(value: unknown): SceneAssetsForBeat | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const item = value as Record<string, unknown>;
  const normalizeUrl = (key: string): string | null => {
    const raw = item[key];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  };
  return {
    scene_id: typeof item.scene_id === 'string' && item.scene_id.trim() ? item.scene_id : null,
    master_url: normalizeUrl('master_url'),
    reverse_url: normalizeUrl('reverse_url'),
    director_env_only_url: normalizeUrl('director_env_only_url'),
    pano_360_url: normalizeUrl('pano_360_url'),
    ply_url: null,
  };
}

function directorSourceUrl(source: DirectorWorldSource): string | null {
  return source.pano_url ?? source.ply_url ?? source.url ?? null;
}

function directorControlBundleFromMeta(
  meta: ThreeDDirectorCaptureMeta | undefined,
): DirectorControlFrameBundle | null {
  const bundle = meta?.controlFrameBundle;
  if (!bundle?.rel_paths || !bundle.rel_paths.combined || !bundle.rel_paths.env_only || !bundle.rel_paths.frame_meta) {
    return null;
  }
  return bundle;
}

function directorControlBundleImageUrl(
  bundle: DirectorControlFrameBundle | null,
  kind: 'combined' | 'env_only',
): string {
  return bundle?.urls?.[kind] ?? '';
}

function manifestSourceToWorldSource(manifest: DirectorStageManifest): DirectorWorldSource {
  return {
    id: `manifest:${manifest.source.source_kind}:${manifest.source.ply_url ?? manifest.source.url ?? manifest.source.pano_url ?? 'source'}`,
    source_type: manifest.source.source_type ?? 'sog',
    source_kind: manifest.source.source_kind,
    label: manifest.source.source_kind,
    ply_url: manifest.source.ply_url,
    url: manifest.source.url ?? manifest.source.ply_url ?? manifest.source.pano_url,
    pano_url: manifest.source.pano_url,
    pano_fs: manifest.source.pano_fs,
    collision_glb_url: manifest.source.collision_glb_url,
    current: true,
  };
}

function manifestOptionToWorldSource(
  option: NonNullable<DirectorStageManifest['source_options']>[number],
): DirectorWorldSource | null {
  if (option.kind === 'active') return null;
  return {
    id: `option:${option.kind}:${option.ply_url ?? option.url ?? option.pano_url ?? 'source'}`,
    source_type: option.source_type ?? 'sog',
    source_kind: option.kind,
    label: option.label ?? option.kind,
    ply_url: option.ply_url,
    url: option.url ?? option.ply_url ?? option.pano_url,
    pano_url: option.pano_url,
    pano_fs: option.pano_fs,
    slot_kind: option.slot_kind,
    fs: option.fs,
    current: option.current,
  };
}

function directorManifestWithScenePanoSource(
  manifest: DirectorStageManifest,
  assets: SceneAssetsForBeat | null,
): DirectorStageManifest {
  if (!assets?.pano_360_url) return manifest;
  const sources = manifest.sources?.length
    ? manifest.sources.filter((source) => source.source_type !== 'mesh')
    : [
        manifestSourceToWorldSource(manifest),
        ...(manifest.source_options ?? [])
          .map(manifestOptionToWorldSource)
          .filter((source): source is DirectorWorldSource => source !== null),
      ];
  const panoSource: DirectorWorldSource = {
    id: `scene-pano:${assets.scene_id ?? assets.pano_360_url}`,
    source_type: 'pano360',
    source_kind: 'pano',
    label: '360',
    url: assets.pano_360_url,
    pano_url: assets.pano_360_url,
    slot_kind: 'scene_director_pano_360',
  };
  if (!sources.some((source) => directorSourceUrl(source) === assets.pano_360_url)) {
    sources.push(panoSource);
  }
  return {
    ...manifest,
    sources,
    active_source_id: manifest.active_source_id ?? sources.find((source) => source.current)?.id,
  };
}

function SourceActionButton({
  icon,
  title,
  detail,
  disabled,
  onClick,
  className = '',
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`min-h-[58px] rounded-[8px] border border-white/10 bg-black/20 px-3 py-2 text-left transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      disabled={disabled}
      onClick={onClick}
    >
      <div className="flex items-center gap-2 text-xs font-semibold text-text-dark">
        {icon}
        <span>{title}</span>
      </div>
      <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-text-muted">{detail}</div>
    </button>
  );
}

// 这些输入口最容易被「拖了素材却没接上」误伤（落点不准 / 不知道往哪接），
// 未绑定时给个更显眼的把手 + 提示文案，降低误操作。
const EMPHASIZED_INPUT_ROLES = new Set<string>([
  'source_image',
  'scene_master',
  'scene_reverse_master',
  'background',
]);
const SKILL_INPUT_HANDLE_LEFT = -17;
const SKILL_ROW_INPUT_HANDLE_LEFT = -30;
const SKILL_CARD_CLASS = 'rounded-[8px] border border-white/10 bg-white/[0.04] px-3 py-2';

function SkillInputHandle({
  id,
  emphasized = false,
  leftOffset = SKILL_INPUT_HANDLE_LEFT,
}: {
  id: string;
  emphasized?: boolean;
  leftOffset?: number;
}) {
  const className = emphasized
    ? 'skill-node-input-handle !h-2.5 !w-2.5 !border-0 !bg-cyan-300'
    : 'skill-node-input-handle !h-2.5 !w-2.5 !border-0 !bg-cyan-300';

  return (
    <Handle
      type="target"
      position={Position.Left}
      id={id}
      className={className}
      style={{ left: leftOffset, top: '50%' }}
    />
  );
}

function assertCurrentRunContext(
  projectId: string,
  canvasId: string,
  skillNodeId: string,
  runId: string | null,
  startedAt: number | null,
): void {
  const currentUrl = readUrl();
  if (currentUrl.project !== projectId || (currentUrl.canvas ?? 'default') !== canvasId) {
    throw new Error('Skill run completed after switching canvas; output was not materialized');
  }

  const currentNode = useCanvasStore.getState().nodes.find((node) => node.id === skillNodeId);
  if (!currentNode) {
    throw new Error('Skill node was deleted before the run completed');
  }
  const currentData = currentNode.data as {
    generationStartedAt?: unknown;
    skillRunId?: unknown;
  };
  const currentRunId = typeof currentData.skillRunId === 'string' ? currentData.skillRunId : '';
  if (runId && currentRunId && currentRunId !== runId) {
    throw new Error('A newer skill run replaced this completion');
  }
  if (!runId || !currentRunId) {
    const currentStartedAt = currentData.generationStartedAt;
    if (startedAt !== null && currentStartedAt !== startedAt) {
      throw new Error('A newer skill run replaced this completion');
    }
  }
}

export const SkillNode = memo(({ id, data, width, selected }: SkillNodeProps) => {
  const { t } = useTranslation();
  const resumeRunRef = useRef<string | null>(null);
  const submitInFlightRef = useRef(false);
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdgeWithData = useCanvasStore((state) => state.addEdgeWithData);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  // 只订阅与本节点相连的边、以及入边的源节点。useShallow 逐元素比较,使得拖动「无关」
  // 节点时本 SkillNode 不再重渲染 —— 边对象在拖拽中引用稳定,源节点只在自身变化时换引用。
  const incomingEdges = useCanvasStore(
    useShallow((state) => state.edges.filter((edge) => edge.target === id))
  );
  const outgoingEdges = useCanvasStore(
    useShallow((state) => state.edges.filter((edge) => edge.source === id))
  );
  const sourceNodes = useCanvasStore(
    useShallow((state) => {
      const sourceIds = new Set(
        state.edges.filter((edge) => edge.target === id).map((edge) => edge.source)
      );
      return state.nodes.filter((node) => sourceIds.has(node.id));
    })
  );
  const [registry, setRegistry] = useState<SkillDefinition[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sceneAssets, setSceneAssets] = useState<SceneAssetsForBeat | null>(null);
  const [sourcePickerError, setSourcePickerError] = useState<string | null>(null);
  const [sourcePickerBusy, setSourcePickerBusy] = useState(false);
  const [cropSource, setCropSource] = useState<{
    url: string;
    label: 'master' | 'reverse' | 'director_background';
  } | null>(null);
  const [directorStageOpen, setDirectorStageOpen] = useState(false);
  const [directorStageManifest, setDirectorStageManifest] = useState<DirectorStageManifest | null>(null);
  const [directorWorldDestination, setDirectorWorldDestination] = useState<DirectorWorldDestination | null>(null);
  const [submitInFlight, setSubmitInFlight] = useState(false);
  const [taskRecordGraceUntil, setTaskRecordGraceUntil] = useState(0);
  void selected;

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    getSkillRegistry()
      .then((items) => {
        if (!cancelled) {
          setRegistry(items);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const skill = useMemo(
    () => registry.find((item) => item.id === data.skill_id) ?? null,
    [data.skill_id, registry],
  );
  const parameterEntries = useMemo(
    () => skillParameterEntries(skill, data.parameters),
    [data.parameters, skill],
  );
  const skillParameters = useMemo(
    () => normalizedSkillParameters(skill, data.parameters),
    [data.parameters, skill],
  );
  const generationTaskKey =
    typeof data.generationTaskKey === 'string' ? data.generationTaskKey.trim() : '';
  const trackedTask = useTaskCenterStore((state) =>
    generationTaskKey ? state.tasks.get(generationTaskKey) ?? null : null,
  );
  const taskCenterHydrated = useTaskCenterStore((state) => state.isHydrated);
  const taskRecordGraceActive = taskRecordGraceUntil > Date.now();
  const nodeById = useMemo(
    () => new Map(sourceNodes.map((node) => [node.id, node] as const)),
    [sourceNodes]
  );
  const beatContextNode = useMemo(() => {
    const beatEdge = incomingEdges.find((edge) => roleFromEdge(edge) === 'beat_context');
    return beatEdge ? nodeById.get(beatEdge.source) : undefined;
  }, [incomingEdges, nodeById]);
  const beatContextReferences = useMemo(
    () => beatContextListsFromNode(beatContextNode),
    [beatContextNode],
  );
  const inputHandleIds = useMemo(() => {
    const roles = new Set<string>();
    for (const input of skill?.inputs ?? []) {
      if (
        data.skill_id === 'freezone.frame_from_context' &&
        isReferenceInputRole(input.role) &&
        (
          (input.role === 'identity' && beatContextReferences.identities.length > 0) ||
          (input.role === 'prop' && beatContextReferences.props.length > 0)
        )
      ) {
        continue;
      }
      roles.add(input.role);
    }
    if (data.skill_id === 'freezone.frame_from_context') {
      for (const identityId of beatContextReferences.identities) {
        roles.add(referenceHandleId('identity', identityId));
      }
      for (const propId of beatContextReferences.props) {
        roles.add(referenceHandleId('prop', propId));
      }
    }
    for (const edge of incomingEdges) {
      const handleId = nonEmptyHandleId(edge.targetHandle);
      if (handleId && !isNoReferenceHandle(handleId)) {
        roles.add(handleId);
      }
    }
    return Array.from(roles);
  }, [beatContextReferences.identities, beatContextReferences.props, data.skill_id, incomingEdges, skill?.inputs]);
  const referenceInputHandlesByRole = useMemo(() => {
    const handles: Record<'identity' | 'prop', string[]> = { identity: [], prop: [] };
    const add = (role: 'identity' | 'prop', handleId: string) => {
      if (!handles[role].includes(handleId)) {
        handles[role].push(handleId);
      }
    };
    if (data.skill_id === 'freezone.frame_from_context') {
      for (const identityId of beatContextReferences.identities) {
        add('identity', referenceHandleId('identity', identityId));
      }
      for (const propId of beatContextReferences.props) {
        add('prop', referenceHandleId('prop', propId));
      }
    }
    for (const edge of incomingEdges) {
      const handleId = nonEmptyHandleId(edge.targetHandle);
      const role = roleFromEdge(edge);
      if (handleId?.startsWith('identity:')) {
        if (!isNoReferenceHandle(handleId, 'identity')) {
          add('identity', handleId);
        }
      } else if (handleId?.startsWith('prop:')) {
        if (!isNoReferenceHandle(handleId, 'prop')) {
          add('prop', handleId);
        }
      } else if (role === 'identity' && handleId === 'identity') {
        add('identity', handleId);
      } else if (role === 'prop' && handleId === 'prop') {
        add('prop', handleId);
      }
    }
    return handles;
  }, [beatContextReferences.identities, beatContextReferences.props, data.skill_id, incomingEdges]);
  const outputHandleIds = useMemo(() => {
    const roles = new Set<string>();
    for (const output of skill?.outputs ?? []) {
      roles.add(output.role);
    }
    for (const edge of outgoingEdges) {
      const handleId = nonEmptyHandleId(edge.sourceHandle);
      if (handleId) {
        roles.add(handleId);
      }
    }
    return Array.from(roles);
  }, [outgoingEdges, skill?.outputs]);
  const beatTarget = useMemo(() => resolveBeatTargetFromNode(beatContextNode), [beatContextNode]);
  const ready = skill ? isSkillReadyToSubmit(skill, incomingEdges, nodeById) : false;
  const taskIsActive = trackedTask ? isActiveTask(trackedTask) : false;
  const waitingForTaskRecord =
    data.isGenerating === true
    && generationTaskKey.length > 0
    && !trackedTask
    && (!taskCenterHydrated || taskRecordGraceActive);
  const isBusy = submitInFlight || taskIsActive || waitingForTaskRecord;
  const submitLabel = t(taskStatusLabelKey(trackedTask, submitInFlight, waitingForTaskRecord));
  const resolvedWidth = typeof width === 'number' ? width : DEFAULT_WIDTH;
  const isSetSelectedBackgroundSkill = data.skill_id === 'freezone.set_selected_background';
  const isSetDirectorCombinedSkill = data.skill_id === 'freezone.set_director_combined';
  const localizedSkillName = skill ? translateSkillName(skill, t) : null;
  const localizedSkillDescription = skill ? translateSkillDescription(skill, t) : null;
  const mainlineManaged = isSystemManagedNodeData(data);
  const embeddedSceneAssets = useMemo(
    () => sceneAssetsFromSkillData((data as Record<string, unknown>).scene_source_urls),
    [data],
  );
  const directorEnvOnlyUrl =
    sceneAssets?.director_env_only_url
    ?? embeddedSceneAssets?.director_env_only_url
    ?? null;
  const directorEnvOnlyPreviewUrl = directorEnvOnlyUrl;

  const stageSelectedBackground = (
    target: { episode?: unknown; beat?: unknown },
    imageUrl: string,
    label?: string,
    extraData?: Partial<CanvasNodeData> & Record<string, unknown>,
  ): string | null => {
    const episode = numericField(target.episode);
    const beat = numericField(target.beat);
    if (episode === null || beat === null) {
      setSourcePickerError('缺少镜头上下文');
      return null;
    }
    const outputNodeId = stageSelectedBackgroundOutputForSkill(
      { episode, beat },
      imageUrl,
      {
        sourceSkillNodeId: id,
        label,
        extraData,
      },
    );
    if (!outputNodeId) {
      setSourcePickerError('没有找到当前背景输出节点');
      return null;
    }
    if (mainlineManaged && !extraData?.committed_at) {
      canvasEventBus.publish('freezone/commit-node', {
        nodeId: outputNodeId,
        auto: true,
        successMessage: t('viewer.threeD.selectedBackgroundCommitSuccess', { episode, beat }),
      });
    }
    return outputNodeId;
  };

  const uploadAndStageSelectedBackground = async (blob: Blob, filename: string, label?: string) => {
    const projectId = readUrl().project;
    if (!projectId || !beatTarget) {
      throw new Error('缺少项目或镜头上下文');
    }
    const uploaded = await uploadFreezoneImage(projectId, blob, filename, { timeoutMs: false });
    const nodeId = stageSelectedBackground(beatTarget, uploaded.url, label);
    if (!nodeId) {
      throw new Error('当前背景输出节点不可用');
    }
  };

  const ensureSceneAssets = async (fresh = false): Promise<SceneAssetsForBeat | null> => {
    if (!fresh && embeddedSceneAssets) {
      return embeddedSceneAssets;
    }
    if (!fresh && sceneAssets) {
      return sceneAssets;
    }
    const projectId = readUrl().project;
    if (!projectId || !beatTarget) {
      setSourcePickerError('缺少项目或镜头上下文');
      return null;
    }
    setSourcePickerBusy(true);
    setSourcePickerError(null);
    try {
      const assets = await getSceneAssetsForBeat(projectId, beatTarget.episode, beatTarget.beat);
      setSceneAssets(assets);
      return assets;
    } catch (error) {
      setSourcePickerError(errorMessage(error));
      return null;
    } finally {
      setSourcePickerBusy(false);
    }
  };

  useEffect(() => {
    if (!isSetSelectedBackgroundSkill || !beatTarget) return;
    const projectId = readUrl().project;
    if (!projectId) return;
    let cancelled = false;
    setSourcePickerBusy(true);
    void getSceneAssetsForBeat(projectId, beatTarget.episode, beatTarget.beat)
      .then((assets) => {
        if (!cancelled) setSceneAssets(assets);
      })
      .catch((error) => {
        if (!cancelled) setSourcePickerError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setSourcePickerBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [beatTarget?.beat, beatTarget?.episode, isSetSelectedBackgroundSkill]);

  const handleParameterChange = (key: string, value: string | boolean) => {
    const currentParameters = recordValue(data.parameters) ?? {};
    updateNodeData(id, {
      parameters: {
        ...currentParameters,
        [key]: value,
      },
    });
  };

  const handleDirectorCombinedCaptureSuccess = async (
    blob: Blob,
    meta?: ThreeDDirectorCaptureMeta,
  ) => {
    const projectId = readUrl().project;
    const canvasId = readUrl().canvas ?? 'default';
    if (!projectId || !beatTarget) {
      throw new Error(t('viewer.threeD.directorCombinedMissingContext'));
    }
    const bundle = directorControlBundleFromMeta(meta);
    let imageUrl = directorControlBundleImageUrl(bundle, 'combined') || meta?.controlFrameUrl || '';
    if (!imageUrl) {
      const uploaded = await uploadFreezoneImage(
        projectId,
        blob,
        `director_combined_3gs_${Date.now()}.png`,
        { timeoutMs: false },
      );
      imageUrl = uploaded.url;
    }
    const directorCombinedContext = {
      kind: 'director_combined',
      projectId,
      episode: beatTarget.episode,
      beat: beatTarget.beat,
      role: 'director_combined',
      sourceUrl: imageUrl,
    } satisfies MainlineContext;
    const output: SkillRunOutput = {
      schema_version: 'skill.v1',
      role: 'director_combined',
      media_type: 'image',
      node_type: 'imageGenNode',
      pushable: true,
      image_url: imageUrl,
      label: t('viewer.threeD.directorCombinedOutputLabel', {
        episode: beatTarget.episode,
        beat: beatTarget.beat,
      }),
      slot_target: {
        kind: 'director_render',
        episode: beatTarget.episode,
        beat: beatTarget.beat,
      },
      mainline_context: [
        directorCombinedContext,
      ],
      ...(bundle ? {
        director_control_bundle: bundle,
        committed: true,
        committed_slot_url: imageUrl,
      } : {}),
    };
    materializeOutputs([output], projectId, canvasId, null, null);
    const outputNodeId = useCanvasStore
      .getState()
      .edges
      .find((edge) => edge.source === id && outputRoleFromEdge(edge) === 'director_combined')
      ?.target;
    if (bundle && outputNodeId) {
      updateNodeData(outputNodeId, {
        director_control_bundle: bundle,
        committed_at: new Date().toISOString(),
        committed_slot_url: imageUrl,
      });
    } else if (mainlineManaged && outputNodeId) {
      canvasEventBus.publish('freezone/commit-node', {
        nodeId: outputNodeId,
        auto: true,
        successMessage: t('viewer.threeD.directorCombinedCommitSuccess', {
          episode: beatTarget.episode,
          beat: beatTarget.beat,
        }),
      });
    }
    setSourcePickerError(null);
  };

  useEffect(() => {
    setSceneAssets(null);
    setSourcePickerError(null);
  }, [beatTarget?.episode, beatTarget?.beat]);

  useEffect(() => {
    if (taskRecordGraceUntil <= 0) {
      return undefined;
    }
    const remainingMs = taskRecordGraceUntil - Date.now();
    if (remainingMs <= 0) {
      setTaskRecordGraceUntil(0);
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      setTaskRecordGraceUntil(0);
    }, remainingMs);
    return () => window.clearTimeout(timeout);
  }, [taskRecordGraceUntil]);

  useEffect(() => {
    if (trackedTask && taskRecordGraceUntil > 0) {
      setTaskRecordGraceUntil(0);
    }
  }, [taskRecordGraceUntil, trackedTask]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, inputHandleIds, outputHandleIds, resolvedWidth, updateNodeInternals]);

  const materializeOutputs = (
    outputs: SkillRunOutput[],
    projectId: string,
    canvasId: string,
    runId: string | null,
    startedAt: number | null,
  ) => {
    assertCurrentRunContext(projectId, canvasId, id, runId, startedAt);
    const state = useCanvasStore.getState();
    const sourceNode = state.nodes.find((node) => node.id === id);
    if (!sourceNode) {
      throw new Error('Skill node no longer exists');
    }
    const sourcePosition = sourceNode.position;
    const startY =
      sourcePosition.y - (Math.max(0, outputs.length - 1) * OUTPUT_Y_SPACING) / 2;

    outputs.forEach((output, index) => {
      const latestState = useCanvasStore.getState();
      const boundOutputNodes = latestState.edges
        .filter((edge) => edge.source === id && outputRoleFromEdge(edge) === output.role)
        .map((edge) => latestState.nodes.find((node) => node.id === edge.target))
        .filter((node): node is CanvasNode => Boolean(node));
      if (boundOutputNodes.length > 0) {
        for (const node of boundOutputNodes) {
          const existingData = recordValue(node.data) ?? {};
          const patch: Partial<CanvasNodeData> & Record<string, unknown> = {
            displayName:
              typeof existingData.displayName === 'string' && existingData.displayName.trim()
                ? existingData.displayName
                : outputLabel(output),
            output_role: output.role,
            media_kind: output.media_type,
            candidate_origin: { skill_id: data.skill_id, skill_node_id: id },
            ...(output.slot_target ? { slot_target: output.slot_target } : {}),
            ...(Array.isArray(output.mainline_context)
              ? { mainline_context: output.mainline_context }
              : {}),
            ...(recordValue(output.director_control_bundle)
              ? { director_control_bundle: output.director_control_bundle }
              : {}),
          };
          if (output.media_type === 'image') {
            patch.imageUrl = output.image_url ?? null;
            patch.previewImageUrl = output.image_url ?? null;
            patch.committed_slot_url =
              typeof output.committed_slot_url === 'string'
                ? output.committed_slot_url
                : null;
            patch.committed_at = output.committed === true ? new Date().toISOString() : null;
          } else {
            patch.content = outputText(output);
          }
          updateNodeData(node.id, patch);
        }
        return;
      }

      const selectedTarget = selectedBackgroundTarget(output);
      if (selectedTarget && output.image_url) {
        if (stageSelectedBackground(selectedTarget, output.image_url, outputLabel(output))) {
          return;
        }
      }
      const targetId = addNode(
        nodeTypeForOutput(output),
        {
          x: sourcePosition.x + OUTPUT_X_OFFSET,
          y: startY + index * OUTPUT_Y_SPACING,
        },
        nodeDataForOutput(output, data.skill_id, id),
      );
      const edgeId = addEdgeWithData(
        id,
        targetId,
        {
          edgeKind: 'role_binding',
          role: output.role,
          label: outputLabel(output),
          propagates: false,
        },
        {
          id: `e-${id}-${targetId}-${output.role}`,
          sourceHandle: output.role,
          targetHandle: 'target',
        },
      );
      if (!edgeId) {
        useCanvasStore.getState().deleteNode(targetId);
        throw new Error(`Failed to connect skill output ${output.role}`);
      }
    });
  };

  useEffect(() => {
    if (!skill || data.isGenerating !== true) {
      return;
    }
    const runId = typeof data.skillRunId === 'string' ? data.skillRunId : '';
    if (!runId) {
      return;
    }
    const projectId = readUrl().project;
    const canvasId = readUrl().canvas ?? 'default';
    if (!projectId) {
      return;
    }
    const resumeKey = `${projectId}:${canvasId}:${id}:${runId}`;
    if (resumeRunRef.current === resumeKey) {
      return;
    }
    resumeRunRef.current = resumeKey;
    let cancelled = false;
    const startedAt =
      typeof data.generationStartedAt === 'number' && Number.isFinite(data.generationStartedAt)
        ? data.generationStartedAt
        : null;

    void (async () => {
      try {
        const taskKey = typeof data.generationTaskKey === 'string' ? data.generationTaskKey : '';
        if (taskKey) {
          await awaitTaskCompletion(taskKey, projectId, {
            // 续接时用持久化的类型取同一份预算（见 pollTimeoutForTaskType）。
            taskType:
              typeof data.generationTaskType === 'string' ? data.generationTaskType : null,
          });
        }
        const result = await awaitSkillRunResult(projectId, runId);
        if (cancelled) {
          return;
        }
        if (isFailureStatus(result.status)) {
          throw new Error(skillErrorMessage(result.error) ?? `Skill run failed with status ${result.status}`);
        }
        materializeOutputs(result.outputs ?? [], projectId, canvasId, runId, startedAt);
        updateNodeData(id, {
          isGenerating: false,
          generationStartedAt: null,
          generationError: null,
          generationTaskKey: null,
          generationTaskType: null,
          generationTaskJobId: null,
        });
      } catch (error) {
        if (!cancelled) {
          updateNodeData(id, {
            isGenerating: false,
            generationStartedAt: null,
            generationError: errorMessage(error),
            generationTaskKey: null,
            generationTaskType: null,
            generationTaskJobId: null,
          });
        }
      } finally {
        if (resumeRunRef.current === resumeKey) {
          resumeRunRef.current = null;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    data.generationStartedAt,
    data.generationTaskKey,
    data.isGenerating,
    data.skillRunId,
    id,
    skill,
    updateNodeData,
  ]);

  const handlePickFlatSource = async (kind: 'master' | 'reverse' | 'director_background') => {
    const assets = await ensureSceneAssets(kind === 'director_background');
    const url =
      kind === 'master'
        ? assets?.master_url
        : kind === 'reverse'
          ? assets?.reverse_url
          : assets?.director_env_only_url;
    if (!url) {
      setSourcePickerError(
        kind === 'master'
          ? '当前场景没有 master 图'
          : kind === 'reverse'
            ? '当前场景没有 reverse 图'
            : '当前 Beat 还没有导演背景图',
      );
      return;
    }
    setCropSource({ url, label: kind });
  };

  const openContextDirectorWorld = async (destination: DirectorWorldDestination) => {
    const projectId = readUrl().project;
    if (!projectId || !beatTarget) {
      setSourcePickerError('缺少项目或镜头上下文');
      return;
    }
    setSourcePickerBusy(true);
    setSourcePickerError(null);
    try {
      const assets = await ensureSceneAssets();
      const manifest = await getBeatDirectorStageManifest(projectId, beatTarget.episode, beatTarget.beat);
      setDirectorStageManifest(
        mergeManifestWithCanvasBeatContext(
          directorManifestWithScenePanoSource(manifest, assets),
          beatContextNode,
        ),
      );
      setDirectorWorldDestination(destination);
      setDirectorStageOpen(true);
    } catch (error) {
      setSourcePickerError(errorMessage(error));
    } finally {
      setSourcePickerBusy(false);
    }
  };

  const handleDirectorWorldOpenChange = (open: boolean) => {
    setDirectorStageOpen(open);
    if (!open) {
      setDirectorWorldDestination(null);
    }
  };

  const handleDirectorWorldCaptureSuccess = async (
    blob: Blob,
    meta?: ThreeDDirectorCaptureMeta,
  ) => {
    const destination = directorWorldDestination;
    if (!destination) {
      return;
    }
    try {
      if (destination === 'selected_background') {
        await uploadAndStageSelectedBackground(
          blob,
          `background_director_world_${Date.now()}.png`,
          t('viewer.threeD.selectedBackgroundOutputLabel', {
            episode: beatTarget?.episode ?? '',
            beat: beatTarget?.beat ?? '',
          }),
        );
      } else {
        await handleDirectorCombinedCaptureSuccess(blob, meta);
      }
      setSourcePickerError(null);
      setDirectorStageOpen(false);
    } catch (error) {
      setSourcePickerError(errorMessage(error));
      throw error;
    } finally {
      setDirectorWorldDestination(null);
    }
  };

  const handleSubmit = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!skill || !ready || isBusy) {
      return;
    }

    const projectId = readUrl().project;
    const canvasId = readUrl().canvas ?? 'default';
    if (!projectId) {
      updateNodeData(id, { generationError: 'project id is required to run a skill' });
      return;
    }
    if (submitInFlightRef.current) {
      return;
    }

    let startedAt = 0;
    let activeRunKey: string | null = null;
    try {
      const state = useCanvasStore.getState();
      const latestNodeById = new Map(state.nodes.map((node) => [node.id, node] as const));
      const skillNode = latestNodeById.get(id);
      if (!skillNode) {
        throw new Error('Skill node no longer exists');
      }
      if ((skillNode.data as { isGenerating?: unknown }).isGenerating === true) {
        return;
      }
      submitInFlightRef.current = true;
      setSubmitInFlight(true);
      const resolvedInputs = resolveInputsForSkill(
        skill,
        skillNode,
        state.edges.filter((edge) => edge.target === id),
        latestNodeById,
      );
      const currentParameters = normalizedSkillParameters(
        skill,
        (skillNode.data as SkillNodeData).parameters,
      );
      const inputSignature = skillInputSignature({
        inputs: resolvedInputs,
        parameters: currentParameters,
      });
      const idempotencyKey = skillRunIdempotencyKey(
        canvasId,
        id,
        data.skill_id,
        inputSignature,
        createSkillRunNonce(),
      );
      startedAt = Date.now();
      updateNodeData(id, {
        isGenerating: true,
        generationStartedAt: startedAt,
        generationError: null,
        skillInputSignature: inputSignature,
        skillIdempotencyKey: idempotencyKey,
        skillRunId: null,
        generationTaskKey: null,
        generationTaskType: null,
        generationTaskJobId: null,
      });
      const response = await runSkill(projectId, data.skill_id, {
        skill_node_id: id,
        canvas_id: canvasId,
        idempotency_key: idempotencyKey,
        resolved_inputs: resolvedInputs,
        parameters: currentParameters,
      });
      const runKey = `${projectId}:${canvasId}:${id}:${response.run_id}`;
      activeRunKey = runKey;
      resumeRunRef.current = runKey;
      updateNodeData(id, {
        isGenerating: true,
        skillRunId: response.run_id,
        generationTaskKey: response.task_key ?? null,
        generationTaskType: response.task_type ?? null,
        generationTaskJobId: response.job_id ?? null,
      });
      if (response.task_key) {
        setTaskRecordGraceUntil(Date.now() + TASK_RECORD_GRACE_MS);
        setSubmitInFlight(false);
        submitInFlightRef.current = false;
        await awaitTaskCompletion(response.task_key, projectId, {
          taskType: response.task_type ?? null,
        });
      }
      const result = await awaitSkillRunResult(projectId, response.run_id);
      if (isFailureStatus(result.status)) {
        throw new Error(skillErrorMessage(result.error) ?? `Skill run failed with status ${result.status}`);
      }
      materializeOutputs(result.outputs ?? [], projectId, canvasId, response.run_id, startedAt);
      updateNodeData(id, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
        generationTaskKey: null,
        generationTaskType: null,
        generationTaskJobId: null,
      });
      submitInFlightRef.current = false;
      setSubmitInFlight(false);
      setTaskRecordGraceUntil(0);
      if (resumeRunRef.current === runKey) {
        resumeRunRef.current = null;
      }
    } catch (error) {
      submitInFlightRef.current = false;
      setSubmitInFlight(false);
      setTaskRecordGraceUntil(0);
      if (activeRunKey && resumeRunRef.current === activeRunKey) {
        resumeRunRef.current = null;
      }
      const currentNode = useCanvasStore.getState().nodes.find((node) => node.id === id);
      const currentStartedAt = (currentNode?.data as { generationStartedAt?: unknown } | undefined)?.generationStartedAt;
      if (currentNode && (currentStartedAt === startedAt || !activeRunKey)) {
        updateNodeData(id, {
          isGenerating: false,
          generationStartedAt: null,
          generationError: errorMessage(error),
          generationTaskKey: null,
          generationTaskType: null,
          generationTaskJobId: null,
        });
      }
    }
  };

  return (
    <div
      className="group relative w-full overflow-visible"
      style={{ width: resolvedWidth }}
      onClick={() => setSelectedNode(id)}
    >
      {outputHandleIds.map((handleId, index) => (
        <Handle
          key={handleId}
          type="source"
          position={Position.Right}
          id={handleId}
          className="!h-2.5 !w-2.5 !border-0 !bg-emerald-300"
          style={{ top: handleTop(index, outputHandleIds.length) }}
        />
      ))}
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Boxes className="h-4 w-4" />}
        titleText={localizedSkillName ?? data.displayName ?? '技能'}
        editable={false}
      />

      <div className="flex min-h-[240px] flex-col overflow-visible rounded-[var(--node-radius)] border border-cyan-200/25 bg-[rgba(12,22,30,0.94)] text-text-dark shadow-[0_16px_44px_rgba(0,0,0,0.36)]">
        <div className="border-b border-white/10 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white">
                {localizedSkillName ?? (isLoading ? '加载技能...' : '未知技能')}
              </div>
              <div className="mt-1 line-clamp-2 text-xs leading-5 text-text-muted">
                {localizedSkillDescription ?? loadError ?? data.skill_id}
              </div>
            </div>
            <div className="shrink-0 rounded-full border border-cyan-200/20 bg-cyan-300/10 px-2 py-1 text-[10px] font-medium text-cyan-100">
              {skill ? PROVIDER_LABELS[skill.provider] : 'skill'}
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-xs text-text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            loading registry
          </div>
        ) : skill ? (
          <div className="flex flex-1 flex-col gap-3 p-4">
            {parameterEntries.length > 0 && (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">
                  {t('viewer.threeD.skillParametersTitle')}
                </div>
                {parameterEntries.map((entry) => {
                  const currentValue = skillParameters[entry.key] ?? entry.value;
                  const parameterLabel = translateSkillParameterLabel(
                    skill.id,
                    entry.key,
                    entry.label,
                    t,
                  );
                  if (entry.type === 'boolean') {
                    const isSelected = currentValue === true;
                    return (
                      <div
                        key={entry.key}
                        className={SKILL_CARD_CLASS}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 text-xs font-medium text-white">
                            {parameterLabel}
                          </div>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={isSelected}
                            disabled={isBusy}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleParameterChange(entry.key, !isSelected);
                            }}
                            className={[
                              'relative h-6 w-11 shrink-0 rounded-full border transition',
                              isSelected
                                ? 'border-cyan-300 bg-cyan-300'
                                : 'border-white/15 bg-black/30 hover:bg-white/10',
                              isBusy ? 'cursor-not-allowed opacity-60' : '',
                            ].join(' ')}
                          >
                            <span
                              className={[
                                'absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow transition-transform',
                                isSelected ? 'translate-x-5' : 'translate-x-0.5',
                              ].join(' ')}
                            />
                          </button>
                        </div>
                      </div>
                    );
                  }
                  const selectedValue = String(currentValue);
                  const optionColumnCount = Math.min(Math.max(entry.options.length, 1), 4);
                  return (
                    <div
                      key={entry.key}
                      className={SKILL_CARD_CLASS}
                    >
                      <div className="mb-2 text-xs font-medium text-white">{parameterLabel}</div>
                      <div
                        className="nodrag nopan grid gap-1 rounded-[6px] bg-black/35 p-1"
                        style={{
                          gridTemplateColumns: `repeat(${optionColumnCount}, minmax(0, 1fr))`,
                        }}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {entry.options.map((option) => {
                          const isSelected = selectedValue === option;
                          const optionLabel = translateSkillParameterOption(
                            skill.id,
                            entry.key,
                            option,
                            t,
                          );
                          return (
                            <button
                              key={option}
                              type="button"
                              disabled={isBusy}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleParameterChange(entry.key, option);
                              }}
                              className={[
                                'min-h-8 rounded-[5px] px-2 text-xs font-semibold transition active:scale-[0.99]',
                                isSelected
                                  ? 'bg-cyan-300 text-slate-950 shadow-sm'
                                  : 'cursor-pointer text-white/55 hover:bg-white/10 hover:text-white',
                                isBusy ? 'cursor-not-allowed opacity-60' : '',
                              ].join(' ')}
                            >
                              {optionLabel}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">
                Inputs
              </div>
              {skill.inputs.map((input) => {
                const boundEdges = findBoundEdges(incomingEdges, input.role).filter(
                  (edge) => !isNoReferenceEdge(edge, input.role),
                );
                const referenceHandles = isReferenceInputRole(input.role)
                  ? referenceInputHandlesByRole[input.role]
                  : [];
                const usesRowHandles = referenceHandles.length > 0;
                const emphasizedInput = EMPHASIZED_INPUT_ROLES.has(input.role);
                const noReferenceLabel = input.role === 'identity' && beatContextReferences.noCharacter
                  ? t('viewer.threeD.skillInputNoCharacter', { defaultValue: '无角色' })
                  : input.role === 'prop' && beatContextReferences.noProp
                    ? t('viewer.threeD.skillInputNoProp', { defaultValue: '无道具' })
                    : null;
                const renderBoundChip = (edge: CanvasEdge) => {
                  const sourceNode = nodeById.get(edge.source);
                  const previewUrl = resolvePreviewUrl(sourceNode);
                  return (
                    <div
                      key={edge.id}
                      className="flex max-w-full items-center gap-2 text-xs text-text-dark"
                    >
                      {previewUrl ? (
                        <img
                          src={previewUrl}
                          alt=""
                          className="h-7 w-7 rounded-full object-cover"
                          draggable={false}
                        />
                      ) : (
                        <div className="flex h-6 w-6 items-center justify-center rounded-[5px] border border-white/10 bg-white/[0.04] text-text-muted">
                          <FileText className="h-3.5 w-3.5" />
                        </div>
                      )}
                      <span className="truncate">{resolveSourceLabel(sourceNode, t('viewer.threeD.skillStatus.missingSource'))}</span>
                    </div>
                  );
                };
                const renderAnchoredChipRow = (edge: CanvasEdge, forcedHandleId?: string) => {
                  const handleId = forcedHandleId ?? (
                    referenceHandles.length > 0
                      ? nonEmptyHandleId(edge.targetHandle)
                      : input.role
                  );
                  return (
                    <div
                      key={edge.id}
                      className="relative flex max-w-full"
                    >
                      {usesRowHandles && handleId ? (
                        <SkillInputHandle
                          id={handleId}
                          leftOffset={SKILL_ROW_INPUT_HANDLE_LEFT}
                        />
                      ) : null}
                      {renderBoundChip(edge)}
                    </div>
                  );
                };
                const renderContextReferenceRow = (handleId: string) => (
	                  <div
	                    key={handleId}
	                    className="relative flex max-w-full"
	                  >
	                    <SkillInputHandle
	                      id={handleId}
	                      leftOffset={SKILL_ROW_INPUT_HANDLE_LEFT}
	                    />
	                    <div className="flex max-w-full items-center gap-2 text-xs text-text-dark">
	                      <div className="flex h-6 w-6 items-center justify-center rounded-[5px] border border-white/10 bg-white/[0.04] text-text-muted">
	                        <FileText className="h-3.5 w-3.5" />
	                      </div>
	                      <span className="truncate">
	                        {t('viewer.threeD.skillInputFromBeatContext')} · {labelFromReferenceHandle(handleId)}
	                      </span>
	                    </div>
	                  </div>
                );
                const renderReferenceRows = () => {
                  const renderedEdgeIds = new Set<string>();
                  const rows: ReactNode[] = referenceHandles.map((handleId) => {
                    const edge = boundEdges.find(
                      (candidate) => nonEmptyHandleId(candidate.targetHandle) === handleId,
                    );
                    if (edge) {
                      renderedEdgeIds.add(edge.id);
                      return renderAnchoredChipRow(edge, handleId);
                    }
                    return renderContextReferenceRow(handleId);
                  });
                  for (const edge of boundEdges) {
                    if (!renderedEdgeIds.has(edge.id)) {
                      rows.push(renderAnchoredChipRow(edge));
                    }
                  }
                  return rows;
                };
                return (
                  <div
                    key={input.role}
                    className={`relative ${SKILL_CARD_CLASS}`}
                  >
                    {!usesRowHandles ? (
                      <SkillInputHandle id={input.role} emphasized={emphasizedInput} />
                    ) : null}
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-medium text-white">
                        {translateSkillInputLabel(input.role, input.label, t)}
                      </span>
                      <span className={input.required ? 'text-amber-200' : 'text-text-muted'}>
                        {translateSkillRequirement(input.required, t)} · {translateSkillCardinality(input.cardinality, t)}
                      </span>
                    </div>
                    <div
                      className={
                        referenceHandles.length > 0
                          ? 'mt-2 space-y-2'
                          : 'mt-2 flex flex-wrap gap-2'
                      }
                    >
                      {referenceHandles.length > 0 ? (
                        renderReferenceRows()
                      ) : boundEdges.length === 0 && noReferenceLabel ? (
                        <span className="text-xs text-text-muted">
                          {noReferenceLabel}
                        </span>
                      ) : boundEdges.length === 0 ? (
                        <span
                          className={`text-xs ${emphasizedInput ? 'text-cyan-200/80' : 'text-text-muted'}`}
                        >
                          {t('viewer.threeD.skillInputUnbound')}
                          {emphasizedInput
                            ? ` · ${t('viewer.threeD.skillInputDragHint')}`
                            : null}
                        </span>
                      ) : (
                        boundEdges.map((edge) => renderAnchoredChipRow(edge))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {isSetSelectedBackgroundSkill && (
              <div className="rounded-[8px] border border-amber-300/20 bg-amber-300/[0.06] p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-amber-100">
                    {t('viewer.threeD.currentBackgroundSource')}
                  </div>
                  {sourcePickerBusy && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-100/70" />
                  )}
                </div>
                <div className="mb-3 rounded-[8px] border border-white/10 bg-black/20 p-2">
                  <div className="mb-1 text-[11px] text-text-muted">
                    {t('viewer.threeD.savedEnvOnlyBackground')}
                  </div>
                  {directorEnvOnlyPreviewUrl ? (
                    <img
                      src={directorEnvOnlyPreviewUrl}
                      alt=""
                      className="h-24 w-full rounded-[6px] object-cover"
                      draggable={false}
                    />
                  ) : (
                    <div className="flex h-20 items-center justify-center rounded-[6px] bg-white/[0.04] text-xs text-text-muted">
                      {t('viewer.threeD.noEnvOnlyBackground')}
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <SourceActionButton
                    icon={<Crop className="h-3.5 w-3.5" />}
                    title={t('viewer.threeD.cropDirectorBackground')}
                    detail={t('viewer.threeD.cropDirectorBackgroundDetail', {
                      aspects: SELECTED_BACKGROUND_CROP_ASPECT_OPTIONS.join(' / '),
                    })}
                    disabled={!beatTarget || sourcePickerBusy}
                    onClick={() => void handlePickFlatSource('director_background')}
                  />
                  <SourceActionButton
                    icon={<Crop className="h-3.5 w-3.5" />}
                    title={t('viewer.threeD.cropMaster')}
                    detail={t('viewer.threeD.cropMasterDetail', {
                      aspects: SELECTED_BACKGROUND_CROP_ASPECT_OPTIONS.join(' / '),
                    })}
                    disabled={!beatTarget || sourcePickerBusy}
                    onClick={() => void handlePickFlatSource('master')}
                  />
                  <SourceActionButton
                    icon={<Crop className="h-3.5 w-3.5" />}
                    title={t('viewer.threeD.cropReverse')}
                    detail={t('viewer.threeD.cropReverseDetail', {
                      aspects: SELECTED_BACKGROUND_CROP_ASPECT_OPTIONS.join(' / '),
                    })}
                    disabled={!beatTarget || sourcePickerBusy}
                    onClick={() => void handlePickFlatSource('reverse')}
                  />
                </div>
                <div className="mt-2 text-[11px] leading-4 text-text-muted">
                  {t('viewer.threeD.selectedBackgroundSourceHint')}
                </div>
                {sourcePickerError && (
                  <div className={`mt-2 max-h-24 overflow-y-auto ${NODE_INLINE_ERROR_MESSAGE_CLASS}`}>
                    {sourcePickerError}
                  </div>
                )}
              </div>
            )}

            {isSetDirectorCombinedSkill && (
              <div className="rounded-[8px] border border-cyan-300/20 bg-cyan-300/[0.06] p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-cyan-100">
                    {t('viewer.threeD.directorCombinedSourceTitle')}
                  </div>
                  {sourcePickerBusy && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-100/70" />
                  )}
                </div>
                <SourceActionButton
                  icon={<Camera className="h-3.5 w-3.5" />}
                  title={t('viewer.threeD.directorWorld')}
                  detail={t('viewer.threeD.directorCombinedDirectorWorldDetail')}
                  disabled={!beatTarget || sourcePickerBusy}
                  onClick={() => void openContextDirectorWorld('director_combined')}
                  className="w-full"
                />
                <div className="mt-2 text-[11px] leading-4 text-text-muted">
                  {t('viewer.threeD.directorCombinedSourceHint')}
                </div>
                {sourcePickerError && (
                  <div className={`mt-2 max-h-24 overflow-y-auto ${NODE_INLINE_ERROR_MESSAGE_CLASS}`}>
                    {sourcePickerError}
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">
                {t('viewer.threeD.skillStatus.outputs')}
              </div>
              <div className="flex flex-wrap gap-2">
                {skill.outputs.map((output) => (
                  <span
                    key={output.role}
                    className="rounded-full border border-emerald-200/20 bg-emerald-300/10 px-2 py-1 text-[11px] text-emerald-100"
                  >
                    {translateSkillOutputLabel(output.role, output.label, t)}
                  </span>
                ))}
              </div>
            </div>

            <button
              type="button"
              disabled={!ready || isBusy}
              onClick={handleSubmit}
              className="mt-auto inline-flex items-center justify-center gap-2 rounded-[8px] bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-text-muted"
            >
              {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {submitLabel}
            </button>
            {data.generationError ? (
              <div className={`max-h-32 overflow-y-auto ${NODE_INLINE_ERROR_MESSAGE_CLASS}`}>
                {data.generationError}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-text-muted">
            {t('viewer.threeD.skillStatus.missingSkill', {
              id: data.skill_id || t('viewer.threeD.skillStatus.emptySkillId'),
            })}
          </div>
        )}
      </div>
      {isSetSelectedBackgroundSkill && beatTarget && cropSource && (
        <BackgroundCropperDialog
          isOpen={Boolean(cropSource)}
          onClose={() => setCropSource(null)}
          sourceUrl={cropSource.url}
          sourceLabel={cropSource.label}
          aspectOptions={SELECTED_BACKGROUND_CROP_ASPECT_OPTIONS}
          onConfirmBlob={(blob, filename) =>
            uploadAndStageSelectedBackground(
              blob,
              filename,
              t('viewer.threeD.selectedBackgroundOutputLabel', {
                episode: beatTarget.episode,
                beat: beatTarget.beat,
              }),
            )
          }
          onCandidateSuccess={() => setSourcePickerError(null)}
          onError={(message) => setSourcePickerError(message)}
        />
      )}
      {inputHandleIds.map((handleId, index) => (
        <Handle
          key={`fallback-${handleId}`}
          type="target"
          position={Position.Left}
          id={handleId}
          className="!pointer-events-none !h-2.5 !w-2.5 !border-0 !bg-cyan-300 !opacity-0"
          style={{ top: handleTop(index, inputHandleIds.length) }}
        />
      ))}
      {(isSetSelectedBackgroundSkill || isSetDirectorCombinedSkill) && beatTarget && (
        <ThreeDDirectorDialog
          open={directorStageOpen}
          onOpenChange={handleDirectorWorldOpenChange}
          manifest={directorStageManifest}
          title={t('viewer.threeD.beatDirectorWorld')}
          description={t('viewer.threeD.beatDirectorWorldDescription')}
          viewerPurpose="beat"
          autoCommitDirectorCombined={mainlineManaged}
          onCaptureSelectedBackground={
            directorWorldDestination === 'selected_background'
              ? handleDirectorWorldCaptureSuccess
              : undefined
          }
          onSubmitDirectorCombined={
            directorWorldDestination === 'director_combined'
              ? handleDirectorWorldCaptureSuccess
              : undefined
          }
        />
      )}
    </div>
  );
});
