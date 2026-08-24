// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Link } from "@tanstack/react-router";
import { Film } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { BeatReference } from "@/lib/queries/asset-references";
import { cn } from "@/lib/utils";

/**
 * Reverse "appears in beats" list for an asset edit surface. Each entry deep-links
 * to the beats workbench (`?beat=N`), so cmd/right-click opens it in a new tab.
 * References come from `useAssetReferences.referencesFor(type, id)`.
 */
export function AssetBeatReferences({
  project,
  references,
  className,
}: {
  project: string;
  references: BeatReference[];
  className?: string;
}) {
  const { t } = useTranslation();

  const sorted = useMemo(
    () =>
      [...references].sort(
        (a, b) => a.episode - b.episode || a.beatNumber - b.beatNumber,
      ),
    [references],
  );

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Film className="size-3.5" />
        {t("assets.common.appearsIn")}
        <span className="tabular-nums">({sorted.length})</span>
      </div>
      {sorted.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">
          {t("assets.common.usageNone")}
        </p>
      ) : (
        <div className="flex max-h-[200px] flex-wrap gap-1.5 overflow-y-auto overscroll-contain pr-1">
          {sorted.map((ref) => (
            <Link
              key={`${ref.episode}:${ref.beatNumber}`}
              to="/projects/$project/episodes/$episode/beats"
              params={{ project, episode: String(ref.episode) }}
              search={{ beat: ref.beatNumber } as never}
              hash={`beat-${ref.beatNumber}`}
              className="inline-flex items-center rounded-[6px] border border-border bg-background/40 px-2 py-0.5 text-[11px] text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
            >
              {t("assets.common.beatRef", {
                episode: ref.episode,
                beat: ref.beatNumber,
              })}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
