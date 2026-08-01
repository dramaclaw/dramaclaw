// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Copy,
  Download,
  FileText,
  Loader2,
  RefreshCw,
  Scissors,
  Square,
  Upload,
} from "lucide-react";

import {
  useCutGrid,
  useExportGridPrompt,
  useGrids,
  useRebuildPoolIndex,
  useRegenerateGrid,
  useUploadGrid,
  type PoolImage,
} from "@/lib/queries/sketches";
import { queryKeys } from "@/lib/query-keys";
import { resolveMediaUrl } from "@/lib/media-url";
import { gridAspectCss } from "@/lib/aspect-ratio";
import {
  backendErrorToastMessage,
  BillingRuleNotConfiguredError,
} from "@/lib/api-errors";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { useRenderSettings } from "@/lib/queries/render-settings";
import { useProjectAspectRatio } from "@/stores/aspect-ratio-store";
import { useTaskController } from "@/hooks/use-task-controller";
import { CreditCostInline } from "@/components/credit-cost-inline";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { Beat } from "@/types/episode";

const GRID_ACTION_BUTTON_CLASS =
  "justify-start gap-1 rounded-[5px] px-1 text-foreground/82 shadow-none transition-colors hover:bg-transparent hover:text-foreground disabled:text-muted-foreground/45";

interface RenderGridGalleryProps {
  project: string;
  episode: number;
  beats?: Beat[];
}

interface RenderGridGroup {
  gridIndex: number;
  gridUrl: string;
  cells: PoolImage[];
  rows: number;
  cols: number;
  modeKey: string;
  beatNumbers: number[];
}

export function RenderGridGallery({
  project,
  episode,
  beats = [],
}: RenderGridGalleryProps) {
  const { t } = useTranslation();
  const { spec } = useProjectAspectRatio(project);
  const { data: gridsRes } = useGrids(project, episode);
  const rebuildPoolIndex = useRebuildPoolIndex(project, episode);
  const groups = useMemo(
    () => buildRenderGridGroups(gridsRes?.data?.images ?? [], beats),
    [beats, gridsRes?.data?.images],
  );

  const handleRebuildPoolIndex = async () => {
    try {
      const res = await rebuildPoolIndex.mutateAsync();
      toast.success(
        t("episode.workbench.renderGrid.rebuildSuccess", {
          count: res.data.image_count,
        }),
      );
    } catch {
      toast.error(t("episode.workbench.renderGrid.rebuildFailed"));
    }
  };

  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-background/50 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-muted-foreground">
          {t("episode.workbench.renderGrid.titleWithCount", {
            count: groups.length,
          })}
        </h2>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={rebuildPoolIndex.isPending}
            onClick={() => void handleRebuildPoolIndex()}
            className="h-6 gap-1 px-1.5 text-[10px]"
          >
            {rebuildPoolIndex.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {t("episode.workbench.renderGrid.rebuildIndex")}
          </Button>
        </div>
      </div>
      {groups.length === 0 ? (
        <p className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
          {t("episode.workbench.renderGrid.noIndexedGrids")}
        </p>
      ) : (
        // 卡片改自适应网格 + 纵向滚动,撑满弹窗;列宽 minmax 保证大屏多列、窄屏单列。
        <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-4 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
          {groups.map((group) => (
            <RenderGridCard
              key={group.gridIndex}
              project={project}
              episode={episode}
              group={group}
              cellAspect={spec.renderAspect}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RenderGridCard({
  project,
  episode,
  group,
  cellAspect,
}: {
  project: string;
  episode: number;
  group: RenderGridGroup;
  cellAspect: string;
}) {
  const { t } = useTranslation();
  const regenerateGrid = useRegenerateGrid(project, episode);
  const renderSettings = useRenderSettings(project);
  const cutGrid = useCutGrid(project, episode);
  const uploadGrid = useUploadGrid(project, episode);
  const exportGridPrompt = useExportGridPrompt(project, episode);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState("");
  const scope = `grid_${group.gridIndex}`;
  const regenTask = useTaskController({
    key: {
      taskType: "grid_regenerate",
      project,
      episode,
      scope,
    },
    invalidateKeys: [
      queryKeys.grids(project, episode),
      queryKeys.beats(project, episode),
      queryKeys.pipelineStatus(project),
    ],
  });
  const gridUrl = resolveMediaUrl(group.gridUrl);
  const renderImageSelection = renderSettings.data?.data.render_image_selection;
  const gridCost = useGenerationCreditCost(
    "feature",
    "mainline.render_regen",
    {
      surface: "supertale",
      imageRole: "render",
      modeKey: group.modeKey,
      params: renderImageSelection
        ? { image_selection: renderImageSelection }
        : null,
    },
  );
  const gridCostDisplay =
    gridCost.data?.data.display ??
    (gridCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);

  const handleRegenerate = async () => {
    try {
      const res = await regenerateGrid.mutateAsync({
        gridIndex: group.gridIndex,
        sceneGrouping: true,
      });
      if (res.ok === false) {
        toast.error(backendErrorToastMessage(res.error, t));
        return;
      }
      regenTask.start({ scope });
      toast.success(
        t("episode.workbench.renderGrid.regenStarted", {
          n: group.gridIndex,
        }),
      );
    } catch (error) {
      toast.error(backendErrorToastMessage(error, t));
    }
  };

  const handleCut = async () => {
    try {
      const res = await cutGrid.mutateAsync({
        gridIndex: group.gridIndex,
        rows: group.rows,
        cols: group.cols,
        modeKey: group.modeKey,
        beatNumbers: group.beatNumbers,
        gridType: "render",
      });
      if (res.ok === false) {
        toast.error(res.error || t("episode.workbench.renderGrid.cutFailed"));
        return;
      }
      toast.success(
        t("episode.workbench.renderGrid.cutSuccess", {
          n: group.gridIndex,
        }),
      );
    } catch {
      toast.error(t("episode.workbench.renderGrid.cutFailed"));
    }
  };

  const handleUploadChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const res = await uploadGrid.mutateAsync({
        gridIndex: group.gridIndex,
        file,
        gridType: "render",
        modeKey: group.modeKey,
        beatNumbers: group.beatNumbers,
      });
      if (res.ok === false) {
        toast.error(res.error || t("episode.workbench.renderGrid.uploadFailed"));
        return;
      }
      toast.success(
        t("episode.workbench.renderGrid.uploadSuccess", {
          n: group.gridIndex,
        }),
      );
    } catch {
      toast.error(t("episode.workbench.renderGrid.uploadFailed"));
    }
  };

  const handleExportPrompt = async () => {
    try {
      const res = await exportGridPrompt.mutateAsync({
        gridIndex: group.gridIndex,
        gridType: "render",
        modeKey: group.modeKey,
        beatNumbers: group.beatNumbers,
      });
      if (res.ok === false) {
        toast.error(res.error || t("episode.workbench.renderGrid.promptFailed"));
        return;
      }
      setPromptText(res.data.prompt);
      setPromptOpen(true);
    } catch {
      toast.error(t("episode.workbench.renderGrid.promptFailed"));
    }
  };

  const handleCopyPrompt = async () => {
    await navigator.clipboard?.writeText(promptText);
    toast.success(t("episode.workbench.renderGrid.copySuccess"));
  };

  const handleDownload = () => {
    if (!gridUrl) return;
    const a = document.createElement("a");
    a.href = gridUrl;
    a.download = `render_grid_${group.gridIndex}.png`;
    a.click();
  };

  return (
    <article className="flex min-w-0 flex-col gap-2 rounded-md border border-white/10 bg-transparent p-2">
      <button
        type="button"
        disabled={!gridUrl}
        onClick={() => gridUrl && window.open(gridUrl, "_blank", "noopener,noreferrer")}
        className="overflow-hidden rounded border border-white/10 bg-black/20 disabled:cursor-default"
        style={{ aspectRatio: gridAspectCss(group.cols, group.rows, cellAspect) }}
      >
        {gridUrl ? (
          <img
            src={gridUrl}
            alt={t("episode.workbench.renderGrid.gridLabel", {
              n: group.gridIndex,
            })}
            className="h-full w-full object-contain"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {t("episode.workbench.renderGrid.noPreview")}
          </span>
        )}
      </button>
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-medium">
            {t("episode.workbench.renderGrid.gridLabel", {
              n: group.gridIndex,
            })}
          </span>
          <span className="text-muted-foreground">
            {group.rows}x{group.cols}
          </span>
        </div>
        <p className="truncate text-[11px] text-muted-foreground">
          {t("episode.workbench.renderGrid.cellCount", {
            count: group.cells.length,
          })}
          {" · B"}
          {formatBeatRange(group.beatNumbers)}
        </p>
      </div>
      <div className="flex flex-wrap gap-1">
        {regenTask.started ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => void regenTask.stop()}
            disabled={regenTask.stopping}
            className={GRID_ACTION_BUTTON_CLASS}
          >
            {regenTask.stopping ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Square className="size-3" />
            )}
            {t("common.stop")}
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={handleRegenerate}
            disabled={regenerateGrid.isPending}
            className={GRID_ACTION_BUTTON_CLASS}
          >
            {regenerateGrid.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {t("common.regenerate")}
            <CreditCostInline
              display={gridCostDisplay}
              promotion={gridCost.data?.data.promotion}
            />
          </Button>
        )}
        <input
          ref={uploadInputRef}
          type="file"
          accept="image/*"
          aria-label={t("episode.workbench.renderGrid.uploadGrid")}
          className="sr-only"
          onChange={(event) => void handleUploadChange(event)}
        />
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => uploadInputRef.current?.click()}
          disabled={uploadGrid.isPending}
          className={GRID_ACTION_BUTTON_CLASS}
        >
          {uploadGrid.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Upload className="size-3" />
          )}
          {t("episode.workbench.renderGrid.uploadGrid")}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={handleExportPrompt}
          disabled={exportGridPrompt.isPending}
          className={GRID_ACTION_BUTTON_CLASS}
        >
          {exportGridPrompt.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <FileText className="size-3" />
          )}
          {t("episode.workbench.renderGrid.exportPrompt")}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={handleCut}
          disabled={cutGrid.isPending}
          className={GRID_ACTION_BUTTON_CLASS}
        >
          {cutGrid.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Scissors className="size-3" />
          )}
          {t("episode.workbench.renderGrid.cut")}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={handleDownload}
          disabled={!gridUrl}
          className={GRID_ACTION_BUTTON_CLASS}
        >
          <Download className="size-3" />
          {t("common.download")}
        </Button>
      </div>
      <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
        <DialogContent className="max-w-[min(calc(100vw-2rem),760px)] sm:max-w-[min(calc(100vw-2rem),760px)]">
          <DialogHeader>
            <DialogTitle>
              {t("episode.workbench.renderGrid.promptTitle", {
                n: group.gridIndex,
              })}
            </DialogTitle>
          </DialogHeader>
          <Textarea
            aria-label={t("episode.workbench.renderGrid.promptContent")}
            value={promptText}
            readOnly
            className="min-h-[260px] resize-y font-mono text-xs"
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void handleCopyPrompt()}
              className="gap-1 active:scale-95 transition-transform"
            >
              <Copy className="size-3" />
              {t("common.copy")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </article>
  );
}

function buildRenderGridGroups(
  images: PoolImage[],
  beats: Beat[] = [],
): RenderGridGroup[] {
  const byGridUrl = new Map<string, PoolImage[]>();
  for (const image of images) {
    if (image.type !== "render") continue;
    if (!image.grid_url) continue;
    const key = image.grid_url || image.grid_path || `${image.grid_index}`;
    const next = byGridUrl.get(key) ?? [];
    next.push(image);
    byGridUrl.set(key, next);
  }

  const batches = [...byGridUrl.values()].sort(compareRenderGridBatches);
  const plannedGroups = buildPlannedRenderGridGroups(beats);
  const gridIndexCounts = new Map<number, number>();
  for (const cells of batches) {
    const gridIndex = Number(cells[0]?.grid_index);
    if (!Number.isFinite(gridIndex)) continue;
    gridIndexCounts.set(gridIndex, (gridIndexCounts.get(gridIndex) ?? 0) + 1);
  }

  return batches
    .map((cells, orderIndex) => {
      const ordered = [...cells].sort((a, b) => a.cell_index - b.cell_index);
      const sourceGridIndex = Number(ordered[0]?.grid_index);
      const plannedGridIndex = findBestPlannedGridIndex(ordered, plannedGroups);
      const gridIndex =
        plannedGridIndex ??
        (Number.isFinite(sourceGridIndex) && gridIndexCounts.get(sourceGridIndex) === 1
          ? sourceGridIndex
          : orderIndex);
      const rows = Math.max(1, ...ordered.map((cell) => Number(cell.row) + 1));
      const cols = Math.max(1, ...ordered.map((cell) => Number(cell.col) + 1));
      const modeKey = ordered[0]?.mode || `${rows}x${cols}`;
      const beatNumbers = [
        ...new Set(
          ordered
            .map((cell) => Number(cell.original_beat))
            .filter((beat) => Number.isFinite(beat) && beat > 0),
        ),
      ].sort((a, b) => a - b);
      return {
        gridIndex,
        gridUrl: ordered[0]?.grid_url ?? "",
        cells: ordered,
        rows,
        cols,
        modeKey,
        beatNumbers,
      };
    });
}

function buildPlannedRenderGridGroups(beats: Beat[]): { gridIndex: number; beatNumbers: number[] }[] {
  if (beats.length === 0) return [];
  const byScene = new Map<string, Beat[]>();
  for (const beat of beats) {
    const scene = getBeatSceneId(beat);
    const sceneBeats = byScene.get(scene) ?? [];
    sceneBeats.push(beat);
    byScene.set(scene, sceneBeats);
  }

  const groups: { gridIndex: number; beatNumbers: number[] }[] = [];
  for (const sceneBeats of byScene.values()) {
    for (let offset = 0; offset < sceneBeats.length; offset += 25) {
      groups.push({
        gridIndex: groups.length,
        beatNumbers: sceneBeats
          .slice(offset, offset + 25)
          .map((beat) => beat.beat_number),
      });
    }
  }
  return groups;
}

function findBestPlannedGridIndex(
  cells: PoolImage[],
  plannedGroups: { gridIndex: number; beatNumbers: number[] }[],
): number | null {
  let best: { gridIndex: number; score: number } | null = null;
  const cellBeats = new Set(
    cells
      .map((cell) => Number(cell.original_beat))
      .filter((beat) => Number.isFinite(beat) && beat > 0),
  );
  for (const group of plannedGroups) {
    const plannedBeats = new Set(group.beatNumbers);
    let overlap = 0;
    for (const beat of cellBeats) {
      if (plannedBeats.has(beat)) overlap += 1;
    }
    if (overlap === 0) continue;
    const exactBeatSet =
      overlap === cellBeats.size && overlap === plannedBeats.size ? 1000 : 0;
    const score = exactBeatSet + overlap;
    if (!best || score > best.score) {
      best = { gridIndex: group.gridIndex, score };
    }
  }
  return best?.gridIndex ?? null;
}

function getBeatSceneId(beat: Beat): string {
  return (
    beat.scene_ref?.scene_id?.trim() ||
    beat.location?.trim() ||
    beat.location_description?.trim() ||
    "未知场景"
  );
}

function compareRenderGridBatches(left: PoolImage[], right: PoolImage[]): number {
  const leftMinBeat = minOriginalBeat(left);
  const rightMinBeat = minOriginalBeat(right);
  if (leftMinBeat !== rightMinBeat) return leftMinBeat - rightMinBeat;
  return latestGeneratedAt(right) - latestGeneratedAt(left);
}

function minOriginalBeat(cells: PoolImage[]): number {
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    ...cells
      .map((cell) => Number(cell.original_beat))
      .filter((beat) => Number.isFinite(beat) && beat > 0),
  );
}

function latestGeneratedAt(cells: PoolImage[]): number {
  return Math.max(
    0,
    ...cells.map((cell) => (cell.generated_at ? Date.parse(cell.generated_at) : 0)),
  );
}

function formatBeatRange(beats: number[]): string {
  if (beats.length === 0) return "-";
  const sorted = [...new Set(beats)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const beat of sorted.slice(1)) {
    if (beat === previous + 1) {
      previous = beat;
      continue;
    }
    ranges.push(start === previous ? String(start) : `${start}-${previous}`);
    start = beat;
    previous = beat;
  }
  ranges.push(start === previous ? String(start) : `${start}-${previous}`);
  return ranges.join(",");
}
