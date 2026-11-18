// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from "react-i18next";
import { isCeRuntime } from "@/lib/runtime-config";

export function ChatHistoryNotice() {
  const { t } = useTranslation();
  if (!isCeRuntime()) return null;

  return (
    <div role="status" className="shrink-0 border-b border-warning/20 bg-warning/8 px-3 py-2 text-xs leading-relaxed">
      <p className="font-medium text-foreground">{t("chatSnapshot.ceHistory.title")}</p>
      <p className="mt-1 text-foreground">{t("chatSnapshot.ceHistory.description")}</p>
      <div className="mt-2 flex flex-wrap items-start gap-x-3 gap-y-2">
        <details className="min-w-0 flex-1 basis-40">
          <summary className="cursor-pointer text-foreground underline underline-offset-2">
            {t("chatSnapshot.ceHistory.help")}
          </summary>
          <div className="mt-2 max-h-48 space-y-2 overflow-y-auto break-words pr-1 ui-scrollbar">
            <p>{t("chatSnapshot.ceHistory.continue")}</p>
            <p>{t("chatSnapshot.ceHistory.backup")}</p>
            <p>{t("chatSnapshot.ceHistory.privacy")}</p>
            <a
              href="https://github.com/dramaclaw/dramaclaw/blob/main/docs/chat-history-oom-recovery.md"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block underline underline-offset-2"
            >
              {t("chatSnapshot.ceHistory.recoveryGuide")}
            </a>
          </div>
        </details>
        <a
          href="https://github.com/dramaclaw/dramaclaw/issues/new/choose"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2"
        >
          {t("chatSnapshot.ceHistory.support")}
        </a>
      </div>
    </div>
  );
}
