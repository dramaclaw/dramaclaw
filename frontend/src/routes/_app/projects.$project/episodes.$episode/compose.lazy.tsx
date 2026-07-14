// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createLazyFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ArrowUpRight,
  Download,
  FileText,
  Film,
  Loader2,
  Subtitles,
} from "lucide-react";

import { useComposeEpisode, useFinalVideo } from "@/lib/queries/video";
import { useEpisodeBeats, useEpisodeDetail } from "@/lib/queries/episodes";
import { useProject, useUpdateProject } from "@/lib/queries/projects";
import { useTaskController } from "@/hooks/use-task-controller";
import { useBeatStates } from "@/hooks/use-beat-states";
import { queryKeys } from "@/lib/query-keys";
import { api } from "@/lib/api";
import { p } from "@/lib/api-path";
import { type StageId } from "@/lib/episode-stage-registry";
import {
  orientationForAspectRatio,
  type Orientation,
} from "@/lib/aspect-ratio";
import { EpisodeEmptyState } from "@/components/episode/episode-empty-state";
import { StageProgressPanel } from "@/components/stage-progress-panel";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Resolution = "720x1280" | "1080x1920" | "1280x720" | "1920x1080";
type ResolutionTier = "720" | "1080";
type TFn = ReturnType<typeof useTranslation>["t"];
type BlockerStage = Exclude<StageId, "compose">;

function formatDuration(totalSeconds: number): string | null {
  if (!totalSeconds || totalSeconds <= 0) return null;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function resolutionLabel(resolution: Resolution): string {
  return resolutionTier(resolution) === "1080" ? "1080p" : "720p";
}

function resolutionTier(value: string | undefined | null): ResolutionTier {
  return value === "1080x1920" || value === "1920x1080" ? "1080" : "720";
}

function resolutionFor(tier: ResolutionTier, orientation: Orientation): Resolution {
  if (orientation === "landscape") {
    return tier === "1080" ? "1920x1080" : "1280x720";
  }
  return tier === "1080" ? "1080x1920" : "720x1280";
}

function resolutionOptions(orientation: Orientation): Resolution[] {
  return [resolutionFor("720", orientation), resolutionFor("1080", orientation)];
}

function MetaDot() {
  return <span className="text-muted-foreground/40">·</span>;
}

// ── InlineSwitch — lightweight toggle switch ────────────────────────

function InlineSwitch({
  checked,
  onChange,
  icon: Icon,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  icon: React.ElementType;
  label: string;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5">
      <span className="relative inline-flex h-4 w-7 shrink-0 items-center">
        <input
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          onChange={onChange}
        />
        <span className="absolute inset-0 rounded-full bg-white/[0.1] transition-colors peer-checked:bg-primary/40" />
        <span className="absolute left-[2px] top-[2px] h-3 w-3 rounded-full bg-white/60 transition-all peer-checked:translate-x-3" />
      </span>
      <span className={cn(
        "flex items-center gap-1 text-[12px] transition-colors",
        checked ? "text-foreground" : "text-muted-foreground",
      )}>
        <Icon className="size-3" />
        {label}
      </span>
    </label>
  );
}

function ComposeTabContent() {
  const { t } = useTranslation();
  const { project, episode } = Route.useParams();
  const epNum = parseInt(episode, 10);
  const composeEpisode = useComposeEpisode(project, epNum);
  const { counts } = useBeatStates(project, epNum);
  const beatsRes = useEpisodeBeats(project, epNum);
  const episodeRes = useEpisodeDetail(project, epNum);
  const projectConfigRes = useProject(project);
  const updateProject = useUpdateProject(project);
  const finalVideoRes = useFinalVideo(project, epNum);
  const canCompose = counts.compose.ready;
  const projectConfig = projectConfigRes.data?.data;
  const orientation = orientationForAspectRatio(projectConfig?.aspect_ratio) ?? "portrait";

  const [addSubtitles, setAddSubtitles] = useState(true);
  const [resolution, setResolution] = useState<Resolution>("720x1280");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [composeConfirm, setComposeConfirm] = useState(false);

  useEffect(() => {
    setResolution(
      resolutionFor(resolutionTier(projectConfig?.video_resolution), orientation),
    );
  }, [orientation, projectConfig?.video_resolution]);

  useEffect(() => {
    setAddSubtitles(projectConfig?.add_subtitles ?? true);
  }, [projectConfig?.add_subtitles]);

  const persistComposePrefs = useCallback(
    (updates: { video_resolution?: Resolution; add_subtitles?: boolean }) => {
      void updateProject
        .mutateAsync(updates)
        .catch(() => toast.error(t("common.error")));
    },
    [t, updateProject],
  );

  const handleResolutionChange = useCallback(
    (value: string | null) => {
      const next = resolutionFor(resolutionTier(value), orientation);
      setResolution(next);
      persistComposePrefs({ video_resolution: next });
    },
    [orientation, persistComposePrefs],
  );

  const handleAddSubtitlesChange = useCallback(() => {
    const next = !addSubtitles;
    setAddSubtitles(next);
    persistComposePrefs({ add_subtitles: next });
  }, [addSubtitles, persistComposePrefs]);

  // Mirrors the old NiceGUI filename convention (videos/episodes/ep{NNN}_final.mp4).
  // The backend writes to this fixed path — display-only.
  const outputFilename = `ep${String(epNum).padStart(3, "0")}_final.mp4`;

  // The compose gate requires audio + video per beat (matches BE actor
  // pre-flight). `counts.video.total` is the canonical total beat count.
  const totalBeats = counts.video.total;

  const beats = beatsRes.data?.data ?? [];
  const totalDurationSec = beats.reduce(
    (acc, b) => acc + (b.estimated_duration ?? 0),
    0,
  );
  const durationLabel = formatDuration(totalDurationSec);

  // De-dup: trust the episode title when present, else fall back to the
  // "第 N 集" header. Previous layout rendered both, which produced the
  // "第 1 集 · 第1集" double-up when the title itself follows that pattern.
  const rawTitle = episodeRes.data?.data?.title?.trim();
  const displayTitle =
    rawTitle && rawTitle.length > 0
      ? rawTitle
      : t("episode.compose.episodeHeader", { n: epNum });

  const task = useTaskController({
    key: {
      // BE emits `compose_episode`, not `video_compose`.
      taskType: "compose_episode",
      project,
      episode: epNum,
    },
    invalidateKeys: [
      queryKeys.pipelineStatus(project),
      queryKeys.videoPool(project, epNum),
      queryKeys.beats(project, epNum),
      queryKeys.finalVideo(project, epNum),
    ],
    onComplete: (result) => {
      const r = result as { video_url?: string; url?: string } | null;
      const u = r?.video_url ?? r?.url;
      if (u) setResultUrl(u);
    },
  });

  const isComposing = task.started || composeEpisode.isPending;

  const beatsLoading = beatsRes.isLoading;
  const beatsEmpty = !beatsLoading && beats.length === 0;

  // Hydrate on mount / refetch: if a final video already exists on disk, show
  // the preview + download without waiting for an SSE. Skipped while compose
  // is running (the fresh render wins), and never clobbers a URL we just
  // received from `onComplete`.
  const hydratedUrl = finalVideoRes.data?.data?.exists
    ? finalVideoRes.data?.data?.video_url
    : null;
  useEffect(() => {
    if (isComposing) return;
    if (resultUrl) return;
    if (hydratedUrl) setResultUrl(hydratedUrl);
  }, [hydratedUrl, isComposing, resultUrl]);

  const handleCompose = async () => {
    try {
      setResultUrl(null);
      await composeEpisode.mutateAsync({
        add_subtitles: addSubtitles,
        add_bgm: false,
        resolution,
      });
      task.start();
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleDownloadVideo = async () => {
    try {
      const res = await api.get(
        p`api/v1/projects/${project}/episodes/${epNum}/export/video`,
      );
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `${project}_${outputFilename}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 2_000);
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleExport = async (suffix: "srt" | "zip") => {
    try {
      const res =
        suffix === "zip"
          ? await api.post(
            p`api/v1/projects/${project}/episodes/${epNum}/export/zip`,
          )
          : await api.get(
            p`api/v1/projects/${project}/episodes/${epNum}/export/srt`,
          );
      const blob = await res.blob();
      const filename = `${project}_ep${epNum}.${suffix}`;
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 2_000);
    } catch {
      toast.error(t("common.error"));
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Compose confirm dialog */}
      <AlertDialog open={composeConfirm} onOpenChange={setComposeConfirm}>
        <AlertDialogContent className="max-w-[480px] rounded-2xl border-white/8 bg-background/80 p-6 shadow-none backdrop-blur-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-center text-base font-semibold text-foreground">
              {t("episode.compose.composeTitle", { title: displayTitle })}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-center text-sm text-muted-foreground">
              {t("episode.compose.composeDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t("episode.compose.beats")}
              </div>
              <div className="mt-0.5 text-sm font-medium text-foreground">
                {totalBeats || "—"}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t("episode.compose.duration")}
              </div>
              <div className="mt-0.5 text-sm font-medium text-foreground">
                {durationLabel ?? "—"}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t("episode.compose.resolution")}
              </div>
              <div className="mt-0.5 text-sm font-medium text-foreground">
                {resolutionLabel(resolution)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t("episode.compose.options")}
              </div>
              <div className="mt-0.5 text-sm font-medium text-foreground">
                {addSubtitles ? t("episode.compose.subtitlesOn") : t("episode.compose.subtitlesOff")}
              </div>
            </div>
          </div>
          <AlertDialogFooter className="gap-2 pt-2">
            <AlertDialogCancel className="h-10 rounded-lg border-white/18 bg-white/[0.06] px-4 text-sm font-normal text-foreground/80 hover:border-white/28 hover:bg-white/[0.1] hover:text-foreground">
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-10 gap-1.5 rounded-lg bg-primary px-4 text-sm font-normal text-primary-foreground shadow-lg shadow-primary/15 hover:bg-primary/90"
              onClick={() => {
                setComposeConfirm(false);
                handleCompose();
              }}
            >
              <Film className="size-4" />
              {t("episode.compose.composeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Main area */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 p-6 sm:p-8">
          {/* Header: title + meta, actions on the right */}
          {!beatsEmpty && (
            <header className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-xl font-semibold text-foreground sm:text-2xl">
                  {displayTitle}
                </h1>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="font-mono">{outputFilename}</span>
                  {resultUrl ? (
                    <>
                      <MetaDot />
                      <span>{resolutionLabel(resolution)}</span>
                      <MetaDot />
                      <span>
                        {addSubtitles
                          ? t("episode.compose.subtitlesOn")
                          : t("episode.compose.subtitlesOff")}
                      </span>
                      {durationLabel ? (
                        <>
                          <MetaDot />
                          <span>{durationLabel}</span>
                        </>
                      ) : null}
                    </>
                  ) : durationLabel ? (
                    <>
                      <MetaDot />
                      <span>
                        {t("episode.compose.durationApprox", { value: durationLabel })}
                      </span>
                    </>
                  ) : null}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleExport("srt")}
                  className="gap-1.5"
                >
                  <FileText className="size-3.5" />
                  {t("episode.compose.exportSrt")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleExport("zip")}
                  className="gap-1.5"
                >
                  <Download className="size-3.5" />
                  {t("episode.compose.exportZip")}
                </Button>
                {resultUrl ? (
                  <>
                    <Button
                      size="sm"
                      onClick={() => void handleDownloadVideo()}
                      className="gap-1.5"
                    >
                      <Download className="size-3.5" />
                      {t("episode.compose.downloadVideo")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setComposeConfirm(true)}
                      disabled={!canCompose || isComposing}
                      className="gap-1.5"
                    >
                      {isComposing ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Film className="size-3.5" />
                      )}
                      {t("episode.compose.recomposeEpisode")}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => setComposeConfirm(true)}
                    disabled={!canCompose || isComposing}
                    className="gap-1.5 bg-primary text-primary-foreground shadow-none hover:bg-primary/85 active:bg-primary/75"
                  >
                    {isComposing ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Film className="size-3.5" />
                    )}
                    {t("episode.compose.composeEpisode")}
                  </Button>
                )}
              </div>
            </header>
          )}

          {!beatsEmpty && <hr className="border-border/30" />}

          {/* Config row + warning: below divider */}
          {!beatsEmpty && !resultUrl && !isComposing && (
            <div className="flex flex-col gap-5 pb-2 pt-1 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
              <div className="min-w-0 space-y-1.5">
                <h2 className="text-base font-semibold text-amber-400">
                  {t("episode.compose.blockerCount", { count: counts.compose.missing.length })}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {t("episode.compose.blockerSubtitle")}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-6">
                {/* Resolution */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] text-muted-foreground">{t("episode.compose.resolution")}:</span>
                  <Select value={resolution} onValueChange={handleResolutionChange}>
                    <SelectTrigger className="!h-7 w-28 rounded-[6px] border border-white/10 bg-transparent py-0 text-[12px] font-medium text-foreground/85">
                      <SelectValue>{() => resolutionLabel(resolution)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {resolutionOptions(orientation).map((value) => (
                        <SelectItem key={value} value={value}>
                          {resolutionLabel(value)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Switches */}
                <InlineSwitch
                  checked={addSubtitles}
                  onChange={handleAddSubtitlesChange}
                  icon={Subtitles}
                  label={t("video.addSubtitles")}
                />
              </div>
            </div>
          )}

          {/* Content below divider */}
          {resultUrl ? (
            // Vertical (9:16) drama clips are taller than they are wide.
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
              <video
                src={resultUrl}
                controls
                className="block max-h-full max-w-full rounded-lg"
              />
            </div>
          ) : beatsLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("episode.beats.loading")}
            </div>
          ) : beatsEmpty ? (
            <EpisodeEmptyState
              icon={Film}
              title={t("episode.compose.noClips")}
              description={t("episode.compose.noClipsHint")}
            />
          ) : isComposing ? (
            <StageProgressPanel
              title={t("episode.compose.composing")}
              currentTask={task.stream.currentTask}
              progress={task.stream.progress}
              logs={task.logs}
              onStop={task.stop}
              stopping={task.stopping}
            />
          ) : (
            <>
              {/* Beat grid — lightweight cards */}
              {counts.compose.missing.length > 0 && (
                <BeatBlockerGrid
                  project={project}
                  episode={epNum}
                  missing={counts.compose.missing}
                  t={t}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── BeatBlockerGrid — lightweight cards, no amber container ────────

function BeatBlockerGrid({
  project,
  episode,
  missing,
  t,
}: {
  project: string;
  episode: number;
  missing: { beatNum: number; stages: BlockerStage[] }[];
  t: TFn;
}) {
  const navigate = useNavigate();
  const jump = (beatNum: number) => {
    void navigate({
      to: "/projects/$project/episodes/$episode/beats",
      params: { project, episode: String(episode) },
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        focusBeat: beatNum,
      })) as never,
    });
  };

  return (
    <div className="grid grid-cols-2 gap-4 pb-8 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
      {missing.map(({ beatNum, stages }) => (
        <button
          key={beatNum}
          type="button"
          onClick={() => jump(beatNum)}
          className="group relative flex min-h-[92px] flex-col rounded-[8px] border border-white/10 bg-white/[0.03] px-6 py-3.5 text-left transition-all duration-[350ms] hover:scale-[1.015] hover:border-primary/30 hover:bg-primary/[0.06]"
        >
          <ArrowUpRight className="absolute right-3 top-3 size-3.5 text-muted-foreground opacity-0 transition-opacity duration-[350ms] group-hover:opacity-100" />
          <div className="space-y-2.5">
            <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
              {t("episode.compose.beatLabel")}
            </span>
            <span className="block text-2xl font-semibold tabular-nums leading-none text-foreground">
              {beatNum}
            </span>
          </div>
          <p className="mt-2.5 text-xs leading-4 text-muted-foreground">
            {t("episode.compose.missingItems", {
              items: stages
                .map((s) => t(`episode.stage.${s}`))
                .join(t("episode.compose.missingItemSeparator")),
            })}
          </p>
        </button>
      ))}
    </div>
  );
}

export const Route = createLazyFileRoute(
  "/_app/projects/$project/episodes/$episode/compose",
)({
  component: ComposeTabContent,
});
