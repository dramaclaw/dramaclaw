// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Download,
  Crop,
  ExternalLink,
  Image as ImageIcon,
  Lock,
  Loader2,
  RefreshCw,
  Square,
  SunMedium,
  Upload,
  X,
} from "lucide-react";

import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import {
  StalePoolSelectError,
  useBeatBackgroundAnchors,
  useBeatDirectorStageManifest,
  useCropBeatBackgroundAnchor,
  usePoolSelect,
  useRegenerateRenderBeats,
  useUpdateBeatBackgroundAnchor,
  useUploadBeatImage,
  useUploadBeatBackgroundAnchor,
  type BeatBackgroundAnchorItem,
  type BeatBackgroundReference,
  type PoolImage,
} from "@/lib/queries/sketches";
import {
  ThreeDDirectorDialog,
  type ThreeDDirectorCaptureMeta,
} from "@/features/viewer-kit/three-d/ThreeDDirectorDialog";
import { openPresetProjectionInMyCanvas } from "@/features/freezone/openPresetProjection";
import { useRenderSettings } from "@/lib/queries/render-settings";
import { useScenePlatePreview } from "@/lib/queries/scenes";
import { resolveMediaUrl } from "@/lib/media-url";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/use-now";
import { useTaskController } from "@/hooks/use-task-controller";
import { queryKeys } from "@/lib/query-keys";
import { useSeenPoolStore } from "@/stores/seen-pool-store";
import { useProjectAspectRatio } from "@/stores/aspect-ratio-store";
import { centerCropBoxForRatio, ratioToCss, zoomCropBox } from "@/lib/aspect-ratio";
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
import type { Beat } from "@/types/episode";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { CreditCostInline } from "@/components/credit-cost-inline";
import {
  CROP_DIALOG_SAVE_BUTTON_CLASS,
  MEDIA_PRIMARY_ACTION_BUTTON_CLASS,
  MEDIA_THUMB_ACTIVE_CLASS,
  MEDIA_THUMB_ACTIVE_MARK_CLASS,
  MEDIA_THUMB_CLASS,
  MEDIA_THUMB_IDLE_CLASS,
  MEDIA_THUMB_NEW_CLASS,
  MEDIA_THUMB_TIME_CLASS,
} from "./media-styles";

const NEW_WINDOW_MS = 10 * 60 * 1000;
const CROP_SOURCE_ANCHORS = new Set(["master", "reverse", "director_env_only"]);
const RENDER_GRID_CLASS =
  "grid grid-cols-[auto_minmax(260px,1fr)] items-start gap-x-4 gap-y-3";
const RENDER_PREVIEW_CLASS =
  "flex h-[220px] w-auto max-w-full justify-self-start cursor-zoom-in items-center justify-center overflow-hidden rounded-[10px] border border-white/[0.075] bg-white/[0.022] transition-[border-color,background-color,opacity] hover:border-white/[0.14] hover:bg-white/[0.04] hover:opacity-95";
const RENDER_PREVIEW_IMAGE_CLASS = "h-full w-full object-cover";
const RENDER_EMPTY_CLASS =
  "flex h-[220px] w-auto max-w-full justify-self-start items-center justify-center rounded-[10px] border border-dashed border-white/[0.075] bg-white/[0.018] text-xs text-muted-foreground/70";
const RENDER_CANDIDATES_CLASS =
  "flex max-h-[220px] flex-wrap content-start gap-2 overflow-y-auto pr-1";
const RELIGHT_BADGE_CLASS =
  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium leading-none";
const RENDER_BACKGROUND_ANCHOR_LABEL_KEYS: Record<string, string> = {
  director_env_only: "episode.workbench.render.backgroundAnchorLabels.directorEnvOnly",
  master: "episode.workbench.render.backgroundAnchorLabels.master",
  reverse: "episode.workbench.render.backgroundAnchorLabels.reverse",
};

function clampCropBox(
  crop: { x: number; y: number; width: number; height: number },
  imageSize: { width: number; height: number },
) {
  return {
    ...crop,
    x: Math.min(Math.max(0, Math.round(crop.x)), Math.max(0, imageSize.width - crop.width)),
    y: Math.min(Math.max(0, Math.round(crop.y)), Math.max(0, imageSize.height - crop.height)),
  };
}

interface RenderSectionProps {
  beat: Beat;
  project: string;
  episode: number;
  images: PoolImage[];
  assignments: Record<string, string>;
  onPreview?: (url: string) => void;
}

export function RenderSection({
  beat,
  project,
  episode,
  images,
  assignments,
  onPreview,
}: RenderSectionProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { spec: aspectSpec } = useProjectAspectRatio(project);
  const poolSelect = usePoolSelect(project, episode);
  const regenerate = useRegenerateRenderBeats(project, episode);
  const renderSettings = useRenderSettings(project);
  const renderSceneId =
    beat.scene_ref?.scene_id?.trim() || beat.location?.trim() || "";
  const renderVariantId = beat.scene_ref?.variant_id?.trim() || "";
  const scenePlatePreview = useScenePlatePreview(
    project,
    renderSceneId,
    renderVariantId,
    beat.time_of_day ?? "",
  );
  const renderPlatePreview =
    scenePlatePreview.data?.ok === true ? scenePlatePreview.data.data.render : null;
  const renderRegenCost = useGenerationCreditCost(
    "image_selection",
    renderSettings.data?.data.render_image_selection,
    { surface: "supertale", imageRole: "render", modeKey: "1x1_2-3" },
  );
  const uploadRender = useUploadBeatImage(project, episode, "render");
  const backgroundAnchors = useBeatBackgroundAnchors(project, episode, beat.beat_number);
  const [directorWorldOpen, setDirectorWorldOpen] = useState(false);
  const stageManifest = useBeatDirectorStageManifest(
    project,
    episode,
    beat.beat_number,
    directorWorldOpen,
  );
  const updateBackgroundAnchor = useUpdateBeatBackgroundAnchor(project, episode, beat.beat_number);
  const cropBackgroundAnchor = useCropBeatBackgroundAnchor(project, episode, beat.beat_number);
  const uploadBackgroundAnchor = useUploadBeatBackgroundAnchor(project, episode, beat.beat_number);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const backgroundUploadInputRef = useRef<HTMLInputElement | null>(null);
  // BE's `selected_regen` task row uses `scope=selection_scope(mode_key,
  // beats)` with beat_num=None. Passing `beatNum` here made the SSE filter
  // miss the row entirely. Scope is supplied at start() via the mutation
  // response.
  const regenTask = useTaskController({
    key: {
      taskType: "selected_regen",
      project,
      episode,
    },
    invalidateKeys: [
      queryKeys.grids(project, episode),
      queryKeys.beats(project, episode),
    ],
  });
  const [stalePrompt, setStalePrompt] = useState<{ poolId: string; message: string } | null>(null);
  const [regenConfirm, setRegenConfirm] = useState(false);
  const [freezonePending, setFreezonePending] = useState(false);
  const [croppingAnchorId, setCroppingAnchorId] = useState<string | null>(null);
  const now = useNow();
  const markSeen = useSeenPoolStore((s) => s.markSeen);
  const seenSet = useSeenPoolStore((s) => s.seen[`${project}:${episode}`]);

  const candidates = images
    .filter((i) => i.type === "render" && i.original_beat === beat.beat_number && i.cell_url)
    .sort((a, b) => {
      const ta = a.generated_at ? Date.parse(a.generated_at) : 0;
      const tb = b.generated_at ? Date.parse(b.generated_at) : 0;
      return tb - ta;
    });

  const currentAssignment = assignments[String(beat.beat_number)] ?? null;
  const assignedRender = currentAssignment
    ? images.find((i) => isRenderAssignmentMatch(i, currentAssignment)) ?? null
    : null;
  const detailRender = assignedRender ?? candidates[0] ?? null;
  const previewUrl = beat.frame_url ?? detailRender?.cell_url ?? null;
  // Live loading state for the preview card while a render regen runs. Progress
  // comes from the active task's SSE stream (0–1) and survives refresh because
  // the controller reconciles against the persisted task row.
  const renderActive = regenTask.started;
  const renderPercent = Math.max(
    0,
    Math.min(100, Math.round((regenTask.stream?.progress ?? 0) * 100)),
  );
  const backgroundData =
    backgroundAnchors.data?.ok === true ? backgroundAnchors.data.data : null;
  const currentBackgroundSource =
    backgroundData?.current_source ?? backgroundData?.current_anchor ?? null;
  const currentBackground =
    backgroundData?.anchors.find((anchor) => anchor.id === currentBackgroundSource) ??
    backgroundData?.anchors.find((anchor) => anchor.current) ??
    backgroundData?.anchors.find((anchor) => anchor.exists) ??
    null;
  const currentBackgroundReference =
    backgroundData?.display_reference ?? backgroundData?.current_reference ?? null;

  const handleSelect = async (poolId: string) => {
    markSeen(project, episode, poolId);
    try {
      await poolSelect.mutateAsync({ beatNum: beat.beat_number, poolId });
      toast.success(t("episode.workbench.render.switched"));
    } catch (err) {
      if (err instanceof StalePoolSelectError) {
        setStalePrompt({ poolId, message: err.message });
        return;
      }
      toast.error(err instanceof Error ? err.message : t("episode.workbench.render.switchFailed"));
    }
  };

  const handleStaleForce = async () => {
    if (!stalePrompt) return;
    const poolId = stalePrompt.poolId;
    setStalePrompt(null);
    markSeen(project, episode, poolId);
    try {
      await poolSelect.mutateAsync({ beatNum: beat.beat_number, poolId, force: true });
      toast.success(t("episode.workbench.render.forcedUse"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("episode.workbench.render.forceFailed"));
    }
  };

  const handleRegen = async () => {
    try {
      const anchorId = currentBackgroundSource || "master";
      const backgroundRes = await updateBackgroundAnchor.mutateAsync({ anchorId });
      if (!backgroundRes.ok) {
        toast.error(backgroundRes.error || t("episode.workbench.render.backgroundSaveFailed"));
        return;
      }
      const res = await regenerate.mutateAsync({ beatIndices: [beat.beat_number], modeKey: "1x1_2-3" });
      if (res.ok === false) {
        toast.error(res.error || t("episode.workbench.render.regenFailed"));
        return;
      }
      regenTask.start({ scope: res.scope });
      toast.success(t("episode.workbench.render.regenStarted"));
    } catch {
      toast.error(t("episode.workbench.render.regenFailed"));
    }
  };

  const handleDownload = () => {
    const img = detailRender;
    if (!img?.cell_url) return;
    const url = resolveMediaUrl(img.cell_url);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `beat_${beat.beat_number}_render.png`;
    a.click();
  };

  const handleUpload = async (file: File | null | undefined) => {
    if (!file) return;
    try {
      const res = await uploadRender.mutateAsync({ beatNum: beat.beat_number, file });
      if (!res.ok) {
        toast.error(res.error || t("common.error"));
        return;
      }
      toast.success(t("episode.workbench.render.switched"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleChooseBackground = async (anchorId: string) => {
    try {
      const res = await updateBackgroundAnchor.mutateAsync({ anchorId });
      if (!res.ok) {
        toast.error(res.error || t("episode.workbench.render.backgroundSaveFailed"));
        return;
      }
      toast.success(t("episode.workbench.render.backgroundSaved"));
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("episode.workbench.render.backgroundSaveFailed"),
      );
    }
  };

  const handleCropBackground = async (
    anchorId: string,
    crop: { x: number; y: number; width: number; height: number },
  ) => {
    setCroppingAnchorId(anchorId);
    try {
      const res = await cropBackgroundAnchor.mutateAsync({
        anchorId,
        crop,
      });
      if (!res.ok) {
        toast.error(res.error || t("episode.workbench.render.backgroundSaveFailed"));
        return;
      }
      toast.success(t("episode.workbench.render.backgroundSaved"));
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("episode.workbench.render.backgroundSaveFailed"),
      );
    } finally {
      setCroppingAnchorId(null);
    }
  };

  const handleUploadBackground = async (file: File | null | undefined) => {
    if (!file) return;
    try {
      const res = await uploadBackgroundAnchor.mutateAsync({ file });
      if (!res.ok) {
        toast.error(res.error || t("episode.workbench.render.backgroundUploadFailed"));
        return;
      }
      toast.success(t("episode.workbench.render.backgroundUploaded"));
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("episode.workbench.render.backgroundUploadFailed"),
      );
    }
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
    await queryClient.invalidateQueries({
      queryKey: queryKeys.directorControlFrame(project, episode, beat.beat_number),
    });
    setDirectorWorldOpen(false);
  };

  const handleOpenRenderFreezone = async () => {
    setFreezonePending(true);
    try {
      await openPresetProjectionInMyCanvas(project, {
        scope: "beat",
        episode,
        beat: beat.beat_number,
        primary_slot: "frame",
      });
      toast.success(t("episode.workbench.render.freezoneOpened"));
    } catch {
      toast.error(t("episode.workbench.render.freezoneOpenFailed"));
    } finally {
      setFreezonePending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-[10px] border border-white/[0.055] bg-white/[0.016] p-3">
        <div className={RENDER_GRID_CLASS}>
          {/* Left: preview image (with a live progress overlay while generating) */}
          <div className="relative justify-self-start">
            {previewUrl ? (
              <button
                type="button"
                onClick={() => {
                  const safe = resolveMediaUrl(previewUrl);
                  if (safe) onPreview?.(safe);
                }}
                className={RENDER_PREVIEW_CLASS}
                style={{ aspectRatio: ratioToCss(aspectSpec.renderAspect) }}
              >
                <img
                  src={resolveMediaUrl(previewUrl) ?? ""}
                  alt={`Beat ${beat.beat_number} render`}
                  className={RENDER_PREVIEW_IMAGE_CLASS}
                  loading="lazy"
                  decoding="async"
                />
              </button>
            ) : (
              <div className={RENDER_EMPTY_CLASS} style={{ aspectRatio: ratioToCss(aspectSpec.renderAspect) }}>
                {t("episode.beat.noRender")}
              </div>
            )}
            {renderActive && (
              <div
                className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-[10px] bg-black/55 backdrop-blur-[1px]"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={renderPercent}
              >
                <Loader2 aria-hidden className="size-5 animate-spin text-white/90" />
                <div className="flex items-baseline leading-none text-white">
                  <span className="text-2xl font-semibold tabular-nums tracking-tight">
                    {renderPercent}
                  </span>
                  <span className="ml-0.5 text-xs font-medium text-white/70">%</span>
                </div>
                <div className="h-1 w-24 overflow-hidden rounded-full bg-white/20">
                  <div
                    className="h-full rounded-full bg-white/85 transition-[width] duration-300 ease-out"
                    style={{ width: `${renderPercent}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Right: candidates + actions */}
          <div className="flex min-h-0 flex-col gap-2.5">
            {candidates.length > 0 && (
              <div className={RENDER_CANDIDATES_CLASS}>
                {candidates.map((img) => {
                  const src = img.cell_url ? resolveMediaUrl(img.cell_url) : null;
                  const isActive =
                    currentAssignment !== null &&
                    isRenderAssignmentMatch(img, currentAssignment);
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
                      <div className="h-[76px]" style={{ aspectRatio: ratioToCss(aspectSpec.renderAspect) }}>
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
                  {previewUrl
                    ? t("common.regenerate")
                    : t("episode.workbench.render.generateNew")}
                  <CreditCostInline display={renderRegenCost.data?.data.display} />
                </Button>
              )}
              {renderPlatePreview ? (
                <RenderRelightBadge
                  relight={renderPlatePreview.relight}
                  timeOfDay={beat.time_of_day ?? ""}
                />
              ) : null}
            </div>
            <div className="flex items-center gap-1.5">
              <Button size="xs" variant="ghost" onClick={handleDownload} disabled={!detailRender} className="gap-1">
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
                disabled={uploadRender.isPending}
                className="gap-1"
              >
                {uploadRender.isPending ? (
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
                onClick={handleOpenRenderFreezone}
                disabled={freezonePending}
                className="gap-1"
                title={t("episode.workbench.render.openFreezoneTip")}
              >
                {freezonePending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <ExternalLink className="size-3" />
                )}
                {t("episode.workbench.render.openFreezone")}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <RenderBackgroundReferencePanel
        anchor={currentBackground}
        sourceId={currentBackgroundSource}
        reference={currentBackgroundReference}
        renderInput={backgroundData?.render_input ?? null}
        cropAspectLabel={aspectSpec.renderAspect}
        cropAspectRatio={aspectSpec.ratioValue}
        anchors={backgroundData?.anchors ?? []}
        canChoose={backgroundData?.can_choose ?? false}
        loading={backgroundAnchors.isLoading}
        choosing={updateBackgroundAnchor.isPending}
        uploading={uploadBackgroundAnchor.isPending}
        croppingAnchorId={croppingAnchorId}
        onChoose={handleChooseBackground}
        onCrop={handleCropBackground}
        uploadInputRef={backgroundUploadInputRef}
        onUpload={handleUploadBackground}
        onOpenDirectorWorld={() => setDirectorWorldOpen(true)}
      />

      <ThreeDDirectorDialog
        open={directorWorldOpen}
        onOpenChange={setDirectorWorldOpen}
        manifest={stageManifest.data?.ok ? stageManifest.data.data : null}
        title={t("episode.workbench.render.backgroundOpen360")}
        description={t("episode.workbench.render.backgroundDirectorWorldDescription")}
        viewerPurpose="beat"
        autoCommitDirectorCombined
        onSubmitDirectorCombined={handleDirectorWorldCombinedCapture}
      />

      <AlertDialog open={stalePrompt !== null} onOpenChange={(v) => !v && setStalePrompt(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("episode.workbench.render.versionMismatch")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("episode.workbench.render.versionMismatchDesc")}
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
            <AlertDialogTitle>{t("episode.workbench.render.regenTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("episode.workbench.render.regenDesc", { n: beat.beat_number })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setRegenConfirm(false);
                void handleRegen();
              }}
            >
              {t("common.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}

function RenderRelightBadge({
  relight,
  timeOfDay,
}: {
  relight: boolean;
  timeOfDay: string;
}) {
  if (relight) {
    const label = `Relight 到 ${timeOfDay.trim() || "指定时间"}`;
    return (
      <span
        title="Relight：按 beat 时间重新打光，不改变场景结构。"
        className={cn(
          RELIGHT_BADGE_CLASS,
          "border-amber-300/35 bg-amber-300/[0.08] text-amber-200/90",
        )}
      >
        <SunMedium className="size-3.5" />
        {label}
      </span>
    );
  }
  return (
    <span
      title="锁图光：使用场景图自带光线，不重新打光。"
      className={cn(
        RELIGHT_BADGE_CLASS,
        "border-emerald-300/30 bg-emerald-300/[0.07] text-emerald-200/88",
      )}
    >
      <Lock className="size-3.5" />
      锁图光
    </span>
  );
}

interface RenderBackgroundReferencePanelProps {
  anchor: BeatBackgroundAnchorItem | null;
  sourceId: string | null;
  reference: BeatBackgroundReference | null;
  renderInput: BeatBackgroundReference | null;
  cropAspectLabel: string;
  cropAspectRatio: number;
  anchors: BeatBackgroundAnchorItem[];
  canChoose: boolean;
  loading: boolean;
  choosing: boolean;
  uploading: boolean;
  croppingAnchorId: string | null;
  onOpenDirectorWorld?: () => void;
  uploadInputRef: RefObject<HTMLInputElement | null>;
  onChoose: (anchorId: string) => void;
  onCrop: (
    anchorId: string,
    crop: { x: number; y: number; width: number; height: number },
  ) => void;
  onUpload: (file: File | null | undefined) => void;
}

interface RenderBackgroundCropTarget {
  id: string;
  label: string;
  url: string | null;
  path?: string | null;
}

function RenderBackgroundReferencePanel({
  anchor,
  sourceId,
  reference,
  cropAspectLabel,
  cropAspectRatio,
  anchors,
  canChoose,
  loading,
  choosing,
  uploading,
  croppingAnchorId,
  onOpenDirectorWorld,
  uploadInputRef,
  onChoose,
  onCrop,
  onUpload,
}: RenderBackgroundReferencePanelProps) {
  const { t } = useTranslation();
  const cropImageRef = useRef<HTMLImageElement | null>(null);
  const cropBoxRef = useRef<HTMLDivElement | null>(null);
  const cropDragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    crop: { x: number; y: number; width: number; height: number };
  } | null>(null);
  const [cropTarget, setCropTarget] = useState<RenderBackgroundCropTarget | null>(null);
  const [cropNaturalSize, setCropNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [cropBox, setCropBox] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const currentSrc = reference?.url
    ? resolveMediaUrl(reference.url)
    : anchor?.url
      ? resolveMediaUrl(anchor.url)
      : null;
  const activeAnchorId = sourceId ?? reference?.id ?? anchor?.id ?? "";
  const disabled = loading || !canChoose;
  const formatAnchorLabel = (
    item: { id?: string | null; label?: string | null } | null | undefined,
  ) => {
    const fallback = item?.label ?? item?.id ?? "";
    const labelKey = item?.id ? RENDER_BACKGROUND_ANCHOR_LABEL_KEYS[item.id] : undefined;
    return labelKey ? t(labelKey, { defaultValue: fallback }) : fallback;
  };
  const currentLabel = formatAnchorLabel(reference ?? anchor ?? { id: "master", label: "master" });
  const sourceAnchors = anchors.filter((item) => item.id !== "selected_background");
  const cropTargetSrc = cropTarget?.url ? resolveMediaUrl(cropTarget.url) : null;
  const cropPending = cropTarget ? croppingAnchorId === cropTarget.id : false;
  const cropTitle = cropTarget
    ? t("episode.workbench.render.backgroundCropTitle", { label: cropTarget.label })
    : t("episode.workbench.render.backgroundCropFallbackTitle");
  const canOpenDirectorWorld = Boolean(onOpenDirectorWorld);

  useEffect(() => {
    const cropBoxElement = cropBoxRef.current;
    if (!cropBoxElement || !cropNaturalSize || !cropTarget) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setCropBox((current) =>
        current
          ? zoomCropBox(
              current,
              cropNaturalSize.width,
              cropNaturalSize.height,
              event.deltaY < 0 ? 0.9 : 1.1,
            )
          : current,
      );
    };

    cropBoxElement.addEventListener("wheel", handleWheel, { passive: false });
    return () => cropBoxElement.removeEventListener("wheel", handleWheel);
  }, [cropNaturalSize, cropTarget]);

  const closeCropDialog = () => {
    setCropTarget(null);
    setCropNaturalSize(null);
    setCropBox(null);
    cropDragRef.current = null;
  };

  const saveCropTarget = () => {
    if (!cropTarget) return;
    onCrop(
      cropTarget.id,
      cropBox ??
        centerCropBoxForRatio(
          cropNaturalSize?.width ?? 0,
          cropNaturalSize?.height ?? 0,
          cropAspectRatio,
        ),
    );
    closeCropDialog();
  };

  const moveCropBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!cropDragRef.current || !cropNaturalSize || !cropImageRef.current) return;
    const imageRect = cropImageRef.current.getBoundingClientRect();
    if (imageRect.width <= 0 || imageRect.height <= 0) return;
    const scaleX = cropNaturalSize.width / imageRect.width;
    const scaleY = cropNaturalSize.height / imageRect.height;
    const drag = cropDragRef.current;
    const nextCrop = {
      ...drag.crop,
      x: drag.crop.x + (event.clientX - drag.clientX) * scaleX,
      y: drag.crop.y + (event.clientY - drag.clientY) * scaleY,
    };
    setCropBox(clampCropBox(nextCrop, cropNaturalSize));
  };

  const cropBoxStyle =
    cropBox && cropNaturalSize
      ? {
          left: `${(cropBox.x / cropNaturalSize.width) * 100}%`,
          top: `${(cropBox.y / cropNaturalSize.height) * 100}%`,
          width: `${(cropBox.width / cropNaturalSize.width) * 100}%`,
          height: `${(cropBox.height / cropNaturalSize.height) * 100}%`,
        }
      : undefined;

  return (
    <section className="col-span-2 rounded-[10px] border border-white/[0.055] bg-white/[0.016] p-3">
      <div className="grid items-start gap-3 md:grid-cols-[auto_minmax(0,1fr)]">
        <div className="min-w-0">
          <div
            className="max-w-[min(180px,28vw)] overflow-hidden rounded-[8px] border border-white/[0.075] bg-white/[0.02]"
          >
            {currentSrc ? (
              <img
                src={currentSrc}
                alt={t("episode.workbench.render.backgroundTitle")}
                className="block h-auto max-h-[180px] w-auto max-w-full object-contain"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <div className="flex h-[120px] w-[min(180px,28vw)] items-center justify-center text-xs text-muted-foreground">
                {loading
                  ? t("common.loading", "Loading")
                  : t("episode.workbench.render.backgroundMissing")}
              </div>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
            <div className="flex min-w-0 items-center text-[12px] font-medium text-foreground/76">
              <span className="truncate">{t("episode.workbench.render.backgroundTitle")}</span>
            </div>
            <span className="inline-flex h-5 max-w-full items-center rounded-full border border-primary/35 bg-primary/[0.07] px-2 text-[11px] font-medium leading-none text-primary/88">
              {t("episode.workbench.render.backgroundCurrent", {
                label: currentLabel,
              })}
            </span>
          </div>

          <div className="flex flex-col items-start gap-3">
            {sourceAnchors.map((item) => {
              const isActive = item.id === activeAnchorId;
              const canCrop = CROP_SOURCE_ANCHORS.has(item.id);
              const itemLabel = formatAnchorLabel(item);
              const cropActionLabel = t("episode.workbench.render.backgroundCropAction", {
                label: itemLabel,
              });
              return (
                <div key={item.id} className="flex items-center gap-1 rounded-[8px]">
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={disabled || !item.exists || choosing}
                    onClick={() => onChoose(item.id)}
                    title={item.path || itemLabel}
                    className={cn(
                      "h-7 gap-1 rounded-[7px] border-white/[0.13] bg-white/[0.035] px-2.5 text-[12px] font-normal text-foreground/76 shadow-none hover:border-white/[0.22] hover:bg-white/[0.06] hover:text-foreground disabled:border-white/[0.09] disabled:bg-white/[0.02] disabled:text-muted-foreground/55 dark:bg-white/[0.035]",
                      isActive && "border-primary/45 bg-primary/[0.075] text-primary/90 hover:border-primary/60 hover:bg-primary/[0.11] hover:text-primary",
                    )}
                  >
                    {choosing && isActive ? <Loader2 className="size-3 animate-spin" /> : null}
                    {itemLabel}
                  </Button>
                  {canCrop ? (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="outline"
                      aria-label={cropActionLabel}
                      title={cropActionLabel}
                      disabled={disabled || !item.exists || croppingAnchorId !== null}
                      className="size-7 rounded-[7px] border-white/[0.13] bg-white/[0.035] text-foreground/70 shadow-none hover:border-white/[0.22] hover:bg-white/[0.06] hover:text-foreground disabled:border-white/[0.09] disabled:bg-white/[0.02] disabled:text-muted-foreground/55 dark:bg-white/[0.035]"
                      onClick={() => {
                        setCropNaturalSize(null);
                        setCropTarget({
                          id: item.id,
                          label: itemLabel,
                          url: item.url ?? null,
                          path: item.path ?? null,
                        });
                      }}
                    >
                      {croppingAnchorId === item.id ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Crop className="size-3" />
                      )}
                    </Button>
                  ) : null}
                </div>
              );
            })}
            <input
              ref={uploadInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                onUpload(file);
              }}
            />
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => uploadInputRef.current?.click()}
              disabled={disabled || uploading}
              className="h-7 gap-1 rounded-[7px] border-white/[0.13] bg-white/[0.035] px-2.5 text-[12px] font-normal text-foreground/76 shadow-none hover:border-white/[0.22] hover:bg-white/[0.06] hover:text-foreground disabled:border-white/[0.09] disabled:bg-white/[0.02] disabled:text-muted-foreground/55 dark:bg-white/[0.035]"
            >
              {uploading ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />}
              {t("episode.workbench.render.backgroundUpload")}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {canOpenDirectorWorld ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={onOpenDirectorWorld}
                disabled={disabled}
                className="h-7 gap-1 rounded-[7px] border-white/[0.13] bg-white/[0.035] px-2.5 text-[12px] font-normal text-foreground/76 shadow-none hover:border-white/[0.22] hover:bg-white/[0.06] hover:text-foreground disabled:border-white/[0.09] disabled:bg-white/[0.02] disabled:text-muted-foreground/55 dark:bg-white/[0.035]"
              >
                <ImageIcon className="size-3" />
                {t("episode.workbench.render.backgroundOpen360")}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <Dialog open={cropTarget !== null} onOpenChange={(open) => !open && closeCropDialog()}>
        <DialogContent
          showCloseButton={false}
          className="gap-0 overflow-hidden rounded-none border-0 bg-black p-0 text-white ring-white/10 sm:max-w-[min(96vw,1120px)]"
        >
          <div className="relative flex h-12 items-center border-b border-white/10 px-4">
            <div className="flex items-center gap-2 text-sm font-medium text-white">
              <Crop className="size-4" />
              {`裁剪 ${cropAspectLabel}`}
            </div>
            <DialogTitle className="absolute left-1/2 max-w-[52vw] -translate-x-1/2 truncate text-center text-sm font-medium text-white">
              {cropTitle}
            </DialogTitle>
            <button
              type="button"
              aria-label="关闭"
              className="absolute right-4 flex size-7 items-center justify-center text-white/90 hover:text-white"
              onClick={closeCropDialog}
            >
              <X className="size-5" />
            </button>
          </div>
          <div className="relative flex min-h-[360px] items-center justify-center bg-black p-4">
            {cropTargetSrc ? (
              <div className="relative inline-block max-h-[72vh] max-w-full">
                <img
                  ref={cropImageRef}
                  src={cropTargetSrc}
                  alt={cropTitle}
                  className="block max-h-[72vh] max-w-full object-contain"
                  onLoad={(event) => {
                    const nextSize = {
                      width: event.currentTarget.naturalWidth,
                      height: event.currentTarget.naturalHeight,
                    };
                    setCropNaturalSize(nextSize);
                    setCropBox(
                      centerCropBoxForRatio(
                        nextSize.width,
                        nextSize.height,
                        cropAspectRatio,
                      ),
                    );
                  }}
                />
                {cropBoxStyle ? (
                  <div
                    ref={cropBoxRef}
                    role="button"
                    tabIndex={0}
                    aria-label="移动裁剪区域"
                    className="absolute cursor-move touch-none border-2 border-cyan-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.58)]"
                    style={cropBoxStyle}
                    onPointerDown={(event) => {
                      if (!cropBox) return;
                      event.preventDefault();
                      event.currentTarget.setPointerCapture?.(event.pointerId);
                      cropDragRef.current = {
                        pointerId: event.pointerId,
                        clientX: event.clientX,
                        clientY: event.clientY,
                        crop: cropBox,
                      };
                    }}
                    onPointerMove={moveCropBox}
                    onPointerUp={(event) => {
                      event.currentTarget.releasePointerCapture?.(event.pointerId);
                      cropDragRef.current = null;
                    }}
                    onPointerCancel={(event) => {
                      event.currentTarget.releasePointerCapture?.(event.pointerId);
                      cropDragRef.current = null;
                    }}
                  >
                    <div className="pointer-events-none absolute inset-y-0 left-1/3 border-l border-white/30" />
                    <div className="pointer-events-none absolute inset-y-0 left-2/3 border-l border-white/30" />
                    <div className="pointer-events-none absolute inset-x-0 top-1/3 border-t border-white/30" />
                    <div className="pointer-events-none absolute inset-x-0 top-2/3 border-t border-white/30" />
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
                {t("episode.workbench.render.backgroundMissing")}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-white/10 bg-black px-4 py-3">
            <Button type="button" variant="outline" onClick={closeCropDialog}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={saveCropTarget}
              disabled={!cropTargetSrc || cropPending}
              className={CROP_DIALOG_SAVE_BUTTON_CLASS}
            >
              {cropPending ? <Loader2 className="size-3 animate-spin" /> : <Crop className="size-3" />}
              {t("episode.workbench.render.backgroundCropSave", "保存截图")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function isRenderAssignmentMatch(img: PoolImage, assignment: string) {
  return (
    img.type === "render" &&
    (img.id === assignment ||
      img.cell_path === assignment ||
      img.grid_path === assignment)
  );
}
