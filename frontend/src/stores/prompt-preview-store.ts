// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Prompt preview panel chrome (open / width). Region-agnostic UX state only —
 * no project or episode ids belong here.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { quotaSafeStateStorage } from "@/lib/localStorageQuota";

export const PROMPT_PREVIEW_WIDTH_MIN = 360;
export const PROMPT_PREVIEW_WIDTH_DEFAULT = 480;
export const PROMPT_PREVIEW_WIDTH_MAX = 760;

export function clampPromptPreviewWidth(width: number): number {
  if (!Number.isFinite(width)) return PROMPT_PREVIEW_WIDTH_DEFAULT;
  return Math.min(PROMPT_PREVIEW_WIDTH_MAX, Math.max(PROMPT_PREVIEW_WIDTH_MIN, width));
}

interface PromptPreviewState {
  open: boolean;
  width: number;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setWidth: (width: number) => void;
}

export const usePromptPreviewStore = create<PromptPreviewState>()(
  persist(
    (set) => ({
      open: false,
      width: PROMPT_PREVIEW_WIDTH_DEFAULT,
      setOpen: (open) => set({ open }),
      toggle: () => set((s) => ({ open: !s.open })),
      setWidth: (width) => set({ width: clampPromptPreviewWidth(width) }),
    }),
    {
      name: "dramaclaw-prompt-preview",
      version: 1,
      storage: createJSONStorage(() => quotaSafeStateStorage),
    },
  ),
);
