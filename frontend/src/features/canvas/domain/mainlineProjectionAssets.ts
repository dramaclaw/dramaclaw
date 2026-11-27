// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { FreezoneProjectAsset } from "@/api/projects";

export function combineMainlineProjectionAssets(
  assets: FreezoneProjectAsset[],
  characters: { name?: unknown; display_name?: unknown; role?: unknown; portrait_url?: unknown }[],
): FreezoneProjectAsset[] {
  const characterAssets: FreezoneProjectAsset[] = characters
    .map((character): FreezoneProjectAsset | null => {
      const name = typeof character.name === "string" ? character.name.trim() : "";
      if (!name) return null;
      const displayName =
        typeof character.display_name === "string" && character.display_name.trim()
          ? character.display_name.trim()
          : name;
      return {
        id: `character:${name}`,
        tab: "characters",
        kind: "character",
        role: "character_profile",
        label: displayName,
        sublabel: typeof character.role === "string" && character.role.trim() ? character.role.trim() : undefined,
        url: typeof character.portrait_url === "string" && character.portrait_url.trim()
          ? character.portrait_url.trim()
          : null,
        exists: true,
        media_type: character.portrait_url ? "image" : "text",
        meta: { character: name },
      };
    })
    .filter((asset): asset is FreezoneProjectAsset => Boolean(asset));
  return [...assets, ...characterAssets];
}
