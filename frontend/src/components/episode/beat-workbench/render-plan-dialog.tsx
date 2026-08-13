// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { skipToken, useQueries, useQuery } from "@tanstack/react-query";
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
import { queryKeys } from "@/lib/query-keys";
import type { OkResponse } from "@/types/api";
import type {
  PlanEntry,
  RejectedDispatch,
  RenderExecuteResult,
  RenderPlan,
} from "@/types/render-plan";
import type { Task, TaskStatus } from "@/types/task";

const RENDER_REGEN_FEATURE_KEY = "mainline.render_regen";

/** Same set `useTasks` uses to decide its 2s poll cadence (`queries/tasks.ts:59-66`). */
const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "submitting",
  "queued",
  "pending",
  "starting",
  "running",
]);

// 文案不落 `public/locales/*`（不在本切片 ownership 内），走仓内既有的
// `t(key, { defaultValue })` 内联兜底形制（先例 `batch-panel.tsx:570-572`）。
// 三种 reason 必须是三条真的不一样的话 —— 用户能不能自己解掉，取决于撞的是
// 哪条闸：自己的任务、同渠道别人的任务、还是整个平台。
const PARTIAL_REASON_COPY: Record<
  RejectedDispatch["reason"],
  { key: string; defaultValue: string }
> = {
  channel: {
    key: "episode.renderPlan.partial.reason.channel",
    defaultValue: "渠道并发已满：剩余 {{fail}} 格要等同渠道的任务腾出位置",
  },
  platform: {
    key: "episode.renderPlan.partial.reason.platform",
    defaultValue: "平台整体并发已满：剩余 {{fail}} 格要等平台腾出位置",
  },
  user: {
    key: "episode.renderPlan.partial.reason.user",
    defaultValue: "你的并发已满：剩余 {{fail}} 格要等你自己的任务先跑完",
  },
};

/**
 * 一次尽力投递之后的残局。
 *
 * `entries` 是**被拒的 plan 条目逐字**（不是重算出来的）：后端 fanout 有序、
 * 撞闸即 break，所以被拒的必是 `resolved_grids` 的尾段，取法就是
 * `slice(task_ids.length)`（TCP-P63；在前端重算 `selection_scope` 会复制后端的
 * 哈希真源）。`shapeOk` 记住那条长度断言 —— 不成立就只报信息，不重投。
 */
interface PartialDispatchState {
  /** 本轮真的投出去了几格。 */
  ok: number;
  rejected: RejectedDispatch[];
  entries: PlanEntry[];
  /** 本轮投出去的 task id，用来从既有轮询里看「在途下降」。 */
  watchTaskIds: string[];
  /** 自动重投的那**一**轮是否已经用掉（此后只剩手动「继续」）。 */
  autoUsed: boolean;
  shapeOk: boolean;
}

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
  const [partial, setPartial] = useState<PartialDispatchState | null>(null);
  const [retrying, setRetrying] = useState(false);
  // 复用**既有**的任务轮询：`skipToken` 表示这个订阅永远不自己发请求，只订阅
  // `queryKeys.tasks(project)` 这份缓存 —— 写它的是页面上已经挂着的 `useTasks`
  // （`batch-panel.tsx:392`，本对话框正是它渲染出来的）。这样既不新起定时器，
  // 也不用把 `queries/tasks.ts` 那条 import 链（`@/i18n` / confirm-dialog）拽进来。
  const tasksCache = useQuery({
    queryKey: queryKeys.tasks(project),
    queryFn: skipToken,
  });
  const taskRows = (tasksCache.data as OkResponse<Task[]> | undefined)?.data;
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
    setPartial(null);
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

  /**
   * 消化一次 execute 的结果。`allowAuto` 只在**第一轮**为真 —— 自动重投至多一轮，
   * 之后一律退回手动「继续」（任务书三条不许自由发挥的第 3 条）。
   */
  const applyExecuteResult = (data: RenderExecuteResult, allowAuto: boolean) => {
    const taskIds = data.task_ids ?? [];
    const rejected = data.rejected ?? [];
    onDispatched(taskIds);
    if (rejected.length === 0) {
      setPartial(null);
      onOpenChange(false);
      return;
    }
    const grids = data.resolved_grids ?? [];
    const entries = grids.slice(taskIds.length);
    setPartial({
      ok: taskIds.length,
      rejected,
      entries,
      watchTaskIds: taskIds,
      autoUsed: !allowAuto,
      // 尾段长度对不上就说明「有序 + break」这个前提不成立了，宁可不投：
      // 猜错会重复投递已经在跑的格子（= 双计费）。
      shapeOk: entries.length > 0 && entries.length === rejected.length,
    });
  };

  /**
   * 只重投被拒的那部分，两步：
   *  1. `/render/plan` 带**恰好是**被拒条目 beats 并集的 `beat_indices`，拿一份新的
   *     `input_fingerprint`（多一个少一个都会被后端 `_custom_render_plan_error` 判
   *     400 `invalid_custom_plan`）。
   *  2. `/render/execute` 带 `custom_plan: true` ＋ 逐字的被拒条目。`custom_plan`
   *     分支不重新分组，每格的 `entry_scope` 才会与被拒的那次逐字相同；走重算分支
   *     会把子集重新编组，格子与任何一条被拒 scope 都对不上。
   */
  const redispatch = async (state: PartialDispatchState) => {
    if (!state.shapeOk || retrying) return;
    const beats = [
      ...new Set(state.entries.flatMap((entry) => entry.beat_numbers)),
    ].sort((a, b) => a - b);
    const giveUp = () => setPartial({ ...state, autoUsed: true });
    setRetrying(true);
    try {
      const planRes = await planMutation.mutateAsync({
        beat_indices: beats,
        strategy: "location",
        aspect_mode: aspectMode,
        force_one_by_one: defaultForceOneByOne,
      });
      if (!planRes.ok || !planRes.data) {
        toast.error(t("common.error"));
        giveUp();
        return;
      }
      const res = await executeMutation.mutateAsync({
        plan: state.entries,
        plan_hash: planRes.data.plan_hash,
        input_fingerprint: planRes.data.input_fingerprint,
        strategy: "location",
        aspect_mode: aspectMode,
        beat_indices: beats,
        custom_plan: true,
        force_one_by_one: defaultForceOneByOne,
        image_generation_selection: renderImageSelection ?? undefined,
      });
      if (!res.ok) {
        toast.error(t("common.error"));
        giveUp();
        return;
      }
      applyExecuteResult(res.data, false);
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
      giveUp();
    } finally {
      setRetrying(false);
    }
  };

  // 自动重投的触发器：**复用既有轮询**，看本轮投出去的任务是否已全部离开在途。
  useEffect(() => {
    if (!open || retrying) return;
    if (!partial || partial.autoUsed || !partial.shapeOk) return;
    if (partial.watchTaskIds.length === 0 || !taskRows) return;
    const byId = new Map<string, TaskStatus>();
    for (const row of taskRows) {
      if (row.task_id) byId.set(row.task_id, row.status);
    }
    // 「至少见过一次」守卫：轮询还没把这批任务带回来时不下判断。宁可不自动投
    // （用户还有「继续」兜底），也不能把「没见到」误读成「已经跑完」。
    if (!partial.watchTaskIds.every((id) => byId.has(id))) return;
    if (partial.watchTaskIds.some((id) => ACTIVE_TASK_STATUSES.has(byId.get(id)!))) return;
    const snapshot = { ...partial, autoUsed: true };
    setPartial(snapshot);
    void redispatch(snapshot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, retrying, partial, taskRows]);

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
      applyExecuteResult(res.data, true);
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
  const partialReasonLines = useMemo(() => {
    if (!partial) return [];
    const reasons = [...new Set(partial.rejected.map((item) => item.reason))];
    return reasons.map((reason) => {
      const fail = partial.rejected.filter((item) => item.reason === reason).length;
      const copy = PARTIAL_REASON_COPY[reason];
      if (!copy) return t("common.error");
      return t(copy.key, { defaultValue: copy.defaultValue, fail });
    });
  }, [partial, t]);
  const confirmLabel = plan
    ? t("episode.renderPlan.confirm", { grids: plan.total_grids })
    : planMutation.isPending
      ? t("episode.renderPlan.planning")
      : t("episode.renderPlan.unavailable");
  let renderPlanCostDisplay: string | null = null;
  let renderPlanPromotion: GenerationCreditCost["promotion"];
  if (plan) {
    let complete = true;
    let missingRule = false;
    let totalCost = 0;
    let totalOriginalCost = 0;
    const promotions: NonNullable<GenerationCreditCost["promotion"]>[] = [];
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
      totalOriginalCost += query?.data?.data.original_cost ?? cost;
      if (query?.data?.data.promotion?.id) {
        promotions.push(query.data.data.promotion);
      }
    }
    const firstPromotion = promotions[0];
    if (
      firstPromotion
      && promotions.length === plan.plan.length
      && promotions.every((item) => item.id === firstPromotion.id)
    ) {
      renderPlanPromotion = firstPromotion;
    }
    renderPlanCostDisplay = missingRule
      ? t("common.billingRuleNotConfiguredShort")
      : complete
        ? totalOriginalCost > totalCost
          ? `${formatCreditCost(totalOriginalCost)}→${formatCreditCost(totalCost)}`
          : formatCreditCost(totalCost)
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

        {partial && (
          <div
            role="status"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          >
            <AlertTriangle className="mr-1 inline size-3" />
            {t("episode.renderPlan.partial.summary", {
              defaultValue: "已投 {{ok}} / 被拒 {{fail}}",
              ok: partial.ok,
              fail: partial.rejected.length,
            })}
            {partialReasonLines.map((line) => (
              <div key={line}>{line}</div>
            ))}
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
          {partial?.shapeOk && (
            <AlertDialogAction
              variant="outline"
              onClick={() => void redispatch(partial)}
              disabled={retrying || loading}
            >
              {t("episode.renderPlan.partial.continue", { defaultValue: "继续" })}
            </AlertDialogAction>
          )}
          <AlertDialogAction
            variant="outline"
            onClick={handleConfirm}
            // 已经部分投出去之后，主按钮必须锁死：再点一次就是整批重放
            // （前 k 个还活着 → 去重锁挡不住重复计费）。重投只能走「继续」。
            disabled={loading || !plan || !!partial}
            className="relative pr-11 transition-transform active:scale-95"
          >
            {executeMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              confirmLabel
            )}
            <CreditCostInline
              display={renderPlanCostDisplay}
              promotion={renderPlanPromotion}
            />
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
