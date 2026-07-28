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
  Square,
  Upload,
} from "lucide-react";

import {
  useExportGridPrompt,
  useGenerateSketches,
  useGrids,
  useSketchGridPreview,
  useUploadGrid,
  type PoolImage,
} from "@/lib/queries/sketches";
import type { SketchAspectRatio } from "@/lib/queries/sketch-settings";
import { gridAspectCss } from "@/lib/aspect-ratio";
import { queryKeys } from "@/lib/query-keys";
import { TASK_TYPES } from "@/lib/task-types";
import { resolveMediaUrl } from "@/lib/media-url";
import { cn } from "@/lib/utils";
import {
  backendErrorToastMessage,
  BillingRuleNotConfiguredError,
} from "@/lib/api-errors";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
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

interface SketchGridGalleryProps {
  project: string;
  episode: number;
  beats?: Beat[];
  aspectRatio?: SketchAspectRatio;
  imageGenerationSelection?: string;
}

interface SketchGridGroup {
  gridIndex: number;
  gridUrl: string | null;
  cells: PoolImage[];
  fallbackCells: { beatNumber: number; url: string | null }[];
  rows: number;
  cols: number;
  modeKey: string;
  beatNumbers: number[];
  sceneId?: string;
}

export function SketchGridGallery({
  project,
  episode,
  beats = [],
  aspectRatio = "2:3",
  imageGenerationSelection,
}: SketchGridGalleryProps) {
  const { t } = useTranslation();
  const { data: gridsRes } = useGrids(project, episode);
  const groups = useMemo(
    () => buildSketchGridGroups(gridsRes?.data?.images ?? [], beats, aspectRatio),
    [aspectRatio, beats, gridsRes?.data?.images],
  );

  if (groups.length === 0) return null;

  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-background/50 px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-xs font-semibold text-muted-foreground">
          {t("episode.workbench.sketchGrid.titleWithCount", {
            count: groups.length,
          })}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
          {groups.map((group) => (
            <SketchGridCard
              key={group.gridIndex}
              project={project}
              episode={episode}
              group={group}
              aspectRatio={aspectRatio}
              imageGenerationSelection={imageGenerationSelection}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function SketchGridCard({
  project,
  episode,
  group,
  aspectRatio,
  imageGenerationSelection,
}: {
  project: string;
  episode: number;
  group: SketchGridGroup;
  aspectRatio: SketchAspectRatio;
  imageGenerationSelection?: string;
}) {
  const { t } = useTranslation();
  const generateSketches = useGenerateSketches(project, episode);
  const uploadGrid = useUploadGrid(project, episode);
  const exportGridPrompt = useExportGridPrompt(project, episode);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState("");
  const scope = `grid_${group.gridIndex}`;
  const sketchTask = useTaskController({
    key: {
      taskType: TASK_TYPES.SKETCH_GRID_GENERATION,
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
  const fallbackCells = group.fallbackCells.length > 0
    ? group.fallbackCells
    : group.cells.map((cell) => ({
        beatNumber: cell.original_beat,
        url: cell.cell_url,
      }));
  const hasFallbackPreview = fallbackCells.some((cell) => resolveMediaUrl(cell.url));
  const sketchPreview = useSketchGridPreview(project, episode, {
    gridIndex: group.gridIndex,
    rows: group.rows,
    cols: group.cols,
    beatNumbers: group.beatNumbers,
    enabled: !gridUrl && !hasFallbackPreview,
  });
  const generatedPreviewUrl =
    sketchPreview.data?.ok === true
      ? resolveMediaUrl(sketchPreview.data.data?.preview_url)
      : null;
  const hasPreview = Boolean(gridUrl || generatedPreviewUrl || hasFallbackPreview);
  const gridCost = useGenerationCreditCost(
    "feature",
    "mainline.sketch_regen",
    {
      surface: "supertale",
      imageRole: "sketch",
      modeKey: group.modeKey,
      params: imageGenerationSelection
        ? { image_selection: imageGenerationSelection }
        : null,
    },
  );
  const gridCostDisplay =
    gridCost.data?.data.display ??
    (gridCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);

  const handleGenerate = async () => {
    try {
      const res = await generateSketches.mutateAsync({
        grid_index: group.gridIndex,
        sketch_scene_grouping: true,
        aspect_ratio: aspectRatio,
        ...(imageGenerationSelection
          ? { image_generation_selection: imageGenerationSelection }
          : {}),
      });
      if (res.ok === false) {
        toast.error(backendErrorToastMessage(res.error, t));
        return;
      }
      sketchTask.start({ scope });
      toast.success(
        t("episode.workbench.sketchGrid.regenStarted", {
          n: group.gridIndex,
        }),
      );
    } catch (error) {
      toast.error(backendErrorToastMessage(error, t));
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
        gridType: "sketch",
        modeKey: group.modeKey,
        beatNumbers: group.beatNumbers,
      });
      if (res.ok === false) {
        toast.error(res.error || t("episode.workbench.sketchGrid.uploadFailed"));
        return;
      }
      toast.success(
        t("episode.workbench.sketchGrid.uploadSuccess", {
          n: group.gridIndex,
        }),
      );
    } catch {
      toast.error(t("episode.workbench.sketchGrid.uploadFailed"));
    }
  };

  const handleExportPrompt = async () => {
    try {
      const res = await exportGridPrompt.mutateAsync({
        gridIndex: group.gridIndex,
        gridType: "sketch",
        modeKey: group.modeKey,
        beatNumbers: group.beatNumbers,
      });
      if (res.ok === false) {
        toast.error(res.error || t("episode.workbench.sketchGrid.promptFailed"));
        return;
      }
      setPromptText(res.data.prompt);
      setPromptOpen(true);
    } catch {
      toast.error(t("episode.workbench.sketchGrid.promptFailed"));
    }
  };

  const handleCopyPrompt = async () => {
    await navigator.clipboard?.writeText(promptText);
    toast.success(t("episode.workbench.sketchGrid.copySuccess"));
  };

  const handleDownload = () => {
    if (!gridUrl) return;
    const a = document.createElement("a");
    a.href = gridUrl;
    a.download = `sketch_grid_${group.gridIndex}.png`;
    a.click();
  };

  return (
    <article className="flex min-w-0 flex-col gap-2 rounded-md border border-white/10 bg-transparent p-2">
      <button
        type="button"
        disabled={!gridUrl && !hasFallbackPreview && !generatedPreviewUrl}
        onClick={() => {
          const url = gridUrl ?? generatedPreviewUrl;
          if (url) window.open(url, "_blank", "noopener,noreferrer");
        }}
        className={cn(
          "overflow-hidden rounded bg-black/20 disabled:cursor-default",
          hasPreview && "border border-white/10",
        )}
        style={{ aspectRatio: gridAspectCss(group.cols, group.rows, aspectRatio) }}
      >
        {gridUrl ? (
          <img
            src={gridUrl}
            alt={t("episode.workbench.sketchGrid.gridLabel", {
              n: group.gridIndex,
            })}
            className="h-full w-full object-contain"
            loading="lazy"
            decoding="async"
          />
        ) : generatedPreviewUrl ? (
          <img
            src={generatedPreviewUrl}
            alt={t("episode.workbench.sketchGrid.gridLabel", {
              n: group.gridIndex,
            })}
            className="h-full w-full object-contain opacity-70"
            loading="lazy"
            decoding="async"
          />
        ) : hasFallbackPreview ? (
          <div
            className="grid h-full w-full gap-px bg-border"
            style={{
              gridTemplateColumns: `repeat(${group.cols}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${group.rows}, minmax(0, 1fr))`,
            }}
            aria-label={t("episode.workbench.sketchGrid.gridLabel", {
              n: group.gridIndex,
            })}
          >
            {Array.from({ length: group.rows * group.cols }, (_, index) => {
              const cell = fallbackCells[index];
              const src = resolveMediaUrl(cell?.url);
              return (
                <div key={index} className="min-h-0 min-w-0 bg-background">
                  {src ? (
                    <img
                      src={src}
                      alt=""
                      className="h-full w-full object-cover opacity-70"
                      loading="lazy"
                      decoding="async"
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <span className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {t("episode.workbench.sketchGrid.noPreview")}
          </span>
        )}
      </button>
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-medium">
            {t("episode.workbench.sketchGrid.gridLabel", {
              n: group.gridIndex,
            })}
          </span>
          <span className="text-muted-foreground">
            {group.rows}x{group.cols}
          </span>
        </div>
        <p className="truncate text-[11px] text-muted-foreground">
          {t("episode.workbench.sketchGrid.cellCount", {
            count: group.cells.length,
          })}
          {" · B"}
          {formatBeatRange(group.beatNumbers)}
        </p>
        {group.sceneId && (
          <p className="truncate text-[11px] text-muted-foreground">
            {group.sceneId === UNKNOWN_SCENE_ID
              ? t("episode.workbench.sketchGrid.unknownScene")
              : group.sceneId}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {sketchTask.started ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => void sketchTask.stop()}
            disabled={sketchTask.stopping}
            className={GRID_ACTION_BUTTON_CLASS}
          >
            {sketchTask.stopping ? (
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
              onClick={handleGenerate}
              disabled={generateSketches.isPending}
              className={GRID_ACTION_BUTTON_CLASS}
            >
            {generateSketches.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {t("episode.workbench.sketchGrid.generateGrid")}
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
          aria-label={t("episode.workbench.sketchGrid.uploadGrid")}
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
          {t("episode.workbench.sketchGrid.uploadGrid")}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={handleExportPrompt}
          disabled={!gridUrl || exportGridPrompt.isPending}
          className={GRID_ACTION_BUTTON_CLASS}
        >
          {exportGridPrompt.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <FileText className="size-3" />
          )}
          {t("episode.workbench.sketchGrid.exportPrompt")}
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
              {t("episode.workbench.sketchGrid.promptTitle", {
                n: group.gridIndex,
              })}
            </DialogTitle>
          </DialogHeader>
          <Textarea
            aria-label={t("episode.workbench.sketchGrid.promptContent")}
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

function buildSketchGridGroups(
  images: PoolImage[],
  beats: Beat[] = [],
  aspectRatio: SketchAspectRatio = "2:3",
): SketchGridGroup[] {
  const planned = buildPlannedSketchGridGroups(beats, aspectRatio);
  const beatSketchUrls = new Map(
    beats.map((beat) => [beat.beat_number, beat.sketch_url ?? null]),
  );
  const latestSketchByBeat = buildLatestSketchByBeat(images);
  const groups = new Map<number, SketchGridGroup>();
  for (const group of planned) {
    groups.set(group.gridIndex, group);
  }

  const byGridUrl = new Map<string, PoolImage[]>();
  for (const image of images) {
    if (image.type !== "sketch") continue;
    if (!image.grid_url) continue;
    const key = image.grid_url || image.grid_path || `${image.grid_index}`;
    const next = byGridUrl.get(key) ?? [];
    next.push(image);
    byGridUrl.set(key, next);
  }

  const byGrid = new Map<number, PoolImage[][]>();
  const plannedGroups = [...groups.values()];
  for (const cells of byGridUrl.values()) {
    const gridIndex = findBestPlannedGridIndex(cells, plannedGroups);
    const next = byGrid.get(gridIndex) ?? [];
    next.push(cells);
    byGrid.set(gridIndex, next);
  }

  for (const [gridIndex, candidates] of byGrid.entries()) {
    const cells = pickCurrentGridCells(candidates, groups.get(gridIndex));
    const ordered = [...cells].sort((a, b) => a.cell_index - b.cell_index);
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
    const existing = groups.get(gridIndex);
    groups.set(gridIndex, {
      ...existing,
      gridIndex,
      gridUrl: ordered[0]?.grid_url ?? "",
      cells: ordered,
      fallbackCells: existing?.fallbackCells ?? [],
      rows: existing?.rows ?? rows,
      cols: existing?.cols ?? cols,
      modeKey: existing?.modeKey ?? modeKey,
      beatNumbers: existing?.beatNumbers.length ? existing.beatNumbers : beatNumbers,
    });
  }

  for (const group of groups.values()) {
    group.fallbackCells = group.beatNumbers.map((beatNumber) => ({
      beatNumber,
      url: beatSketchUrls.get(beatNumber) ?? latestSketchByBeat.get(beatNumber)?.cell_url ?? null,
    }));
  }

  return [...groups.values()].sort((left, right) => left.gridIndex - right.gridIndex);
}

function findBestPlannedGridIndex(
  cells: PoolImage[],
  plannedGroups: SketchGridGroup[],
): number {
  const fallbackGridIndex = Number(cells[0]?.grid_index);
  let bestMatch: { gridIndex: number; score: number } | null = null;
  const cellBeats = new Set(
    cells
      .map((cell) => Number(cell.original_beat))
      .filter((beat) => Number.isFinite(beat) && beat > 0),
  );
  const mode = cells[0]?.mode;

  for (const group of plannedGroups) {
    const plannedBeats = new Set(group.beatNumbers);
    const overlap = beatOverlap(cells, plannedBeats);
    if (overlap === 0) continue;
    const exactBeatSet =
      overlap === plannedBeats.size && overlap === cellBeats.size ? 1000 : 0;
    const modeBonus = mode && mode === group.modeKey ? 50 : 0;
    const score = exactBeatSet + modeBonus + overlap;
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { gridIndex: group.gridIndex, score };
    }
  }

  if (bestMatch) return bestMatch.gridIndex;
  return Number.isFinite(fallbackGridIndex) ? fallbackGridIndex : 0;
}

function buildLatestSketchByBeat(images: PoolImage[]): Map<number, PoolImage> {
  const byBeat = new Map<number, PoolImage>();
  for (const image of images) {
    if (image.type !== "sketch" || !image.cell_url) continue;
    const beatNumber = Number(image.original_beat);
    if (!Number.isFinite(beatNumber) || beatNumber <= 0) continue;
    const current = byBeat.get(beatNumber);
    if (!current || comparePoolImageFreshness(image, current) > 0) {
      byBeat.set(beatNumber, image);
    }
  }
  return byBeat;
}

function comparePoolImageFreshness(left: PoolImage, right: PoolImage): number {
  const leftFresh = left.stale ? 0 : 1;
  const rightFresh = right.stale ? 0 : 1;
  if (leftFresh !== rightFresh) return leftFresh - rightFresh;
  const leftTime = left.generated_at ? Date.parse(left.generated_at) : 0;
  const rightTime = right.generated_at ? Date.parse(right.generated_at) : 0;
  return leftTime - rightTime;
}

function pickCurrentGridCells(
  candidates: PoolImage[][],
  planned?: SketchGridGroup,
): PoolImage[] {
  const plannedBeats = new Set(planned?.beatNumbers ?? []);
  return [...candidates].sort((left, right) => {
    const leftOverlap = plannedBeats.size > 0 ? beatOverlap(left, plannedBeats) : 0;
    const rightOverlap = plannedBeats.size > 0 ? beatOverlap(right, plannedBeats) : 0;
    if (leftOverlap !== rightOverlap) return rightOverlap - leftOverlap;

    const leftFresh = left.some((cell) => !cell.stale) ? 1 : 0;
    const rightFresh = right.some((cell) => !cell.stale) ? 1 : 0;
    if (leftFresh !== rightFresh) return rightFresh - leftFresh;

    return latestGeneratedAt(right) - latestGeneratedAt(left);
  })[0] ?? [];
}

function beatOverlap(cells: PoolImage[], beats: Set<number>): number {
  const seen = new Set<number>();
  for (const cell of cells) {
    const beat = Number(cell.original_beat);
    if (beats.has(beat)) seen.add(beat);
  }
  return seen.size;
}

function latestGeneratedAt(cells: PoolImage[]): number {
  return Math.max(
    0,
    ...cells.map((cell) => (cell.generated_at ? Date.parse(cell.generated_at) : 0)),
  );
}

const SKETCH_2_3_MODES = [
  { capacity: 1, rows: 1, cols: 1, modeKey: "1x1_2-3_sketch" },
  { capacity: 4, rows: 2, cols: 2, modeKey: "2x2_2-3_sketch" },
  { capacity: 9, rows: 3, cols: 3, modeKey: "3x3_2-3_sketch" },
  { capacity: 16, rows: 4, cols: 4, modeKey: "4x4_2-3_sketch" },
  { capacity: 25, rows: 5, cols: 5, modeKey: "5x5_2-3_sketch" },
];

const SKETCH_16_9_MODES = [
  { capacity: 1, rows: 1, cols: 1, modeKey: "1x1_16-9_sketch" },
  { capacity: 4, rows: 2, cols: 2, modeKey: "2x2_16-9_sketch" },
  { capacity: 9, rows: 3, cols: 3, modeKey: "3x3_16-9_sketch" },
  { capacity: 16, rows: 4, cols: 4, modeKey: "4x4_16-9_sketch" },
  { capacity: 25, rows: 5, cols: 5, modeKey: "5x5_16-9_sketch" },
];

function buildPlannedSketchGridGroups(
  beats: Beat[],
  aspectRatio: SketchAspectRatio,
): SketchGridGroup[] {
  if (beats.length === 0) return [];
  const byScene = new Map<string, Beat[]>();
  for (const beat of beats) {
    if (isSpaceMapBeat(beat)) continue;
    const scene = getBeatSceneId(beat);
    const sceneBeats = byScene.get(scene) ?? [];
    sceneBeats.push(beat);
    byScene.set(scene, sceneBeats);
  }

  const groups: SketchGridGroup[] = [];
  const modes = aspectRatio === "16:9" ? SKETCH_16_9_MODES : SKETCH_2_3_MODES;
  for (const [sceneId, sceneBeats] of byScene.entries()) {
    let offset = 0;
    while (offset < sceneBeats.length) {
      const remaining = Math.min(sceneBeats.length - offset, 25);
      const mode =
        modes.find((item) => remaining <= item.capacity) ??
        modes[modes.length - 1];
      const chunk = sceneBeats.slice(offset, offset + mode.capacity);
      groups.push({
        gridIndex: groups.length,
        gridUrl: null,
        cells: [],
        fallbackCells: chunk.map((beat) => ({
          beatNumber: beat.beat_number,
          url: beat.sketch_url ?? null,
        })),
        rows: mode.rows,
        cols: mode.cols,
        modeKey: mode.modeKey,
        beatNumbers: chunk.map((beat) => beat.beat_number),
        sceneId,
      });
      offset += mode.capacity;
    }
  }
  return groups;
}

const UNKNOWN_SCENE_ID = "__unknown_scene__";

function getBeatSceneId(beat: Beat): string {
  return (
    beat.scene_ref?.scene_id?.trim() ||
    beat.location?.trim() ||
    beat.location_description?.trim() ||
    UNKNOWN_SCENE_ID
  );
}

function isSpaceMapBeat(beat: Beat): boolean {
  const visual = (beat.visual_description ?? "").trim().toLowerCase();
  return (
    visual.startsWith("[space_map") ||
    visual.startsWith("[space_anchor_map]") ||
    visual.startsWith("[absolute_layout_map]")
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
