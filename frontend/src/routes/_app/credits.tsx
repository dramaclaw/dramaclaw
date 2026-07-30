// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Clock3, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  formatCreditPromotionLabel,
  CreditSparkIcon,
} from "@/components/credits/credit-visual";
import {
  type CreditTransaction,
  type CreditTransactionCategory,
  useCreditFilterOptions,
  useCreditPromotions,
  useCreditSummary,
  useCreditTransactions,
} from "@/lib/queries/credits";
import { isCeRuntime } from "@/lib/runtime-config";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;
const CATEGORIES: CreditTransactionCategory[] = ["all", "earned", "spent", "refunded"];

function dateBoundary(value: string, end = false): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (end) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

function formatNumber(value: number, language: string): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string | null, language: string): string {
  if (!value) return "--";
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function TransactionStatus({ item }: { item: CreditTransaction }) {
  const { t } = useTranslation();
  const tone =
    item.status === "pending"
      ? "bg-amber-400/12 text-amber-300"
      : item.status === "refunded"
        ? "bg-sky-400/12 text-sky-300"
        : "bg-emerald-400/12 text-emerald-300";
  return (
    <span className={cn("inline-flex rounded-md px-2 py-1 text-[11px] font-medium", tone)}>
      {t(`credits.status.${item.status}`)}
    </span>
  );
}

function CreditsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const language = i18n.resolvedLanguage ?? i18n.language ?? "zh";
  const [category, setCategory] = useState<CreditTransactionCategory>("all");
  const [page, setPage] = useState(1);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [projectId, setProjectId] = useState("");
  const [featureKey, setFeatureKey] = useState("");
  const [model, setModel] = useState("");
  const summaryQuery = useCreditSummary();
  const promotionQuery = useCreditPromotions();
  const filterOptionsQuery = useCreditFilterOptions();
  const filters = useMemo(
    () => ({
      category,
      page,
      pageSize: PAGE_SIZE,
      startAt: dateBoundary(startDate),
      endAt: dateBoundary(endDate, true),
      projectId: projectId || undefined,
      featureKey: featureKey || undefined,
      model: model || undefined,
    }),
    [category, endDate, featureKey, model, page, projectId, startDate],
  );
  const transactionsQuery = useCreditTransactions(filters);
  const summary = summaryQuery.data?.data;
  const promotions = promotionQuery.data?.data.items ?? [];
  const transactions = transactionsQuery.data?.data;
  const filterOptions = filterOptionsQuery.data?.data;
  const totalPages = Math.max(1, Math.ceil((transactions?.total ?? 0) / PAGE_SIZE));

  const resetPage = (update: () => void) => {
    update();
    setPage(1);
  };

  const goBack = () => {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  };

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 pb-10">
      <section className="rounded-2xl border border-white/8 bg-card/70 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <button
              type="button"
              onClick={goBack}
              className="mb-3 inline-flex items-center gap-1 text-sm text-white/55 transition-colors hover:text-white"
            >
              <ChevronLeft className="size-4" />
              {t("credits.back")}
            </button>
            <h1 className="text-xl font-semibold text-white">{t("credits.centerTitle")}</h1>
            <p className="mt-1 text-sm text-white/45">{t("credits.centerDescription")}</p>
          </div>
          {summary && summary.pending > 0 ? (
            <div className="flex items-center gap-2 rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
              <Clock3 className="size-4" />
              {t("credits.pendingAmount", {
                amount: formatNumber(summary.pending, language),
              })}
            </div>
          ) : null}
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["balance", summary?.balance, "text-sky-300"],
            ["earned", summary?.earned, "text-emerald-300"],
            ["spent", summary?.spent, "text-rose-300"],
            ["refunded", summary?.refunded, "text-violet-300"],
          ].map(([key, value, tone]) => (
            <div key={String(key)} className="rounded-xl border border-white/7 bg-white/[0.025] p-4">
              <div className="text-xs text-white/45">{t(`credits.${key}`)}</div>
              <div className={cn("mt-2 flex items-center gap-1.5 text-2xl font-semibold", tone)}>
                {key === "balance" ? <CreditSparkIcon className="size-5" /> : null}
                <span className="tabular-nums">
                  {typeof value === "number" ? formatNumber(value, language) : "--"}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {promotions.length > 0 ? (
        <section className="rounded-2xl border border-amber-300/12 bg-amber-300/[0.035] p-5">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-amber-300" />
            <h2 className="text-base font-semibold text-white">{t("credits.availablePromotions")}</h2>
          </div>
          <p className="mt-1 text-xs text-white/40">{t("credits.promotionDisclaimer")}</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {promotions.map((promotion) => (
              <div
                key={promotion.id}
                className="rounded-xl border border-amber-200/10 bg-black/10 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-white">{promotion.name}</div>
                    <div className="mt-1 truncate text-xs text-white/45">
                      {promotion.target_label}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-md bg-amber-300/12 px-2 py-1 text-xs font-semibold text-amber-300">
                    {formatCreditPromotionLabel(promotion)}
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between text-[11px] text-white/35">
                  <span>{t(`credits.domain.${promotion.billing_domain}`)}</span>
                  <span>
                    {promotion.ends_at
                      ? t("credits.endsAt", {
                          time: formatDate(promotion.ends_at, language),
                        })
                      : t("credits.longTerm")}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="min-h-[440px] rounded-2xl border border-white/8 bg-card/70 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 border-b border-white/8">
            {CATEGORIES.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => resetPage(() => setCategory(value))}
                className={cn(
                  "relative px-3 py-2 text-sm transition-colors",
                  category === value ? "text-white" : "text-white/45 hover:text-white/75",
                )}
              >
                {t(`credits.category.${value}`)}
                {category === value ? (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 bg-sky-400" />
                ) : null}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-xs text-white/35">
              {transactionsQuery.isFetching
                ? t("credits.filtering")
                : t("credits.filteredRecords", { count: transactions?.total ?? 0 })}
            </span>
            <input
              type="date"
              value={startDate}
              onChange={(event) => resetPage(() => setStartDate(event.target.value))}
              aria-label={t("credits.startDate")}
              className="h-9 rounded-lg border border-white/8 bg-white/[0.035] px-3 text-xs text-white/70 outline-none focus:border-sky-400/50"
            />
            <input
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={(event) => resetPage(() => setEndDate(event.target.value))}
              aria-label={t("credits.endDate")}
              className="h-9 rounded-lg border border-white/8 bg-white/[0.035] px-3 text-xs text-white/70 outline-none focus:border-sky-400/50"
            />
            <select
              value={projectId}
              onChange={(event) => resetPage(() => setProjectId(event.target.value))}
              aria-label={t("credits.projectFilter")}
              className="h-9 min-w-36 rounded-lg border border-white/8 bg-[#1b1d22] px-3 text-xs text-white/70 outline-none focus:border-sky-400/50"
            >
              <option value="">{t("credits.allProjects")}</option>
              {(filterOptions?.projects ?? []).map((project) => (
                <option key={project.value} value={project.value}>
                  {project.label}
                </option>
              ))}
            </select>
            <select
              value={featureKey}
              onChange={(event) => resetPage(() => setFeatureKey(event.target.value))}
              aria-label={t("credits.featureFilter")}
              className="h-9 min-w-36 rounded-lg border border-white/8 bg-[#1b1d22] px-3 text-xs text-white/70 outline-none focus:border-sky-400/50"
            >
              <option value="">{t("credits.allFeatures")}</option>
              {(filterOptions?.features ?? []).map((feature) => (
                <option key={feature.value} value={feature.value}>
                  {feature.label}
                </option>
              ))}
            </select>
            <select
              value={model}
              onChange={(event) => resetPage(() => setModel(event.target.value))}
              aria-label={t("credits.modelFilter")}
              className="h-9 min-w-36 rounded-lg border border-white/8 bg-[#1b1d22] px-3 text-xs text-white/70 outline-none focus:border-sky-400/50"
            >
              <option value="">{t("credits.allModels")}</option>
              {(filterOptions?.models ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[920px] border-collapse text-left">
            <thead>
              <tr className="border-y border-white/8 text-xs text-white/35">
                <th className="px-3 py-3 font-medium">{t("credits.columns.time")}</th>
                <th className="px-3 py-3 font-medium">{t("credits.columns.feature")}</th>
                <th className="px-3 py-3 font-medium">{t("credits.columns.project")}</th>
                <th className="px-3 py-3 font-medium">{t("credits.columns.status")}</th>
                <th className="px-3 py-3 text-right font-medium">{t("credits.columns.change")}</th>
                <th className="px-3 py-3 text-right font-medium">{t("credits.columns.balance")}</th>
              </tr>
            </thead>
            <tbody>
              {(transactions?.items ?? []).map((item) => {
                const discounted =
                  item.original_cost !== null
                  && item.charged_cost !== null
                  && item.original_cost > item.charged_cost;
                return (
                  <tr key={item.id} className="border-b border-white/6 text-sm">
                    <td className="whitespace-nowrap px-3 py-3.5 text-xs text-white/45">
                      {formatDate(item.occurred_at, language)}
                    </td>
                    <td className="px-3 py-3.5">
                      <div className="font-medium text-white/85">
                        {item.feature_label || t("credits.adjustment")}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-white/35">
                        {item.model ? <span>{item.model}</span> : null}
                        {discounted ? (
                          <span className="text-amber-300">
                            {item.promotion.name || t("credits.promotionalPrice")}
                            {" · "}
                            <span className="line-through">{item.original_cost}</span>
                            {" → "}
                            {item.charged_cost}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-3.5 text-white/55">
                      {item.project_name || item.project_id || "--"}
                    </td>
                    <td className="px-3 py-3.5">
                      <TransactionStatus item={item} />
                    </td>
                    <td
                      className={cn(
                        "px-3 py-3.5 text-right font-medium tabular-nums",
                        item.delta > 0 ? "text-emerald-300" : "text-rose-300",
                      )}
                    >
                      {item.delta > 0 ? "+" : ""}
                      {formatNumber(item.delta, language)}
                    </td>
                    <td className="px-3 py-3.5 text-right text-white/60 tabular-nums">
                      {formatNumber(item.balance_after, language)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!transactionsQuery.isLoading && (transactions?.items.length ?? 0) === 0 ? (
          <div className="flex h-64 items-center justify-center text-sm text-white/35">
            {t("credits.empty")}
          </div>
        ) : null}
        {transactionsQuery.isLoading ? (
          <div className="flex h-64 items-center justify-center text-sm text-white/35">
            {t("common.loading")}
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-between text-xs text-white/40">
          <span>{t("credits.totalRecords", { count: transactions?.total ?? 0 })}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              className="flex size-8 items-center justify-center rounded-lg border border-white/8 disabled:opacity-30"
              aria-label={t("credits.previousPage")}
            >
              <ChevronLeft className="size-4" />
            </button>
            <span>{t("credits.pageOf", { page, total: totalPages })}</span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              className="flex size-8 items-center justify-center rounded-lg border border-white/8 disabled:opacity-30"
              aria-label={t("credits.nextPage")}
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export const Route = createFileRoute("/_app/credits")({
  beforeLoad: () => {
    if (isCeRuntime()) throw redirect({ to: "/" });
  },
  component: CreditsPage,
});
