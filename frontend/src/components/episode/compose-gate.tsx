// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { useBeatStates } from "@/hooks/use-beat-states";
import { STAGES_BY_ID, type StageId } from "@/lib/episode-stage-registry";
import type { EpisodeCounts } from "@/types/beat-state";

interface ComposeGateProps {
  project: string;
  episode: number;
}

type BlockerStageId = Exclude<StageId, "compose" | "script" | "sketch">;

const MAX_BEATS_DISPLAYED = 5;

/**
 * Compose readiness gate. Renders directly above the compose action area:
 *
 * - Ready: green banner summarising total beats covered.
 * - Blocked: amber banner listing missing assets grouped by stage. Each line
 *   has a `[处理 →]` button that navigates to the offending stage tab and
 *   sets `?beat=N` + `#beat-N` so the workbench drawer auto-opens on the
 *   first missing beat for that stage. Lists at most {@link MAX_BEATS_DISPLAYED}
 *   beat numbers per stage with a "..." indicator when truncated.
 *
 * Mirrors the tooltip rendering logic in the Health Bar's compose cell so the
 * two surfaces tell the same story.
 */
export function ComposeGate({ project, episode }: ComposeGateProps) {
  const { t } = useTranslation();
  const { counts } = useBeatStates(project, episode);
  const navigate = useNavigate();

  if (counts.compose.ready) {
    return (
      <p className="rounded border border-primary/40 bg-primary/10 p-3 text-xs text-primary">
        ✓ {t("episode.health.allReady")} · {t("episode.health.beatCount", { count: counts.script.total })}
      </p>
    );
  }

  const grouped = groupBlockersByStage(counts);

  const fix = (stage: BlockerStageId, firstBeat: number) => {
    const def = STAGES_BY_ID[stage];
    navigate({
      to: `/projects/$project/episodes/$episode${def.routeSegment}` as const,
      params: { project, episode: String(episode) },
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        beat: firstBeat,
        stage,
      })) as never,
      hash: `beat-${firstBeat}`,
    });
  };

  return (
    <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
      <p className="mb-2 font-medium text-amber-700 dark:text-amber-300">
        ⚠ {t("episode.compose.blocked")}
      </p>
      <ul className="space-y-1">
        {grouped.map(({ stage, beats }) => (
          <li key={stage} className="flex items-center gap-2">
            <span className="flex-1 text-amber-800 dark:text-amber-100">
              · {beats.length} {t(`episode.stage.${stage}`)} (beat{" "}
              {beats.slice(0, MAX_BEATS_DISPLAYED).join(", ")}
              {beats.length > MAX_BEATS_DISPLAYED ? "..." : ""})
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => fix(stage, beats[0])}
              className="text-xs text-amber-700 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100"
            >
              {t("episode.workbench.jumpTo", { stage: t(`episode.stage.${stage}`) })} →
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Group `counts.compose.missing` entries by the offending stage so each stage
 * surfaces once with its full beat list, regardless of how many stages a beat
 * blocks on. Compose only concatenates existing video clips with audio, so
 * the blockers mirror the BE actor's own pre-flight: `audio · video`.
 */
function groupBlockersByStage(
  counts: EpisodeCounts,
): Array<{ stage: BlockerStageId; beats: number[] }> {
  const order: BlockerStageId[] = ["audio", "video"];
  const buckets: Record<BlockerStageId, number[]> = {
    audio: [],
    video: [],
  };
  for (const { beatNum, stages } of counts.compose.missing) {
    for (const s of stages) {
      // `missing.stages` is typed permissively (all non-compose stages), but
      // the derivation only pushes `audio | video`. Guard so this stays safe
      // if the derivation ever adds another blocker we don't surface here.
      if (s !== "audio" && s !== "video") continue;
      buckets[s].push(beatNum);
    }
  }
  return order
    .filter((s) => buckets[s].length > 0)
    .map((s) => ({ stage: s, beats: buckets[s] }));
}
