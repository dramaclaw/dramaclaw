// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Fingerprint,
  Star,
  Users,
  Volume2,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { Character } from "@/types/character";

export type CharacterStats = {
  total: number;
  mainCharacters: number;
  identityReady: number;
  voiceReady: number;
};

export type CharacterStatsStripProps = {
  characters: Character[];
  identityCounts?: Record<string, number>;
  /** Overrides the default localized "narrator lead" label. */
  mainCharacterLabel?: string;
  className?: string;
};

type DisplayStatItem = {
  key: string;
  label: string;
  icon: LucideIcon;
  display: string;
  tone?: "default" | "ready" | "warning";
};

function hasValue(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

export function deriveCharacterStats(
  characters: Character[],
  identityCounts?: Record<string, number>,
): CharacterStats {
  const stats: CharacterStats = {
    total: characters.length,
    mainCharacters: 0,
    identityReady: 0,
    voiceReady: 0,
  };

  for (const character of characters) {
    if (character.is_main === true) {
      stats.mainCharacters += 1;
    }
    if (hasValue(character.reference_audio_path)) {
      stats.voiceReady += 1;
    }
    if (
      (identityCounts?.[character.name] ?? character.identity_ids?.length ?? 0) > 0
    ) {
      stats.identityReady += 1;
    }
  }

  return stats;
}

export function CharacterStatsStrip({
  characters,
  identityCounts,
  mainCharacterLabel,
  className,
}: CharacterStatsStripProps) {
  const { t } = useTranslation();
  const stats = useMemo(
    () => deriveCharacterStats(characters, identityCounts),
    [characters, identityCounts],
  );
  // Ready/total: portrait, identity, and voice each show "ready / total".
  const items: DisplayStatItem[] = [
    {
      key: "total",
      label: t("characters.stats.strip.total"),
      icon: Users,
      display: `${stats.total}`,
    },
    {
      key: "mainCharacters",
      label: mainCharacterLabel ?? t("characters.stats.strip.mainCharacter"),
      icon: Star,
      display: `${stats.mainCharacters}`,
    },
    {
      key: "identityReady",
      label: t("characters.stats.strip.identity"),
      icon: Fingerprint,
      display: `${stats.identityReady}/${stats.total}`,
    },
    {
      key: "voiceReady",
      label: t("characters.stats.strip.voice"),
      icon: Volume2,
      display: `${stats.voiceReady}/${stats.total}`,
      tone: "ready",
    },
  ];

  return (
    <ul
      aria-label={t("characters.stats.strip.ariaLabel")}
      className={cn(
        "flex flex-wrap items-center justify-center gap-x-10 gap-y-2 py-1.5",
        className,
      )}
    >
      {items.map(({ key, label, icon: Icon, display, tone = "default" }) => (
        <li
          key={key}
          aria-label={`${label}: ${display}`}
          className="flex items-center gap-2"
        >
          <Icon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground",
              tone === "ready" && "text-emerald-600 dark:text-emerald-300",
              tone === "warning" && "text-amber-600 dark:text-amber-300",
            )}
          />
          <div className="flex items-center gap-5">
            <span className="truncate text-[11px] text-muted-foreground">
              {label}
            </span>
            <span className="shrink-0 text-xs font-medium tabular-nums text-foreground">
              {display}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
