// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { SettingsPage } from "./settings-dialog";

export const OPEN_SETTINGS_DIALOG_EVENT = "dramaclaw-open-settings-dialog";

export interface OpenSettingsDialogDetail {
  page?: SettingsPage;
}

export function openSettingsDialog(page?: SettingsPage): void {
  window.dispatchEvent(
    new CustomEvent<OpenSettingsDialogDetail>(OPEN_SETTINGS_DIALOG_EVENT, {
      detail: { page },
    }),
  );
}
