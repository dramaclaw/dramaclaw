// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { AlertTriangle, CircleX, Lightbulb } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { FormatCheck } from "@/lib/queries/ingest";

type FormatCheckDetailsDialogProps = {
  formatCheck: FormatCheck | null;
  filename?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function FormatCheckDetailsDialog({
  formatCheck,
  filename,
  open,
  onOpenChange,
}: FormatCheckDetailsDialogProps) {
  const { t } = useTranslation();
  const issues = formatCheck?.issues ?? [];
  const isBlocking = formatCheck?.level === "blocking";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl sm:max-w-xl rounded-lg bg-black">
        <DialogHeader>
          <DialogTitle>{t("aiAssistant.formatCheck.title")}</DialogTitle>
          {filename && (
            <p className="truncate text-xs text-muted-foreground" title={filename}>
              {filename}
            </p>
          )}
        </DialogHeader>

        <div className="space-y-4">
          {formatCheck?.summary && (
            <p
              className={
                isBlocking
                  ? "text-sm leading-6 text-destructive"
                  : "text-sm leading-6 text-foreground"
              }
            >
              {formatCheck.summary}
            </p>
          )}

          <div
            className={
              isBlocking
                ? "whitespace-pre-line rounded-md border border-destructive/25 bg-destructive/[0.07] px-3 py-2 text-xs leading-5 text-muted-foreground"
                : "whitespace-pre-line rounded-md border bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground"
            }
          >
            {t("aiAssistant.formatCheck.recommended")}
          </div>

          {issues.length > 0 ? (
            <ScrollArea className="max-h-[46vh]">
              <ul className="space-y-2 pr-3">
                {issues.map((issue, index) => (
                  <li
                    key={`${issue.code}-${issue.line ?? "x"}-${index}`}
                    className="rounded-md border bg-black p-3"
                  >
                    <div className="flex items-start gap-2">
                      {isBlocking ? (
                        <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
                      ) : (
                        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                      )}
                      <div className="min-w-0 flex-1">
                        {issue.message.trim() !== formatCheck?.summary?.trim() && (
                          <p className="break-words text-sm leading-6 text-foreground">
                            {issue.message}
                          </p>
                        )}
                        {issue.fix && (
                          <p className="mt-1.5 flex items-start gap-1.5 break-words text-xs leading-5 text-muted-foreground">
                            <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-primary" />
                            <span>{issue.fix}</span>
                          </p>
                        )}
                      </div>
                      {issue.line != null && (
                        <Badge
                          variant="outline"
                          className="shrink-0 rounded-md font-mono text-muted-foreground"
                        >
                          {t("aiAssistant.formatCheck.lineLabel", { line: issue.line })}
                        </Badge>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("aiAssistant.formatCheck.noIssues")}
            </p>
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t("aiAssistant.formatCheck.close")}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
