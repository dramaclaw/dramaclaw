// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, Check, ChevronDown, Clapperboard, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  PROJECT_SECTION_ROUTES,
  projectModeFromPath,
  projectSectionFromPath,
} from "@/components/layout/project-navigation-routes";
import { normalizeLastEpisodeLocation, useEpisodeWorkbenchStore } from "@/stores/episode-workbench-store";
import { isRememberedSection, useProjectNavStore } from "@/stores/project-nav-store";
import { useAllProjectSummaries } from "@/lib/queries/projects";
import { getProjectCover } from "@/lib/project-cover";
import { cn } from "@/lib/utils";

const XIAJI_DEFAULT_ROUTE = PROJECT_SECTION_ROUTES.ingest;

const xiajiMenuItems = [
  { labelKey: "nav.ingest", to: PROJECT_SECTION_ROUTES.ingest },
  { labelKey: "nav.assets", to: PROJECT_SECTION_ROUTES.characters },
  {
    labelKey: "nav.episodes",
    to: PROJECT_SECTION_ROUTES.episodes,
    rememberKey: "episodes",
  },
  { labelKey: "nav.aiAssistant", to: PROJECT_SECTION_ROUTES.assistant },
  { labelKey: "nav.styles", to: PROJECT_SECTION_ROUTES.styles },
] as const;

function ProjectAvatar({ name }: { name: string }) {
  const { gradient, initial } = useMemo(() => getProjectCover(name), [name]);
  return (
    <span
      className="flex size-5 shrink-0 items-center justify-center rounded text-xs font-bold text-white/95"
      style={{ background: gradient }}
    >
      {initial}
    </span>
  );
}

export function ProjectSwitcher({ current }: { current: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: summaries } = useAllProjectSummaries();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const targetSection = projectSectionFromPath(pathname) ?? "freezone";
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const projects = useMemo(
    () =>
      (summaries ?? [])
        .filter((project) => project.status === "active")
        .map((project) => ({ id: project.id || project.name, name: project.name })),
    [summaries],
  );
  const currentSummary = useMemo(
    () =>
      projects.find((project) => project.id === current) ??
      projects.find((project) => project.name === current),
    [current, projects],
  );
  const currentName = currentSummary?.name ?? current;

  const cancelClose = () => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const openMenu = () => {
    cancelClose();
    setOpen(true);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 120);
  };

  useEffect(() => cancelClose, []);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        onMouseEnter={openMenu}
        onMouseLeave={scheduleClose}
        className="inline-flex h-8 max-w-[156px] cursor-pointer items-center gap-1.5 bg-transparent px-1 text-left text-[13px] leading-none text-sidebar-foreground/90 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <span className="min-w-0 truncate leading-none">{currentName}</span>
        <ChevronDown className="size-3.5 shrink-0 translate-y-px text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={8}
        onMouseEnter={openMenu}
        onMouseLeave={scheduleClose}
        className="w-56 rounded-md border border-white/10 bg-popover p-1 shadow-xl shadow-black/20 ring-0"
      >
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() => navigate({ to: "/" })}
            className="min-h-8 gap-2 rounded-sm px-2 py-1.5 text-xs focus:bg-white/8 focus:text-current"
          >
            <ArrowLeft className="size-3.5" />
            {t("project.dashboardReturn")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {t("nav.switchProject")}
          </DropdownMenuLabel>
          {projects.map((project) => (
            <DropdownMenuItem
              key={project.id}
              onClick={() =>
                navigate({
                  to: PROJECT_SECTION_ROUTES[targetSection],
                  params: { project: project.id },
                })
              }
              className="min-h-8 gap-2 rounded-sm px-2 py-1.5 text-xs focus:bg-white/8 focus:text-current"
            >
              <ProjectAvatar name={project.name} />
              <span className="flex-1 truncate">{project.name}</span>
              {project.id === current ? (
                <Check className="size-3.5 text-primary" aria-hidden />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 「虾集」子页菜单，作为 header 的第二行渲染 —— 它必须在文档流里占真实高度，
 * 而不是浮在内容之上：内容区是独立滚动容器，任何浮层都会被滚上来的内容穿过。
 */
export function ProjectXiajiMenu({ project }: { project: string }) {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const rememberedEpisodeLocation = useEpisodeWorkbenchStore(
    (state) => state.lastEpisodeLocationByProject[project],
  );

  if (projectModeFromPath(pathname) !== "xiaji") return null;

  return (
    <div className="flex justify-center px-4 pb-2">
      <nav
        aria-label={t("nav.xiajiMenu")}
        className="flex items-center gap-3 whitespace-nowrap rounded-full border border-white/[0.08] bg-white/[0.04] px-3.5 py-0.5 text-sidebar-foreground"
      >
        {xiajiMenuItems.map((item) => {
          const target =
            "rememberKey" in item && rememberedEpisodeLocation
              ? normalizeLastEpisodeLocation(project, rememberedEpisodeLocation) ?? item.to
              : item.to;
          // 高亮按栏目自身的路由判断：target 可能是带 ?query 的剧集深链，
          // 拿它比 pathname 永远不相等（虾镜里就不会高亮）。
          const sectionPath = item.to.replace("$project", encodeURIComponent(project));
          const active = pathname === sectionPath || pathname.startsWith(`${sectionPath}/`);
          return (
            <Link
              key={item.labelKey}
              to={target}
              params={{ project }}
              className={cn(
                "flex h-7 items-center px-1.5 text-xs font-semibold transition-colors duration-150 ease-[var(--ease-out-quint)]",
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              aria-current={active ? "page" : undefined}
            >
              {t(item.labelKey)}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export function ProjectHeaderNavigation({ project }: { project: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeMode = projectModeFromPath(pathname);
  const rememberedEpisodeLocation = useEpisodeWorkbenchStore(
    (state) => state.lastEpisodeLocationByProject[project],
  );
  const setLastEpisodeLocation = useEpisodeWorkbenchStore((state) => state.setLastEpisodeLocation);
  const clearLastEpisodeLocation = useEpisodeWorkbenchStore((state) => state.clearLastEpisodeLocation);
  const rememberSection = useProjectNavStore((state) => state.rememberSection);
  const lastXiajiSection = useProjectNavStore(
    (state) => state.lastXiajiSectionByProject[project],
  );

  // 记住当前停留的区块（虾画 / 虾集子页），进项目和切「虾集」时按此恢复。
  useEffect(() => {
    const section = projectSectionFromPath(pathname);
    if (isRememberedSection(section)) {
      rememberSection(project, section);
    }
  }, [pathname, project, rememberSection]);

  useEffect(() => {
    const episodesRoot = `/projects/${encodeURIComponent(project)}/episodes`;
    if (pathname === episodesRoot) {
      clearLastEpisodeLocation(project);
      return;
    }
    const match = pathname.match(/^\/projects\/([^/]+)\/episodes\/(\d+)(?:\/|$)/);
    if (!match || decodeURIComponent(match[1]) !== project) return;
    setLastEpisodeLocation(project, `${pathname}${window.location.search}`);
  }, [clearLastEpisodeLocation, pathname, project, setLastEpisodeLocation]);

  const changeMode = (mode: "xiahua" | "xiaji") => {
    if (mode === activeMode) return;
    if (mode === "xiahua") {
      navigate({ to: PROJECT_SECTION_ROUTES.freezone, params: { project } });
      return;
    }
    // 切「虾集」时回到上次停留的子页（默认虾料）；上次在虾镜且有剧集深链则直达。
    let target: string = lastXiajiSection
      ? PROJECT_SECTION_ROUTES[lastXiajiSection]
      : XIAJI_DEFAULT_ROUTE;
    if (lastXiajiSection === "episodes" && rememberedEpisodeLocation) {
      target =
        normalizeLastEpisodeLocation(project, rememberedEpisodeLocation) ?? target;
    }
    navigate({ to: target, params: { project } });
  };

  return (
    <nav
      aria-label={t("nav.creationMode")}
      className="absolute left-1/2 top-1/2 z-30 flex -translate-x-1/2 -translate-y-1/2 items-center"
    >
      <div className="relative flex h-8 items-center rounded-full bg-white/[0.07]">
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-0 top-1/2 h-7 w-[74px] -translate-y-1/2 rounded-full bg-foreground transition-transform duration-300 ease-[var(--ease-out-quint)]",
            activeMode === "xiaji" && "translate-x-[74px]",
          )}
        />
        <button
          type="button"
          onClick={() => changeMode("xiahua")}
          className={cn(
            "relative z-10 inline-flex h-8 w-[74px] items-center justify-center gap-1.5 rounded-full text-xs font-semibold transition-colors",
            activeMode === "xiahua"
              ? "text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
          aria-pressed={activeMode === "xiahua"}
        >
          <Sparkles className="size-3.5" />
          {t("nav.freezone")}
        </button>
        <button
          type="button"
          onClick={() => changeMode("xiaji")}
          className={cn(
            "relative z-10 inline-flex h-8 w-[74px] items-center justify-center gap-1.5 rounded-full text-xs font-semibold transition-colors",
            activeMode === "xiaji"
              ? "text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
          aria-pressed={activeMode === "xiaji"}
        >
          <Clapperboard className="size-3.5" />
          {t("nav.xiaji")}
        </button>
      </div>
    </nav>
  );
}
