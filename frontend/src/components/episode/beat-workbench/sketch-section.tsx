// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Accessibility, Box, Crop, Download, ExternalLink, ImageIcon, Loader2, Package, RefreshCw, Sparkles, Square, Upload } from "lucide-react";

import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import {
  useBeatBackgroundAnchors,
  useBeatDirectorStageManifest,
  useDirectorControlFrameStatus,
  useDirectorControlToSketch,
  StalePoolSelectError,
  usePoolSelect,
  useRegenerateSketches,
  useUpdateBeatBackgroundAnchor,
  useUploadBeatImage,
  type BeatBackgroundAnchorsData,
  type PoolImage,
} from "@/lib/queries/sketches";
import {
  ThreeDDirectorDialog,
  type ThreeDDirectorCaptureMeta,
} from "@/features/viewer-kit/three-d/ThreeDDirectorDialog";
import { openPresetProjectionInMyCanvas } from "@/features/freezone/openPresetProjection";
import { useCharacters } from "@/lib/queries/characters";
import { useEpisodeDetail } from "@/lib/queries/episodes";
import { useSketchSettings } from "@/lib/queries/sketch-settings";
import { useScript } from "@/lib/queries/scripts";
import { parseColorValue, splitIdentityId } from "@/lib/sketch-colors";
import { resolveMediaUrl } from "@/lib/media-url";
import { withImageCacheBust } from "@/features/canvas/application/imageData";
import { ratioToCss } from "@/lib/aspect-ratio";
import { GLASS_DIALOG_CONTENT_CLASS } from "@/lib/dialog-styles";
import { useProjectAspectRatio } from "@/stores/aspect-ratio-store";
import { resolveImage } from "@/lib/resolve-image";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/use-now";
import { useNavigateToAsset } from "@/hooks/use-assets-deep-link";
import { useTaskController } from "@/hooks/use-task-controller";
import { queryKeys } from "@/lib/query-keys";
import { useSeenPoolStore } from "@/stores/seen-pool-store";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SketchPoseEditorDialog } from "./sketch-pose-editor-dialog";
import { SketchCropDialog } from "./sketch-crop-dialog";
import { CreditCostInline } from "@/components/credit-cost-inline";
import {
  MEDIA_PRIMARY_ACTION_BUTTON_CLASS,
  MEDIA_THUMB_ACTIVE_CLASS,
  MEDIA_THUMB_ACTIVE_MARK_CLASS,
  MEDIA_THUMB_CLASS,
  MEDIA_THUMB_IDLE_CLASS,
  MEDIA_THUMB_NEW_CLASS,
  MEDIA_THUMB_TIME_CLASS,
} from "./media-styles";
import type { Beat } from "@/types/episode";

const NEW_WINDOW_MS = 10 * 60 * 1000;
const SKETCH_GRID_CLASS =
  "grid grid-cols-[auto_minmax(260px,1fr)] items-start gap-x-4 gap-y-3";
const SKETCH_PREVIEW_CLASS =
  "flex h-[220px] w-auto max-w-full justify-self-start cursor-zoom-in items-center justify-center overflow-hidden rounded-[10px] border border-white/[0.075] bg-white/[0.022] transition-[border-color,background-color,opacity] hover:border-white/[0.14] hover:bg-white/[0.04] hover:opacity-95";
const SKETCH_PREVIEW_IMAGE_CLASS = "h-full w-full object-cover";
const SKETCH_EMPTY_CLASS =
  "flex h-[220px] w-auto max-w-full justify-self-start items-center justify-center rounded-[10px] border border-dashed border-white/[0.075] bg-white/[0.018] text-xs text-muted-foreground/70";
const SKETCH_CANDIDATES_CLASS =
  "flex max-h-[220px] flex-wrap content-start gap-2 overflow-y-auto pr-1";
const BACKGROUND_ANCHOR_PREVIEW_ASPECT = "16 / 9";

interface SketchSectionProps {
  beat: Beat;
  project: string;
  episode: number;
  images: PoolImage[];
  assignments: Record<string, string>;
  onPreview?: (url: string) => void;
}

type SketchToolAction = "pose" | "crop";

export function SketchSection({
  beat,
  project,
  episode,
  images,
  assignments,
  onPreview,
}: SketchSectionProps) {
  const { t } = useTranslation();
  const { spec } = useProjectAspectRatio(project);
  const navigateToAsset = useNavigateToAsset(project);
  const poolSelect = usePoolSelect(project, episode);
  const regenerate = useRegenerateSketches(project, episode);
  const sketchSettings = useSketchSettings(project);
  const singleSketchModeKey =
    spec.sketchAspect === "16:9" ? "1x1_16-9_sketch" : "1x1_2-3_sketch";
  const sketchRegenCost = useGenerationCreditCost(
    "image_selection",
    sketchSettings.data?.data.sketch_image_selection,
    { surface: "supertale", imageRole: "sketch", modeKey: singleSketchModeKey },
  );
  const uploadSketch = useUploadBeatImage(project, episode, "sketch");
  const [stageDialogOpen, setStageDialogOpen] = useState(false);
  const stageManifest = useBeatDirectorStageManifest(
    project,
    episode,
    beat.beat_number,
    stageDialogOpen,
  );
  const backgroundAnchors = useBeatBackgroundAnchors(project, episode, beat.beat_number);
  const updateBackgroundAnchor = useUpdateBeatBackgroundAnchor(project, episode, beat.beat_number);
  const directorStatus = useDirectorControlFrameStatus(project, episode, beat.beat_number);
  const directorConvert = useDirectorControlToSketch(project, episode, beat.beat_number);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const { data: scriptRes } = useScript(project, episode);
  const { data: charsRes } = useCharacters(project);
  const { data: episodeRes } = useEpisodeDetail(project, episode);
  // BE's `sketch_regen` task row uses `scope=selection_scope(mode_key,
  // beats)` with beat_num=None. Earlier comment here was wrong — we had
  // been passing `beatNum`, but the BE never set it, so the SSE filter
  // missed the row and the stream fell into a "Task not found" reconnect
  // loop. Scope now flows through `start({ scope })` from the mutation
  // response.
  const regenTask = useTaskController({
    key: {
      taskType: "sketch_regen",
      project,
      episode,
    },
    invalidateKeys: [
      queryKeys.grids(project, episode),
      queryKeys.beats(project, episode),
    ],
  });
  const directorTask = useTaskController({
    key: {
      taskType: "sketch_generation",
      project,
      episode,
    },
    invalidateKeys: [
      queryKeys.grids(project, episode),
      queryKeys.beats(project, episode),
    ],
  });
  const [stalePrompt, setStalePrompt] = useState<{
    poolId: string;
    message: string;
    nextAction?: SketchToolAction;
  } | null>(null);
  const [regenConfirm, setRegenConfirm] = useState(false);
  const [poseEditorOpen, setPoseEditorOpen] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
  const [backgroundDialogOpen, setBackgroundDialogOpen] = useState(false);
  const [backgroundDialogData, setBackgroundDialogData] =
    useState<BeatBackgroundAnchorsData | null>(null);
  const [freezonePending, setFreezonePending] = useState(false);
  const now = useNow();
  const markSeen = useSeenPoolStore((s) => s.markSeen);
  const seenSet = useSeenPoolStore((s) => s.seen[`${project}:${episode}`]);

  const resolved = resolveImage(images, assignments, beat.beat_number, "sketch", beat.sketch_url ?? null);
  const resolvedDownloadUrl = resolved.url ? resolveMediaUrl(resolved.url) : null;
  // Live loading state for the preview card: either the director generation or
  // a regen run drives the overlay. Progress from the active task's SSE stream
  // (0–1) is surfaced as a percentage; it survives refresh because both
  // controllers reconcile against the persisted task row.
  const sketchActive = directorTask.started || regenTask.started;
  const sketchStream = directorTask.started ? directorTask.stream : regenTask.stream;
  const sketchPercent = Math.max(
    0,
    Math.min(100, Math.round((sketchStream?.progress ?? 0) * 100)),
  );
  const candidates = images
    .filter((i) => i.type === "sketch" && i.cell_url)
    .sort((a, b) => {
      const ta = a.generated_at ? Date.parse(a.generated_at) : 0;
      const tb = b.generated_at ? Date.parse(b.generated_at) : 0;
      return tb - ta;
    });

  const currentPoolId = assignments[String(beat.beat_number)] ?? null;
  const selectedPoolImage = currentPoolId
    ? images.find((img) => img.id === currentPoolId && img.type === "sketch") ?? null
    : null;
  const hasSketch = Boolean(resolved.url);

  const castedEntries = useMemo(() => {
    const sketchColors = scriptRes?.data?.sketch_colors ?? {};
    const characterNames = new Set((charsRes?.data ?? []).map((c) => c.name));
    return (beat.detected_identities ?? [])
      .map((identityId) => {
        const { hex } = parseColorValue(sketchColors[identityId] ?? "");
        if (!hex) return null;
        const { character, identity } = splitIdentityId(identityId, characterNames);
        return { identityId, hex, character, identity };
      })
      .filter((e): e is { identityId: string; hex: string; character: string; identity: string } => e !== null);
  }, [beat.detected_identities, scriptRes, charsRes]);
  const propEntries = useMemo(() => {
    const propById = new Map(
      (episodeRes?.data?.prop_menu ?? []).map((prop) => [prop.prop_id, prop]),
    );
    return (beat.detected_props ?? []).map((propId) => {
      const prop = propById.get(propId);
      const { hex } = parseColorValue(prop?.marker_color ?? "");
      return { propId, hex };
    });
  }, [beat.detected_props, episodeRes]);
  const markedPropEntries = useMemo(() => {
    const detected = new Set(beat.detected_props ?? []);
    return extractMarkedProps(beat.visual_description ?? "").filter((propId) => !detected.has(propId));
  }, [beat.detected_props, beat.visual_description]);
  const directorControl =
    directorStatus.data?.ok === true ? directorStatus.data.data : null;
  const resolvedDirectorControlUrl =
    directorControl?.ready && directorControl.url
      ? resolveMediaUrl(directorControl.url)
      : null;
  const directorControlUrl = resolvedDirectorControlUrl
    ? withImageCacheBust(resolvedDirectorControlUrl, directorStatus.dataUpdatedAt)
    : null;
  const backgroundData =
    backgroundAnchors.data?.ok === true ? backgroundAnchors.data.data : null;
  const visibleBackgroundData = backgroundDialogData ?? backgroundData;

  const openSketchTool = (action: SketchToolAction) => {
    if (action === "pose") {
      setPoseEditorOpen(true);
      return;
    }
    setCropOpen(true);
  };

  const promotePoolSketch = async (poolId: string, nextAction?: SketchToolAction) => {
    markSeen(project, episode, poolId);
    try {
      await poolSelect.mutateAsync({ beatNum: beat.beat_number, poolId });
      toast.success(t("episode.workbench.sketch.switched"));
      if (nextAction) openSketchTool(nextAction);
    } catch (err) {
      if (err instanceof StalePoolSelectError) {
        setStalePrompt({ poolId, message: err.message, nextAction });
        return;
      }
      toast.error(err instanceof Error ? err.message : t("episode.workbench.sketch.switchFailed"));
    }
  };

  const handleSelect = async (poolId: string) => {
    await promotePoolSketch(poolId);
  };

  const handleOpenSketchTool = async (action: SketchToolAction) => {
    if (beat.sketch_url) {
      openSketchTool(action);
      return;
    }
    const poolId = selectedPoolImage?.id;
    if (!poolId) {
      toast.error(t("episode.beat.noSketch"));
      return;
    }
    await promotePoolSketch(poolId, action);
  };

  const handleStaleForce = async () => {
    if (!stalePrompt) return;
    const poolId = stalePrompt.poolId;
    const nextAction = stalePrompt.nextAction;
    setStalePrompt(null);
    markSeen(project, episode, poolId);
    try {
      await poolSelect.mutateAsync({ beatNum: beat.beat_number, poolId, force: true });
      toast.success(t("episode.workbench.sketch.forcedUse"));
      if (nextAction) openSketchTool(nextAction);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("episode.workbench.sketch.forceFailed"));
    }
  };

  const handleRegen = async () => {
    try {
      const res = await regenerate.mutateAsync({
        beatIndices: [beat.beat_number],
        modeKey: singleSketchModeKey,
      });
      if (res.ok === false) {
        toast.error(res.error || t("episode.workbench.sketch.regenFailed"));
        return;
      }
      regenTask.start({ scope: res.scope });
      toast.success(t("episode.workbench.sketch.regenStarted"));
    } catch {
      toast.error(t("episode.workbench.sketch.regenFailed"));
    }
  };

  const handleDownload = () => {
    if (!resolvedDownloadUrl) return;
    const a = document.createElement("a");
    a.href = resolvedDownloadUrl;
    a.download = `beat_${beat.beat_number}_sketch.png`;
    a.click();
  };

  const handleUpload = async (file: File | null | undefined) => {
    if (!file) return;
    try {
      const res = await uploadSketch.mutateAsync({ beatNum: beat.beat_number, file });
      if (!res.ok) {
        toast.error(res.error || t("common.error"));
        return;
      }
      toast.success(t("episode.workbench.sketch.switched"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleConvertDirectorControl = async () => {
    try {
      const res = await directorConvert.mutateAsync();
      if (!res.ok) {
        toast.error(res.error || t("episode.workbench.sketch.convertDirectorFailed"));
        return;
      }
      directorTask.start({ scope: res.scope });
      toast.success(t("episode.workbench.sketch.convertDirectorStarted"));
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("episode.workbench.sketch.convertDirectorFailed"),
      );
    }
  };

  const handleOpenDirectorWorld = () => {
    setStageDialogOpen(true);
  };

  const handleDirectorWorldCombinedCapture = async (
    _blob: Blob,
    meta: ThreeDDirectorCaptureMeta,
  ) => {
    const bundle = meta.controlFrameBundle;
    if (!bundle) {
      toast.error(t("viewer.threeD.directorControlBundleMissing"));
      return;
    }
    toast.success(t("viewer.threeD.directorControlCommitted", {
      path: meta.controlFrameRelPath ?? bundle.rel_paths.combined,
    }));
    await directorStatus.refetch();
    setStageDialogOpen(false);
  };

  const handleOpenBackgroundDialog = async () => {
    try {
      const refreshed = await backgroundAnchors.refetch();
      if (refreshed.error instanceof Error) {
        toast.error(refreshed.error.message || t("episode.workbench.sketch.chooseBackgroundFailed"));
        return;
      }
      const nextData =
        refreshed.data?.ok === true ? refreshed.data.data : backgroundData;
      if (!nextData?.can_choose) {
        toast.error(nextData?.error || t("episode.workbench.sketch.chooseBackgroundFailed"));
        return;
      }
      setBackgroundDialogData(nextData);
      setBackgroundDialogOpen(true);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("episode.workbench.sketch.chooseBackgroundFailed"),
      );
    }
  };

  const handleChooseBackground = async (anchorId: string) => {
    try {
      const res = await updateBackgroundAnchor.mutateAsync({ anchorId });
      if (!res.ok) {
        toast.error(res.error || t("episode.workbench.sketch.chooseBackgroundFailed"));
        return;
      }
      toast.success(t("episode.workbench.sketch.chooseBackgroundSaved"));
      if (res.data) setBackgroundDialogData(res.data);
      setBackgroundDialogOpen(false);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("episode.workbench.sketch.chooseBackgroundFailed"),
      );
    }
  };

  const handleOpenSketchFreezone = async () => {
    setFreezonePending(true);
    try {
      await openPresetProjectionInMyCanvas(project, {
        scope: "beat",
        episode,
        beat: beat.beat_number,
        primary_slot: "sketch",
      });
      toast.success(t("episode.workbench.sketch.freezoneOpened"));
    } catch {
      toast.error(t("episode.workbench.sketch.freezoneOpenFailed"));
    } finally {
      setFreezonePending(false);
    }
  };

  return (
    <div className={SKETCH_GRID_CLASS}>
      {(castedEntries.length > 0 || propEntries.length > 0 || markedPropEntries.length > 0) && (
        <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
          {castedEntries.map((e) => (
            <button
              key={e.identityId}
              type="button"
              onClick={() => navigateToAsset("identity", e.identityId)}
              className="inline-flex h-5 max-w-[180px] items-center gap-1 rounded-full border border-white/[0.075] bg-white/[0.018] px-1.5 leading-none text-[11px] transition-colors hover:border-primary/45 hover:bg-primary/[0.07]"
              title={`${e.character}${e.identity ? ` · ${e.identity}` : ""}`}
            >
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: e.hex }}
              />
              <span className="truncate text-foreground/78">
                {e.character}
                {e.identity && (
                  <>
                    {" · "}
                    <span className="text-muted-foreground/72">{e.identity}</span>
                  </>
                )}
              </span>
            </button>
          ))}
          {propEntries.map((prop) => (
            <button
              key={prop.propId}
              type="button"
              onClick={() => navigateToAsset("prop", prop.propId)}
              className="inline-flex h-5 max-w-[180px] items-center gap-1 rounded-full border border-white/[0.075] bg-white/[0.018] px-1.5 leading-none text-[11px] transition-colors hover:border-primary/45 hover:bg-primary/[0.07]"
              title={prop.propId}
            >
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: prop.hex ?? undefined }}
              />
              <span className="truncate text-muted-foreground/72">
                {prop.propId}
              </span>
            </button>
          ))}
          {markedPropEntries.map((propId) => (
            <button
              key={propId}
              type="button"
              onClick={() => navigateToAsset("prop", propId)}
              className="inline-flex h-5 max-w-[180px] items-center gap-1 rounded-full border border-white/[0.075] bg-white/[0.018] px-1.5 leading-none text-[11px] transition-colors hover:border-primary/45 hover:bg-primary/[0.07]"
              title={propId}
            >
              <Package aria-hidden className="size-2.5 shrink-0 text-muted-foreground/70" />
              <span className="truncate text-muted-foreground/72">{propId}</span>
            </button>
          ))}
        </div>
      )}

      {/* Left: preview image (with a live progress overlay while generating) */}
      <div className="relative justify-self-start">
        {resolved.url ? (
          <button
            type="button"
            onClick={() => {
              const safe = resolveMediaUrl(resolved.url);
              if (safe) onPreview?.(safe);
            }}
            className={SKETCH_PREVIEW_CLASS}
            style={{ aspectRatio: ratioToCss(spec.sketchAspect) }}
          >
            <img
              src={resolveMediaUrl(resolved.url) ?? ""}
              alt={`Beat ${beat.beat_number} sketch`}
              className={SKETCH_PREVIEW_IMAGE_CLASS}
              loading="lazy"
              decoding="async"
            />
          </button>
        ) : (
          <div className={SKETCH_EMPTY_CLASS} style={{ aspectRatio: ratioToCss(spec.sketchAspect) }}>
            {t("episode.beat.noSketch")}
          </div>
        )}
        {sketchActive && (
          <div
            className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-[10px] bg-black/55 backdrop-blur-[1px]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={sketchPercent}
          >
            <Loader2 aria-hidden className="size-5 animate-spin text-white/90" />
            <div className="flex items-baseline leading-none text-white">
              <span className="text-2xl font-semibold tabular-nums tracking-tight">
                {sketchPercent}
              </span>
              <span className="ml-0.5 text-xs font-medium text-white/70">%</span>
            </div>
            <div className="h-1 w-24 overflow-hidden rounded-full bg-white/20">
              <div
                className="h-full rounded-full bg-white/85 transition-[width] duration-300 ease-out"
                style={{ width: `${sketchPercent}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Right: casted characters + candidates + actions */}
      <div className="flex min-h-0 flex-col gap-2.5">
        {directorControlUrl && (
          <div className="flex items-center gap-2 rounded-[8px] border border-white/[0.075] bg-white/[0.02] p-2">
            <button
              type="button"
              onClick={() => onPreview?.(directorControlUrl)}
              className="h-14 w-14 shrink-0 overflow-hidden rounded-[6px] border border-white/[0.08] bg-black/30"
            >
              <img
                src={directorControlUrl}
                alt={`Beat ${beat.beat_number} Director World control frame`}
                className="h-full w-full object-cover"
                loading="lazy"
                decoding="async"
              />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-fuchsia-100">
                {t("episode.workbench.sketch.directorControl")}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {t("episode.workbench.sketch.directorControlFile")}
              </div>
            </div>
            {directorTask.started ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void directorTask.stop()}
                disabled={directorTask.stopping}
                className="gap-1"
              >
                {directorTask.stopping ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Square className="size-3" />
                )}
                {t("common.stop")}
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                onClick={handleConvertDirectorControl}
                disabled={directorConvert.isPending}
                className="gap-1"
              >
                {directorConvert.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Sparkles className="size-3" />
                )}
                {t("episode.workbench.sketch.convertDirectorControl")}
              </Button>
            )}
          </div>
        )}
        {candidates.length > 0 && (
          <div className={SKETCH_CANDIDATES_CLASS}>
            {candidates.map((img) => {
              const src = img.cell_url ? resolveMediaUrl(img.cell_url) : null;
              const isActive = currentPoolId === img.id;
              const timeLabel = formatRelativeTime(img.generated_at, now);
              const generatedAtMs = img.generated_at ? Date.parse(img.generated_at) : NaN;
              const withinNewWindow =
                !Number.isNaN(generatedAtMs) && now - generatedAtMs < NEW_WINDOW_MS;
              const isSeen = !!seenSet && seenSet.includes(img.id);
              const isNew = withinNewWindow && !isSeen && !isActive;
              return (
                <button
                  key={img.id}
                  type="button"
                  onClick={() => handleSelect(img.id)}
                  disabled={poolSelect.isPending}
                  className={cn(
                    MEDIA_THUMB_CLASS,
                    isActive ? MEDIA_THUMB_ACTIVE_CLASS : MEDIA_THUMB_IDLE_CLASS,
                  )}
                >
                  <div className="h-[76px]" style={{ aspectRatio: ratioToCss(spec.sketchAspect) }}>
                    {src !== null && <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />}
                  </div>
                  {isNew && (
                    <span className={MEDIA_THUMB_NEW_CLASS}>
                      {t("common.new")}
                    </span>
                  )}
                  {timeLabel && (
                    <span className={MEDIA_THUMB_TIME_CLASS}>
                      {timeLabel}
                    </span>
                  )}
                  {isActive && (
                    <span className={MEDIA_THUMB_ACTIVE_MARK_CLASS}>
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Actions — full width row below both columns */}
      <div className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
        <div className="flex items-center gap-1.5">
          {regenTask.started ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void regenTask.stop()}
              disabled={regenTask.stopping}
              className={MEDIA_PRIMARY_ACTION_BUTTON_CLASS}
            >
              {regenTask.stopping ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Square className="size-3" />
              )}
              {t("common.stop")}
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => setRegenConfirm(true)}
              disabled={regenerate.isPending}
              className={MEDIA_PRIMARY_ACTION_BUTTON_CLASS}
            >
              {regenerate.isPending ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              {hasSketch
                ? t("common.regenerate")
                : t("common.generateNew")}
              <CreditCostInline display={sketchRegenCost.data?.data.display} />
            </Button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void handleOpenSketchTool("pose")}
            disabled={poolSelect.isPending || (!beat.sketch_url && !selectedPoolImage)}
            className="gap-1"
            title={t("episode.workbench.sketch.poseEdit")}
          >
            <Accessibility className="size-3" />
            {t("episode.workbench.sketch.poseEdit")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void handleOpenSketchTool("crop")}
            disabled={poolSelect.isPending || (!beat.sketch_url && !selectedPoolImage)}
            className="gap-1"
            title={t("episode.workbench.sketch.cropEdit")}
          >
            <Crop className="size-3" />
            {t("episode.workbench.sketch.cropEdit")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={handleOpenBackgroundDialog}
            disabled={backgroundAnchors.isLoading}
            className="gap-1"
            title={t("episode.workbench.sketch.chooseBackgroundTip")}
          >
            <ImageIcon className="size-3" />
            {t("episode.workbench.sketch.chooseBackground")}
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="xs" variant="ghost" onClick={handleDownload} disabled={!resolvedDownloadUrl} className="gap-1">
            <Download className="size-3" />
            {t("common.download")}
          </Button>
          <input
            ref={uploadInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              void handleUpload(file);
            }}
          />
          <Button
            size="xs"
            variant="ghost"
            onClick={() => uploadInputRef.current?.click()}
            disabled={uploadSketch.isPending}
            className="gap-1"
          >
            {uploadSketch.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Upload className="size-3" />
            )}
            {t("common.upload")}
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            onClick={handleOpenDirectorWorld}
            disabled={stageDialogOpen && stageManifest.isLoading}
            className="gap-1"
            title={t("episode.workbench.sketch.openDirectorWorldTip")}
          >
            <Box className="size-3" />
            {t("episode.workbench.sketch.openDirectorWorld")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={handleOpenSketchFreezone}
            disabled={freezonePending}
            className="gap-1"
            title={t("episode.workbench.sketch.openFreezoneTip")}
          >
            {freezonePending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ExternalLink className="size-3" />
            )}
            {t("episode.workbench.sketch.openFreezone")}
          </Button>
        </div>
      </div>

      <Dialog
        open={backgroundDialogOpen}
        onOpenChange={(open) => {
          setBackgroundDialogOpen(open);
          if (!open) setBackgroundDialogData(null);
        }}
      >
        <DialogContent
          className={cn(
            GLASS_DIALOG_CONTENT_CLASS,
            "max-h-[min(calc(100vh-2rem),820px)] max-w-[min(calc(100vw-2rem),960px)] overflow-y-auto p-7",
          )}
        >
          <DialogHeader>
            <DialogTitle>{t("episode.workbench.sketch.backgroundDialogTitle", { n: beat.beat_number })}</DialogTitle>
            <DialogDescription>
              {t("episode.workbench.sketch.backgroundDialogDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            {(visibleBackgroundData?.anchors ?? []).map((anchor) => {
              const src = anchor.url ? resolveMediaUrl(anchor.url) : null;
              return (
                <div
                  key={anchor.id}
                  className={cn(
                    "rounded-lg border p-3",
                    anchor.current
                      ? "border-amber-400/70 bg-amber-500/10"
                      : "border-white/[0.12] bg-white/[0.045]",
                  )}
                >
                  <div
                    className="overflow-hidden rounded-md border border-white/[0.12] bg-black/25"
                    style={{ aspectRatio: BACKGROUND_ANCHOR_PREVIEW_ASPECT }}
                  >
                    {src ? (
                      <img
                        src={src}
                        alt={anchor.label}
                        className="h-full w-full object-cover"
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                        {t("episode.workbench.sketch.backgroundMissing")}
                      </div>
                    )}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{anchor.label}</div>
                      {anchor.current && (
                        <div className="text-[11px] text-amber-300">
                          {t("episode.workbench.sketch.backgroundCurrent")}
                        </div>
                      )}
                    </div>
                    <Button
                      size="xs"
                      variant={anchor.current ? "default" : "outline"}
                      disabled={!anchor.exists || updateBackgroundAnchor.isPending}
                      onClick={() => handleChooseBackground(anchor.id)}
                    >
                      {anchor.snapshot_to_selected_background
                        ? t("episode.workbench.sketch.backgroundSnapshotUse")
                        : t("common.use")}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={stalePrompt !== null} onOpenChange={(v) => !v && setStalePrompt(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("episode.workbench.sketch.versionMismatch")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("episode.workbench.sketch.versionMismatchDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleStaleForce}>{t("common.forceUse")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={regenConfirm} onOpenChange={setRegenConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {hasSketch
                ? t("episode.workbench.sketch.regenTitle")
                : t("episode.workbench.sketch.generateTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {hasSketch
                ? t("episode.workbench.sketch.regenDesc", { n: beat.beat_number })
                : t("episode.workbench.sketch.generateDesc", { n: beat.beat_number })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setRegenConfirm(false); handleRegen(); }}>{t("common.confirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <SketchPoseEditorDialog
        open={poseEditorOpen}
        onOpenChange={setPoseEditorOpen}
        project={project}
        episode={episode}
        beatNum={beat.beat_number}
      />
      <SketchCropDialog
        open={cropOpen}
        onOpenChange={setCropOpen}
        project={project}
        episode={episode}
        beatNum={beat.beat_number}
      />
      <ThreeDDirectorDialog
        open={stageDialogOpen}
        onOpenChange={setStageDialogOpen}
        manifest={stageManifest.data?.ok ? stageManifest.data.data : null}
        title={`${t("viewer.threeD.beatDirectorWorld")} ${beat.beat_number}`}
        description={t("viewer.threeD.beatDirectorWorldDescription")}
        viewerPurpose="beat"
        autoCommitDirectorCombined
        onSubmitDirectorCombined={handleDirectorWorldCombinedCapture}
      />
    </div>
  );
}

function extractMarkedProps(visualDescription: string): string[] {
  const props: string[] = [];
  const seen = new Set<string>();
  for (const match of visualDescription.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const propId = (match[1] ?? "").trim();
    if (!propId || seen.has(propId)) continue;
    seen.add(propId);
    props.push(propId);
  }
  return props;
}
