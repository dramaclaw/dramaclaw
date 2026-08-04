// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Promise-based global confirm dialog, replacing `window.confirm` so
 * non-component code (mutations, stores) can await a styled AlertDialog.
 * Mount `<ConfirmDialogHost />` once in the root layout.
 */
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Button } from "@/components/ui/button";

export interface ConfirmDialogOptions {
  title?: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: React.ComponentProps<typeof Button>["variant"];
}

interface PendingConfirm extends ConfirmDialogOptions {
  resolve: (confirmed: boolean) => void;
}

interface ConfirmDialogState {
  pending: PendingConfirm | null;
}

const useConfirmDialogStore = create<ConfirmDialogState>(() => ({
  pending: null,
}));

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // A newer request supersedes an unanswered one — the old caller
    // proceeds as if dismissed, same as a closed window.confirm.
    useConfirmDialogStore.getState().pending?.resolve(false);
    useConfirmDialogStore.setState({ pending: { ...options, resolve } });
  });
}

function settle(confirmed: boolean) {
  const { pending } = useConfirmDialogStore.getState();
  if (!pending) return;
  useConfirmDialogStore.setState({ pending: null });
  pending.resolve(confirmed);
}

export function ConfirmDialogHost() {
  const pending = useConfirmDialogStore((s) => s.pending);
  const { t } = useTranslation();

  return (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && settle(false)}>
      <AlertDialogContent className="top-24 w-[min(calc(100vw-2rem),440px)] translate-y-0">
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.title ?? t("common.confirm")}</AlertDialogTitle>
          <AlertDialogDescription>{pending?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            size="sm"
            className="h-7 min-w-0 rounded-md px-4 text-[0.8rem]"
            onClick={() => settle(false)}
          >
            {pending?.cancelText ?? t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={pending?.confirmVariant}
            size="sm"
            className="h-7 min-w-0 rounded-md px-4 text-[0.8rem]"
            onClick={() => settle(true)}
          >
            {pending?.confirmText ?? t("common.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
