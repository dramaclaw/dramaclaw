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
  useGenerateQwenEditPrompt,
  useRenderReview,
  type QwenEditPrompts,
  type RenderReviewData,
} from "@/lib/queries/sketches";
import {
  useRunpodWorkerStatus,
  useStartRunpodWorker,
} from "@/lib/queries/runpod-worker";

export interface RenderReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: string;
  episode: number;
  beatNum: number;
  imageGenerationSelection?: string;
  /** Called when the user clicks Confirm. The caller (render-section.tsx)
   * does the actual regenerate.mutateAsync + task tracking, exactly as it
   * does for every other image selection. */
  onConfirm: (overrides: {
    qwenEditPrompts: QwenEditPrompts;
    reviewFingerprint: string;
  }) => void;
}

/**
 * Dev-only review/confirm dialog for the `runpod_qwen_edit_render` /
 * `_render_multi` image selections — mirrors `VideoReviewDialog` for the
 * same reason: a RunPod Qwen-Image-Edit-2511 render takes ~10 minutes of
 * GPU time (single character) or ~10×(1+N) minutes (multi-character), too
 * expensive to spend blind on a sketch/reference mismatch or an
 * off-standard prompt. Goes through a read-only `/render/review` dry run
 * first, with an optional AI rewrite that follows Qwen-Image-Edit-2511's
 * own official "Edit Prompt Enhancer" prompt standard.
 */
export function RenderReviewDialog({
  open,
  onOpenChange,
  project,
  episode,
  beatNum,
  imageGenerationSelection,
  onConfirm,
}: RenderReviewDialogProps) {
  const { t } = useTranslation();
  const reviewMutation = useRenderReview(project, episode);
  const aiRewriteMutation = useGenerateQwenEditPrompt(project, episode);
  const workerStatus = useRunpodWorkerStatus(open);
  const startWorker = useStartRunpodWorker();

  const [fullPrompt, setFullPrompt] = useState("");
  const [scenePrompt, setScenePrompt] = useState("");
  const [inpaintPrompts, setInpaintPrompts] = useState<Record<string, string>>({});
  // Mirrors VideoReviewDialog's promptSeededRef — only seed the editable
  // text from the review response once per dialog-open (or once after a
  // successful AI rewrite), never on every background refetch.
  const promptSeededRef = useRef(false);

  const fetchReview = (promptOverride?: QwenEditPrompts) => {
    reviewMutation.mutate({
      beatNum,
      imageGenerationSelection,
      qwenEditPrompts: promptOverride,
    });
  };

  useEffect(() => {
    promptSeededRef.current = false;
    if (!open) return;
    fetchReview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, beatNum]);

  const reviewData = reviewMutation.data;
  const review: RenderReviewData | null =
    reviewData?.ok === true && reviewData.supported === true ? reviewData : null;
  const unsupported = reviewData?.ok === true && reviewData.supported === false;
  const reviewError = reviewData?.ok === false ? reviewData.error : null;
  const isMulti = review?.mode === "multi";

  useEffect(() => {
    if (!open || promptSeededRef.current || !review) return;
    setFullPrompt(review.prompts.full_prompt ?? "");
    setScenePrompt(review.prompts.scene_prompt ?? "");
    setInpaintPrompts(
      Object.fromEntries(
        (review.prompts.identities ?? []).map((i) => [i.identity_id, i.inpaint_prompt]),
      ),
    );
    promptSeededRef.current = true;
  }, [open, review]);

  const currentOverride = (): QwenEditPrompts =>
    isMulti
      ? { scene_prompt: scenePrompt, inpaint_prompts: inpaintPrompts }
      : { full_prompt: fullPrompt };

  const handleAiRewrite = async () => {
    try {
      const res = await aiRewriteMutation.mutateAsync({ beatNum, imageGenerationSelection });
      if (!res.ok) {
        toast.error(res.error || t("episode.workbench.renderReview.reviewFailed"));
        return;
      }
      const nextOverride: QwenEditPrompts = {};
      if (res.prompts.full_prompt !== undefined) {
        setFullPrompt(res.prompts.full_prompt);
        nextOverride.full_prompt = res.prompts.full_prompt;
      }
      if (res.prompts.scene_prompt !== undefined) {
        setScenePrompt(res.prompts.scene_prompt);
        nextOverride.scene_prompt = res.prompts.scene_prompt;
      }
      if (res.prompts.identities) {
        const nextInpaint = Object.fromEntries(
          res.prompts.identities.map((i) => [i.identity_id, i.inpaint_prompt]),
        );
        setInpaintPrompts(nextInpaint);
        nextOverride.inpaint_prompts = nextInpaint;
      }
      promptSeededRef.current = true;
      toast.success(
        t("episode.workbench.renderReview.aiRewriteSuccess", {
          count: res.lint?.length ?? 0,
        }),
      );
      fetchReview(nextOverride);
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
      qwenEditPrompts: currentOverride(),
      reviewFingerprint: review.input_fingerprint,
    });
  };

  const loading = reviewMutation.isPending && !review && !unsupported;
  const lintErrors = review?.lint.filter((item) => item.severity === "error") ?? [];
  const lintWarnings = review?.lint.filter((item) => item.severity === "warning") ?? [];
  const sketchSrc = review?.sketch_url ? resolveMediaUrl(review.sketch_url) : null;
  const workerData = workerStatus.data?.data;
  const workerOff = Boolean(workerData && workerData.configured && !workerData.running);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(GLASS_DIALOG_CONTENT_CLASS, "ring-white/10 sm:max-w-3xl")}>
        <DialogHeader>
          <DialogTitle>
            {t("episode.workbench.renderReview.title", {
              model: review?.model_label ?? "Qwen-Image-Edit-2511",
            })}
          </DialogTitle>
        </DialogHeader>

        <div className="grid max-h-[70vh] gap-4 overflow-y-auto pr-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("episode.workbench.renderReview.loading")}
            </div>
          ) : unsupported ? (
            <div className="rounded-[8px] border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
              {t("episode.workbench.renderReview.unsupported")}
            </div>
          ) : reviewError ? (
            <div className="rounded-[8px] border border-destructive/35 bg-destructive/[0.08] p-3 text-xs text-destructive">
              {reviewError}
            </div>
          ) : reviewMutation.isError ? (
            <div className="rounded-[8px] border border-destructive/35 bg-destructive/[0.08] p-3 text-xs text-destructive">
              {backendErrorToastMessage(reviewMutation.error, t)}
            </div>
          ) : review ? (
            <>
              {workerOff && (
                <div className="flex items-center justify-between gap-3 rounded-[8px] border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  <span className="inline-flex items-center gap-1.5">
                    <AlertTriangle className="size-3.5" />
                    {t("episode.workbench.renderReview.workerOff")}
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
                    {t("episode.workbench.renderReview.startWorker")}
                  </Button>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-[8px] border border-white/[0.075] bg-white/[0.02] sm:w-[160px]">
                  {sketchSrc ? (
                    <img src={sketchSrc} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <ImageIcon className="size-6 text-muted-foreground/60" />
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
                  <SummaryField
                    label={t("episode.workbench.renderReview.modeLabel")}
                    value={review.mode}
                  />
                  <SummaryField
                    label={t("episode.workbench.renderReview.selectionLabel")}
                    value={review.selection}
                  />
                  <SummaryField
                    label={t("episode.workbench.renderReview.estimateLabel")}
                    value={t("episode.workbench.renderReview.estimateValue", {
                      minutes: review.estimate_minutes,
                    })}
                  />
                </div>
              </div>

              {!isMulti && (
                <>
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("episode.workbench.renderReview.referencesHeader")}
                    </span>
                    <ReferenceStrip references={review.references} />
                  </div>
                  <PromptField
                    label={t("episode.workbench.renderReview.promptLabel")}
                    value={fullPrompt}
                    onChange={setFullPrompt}
                    onAiRewrite={() => void handleAiRewrite()}
                    aiPending={aiRewriteMutation.isPending}
                    modelLabel={review.model_label}
                    t={t}
                  />
                </>
              )}

              {isMulti && (
                <>
                  <PromptField
                    label={t("episode.workbench.renderReview.scenePromptLabel")}
                    value={scenePrompt}
                    onChange={setScenePrompt}
                    onAiRewrite={() => void handleAiRewrite()}
                    aiPending={aiRewriteMutation.isPending}
                    modelLabel={review.model_label}
                    t={t}
                  />
                  <div className="space-y-3">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("episode.workbench.renderReview.identitiesHeader")}
                    </span>
                    {(review.prompts.identities ?? []).map((identity) => {
                      const portraitSrc = identity.portrait_url
                        ? resolveMediaUrl(identity.portrait_url)
                        : null;
                      const maskSrc = identity.mask_preview_url
                        ? resolveMediaUrl(identity.mask_preview_url)
                        : null;
                      return (
                        <div
                          key={identity.identity_id}
                          className="space-y-1.5 rounded-[8px] border border-white/[0.075] bg-white/[0.012] p-2.5"
                        >
                          <div className="flex items-center gap-2">
                            <div className="relative size-10 shrink-0 overflow-hidden rounded-[6px] border border-white/[0.075] bg-white/[0.02]">
                              {portraitSrc ? (
                                <img
                                  src={portraitSrc}
                                  alt={identity.name}
                                  className="absolute inset-0 h-full w-full object-cover"
                                />
                              ) : (
                                <ImageIcon className="absolute inset-0 m-auto size-4 text-muted-foreground/60" />
                              )}
                            </div>
                            <span className="text-xs font-medium">{identity.name}</span>
                            {identity.mask_missing && (
                              <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                                <AlertTriangle className="size-3" />
                                {t("episode.workbench.renderReview.maskMissing")}
                              </span>
                            )}
                          </div>
                          {maskSrc && (
                            <img
                              src={maskSrc}
                              alt=""
                              className="max-h-32 w-auto rounded-[6px] border border-white/[0.075] object-contain"
                            />
                          )}
                          <Textarea
                            value={inpaintPrompts[identity.identity_id] ?? ""}
                            onChange={(e) =>
                              setInpaintPrompts((prev) => ({
                                ...prev,
                                [identity.identity_id]: e.target.value,
                              }))
                            }
                            rows={3}
                            className="resize-none text-sm"
                          />
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {lintErrors.length > 0 && (
                <div className="space-y-1">
                  <span className="text-xs font-medium text-destructive">
                    {t("episode.workbench.renderReview.lintErrorsHeader")}
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
                    {t("episode.workbench.renderReview.lintWarningsHeader")}
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
            {t("episode.workbench.renderReview.cancel")}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={loading || !review || lintErrors.length > 0}
          >
            {t("episode.workbench.renderReview.confirm")}
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

function ReferenceStrip({
  references,
}: {
  references: RenderReviewData["references"];
}) {
  if (references.length === 0) return null;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,6.5rem))] gap-2">
      {references.map((ref, i) => {
        const refSrc = ref.path ? resolveMediaUrl(ref.path) : null;
        return (
          <div
            key={`${ref.identity_id}:${i}`}
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
                <ImageIcon className="absolute inset-0 m-auto size-4 text-muted-foreground/60" />
              )}
            </div>
            <div className="px-1.5 py-1">
              <div className="truncate text-[10px] font-medium">{ref.name}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PromptField({
  label,
  value,
  onChange,
  onAiRewrite,
  aiPending,
  modelLabel,
  t,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onAiRewrite: () => void;
  aiPending: boolean;
  modelLabel: string;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Button type="button" size="xs" variant="outline" onClick={onAiRewrite} disabled={aiPending}>
          {aiPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <WandSparkles className="size-3" />
          )}
          {aiPending
            ? t("episode.workbench.renderReview.aiRewriting")
            : t("episode.workbench.renderReview.aiRewrite", { model: modelLabel })}
        </Button>
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={5}
        className="resize-none text-sm"
      />
    </div>
  );
}
