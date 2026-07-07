// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createLazyFileRoute } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Brush, Clapperboard, Loader2, Play, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { useEpisodeBeats, useEpisodeDetail } from "@/lib/queries/episodes";
import { useBeatStates } from "@/hooks/use-beat-states";
import { useBeatsWorkbenchParam } from "@/hooks/use-beats-workbench-param";
import { useEpisodeImageTaskInvalidation } from "@/hooks/use-episode-image-task-invalidation";
import { useSelection } from "@/hooks/use-selection";
import { useViewToggles } from "@/hooks/use-view-toggles";
import { useGenerateScript } from "@/lib/queries/scripts";
import {
  useSketchSettings,
  type SketchAspectRatio,
} from "@/lib/queries/sketch-settings";
import {
  useRebuildPoolIndex,
  useRegenerateSketches,
} from "@/lib/queries/sketches";
import { useProject, useUpdateProject } from "@/lib/queries/projects";
import { useProjectAspectRatio } from "@/stores/aspect-ratio-store";
import {
  aspectRatioForOrientation,
  orientationForAspectRatio,
} from "@/lib/aspect-ratio";
import { DEFAULT_VIDEO_BACKEND, useVideoBackends } from "@/lib/queries/video";
import { openPresetProjectionInMyCanvas } from "@/features/freezone/openPresetProjection";
import { useTaskController } from "@/hooks/use-task-controller";
import { useScopedTaskBatchInvalidation } from "@/hooks/use-scoped-task-batch-invalidation";
import { queryKeys } from "@/lib/query-keys";
import { TASK_TYPES } from "@/lib/task-types";
import { useTasks } from "@/lib/queries/tasks";
import { GLASS_ALERT_DIALOG_CONTENT_CLASS } from "@/lib/dialog-styles";
import { cn } from "@/lib/utils";

import { BatchBar } from "@/components/episode/beat-workbench/batch-bar";
import {
  createSketchRegenPlanItems,
  getLockedSketchRegenItemIds,
  sketchRegenModelCallCount,
  sketchPlanGridLabel,
} from "@/components/episode/beat-workbench/batch-panel";
import {
  useEpisodeActionsSlot,
  useRegisterEpisodeActionsSlot,
} from "@/components/episode/episode-actions-slot";
import { BeatCardGrid } from "@/components/episode/beat-workbench/beat-card-grid";
import { EpisodeEmptyState } from "@/components/episode/episode-empty-state";
import { SketchGridGallery } from "@/components/episode/beat-workbench/sketch-grid-gallery";
import {
  SketchColorLegend,
  SketchStudioActions,
} from "@/components/episode/beat-workbench/sketch-studio-actions";
import { RenderGridGallery } from "@/components/episode/beat-workbench/render-grid-gallery";
import { ViewToggles } from "@/components/episode/beat-workbench/view-toggles";
import { ActionPanel } from "@/components/episode/beat-workbench/action-panel";
import { RenderPlanDialog } from "@/components/episode/beat-workbench/render-plan-dialog";
import { useHideHeaderOnScroll } from "@/components/episode/header-collapse";
import { Button } from "@/components/ui/button";
import { EMPTY_STATE_ACTION_BUTTON_CLASS } from "@/components/ui/empty-state-styles";
import { CreditCostInline } from "@/components/credit-cost-inline";
import { formatCreditCost } from "@/components/credits/credit-visual";
import {
  backendErrorToastMessage,
  BillingRuleNotConfiguredError,
} from "@/lib/api-errors";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";

const SHOW_EPISODE_FREEZONE_ENTRY = false;

/**
 * /beats (镜头) — v2 card-grid + action-panel workbench.
 *
 * Layout:
 *   ├─ BatchBar         (episode-level batch actions, always visible)
 *   └─ fixed two-column workbench
 *       ├─ left pane: ViewToggles + BeatCardGrid
 *       └─ right pane: sketch studio actions + ActionPanel
 *
 * NiceGUI sketch grid features are exposed from the toolbar as dialogs
 * so the default shell stays aligned with the FE main branch split layout.
 */
function BeatsTabContent() {
  const { t } = useTranslation();
  const scrollHideRef = useHideHeaderOnScroll<HTMLDivElement>();
  // Route params
  const { project, episode } = Route.useParams();
  const epNum = parseInt(episode, 10);
  const actionsSlot = useEpisodeActionsSlot();
  useEpisodeImageTaskInvalidation(project, epNum);

  // Data
  const { data: beatsRes, isLoading } = useEpisodeBeats(project, epNum);
  const { data: episodeRes } = useEpisodeDetail(project, epNum);
  const { data: sketchSettingsRes } = useSketchSettings(project);
  const projectConfigRes = useProject(project);
  const videoBackendsRes = useVideoBackends(project);
  const updateProject = useUpdateProject(project);
  const { states } = useBeatStates(project, epNum);
  const beats = beatsRes?.data ?? [];
  useRegisterEpisodeActionsSlot(beats.length > 0);
  const identityIds = episodeRes?.data?.identity_ids ?? [];
  const identityPlanReady = identityIds.length > 0;
  const isNarratedProject = projectConfigRes.data?.data?.spine_template === "narrated";

  // URL deep-link
  const {
    beat: deepLinkBeat,
    sub: targetSection,
    focusBeat,
    setBeat,
    clearFocusBeat,
  } = useBeatsWorkbenchParam();
  const appliedDeepLinkRef = useRef<string | null>(null);
  const focusAppliedRef = useRef<number | null>(null);

  // Selection state machine
  const {
    state: selection,
    handleCardClick,
    toggleCheck,
    selectSingle,
    clearSelection,
  } = useSelection({ project, episode: epNum });

  // View toggles (localStorage persisted)
  const { toggles, toggle: toggleView } = useViewToggles(project, epNum);

  // Project-level prefs mirrored from NiceGUI video_studio_page.video_settings.
  const [videoBackend, setVideoBackendState] = useState(DEFAULT_VIDEO_BACKEND);

  // 左(渲染/Beat 区)与右(详情/功能区)的可拖拽宽度占比。拖动中间分隔条调节占比;
  // 比例持久化到 localStorage —— 属 UI 偏好(region 无关),不随切区清空。clamp 25%–70%。
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const splitDraggingRef = useRef(false);
  const [leftSplitPct, setLeftSplitPct] = useState<number>(() => {
    const saved = Number(localStorage.getItem("st.beats.split-ratio"));
    return Number.isFinite(saved) && saved >= 25 && saved <= 70 ? saved : 38;
  });
  const handleSplitPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      splitDraggingRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );
  const handleSplitPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!splitDraggingRef.current) return;
      const rect = splitContainerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const pct = ((event.clientX - rect.left) / rect.width) * 100;
      setLeftSplitPct(Math.min(70, Math.max(25, pct)));
    },
    [],
  );
  const handleSplitPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!splitDraggingRef.current) return;
      splitDraggingRef.current = false;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      setLeftSplitPct((pct) => {
        localStorage.setItem("st.beats.split-ratio", String(Math.round(pct)));
        return pct;
      });
    },
    [],
  );

  // 画幅 (aspect ratio) — single global per-project source of truth. Drives
  // sketch generation params, beat-card display, and render/video downstream.
  const { orientation, spec: aspectSpecValue, setOrientation } =
    useProjectAspectRatio(project);
  const sketchAspectRatio: SketchAspectRatio = aspectSpecValue.sketchAspect;
  // Switching画幅 never re-stretches already-generated assets — it only changes
  // the ratio future generations use. Warn before flipping if this episode
  // already has sketches/renders/videos so the user can re-generate knowingly.
  const [pendingAspect, setPendingAspect] = useState<SketchAspectRatio | null>(
    null,
  );
  const hasGeneratedAssets = useMemo(
    () => beats.some((b) => b.sketch_url || b.frame_url || b.video_url),
    [beats],
  );
  const applyAspect = useCallback(
    (next: SketchAspectRatio) => {
      const nextOrientation = next === "16:9" ? "landscape" : "portrait";
      setOrientation(nextOrientation);
      void updateProject
        .mutateAsync({ aspect_ratio: aspectRatioForOrientation(nextOrientation) })
        .catch(() => toast.error(t("common.error")));
    },
    [setOrientation, t, updateProject],
  );
  const setSketchAspectRatio = useCallback(
    (next: SketchAspectRatio) => {
      const nextOrientation = next === "16:9" ? "landscape" : "portrait";
      if (nextOrientation === orientation) return;
      if (hasGeneratedAssets) {
        setPendingAspect(next);
        return;
      }
      applyAspect(next);
    },
    [applyAspect, hasGeneratedAssets, orientation],
  );
  useEffect(() => {
    setVideoBackendState(
      projectConfigRes.data?.data?.video_backend || DEFAULT_VIDEO_BACKEND,
    );
  }, [projectConfigRes.data?.data?.video_backend]);
  useEffect(() => {
    const persistedOrientation = orientationForAspectRatio(
      projectConfigRes.data?.data?.aspect_ratio,
    );
    if (persistedOrientation && persistedOrientation !== orientation) {
      setOrientation(persistedOrientation);
    }
  }, [orientation, projectConfigRes.data?.data?.aspect_ratio, setOrientation]);
  const handleVideoBackendChange = useCallback(
    (backend: string) => {
      if (!backend) return;
      setVideoBackendState(backend);
      void updateProject
        .mutateAsync({ video_backend: backend })
        .catch(() => toast.error(t("common.error")));
    },
    [t, updateProject],
  );
  const sketchImageGenerationSelection =
    sketchSettingsRes?.data?.sketch_image_selection;
  const sketchCostModeKey =
    sketchAspectRatio === "16:9" ? "1x1_16-9_sketch" : "1x1_2-3_sketch";
  const sketchCost = useGenerationCreditCost(
    "image_selection",
    sketchImageGenerationSelection,
    { surface: "supertale", imageRole: "sketch", modeKey: sketchCostModeKey },
  );
  const isSeedance2Backend =
    videoBackendsRes.data?.data.find((backend) => backend.value === videoBackend)
      ?.is_seedance2 === true;

  const aspectRatio: "portrait" | "landscape" = orientation;

  const regenSketches = useRegenerateSketches(project, epNum);
  const rebuildPoolIndex = useRebuildPoolIndex(project, epNum);
  const tasks = useTasks({ project, episode: epNum });
  // A batch dispatches one `sketch_regen` task per grid (each with its own
  // server-assigned scope). A single `useTaskController` can only follow one
  // scope at a time, so track the whole set by scope membership instead — every
  // grid's completion then refreshes the page, not just the last one.
  const { track: trackSketchRegen } = useScopedTaskBatchInvalidation({
    project,
    taskType: TASK_TYPES.SKETCH_REGEN,
    invalidateKeys: [
      queryKeys.grids(project, epNum),
      queryKeys.beats(project, epNum),
      queryKeys.pipelineStatus(project),
    ],
  });
  // One render `execute` fans out into N `selected_regen` grid tasks (and only
  // returns a non-matching umbrella `location__…` scope), so a single
  // controller can't follow them all. Track every grid task by its id instead.
  const { track: trackRenderTask } = useScopedTaskBatchInvalidation({
    project,
    taskType: TASK_TYPES.SELECTED_REGEN,
    matchBy: "task_id",
    invalidateKeys: [
      queryKeys.grids(project, epNum),
      queryKeys.beats(project, epNum),
      queryKeys.sketchImageUsage(project, epNum),
      queryKeys.pipelineStatus(project),
    ],
  });
  const checkedBeatNums = useMemo(
    () =>
      selection.mode === "multi"
        ? [...selection.checked].sort((a, b) => a - b)
        : [],
    [selection],
  );
  const [sketchPlanOpen, setSketchPlanOpen] = useState(false);
  const [renderPlanOpen, setRenderPlanOpen] = useState(false);
  const sketchPlanItems = useMemo(
    () => createSketchRegenPlanItems(beats, checkedBeatNums, sketchAspectRatio),
    [beats, checkedBeatNums, sketchAspectRatio],
  );
  const lockedSketchItemIds = useMemo(
    () => getLockedSketchRegenItemIds(tasks.data?.data, sketchPlanItems),
    [sketchPlanItems, tasks.data?.data],
  );
  const sketchPlanUnlockedCount = sketchPlanItems.filter(
    (item) => !lockedSketchItemIds.has(item.id),
  ).length;
  const sketchPlanCostDisplay = useMemo(() => {
    const unitCost = sketchCost.data?.data.cost;
    if (typeof unitCost !== "number") return null;
    return formatCreditCost(unitCost * sketchRegenModelCallCount(sketchPlanItems));
  }, [sketchCost.data?.data.cost, sketchPlanItems]);

  const openSketchPlan = useCallback(() => {
    if (checkedBeatNums.length === 0) return;
    setSketchPlanOpen(true);
  }, [checkedBeatNums.length]);

  const openRenderPlan = useCallback(() => {
    if (checkedBeatNums.length === 0) return;
    setRenderPlanOpen(true);
  }, [checkedBeatNums.length]);

  const dispatchSketchPlanItems = useCallback(async () => {
    const dispatchableItems = sketchPlanItems.filter(
      (item) => !lockedSketchItemIds.has(item.id),
    );
    if (dispatchableItems.length === 0) {
      toast.warning(
        t("episode.workbench.batch.sketchGroupRunning", {
          defaultValue: "相同草图组正在运行中",
        }),
      );
      return;
    }

    let okBeats = 0;
    let okGrids = 0;
    let fail = 0;
    let firstError = "";

    for (const item of dispatchableItems) {
      try {
        const res = await regenSketches.mutateAsync({
          beatIndices: item.beatNumbers,
          modeKey: item.modeKey,
        });
        if (res.ok === false) {
          fail++;
          firstError ||= res.error || t("episode.workbench.batch.dispatchFailed");
          continue;
        }
        okGrids++;
        okBeats += item.beatNumbers.length;
        trackSketchRegen(res.scope);
      } catch {
        fail++;
        firstError ||= t("episode.workbench.batch.dispatchFailed");
      }
    }

    if (okGrids > 0) {
      clearSelection();
      toast.success(
        t("episode.workbench.batch.dispatched", {
          count: okBeats,
          mode: okGrids === 1 ? dispatchableItems[0].modeLabel : `${okGrids} grids`,
        }),
      );
    }

    if (fail > 0 && okGrids === 0 && firstError) {
      toast.error(firstError);
    } else if (fail > 0) {
      toast.warning(
        `${t("episode.workbench.batch.videoPartial", { ok: okGrids, fail })}${
          firstError ? `: ${firstError}` : ""
        }`,
      );
    }
  }, [
    clearSelection,
    lockedSketchItemIds,
    regenSketches,
    sketchPlanItems,
    trackSketchRegen,
    t,
  ]);

  const handleConfirmSketchPlan = useCallback(() => {
    setSketchPlanOpen(false);
    void dispatchSketchPlanItems();
  }, [dispatchSketchPlanItems]);

  const handleRebuildPoolIndex = useCallback(async () => {
    try {
      const res = await rebuildPoolIndex.mutateAsync();
      toast.success(
        t("episode.workbench.pool.rebuildSuccess", {
          count: res.data.image_count,
        }),
      );
    } catch {
      toast.error(t("episode.workbench.pool.rebuildFailed"));
    }
  }, [rebuildPoolIndex, t]);

  const firstBeatNumber = beats[0]?.beat_number ?? null;

  // Deep-link: apply URL-backed selection once per URL target.
  useEffect(() => {
    const deepLinkKey =
      deepLinkBeat !== null && beats.length > 0
        ? `beat:${deepLinkBeat}`
        : targetSection !== null && firstBeatNumber !== null
          ? `sub:${targetSection}:${firstBeatNumber}`
          : null;

    if (deepLinkKey === null) {
      appliedDeepLinkRef.current = null;
      return;
    }
    if (appliedDeepLinkRef.current === deepLinkKey) {
      return;
    }
    appliedDeepLinkRef.current = deepLinkKey;

    if (selection.mode !== "none") {
      return;
    }

    if (deepLinkBeat !== null) {
      selectSingle(deepLinkBeat);
    } else if (firstBeatNumber !== null) {
      selectSingle(firstBeatNumber);
    }
  }, [
    deepLinkBeat,
    targetSection,
    beats.length,
    firstBeatNumber,
    selectSingle,
    selection.mode,
  ]);

  // Explicit jump (e.g. clicking a card on the compose tab): force-select the
  // target beat regardless of restored selection, then drop the one-shot URL
  // param. BeatCardGrid scrolls the now-selected card into view.
  useEffect(() => {
    if (focusBeat === null) {
      focusAppliedRef.current = null;
      return;
    }
    if (beats.length === 0) return;
    if (focusAppliedRef.current === focusBeat) return;
    focusAppliedRef.current = focusBeat;
    selectSingle(focusBeat);
    clearFocusBeat();
  }, [focusBeat, beats.length, selectSingle, clearFocusBeat]);

  // Sync URL when selection changes to single
  useEffect(() => {
    if (selection.mode === "single") {
      setBeat(selection.beatNum);
    } else if (selection.mode === "none") {
      setBeat(null);
    }
    // Don't sync multi-select to URL
  }, [selection, setBeat]);

  // If a selected beat is deleted or disappears after refetch, treat it as no
  // selection. Raw backend ids (for manual shots, e.g. 61) must not leak into
  // the right-panel header once the row no longer exists.
  useEffect(() => {
    if (isLoading) return;
    if (selection.mode !== "single") return;
    if (beats.some((beat) => beat.beat_number === selection.beatNum)) return;
    clearSelection();
  }, [beats, clearSelection, isLoading, selection]);

  // Generate script for empty state
  const generateScript = useGenerateScript(project, epNum);
  const generateScriptCost = useGenerationCreditCost("feature", "script_writer");
  const generateScriptCostDisplay =
    generateScriptCost.data?.data.display ??
    (generateScriptCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);
  const scriptTask = useTaskController({
    key: { taskType: "script_writer", project, episode: epNum },
    alsoReconcile: ["literal_script_writer"],
    invalidateKeys: [
      queryKeys.script(project, epNum),
      queryKeys.beats(project, epNum),
      queryKeys.pipelineStatus(project),
    ],
  });
  const handleGenerate = async () => {
    if (!identityPlanReady) {
      toast.error(t("episode.script.identityRequired"));
      return;
    }
    try {
      const res = await generateScript.mutateAsync({});
      if (res.ok === false) {
        toast.error(backendErrorToastMessage(res.error, t));
        return;
      }
      scriptTask.start({ scope: res.scope });
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const [openingEpisodeFreezone, setOpeningEpisodeFreezone] = useState(false);
  const handleOpenEpisodeFreezone = useCallback(async () => {
    setOpeningEpisodeFreezone(true);
    try {
      await openPresetProjectionInMyCanvas(project, {
        scope: "episode",
        episode: epNum,
      });
      toast.success(t("episode.workbench.actionPanel.episodeFreezoneOpened"));
    } catch {
      toast.error(t("episode.workbench.actionPanel.episodeFreezoneOpenFailed"));
    } finally {
      setOpeningEpisodeFreezone(false);
    }
  }, [epNum, project, t]);

  // Confirm dialog state for empty-state generate
  const [genBeatsConfirm, setGenBeatsConfirm] = useState(false);
  const [gridGalleryOpen, setGridGalleryOpen] = useState(false);
  const [renderGridGalleryOpen, setRenderGridGalleryOpen] = useState(false);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("episode.beats.loading")}
      </div>
    );
  }

  // Empty state — no beats
  if (beats.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-12 text-center">
        <EpisodeEmptyState
          icon={Clapperboard}
          title={t("episode.beats.noBeatsTitle")}
          description={t("episode.beats.noBeats")}
          className="h-auto p-0"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => setGenBeatsConfirm(true)}
          disabled={
            !identityPlanReady || generateScript.isPending || scriptTask.started
          }
          className={cn(EMPTY_STATE_ACTION_BUTTON_CLASS, "[&_svg]:size-3.5")}
          title={
            identityPlanReady
              ? undefined
              : t("episode.script.identityRequired")
          }
        >
          {generateScript.isPending || scriptTask.started ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          {t("episode.beats.generateBeats")}
          <CreditCostInline display={generateScriptCostDisplay} />
        </Button>
        <AlertDialog open={genBeatsConfirm} onOpenChange={setGenBeatsConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("episode.beats.generateBeatsTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("episode.beats.generateBeatsDesc")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setGenBeatsConfirm(false);
                  handleGenerate();
                }}
              >
                {t("common.confirmExecute")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  const detailBeatNumber =
    selection.mode === "single" ? selection.beatNum : null;
  const detailBeatDisplayNumber =
    detailBeatNumber === null
      ? null
      : (() => {
          const index = beats.findIndex(
            (beat) => beat.beat_number === detailBeatNumber,
          );
          return index >= 0 ? index + 1 : null;
        })();

  // Main layout
  return (
    <div ref={scrollHideRef} className="flex h-full flex-col overflow-hidden">
      {actionsSlot &&
        createPortal(
          <BatchBar
            project={project}
            episode={epNum}
            beats={beats}
            videoBackend={videoBackend}
            spineTemplate={isNarratedProject ? "narrated" : "drama"}
            sketchAspectRatio={sketchAspectRatio}
            onSketchAspectRatioChange={setSketchAspectRatio}
          />,
          actionsSlot,
        )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <div
          ref={splitContainerRef}
          data-beats-split
          className="flex h-full min-h-0 overflow-hidden"
        >
          <section
            style={{ width: `${leftSplitPct}%` }}
            className="min-w-0 shrink-0 overflow-hidden"
          >
            <div className="flex h-full min-h-0 flex-col">
              <ViewToggles
                toggles={toggles}
                onToggle={toggleView}
                selection={selection}
                totalBeats={beats.length}
                onClearSelection={clearSelection}
                onBatchRegenSketch={openSketchPlan}
                onBatchRegenRender={openRenderPlan}
                legendSlot={
                  <SketchColorLegend project={project} episode={epNum} />
                }
              />
              <BeatCardGrid
                beats={beats}
                toggles={toggles}
                selection={selection}
                aspectRatio={aspectRatio}
                project={project}
                episode={epNum}
                spineTemplate={isNarratedProject ? "narrated" : "drama"}
                onCardClick={handleCardClick}
                onCheckboxClick={toggleCheck}
              />
            </div>
          </section>
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={handleSplitPointerDown}
            onPointerMove={handleSplitPointerMove}
            onPointerUp={handleSplitPointerUp}
            className="group relative z-10 w-1.5 shrink-0 cursor-col-resize touch-none select-none"
            title={t("episode.workbench.view.dragToResize")}
          >
            <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/[0.055] transition-colors group-hover:bg-primary/60 group-active:bg-primary/80" />
          </div>
          <section className="min-w-0 flex-1 overflow-hidden">
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-b border-white/[0.055] px-3 py-2">
                {detailBeatDisplayNumber !== null ? (
                  <span className="font-mono text-xs font-medium leading-none tabular-nums text-primary">
                    {t("episode.workbench.view.activeBeat", {
                      n: detailBeatDisplayNumber,
                    })}
                  </span>
                ) : (
                  <span aria-hidden className="min-w-0" />
                )}
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 rounded-[5px] bg-transparent px-1.5 text-[11px] font-medium text-foreground/75 shadow-none hover:bg-white/[0.04] hover:text-foreground dark:bg-transparent"
                    onClick={() => void handleRebuildPoolIndex()}
                    disabled={rebuildPoolIndex.isPending}
                    title={t("episode.workbench.pool.rebuildIndex")}
                  >
                    {rebuildPoolIndex.isPending ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3" />
                    )}
                    {t("episode.workbench.pool.rebuildIndex")}
                  </Button>
                  {SHOW_EPISODE_FREEZONE_ENTRY && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5"
                      onClick={handleOpenEpisodeFreezone}
                      disabled={openingEpisodeFreezone}
                      title={t("episode.workbench.actionPanel.episodeFreezoneTooltip")}
                    >
                      {openingEpisodeFreezone ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Brush className="size-3.5" />
                      )}
                      {t("episode.workbench.actionPanel.episodeFreezone")}
                    </Button>
                  )}
                  <SketchStudioActions
                    project={project}
                    episode={epNum}
                    onOpenGridGallery={() => setGridGalleryOpen(true)}
                    onOpenRenderGridGallery={
                      isNarratedProject
                        ? () => setRenderGridGalleryOpen(true)
                        : undefined
                    }
                    showLegend={false}
                    showDetectionSummary={false}
                  />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <ActionPanel
                  selection={selection}
                  beats={beats}
                  states={states}
                  project={project}
                  episode={epNum}
                  defaultBackend={videoBackend}
                  onDefaultBackendChange={handleVideoBackendChange}
                  spineTemplate={isNarratedProject ? "narrated" : "drama"}
                  isSeedance2Backend={isSeedance2Backend}
                  showAudioMediaStatus={isNarratedProject}
                  targetSection={targetSection}
                />
              </div>
            </div>
          </section>
        </div>
      </div>
      <Dialog open={gridGalleryOpen} onOpenChange={setGridGalleryOpen}>
        <DialogContent
          closeButtonClassName="top-0 -right-9 z-50 bg-transparent text-white/45 hover:bg-transparent hover:text-white/72 focus-visible:bg-transparent"
          overlayClassName="bg-black/8 supports-backdrop-filter:backdrop-blur-sm"
          className="h-[min(calc(100vh-3rem),760px)] w-[min(calc(100vw-1rem),1440px)] max-w-none sm:max-w-none overflow-visible rounded-2xl border border-white/10 bg-black/35 bg-[linear-gradient(135deg,rgba(255,255,255,0.045),rgba(255,255,255,0.012))] p-0 shadow-none backdrop-blur-2xl"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t("episode.workbench.sketchGrid.title")}</DialogTitle>
          </DialogHeader>
          <div className="h-full overflow-hidden rounded-2xl">
            <SketchGridGallery
              project={project}
              episode={epNum}
              beats={beats}
              aspectRatio={sketchAspectRatio}
              imageGenerationSelection={sketchImageGenerationSelection}
            />
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={renderGridGalleryOpen} onOpenChange={setRenderGridGalleryOpen}>
        <DialogContent
          closeButtonClassName="top-0 -right-9 z-50 bg-transparent text-white/45 hover:bg-transparent hover:text-white/72 focus-visible:bg-transparent"
          overlayClassName="bg-black/8 supports-backdrop-filter:backdrop-blur-sm"
          className="h-[min(calc(100vh-3rem),760px)] w-[min(calc(100vw-1rem),1440px)] max-w-none sm:max-w-none overflow-visible rounded-2xl border border-white/10 bg-black/35 bg-[linear-gradient(135deg,rgba(255,255,255,0.045),rgba(255,255,255,0.012))] p-0 shadow-none backdrop-blur-2xl"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t("episode.workbench.renderGrid.title")}</DialogTitle>
          </DialogHeader>
          <div className="h-full overflow-hidden rounded-2xl">
            <RenderGridGallery project={project} episode={epNum} beats={beats} />
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog open={sketchPlanOpen} onOpenChange={setSketchPlanOpen}>
        <AlertDialogContent className={cn("max-w-3xl", GLASS_ALERT_DIALOG_CONTENT_CLASS)}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("episode.sketchPlan.title", {
                beats: checkedBeatNums.length,
                grids: sketchPlanItems.length,
                defaultValue: `草图计划（${checkedBeatNums.length} beats → ${sketchPlanItems.length} 个网格）`,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("episode.sketchPlan.subtitle", {
                defaultValue: "系统已根据场景自动分组。确认后会直接发配草图任务。",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="mt-4 max-h-[45vh] overflow-y-auto">
            <div className="flex flex-wrap gap-2">
              {sketchPlanItems.map((item) => (
                <div
                  key={item.id}
                  className={`flex w-[170px] shrink-0 flex-col gap-1 rounded-[6px] border bg-white/[0.05] p-2 text-xs backdrop-blur-sm ${
                    lockedSketchItemIds.has(item.id)
                      ? "border-white/10 opacity-50"
                      : "border-white/10"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {sketchPlanGridLabel(item.modeKey)}
                    </span>
                    <span className="text-muted-foreground">
                      {item.beatNumbers.length > 1
                        ? `B${item.beatNumbers[0]}-${
                            item.beatNumbers[item.beatNumbers.length - 1]
                          }`
                        : `B${item.beatNumbers[0]}`}
                    </span>
                  </div>
                  <div
                    className="truncate text-emerald-400"
                    title={item.sceneIds.join(" / ")}
                  >
                    {item.sceneIds.join(" / ") ||
                      t("episode.renderPlan.unknownLocation")}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {lockedSketchItemIds.has(item.id)
                      ? t("episode.workbench.batch.sketchGroupRunning", {
                          defaultValue: "相同草图组正在运行中",
                        })
                      : item.modeLabel}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <AlertDialogFooter className="px-4">
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="outline"
              disabled={sketchPlanItems.length === 0 || sketchPlanUnlockedCount === 0}
              onClick={handleConfirmSketchPlan}
              className="relative pr-11 transition-transform active:scale-95"
            >
              {t("episode.sketchPlan.confirm", {
                grids: sketchPlanItems.length,
                defaultValue: `确认草图 ${sketchPlanItems.length} 个网格`,
              })}
              <CreditCostInline display={sketchPlanCostDisplay} />
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RenderPlanDialog
        open={renderPlanOpen}
        onOpenChange={setRenderPlanOpen}
        project={project}
        episode={epNum}
        beatIndices={checkedBeatNums}
        aspectMode={aspectSpecValue.renderAspect}
        defaultForceOneByOne={false}
        onDispatched={(taskIds) => {
          taskIds.forEach((id) => trackRenderTask(id));
          toast.success(t("episode.renderPlan.dispatched"));
          clearSelection();
        }}
      />
      <AlertDialog
        open={pendingAspect !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAspect(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("episode.workbench.aspectSwitch.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("episode.workbench.aspectSwitch.desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingAspect) applyAspect(pendingAspect);
                setPendingAspect(null);
              }}
            >
              {t("episode.workbench.aspectSwitch.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export const Route = createLazyFileRoute(
  "/_app/projects/$project/episodes/$episode/beats",
)({
  component: BeatsTabContent,
});
