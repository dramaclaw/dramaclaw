// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "lucide-react";

import { useRegenerateBeatAudio } from "@/lib/queries/audio";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { resolveMediaUrl } from "@/lib/media-url";
import { CreditCostInline } from "@/components/credit-cost-inline";
import {
  backendErrorToastMessage,
  BillingRuleNotConfiguredError,
} from "@/lib/api-errors";
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
import { useTaskController } from "@/hooks/use-task-controller";
import { queryKeys } from "@/lib/query-keys";
import { TASK_TYPES } from "@/lib/task-types";
import type { BeatStageState } from "@/types/beat-state";
import type { Beat } from "@/types/episode";
import { MEDIA_PRIMARY_ACTION_BUTTON_CLASS } from "./media-styles";

interface AudioPaneProps {
  beat: Beat;
  project: string;
  episode: number;
  state: BeatStageState;
  spineTemplate?: "drama" | "narrated";
}

type VoiceConfigTarget = "characters" | "voices";

const ASSET_TAB_STORAGE_KEY_PREFIX = "supertale-asset-tab:";
const BEAT_AUDIO_GENERATION_FEATURE_KEY = "mainline.beat_audio_generation";

function assetTabStorageKey(project: string): string {
  return `${ASSET_TAB_STORAGE_KEY_PREFIX}${encodeURIComponent(project)}`;
}

function audioPrereqTarget(error: string): VoiceConfigTarget | null {
  const message = String(error || "").trim();
  if (!message.includes("解说声线缺失")) return null;
  if (message.includes("解说主角") || message.includes("角色工作台")) return "characters";
  return "voices";
}

function audioPrereqMessage(error: string, t: (key: string) => string): string {
  const message = String(error || "").trim();
  if (!message.includes("解说声线缺失")) return message;
  if (message.includes("解说主角") || message.includes("角色工作台")) {
    return `${message}${t("episode.workbench.audio.prereqHintCharacters")}`;
  }
  return `${message}${t("episode.workbench.audio.prereqHintVoices")}`;
}

/** 音频 sub-tab — per-beat IndexTTS2 task dispatch and playback. */
export function AudioPane({
  beat,
  project,
  episode,
  state,
}: AudioPaneProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const regenerate = useRegenerateBeatAudio(project, episode);
  const audioCost = useGenerationCreditCost(
    "feature",
    BEAT_AUDIO_GENERATION_FEATURE_KEY,
    { quantity: 1 },
  );
  const audioCostDisplay =
    audioCost.data?.data.display ??
    (audioCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);
  const audioTask = useTaskController({
    key: { taskType: TASK_TYPES.AUDIO_GENERATION_INDEXTTS2, project, episode },
    alsoReconcile: [TASK_TYPES.AUDIO_GENERATION],
    invalidateKeys: [
      queryKeys.beats(project, episode),
      queryKeys.pipelineStatus(project),
    ],
  });

  const [regenConfirm, setRegenConfirm] = useState(false);

  const narration = beat.narration_segment ?? "";
  const narrationEmpty = narration.trim() === "";
  const src = beat.audio_url ? resolveMediaUrl(beat.audio_url) : null;

  const showAudioError = (error: string) => {
    const target = audioPrereqTarget(error);
    const message = audioPrereqMessage(error, t);
    if (!target) {
      toast.error(message);
      return;
    }
    toast.error(message, {
      action: {
        label: t("episode.workbench.audio.configureVoiceAction"),
        onClick: () => {
          window.localStorage.setItem(assetTabStorageKey(project), target);
          navigate({
            to: "/projects/$project/characters",
            params: { project },
          });
        },
      },
    });
  };

  const handleRegen = async () => {
    try {
      const res = await regenerate.mutateAsync(beat.beat_number);
      if (res.ok === false) {
        showAudioError(res.error || t("episode.workbench.audio.regenFailed"));
        return;
      }
      audioTask.start({ scope: res.scope });
      toast.success(t("episode.workbench.audio.regenerated", { n: beat.beat_number }));
    } catch (error) {
      toast.error(backendErrorToastMessage(error, t));
    }
  };

  return (
    <div className="flex w-full flex-col items-start gap-3">
      {narrationEmpty ? (
        <p className="px-1 py-0.5 text-xs leading-5 text-muted-foreground/72">
          {t("episode.workbench.audio.narrationEmpty")}
        </p>
      ) : (
        <div className="flex w-full max-w-[420px] flex-col items-start gap-3">
          {src ? (
            <audio
              src={src}
              controls
              className="h-7 w-full rounded-full opacity-85 [color-scheme:dark]"
            />
          ) : (
            <div className="flex h-7 w-full items-center rounded-[7px] border border-dashed border-white/[0.075] bg-white/[0.018] px-2.5 text-xs text-muted-foreground/72">
              {state === "generating"
                ? t("episode.workbench.audio.generating")
                : state === "failed"
                  ? `⚠ ${t("episode.workbench.audio.genFailed")}`
                  : t("episode.workbench.audio.notGenerated")}
            </div>
          )}
          <Button
            size="xs"
            variant="outline"
            onClick={() => setRegenConfirm(true)}
            disabled={regenerate.isPending || audioTask.started}
            className={MEDIA_PRIMARY_ACTION_BUTTON_CLASS}
          >
            {regenerate.isPending || audioTask.started ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {t("common.regenerate")}
            <CreditCostInline display={audioCostDisplay} />
          </Button>
        </div>
      )}

      <AlertDialog open={regenConfirm} onOpenChange={setRegenConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("episode.workbench.audio.regenTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("episode.workbench.audio.regenDesc", { n: beat.beat_number })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setRegenConfirm(false); handleRegen(); }}>{t("common.confirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
