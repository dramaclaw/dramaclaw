// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2, X } from "lucide-react";

import type { ImpactBeat, PushResult, PushTarget, PushTargetKind } from "@/api/push";
import {
  modelSourceUrlFromNodeData,
  type DropMediaType,
} from "@/stores/assetDropStore";
import {
  listCharacters,
  listCharacterIdentities,
  listEpisodes,
  listBeats,
  listScenes,
  type SupertaleCharacter,
  type SupertaleIdentity,
  type SupertaleEpisodeSummary,
} from "@/api/projects";
import type { SceneAsset } from "@/types/scene";
import { UiButton, UiInput, UiPanel, UiSelect } from "@/components/ui";
import {
  UI_DIALOG_TRANSITION_MS,
} from "@/components/ui/motion";
import { useDialogTransition } from "@/components/ui/useDialogTransition";
import { previewAssetImpact, promoteToAsset } from "./promoteToAsset";
import { commitDirectorRenderFromCanvasSource } from "./directorRenderCommit";
import {
  commitSceneDirectorWorldFromCanvasNode,
  hasDirectorWorldSceneState,
  isDirectorWorldSourceSlotTarget,
} from "./sceneDirectorWorldCommit";
import { nodeDataAfterCommittedSlot } from "./committedNodePatch";
import { isAutoEpisodeTitle } from "@/lib/episode-title";

// CommitDialog 显示给用户的 slot 选项。已隐藏:
// - scene_360       — 已 deprecate (presets.py:703-710 注释),被 scene_director_pano_360 取代
// - scene_spatial_layout — 当前主线不再展示/回写空间布局图,保留 type 只为旧数据兼容
// - scene_3gs_active_ply — 派生指针 (manifest 自动更新指向 master/reverse/pano 之一),
//                           不应该让用户直接 push;真要更新去 push 对应的 master/reverse/pano_ply
// - scene_3gs_collision_glb — 碰撞辅助文件,不是资产页可见场景槽位
// - director_render is a structured bundle target. In user-facing UX we call it
//   a "导演合成资产"; commit code wraps ordinary canvas images as manual bundles.
// Backend PushTargetKind type 仍保留这些 kind (兼容旧 canvas / 旧 client 传入),
// 只是 UI 不主动列出。
const KIND_LABELS: Record<PushTargetKind, string> = {
  frame: "首帧",
  sketch: "草图",
  director_render: "导演合成资产",
  selected_background: "当前背景",
  identity: "角色身份图",
  identity_costume: "身份服装图",
  identity_portrait: "年龄身份肖像",
  portrait: "角色肖像",
  scene_master: "场景主图",
  scene_reverse_master: "反面场景图",
  scene_spatial_layout: "Scene Spatial Layout (空间布局图)",
  scene_360: "Scene 360 (DEPRECATED — use Director Pano 360)",
  scene_director_world: "导演世界",
  scene_director_pano_360: "Director Pano 360 (3GS 全景图)",
  scene_3gs_active_ply: "3D 世界（当前入口）",
  scene_3gs_master_ply: "3D 世界（正面）",
  scene_3gs_reverse_ply: "3D 世界（背面）",
  scene_3gs_pano_ply: "3D 世界（360）",
  scene_3gs_custom_scene: "3D 世界（自定义场景）",
  scene_3gs_collision_glb: "3D 世界碰撞体",
  prop_ref: "Prop Reference (道具参考)",
  video: "Video (beat 视频)",
  beat_audio: "Audio (beat 音频)",
};

// 用户主动选择面板里隐藏的 slot kinds (defaultTarget 仍可被推断到,只是不
// 在 UiSelect dropdown 里手动选)。
const HIDDEN_KINDS = new Set<PushTargetKind>([
  "scene_360",
  "scene_spatial_layout",
  "scene_director_world",
  "scene_3gs_active_ply",
  "scene_3gs_collision_glb",
]);

export function isUserSelectableCommitKind(kind: PushTargetKind): boolean {
  return kind !== "video" && kind !== "beat_audio" && !HIDDEN_KINDS.has(kind);
}

const GLOBAL_SLOT_KINDS = new Set<PushTargetKind>([
  "identity",
  "identity_costume",
  "identity_portrait",
  "portrait",
  "scene_master",
  "scene_reverse_master",
  "scene_spatial_layout",
  "scene_director_pano_360",
  "scene_3gs_master_ply",
  "scene_3gs_reverse_ply",
  "scene_3gs_pano_ply",
  "scene_3gs_custom_scene",
  "prop_ref",
]);

const BEAT_SLOT_KINDS: PushTargetKind[] = [
  "frame",
  "sketch",
  "director_render",
  "selected_background",
];

const COMMIT_FIELD_BORDER_CLASS =
  "!border-[rgba(255,255,255,0.13)] hover:!border-[rgba(255,255,255,0.22)] focus-visible:!border-[rgb(var(--accent-rgb)/0.55)]";
const COMMIT_SELECT_MENU_CLASS =
  "!z-[260] !border-[rgba(255,255,255,0.14)] !bg-[#101217] shadow-[0_18px_44px_rgba(0,0,0,0.55)]";

function renderCommitSuccessMessage(target: PushTarget, result: PushResult): string {
  if (target.kind === "director_render") {
    return `已提交导演合成资产：${result.target_path}（含纯背景和元数据）`;
  }
  if (target.kind === "scene_director_world") {
    return `已提交导演世界：${result.target_path}`;
  }
  return `已提交到 ${result.target_path}` +
    (result.backup ? `(旧文件 backup 至 ${result.backup})` : "") +
    (result.stale_marked ? `；已标记 ${result.stale_marked} 个镜头需重生` : "");
}

const SCENE_SLOT_KINDS = new Set<PushTargetKind>([
  "scene_master",
  "scene_reverse_master",
  "scene_spatial_layout",
  "scene_director_world",
  "scene_director_pano_360",
  "scene_3gs_master_ply",
  "scene_3gs_reverse_ply",
  "scene_3gs_pano_ply",
  "scene_3gs_custom_scene",
]);

const MODEL_WORLD_SLOT_KINDS: PushTargetKind[] = [
  "scene_3gs_master_ply",
  "scene_3gs_reverse_ply",
  "scene_3gs_pano_ply",
  "scene_3gs_custom_scene",
];

const MODEL_PANO_SLOT_KINDS: PushTargetKind[] = [
  "scene_director_pano_360",
];
const EMPTY_DIRECTOR_WORLD_SOURCE_ID = "__empty_director_world__";

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sourceUrlFromRecord(source: Record<string, unknown>): string {
  return (
    stringValue(source.url) ||
    stringValue(source.ply_url) ||
    stringValue(source.pano_url) ||
    stringValue(source.fs) ||
    stringValue(source.pano_fs)
  );
}

function isEmptyDirectorWorldSourceId(sourceId: string): boolean {
  return sourceId === EMPTY_DIRECTOR_WORLD_SOURCE_ID;
}

export function modelSlotKindsForNodeData(
  nodeData: Record<string, unknown> | null | undefined,
  sourceUrl: string,
): PushTargetKind[] {
  const sources = Array.isArray(nodeData?.sources)
    ? nodeData.sources.filter((source): source is Record<string, unknown> =>
        Boolean(source && typeof source === "object"),
      )
    : [];
  const activeSourceId = stringValue(nodeData?.activeSourceId);
  if (isEmptyDirectorWorldSourceId(activeSourceId)) {
    return [];
  }
  const activeSource =
    sources.find((source) => stringValue(source.id) === activeSourceId) ??
    sources.find((source) => sourceUrlFromRecord(source) === sourceUrl) ??
    sources[0];
  if (activeSourceId && !sourceUrlFromRecord(activeSource ?? {})) {
    return [];
  }
  if (stringValue(activeSource?.source_type) === "pano360") {
    return MODEL_PANO_SLOT_KINDS;
  }
  if (stringValue(nodeData?.panoUrl) && !stringValue(nodeData?.plyUrl)) {
    return MODEL_PANO_SLOT_KINDS;
  }
  return MODEL_WORLD_SLOT_KINDS;
}

interface CommitDialogProps {
  project: string;
  /** Source media URL (must be /static/<u>/<p>/...). 图像/视频/音频/3GS。 */
  sourceUrl: string;
  /** Optional thumbnail for header preview. */
  previewUrl?: string | null;
  /** Optional human label from the canvas node; avoids exposing raw generated file names. */
  sourceLabelOverride?: string | null;
  /** 来源节点的媒体类型;决定预览方式与可选提交目标。默认 image。 */
  mediaType?: DropMediaType;
  /** Optional default target inferred from where the source came from. */
  defaultTarget?: Partial<PushTarget> & { kind: PushTargetKind };
  /** Complete director bundle, if this image is still the original Director render asset. */
  directorControlBundle?: Record<string, unknown> | null;
  /** Canvas node state for structured commits that are not plain file replacements. */
  nodeData?: Record<string, unknown> | null;
  /** Reads the latest canvas node state at submit time. */
  getNodeData?: () => Record<string, unknown> | null | undefined;
  onClose: () => void;
  onSuccess: (
    msg: string,
    result: PushResult,
    target: PushTarget,
    nodeDataPatch?: Record<string, unknown> | null,
  ) => void;
}

export function CommitDialog({
  project,
  sourceUrl,
  previewUrl,
  sourceLabelOverride,
  mediaType = "image",
  defaultTarget,
  directorControlBundle,
  nodeData,
  getNodeData,
  onClose,
  onSuccess,
}: CommitDialogProps) {
  const modelSlotKinds = mediaType === "model"
    ? modelSlotKindsForNodeData(nodeData, sourceUrl)
    : [];
  const defaultKind = defaultTarget?.kind;
  const initialKind =
    mediaType === "video"
      ? "video"
      : mediaType === "audio"
        ? "beat_audio"
        : mediaType === "model"
          ? defaultKind && (defaultKind === "scene_director_world" || modelSlotKinds.includes(defaultKind))
            ? defaultKind
            : modelSlotKinds[0] ?? "scene_3gs_custom_scene"
          : defaultKind ?? "frame";
  const [kind, setKind] = useState<PushTargetKind>(
    initialKind,
  );
  // beat-style target
  const [episode, setEpisode] = useState<number | null>(
    typeof (defaultTarget as { episode?: number })?.episode === "number"
      ? (defaultTarget as { episode: number }).episode
      : null,
  );
  const [beat, setBeat] = useState<number | null>(
    typeof (defaultTarget as { beat?: number })?.beat === "number"
      ? (defaultTarget as { beat: number }).beat
      : null,
  );
  // identity-style target
  const [character, setCharacter] = useState<string | null>(
    typeof (defaultTarget as { character?: string })?.character === "string"
      ? (defaultTarget as { character: string }).character
      : null,
  );
  const [identityId, setIdentityId] = useState<string | null>(
    typeof (defaultTarget as { identity_id?: string })?.identity_id === "string"
      ? (defaultTarget as { identity_id: string }).identity_id
      : null,
  );
  const [sceneId, setSceneId] = useState<string>(
    typeof (defaultTarget as { scene_id?: string })?.scene_id === "string"
      ? (defaultTarget as { scene_id: string }).scene_id
      : "",
  );
  const [propId, setPropId] = useState<string>(
    typeof (defaultTarget as { prop_id?: string })?.prop_id === "string"
      ? (defaultTarget as { prop_id: string }).prop_id
      : "",
  );

  const [episodes, setEpisodes] = useState<SupertaleEpisodeSummary[]>([]);
  const [scenes, setScenes] = useState<SceneAsset[]>([]);
  const [scenesLoading, setScenesLoading] = useState(false);
  const [beatOptions, setBeatOptions] = useState<number[]>([]);
  const [beatsLoading, setBeatsLoading] = useState(false);
  const [characters, setCharacters] = useState<SupertaleCharacter[]>([]);
  const [identityOptions, setIdentityOptions] = useState<SupertaleIdentity[]>([]);
  const [identitiesLoading, setIdentitiesLoading] = useState(false);
  const [impactBeats, setImpactBeats] = useState<ImpactBeat[]>([]);
  const [impactLoading, setImpactLoading] = useState(false);
  const [markStale, setMarkStale] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { shouldRender, isVisible } = useDialogTransition(true, UI_DIALOG_TRANSITION_MS);

  // Load non-scene context lists for dropdowns. Keep this independent from
  // scene loading so a scene endpoint failure cannot break beat/identity commits.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [chars, eps] = await Promise.all([
          listCharacters(project),
          listEpisodes(project),
        ]);
        if (cancelled) return;
        setCharacters(chars);
        setEpisodes(eps);
        if (episode === null && eps.length > 0) {
          setEpisode(eps[0].episode_num ?? 1);
        }
        if (character === null && chars.length > 0) {
          setCharacter(chars[0].name);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载选项失败");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project]);

  useEffect(() => {
    let cancelled = false;
    setScenesLoading(true);
    (async () => {
      try {
        const sceneAssets = await listScenes(project);
        if (cancelled) return;
        setScenes(sceneAssets);
        setSceneId((current) =>
          current.trim() || sceneOptionValue(sceneAssets[0]) || "",
        );
      } catch (err) {
        if (cancelled) return;
        void err;
        setScenes([]);
      } finally {
        if (!cancelled) setScenesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project]);

  // Refresh beats count when episode changes.
  useEffect(() => {
    let cancelled = false;
    if (episode === null) {
      setBeatOptions([]);
      setBeat(null);
      setBeatsLoading(false);
      return;
    }
    setBeatsLoading(true);
    (async () => {
      try {
        const beats = await listBeats(project, episode);
        if (cancelled) return;
        const options = beats
          .map((item, index) => {
            if (typeof item.beat_number === "number" && Number.isFinite(item.beat_number)) {
              return item.beat_number;
            }
            if (typeof item.beat_index === "number" && Number.isFinite(item.beat_index)) {
              return item.beat_index > 0 ? item.beat_index : item.beat_index + 1;
            }
            return index + 1;
          })
          .filter((value) => value > 0);
        const uniqueOptions = Array.from(new Set(options));
        setBeatOptions(uniqueOptions);
        setBeat((current) => {
          if (uniqueOptions.length === 0) return null;
          return current !== null && uniqueOptions.includes(current)
            ? current
            : uniqueOptions[0];
        });
      } catch {
        if (cancelled) return;
        setBeatOptions([]);
        setBeat(null);
      } finally {
        if (!cancelled) setBeatsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project, episode]);

  const isBeatStyle =
    kind === "frame" ||
    kind === "sketch" ||
    kind === "director_render" ||
    kind === "selected_background" ||
    kind === "video" ||
    kind === "beat_audio";
  const isIdentityStyle =
    kind === "identity" ||
    kind === "identity_costume" ||
    kind === "identity_portrait" ||
    kind === "portrait";
  const needsIdentityId =
    kind === "identity" ||
    kind === "identity_costume" ||
    kind === "identity_portrait";
  const isSceneStyle = SCENE_SLOT_KINDS.has(kind);
  const isPropStyle = kind === "prop_ref";
  const isGlobalSlot = GLOBAL_SLOT_KINDS.has(kind);
  const modelCommitKindAllowed =
    mediaType !== "model" || kind === "scene_director_world" || modelSlotKinds.includes(kind);
  const noTargetYet = mediaType === "model" && !modelCommitKindAllowed;
  const noModelSourceForSlotCommit = mediaType === "model" && modelSlotKinds.length === 0;
  const showTargetKindSelect = mediaType === "image" ||
    (mediaType === "model" && kind !== "scene_director_world");
  const targetKindOptions = Object.entries(KIND_LABELS)
    .filter(([k]) => {
      const optionKind = k as PushTargetKind;
      if (!isUserSelectableCommitKind(optionKind)) return false;
      return mediaType === "model" ? modelSlotKinds.includes(optionKind) : true;
    });

  useEffect(() => {
    let cancelled = false;
    if (!needsIdentityId || !character) {
      setIdentityOptions([]);
      setIdentitiesLoading(false);
      return;
    }

    const embeddedIdentities =
      characters.find((candidate) => candidate.name === character)?.identities ?? [];
    if (embeddedIdentities.length > 0) {
      setIdentityOptions(embeddedIdentities);
      setIdentitiesLoading(false);
      setIdentityId((current) => {
        if (current && embeddedIdentities.some((item) => identityOptionValue(item) === current)) {
          return current;
        }
        return current || firstIdentityOptionValue(embeddedIdentities);
      });
      return;
    }

    setIdentitiesLoading(true);
    (async () => {
      try {
        const identities = await listCharacterIdentities(project, character);
        if (cancelled) return;
        setIdentityOptions(identities);
        setIdentityId((current) => {
          if (current && identities.some((item) => identityOptionValue(item) === current)) {
            return current;
          }
          return current || firstIdentityOptionValue(identities);
        });
      } catch (err) {
        if (cancelled) return;
        setIdentityOptions([]);
        setIdentityId(null);
        setError(err instanceof Error ? err.message : "加载 identity_id 失败");
      } finally {
        if (!cancelled) setIdentitiesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project, character, characters, needsIdentityId]);

  const displayedIdentityOptions = identityOptionsForSelect(identityOptions, identityId);

  const target = buildTarget(kind, episode, beat, character, identityId, sceneId, propId);
  const targetLabel = target ? renderTargetLabel(target) : "目标未完整";
  const nodeSourceLabel =
    typeof sourceLabelOverride === "string" && sourceLabelOverride.trim()
      ? sourceLabelOverride.trim()
      : "";
  const sourceLabel = nodeSourceLabel || sourceDisplayName(sourceUrl);
  const mediaLabel = renderMediaLabel(mediaType);
  const modelSourceLabel = mediaType === "model"
    ? directorWorldSourceDisplayName(nodeData, sourceUrl, nodeSourceLabel)
    : "";
  const commitSourceTitle = target?.kind === "scene_director_world"
    ? "导演世界状态"
    : mediaType === "model"
      ? modelSourceLabel
      : mediaLabel;
  const commitSourceSubtitle = target?.kind === "scene_director_world"
    ? "提交当前导演世界 manifest"
    : mediaType === "model"
      ? "提交当前 3D 世界到主线场景"
      : sourceLabel;
  const commitSourceBadge = target?.kind === "scene_director_world"
    ? "WORLD"
    : mediaType === "audio"
      ? "audio"
      : mediaType === "model"
        ? "3gs"
        : "image";

  useEffect(() => {
    let cancelled = false;
    if (!target || !GLOBAL_SLOT_KINDS.has(target.kind)) {
      setImpactBeats([]);
      setImpactLoading(false);
      return;
    }
    setImpactLoading(true);
    (async () => {
      try {
        const result = await previewAssetImpact(project, target);
        if (cancelled) return;
        setImpactBeats(result.affected_beats ?? []);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setImpactBeats([]);
      } finally {
        if (!cancelled) setImpactLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project, kind, episode, beat, character, identityId, sceneId, propId]);

  const ready =
    !submitting &&
    !!sourceUrl &&
    !noTargetYet &&
    ((isBeatStyle && episode !== null && beat !== null) ||
      (isIdentityStyle && !!character && (!needsIdentityId || !!identityId)) ||
      (isSceneStyle && !!sceneId.trim()) ||
      (isPropStyle && !!propId.trim()));

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const target = buildTarget(kind, episode, beat, character, identityId, sceneId, propId);
      if (!target) throw new Error("目标不完整");
      if (mediaType === "model" && isDirectorWorldSourceSlotTarget(target) && !modelSlotKinds.includes(target.kind)) {
        throw new Error("无来源没有可提交的 3D 世界素材；请切换到具体世界来源后再提交到主线槽位。");
      }
      if (target.kind === "director_render") {
        const result = await commitDirectorRenderFromCanvasSource(project, target, {
          sourceUrl,
          previewUrl,
          bundle: directorControlBundle,
        });
        onSuccess(renderCommitSuccessMessage(target, result), result, target);
        onClose();
        return;
      }
      if (target.kind === "scene_director_world") {
        const latestNodeData = getNodeData?.() ?? nodeData;
        if (!latestNodeData) {
          throw new Error("导演世界提交需要画布节点状态");
        }
        const result = await commitSceneDirectorWorldFromCanvasNode(project, target, latestNodeData);
        onSuccess(renderCommitSuccessMessage(target, result), result, target);
        onClose();
        return;
      }
      const latestNodeData = getNodeData?.() ?? nodeData;
      const submitSourceUrl =
        mediaType === "model" && latestNodeData
          ? modelSourceUrlFromNodeData(latestNodeData) ?? sourceUrl
          : sourceUrl;
      const result = await promoteToAsset(project, submitSourceUrl, target, {
        mark_stale: markStale && GLOBAL_SLOT_KINDS.has(target.kind),
      });
      let message = renderCommitSuccessMessage(target, result);
      let nodeDataPatch: Record<string, unknown> | null = null;
      const directorWorldManifestData =
        mediaType === "model" && latestNodeData && isDirectorWorldSourceSlotTarget(target)
          ? nodeDataAfterCommittedSlot(latestNodeData, target, result, project)
          : null;
      if (latestNodeData && !isDirectorWorldSourceSlotTarget(target)) {
        nodeDataPatch = nodeDataAfterCommittedSlot(latestNodeData, target, result, project);
      }
      if (directorWorldManifestData && isDirectorWorldSourceSlotTarget(target)) {
        nodeDataPatch = directorWorldManifestData;
        if (hasDirectorWorldSceneState(directorWorldManifestData)) {
          await commitSceneDirectorWorldFromCanvasNode(
            project,
            { kind: "scene_director_world", scene_id: target.scene_id },
            directorWorldManifestData,
            { pruneStale: false },
          );
          message += "；已同步导演世界状态";
        }
      }
      onSuccess(message, result, target, nodeDataPatch);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!shouldRender || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[220] flex items-center justify-center">
      <div
        className={`absolute inset-0 bg-black/55 backdrop-blur-[2px] transition-opacity duration-200 ${
          isVisible ? "opacity-100" : "opacity-0"
        }`}
        onClick={submitting ? undefined : onClose}
      />
      <UiPanel
        className={`relative flex max-h-[82vh] w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden !bg-[rgb(var(--surface-rgb))] transition-[opacity,transform] duration-200 ${
          isVisible ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
        }`}
      >
        <header className="flex items-start gap-3 px-5 pb-2 pt-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold leading-tight text-text-dark">提交到主线资产</h2>
            <p className="mt-0.5 truncate text-xs text-text-muted">项目：{project}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-text-muted transition hover:text-text-dark disabled:opacity-30"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto px-5 pb-4 pt-2">
          <div className="flex items-center gap-3 rounded-lg border border-[rgba(255,255,255,0.13)] bg-[var(--ui-surface-field)] p-2">
            {mediaType === "video" ? (
              <video
                src={sourceUrl}
                muted
                playsInline
                className="h-14 w-14 shrink-0 rounded-full object-cover"
              />
            ) : mediaType === "audio" ? (
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-black/30 text-[10px] uppercase tracking-[0.08em] text-text-muted">
                {commitSourceBadge}
              </div>
            ) : mediaType === "model" ? (
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-black/30 text-[10px] uppercase tracking-[0.08em] text-text-muted">
                {commitSourceBadge}
              </div>
            ) : previewUrl ? (
              <img
                src={previewUrl}
                alt="source preview"
                className="h-14 w-14 shrink-0 rounded-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-black/30 text-[10px] uppercase tracking-[0.08em] text-text-muted">
                {commitSourceBadge}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="mt-0.5 truncate text-sm font-medium text-text-dark">{commitSourceTitle}</div>
              <div className="mt-0.5 truncate text-xs text-text-muted/88">{commitSourceSubtitle}</div>
            </div>
          </div>

          {noTargetYet && (
            <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2.5 text-xs leading-relaxed text-amber-200/90">
              {noModelSourceForSlotCommit
                ? "无来源没有可提交的 3D 世界素材；请切换到具体世界来源后再提交到主线槽位。"
                : "当前 3D 世界没有可提交到该槽位的素材。"}
            </div>
          )}

          {/* 目标类型下拉：图像可选全部可见槽；3D 模型只可选场景 3GS 槽。 */}
          {showTargetKindSelect && (
            <Section title="目标类型">
              <UiSelect
                value={kind}
                onChange={(e) => setKind(e.target.value as PushTargetKind)}
                aria-label="目标类型"
                className={COMMIT_FIELD_BORDER_CLASS}
                menuClassName={COMMIT_SELECT_MENU_CLASS}
              >
                {targetKindOptions
                  .map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
              </UiSelect>
            </Section>
          )}

          {!noTargetYet && isBeatStyle && (
            <Section title="目标位置">
              {mediaType === "image" && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {BEAT_SLOT_KINDS.map((slotKind) => {
                    const active = kind === slotKind;
                    return (
                      <button
                        key={slotKind}
                        type="button"
                        onClick={() => setKind(slotKind)}
                        className={`inline-flex h-7 items-center rounded-md border px-2.5 text-[11px] font-medium transition-colors ${
                          active
                            ? "border-accent bg-accent text-white"
                            : "border-[color:var(--ui-border-soft)] bg-[var(--ui-surface-field)] text-text-muted hover:border-[color:var(--ui-border-strong)] hover:text-text-dark"
                        }`}
                      >
                        {shortKindLabel(slotKind)}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="flex gap-2">
                <div className="flex-1">
                  <UiSelect
                    value={episode ?? ""}
                    onChange={(e) => setEpisode(Number(e.target.value))}
                    aria-label="集数"
                    className={COMMIT_FIELD_BORDER_CLASS}
                    menuClassName={COMMIT_SELECT_MENU_CLASS}
                  >
                    {episodes.map((ep) => (
                      <option key={ep.episode_num} value={ep.episode_num}>
                        ep{ep.episode_num}
                        {ep.title && !isAutoEpisodeTitle(ep.title, ep.episode_num)
                          ? ` · ${ep.title}`
                          : ""}
                      </option>
                    ))}
                  </UiSelect>
                </div>
                <div className="w-32">
                  <UiSelect
                    value={beat ?? ""}
                    onChange={(e) => setBeat(Number(e.target.value))}
                    disabled={beatsLoading || beatOptions.length === 0}
                    aria-label="Beat"
                    className={COMMIT_FIELD_BORDER_CLASS}
                    menuClassName={COMMIT_SELECT_MENU_CLASS}
                  >
                    {beatsLoading && (
                      <option value="" disabled>
                        加载 beat…
                      </option>
                    )}
                    {!beatsLoading && beatOptions.length === 0 && (
                      <option value="" disabled>
                        无 beat
                      </option>
                    )}
                    {beatOptions.map((n) => (
                      <option key={n} value={n}>
                        B{n}
                      </option>
                    ))}
                  </UiSelect>
                </div>
              </div>
            </Section>
          )}

          {isIdentityStyle && (
            <Section title="目标位置">
              <div className="space-y-2">
                <UiSelect
                  value={character ?? ""}
                  onChange={(e) => {
                    setCharacter(e.target.value);
                    setIdentityId(null);
                  }}
                  aria-label="角色"
                  className={COMMIT_FIELD_BORDER_CLASS}
                  menuClassName={COMMIT_SELECT_MENU_CLASS}
                >
                  {characters.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.display_name || c.name}
                    </option>
                  ))}
                </UiSelect>
                {needsIdentityId && (
                  <UiSelect
                    value={identityId ?? ""}
                    onChange={(e) => setIdentityId(e.target.value)}
                    disabled={identitiesLoading}
                    aria-label="identity_id"
                    className={COMMIT_FIELD_BORDER_CLASS}
                    menuClassName={COMMIT_SELECT_MENU_CLASS}
                  >
                    {identitiesLoading ? (
                      <option value="" disabled>
                        加载 identity_id…
                      </option>
                    ) : displayedIdentityOptions.length === 0 ? (
                      <option value="" disabled>
                        当前角色没有 identity_id
                      </option>
                    ) : (
                      displayedIdentityOptions.map((id) => {
                        const value = identityOptionValue(id);
                        return (
                          <option key={value} value={value}>
                            {identityOptionLabel(id)}
                          </option>
                        );
                      })
                    )}
                  </UiSelect>
                )}
              </div>
            </Section>
          )}

          {isSceneStyle && (
            <Section title="目标位置">
              {scenes.length > 0 ? (
                <UiSelect
                  value={sceneId}
                  onChange={(e) => setSceneId(e.target.value)}
                  disabled={scenesLoading}
                  aria-label="场景"
                  className={COMMIT_FIELD_BORDER_CLASS}
                  menuClassName={COMMIT_SELECT_MENU_CLASS}
                >
                  {scenes.map((scene) => {
                    const value = sceneOptionValue(scene);
                    if (!value) return null;
                    return (
                      <option key={value} value={value}>
                        {sceneOptionLabel(scene)}
                      </option>
                    );
                  })}
                </UiSelect>
              ) : (
                <UiInput
                  value={sceneId}
                  onChange={(e) => setSceneId(e.target.value)}
                  placeholder="scene_id,例如:兰州拉面馆"
                  className={COMMIT_FIELD_BORDER_CLASS}
                />
              )}
              <p className="mt-2 text-[11px] text-text-muted">将写入该场景资产槽位。</p>
            </Section>
          )}

          {isPropStyle && (
            <Section title="目标位置">
              <UiInput
                value={propId}
                onChange={(e) => setPropId(e.target.value)}
                placeholder="prop_id,例如:办公纸箱"
                className={COMMIT_FIELD_BORDER_CLASS}
              />
              <p className="mt-2 text-[11px] text-text-muted">将写入该道具参考资产槽位。</p>
            </Section>
          )}

          {isGlobalSlot && (
            <Section title="影响预览">
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.08] p-3 text-xs">
                {impactLoading ? (
                  <div className="flex items-center gap-2 text-text-muted">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    正在计算影响范围…
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      将影响 {impactBeats.length} 个镜头
                    </div>
                    {impactBeats.length > 0 && (
                      <div className="ui-scrollbar mt-2 max-h-28 space-y-1 overflow-y-auto pr-1">
                        {impactBeats.slice(0, 12).map((b) => (
                          <div key={`${b.episode}-${b.beat}`} className="text-text-muted">
                            EP{b.episode} / B{b.beat}
                            {b.visual_description ? ` · ${b.visual_description.slice(0, 48)}` : ""}
                          </div>
                        ))}
                        {impactBeats.length > 12 && (
                          <div className="text-text-muted">
                            还有 {impactBeats.length - 12} 个未显示
                          </div>
                        )}
                      </div>
                    )}
                    <label className="mt-3 flex cursor-pointer items-start gap-2 text-text-muted">
                      <input
                        type="checkbox"
                        checked={markStale}
                        onChange={(e) => setMarkStale(e.target.checked)}
                        className="sr-only peer"
                      />
                      <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-[rgba(255,255,255,0.22)] bg-bg-dark/60 text-transparent transition-colors peer-checked:border-amber-400/70 peer-checked:bg-amber-400/25 peer-checked:text-amber-200">
                        <svg
                          viewBox="0 0 16 16"
                          className="h-3 w-3"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3.5 8.5l3 3 6-7" />
                        </svg>
                      </span>
                      <span className="leading-relaxed">
                        提交后把这些镜头标记为需重生，后续主流程可按标记重生
                      </span>
                    </label>
                  </>
                )}
              </div>
            </Section>
          )}

          <div className="flex items-start gap-2 px-1 text-[11px] leading-relaxed text-amber-100/70">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-200/55" />
            <span>将覆盖「{targetLabel}」已有资产；原文件会保留在历史记录中。</span>
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-300 break-words">
              {error}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-3.5">
          <UiButton variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            取消
          </UiButton>
          <UiButton
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={!ready}
            className="!h-9 rounded-full !bg-[rgb(var(--accent-rgb))] px-4 text-white hover:!bg-[rgb(var(--accent-rgb)/0.88)]"
          >
            {submitting ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                提交中
              </>
            ) : (
              "提交"
            )}
          </UiButton>
        </footer>
      </UiPanel>
    </div>,
    document.body
  );
}

function identityOptionValue(identity: SupertaleIdentity): string {
  const value = identity.identity_id || identity.id || identity.name || "";
  return String(value).trim();
}

function identityOptionLabel(identity: SupertaleIdentity): string {
  const value = identityOptionValue(identity);
  const displayName = String(identity.identity_name || identity.name || "").trim();
  if (displayName && displayName !== value) {
    return `${displayName} · ${value}`;
  }
  return value;
}

function firstIdentityOptionValue(identities: SupertaleIdentity[]): string | null {
  for (const identity of identities) {
    const value = identityOptionValue(identity);
    if (value) return value;
  }
  return null;
}

function sceneOptionValue(scene: SceneAsset | undefined): string {
  return typeof scene?.name === "string" && scene.name.trim() ? scene.name.trim() : "";
}

export function sceneOptionLabel(scene: SceneAsset): string {
  return sceneOptionValue(scene);
}

function renderMediaLabel(mediaType: DropMediaType): string {
  if (mediaType === "video") return "视频";
  if (mediaType === "audio") return "音频";
  if (mediaType === "model") return "3D 模型";
  return "图片";
}

function sourceDisplayName(sourceUrl: string): string {
  try {
    const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
    const url = new URL(sourceUrl, base);
    const last = url.pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : sourceUrl;
  } catch {
    const last = sourceUrl.split("?")[0].split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : sourceUrl;
  }
}

export function directorWorldSourceDisplayName(
  nodeData: Record<string, unknown> | null | undefined,
  sourceUrl: string,
  fallback: string,
): string {
  const source = activeDirectorWorldSource(nodeData, sourceUrl);
  const label = stringFromUnknown(source?.label);
  if (label) return label;
  const sourceKind = stringFromUnknown(source?.source_kind);
  if (sourceKind === "master") return "正面 3D 世界";
  if (sourceKind === "reverse") return "背面 3D 世界";
  if (sourceKind === "pano") return source?.source_type === "pano360" ? "360 图" : "360 3D 世界";
  if (sourceKind === "custom") return "自定义 3D 世界";
  if (sourceKind === "uploaded") return "上传 3D 世界";
  const sourceType = stringFromUnknown(source?.source_type);
  if (sourceType === "pano360") return "360 图";
  return fallback && !looksLikeAssetFilename(fallback) ? fallback : "3D 世界";
}

function activeDirectorWorldSource(
  nodeData: Record<string, unknown> | null | undefined,
  sourceUrl: string,
): Record<string, unknown> | null {
  const sources = Array.isArray(nodeData?.sources)
    ? nodeData.sources.filter((source): source is Record<string, unknown> =>
        Boolean(source && typeof source === "object"),
      )
    : [];
  const activeSourceId = stringFromUnknown(nodeData?.activeSourceId);
  return (
    (activeSourceId ? sources.find((source) => stringFromUnknown(source.id) === activeSourceId) : undefined) ??
    sources.find((source) => sourceRecordUrl(source) === sourceUrl) ??
    sources.find((source) => source.current === true) ??
    sources[0] ??
    null
  );
}

function sourceRecordUrl(source: Record<string, unknown>): string {
  for (const key of ["url", "ply_url", "pano_url", "fs", "pano_fs"]) {
    const value = stringFromUnknown(source[key]);
    if (value) return value;
  }
  return "";
}

function stringFromUnknown(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function looksLikeAssetFilename(value: string): boolean {
  return /\.[a-z0-9]{2,5}$/i.test(value.trim());
}

function identityOptionsForSelect(
  identities: SupertaleIdentity[],
  currentIdentityId: string | null,
): SupertaleIdentity[] {
  const options = identities.filter((identity) => identityOptionValue(identity));
  if (
    currentIdentityId &&
    !options.some((identity) => identityOptionValue(identity) === currentIdentityId)
  ) {
    return [{ id: currentIdentityId, identity_id: currentIdentityId }, ...options];
  }
  return options;
}

function buildTarget(
  kind: PushTargetKind,
  episode: number | null,
  beat: number | null,
  character: string | null,
  identityId: string | null,
  sceneId: string,
  propId: string,
): PushTarget | null {
  if (
    kind === "frame" ||
    kind === "sketch" ||
    kind === "director_render" ||
    kind === "selected_background" ||
    kind === "video" ||
    kind === "beat_audio"
  ) {
    if (episode === null || beat === null) return null;
    return { kind, episode, beat };
  }
  if (
    kind === "identity" ||
    kind === "identity_costume" ||
    kind === "identity_portrait"
  ) {
    if (!character || !identityId) return null;
    return { kind, character, identity_id: identityId };
  }
  if (kind === "portrait") {
    if (!character) return null;
    return { kind: "portrait", character };
  }
  if (SCENE_SLOT_KINDS.has(kind)) {
    const trimmed = sceneId.trim();
    if (!trimmed) return null;
    return { kind, scene_id: trimmed } as PushTarget;
  }
  if (kind === "prop_ref") {
    const trimmed = propId.trim();
    if (!trimmed) return null;
    return { kind: "prop_ref", prop_id: trimmed };
  }
  return null;
}

function renderTargetLabel(t: PushTarget): string {
  if (
    t.kind === "frame" ||
    t.kind === "sketch" ||
    t.kind === "director_render" ||
    t.kind === "selected_background" ||
    t.kind === "video" ||
    t.kind === "beat_audio"
  ) {
    return `EP${t.episode} / B${t.beat} / ${shortKindLabel(t.kind)}`;
  }
  if (t.kind === "identity") return `${t.character} / ${t.identity_id} / Identity`;
  if (t.kind === "identity_costume") {
    return `${t.character} / ${t.identity_id} / Identity Costume`;
  }
  if (t.kind === "identity_portrait") {
    return `${t.character} / ${t.identity_id} / Identity Portrait`;
  }
  if (t.kind === "portrait") return `${t.character} / Portrait`;
  if (SCENE_SLOT_KINDS.has(t.kind)) {
    return `${(t as unknown as Record<string, unknown>).scene_id} / ${shortKindLabel(t.kind)}`;
  }
  return `${(t as unknown as Record<string, unknown>).prop_id} / Prop Reference`;
}

function shortKindLabel(kind: PushTargetKind): string {
  if (kind === "frame") return "首帧";
  if (kind === "sketch") return "草图";
  if (kind === "director_render") return "导演合成资产";
  if (kind === "selected_background") return "当前背景";
  if (kind === "video") return "视频";
  if (kind === "beat_audio") return "音频";
  if (kind === "identity") return "角色身份图";
  if (kind === "identity_costume") return "身份服装图";
  if (kind === "identity_portrait") return "年龄身份肖像";
  if (kind === "portrait") return "角色肖像";
  if (kind === "scene_master") return "场景主图";
  if (kind === "scene_reverse_master") return "反面场景图";
  if (kind === "scene_spatial_layout") return "Scene Spatial Layout";
  if (kind === "scene_360") return "Scene 360";
  if (kind === "scene_director_world") return "导演世界";
  if (kind === "scene_director_pano_360") return "Director Pano 360";
  if (kind === "scene_3gs_active_ply") return "3D 世界（当前入口）";
  if (kind === "scene_3gs_master_ply") return "3D 世界（正面）";
  if (kind === "scene_3gs_reverse_ply") return "3D 世界（背面）";
  if (kind === "scene_3gs_pano_ply") return "3D 世界（360）";
  if (kind === "scene_3gs_custom_scene") return "3D 世界（自定义场景）";
  if (kind === "scene_3gs_collision_glb") return "3D 世界碰撞体";
  return "道具参考";
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
        {title}
      </div>
      {children}
    </div>
  );
}
