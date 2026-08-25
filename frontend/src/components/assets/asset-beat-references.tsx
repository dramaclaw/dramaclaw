// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Link } from "@tanstack/react-router";
import { ChevronDown, Film, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  useAssetReferences,
  type AssetRef,
  type BeatReference,
} from "@/lib/queries/asset-references";
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
  showHeading = true,
}: {
  project: string;
  references: BeatReference[];
  className?: string;
  showHeading?: boolean;
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
      {showHeading ? (
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Film className="size-3.5" />
          {t("assets.common.appearsIn")}
          <span className="tabular-nums">({sorted.length})</span>
        </div>
      ) : null}
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

/** Fetch one asset's beat references only after the user asks to see them. */
export function LazyAssetBeatReferences({
  project,
  asset,
  className,
}: {
  project: string;
  asset: AssetRef;
  className?: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detail = useAssetReferences(project, expanded ? [asset] : []);
  const references = detail.referencesFor(asset.type, asset.id);

  return (
    <div className={cn("space-y-2", className)}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <Film className="size-3.5" />
        <span>{t("assets.common.appearsIn")}</span>
        {expanded && !detail.isLoading ? (
          <span className="tabular-nums">({references.length})</span>
        ) : null}
        {detail.isLoading ? (
          <Loader2 className="ml-auto size-3.5 animate-spin" />
        ) : (
          <ChevronDown
            className={cn(
              "ml-auto size-3.5 transition-transform",
              expanded && "rotate-180",
            )}
          />
        )}
      </button>
      {expanded && !detail.isLoading ? (
        <AssetBeatReferences
          project={project}
          references={references}
          showHeading={false}
        />
      ) : null}
    </div>
  );
}
