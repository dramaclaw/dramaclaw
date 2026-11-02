// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

export function CheckoutShell({
  summary,
  children,
  onLeave,
}: {
  summary: ReactNode;
  children: ReactNode;
  onLeave: () => void;
}) {
  const { t } = useTranslation();
  const [leaveOpen, setLeaveOpen] = useState(false);
  return (
    <main className="min-h-dvh bg-[#0b0d11] text-white">
      <div className="grid min-h-dvh lg:grid-cols-[minmax(360px,0.88fr)_minmax(520px,1.12fr)]">
        <section className="flex min-h-[42dvh] flex-col border-b border-white/8 bg-white/[0.025] px-6 py-7 lg:min-h-dvh lg:border-b-0 lg:border-r lg:px-12 lg:py-10 xl:px-20">
          <button
            type="button"
            onClick={() => setLeaveOpen(true)}
            className="group inline-flex h-9 w-fit items-center gap-2 rounded-md px-2 text-sm text-white/48 transition-colors hover:bg-white/[0.05] hover:text-white"
          >
            <ArrowLeft className="size-4" />
            <span>{t("checkout.back")}</span>
          </button>
          <div className="mx-auto my-auto w-full max-w-lg py-10">{summary}</div>
          <div className="text-xs text-white/28">
            DramaClaw · Secure checkout
          </div>
        </section>
        <section className="flex items-center px-6 py-10 lg:px-12 xl:px-20">
          <div className="mx-auto w-full max-w-xl">{children}</div>
        </section>
      </div>
      <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <DialogContent className="max-w-md rounded-xl border border-white/10 bg-[#17191e] p-6 text-white">
          <DialogTitle className="text-base font-semibold">
            {t("checkout.leaveTitle")}
          </DialogTitle>
          <DialogDescription className="text-sm text-white/45">
            {t("checkout.leaveDescription")}
          </DialogDescription>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={onLeave}
              className="h-10 rounded-md bg-white/[0.06] text-sm font-medium text-white/70 hover:bg-white/[0.1]"
            >
              {t("checkout.leave")}
            </button>
            <button
              type="button"
              onClick={() => setLeaveOpen(false)}
              className="h-10 rounded-md bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              {t("checkout.stay")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
