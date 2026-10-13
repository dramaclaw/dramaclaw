// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";

import { confirmDialog } from "@/components/confirm-dialog-host";

export function confirmAssetRename(t: TFunction): Promise<boolean> {
  return confirmDialog({
    title: t("assets.common.renameTitle"),
    description: t("assets.common.confirmRename"),
    confirmText: t("common.save"),
  });
}
