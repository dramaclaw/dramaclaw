// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Film } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { ASSET_CARD_META_BADGE_CLASS } from "@/components/assets/asset-card-styles";

/**
 * Compact "used in N beats" indicator for asset cards. Renders nothing when the
 * asset isn't referenced anywhere (keeps grids quiet). Count is supplied by the
 * caller via `useAssetReferenceIndex` so the heavy beat scan happens once per
 * panel, not once per card.
 */
export function UsageCountBadge({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        ASSET_CARD_META_BADGE_CLASS,
        className,
      )}
    >
      <Film className="size-3" />
      {t("assets.common.usageCount", { count })}
    </span>
  );
}
