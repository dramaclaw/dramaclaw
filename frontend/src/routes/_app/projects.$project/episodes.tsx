// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  createFileRoute,
  Outlet,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useMemo } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Clapperboard,
  Loader2,
  MapPinned,
  Package,
  Play,
  RefreshCw,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";

import { useCharacters } from "@/lib/queries/characters";
import {
  derivePipelineEpisodeStatuses,
  isPlanEpisodeAssetsResult,
  useEpisodeBeats,
  useEpisodeDetail,
  useEpisodes,
  usePipelineStatus,
  usePlanEpisodeProps,
  usePlanEpisodeScenes,
  usePlanEpisodes,
  usePlanIdentities,
} from "@/lib/queries/episodes";
import { deriveEpisodeStats, type EpisodeStats } from "@/lib/episode-stats";
import { useStageTask } from "@/hooks/use-stage-task";
import { queryKeys } from "@/lib/query-keys";
import {
  backendErrorToastMessage,
  BillingRuleNotConfiguredError,
} from "@/lib/api-errors";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { HealthBar } from "@/components/episode/health-bar";
import {
  EpisodeActionsSlotProvider,
  useEpisodeActionsSlotActive,
  useEpisodeActionsSlotSetter,
} from "@/components/episode/episode-actions-slot";
import { TaskControllerProvider } from "@/components/episode/task-controller-provider";
import {
  CollapsibleHeaderRegion,
  HeaderCollapseProvider,
} from "@/components/episode/header-collapse";
import { StageProgressPanel } from "@/components/stage-progress-panel";
import { CreditCostInline } from "@/components/credit-cost-inline";
import { EpisodeListSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { TOP_TABS } from "@/lib/episode-nav";
import type { Episode } from "@/types/episode";

// ─── stage descriptor (shared) ──────────────────────────────────────────────

// v3 valid top-level paths + legacy sub routes that redirect to /beats.
const KNOWN_STAGE_PATHS: readonly string[] = [
  ...TOP_TABS.map((t) => t.routeSegment),
  "/sketches",
  "/audio",
  "/video",
  "/overview",
];
const DEFAULT_STAGE_PATH = "/script";

// ─── helpers ────────────────────────────────────────────────────────────────

function useSelectedEpisodeNum(): number | null {
  const params = useParams({ strict: false }) as { episode?: string };
  return params.episode ? Number(params.episode) : null;
}

function useActiveStagePath(): string {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const m = pathname.match(/\/episodes\/\d+(\/[a-z-]+)?/);
  const found = m?.[1] ?? "";
  return KNOWN_STAGE_PATHS.includes(found) ? found : DEFAULT_STAGE_PATH;
}

function countContentLines(text: string | undefined): number {
  const trimmed = text?.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

// ─── Episode header 2-column layout ─────────────────────────────────────────
// Left column stacks the episode chrome and the pipeline
// step nav. Right column is a portal target that the active route can fill
// with episode-level batch actions (e.g. BatchBar on the beats page).

function EpisodeHeaderLayout({
  episode,
  project,
}: {
  episode: Episode;
  project: string;
}) {
  const slotActive = useEpisodeActionsSlotActive();
  const setSlotTarget = useEpisodeActionsSlotSetter();
  return (
    <CollapsibleHeaderRegion className="bg-background">
      <div className="flex min-w-0 flex-col">
        <HealthBar project={project} episode={episode.number} />
        {slotActive && (
          <div
            ref={setSlotTarget}
            className="flex min-h-0 w-full min-w-0 justify-center border-b border-border/30 bg-white/[0.04] px-9 py-3 shadow-[inset_0_1px_0_hsl(var(--border)/0.3)]"
          />
        )}
      </div>
    </CollapsibleHeaderRegion>
  );
}

// ─── Top bar ────────────────────────────────────────────────────────────────

function episodeDisplayTitle(episode: Episode, episodeNumberLabel: string) {
  return episode.title?.trim() || episodeNumberLabel;
}

function EpisodeTitleSwitcher({
  selectedEpisode,
  episodes,
  onSelectEpisode,
}: {
  selectedEpisode: Episode;
  episodes: Episode[];
  onSelectEpisode: (episodeNum: number) => void;
}) {
  const { t } = useTranslation();
  const currentTitle = episodeDisplayTitle(
    selectedEpisode,
    t("episode.list.episodeNumber", { n: selectedEpisode.number }),
  );

  if (episodes.length <= 1) {
    return (
      <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
        {currentTitle}
      </h1>
    );
  }

  return (
    <DropdownMenu>
      <h1 className="min-w-0 text-2xl font-semibold tracking-tight text-foreground">
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="group inline-flex max-w-full items-center gap-2 rounded-[8px] px-1.5 py-1 text-left transition-colors hover:bg-white/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              aria-label={t("episode.list.switchEpisode")}
            />
          }
        >
          <span className="min-w-0 truncate">{currentTitle}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
        </DropdownMenuTrigger>
      </h1>
      <DropdownMenuContent
        align="start"
        sideOffset={8}
        className="w-80 max-h-[min(72vh,30rem)] overflow-hidden border border-white/15 bg-background/95 p-1.5 text-foreground shadow-none ring-0 backdrop-blur-2xl"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 py-1.5 text-[11px]">
            {t("episode.list.switchEpisode")}
          </DropdownMenuLabel>
          <div className="max-h-[min(62vh,26rem)] overflow-y-auto overscroll-contain pr-1">
            {episodes.map((episode) => {
              const isCurrent = episode.number === selectedEpisode.number;
              const title = episodeDisplayTitle(
                episode,
                t("episode.list.episodeNumber", { n: episode.number }),
              );
              const lines = countContentLines(
                episode.beat_source_text || episode.raw_content,
              );
              const identities = episode.identity_ids?.length ?? 0;
              const scenes = episode.scene_menu?.length ?? 0;
              const props = episode.prop_menu?.length ?? 0;

              return (
                <DropdownMenuItem
                  key={episode.number}
                  onClick={() => {
                    if (!isCurrent) onSelectEpisode(episode.number);
                  }}
                  className={cn(
                    "my-1 items-start gap-3 rounded-[7px] px-2 py-2.5 hover:bg-white/[0.06] focus:bg-white/[0.06]",
                    isCurrent && "bg-white/[0.06] text-foreground",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {title}
                    </span>
                    <span className="mt-1 block truncate text-[11px] !text-muted-foreground">
                      {t("episode.list.episodeSwitchSummary", {
                        lines,
                        identities,
                        scenes,
                        props,
                      })}
                    </span>
                  </span>
                  <Check
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0 !text-primary [&_*]:!text-primary",
                      !isCurrent && "opacity-0",
                    )}
                  />
                </DropdownMenuItem>
              );
            })}
          </div>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TopBar({
  showBack,
  onBack,
  showPlan,
  showReplan,
  onPlan,
  planPending,
  planCostDisplay,
  showRefresh,
  onRefresh,
  refreshPending,
  selectedEpisode,
  episodes,
  onSelectEpisode,
  project,
}: {
  showBack: boolean;
  onBack: () => void;
  showPlan: boolean;
  showReplan: boolean;
  onPlan: () => void;
  planPending: boolean;
  planCostDisplay?: string | null;
  showRefresh: boolean;
  onRefresh: () => void;
  refreshPending: boolean;
  selectedEpisode: Episode | null;
  episodes: Episode[];
  onSelectEpisode: (episodeNum: number) => void;
  project: string;
}) {
  const { t } = useTranslation();
  const episodeNumber = selectedEpisode?.number ?? 0;
  const { data: episodeDetailRes } = useEpisodeDetail(project, episodeNumber);
  const { data: beatsRes } = useEpisodeBeats(project, episodeNumber);
  const episodeDetail = episodeDetailRes?.data ?? selectedEpisode;
  const beatCount = beatsRes?.data.length ?? 0;
  const sourceLineCount = countContentLines(
    episodeDetail?.beat_source_text || episodeDetail?.raw_content,
  );
  const identityCount = episodeDetail?.identity_ids?.length ?? 0;
  const sceneCount = episodeDetail?.scene_menu?.length ?? 0;
  const propCount = episodeDetail?.prop_menu?.length ?? 0;
  const headerTitle = selectedEpisode
    ? selectedEpisode.title || t("episode.list.episodeNumber", { n: selectedEpisode.number })
    : t("nav.episodes");
  const headerSubtitle = selectedEpisode
    ? t("episode.list.selectedEpisodeSummary", {
        lines: sourceLineCount,
        beats: beatCount,
        identities: identityCount,
        scenes: sceneCount,
        props: propCount,
        status:
          beatCount > 0
            ? t("episode.list.scriptReady")
            : t("episode.list.scriptPending"),
      })
    : t("episode.list.subtitle");

  return (
    <div className="flex shrink-0 flex-col gap-3 border-b border-border/30 bg-background px-9 py-5 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Clapperboard className="size-[18px]" />
        </span>
        <div className="min-w-0">
          {selectedEpisode ? (
            <EpisodeTitleSwitcher
              selectedEpisode={selectedEpisode}
              episodes={episodes}
              onSelectEpisode={onSelectEpisode}
            />
          ) : (
            <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
              {headerTitle}
            </h1>
          )}
          <p className="ml-1.5 mt-3 truncate text-sm leading-6 text-muted-foreground">
            {headerSubtitle}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
        {showRefresh && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={refreshPending}
            className="h-8 gap-1.5 rounded-[8px] px-3 text-xs font-normal shadow-none hover:bg-white/[0.04]"
          >
            {refreshPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {t("episode.list.refresh")}
          </Button>
        )}
        {showReplan && (
          <Button
            variant="outline"
            size="sm"
            onClick={onPlan}
            disabled={planPending}
            className="h-8 gap-1.5 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none hover:bg-white/[0.04] dark:bg-transparent"
          >
            {planPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            {t("episode.list.replanEpisodes")}
            <CreditCostInline display={planCostDisplay} />
          </Button>
        )}
        {showPlan && (
          <Button
            size="sm"
            onClick={onPlan}
            disabled={planPending}
            className="h-8 gap-1.5 rounded-[8px] px-3 text-xs font-normal shadow-none"
          >
            {planPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            {t("episode.list.planEpisodes")}
            <CreditCostInline display={planCostDisplay} />
          </Button>
        )}
        {showBack && (
          <Button
            variant="outline"
            size="sm"
            onClick={onBack}
            className="h-8 gap-1.5 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none hover:bg-white/[0.04] dark:bg-transparent"
          >
            <ArrowLeft className="size-3.5" />
            {t("episode.list.backToEpisodes")}
          </Button>
        )}
      </div>
    </div>
  );
}

function EpisodeStatsStrip({
  stats,
  totalCharacters,
  completedEpisodes,
}: {
  stats: EpisodeStats;
  totalCharacters: number;
  completedEpisodes: number;
}) {
  const { t } = useTranslation();
  const items: Array<{
    key: string;
    label: string;
    value: number;
    icon: LucideIcon;
    tone?: "ready";
  }> = [
    {
      key: "episodes",
      label: t("episode.list.stats.totalEpisodes"),
      value: stats.totalEpisodes,
      icon: Clapperboard,
    },
    {
      key: "completed",
      label: t("episode.list.stats.completedEpisodes"),
      value: completedEpisodes,
      icon: Clapperboard,
      tone: "ready" as const,
    },
    {
      key: "characters",
      label: t("episode.list.stats.totalCharacters"),
      value: totalCharacters,
      icon: Users,
    },
    {
      key: "identities",
      label: t("episode.list.stats.totalIdentities"),
      value: stats.totalIdentities,
      icon: Users,
    },
    {
      key: "scenes",
      label: t("episode.list.stats.totalScenes"),
      value: stats.totalScenes,
      icon: MapPinned,
    },
    {
      key: "props",
      label: t("episode.list.stats.totalProps"),
      value: stats.totalProps,
      icon: Package,
    },
  ];

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-2 py-1.5">
      {items.map(({ key, label, value, icon: Icon, tone }) => (
        <div key={key} className="flex items-center gap-2">
          <Icon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground",
              tone === "ready" && "text-emerald-600 dark:text-emerald-300",
            )}
          />
          <div className="flex items-center gap-5">
            <span className="truncate text-[11px] text-muted-foreground">
              {label}
            </span>
            <span className="shrink-0 text-xs font-medium tabular-nums text-foreground">
              {value}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function EpisodePlanShortcut({
  icon,
  summary,
  actionLabel,
  costDisplay,
  pending,
  disabled = false,
  onClick,
}: {
  icon: React.ReactNode;
  summary: string;
  actionLabel: string;
  costDisplay?: string | null;
  pending: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="group flex min-w-0 items-center gap-2 rounded-[8px] bg-white/[0.025] px-2 py-1 transition-colors hover:bg-white/[0.045]">
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-muted-foreground">
        {icon}
        <span className="truncate">{summary}</span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        disabled={pending || disabled}
        aria-label={actionLabel}
        title={actionLabel}
        className="h-7 shrink-0 gap-1 rounded-[7px] bg-transparent px-2 text-[11px] font-normal text-foreground shadow-none transition-colors hover:bg-primary/12 hover:text-primary disabled:bg-transparent disabled:text-muted-foreground/50 [&_svg]:size-3"
      >
        {pending ? (
          <Loader2 className="animate-spin" />
        ) : (
          <Sparkles className="size-3" />
        )}
        {actionLabel}
        <CreditCostInline display={costDisplay} />
      </Button>
    </div>
  );
}

// ─── Episode list item ──────────────────────────────────────────────────────

function EpisodeListItem({
  project,
  episode,
  onSelect,
  onPlanScenes,
  onPlanProps,
  identityCostDisplay,
  sceneCostDisplay,
  propCostDisplay,
  scenePending,
  propPending,
  sceneDisabled,
  propDisabled,
}: {
  project: string;
  episode: Episode;
  onSelect: () => void;
  onPlanScenes: (episodeNum: number) => void;
  onPlanProps: (episodeNum: number) => void;
  identityCostDisplay?: string | null;
  sceneCostDisplay?: string | null;
  propCostDisplay?: string | null;
  scenePending: boolean;
  propPending: boolean;
  sceneDisabled: boolean;
  propDisabled: boolean;
}) {
  const { t } = useTranslation();
  // 镜头数量 = 该集 beats 数。复用既有的 beats 查询（无需后端新增字段）；react-query
  // 会缓存，进入该集详情时本就要拉这份数据。未就绪时不显示，避免闪烁。
  const { data: beatsRes } = useEpisodeBeats(project, episode.number);
  const shotCount = beatsRes?.data.length;
  const planIdentities = usePlanIdentities(project);
  const identityTask = useStageTask({
    taskType: "identity_planner",
    project,
    episode: episode.number,
    invalidateKeys: [
      queryKeys.episodes(project),
      queryKeys.episodeDetail(project, episode.number),
      queryKeys.characters(project),
      queryKeys.pipelineStatus(project),
    ],
    onComplete: (result) => {
      const data = (result ?? {}) as {
        new_count?: number;
        resolved_count?: number;
      };
      if ((data.new_count ?? 0) > 0) {
        toast.success(
          t("episode.script.planIdentitiesNew", { count: data.new_count }),
        );
      } else if ((data.resolved_count ?? 0) > 0) {
        toast.success(
          t("episode.script.planIdentitiesResolved", {
            count: data.resolved_count,
          }),
        );
      } else {
        toast.warning(t("episode.script.planIdentitiesNone"));
      }
    },
  });
  const title =
    episode.title?.trim() || t("episode.list.episodeNumber", { n: episode.number });
  const snippet = (episode.summary || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const identityCount = episode.identity_ids?.length ?? 0;
  const sceneCount = episode.scene_menu?.length ?? 0;
  const propCount = episode.prop_menu?.length ?? 0;
  const identityLabel =
    identityCount > 0
      ? t("episode.list.identityCount", { count: identityCount })
      : t("episode.list.noIdentities");
  const sceneLabel =
    sceneCount > 0
      ? t("episode.list.sceneCount", { count: sceneCount })
      : t("episode.list.noScenes");
  const propLabel =
    propCount > 0
      ? t("episode.list.propCount", { count: propCount })
      : t("episode.list.noProps");

  const handlePlanIdentities = async () => {
    try {
      const res = await planIdentities.mutateAsync(episode.number);
      if (res.ok === false) {
        toast.error(backendErrorToastMessage(res.error, t));
        return;
      }
      identityTask.start();
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const identityPending = planIdentities.isPending || identityTask.started;

  return (
    <div
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "flex h-full min-h-[13rem] w-full flex-col gap-2 rounded-[10px] border border-white/[0.06] bg-white/[0.025] p-3 text-left transition-all duration-200 ease-out",
        "hover:scale-[1.01] hover:border-white/[0.12] hover:bg-white/[0.04]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <div className="flex min-w-0 items-center">
        <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">
          {title}
        </h3>
      </div>

      {snippet && (
        <p className="line-clamp-2 text-xs leading-snug text-muted-foreground/80">
          {snippet}
        </p>
      )}

      {shotCount != null && (
        <div className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
          <Clapperboard className="size-3.5 shrink-0 text-primary" />
          <span>{t("episode.list.shotCount", { count: shotCount })}</span>
        </div>
      )}

      <div className="grid gap-1.5 pt-1">
        <EpisodePlanShortcut
          icon={<Users className="size-3.5 shrink-0 text-sky-400" />}
          summary={identityLabel}
          actionLabel={
            identityCount > 0
              ? t("episode.list.replanIdentities")
              : t("episode.list.planIdentities")
          }
          pending={identityPending}
          disabled={identityPending}
          costDisplay={identityCostDisplay}
          onClick={handlePlanIdentities}
        />
        <EpisodePlanShortcut
          icon={<MapPinned className="size-3.5 shrink-0 text-emerald-400" />}
          summary={sceneLabel}
          actionLabel={
            sceneCount > 0
              ? t("episode.list.replanScenes")
              : t("episode.list.planScenes")
          }
          pending={scenePending}
          disabled={sceneDisabled}
          costDisplay={sceneCostDisplay}
          onClick={() => onPlanScenes(episode.number)}
        />
        <EpisodePlanShortcut
          icon={<Package className="size-3.5 shrink-0 text-amber-400" />}
          summary={propLabel}
          actionLabel={
            propCount > 0
              ? t("episode.list.replanProps")
              : t("episode.list.planProps")
          }
          pending={propPending}
          disabled={propDisabled}
          costDisplay={propCostDisplay}
          onClick={() => onPlanProps(episode.number)}
        />
      </div>

      <div className="mt-auto pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          onMouseDown={(event) => event.stopPropagation()}
          className="h-8 w-full justify-center gap-1.5 rounded-[8px] border-white/10 bg-white/[0.025] px-3 text-xs font-normal text-foreground shadow-none hover:border-primary/45 hover:bg-primary/12 hover:text-primary"
        >
          {t("episode.list.viewDetails")}
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────

function EpisodesPage() {
  const { t } = useTranslation();
  const { project } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const activePath = useActiveStagePath();
  const selectedEpisodeNum = useSelectedEpisodeNum();

  // Queries
  const {
    data: episodesRes,
    isLoading: episodesLoading,
    isFetching: episodesFetching,
  } = useEpisodes(project);
  const {
    data: pipelineRes,
    isLoading: pipelineLoading,
    isFetching: pipelineFetching,
  } = usePipelineStatus(project);
  const { data: charactersRes } = useCharacters(project);

  const episodes = episodesRes?.data ?? [];
  const isLoading = episodesLoading || pipelineLoading;
  const stats = useMemo(() => deriveEpisodeStats(episodes), [episodes]);
  const totalCharacters = useMemo(
    () => charactersRes?.data?.length ?? 0,
    [charactersRes],
  );
  const pipelineEpisodes = useMemo(
    () => derivePipelineEpisodeStatuses(pipelineRes?.data),
    [pipelineRes?.data],
  );
  const completedEpisodes = useMemo(
    () => pipelineEpisodes.filter((ep) => ep.compose === true).length,
    [pipelineEpisodes],
  );

  const episodeByNum = useMemo(() => {
    const m = new Map<number, Episode>();
    for (const ep of episodes) m.set(ep.number, ep);
    return m;
  }, [episodes]);

  // P0 fix: never hide episodes whose pipeline status is missing.
  // Build the display list from the UNION of episode numbers appearing in
  // either source; prefer the real Episode record, fall back to a stub.
  const displayEpisodes: Episode[] = useMemo(() => {
    const nums = new Set<number>();
    for (const ep of episodes) nums.add(ep.number);
    for (const ps of pipelineEpisodes) nums.add(ps.episode);
    return Array.from(nums)
      .sort((a, b) => a - b)
      .map(
        (n) =>
          episodeByNum.get(n) ?? ({ number: n, title: t("episode.list.episodeNumber", { n }) } as Episode),
      );
  }, [episodes, pipelineEpisodes, episodeByNum, t]);


  // Selected episode (URL-driven)
  const selectedEpisode =
    selectedEpisodeNum !== null
      ? episodeByNum.get(selectedEpisodeNum) ??
        ({ number: selectedEpisodeNum, title: t("episode.list.episodeNumber", { n: selectedEpisodeNum }) } as Episode)
      : null;

  // Plan-episodes SSE — global task, not per-episode (episode sentinel = 0).
  const planEpisodes = usePlanEpisodes(project);
  const planEpisodesCost = useGenerationCreditCost("feature", "build_episodes");
  const planEpisodesCostDisplay =
    planEpisodesCost.data?.data.display ??
    (planEpisodesCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);
  const planIdentitiesCost = useGenerationCreditCost("feature", "identity_planner");
  const planIdentitiesCostDisplay =
    planIdentitiesCost.data?.data.display ??
    (planIdentitiesCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);
  const planScenesCost = useGenerationCreditCost("feature", "episode_scene_planner");
  const planScenesCostDisplay =
    planScenesCost.data?.data.display ??
    (planScenesCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);
  const planPropsCost = useGenerationCreditCost("feature", "episode_prop_planner");
  const planPropsCostDisplay =
    planPropsCost.data?.data.display ??
    (planPropsCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);
  const planScenes = usePlanEpisodeScenes(project);
  const planProps = usePlanEpisodeProps(project);
  const planTask = useStageTask({
    taskType: "build_episodes",
    project,
    episode: 0,
    invalidateKeys: [
      queryKeys.episodes(project),
      queryKeys.pipelineStatus(project),
    ],
  });

  const handlePlan = async () => {
    try {
      const res = await planEpisodes.mutateAsync({});
      if (res.ok === false) {
        toast.error(backendErrorToastMessage(res.error, t));
        return;
      }
      planTask.start();
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handleRefresh = async () => {
    try {
      const invalidations = [
        queryClient.invalidateQueries({ queryKey: queryKeys.episodes(project) }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.pipelineStatus(project),
        }),
      ];
      if (selectedEpisodeNum !== null) {
        invalidations.push(
          queryClient.invalidateQueries({
            queryKey: queryKeys.episodeDetail(project, selectedEpisodeNum),
          }),
        );
      }
      await Promise.all(invalidations);
      toast.success(t("episode.list.refreshed"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handlePlanScenes = async (episodeNum: number) => {
    try {
      const res = await planScenes.mutateAsync(episodeNum);
      if (res.ok === false) {
        toast.error(backendErrorToastMessage(res.error, t));
        return;
      }
      toast.success(
        isPlanEpisodeAssetsResult(res)
          ? t("episode.script.scenePlanComplete", {
              count: res.data.total_count,
            })
          : res.message,
      );
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handlePlanProps = async (episodeNum: number) => {
    try {
      const res = await planProps.mutateAsync(episodeNum);
      if (res.ok === false) {
        toast.error(backendErrorToastMessage(res.error, t));
        return;
      }
      toast.success(
        isPlanEpisodeAssetsResult(res)
          ? t("episode.script.propPlanComplete", {
              count: res.data.total_count,
            })
          : res.message,
      );
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handleSelectEpisode = (num: number) => {
    // Preserve the active stage when switching episodes
    navigate({
      to: `/projects/${project}/episodes/${num}${activePath}`,
    });
  };

  const planPending = planEpisodes.isPending || planTask.started;
  const refreshPending = episodesFetching || pipelineFetching;

  const topBar = (
    <TopBar
      showBack={!!selectedEpisode}
      onBack={() => navigate({ to: `/projects/${project}/episodes` })}
      showPlan={!selectedEpisode && displayEpisodes.length === 0}
      showReplan={!selectedEpisode && displayEpisodes.length > 0}
      onPlan={handlePlan}
      planPending={planPending}
      planCostDisplay={planEpisodesCostDisplay}
      showRefresh={!selectedEpisode}
      onRefresh={handleRefresh}
      refreshPending={refreshPending}
      selectedEpisode={selectedEpisode}
      episodes={displayEpisodes}
      onSelectEpisode={handleSelectEpisode}
      project={project}
    />
  );

  return (
    <HeaderCollapseProvider>
    <div className="-m-6 flex h-[calc(100%+3rem)] flex-col overflow-hidden">
      {selectedEpisode ? (
        <CollapsibleHeaderRegion>{topBar}</CollapsibleHeaderRegion>
      ) : (
        topBar
      )}

      {planTask.started && planTask.stream.status !== "idle" && (
        <StageProgressPanel
          title={t("episode.list.planning")}
          currentTask={planTask.stream.currentTask}
          progress={planTask.stream.progress}
          logs={planTask.logs}
          onStop={planTask.stop}
          stopping={planTask.stopping}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {selectedEpisode ? (
          <TaskControllerProvider
            project={project}
            episode={selectedEpisode.number}
          >
            <EpisodeActionsSlotProvider>
              <div className="flex min-h-0 flex-1 flex-col">
                <EpisodeHeaderLayout
                  episode={selectedEpisode}
                  project={project}
                />
                <div className="min-h-0 flex-1 overflow-hidden">
                  <Outlet />
                </div>
              </div>
            </EpisodeActionsSlotProvider>
          </TaskControllerProvider>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {!isLoading && (
              <div className="shrink-0 border-b border-border/30 bg-background px-3 py-3 lg:px-9">
                <EpisodeStatsStrip
                  stats={stats}
                  totalCharacters={totalCharacters}
                  completedEpisodes={completedEpisodes}
                />
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-6">
              {isLoading ? (
                <EpisodeListSkeleton label={t("common.loading")} />
              ) : displayEpisodes.length === 0 ? (
                <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3 text-center">
                  <div className="flex size-16 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.035]">
                    <Clapperboard className="size-6 text-muted-foreground" />
                  </div>
                  <h2 className="text-sm font-semibold text-foreground">
                    {t("episode.list.noEpisodes")}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {t("episode.list.noEpisodesHint")}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePlan}
                    disabled={planPending}
                    className="mt-2 h-8 gap-1.5 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none hover:bg-white/[0.04] dark:bg-transparent"
                  >
                    {planPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Play className="size-3.5" />
                    )}
                    {t("episode.list.planEpisodes")}
                    <CreditCostInline display={planEpisodesCostDisplay} />
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                  {displayEpisodes.map((ep) => (
                    <EpisodeListItem
                      project={project}
                      key={ep.number}
                      episode={ep}
                      onSelect={() => handleSelectEpisode(ep.number)}
                      onPlanScenes={handlePlanScenes}
                      onPlanProps={handlePlanProps}
                      identityCostDisplay={planIdentitiesCostDisplay}
                      sceneCostDisplay={planScenesCostDisplay}
                      propCostDisplay={planPropsCostDisplay}
                      scenePending={
                        planScenes.isPending && planScenes.variables === ep.number
                      }
                      propPending={
                        planProps.isPending && planProps.variables === ep.number
                      }
                      sceneDisabled={planScenes.isPending}
                      propDisabled={planProps.isPending}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
    </HeaderCollapseProvider>
  );
}

// TODO (Phase 6 — backend-coupled, not done yet):
// - Debounced autosave + ETag/If-Match conflict handling on beat PATCH.
// - Attempt badges + admin-password unlock dialog on per-stage actions.
// - Server-authoritative `actions: {stage: {enabled, reason}}` in pipelineStatus.
// - Split pipeline endpoints (list vs per-episode) to reduce invalidation storms.
// - Identity denormalization into characters response (fixes N+1 identity fetch).

export const Route = createFileRoute("/_app/projects/$project/episodes")({
  component: EpisodesPage,
});
