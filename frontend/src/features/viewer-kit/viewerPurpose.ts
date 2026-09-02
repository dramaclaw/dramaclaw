// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";

export type ViewerPurpose = "mainline" | "freezone" | "asset" | "beat";

export function viewerPurposeLabel(purpose: ViewerPurpose | undefined, t: TFunction): string {
  if (purpose === "freezone") return t("viewer.purpose.freezone");
  if (purpose === "asset") return t("viewer.purpose.asset");
  if (purpose === "beat") return t("viewer.purpose.beat");
  return t("viewer.purpose.mainline");
}
