// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCanvasStore } from "@/stores/canvasStore";
import { CircleAlert, MapPin } from "lucide-react";
import { formatAudioDurationSeconds, type AudioDurationRejection } from "./videoModelCapabilities";

const FIRST_FRAME_ROLES = new Set(["首帧", "first_frame"]); // i18n-exempt: backend role values
const LAST_FRAME_ROLES = new Set(["尾帧", "last_frame"]); // i18n-exempt: backend role values

export interface ReferenceIssue {
  media: string;
  index: number;
  name: string;
  reference_key: string;
  code: string;
  actual?: unknown;
  expected?: unknown;
  nodeId?: string;
  label?: string;
  role?: string;
}

export function referenceIssues(error: unknown): ReferenceIssue[] {
  const body = (error as { body?: { detail?: { code?: string; errors?: unknown } } })?.body;
  const detail = body?.detail;
  if (detail?.code !== "REFERENCE_MEDIA_INVALID" || !Array.isArray(detail.errors)) return [];
  return detail.errors.filter((item): item is ReferenceIssue =>
    item && typeof item.code === "string" && typeof item.reference_key === "string"
    && typeof item.media === "string" && typeof item.index === "number",
  );
}

export function matchesReference(url: string, key: string): boolean {
  if (!key) return false;
  try {
    return decodeURIComponent(new URL(url, "https://local.invalid").pathname).endsWith(`/${key}`);
  } catch { return false; }
}

export function referenceIssueName(issue: ReferenceIssue, sourceFileName?: unknown): string {
  return typeof sourceFileName === "string" && sourceFileName.trim()
    ? sourceFileName.trim()
    : issue.name;
}

export function referenceDurationIssues(
  media: "audio" | "video",
  rejection: AudioDurationRejection,
  limits: { minMs?: number; maxMs?: number },
): ReferenceIssue[] {
  const total = rejection.kind === "totalTooShort" || rejection.kind === "totalTooLong";
  const code = rejection.kind === "tooShort" ? "minDuration"
    : rejection.kind === "tooLong" ? "maxDuration"
      : rejection.kind === "totalTooShort" ? "totalMinDuration" : "totalMaxDuration";
  const expectedMs = total ? rejection.limitMs
    : rejection.kind === "tooShort" ? limits.minMs : limits.maxMs;
  return rejection.clips.map((clip, position) => ({
    media,
    index: clip.index ?? position + 1,
    name: clip.label,
    reference_key: clip.url ?? "",
    code,
    actual: formatAudioDurationSeconds(total ? rejection.totalMs : clip.durationMs),
    expected: formatAudioDurationSeconds(expectedMs ?? 0),
    nodeId: clip.nodeId,
  }));
}

export function ReferenceValidationDialog({ issues, open, onClose }: {
  issues: ReferenceIssue[]; open: boolean; onClose: () => void;
}) {
  const { t } = useTranslation();
  const display = (value: unknown) => Array.isArray(value) ? value.join(", ") : String(value ?? "—");
  return <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
    <DialogContent
      className="max-h-[min(80vh,640px)] gap-0 overflow-hidden rounded-2xl border border-border bg-popover p-0 shadow-2xl sm:max-w-[480px]"
      closeButtonClassName="top-4 right-4"
      onClick={(event) => event.stopPropagation()}
    >
      <DialogHeader className="border-b border-border/70 bg-amber-500/[0.06] px-5 py-5 pr-14">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300">
            <CircleAlert className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 space-y-1.5">
            <DialogTitle className="text-base leading-6 font-semibold">{t("referenceValidation.title")}</DialogTitle>
            <DialogDescription className="text-xs leading-5">{t("referenceValidation.hint")}</DialogDescription>
          </div>
        </div>
      </DialogHeader>
      <ul className="max-h-[min(60vh,500px)] space-y-2.5 overflow-y-auto p-4 sm:p-5">
        {issues.map((issue, index) => <li key={index} className="rounded-xl border border-border/80 bg-card/70 p-3.5 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {t(`referenceValidation.${FIRST_FRAME_ROLES.has(issue.role ?? "") ? "firstFrame" : LAST_FRAME_ROLES.has(issue.role ?? "") ? "lastFrame" : issue.media}`)} {issue.index}
            </span>
            <span className="min-w-0 break-all font-mono text-xs font-semibold leading-5 text-foreground" title={issue.label || issue.name}>
              {issue.label || issue.name}
            </span>
          </div>
          <p className="mt-2.5 rounded-lg border border-amber-500/15 bg-amber-500/[0.07] px-3 py-2 text-xs leading-5 text-foreground/85">
            {t(`referenceValidation.${issue.code}`, { actual: display(issue.actual), expected: display(issue.expected) })}
          </p>
          {issue.nodeId && <button type="button" className="mt-2.5 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 dark:text-amber-300" onClick={(event) => {
            event.stopPropagation();
            const store = useCanvasStore.getState();
            if (store.nodes.some((node) => node.id === issue.nodeId)) {
              store.setSelectedNode(issue.nodeId!);
              store.requestFocusNode(issue.nodeId!);
            }
            onClose();
          }}><MapPin className="size-3.5" aria-hidden="true" />{t("referenceValidation.locate")}</button>}
        </li>)}
      </ul>
    </DialogContent>
  </Dialog>;
}
