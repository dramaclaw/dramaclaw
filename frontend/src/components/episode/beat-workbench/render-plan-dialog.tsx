// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueries } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";

import { api } from "@/lib/api";
import {
  backendErrorToastMessage,
  BackendStatusError,
  BillingRuleNotConfiguredError,
  jsonWithBackendError,
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
import { GLASS_ALERT_DIALOG_CONTENT_CLASS } from "@/lib/dialog-styles";
import { cn } from "@/lib/utils";
import { CreditCostInline } from "@/components/credit-cost-inline";
import { formatCreditCost } from "@/components/credits/credit-visual";
import {
  generationCreditCostQueryKey,
  type GenerationCreditCost,
} from "@/lib/queries/generation-credit-cost";
import {
  useRenderExecute,
  useRenderPlan,
} from "@/lib/queries/render-plan";
import { useRenderSettings } from "@/lib/queries/render-settings";
import type { OkResponse } from "@/types/api";
import type { PlanEntry, RenderPlan } from "@/types/render-plan";

const RENDER_REGEN_FEATURE_KEY = "mainline.render_regen";

interface RenderPlanDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  project: string;
  episode: number;
  beatIndices: number[];
  aspectMode: string;
  defaultForceOneByOne?: boolean;
  /**
   * Invoked after a successful execute with the per-grid `selected_regen` task
   * ids (one execute fans out into N grid tasks). Track these for completion —
   * the response's umbrella `scope` matches no task row.
   */
  onDispatched: (taskIds: string[]) => void;
}

export function RenderPlanDialog({
  open,
  onOpenChange,
  project,
  episode,
  beatIndices,
  aspectMode,
  defaultForceOneByOne = false,
  onDispatched,
}: RenderPlanDialogProps) {
  const { t } = useTranslation();
  const planMutation = useRenderPlan(project, episode);
  const executeMutation = useRenderExecute(project, episode);
  const renderSettings = useRenderSettings(project);
  const [plan, setPlan] = useState<RenderPlan | null>(null);
  const [staleBanner, setStaleBanner] = useState<"input" | "plan" | null>(null);
  const renderImageSelection = renderSettings.data?.data.render_image_selection ?? null;
  const renderCostModeKeys = useMemo(
    () => [...new Set((plan?.plan ?? []).map((entry) => entry.mode_key).filter(Boolean))],
    [plan?.plan],
  );
  const renderCostQueries = useQueries({
    queries: renderCostModeKeys.map((modeKey) => ({
      queryKey: generationCreditCostQueryKey("feature", RENDER_REGEN_FEATURE_KEY, {
        surface: "supertale",
        modeKey,
        imageRole: "render",
        params: renderImageSelection ? { image_selection: renderImageSelection } : null,
      }),
      queryFn: () =>
        jsonWithBackendError<OkResponse<GenerationCreditCost>>(
          api.get("api/v1/generation-credit-cost", {
            searchParams: {
              kind: "feature",
              surface: "supertale",
              value: RENDER_REGEN_FEATURE_KEY,
              mode_key: modeKey,
              image_role: "render",
              ...(renderImageSelection
                ? { params: JSON.stringify({ image_selection: renderImageSelection }) }
                : {}),
            },
            throwHttpErrors: false,
          }),
        ),
      enabled: !!renderImageSelection,
      staleTime: 60_000,
    })),
  });

  // Fetch plan when dialog opens or force toggle changes.
  useEffect(() => {
    if (!open) return;
    setPlan(null);
    setStaleBanner(null);
    planMutation.mutate(
      {
        beat_indices: beatIndices,
        strategy: "location",
        aspect_mode: aspectMode,
        force_one_by_one: defaultForceOneByOne,
      },
      {
        onSuccess: (res) => {
          if (!res.ok) {
            toast.error(res.error || t("common.error"));
            setPlan(null);
            onOpenChange(false);
            return;
          }
          if (!res.data) {
            toast.error(t("common.error"));
            setPlan(null);
            onOpenChange(false);
            return;
          }
          setPlan(res.data);
          setStaleBanner(null);
        },
        onError: async (err) => {
          const anyErr = err as {
            response?: { status?: number; json?: () => Promise<unknown> };
          };
          const status = anyErr?.response?.status;
          if (status === 400 && anyErr.response?.json) {
            const body = (await anyErr.response.json()) as {
              error?: string;
            };
            const code = body?.error ?? "unknown";
            const msg =
              code === "invalid_beats"
                ? t("episode.renderPlan.errors.invalidBeats")
                : code === "no_beats"
                  ? t("episode.renderPlan.errors.noBeats")
                  : code || t("common.error");
            toast.error(msg);
            onOpenChange(false);
            return;
          }
          if (status === 503) {
            toast.error(t("episode.renderPlan.featureDisabled"));
            onOpenChange(false);
            return;
          }
          toast.error(t("common.error"));
          onOpenChange(false);
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultForceOneByOne, beatIndices, aspectMode, project, episode]);

  const handleConfirm = async () => {
    if (!plan) return;
    try {
      const res = await executeMutation.mutateAsync({
        plan: plan.plan,
        plan_hash: plan.plan_hash,
        input_fingerprint: plan.input_fingerprint,
        strategy: "location",
        aspect_mode: aspectMode,
        beat_indices: beatIndices,
        force_one_by_one: defaultForceOneByOne,
        image_generation_selection: renderImageSelection ?? undefined,
      });
      if (!res.ok) {
        toast.error(t("common.error"));
        return;
      }
      onDispatched(res.data.task_ids ?? []);
      onOpenChange(false);
    } catch (err) {
      const anyErr = err as { response?: { status?: number; json?: () => Promise<unknown> } };
      const status = err instanceof BackendStatusError
        ? err.status
        : anyErr?.response?.status;
      const body = err instanceof BackendStatusError
        ? err.body
        : anyErr?.response?.json
          ? await anyErr.response.json()
          : null;
      if (status === 409 && body && typeof body === "object") {
        const staleBody = body as {
          error: "input_stale" | "plan_stale";
          data: { new_plan: PlanEntry[]; new_plan_hash: string; new_input_fingerprint: string };
        };
        if (
          (staleBody.error === "input_stale" || staleBody.error === "plan_stale") &&
          staleBody.data?.new_plan
        ) {
          setStaleBanner(staleBody.error === "input_stale" ? "input" : "plan");
          setPlan({
            plan: staleBody.data.new_plan,
            plan_hash: staleBody.data.new_plan_hash,
            input_fingerprint: staleBody.data.new_input_fingerprint,
            strategy: "location",
            total_beats: beatIndices.length,
            total_grids: staleBody.data.new_plan.length,
          });
          return;
        }
        toast.error(backendErrorToastMessage(err, t));
      } else if (status === 503) {
        toast.error(t("episode.renderPlan.featureDisabled"));
        onOpenChange(false);
      } else {
        toast.error(backendErrorToastMessage(err, t));
      }
    }
  };

  const loading = planMutation.isPending || executeMutation.isPending;
  const confirmLabel = plan
    ? t("episode.renderPlan.confirm", { grids: plan.total_grids })
    : planMutation.isPending
      ? t("episode.renderPlan.planning")
      : t("episode.renderPlan.unavailable");
  let renderPlanCostDisplay: string | null = null;
  if (plan) {
    let complete = true;
    let missingRule = false;
    let totalCost = 0;
    for (const entry of plan.plan) {
      const queryIndex = renderCostModeKeys.indexOf(entry.mode_key);
      const query = renderCostQueries[queryIndex];
      if (query?.error instanceof BillingRuleNotConfiguredError) {
        missingRule = true;
        break;
      }
      const cost = query?.data?.data.cost;
      if (typeof cost !== "number") {
        complete = false;
        break;
      }
      totalCost += cost;
    }
    renderPlanCostDisplay = missingRule
      ? t("common.billingRuleNotConfiguredShort")
      : complete
        ? formatCreditCost(totalCost)
        : null;
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={cn("max-w-3xl", GLASS_ALERT_DIALOG_CONTENT_CLASS)}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("episode.renderPlan.title", {
              beats: plan?.total_beats ?? beatIndices.length,
              grids: plan?.total_grids ?? "…",
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("episode.renderPlan.subtitle")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {staleBanner && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mr-1 inline size-3" />
            {t(`episode.renderPlan.stale.${staleBanner}`)}
          </div>
        )}

        <div className="mt-4 max-h-[45vh] overflow-y-auto">
          {loading && !plan ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : !plan ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              {t("episode.renderPlan.unavailable")}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {plan?.plan.map((entry, i) => (
                <PlanCard
                  key={`${entry.mode_key}:${entry.beat_numbers.join("-")}:${i}`}
                  entry={entry}
                />
              ))}
            </div>
          )}
        </div>

        <AlertDialogFooter className="px-4">
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            onClick={handleConfirm}
            disabled={loading || !plan}
            className="relative pr-11 transition-transform active:scale-95"
          >
            {executeMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              confirmLabel
            )}
            <CreditCostInline display={renderPlanCostDisplay} />
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PlanCard({
  entry,
}: {
  entry: PlanEntry;
}) {
  const { t } = useTranslation();
  const beatsLabel = entry.beat_numbers.length > 1
    ? `B${entry.beat_numbers[0]}-${entry.beat_numbers[entry.beat_numbers.length - 1]}`
    : `B${entry.beat_numbers[0]}`;
  const ironLaw = entry.reasons.includes("iron-law-3-chars");
  const multiScene = entry.location.includes("·") || entry.location.includes(" / ");
  return (
    <div
      className={cn(
        "flex w-[170px] shrink-0 flex-col gap-1 rounded-[6px] border border-white/10 bg-white/[0.05] p-2 text-xs backdrop-blur-sm",
        ironLaw && "border-amber-500/50",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">{`${entry.rows}×${entry.cols}`}</span>
        <span className="text-muted-foreground">{beatsLabel}</span>
      </div>
      <div
        className={cn(
          "truncate",
          multiScene ? "text-orange-400" : "text-emerald-400",
        )}
        title={entry.location}
      >
        {entry.location || t("episode.renderPlan.unknownLocation")}
        {entry.padding_count > 0 &&
          ` ${t("episode.renderPlan.paddingCount", { count: entry.padding_count })}`}
      </div>
      {entry.warnings.length > 0 && (
        <div className="text-amber-500">
          <AlertTriangle className="mr-0.5 inline size-2.5" />
          {entry.warnings[0]}
        </div>
      )}
    </div>
  );
}
