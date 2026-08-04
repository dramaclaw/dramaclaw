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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

// DESIGN.md: this route lives on the shadcn semantic palette (background /
// primary), never the canvas one — so no `--accent` blue here.
//
// Surfaces are neutral grey, stacked as alpha over the page floor rather than
// picked from `muted`/`card` — those two are teal-tinted (#182229 / #1f2c34)
// and read as slate, not grey. Layering `foreground` alpha keeps the ramp
// neutral and theme-agnostic: in light mode the same classes tint downward off
// a white floor instead of upward off a black one.
//
// Three steps, each one lighter than what it sits on:
//
//   page floor   background        #090909
//   panel        foreground/8      ≈ #1b1b1b   ← 浅灰容器
//   nested       foreground/10     ≈ #303030   ← tiles / chips / fields / buttons
//   hairline     foreground/12
//
const SURFACE_PANEL = "bg-foreground/8";
const SURFACE_NESTED = "bg-foreground/10";
const HAIRLINE = "border-foreground/12";
// The sticky table header needs an *opaque* fill — `SURFACE_PANEL` is alpha,
// so rows would bleed through it while scrolling. Same colour, resolved
// against the page floor instead of composited over it.
const STICKY_HEAD = cn(
  "sticky top-0 z-10 bg-[color-mix(in_srgb,var(--foreground)_8%,var(--background))]",
  "shadow-[inset_0_-1px_0_0_color-mix(in_srgb,var(--foreground)_12%,transparent)]",
);

const PANEL = cn("rounded-lg border p-4", HAIRLINE, SURFACE_PANEL);
const TILE = cn("rounded-md border p-3", HAIRLINE, SURFACE_NESTED);
const MOTION = "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]";
// Quiet button: pill, 4px/11px, 12px label, no presence until hover.
const QUIET_BUTTON = cn(
  "inline-flex items-center gap-1 rounded-full border",
  HAIRLINE,
  SURFACE_NESTED,
  "px-[11px] py-1 text-xs font-medium text-muted-foreground",
  // Neutral feedback only. `primary` is the selection colour on this page (the
  // active filter chip, the balance ring) — spending it on a hover/press state
  // would make every button look selected.
  "hover:border-foreground/25 hover:bg-foreground/15 hover:text-foreground",
  "active:bg-foreground/20",
  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-foreground/12",
  "disabled:hover:bg-foreground/10 disabled:hover:text-muted-foreground",
  MOTION,
);
// Field: 12px radius, quiet at rest, brighter edge + 3px halo on focus.
const FIELD = cn(
  "h-9 rounded-sm border px-3 text-xs text-foreground outline-none",
  HAIRLINE,
  SURFACE_NESTED,
  // Same reasoning as QUIET_BUTTON: focus is transient, `primary` means
  // selected. A slightly brighter edge plus a soft neutral halo is enough.
  "focus:border-foreground/30 focus:ring-[3px] focus:ring-foreground/10",
  "transition-[border-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
);

// status-succeeded / status-degraded / badge-muted. DESIGN.md fills these with
// `muted`; here they take the same neutral grey as every other nested element
// and keep their semantic text colour.
const STATUS_TONE: Record<CreditTransaction["status"], string> = {
  completed: "text-success",
  confirmed: "text-success",
  pending: "text-warning",
  refunded: "text-muted-foreground",
};

const SUMMARY_TILES = ["balance", "earned", "spent", "refunded"] as const;

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

// The native <select> menu is drawn by the OS: macOS anchors the checked row
// over the trigger, so the list covers the control it came from. base-ui's
// Select portals a real popup under the trigger instead.
//
// "" is the "no filter" state in this page's query params, but base-ui reads an
// empty string as "nothing selected" and would show the placeholder styling —
// hence the sentinel, translated back at the boundary.
const ALL_FILTER = "__all__";

function FilterSelect({
  value,
  onChange,
  options,
  allLabel,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
  allLabel: string;
  ariaLabel: string;
}) {
  const labelFor = (current: string) =>
    current === ALL_FILTER
      ? allLabel
      : (options.find((option) => option.value === current)?.label ?? current);

  return (
    <Select
      value={value || ALL_FILTER}
      onValueChange={(next) => onChange(next === ALL_FILTER ? "" : String(next))}
    >
      {/* The trigger inherits FIELD, then re-states the surface for the `dark:`
          variants baked into SelectTrigger — those sit in a different variant
          group, so twMerge can't collapse them. */}
      <SelectTrigger
        aria-label={ariaLabel}
        className={cn(
          FIELD,
          "min-w-36 justify-between gap-2",
          "dark:bg-foreground/10 dark:hover:bg-foreground/15",
          "focus-visible:border-foreground/30 focus-visible:ring-foreground/10",
        )}
      >
        <SelectValue>{(current: string) => labelFor(current)}</SelectValue>
      </SelectTrigger>
      <SelectContent className="text-xs [&_[data-slot=select-item]]:focus:bg-foreground/10">
        <SelectItem value={ALL_FILTER}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TransactionStatus({ item }: { item: CreditTransaction }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium",
        SURFACE_NESTED,
        STATUS_TONE[item.status] ?? "text-muted-foreground",
      )}
    >
      {t(`credits.status.${item.status}`)}
    </span>
  );
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2.5 text-sm text-destructive">
      <span>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className={cn(QUIET_BUTTON, "shrink-0 border-destructive/30 text-destructive hover:border-destructive/60 hover:text-destructive")}
      >
        {t("credits.retry")}
      </button>
    </div>
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
  const summaryValues: Record<(typeof SUMMARY_TILES)[number], number | undefined> = {
    balance: summary?.balance,
    earned: summary?.earned,
    spent: summary?.spent,
    refunded: summary?.refunded,
  };

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

  // The layout's <main> already scrolls; this page opts out of that (h-full +
  // min-h-0) and hands the overflow to the table instead, so the filters and
  // the pager stay put while only the rows move.
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[1500px] flex-col gap-3">
      <section className={PANEL}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            {/* Chromeless: no border, no fill. A back affordance above the title
                is navigation, not an action — it earns presence on hover only. */}
            <button
              type="button"
              onClick={goBack}
              className={cn(
                QUIET_BUTTON,
                "mb-3 border-transparent bg-transparent pl-2",
                "hover:border-transparent hover:bg-transparent",
              )}
            >
              <ChevronLeft className="size-3.5" strokeWidth={1.75} />
              {t("credits.back")}
            </button>
            <h1 className="text-xl font-semibold text-foreground">{t("credits.centerTitle")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("credits.centerDescription")}</p>
          </div>
          {/* Unfilled too — it reads as a status note next to the title, and
              `text-warning` already carries the whole signal. */}
          {summary && summary.pending > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full py-1 pr-1 text-xs font-medium text-warning">
              <Clock3 className="size-3.5" strokeWidth={1.75} />
              {t("credits.pendingAmount", {
                amount: formatNumber(summary.pending, language),
              })}
            </span>
          ) : null}
        </div>

        {summaryQuery.isError ? (
          <div className="mt-4">
            <InlineError
              message={t("credits.summaryLoadFailed")}
              onRetry={() => void summaryQuery.refetch()}
            />
          </div>
        ) : null}

        {/* Hierarchy comes from size, not hue: one saturated element per screen,
            so the balance tile is ringed in `primary` while all four figures
            stay `foreground`. */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {SUMMARY_TILES.map((key) => {
            const value = summaryValues[key];
            const isBalance = key === "balance";
            return (
              <div
                key={key}
                className={cn(TILE, isBalance && "ring-1 ring-inset ring-primary/25")}
              >
                <div className="text-xs font-medium text-muted-foreground">
                  {t(`credits.${key}`)}
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 text-2xl font-semibold text-foreground">
                  {isBalance ? <CreditSparkIcon className="size-5" /> : null}
                  <span className="tabular-nums">
                    {typeof value === "number" ? formatNumber(value, language) : "--"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {promotions.length > 0 ? (
        <section className={PANEL}>
          <div className="flex items-center gap-1.5">
            <Sparkles className="size-4 text-primary" strokeWidth={1.75} />
            <h2 className="text-base font-semibold text-foreground">
              {t("credits.availablePromotions")}
            </h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t("credits.promotionDisclaimer")}</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {promotions.map((promotion) => (
              <div key={promotion.id} className={TILE}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">
                      {promotion.name}
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {promotion.target_label}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full bg-primary/12 px-2.5 py-0.5 text-xs font-medium text-primary">
                    {formatCreditPromotionLabel(promotion)}
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
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

      <section className={cn(PANEL, "flex min-h-0 flex-1 flex-col")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Pill filters — the signature shape for "clickable but not submit".
              Active state rides `data-state` so portalled copies match. */}
          <div className="flex flex-wrap items-center gap-1">
            {CATEGORIES.map((value) => (
              <button
                key={value}
                type="button"
                data-state={category === value ? "active" : "inactive"}
                onClick={() => resetPage(() => setCategory(value))}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium",
                  SURFACE_NESTED,
                  "text-muted-foreground hover:bg-foreground/15 hover:text-foreground",
                  // Selected = inverted pill. Contrast carries the state, so it
                  // stays legible without spending a hue on it.
                  "data-[state=active]:bg-foreground data-[state=active]:text-background",
                  "data-[state=active]:hover:bg-foreground",
                  MOTION,
                )}
              >
                {t(`credits.category.${value}`)}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-xs text-muted-foreground">
              {transactionsQuery.isFetching
                ? t("credits.filtering")
                : t("credits.filteredRecords", { count: transactions?.total ?? 0 })}
            </span>
            <input
              type="date"
              value={startDate}
              onChange={(event) => resetPage(() => setStartDate(event.target.value))}
              aria-label={t("credits.startDate")}
              className={FIELD}
            />
            <input
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={(event) => resetPage(() => setEndDate(event.target.value))}
              aria-label={t("credits.endDate")}
              className={FIELD}
            />
            <FilterSelect
              value={projectId}
              onChange={(next) => resetPage(() => setProjectId(next))}
              options={filterOptions?.projects ?? []}
              allLabel={t("credits.allProjects")}
              ariaLabel={t("credits.projectFilter")}
            />
            <FilterSelect
              value={featureKey}
              onChange={(next) => resetPage(() => setFeatureKey(next))}
              options={filterOptions?.features ?? []}
              allLabel={t("credits.allFeatures")}
              ariaLabel={t("credits.featureFilter")}
            />
            <FilterSelect
              value={model}
              onChange={(next) => resetPage(() => setModel(next))}
              options={filterOptions?.models ?? []}
              allLabel={t("credits.allModels")}
              ariaLabel={t("credits.modelFilter")}
            />
          </div>
        </div>

        <div className="ui-scrollbar mt-3 min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[920px] border-collapse text-left">
            <thead>
              <tr className="text-xs font-medium text-muted-foreground">
                <th className={cn(STICKY_HEAD, "px-3 py-2.5 font-medium")}>{t("credits.columns.time")}</th>
                <th className={cn(STICKY_HEAD, "px-3 py-2.5 font-medium")}>{t("credits.columns.feature")}</th>
                <th className={cn(STICKY_HEAD, "px-3 py-2.5 font-medium")}>{t("credits.columns.project")}</th>
                <th className={cn(STICKY_HEAD, "px-3 py-2.5 font-medium")}>{t("credits.columns.status")}</th>
                <th className={cn(STICKY_HEAD, "px-3 py-2.5 text-right font-medium")}>
                  {t("credits.columns.change")}
                </th>
                <th className={cn(STICKY_HEAD, "px-3 py-2.5 text-right font-medium")}>
                  {t("credits.columns.balance")}
                </th>
              </tr>
            </thead>
            <tbody>
              {(transactions?.items ?? []).map((item) => {
                const discounted =
                  item.original_cost !== null
                  && item.charged_cost !== null
                  && item.original_cost > item.charged_cost;
                return (
                  // Row hover lifts toward `card`, the one step above the panel —
                  // recessing here would collide with the nested elements.
                  <tr
                    key={item.id}
                    className={cn("border-b border-foreground/8 text-sm hover:bg-foreground/6", MOTION)}
                  >
                    {/* mono-sm is reserved for IDs, paths, seeds and timecodes. */}
                    <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-muted-foreground">
                      {formatDate(item.occurred_at, language)}
                    </td>
                    <td className="px-3 py-3">
                      <div className="font-medium text-foreground">
                        {item.feature_label || t("credits.adjustment")}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {item.model ? <span>{item.model}</span> : null}
                        {discounted ? (
                          <span className="text-primary">
                            {item.promotion.name || t("credits.promotionalPrice")}
                            {" · "}
                            <span className="line-through">{item.original_cost}</span>
                            {" → "}
                            {item.charged_cost}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {item.project_name || item.project_id || "--"}
                    </td>
                    <td className="px-3 py-3">
                      <TransactionStatus item={item} />
                    </td>
                    <td
                      className={cn(
                        "px-3 py-3 text-right font-medium tabular-nums",
                        item.delta > 0 ? "text-success" : "text-destructive",
                      )}
                    >
                      {item.delta > 0 ? "+" : ""}
                      {formatNumber(item.delta, language)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                      {formatNumber(item.balance_after, language)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {!transactionsQuery.isLoading
          && !transactionsQuery.isError
          && (transactions?.items.length ?? 0) === 0 ? (
            <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
              {t("credits.empty")}
            </div>
          ) : null}
          {transactionsQuery.isLoading ? (
            <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
              {t("common.loading")}
            </div>
          ) : null}
          {transactionsQuery.isError ? (
            <div className="mt-3">
              <InlineError
                message={t("credits.transactionsLoadFailed")}
                onRetry={() => void transactionsQuery.refetch()}
              />
            </div>
          ) : null}
        </div>

        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>{t("credits.totalRecords", { count: transactions?.total ?? 0 })}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              className={cn(QUIET_BUTTON, "size-8 justify-center p-0")}
              aria-label={t("credits.previousPage")}
            >
              <ChevronLeft className="size-4" strokeWidth={1.75} />
            </button>
            <span className="tabular-nums">{t("credits.pageOf", { page, total: totalPages })}</span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              className={cn(QUIET_BUTTON, "size-8 justify-center p-0")}
              aria-label={t("credits.nextPage")}
            >
              <ChevronRight className="size-4" strokeWidth={1.75} />
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
