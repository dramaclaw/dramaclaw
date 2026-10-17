// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertTriangle,
  Image as ImageIcon,
  Loader2,
  Play,
  WandSparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  GLASS_DIALOG_CONTENT_CLASS,
  TRANSPARENT_DIALOG_FOOTER_CLASS,
} from "@/lib/dialog-styles";
import { cn } from "@/lib/utils";
import { resolveMediaUrl } from "@/lib/media-url";
import { backendErrorToastMessage } from "@/lib/api-errors";
import {
  useGenerateMiniMaxH3Prompt,
  useVideoReview,
  type SingleVideoRequestBody,
} from "@/lib/queries/video";
import {
  useRunpodWorkerStatus,
  useStartRunpodWorker,
} from "@/lib/queries/runpod-worker";

export interface VideoReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: string;
  episode: number;
  beatNum: number;
  /** Request body built by the caller the same way it builds the regular
   * `/video` regen body — reused verbatim for the `/video/review` dry run,
   * then spread (with `final_prompt` + `review_fingerprint` added) into
   * `onConfirm`. */
  reviewBody: SingleVideoRequestBody;
  /** Called when the user clicks Confirm. The caller (video-pane.tsx) does
   * the actual regenerate.mutateAsync + task tracking, exactly as it does
   * today for every other backend. */
  onConfirm: (finalBody: SingleVideoRequestBody) => void;
}

/**
 * Dev-only review/confirm dialog for the `runpod_minimax_h3` video backend.
 *
 * Unlike every other backend (plain AlertDialog, confirm fires the regen
 * immediately), H3 goes through a read-only `/video/review` dry run first so
 * the user can see the resolved prompt, first frame, identity references and
 * any lint issues before actually enqueueing a generation — and optionally
 * ask the LLM to rewrite the beat into the H3 prompt format first.
 */
export function VideoReviewDialog({
  open,
  onOpenChange,
  project,
  episode,
  beatNum,
  reviewBody,
  onConfirm,
}: VideoReviewDialogProps) {
  const { t } = useTranslation();
  const reviewMutation = useVideoReview(project, episode);
  const aiRewriteMutation = useGenerateMiniMaxH3Prompt(project, episode);
  // Reuse the existing dev-only RunPod worker control (Settings → Models)
  // rather than inventing a new status endpoint/hook for this dialog.
  const workerStatus = useRunpodWorkerStatus(open);
  const startWorker = useStartRunpodWorker();

  const [editedPrompt, setEditedPrompt] = useState("");
  // Guards the textarea seed: it should only ever be set from the review's
  // `prompt` once per dialog-open (or once after a successful AI rewrite,
  // handled separately) — never on every background refetch, or the user's
  // in-progress edit would be clobbered.
  const promptSeededRef = useRef(false);

  // `reviewBody.seedance2ConfigJson` is a snapshot of the parent's local
  // draft state taken whenever `video-pane.tsx` last rendered — it does NOT
  // refresh just because `/minimax-h3-prompt/generate` saved a new prompt
  // straight to the database. The backend prefers a request-supplied
  // `seedance2_config_json`/`final_prompt` over whatever is newest in the
  // beat, so re-sending `reviewBody` unchanged after an AI rewrite would
  // silently re-lint the *old* (pre-rewrite) prompt forever, even though the
  // textarea above it already shows the new one. `promptOverride` lets a
  // caller force the review to check a specific prompt text instead of
  // whatever `reviewBody` currently snapshots.
  const fetchReview = (promptOverride?: string) => {
    reviewMutation.mutate({
      beatNum,
      body:
        promptOverride !== undefined
          ? { ...reviewBody, final_prompt: promptOverride }
          : reviewBody,
    });
  };

  useEffect(() => {
    promptSeededRef.current = false;
    if (!open) return;
    fetchReview();
    // Re-fetch only on a genuine open transition (including a re-open after
    // `input_stale`) or a beat switch — not on every render where the
    // caller hands us a structurally-equal-but-new `reviewBody` object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, beatNum]);

  const reviewData = reviewMutation.data;
  const review = reviewData?.ok === true ? reviewData : null;
  const reviewError = reviewData?.ok === false ? reviewData.error : null;

  useEffect(() => {
    if (!open || promptSeededRef.current || !review) return;
    setEditedPrompt(review.prompt);
    promptSeededRef.current = true;
  }, [open, review]);

  const handleAiRewrite = async () => {
    try {
      // Pass whatever duration the review is currently showing (itself
      // `reviewBody.duration` if the caller set one, else the beat's own
      // natural duration) so the rewritten prompt's timestamps match the
      // clip length that will actually be submitted.
      const res = await aiRewriteMutation.mutateAsync({
        beatNum,
        duration: review?.duration,
      });
      if (!res.ok) {
        toast.error(res.error || t("episode.workbench.videoReview.reviewFailed"));
        return;
      }
      setEditedPrompt(res.prompt);
      promptSeededRef.current = true;
      toast.success(
        t("episode.workbench.videoReview.aiRewriteSuccess", {
          count: res.lint?.length ?? 0,
        }),
      );
      // Re-lint against the prompt we just got back, explicitly — not the
      // stale `reviewBody` snapshot (see `fetchReview`'s comment above).
      fetchReview(res.prompt);
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handleStartWorker = async () => {
    try {
      const res = await startWorker.mutateAsync();
      if (res.ok !== true) {
        toast.error(t("common.error"));
      }
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handleConfirm = () => {
    if (!review) return;
    onOpenChange(false);
    onConfirm({
      ...reviewBody,
      final_prompt: editedPrompt,
      review_fingerprint: review.input_fingerprint,
    });
  };

  const loading = reviewMutation.isPending && !review;
  const lintErrors = review?.lint.filter((item) => item.severity === "error") ?? [];
  const lintWarnings = review?.lint.filter((item) => item.severity === "warning") ?? [];
  const frameSrc = review?.frame_path ? resolveMediaUrl(review.frame_path) : null;
  const workerData = workerStatus.data?.data;
  const workerOff = Boolean(workerData && workerData.configured && !workerData.running);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(GLASS_DIALOG_CONTENT_CLASS, "ring-white/10 sm:max-w-3xl")}>
        <DialogHeader>
          <DialogTitle>{t("episode.workbench.videoReview.title")}</DialogTitle>
        </DialogHeader>

        <div className="grid max-h-[70vh] gap-4 overflow-y-auto pr-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("episode.workbench.videoReview.loading")}
            </div>
          ) : reviewError ? (
            <div className="rounded-[8px] border border-destructive/35 bg-destructive/[0.08] p-3 text-xs text-destructive">
              {reviewError}
            </div>
          ) : reviewMutation.isError ? (
            // `/video/review` failing at the HTTP level (vs. a plain
            // `{ok:false}` body, handled above as `reviewError`) — e.g. a
            // queue-limit or auth error thrown by `jsonWithBackendError`.
            <div className="rounded-[8px] border border-destructive/35 bg-destructive/[0.08] p-3 text-xs text-destructive">
              {backendErrorToastMessage(reviewMutation.error, t)}
            </div>
          ) : review ? (
            <>
              {workerOff && (
                <div className="flex items-center justify-between gap-3 rounded-[8px] border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  <span className="inline-flex items-center gap-1.5">
                    <AlertTriangle className="size-3.5" />
                    {t("episode.workbench.videoReview.workerOff")}
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => void handleStartWorker()}
                    disabled={startWorker.isPending}
                  >
                    {startWorker.isPending ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Play className="size-3" />
                    )}
                    {t("episode.workbench.videoReview.startWorker")}
                  </Button>
                </div>
              )}

              {review.frame_missing && (
                <div className="rounded-[8px] border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="mr-1 inline size-3" />
                  {t("episode.workbench.videoReview.frameMissing")}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                <div
                  className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-[8px] border border-white/[0.075] bg-white/[0.02] sm:w-[160px]"
                  title={review.frame_path ?? undefined}
                >
                  {frameSrc ? (
                    <img src={frameSrc} alt="" className="h-full w-full object-cover" />
                  ) : review.frame_path ? (
                    <span className="break-all p-1 text-center text-[10px] text-muted-foreground">
                      {review.frame_path}
                    </span>
                  ) : (
                    <ImageIcon className="size-6 text-muted-foreground/60" />
                  )}
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
                  <SummaryField
                    label={t("episode.workbench.videoReview.backendLabel")}
                    value={review.backend}
                  />
                  <SummaryField
                    label={t("episode.workbench.videoReview.modeLabel")}
                    value={review.mode}
                  />
                  <SummaryField
                    label={t("episode.workbench.videoReview.durationLabel")}
                    value={`${review.duration}s`}
                  />
                  <SummaryField
                    label={t("episode.workbench.videoReview.ratioLabel")}
                    value={review.ratio}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("episode.workbench.videoReview.promptLabel")}
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => void handleAiRewrite()}
                    disabled={aiRewriteMutation.isPending}
                  >
                    {aiRewriteMutation.isPending ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <WandSparkles className="size-3" />
                    )}
                    {aiRewriteMutation.isPending
                      ? t("episode.workbench.videoReview.aiRewriting")
                      : t("episode.workbench.videoReview.aiRewrite")}
                  </Button>
                </div>
                <Textarea
                  value={editedPrompt}
                  onChange={(e) => setEditedPrompt(e.target.value)}
                  rows={5}
                  className="resize-none text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("episode.workbench.videoReview.referencesHeader")}
                </span>
                {review.references.length > 0 ? (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,6.5rem))] gap-2">
                    {review.references.map((ref, i) => {
                      const refSrc = ref.path ? resolveMediaUrl(ref.path) : null;
                      return (
                        <div
                          key={`${ref.tag}:${i}`}
                          className="overflow-hidden rounded-[7px] border border-white/[0.075] bg-white/[0.018]"
                          title={ref.appearance_details}
                        >
                          <div className="relative aspect-square w-full bg-white/[0.02]">
                            {refSrc ? (
                              <img
                                src={refSrc}
                                alt={ref.name}
                                className="absolute inset-0 h-full w-full object-cover"
                              />
                            ) : (
                              <div className="absolute inset-0 flex items-center justify-center p-1">
                                <span className="break-all text-center text-[9px] text-muted-foreground">
                                  {ref.path}
                                </span>
                              </div>
                            )}
                          </div>
                          <div className="px-1.5 py-1">
                            <div className="truncate text-[10px] font-medium">
                              {ref.tag} · {ref.name}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("episode.workbench.videoReview.referencesEmpty")}
                  </p>
                )}
              </div>

              {lintErrors.length > 0 && (
                <div className="space-y-1">
                  <span className="text-xs font-medium text-destructive">
                    {t("episode.workbench.videoReview.lintErrorsHeader")}
                  </span>
                  <ul className="space-y-1">
                    {lintErrors.map((item, i) => (
                      <li
                        key={`${item.code}:${i}`}
                        className="rounded-[6px] border border-destructive/35 bg-destructive/[0.08] px-2 py-1 text-xs text-destructive"
                      >
                        {item.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {lintWarnings.length > 0 && (
                <div className="space-y-1">
                  <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                    {t("episode.workbench.videoReview.lintWarningsHeader")}
                  </span>
                  <ul className="space-y-1">
                    {lintWarnings.map((item, i) => (
                      <li
                        key={`${item.code}:${i}`}
                        className="rounded-[6px] border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300"
                      >
                        {item.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : null}
        </div>

        <DialogFooter className={TRANSPARENT_DIALOG_FOOTER_CLASS}>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("episode.workbench.videoReview.cancel")}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={loading || !review || lintErrors.length > 0}
          >
            {t("episode.workbench.videoReview.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SummaryField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </div>
      <div className="truncate text-foreground">{value}</div>
    </div>
  );
}
