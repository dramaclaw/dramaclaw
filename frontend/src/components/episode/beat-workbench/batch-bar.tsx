// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Loader2,
  Mic2,
  Palette,
  Sparkles,
  Wand2,
} from "lucide-react";

import { useGenerateAudio } from "@/lib/queries/audio";
import {
  useAssignColors,
  useDetectIdentities,
} from "@/lib/queries/sketches";
import {
  useGlobalOptimize,
  useVideoBackends,
} from "@/lib/queries/video";
import { useTaskController } from "@/hooks/use-task-controller";
import { queryKeys } from "@/lib/query-keys";
import { TASK_TYPES } from "@/lib/task-types";
import { cn } from "@/lib/utils";
import {
  backendErrorToastMessage,
  BillingRuleNotConfiguredError,
} from "@/lib/api-errors";
import type { SketchAspectRatio } from "@/lib/queries/sketch-settings";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { CreditCostInline } from "@/components/credit-cost-inline";
import { CreditCostPill, formatCreditCost } from "@/components/credits/credit-visual";
import type { Beat } from "@/types/episode";

import { RenderModelSelect } from "./render-settings-controls";
import { SketchModelSelect, SketchAspectCheckbox } from "./sketch-settings-controls";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const TOOLBAR_CONTROL_CLASS =
  "h-[26px] gap-1.5 rounded-[6px] border border-white/10 bg-transparent px-2 py-0 text-[11px] font-medium text-foreground/85 transition-colors hover:border-primary/40 hover:bg-white/[0.04] hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:text-muted-foreground/50";

interface BatchBarProps {
  project: string;
  episode: number;
  beats: Beat[];
  videoBackend: string;
  spineTemplate?: "drama" | "narrated";
  sketchAspectRatio: SketchAspectRatio;
  onSketchAspectRatioChange: (aspectRatio: SketchAspectRatio) => void;
}

type AudioCostBeat = Beat & {
  narration?: string | null;
};

function normalizeAudioTypeForCost(beat: AudioCostBeat): string {
  const audioType = String(beat.audio_type || "").trim();
  if (audioType === "action") return "silence";
  if (audioType) return audioType;
  if (String(beat.speaker || "").trim()) return "dialogue";
  return "narration";
}

export function episodeAudioModelCallCount(beats: readonly Beat[]): number {
  return beats.reduce((count, beat) => {
    const beatNumber = Number(beat.beat_number || 0);
    if (beatNumber <= 0 || beat.is_manual_shot) return count;

    const audioType = normalizeAudioTypeForCost(beat);
    if (audioType !== "narration" && audioType !== "dialogue") return count;

    return count + 1;
  }, 0);
}

export function BatchBar({
  project,
  episode,
  beats,
  videoBackend,
  spineTemplate = "drama",
  sketchAspectRatio,
  onSketchAspectRatioChange,
}: BatchBarProps) {
  const { t } = useTranslation();

  const assignColors = useAssignColors(project, episode);
  const detectIdentities = useDetectIdentities(project, episode);
  const generateAudio = useGenerateAudio(project, episode);
  const globalOptimize = useGlobalOptimize(project, episode);
  const videoBackends = useVideoBackends(project);
  const detectIdentitiesCost = useGenerationCreditCost("feature", "ai_identity_detection");
  const episodeAudioCost = useGenerationCreditCost("beat_tts");

  const [errorDialog, setErrorDialog] = useState<{
    title: string;
    description: string;
  } | null>(null);
  const showError = (title: string, description: string) => {
    setErrorDialog({ title, description });
  };
  const audioTask = useTaskController({
    key: { taskType: TASK_TYPES.AUDIO_GENERATION_INDEXTTS2, project, episode },
    alsoReconcile: [TASK_TYPES.AUDIO_GENERATION],
    invalidateKeys: [
      queryKeys.beats(project, episode),
      queryKeys.pipelineStatus(project),
    ],
  });
  const globalOptimizeTask = useTaskController({
    key: { taskType: "global_optimize_video", project, episode },
    invalidateKeys: [
      queryKeys.beats(project, episode),
      queryKeys.pipelineStatus(project),
    ],
    onError: (e) =>
      showError(t("episode.workbench.batch.aiOptimizeTitle"), e || t("common.error")),
  });
  const selectedVideoBackend = videoBackends.data?.data.find(
    (option) => option.value === videoBackend,
  );
  const audioUnavailableForVideoBackend = selectedVideoBackend?.is_seedance2 === true;
  const showGlobalOptimize = spineTemplate === "narrated";
  const episodeAudioCalls = useMemo(
    () => episodeAudioModelCallCount(beats),
    [beats],
  );
  const episodeAudioCostDisplay = useMemo(() => {
    const unitCost = episodeAudioCost.data?.data.cost;
    if (episodeAudioCalls <= 0 || typeof unitCost !== "number") return "";
    return formatCreditCost(unitCost * episodeAudioCalls);
  }, [episodeAudioCost.data?.data.cost, episodeAudioCalls]);
  const detectIdentitiesCostDisplay =
    detectIdentitiesCost.data?.data.display ??
    (detectIdentitiesCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);

  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    onConfirm: () => void;
    costSource?: "episodeAudio";
  } | null>(null);

  const askConfirm = (
    title: string,
    description: string,
    onConfirm: () => void,
    costSource?: "episodeAudio",
  ) => {
    setConfirm({ title, description, onConfirm, costSource });
  };
  const confirmCostDisplay =
    confirm?.costSource === "episodeAudio" ? episodeAudioCostDisplay : "";

  const handleGenAllAudio = async () => {
    try {
      const res = await generateAudio.mutateAsync(undefined);
      if (res.ok === false) {
        showError(t("episode.workbench.batch.genAudioTitle"), res.error || t("common.error"));
        return;
      }
      audioTask.start({ scope: res.scope });
    } catch {
      toast.error(t("common.error"));
    }
  };
  const handleGlobalOptimize = async () => {
    try {
      const res = await globalOptimize.mutateAsync();
      if (res.ok === false) {
        showError(t("episode.workbench.batch.aiOptimizeTitle"), res.error || t("common.error"));
        return;
      }
      globalOptimizeTask.start();
      toast.success(t("episode.workbench.batch.globalOptimizeStarted"));
    } catch {
      toast.error(t("common.error"));
    }
  };
  const handleAiDetect = async () => {
    const toastId = toast.loading(
      t("episode.workbench.batch.aiDetectRunning"),
    );
    try {
      const res = await detectIdentities.mutateAsync();
      if (!res.ok) {
        toast.error(res.error ?? t("common.error"), { id: toastId });
        return;
      }
      const {
        total_beats,
        total_identities,
        total_props = 0,
        review_message,
      } = res.data;
      const reviewMessage =
        review_message || t("episode.workbench.batch.aiDetectReview");
      if (total_identities === 0 && total_props === 0) {
        toast.info(`${t("episode.workbench.batch.aiDetectEmpty")}\n${reviewMessage}`, {
          id: toastId,
        });
        return;
      }
      toast.success(
        `${t("episode.workbench.batch.aiDetectSuccess", {
          beats: total_beats,
          ids: total_identities,
          props: total_props,
        })}\n${reviewMessage}`,
        { id: toastId },
      );
    } catch (error) {
      toast.error(backendErrorToastMessage(error, t), { id: toastId });
    }
  };
  const handleReassignColors = async () => {
    try {
      const res = await assignColors.mutateAsync({ force: true });
      if (!res.ok) {
        toast.error(res.error ?? t("common.error"));
        return;
      }
      toast.success(
        t("episode.workbench.batch.reassignColorsSuccess", {
          count: res.data.count,
          propCount: res.data.prop_count ?? 0,
        }),
      );
    } catch {
      toast.error(t("common.error"));
    }
  };

  return (
    <div className="flex h-full w-full items-center px-3">
      <div
        role="toolbar"
        aria-label={t("episode.workbench.batch.toolbar", "生成工具栏")}
        className="flex w-full min-w-0 flex-wrap items-center justify-center gap-x-7 gap-y-1.5"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-5">
          <SketchModelSelect project={project} />
          <RenderModelSelect project={project} />
          <SketchAspectCheckbox
            aspectRatio={sketchAspectRatio}
            onAspectRatioChange={onSketchAspectRatioChange}
            flat
          />
        </div>

        <span className="hidden h-5 w-px shrink-0 bg-border/75 lg:block" aria-hidden />

        <div className="flex min-w-0 flex-wrap items-center gap-4">
          {showGlobalOptimize && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => askConfirm(t("episode.workbench.batch.aiOptimizeTitle"), t("episode.workbench.batch.aiOptimizeDesc"), handleGlobalOptimize)}
              disabled={globalOptimize.isPending || globalOptimizeTask.started}
              className={TOOLBAR_CONTROL_CLASS}
            >
              {globalOptimize.isPending || globalOptimizeTask.started ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              {t("episode.workbench.batch.aiOptimize")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void handleAiDetect()}
            disabled={detectIdentities.isPending}
            className={TOOLBAR_CONTROL_CLASS}
            title={t("episode.workbench.batch.aiDetectTooltip")}
          >
            {detectIdentities.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Wand2 className="size-3.5" />
            )}
            {t("episode.workbench.batch.aiDetect")}
            <CreditCostInline display={detectIdentitiesCostDisplay} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              askConfirm(
                t("episode.workbench.batch.reassignColorsTitle"),
                t("episode.workbench.batch.reassignColorsDesc"),
                () => void handleReassignColors(),
              )
            }
            disabled={assignColors.isPending}
            className={TOOLBAR_CONTROL_CLASS}
            title={t("episode.workbench.batch.reassignColorsTooltip")}
          >
            {assignColors.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Palette className="size-3.5" />
            )}
            {t("episode.workbench.batch.reassignColors")}
          </Button>
          {/* 精品剧 (spine_template === "drama") 把解说烘进渲染视频，没有独立音频阶段 —— 隐藏「生成全集音频」 */}
          {spineTemplate !== "drama" && (
          <Tooltip>
            <TooltipTrigger
              delay={150}
              closeDelay={150}
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (audioUnavailableForVideoBackend) return;
                    askConfirm(
                      t("episode.workbench.batch.genAudioTitle"),
                      t("episode.workbench.batch.genAudioDesc"),
                      handleGenAllAudio,
                      "episodeAudio",
                    );
                  }}
                  disabled={!audioUnavailableForVideoBackend && (audioTask.started || generateAudio.isPending)}
                  aria-disabled={audioUnavailableForVideoBackend}
                  className={cn(
                    TOOLBAR_CONTROL_CLASS,
                    audioUnavailableForVideoBackend &&
                      "cursor-not-allowed border-white/[0.06] text-muted-foreground/45 hover:border-white/[0.06] hover:bg-transparent hover:text-muted-foreground/45",
                  )}
                />
              }
            >
              {generateAudio.isPending || audioTask.started ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Mic2 className="size-3.5" />
              )}
              {t("episode.workbench.batch.genAudio")}
              <span aria-hidden="true" className="inline-flex min-w-7 justify-start">
                <CreditCostPill
                  display={episodeAudioCostDisplay}
                  disabled={audioUnavailableForVideoBackend}
                  className="h-4 bg-transparent px-0 text-[11px]"
                />
              </span>
            </TooltipTrigger>
            {audioUnavailableForVideoBackend && (
              <TooltipContent
                side="bottom"
                sideOffset={8}
                showArrow={false}
                className="border border-white/10 bg-background/95 text-foreground shadow-none"
              >
                {t("episode.workbench.batch.genAudioUnavailableForVideoModel")}
              </TooltipContent>
            )}
          </Tooltip>
          )}
        </div>
      </div>

      {/* Confirmation dialog for episode-level actions */}
      <AlertDialog open={confirm !== null} onOpenChange={(v) => !v && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant={confirmCostDisplay ? "outline" : undefined}
              onClick={() => {
                confirm?.onConfirm();
                setConfirm(null);
              }}
              className={cn(
                confirmCostDisplay &&
                  "relative border-[3px] border-[#007A87] bg-transparent pr-9 transition-transform hover:border-[#007A87] hover:bg-transparent active:scale-95 dark:border-[#007A87] dark:hover:border-[#007A87]",
              )}
            >
              {t("common.confirmExecute")}
              <CreditCostInline display={confirmCostDisplay} />
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Error dialog — prerequisite / validation failures from the BE */}
      <AlertDialog
        open={errorDialog !== null}
        onOpenChange={(v) => !v && setErrorDialog(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{errorDialog?.title}</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">
              {errorDialog?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setErrorDialog(null)}>
              {t("common.ok", "OK")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
