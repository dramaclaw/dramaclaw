// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { motion } from "framer-motion";
import {
  ArchiveRestore,
  BookOpen,
  Brush,
  FolderOpen,
  LayoutGrid,
  List as ListIcon,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  Share2,
  Trash2,
  Undo2,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useAllProjectSummaries,
  useArchiveProject,
  useCreateProject,
  useProjectCounts,
  usePurgeProject,
  useRestoreProject,
  useSoftDeleteProject,
  useUnarchiveProject,
} from "@/lib/queries/projects";
import { ProjectFolder } from "@/components/projects/project-folder";
import { ShareProjectDialog } from "@/components/projects/share-project-dialog";
import { getProjectCover, NOISE_DATA_URI } from "@/lib/project-cover";
import { openFreezoneProject } from "@/lib/freezone-url";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  canDeleteProject,
  canManageProjectGrants,
  isSharedProject,
  projectRole,
} from "@/lib/project-permissions";
import { useAppStore } from "@/stores/app-store";
import { cn } from "@/lib/utils";
import type { DashboardView } from "@/stores/app-store";
import type { ProjectStatus, ProjectSummary } from "@/types/project";
import { PROJECT_SECTION_ROUTES } from "@/components/layout/project-navigation-routes";
import {
  normalizeLastEpisodeLocation,
  useEpisodeWorkbenchStore,
} from "@/stores/episode-workbench-store";
import { useProjectNavStore } from "@/stores/project-nav-store";

type PendingAction =
  | { kind: "archive"; project: string; name: string }
  | { kind: "delete"; project: string; name: string }
  | { kind: "purge"; project: string; name: string };

type SortKey = "updated-desc" | "updated-asc" | "name-asc" | "name-desc";

const SORT_OPTIONS: { value: SortKey; labelKey: string }[] = [
  { value: "updated-desc", labelKey: "project.sort.updatedDesc" },
  { value: "updated-asc", labelKey: "project.sort.updatedAsc" },
  { value: "name-asc", labelKey: "project.sort.nameAsc" },
  { value: "name-desc", labelKey: "project.sort.nameDesc" },
];

const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9_]+$/;

const PROJECT_CARD_MIN_HEIGHT_CLASS = "min-h-[12.75rem]";
const RECENTLY_CREATED_PROJECT_KEY = "supertale-dashboard-recent-created-project";

function readRecentlyCreatedProject(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(RECENTLY_CREATED_PROJECT_KEY);
}

function prioritizeRecentlyCreatedProject(
  list: ProjectSummary[],
  name: string | null,
): ProjectSummary[] {
  if (!name) return list;
  const index = list.findIndex((p) => p.name === name);
  if (index <= 0) return list;
  const next = [...list];
  const [project] = next.splice(index, 1);
  next.unshift(project);
  return next;
}

function getUpdatedAt(s: ProjectSummary): string {
  return s.updatedAt ?? s.archivedAt ?? s.deletedAt ?? "";
}

function projectRouteParam(summary: ProjectSummary): string {
  return summary.id;
}

function sortSummaries(list: ProjectSummary[], key: SortKey): ProjectSummary[] {
  const arr = [...list];
  switch (key) {
    case "updated-desc":
      return arr.sort((a, b) => {
        const at = getUpdatedAt(a);
        const bt = getUpdatedAt(b);
        if (at !== bt) return at < bt ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
    case "updated-asc":
      return arr.sort((a, b) => {
        const at = getUpdatedAt(a);
        const bt = getUpdatedAt(b);
        if (at !== bt) return at > bt ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
    case "name-asc":
      return arr.sort((a, b) => a.name.localeCompare(b.name));
    case "name-desc":
      return arr.sort((a, b) => b.name.localeCompare(a.name));
  }
}

function ProjectCard({
  summary,
  size = "md",
  onOpen,
  onPreload,
  onShare,
  onAction,
}: {
  summary: ProjectSummary;
  size?: "md" | "sm";
  onOpen: () => void;
  onPreload?: () => void;
  onShare: () => void;
  onAction: (
    action: "archive" | "unarchive" | "delete" | "restore" | "purge",
  ) => void;
}) {
  const { t } = useTranslation();
  const { initial, primary } = useMemo(
    () => getProjectCover(summary.name),
    [summary.name],
  );
  const isActive = summary.status === "active";
  const isArchived = summary.status === "archived";
  const isDeleted = summary.status === "deleted";
  const canManageGrants = canManageProjectGrants(summary);
  const canLifecycle = canDeleteProject(summary);
  const isShared = isSharedProject(summary);
  const roleLabel = t(`project.roleLabel.${projectRole(summary)}`);
  const sourceLabel = isShared
    ? t("project.ownership.from", {
        owner: summary.ownerUsername || t("project.ownership.unknownOwner"),
      })
    : t("project.ownership.mine");
  const ownershipMetaLabel = `${sourceLabel} / ${roleLabel}`;
  const visibleOwnershipLabel = isShared ? ownershipMetaLabel : sourceLabel;

  const relativeEdited = summary.updatedAt
    ? formatRelativeTime(summary.updatedAt, t)
    : null;
  const relativeDeleted = summary.deletedAt
    ? formatRelativeTime(summary.deletedAt, t)
    : null;

  const clickable = !isDeleted;
  const containerClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-project-menu]")) return;
    if (clickable) onOpen();
  };

  const sm = size === "sm";

  return (
    <div
      onFocus={() => {
        if (clickable) onPreload?.();
      }}
      onMouseEnter={() => {
        if (clickable) onPreload?.();
      }}
      onClick={containerClick}
      onKeyDown={(e) => {
        if (!clickable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      className={cn(
        "group relative flex h-full flex-col rounded-lg border border-border/65 bg-card/50 transition-all duration-300 ease-out",
        PROJECT_CARD_MIN_HEIGHT_CLASS,
        sm ? "p-2 pt-4" : "p-3 pt-5",
        clickable &&
          "cursor-pointer hover:border-foreground/15 hover:bg-card/65 hover:shadow-lg hover:shadow-black/10",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        isArchived && "opacity-70",
        isDeleted && "opacity-50",
      )}
    >
      <div className="mx-auto flex w-full flex-col">
        <div
          className={cn(
            "project-cover relative mx-auto mb-3 flex aspect-[16/10] w-[90%] items-end justify-center overflow-visible rounded-lg pb-1",
            isDeleted && "grayscale",
          )}
        >
          <ProjectFolder
            color={primary}
            initial={initial}
            width="100%"
            size={sm ? 0.92 : 1}
            className="translate-y-1"
          />
          {isArchived && (
            <div className="absolute bottom-2 right-2 rounded-full bg-background/60 px-2 py-0.5 text-[10px] font-medium text-foreground backdrop-blur-sm">
              {t("project.archivedBadge")}
            </div>
          )}
        </div>

        <div className="flex w-full items-start justify-between gap-1">
          <h3
            className="ml-[5%] min-w-0 truncate text-sm font-semibold text-foreground"
            title={summary.name}
          >
            {summary.name}
          </h3>
          <div
            data-project-menu
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    className="shrink-0 p-0.5 text-muted-foreground opacity-0 transition-colors hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={t("project.actionsLabel")}
                  />
                }
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="right"
                align="start"
                sideOffset={8}
                className="w-32 rounded-md p-1 shadow-xl shadow-black/20 [&_[data-slot=dropdown-menu-item]]:min-h-8 [&_[data-slot=dropdown-menu-item]]:gap-2 [&_[data-slot=dropdown-menu-item]]:rounded-sm [&_[data-slot=dropdown-menu-item]]:px-2 [&_[data-slot=dropdown-menu-item]]:py-1.5 [&_[data-slot=dropdown-menu-item]]:text-xs [&_[data-slot=dropdown-menu-item]:focus]:bg-white/8 [&_[data-slot=dropdown-menu-item]:focus]:text-current [&_[data-slot=dropdown-menu-item][data-variant=destructive]:focus]:bg-white/8 [&_[data-slot=dropdown-menu-item][data-variant=destructive]:focus]:text-destructive [&_[data-slot=dropdown-menu-item]_svg]:size-3.5"
              >
                <DropdownMenuGroup>
                  {isActive && (
                    <>
                      <DropdownMenuItem onClick={onOpen}>
                        <FolderOpen className="size-4" />
                        {t("project.actions.open")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => openFreezoneProject(projectRouteParam(summary))}
                      >
                        <Brush className="size-4" />
                        {t("project.actions.openFreezone")}
                      </DropdownMenuItem>
                      {canLifecycle && (
                        <>
                          <DropdownMenuItem onClick={() => onAction("archive")}>
                            <ArchiveRestore className="size-4" />
                            {t("project.actions.archive")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => onAction("delete")}
                            variant="destructive"
                          >
                            <Trash2 className="size-4" />
                            {t("project.actions.delete")}
                          </DropdownMenuItem>
                        </>
                      )}
                    </>
                  )}
                  {isArchived && (
                    <>
                      <DropdownMenuItem onClick={onOpen}>
                        <FolderOpen className="size-4" />
                        {t("project.actions.open")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => openFreezoneProject(projectRouteParam(summary))}
                      >
                        <Brush className="size-4" />
                        {t("project.actions.openFreezone")}
                      </DropdownMenuItem>
                      {canManageGrants && (
                        <DropdownMenuItem onClick={onShare}>
                          <Share2 className="size-4" />
                          {t("project.actions.share")}
                        </DropdownMenuItem>
                      )}
                      {canLifecycle && (
                        <>
                          <DropdownMenuItem onClick={() => onAction("unarchive")}>
                            <ArchiveRestore className="size-4" />
                            {t("project.actions.unarchive")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => onAction("delete")}
                            variant="destructive"
                          >
                            <Trash2 className="size-4" />
                            {t("project.actions.delete")}
                          </DropdownMenuItem>
                        </>
                      )}
                    </>
                  )}
                  {isDeleted && (
                    <>
                      {canLifecycle && (
                        <>
                          <DropdownMenuItem onClick={() => onAction("restore")}>
                            <Undo2 className="size-4" />
                            {t("project.actions.restore")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => onAction("purge")}
                            variant="destructive"
                          >
                            <Trash2 className="size-4" />
                            {t("project.actions.purge")}
                          </DropdownMenuItem>
                        </>
                      )}
                    </>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {!isDeleted && (
          <div className="mx-auto mt-2 flex w-[90%] min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground tabular-nums">
            <span className="tabular-nums">
              {t("project.card.episodes", { count: summary.episodeCount ?? 0 })}
            </span>
            {relativeEdited ? (
              <>
                <span className="text-muted-foreground/45" aria-hidden>
                  ·
                </span>
                <span className="min-w-0 truncate">
                  {t("project.card.editedAgo", { time: relativeEdited })}
                </span>
              </>
            ) : null}
          </div>
        )}

        {isDeleted && (
          <div className="mt-1 text-[11px] tabular-nums text-muted-foreground/80">
            <span className="font-medium text-destructive/80">
              {relativeDeleted
                ? t("project.card.deletedAgo", { time: relativeDeleted })
                : t("project.archivedBadge")}
            </span>
          </div>
        )}

        {!isDeleted && (
          <div className="mt-3.5 flex min-w-0 items-center justify-between gap-1.5 text-[10px] leading-none text-muted-foreground/80">
            <div className="ml-[5%] flex min-w-0 items-center gap-1.5" title={ownershipMetaLabel}>
              <span className="min-w-0 truncate">{visibleOwnershipLabel}</span>
              {!isShared ? <span className="sr-only">{roleLabel}</span> : null}
            </div>
            {isActive && canManageGrants ? (
              <button
                type="button"
                data-project-menu
                onClick={(e) => {
                  e.stopPropagation();
                  onShare();
                }}
                className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                aria-label={t("project.actions.share")}
              >
                <Share2 className="size-3" />
                <span>{t("project.actions.share")}</span>
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function CreateProjectCard({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onCreate}
      className={cn(
        "group flex h-full w-full flex-col items-center justify-center rounded-lg border border-white/10 bg-transparent p-3 text-center text-muted-foreground transition-all duration-300 ease-out",
        PROJECT_CARD_MIN_HEIGHT_CLASS,
        "hover:border-white/15 hover:bg-white/[0.03] hover:shadow-lg hover:shadow-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
      )}
    >
      <Plus
        className="mb-3 size-7 stroke-[1px] text-white/70 transition-colors group-hover:text-foreground"
        aria-hidden="true"
      />
      <span className="text-sm font-normal text-white/70 transition-colors group-hover:text-foreground">
        {t("project.createCard")}
      </span>
    </button>
  );
}

function DashboardTabStrip({
  current,
  counts,
  onChange,
}: {
  current: ProjectStatus;
  counts: Record<ProjectStatus, number>;
  onChange: (v: ProjectStatus) => void;
}) {
  const { t } = useTranslation();
  const tabs: { value: ProjectStatus; label: string }[] = [
    { value: "active", label: t("project.statusActive") },
    { value: "archived", label: t("project.statusArchived") },
    { value: "deleted", label: t("project.statusDeleted") },
  ];
  return (
    <div className="inline-flex h-8 items-center rounded-full border border-border bg-background/40 p-1 text-xs">
      {tabs.map((tab) => {
        const active = current === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            onClick={() => onChange(tab.value)}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-full px-3 font-normal transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span>{tab.label}</span>
            <span
              className={cn(
                "rounded-full px-1.5 text-xs tabular-nums",
                active
                  ? "bg-primary-foreground/15 text-primary-foreground"
                  : "bg-accent text-muted-foreground",
              )}
            >
              {counts[tab.value]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ProjectRow({
  summary,
  onOpen,
  onPreload,
  onShare,
  onAction,
}: {
  summary: ProjectSummary;
  onOpen: () => void;
  onPreload?: () => void;
  onShare: () => void;
  onAction: (
    action: "archive" | "unarchive" | "delete" | "restore" | "purge",
  ) => void;
}) {
  const { t } = useTranslation();
  const { gradient, initial } = useMemo(
    () => getProjectCover(summary.name),
    [summary.name],
  );
  const isActive = summary.status === "active";
  const isArchived = summary.status === "archived";
  const isDeleted = summary.status === "deleted";
  const canManageGrants = canManageProjectGrants(summary);
  const canLifecycle = canDeleteProject(summary);
  const roleLabel = t(`project.roleLabel.${projectRole(summary)}`);
  const sourceLabel = isSharedProject(summary)
    ? t("project.ownership.from", {
        owner: summary.ownerUsername || t("project.ownership.unknownOwner"),
      })
    : t("project.ownership.mine");

  const relativeEdited = summary.updatedAt
    ? formatRelativeTime(summary.updatedAt, t)
    : null;
  const relativeDeleted = summary.deletedAt
    ? formatRelativeTime(summary.deletedAt, t)
    : null;

  const clickable = !isDeleted;
  const rowClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-project-menu]")) return;
    if (clickable) onOpen();
  };

  return (
    <div
      onFocus={() => {
        if (clickable) onPreload?.();
      }}
      onMouseEnter={() => {
        if (clickable) onPreload?.();
      }}
      onClick={rowClick}
      onKeyDown={(e) => {
        if (!clickable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      className={cn(
        "group flex items-center gap-3 rounded-lg border border-border/65 bg-card/50 px-3.5 py-3 transition-colors",
        clickable &&
          "cursor-pointer hover:border-foreground/15 hover:bg-card/65",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        isArchived && "opacity-70",
        isDeleted && "opacity-50",
      )}
    >
      <div
        className={cn(
          "relative size-10 shrink-0 overflow-hidden rounded-[9px]",
          isDeleted && "grayscale",
        )}
        style={{ background: gradient }}
      >
        <div
          aria-hidden
          className="absolute inset-0 mix-blend-overlay opacity-[0.08]"
          style={{
            backgroundImage: `url("${NOISE_DATA_URI}")`,
            backgroundSize: "200px 200px",
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <span
            className="text-lg font-bold leading-none text-white/68 drop-shadow-[0_1px_6px_rgba(0,0,0,0.32)]"
            style={{ fontFeatureSettings: '"cv01", "ss03"' }}
          >
            {initial}
          </span>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-3">
        <h3
          className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground"
          title={summary.name}
        >
          {summary.name}
        </h3>
        <span className="hidden shrink-0 rounded-full bg-background/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline">
          {sourceLabel}
        </span>
        <span className="hidden shrink-0 rounded-full bg-primary/12 px-2 py-0.5 text-[10px] font-medium text-primary sm:inline">
          {roleLabel}
        </span>
        {isArchived && (
          <span className="hidden shrink-0 rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline">
            {t("project.archivedBadge")}
          </span>
        )}
        {!isDeleted && summary.episodeCount != null && (
          <div className="hidden shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground/80 md:flex">
            <span>
              {t("project.card.episodes", {
                count: summary.episodeCount ?? 0,
              })}
            </span>
          </div>
        )}
        <div className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:block">
          {isDeleted
            ? relativeDeleted
              ? t("project.card.deletedAgo", { time: relativeDeleted })
              : t("project.archivedBadge")
            : relativeEdited
              ? t("project.card.editedAgo", { time: relativeEdited })
              : null}
        </div>
      </div>

      {isActive && canManageGrants && (
        <button
          type="button"
          data-project-menu
          onClick={(e) => {
            e.stopPropagation();
            onShare();
          }}
          className="flex shrink-0 items-center gap-1 rounded-full bg-background/55 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          aria-label={t("project.actions.share")}
        >
          <Share2 className="size-3.5" />
          <span className="hidden sm:inline">{t("project.actions.share")}</span>
        </button>
      )}

      <div
        data-project-menu
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label={t("project.actionsLabel")}
              />
            }
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-32 rounded-md p-1 shadow-xl shadow-black/20 [&_[data-slot=dropdown-menu-item]]:min-h-8 [&_[data-slot=dropdown-menu-item]]:gap-2 [&_[data-slot=dropdown-menu-item]]:rounded-sm [&_[data-slot=dropdown-menu-item]]:px-2 [&_[data-slot=dropdown-menu-item]]:py-1.5 [&_[data-slot=dropdown-menu-item]]:text-xs [&_[data-slot=dropdown-menu-item]:focus]:bg-white/8 [&_[data-slot=dropdown-menu-item]:focus]:text-current [&_[data-slot=dropdown-menu-item][data-variant=destructive]:focus]:bg-white/8 [&_[data-slot=dropdown-menu-item][data-variant=destructive]:focus]:text-destructive [&_[data-slot=dropdown-menu-item]_svg]:size-3.5"
          >
            <DropdownMenuGroup>
              {isActive && (
                <>
                  <DropdownMenuItem onClick={onOpen}>
                    <FolderOpen className="size-4" />
                    {t("project.actions.open")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => openFreezoneProject(projectRouteParam(summary))}
                  >
                    <Brush className="size-4" />
                    {t("project.actions.openFreezone")}
                  </DropdownMenuItem>
                  {canLifecycle && (
                    <>
                      <DropdownMenuItem onClick={() => onAction("archive")}>
                        <ArchiveRestore className="size-4" />
                        {t("project.actions.archive")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => onAction("delete")}
                        variant="destructive"
                      >
                        <Trash2 className="size-4" />
                        {t("project.actions.delete")}
                      </DropdownMenuItem>
                    </>
                  )}
                </>
              )}
              {isArchived && (
                <>
                  <DropdownMenuItem onClick={onOpen}>
                    <FolderOpen className="size-4" />
                    {t("project.actions.open")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => openFreezoneProject(projectRouteParam(summary))}
                  >
                    <Brush className="size-4" />
                    {t("project.actions.openFreezone")}
                  </DropdownMenuItem>
                  {canManageGrants && (
                    <DropdownMenuItem onClick={onShare}>
                      <Share2 className="size-4" />
                      {t("project.actions.share")}
                    </DropdownMenuItem>
                  )}
                  {canLifecycle && (
                    <>
                      <DropdownMenuItem onClick={() => onAction("unarchive")}>
                        <ArchiveRestore className="size-4" />
                        {t("project.actions.unarchive")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => onAction("delete")}
                        variant="destructive"
                      >
                        <Trash2 className="size-4" />
                        {t("project.actions.delete")}
                      </DropdownMenuItem>
                    </>
                  )}
                </>
              )}
              {isDeleted && (
                <>
                  {canLifecycle && (
                    <>
                      <DropdownMenuItem onClick={() => onAction("restore")}>
                        <Undo2 className="size-4" />
                        {t("project.actions.restore")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => onAction("purge")}
                        variant="destructive"
                      >
                        <Trash2 className="size-4" />
                        {t("project.actions.purge")}
                      </DropdownMenuItem>
                    </>
                  )}
                </>
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  value: DashboardView;
  onChange: (v: DashboardView) => void;
}) {
  const { t } = useTranslation();
  const options: {
    value: DashboardView;
    labelKey: string;
    Icon: typeof LayoutGrid;
  }[] = [
    { value: "card", labelKey: "project.view.card", Icon: LayoutGrid },
    { value: "list", labelKey: "project.view.list", Icon: ListIcon },
  ];
  return (
    <div
      role="tablist"
      aria-label={t("project.view.toggle")}
      className="inline-flex h-8 items-center rounded-full border border-border bg-background/40 p-1 text-xs"
    >
      {options.map(({ value: v, labelKey, Icon }) => {
        const active = value === v;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={t(labelKey)}
            title={t(labelKey)}
            onClick={() => onChange(v)}
            className={cn(
              "inline-flex h-6 items-center justify-center rounded-full px-2 font-normal transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
          </button>
        );
      })}
    </div>
  );
}

function LoadingList() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="flex animate-pulse items-center gap-3 rounded-lg border border-border/60 bg-card px-3 py-2"
        >
          <div className="size-10 rounded-md bg-white/[0.04]" />
          <div className="h-4 w-1/3 rounded bg-white/[0.05]" />
          <div className="ml-auto h-3 w-16 rounded bg-white/[0.04]" />
        </div>
      ))}
    </div>
  );
}

function LoadingGrid({ size = "md" }: { size?: "md" | "sm" }) {
  const sm = size === "sm";
  return (
    <div
      className={cn(
        "grid gap-4",
        sm
          ? "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8"
          : "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7",
      )}
    >
      {Array.from({ length: sm ? 8 : 6 }).map((_, i) => (
        <div
          key={i}
          className={cn(
            "flex animate-pulse flex-col rounded-xl border border-border/60 bg-card",
            sm ? "p-2" : "p-3",
          )}
        >
          <div className="mb-3 aspect-[16/10] rounded-lg bg-white/[0.04]" />
          <div className="h-4 w-2/3 rounded bg-white/[0.05]" />
          <div className="mt-1 h-3 w-1/3 rounded bg-white/[0.04]" />
        </div>
      ))}
    </div>
  );
}

function FirstTimeEmpty({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation();
  const { gradient } = useMemo(() => getProjectCover("empty-dashboard"), []);
  return (
    <div className="flex flex-col items-center justify-center pt-12 text-center">
      <div className="relative mb-6">
        <div
          className="size-32 rounded-full blur-3xl opacity-50"
          style={{ background: gradient }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <BookOpen className="size-8 text-white/80 drop-shadow-[0_0_20px_rgba(255,255,255,0.15)]" />
        </div>
      </div>
      <h3 className="mb-5 text-xl font-bold tracking-tight text-foreground">
        {t("project.heroTitle")}
      </h3>
      <p className="mb-8 text-sm text-muted-foreground">
        {t("project.heroDescription")}
      </p>
      <Button
        onClick={onCreate}
        size="lg"
        className="gap-2 rounded-[10px] px-6"
      >
        <Plus className="size-4" />
        {t("project.heroButton")}
      </Button>
    </div>
  );
}

function TabEmpty({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/30 px-6 py-12 text-center">
      <h3 className="mb-1 text-base font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

function ActiveEmptyWithCreate({
  onCreate,
}: {
  onCreate: () => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7">
      <div>
        <CreateProjectCard onCreate={onCreate} />
      </div>
    </div>
  );
}

function PurgeDialog({
  name,
  open,
  onOpenChange,
  onConfirm,
}: {
  name: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const canConfirm = input.trim() === name;

  // Reset input when dialog closes
  const handleOpenChange = (v: boolean) => {
    if (!v) setInput("");
    onOpenChange(v);
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("project.purgeDialog.title", { name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("project.purgeDialog.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="relative mt-5 flex flex-col gap-2">
          <label className="text-sm font-medium text-muted-foreground">
            {t("project.purgeDialog.typeHint")}
          </label>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={name}
            autoFocus
            className="h-11 rounded-md border-white/12 bg-white/[0.04] px-3 text-sm placeholder:text-muted-foreground/60 focus-visible:border-white/25 focus-visible:ring-2 focus-visible:ring-white/8 dark:bg-white/[0.04]"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!canConfirm}
            className="min-w-24"
            onClick={() => {
              onConfirm();
              handleOpenChange(false);
            }}
          >
            {t("project.purgeDialog.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ArchiveDialog({
  name,
  open,
  onOpenChange,
  onConfirm,
}: {
  name: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("project.archiveDialog.title", { name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("project.archiveDialog.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {t("project.archiveDialog.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteDialog({
  name,
  open,
  onOpenChange,
  onConfirm,
}: {
  name: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("project.deleteDialog.title", { name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("project.deleteDialog.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {t("project.deleteDialog.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ProjectDashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("updated-desc");
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [recentlyCreatedProject, setRecentlyCreatedProject] = useState<
    string | null
  >(() => readRecentlyCreatedProject());
  const [pending, setPending] = useState<PendingAction | null>(null);
  // Project pending the "open in Freezone?" prompt after creation.
  const [shareProject, setShareProject] = useState<ProjectSummary | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const statusCounts = useProjectCounts();
  const allSummaries = useAllProjectSummaries();
  // Only animate the grid entry on a cold load (data wasn't cached). When the
  // user navigates back from a project page, the Sidebar has already warmed
  // the query — render instantly instead of flashing an empty grid.
  const [wasColdOnMount] = useState(() => allSummaries.isLoading);
  const currentTab = useAppStore((s) => s.dashboardTab);
  const setCurrentTab = useAppStore((s) => s.setDashboardTab);
  const view = useAppStore((s) => s.dashboardView);
  const setView = useAppStore((s) => s.setDashboardView);
  const createProject = useCreateProject();
  const archive = useArchiveProject();
  const unarchive = useUnarchiveProject();
  const softDelete = useSoftDeleteProject();
  const restore = useRestoreProject();
  const purge = usePurgeProject();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const contentEditable = (e.target as HTMLElement | null)
        ?.isContentEditable;
      if (contentEditable) return;
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const totalProjects =
    statusCounts.active + statusCounts.archived + statusCounts.deleted;

  // Search filter (client-side). TODO(backend): move to server-side `?q=` when
  // project list grows beyond ~500 items.
  const matchesSearch = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (p: ProjectSummary) => (q ? p.name.toLowerCase().includes(q) : true);
  }, [search]);

  const all = allSummaries.data ?? [];

  const activeList = useMemo(
    () => {
      const sorted = sortSummaries(
        all.filter((p) => p.status === "active" && matchesSearch(p)),
        sort,
      );
      return prioritizeRecentlyCreatedProject(sorted, recentlyCreatedProject);
    },
    [all, matchesSearch, recentlyCreatedProject, sort],
  );
  const archivedList = useMemo(
    () =>
      sortSummaries(
        all.filter((p) => p.status === "archived" && matchesSearch(p)),
        sort,
      ),
    [all, matchesSearch, sort],
  );
  const deletedList = useMemo(
    () =>
      sortSummaries(
        all.filter((p) => p.status === "deleted" && matchesSearch(p)),
        sort,
      ),
    [all, matchesSearch, sort],
  );
  const trimmedNewName = newName.trim();
  const existingProject = useMemo(
    () => (trimmedNewName ? all.find((p) => p.name === trimmedNewName) : null),
    [all, trimmedNewName],
  );
  const hasInvalidProjectName = !!trimmedNewName && !PROJECT_NAME_PATTERN.test(trimmedNewName);
  const createNameError = hasInvalidProjectName
    ? t("project.nameInvalid")
    : existingProject?.status === "active"
      ? t("project.nameExistsActive")
      : existingProject?.status === "archived"
        ? t("project.nameExistsArchived")
        : existingProject?.status === "deleted"
          ? t("project.nameExistsDeleted")
          : null;
  const handleCreate = async () => {
    const name = trimmedNewName;
    if (!name || createNameError) return;
    try {
      const res = await createProject.mutateAsync(name);
      const createdName = res.data.name || name;
      setRecentlyCreatedProject(createdName);
      window.localStorage.setItem(RECENTLY_CREATED_PROJECT_KEY, createdName);
      setNewName("");
      setCreateOpen(false);
    } catch {
      toast.error(t("project.toasts.createFailed"));
    }
  };

  // 进项目恢复上次停留的区块（虾画 / 虾集子页，默认虾画）；上次在虾镜且
  // 有剧集深链则直达该集。
  const resolveProjectEntry = useCallback((project: string): string => {
    const section =
      useProjectNavStore.getState().lastSectionByProject[project] ?? "freezone";
    if (section === "episodes") {
      const remembered =
        useEpisodeWorkbenchStore.getState().lastEpisodeLocationByProject[project];
      if (remembered) {
        const normalized = normalizeLastEpisodeLocation(project, remembered);
        if (normalized) return normalized;
      }
    }
    return PROJECT_SECTION_ROUTES[section] ?? PROJECT_SECTION_ROUTES.freezone;
  }, []);

  const openProject = (project: string) =>
    navigate({ to: resolveProjectEntry(project), params: { project } });
  const preloadProject = useCallback(
    (project: string) => {
      void router
        .preloadRoute({ to: resolveProjectEntry(project), params: { project } })
        .catch(() => undefined);
    },
    [resolveProjectEntry, router],
  );

  const runWithUndo = (
    name: string,
    forward: () => void,
    undo: () => void,
    toastKey: string,
  ) => {
    forward();
    toast.success(t(toastKey, { name }), {
      action: {
        label: t("project.toasts.undo"),
        onClick: undo,
      },
    });
  };

  const onAction = (
    summary: ProjectSummary,
    action: "archive" | "unarchive" | "delete" | "restore" | "purge",
  ) => {
    const project = projectRouteParam(summary);
    const { name } = summary;
    if (action === "archive") return setPending({ kind: "archive", project, name });
    if (action === "delete") return setPending({ kind: "delete", project, name });
    if (action === "purge") return setPending({ kind: "purge", project, name });
    if (action === "unarchive") {
      return runWithUndo(
        name,
        () => unarchive.mutate(project),
        () => archive.mutate(project),
        "project.toasts.unarchived",
      );
    }
    if (action === "restore") {
      return runWithUndo(
        name,
        () => restore.mutate(project),
        () => softDelete.mutate(project),
        "project.toasts.restored",
      );
    }
  };

  const confirmPending = () => {
    if (!pending) return;
    const { kind, project, name } = pending;
    if (kind === "archive") {
      runWithUndo(
        name,
        () => archive.mutate(project),
        () => unarchive.mutate(project),
        "project.toasts.archived",
      );
    } else if (kind === "delete") {
      runWithUndo(
        name,
        () => softDelete.mutate(project),
        () => restore.mutate(project),
        "project.toasts.deleted",
      );
    } else if (kind === "purge") {
      purge.mutate(project);
      toast.success(t("project.toasts.purged", { name }));
    }
    setPending(null);
  };

  return (
    <div className="mx-auto w-full max-w-7xl">
      {/* Header strip */}
      <div className="mb-10 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            {t("project.dashboardTitle")}
          </h1>
          <p className="mt-[12px] text-[13px] font-medium text-muted-foreground">
            {t("project.dashboardSubtitle")}
          </p>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {totalProjects > 0 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("project.searchPlaceholder")}
                className="h-9 w-[min(15rem,calc(100vw-3rem))] rounded-full border-border bg-transparent pl-8 focus-visible:border-foreground/20 focus-visible:ring-2 focus-visible:ring-white/8 md:text-xs dark:bg-transparent"
              />
            </div>
          )}
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogContent className="gap-4 overflow-hidden rounded-2xl border border-white/8 bg-background/68 p-7 shadow-none backdrop-blur-3xl sm:max-w-md">
              <DialogHeader className="gap-2">
                <DialogTitle className="flex items-center gap-2 text-lg font-medium tracking-tight">
                  <span aria-hidden="true">✨</span>
                  <span>{t("project.create")}</span>
                </DialogTitle>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t("project.emptyDescription")}
                </p>
              </DialogHeader>
              <div className="mt-2 flex flex-col gap-2">
                <div className="relative">
                  <Input
                    id="project-name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={t("project.namePlaceholder")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleCreate();
                      }
                    }}
                    aria-invalid={!!createNameError || undefined}
                    aria-describedby={createNameError ? "project-name-error" : undefined}
                    autoFocus
                    className="h-11 rounded-[8px] border-white/12 bg-white/[0.04] px-3 pr-10 text-sm placeholder:text-muted-foreground/70 focus-visible:border-white/25 focus-visible:ring-2 focus-visible:ring-white/8 dark:bg-white/[0.04]"
                  />
                  {newName && (
                    <button
                      type="button"
                      onClick={() => setNewName("")}
                      className="absolute right-2 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
                      aria-label={t("project.clearName")}
                    >
                      <XIcon className="size-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
                {createNameError && (
                  <p
                    id="project-name-error"
                    className="text-xs text-destructive"
                  >
                    {createNameError}
                  </p>
                )}
              </div>
              <DialogFooter className="-mx-7 -mb-7 border-t-0 bg-transparent p-7 pt-3 sm:flex-row sm:justify-end">
                <Button
                  variant="outline"
                  onClick={() => setCreateOpen(false)}
                  className="h-10 w-18 rounded-md border-white/18 bg-white/[0.06] px-0 text-sm font-normal text-foreground/80 hover:border-white/28 hover:bg-white/[0.1] hover:text-foreground"
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={
                    createProject.isPending || !trimmedNewName || !!createNameError
                  }
                  className="h-10 w-18 rounded-md bg-primary px-0 text-sm font-normal text-primary-foreground shadow-lg shadow-primary/15 hover:bg-primary/90"
                >
                  {createProject.isPending && (
                    <Loader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  {t("common.confirm")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Tab strip + sort */}
      <div className="mb-10 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2">
          <DashboardTabStrip
            current={currentTab}
            counts={statusCounts}
            onChange={setCurrentTab}
          />
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger
              size="sm"
              className="h-8 gap-1 rounded-full border-border bg-transparent px-3 text-xs text-muted-foreground hover:bg-foreground/[0.04] data-[size=sm]:h-8 data-[size=sm]:rounded-full dark:bg-transparent dark:hover:bg-foreground/[0.04]"
            >
              <SelectValue>
                {(value: string) => {
                  const opt = SORT_OPTIONS.find((o) => o.value === value);
                  return opt ? t(opt.labelKey) : value;
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent
              align="end"
              sideOffset={8}
              alignItemWithTrigger={false}
              className="w-40 rounded-md p-1 shadow-xl shadow-black/20 data-[align-trigger=true]:animate-in [&_[data-slot=select-item]]:min-h-8 [&_[data-slot=select-item]]:rounded-sm [&_[data-slot=select-item]]:px-2 [&_[data-slot=select-item]]:py-1.5 [&_[data-slot=select-item]]:text-xs [&_[data-slot=select-item]:focus]:bg-white/8 [&_[data-slot=select-item]:focus]:text-current [&_[data-slot=select-item]_svg]:size-3.5"
            >
              {SORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {t(opt.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {currentTab === "deleted" && deletedList.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t("project.trashRetentionHint")}
          </p>
        )}
        <div className="ml-auto flex items-center">
          <ViewToggle value={view} onChange={setView} />
        </div>
      </div>

      {/* Grid / list / empty states */}
      {allSummaries.isLoading ? (
        view === "list" ? (
          <LoadingList />
        ) : (
          <LoadingGrid size="md" />
        )
      ) : (
        (() => {
          const list =
            currentTab === "active"
              ? activeList
              : currentTab === "archived"
                ? archivedList
                : deletedList;

          if (list.length === 0) {
            if (currentTab === "active") {
              const realProjects = statusCounts.active + statusCounts.archived;
              return realProjects === 0 ? (
                <FirstTimeEmpty onCreate={() => setCreateOpen(true)} />
              ) : (
                <ActiveEmptyWithCreate
                  onCreate={() => setCreateOpen(true)}
                />
              );
            }
            if (currentTab === "archived") {
              return (
                <TabEmpty
                  title={t("project.emptyArchived")}
                  description={t("project.emptyArchivedDescription")}
                />
              );
            }
            return (
              <TabEmpty
                title={t("project.emptyTrash")}
                description={t("project.emptyTrashDescription")}
              />
            );
          }

          return (
            <motion.div
              initial={wasColdOnMount ? "hidden" : false}
              animate="visible"
              variants={{
                hidden: {},
                visible: { transition: { staggerChildren: 0.03 } },
              }}
              className={cn(
                view === "list"
                  ? "flex flex-col gap-3"
                  : "grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7",
              )}
            >
              {currentTab === "active" && view === "card" && (
                <motion.div
                  className="h-full w-full"
                  variants={{
                    hidden: { opacity: 0.6 },
                    visible: {
                      opacity: 1,
                      transition: { duration: 0.12, ease: "easeOut" },
                    },
                  }}
                >
                  <CreateProjectCard onCreate={() => setCreateOpen(true)} />
                </motion.div>
              )}
              {list.slice(0, 20).map((summary) => (
                <motion.div
                  key={projectRouteParam(summary)}
                  variants={{
                    hidden: { opacity: 0.6 },
                    visible: {
                      opacity: 1,
                      transition: { duration: 0.12, ease: "easeOut" },
                    },
                  }}
                >
                  {view === "list" ? (
                    <ProjectRow
                      summary={summary}
                      onOpen={() => openProject(projectRouteParam(summary))}
                      onPreload={() => preloadProject(projectRouteParam(summary))}
                      onShare={() => setShareProject(summary)}
                      onAction={(action) => onAction(summary, action)}
                    />
                  ) : (
                    <ProjectCard
                      summary={summary}
                      size="md"
                      onOpen={() => openProject(projectRouteParam(summary))}
                      onPreload={() => preloadProject(projectRouteParam(summary))}
                      onShare={() => setShareProject(summary)}
                      onAction={(action) => onAction(summary, action)}
                    />
                  )}
                </motion.div>
              ))}
              {list
                .slice(20)
                .map((summary) =>
                  view === "list" ? (
                    <ProjectRow
                      key={projectRouteParam(summary)}
                      summary={summary}
                      onOpen={() => openProject(projectRouteParam(summary))}
                      onPreload={() => preloadProject(projectRouteParam(summary))}
                      onShare={() => setShareProject(summary)}
                      onAction={(action) => onAction(summary, action)}
                    />
                  ) : (
                    <ProjectCard
                      key={projectRouteParam(summary)}
                      summary={summary}
                      size="md"
                      onOpen={() => openProject(projectRouteParam(summary))}
                      onPreload={() => preloadProject(projectRouteParam(summary))}
                      onShare={() => setShareProject(summary)}
                      onAction={(action) => onAction(summary, action)}
                    />
                  ),
                )}
            </motion.div>
          );
        })()
      )}

      {/* Dialogs */}
      <ArchiveDialog
        name={pending?.kind === "archive" ? pending.name : ""}
        open={pending?.kind === "archive"}
        onOpenChange={(v) => !v && setPending(null)}
        onConfirm={confirmPending}
      />
      <DeleteDialog
        name={pending?.kind === "delete" ? pending.name : ""}
        open={pending?.kind === "delete"}
        onOpenChange={(v) => !v && setPending(null)}
        onConfirm={confirmPending}
      />
      <PurgeDialog
        name={pending?.kind === "purge" ? pending.name : ""}
        open={pending?.kind === "purge"}
        onOpenChange={(v) => !v && setPending(null)}
        onConfirm={confirmPending}
      />
      <ShareProjectDialog
        project={shareProject}
        open={!!shareProject}
        onOpenChange={(open) => {
          if (!open) setShareProject(null);
        }}
      />
    </div>
  );
}

export const Route = createFileRoute("/_app/")({
  component: ProjectDashboard,
});
