// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
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
import type { TFn } from "@/lib/i18n-types";

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
// 槽位顺序即下拉里的顺序，所以保留成数组而不是靠词条表的键序。
const KIND_ORDER: PushTargetKind[] = [
  "frame",
  "sketch",
  "director_render",
  "selected_background",
  "identity",
  "identity_costume",
  "identity_portrait",
  "portrait",
  "scene_master",
  "scene_reverse_master",
  "scene_spatial_layout",
  "scene_360",
  "scene_director_world",
  "scene_director_pano_360",
  "scene_3gs_active_ply",
  "scene_3gs_master_ply",
  "scene_3gs_reverse_ply",
  "scene_3gs_pano_ply",
  "scene_3gs_custom_scene",
  "scene_3gs_collision_glb",
  "prop_ref",
  "video",
  "beat_audio",
];

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

function renderCommitSuccessMessage(
  target: PushTarget,
  result: PushResult,
  t: TFn,
): string {
  if (target.kind === "director_render") {
    return t("freezone.commit.success.directorRender", { path: result.target_path });
  }
  if (target.kind === "scene_director_world") {
    return t("freezone.commit.success.directorWorld", { path: result.target_path });
  }
  return t("freezone.commit.success.default", { path: result.target_path }) +
    (result.backup ? t("freezone.commit.success.backupSuffix", { path: result.backup }) : "") +
    (result.stale_marked
      ? t("freezone.commit.success.staleSuffix", { count: result.stale_marked })
      : "");
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
  const { t } = useTranslation();
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
        setError(err instanceof Error ? err.message : t("freezone.commit.errors.loadOptions"));
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
  const targetKindOptions = KIND_ORDER.filter((optionKind) => {
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
        setError(err instanceof Error ? err.message : t("freezone.commit.errors.loadIdentities"));
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
  const targetLabel = target ? renderTargetLabel(target, t) : t("freezone.commit.targetIncomplete");
  const nodeSourceLabel =
    typeof sourceLabelOverride === "string" && sourceLabelOverride.trim()
      ? sourceLabelOverride.trim()
      : "";
  const sourceLabel = nodeSourceLabel || sourceDisplayName(sourceUrl);
  const mediaLabel = renderMediaLabel(mediaType, t);
  const modelSourceLabel = mediaType === "model"
    ? directorWorldSourceDisplayName(nodeData, sourceUrl, nodeSourceLabel, t)
    : "";
  const commitSourceTitle = target?.kind === "scene_director_world"
    ? t("freezone.commit.directorWorldState")
    : mediaType === "model"
      ? modelSourceLabel
      : mediaLabel;
  const commitSourceSubtitle = target?.kind === "scene_director_world"
    ? t("freezone.commit.directorWorldManifestHint")
    : mediaType === "model"
      ? t("freezone.commit.modelCommitHint")
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
      if (!target) throw new Error(t("freezone.commit.errors.incompleteTarget"));
      if (mediaType === "model" && isDirectorWorldSourceSlotTarget(target) && !modelSlotKinds.includes(target.kind)) {
        throw new Error(t("freezone.commit.errors.noWorldSource"));
      }
      if (target.kind === "director_render") {
        const result = await commitDirectorRenderFromCanvasSource(project, target, {
          sourceUrl,
          previewUrl,
          bundle: directorControlBundle,
        });
        onSuccess(renderCommitSuccessMessage(target, result, t), result, target);
        onClose();
        return;
      }
      if (target.kind === "scene_director_world") {
        const latestNodeData = getNodeData?.() ?? nodeData;
        if (!latestNodeData) {
          throw new Error(t("freezone.commit.errors.needCanvasNodeState"));
        }
        const result = await commitSceneDirectorWorldFromCanvasNode(project, target, latestNodeData, t);
        onSuccess(renderCommitSuccessMessage(target, result, t), result, target);
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
      let message = renderCommitSuccessMessage(target, result, t);
      let nodeDataPatch: Record<string, unknown> | null = null;
      const directorWorldManifestData =
        mediaType === "model" && latestNodeData && isDirectorWorldSourceSlotTarget(target)
          ? nodeDataAfterCommittedSlot(latestNodeData, target, result, project, t)
          : null;
      if (latestNodeData && !isDirectorWorldSourceSlotTarget(target)) {
        nodeDataPatch = nodeDataAfterCommittedSlot(latestNodeData, target, result, project, t);
      }
      if (directorWorldManifestData && isDirectorWorldSourceSlotTarget(target)) {
        nodeDataPatch = directorWorldManifestData;
        if (hasDirectorWorldSceneState(directorWorldManifestData)) {
          await commitSceneDirectorWorldFromCanvasNode(
            project,
            { kind: "scene_director_world", scene_id: target.scene_id },
            directorWorldManifestData,
            t,
            { pruneStale: false },
          );
          message += t("freezone.commit.success.directorWorldSynced");
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
            <h2 className="text-[15px] font-semibold leading-tight text-text-dark">
              {t("freezone.commit.title")}
            </h2>
            <p className="mt-0.5 truncate text-xs text-text-muted">
              {t("freezone.commit.projectLine", { project })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-text-muted transition hover:text-text-dark disabled:opacity-30"
            aria-label={t("common.close")}
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
                ? t("freezone.commit.errors.noWorldSource")
                : t("freezone.commit.errors.noSlotSource")}
            </div>
          )}

          {/* 目标类型下拉：图像可选全部可见槽；3D 模型只可选场景 3GS 槽。 */}
          {showTargetKindSelect && (
            <Section title={t("freezone.commit.sections.targetKind")}>
              <UiSelect
                value={kind}
                onChange={(e) => setKind(e.target.value as PushTargetKind)}
                aria-label={t("freezone.commit.sections.targetKind")}
                className={COMMIT_FIELD_BORDER_CLASS}
                menuClassName={COMMIT_SELECT_MENU_CLASS}
              >
                {targetKindOptions.map((optionKind) => (
                  <option key={optionKind} value={optionKind}>
                    {t(`freezone.commit.kinds.${optionKind}`)}
                  </option>
                ))}
              </UiSelect>
            </Section>
          )}

          {!noTargetYet && isBeatStyle && (
            <Section title={t("freezone.commit.sections.targetLocation")}>
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
                        {shortKindLabel(slotKind, t)}
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
                    aria-label={t("freezone.commit.sections.episode")}
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
                        {t("freezone.commit.loadingBeats")}
                      </option>
                    )}
                    {!beatsLoading && beatOptions.length === 0 && (
                      <option value="" disabled>
                        {t("freezone.commit.noBeats")}
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
            <Section title={t("freezone.commit.sections.targetLocation")}>
              <div className="space-y-2">
                <UiSelect
                  value={character ?? ""}
                  onChange={(e) => {
                    setCharacter(e.target.value);
                    setIdentityId(null);
                  }}
                  aria-label={t("freezone.commit.sections.character")}
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
                        {t("freezone.commit.loadingIdentities")}
                      </option>
                    ) : displayedIdentityOptions.length === 0 ? (
                      <option value="" disabled>
                        {t("freezone.commit.noIdentities")}
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
            <Section title={t("freezone.commit.sections.targetLocation")}>
              {scenes.length > 0 ? (
                <UiSelect
                  value={sceneId}
                  onChange={(e) => setSceneId(e.target.value)}
                  disabled={scenesLoading}
                  aria-label={t("freezone.commit.sections.scene")}
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
                  placeholder={t("freezone.commit.sceneIdPlaceholder")}
                  className={COMMIT_FIELD_BORDER_CLASS}
                />
              )}
              <p className="mt-2 text-[11px] text-text-muted">{t("freezone.commit.sceneSlotHint")}</p>
            </Section>
          )}

          {isPropStyle && (
            <Section title={t("freezone.commit.sections.targetLocation")}>
              <UiInput
                value={propId}
                onChange={(e) => setPropId(e.target.value)}
                placeholder={t("freezone.commit.propIdPlaceholder")}
                className={COMMIT_FIELD_BORDER_CLASS}
              />
              <p className="mt-2 text-[11px] text-text-muted">{t("freezone.commit.propSlotHint")}</p>
            </Section>
          )}

          {isGlobalSlot && (
            <Section title={t("freezone.commit.sections.impact")}>
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.08] p-3 text-xs">
                {impactLoading ? (
                  <div className="flex items-center gap-2 text-text-muted">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t("freezone.commit.impactCalculating")}
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {t("freezone.commit.impactCount", { count: impactBeats.length })}
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
                            {t("freezone.commit.impactMore", { count: impactBeats.length - 12 })}
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
                      <span className="leading-relaxed">{t("freezone.commit.markStaleHint")}</span>
                    </label>
                  </>
                )}
              </div>
            </Section>
          )}

          <div className="flex items-start gap-2 px-1 text-[11px] leading-relaxed text-amber-100/70">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-200/55" />
            <span>{t("freezone.commit.overwriteWarning", { target: targetLabel })}</span>
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-300 break-words">
              {error}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-3.5">
          <UiButton variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
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
                {t("freezone.commit.submitting")}
              </>
            ) : (
              t("freezone.commit.submit")
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

function renderMediaLabel(mediaType: DropMediaType, t: TFn): string {
  return t(`freezone.commit.mediaKinds.${mediaType}`, {
    defaultValue: t("freezone.commit.mediaKinds.image"),
  });
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
  t: TFn,
): string {
  const source = activeDirectorWorldSource(nodeData, sourceUrl);
  // label 是节点里存的来源名（用户可改），属于业务内容，原样显示。
  const label = stringFromUnknown(source?.label);
  if (label) return label;
  const sourceKind = stringFromUnknown(source?.source_kind);
  const K = "freezone.commit.worldSources";
  if (sourceKind === "master") return t(`${K}.master`);
  if (sourceKind === "reverse") return t(`${K}.reverse`);
  if (sourceKind === "pano") {
    return source?.source_type === "pano360" ? t(`${K}.pano360`) : t(`${K}.pano`);
  }
  if (sourceKind === "custom") return t(`${K}.custom`);
  if (sourceKind === "uploaded") return t(`${K}.uploaded`);
  const sourceType = stringFromUnknown(source?.source_type);
  if (sourceType === "pano360") return t(`${K}.pano360`);
  return fallback && !looksLikeAssetFilename(fallback) ? fallback : t(`${K}.generic`);
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

function renderTargetLabel(target: PushTarget, t: TFn): string {
  if (
    target.kind === "frame" ||
    target.kind === "sketch" ||
    target.kind === "director_render" ||
    target.kind === "selected_background" ||
    target.kind === "video" ||
    target.kind === "beat_audio"
  ) {
    return `EP${target.episode} / B${target.beat} / ${shortKindLabel(target.kind, t)}`;
  }
  if (target.kind === "identity") return `${target.character} / ${target.identity_id} / Identity`;
  if (target.kind === "identity_costume") {
    return `${target.character} / ${target.identity_id} / Identity Costume`;
  }
  if (target.kind === "identity_portrait") {
    return `${target.character} / ${target.identity_id} / Identity Portrait`;
  }
  if (target.kind === "portrait") return `${target.character} / Portrait`;
  if (SCENE_SLOT_KINDS.has(target.kind)) {
    return `${(target as unknown as Record<string, unknown>).scene_id} / ${shortKindLabel(target.kind, t)}`;
  }
  return `${(target as unknown as Record<string, unknown>).prop_id} / Prop Reference`;
}

function shortKindLabel(kind: PushTargetKind, t: TFn): string {
  return t(`freezone.commit.shortKinds.${kind}`);
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
