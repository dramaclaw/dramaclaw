// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCanvasStore } from "@/stores/canvasStore";
import { selectNodeExclusively } from "@/features/canvas/application/nodeSelection";
import { MapPin } from "lucide-react";
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
    {/* DESIGN.md Level 3 决策弹窗：中性 surface-modal + ui-border、24px 内边距；
        模态不模糊、组之间靠间距不用分割线。标题/说明/卡片共用同一条左边线。 */}
    <DialogContent
      className="max-h-[min(80vh,640px)] gap-4 overflow-hidden rounded-lg border border-border bg-[var(--ui-surface-modal)] p-6 ring-0 sm:max-w-[480px]"
      overlayClassName="bg-black/60 supports-backdrop-filter:backdrop-blur-none"
      closeButtonClassName="top-5 right-5"
      onClick={(event) => event.stopPropagation()}
    >
      <DialogHeader className="gap-1 pr-10">
        <DialogTitle className="text-lg leading-7 font-semibold">{t("referenceValidation.title")}</DialogTitle>
        <DialogDescription className="text-xs leading-5">{t("referenceValidation.hint")}</DialogDescription>
      </DialogHeader>
      <ul className="ui-scrollbar -mr-2 max-h-[min(60vh,500px)] space-y-2 overflow-y-auto pr-2">
        {issues.map((issue, index) => <li key={index} className="rounded-sm border border-[var(--ui-border-soft)] bg-[rgb(var(--bg-rgb)/0.5)] p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2 py-0.5">
              <span className="shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
                {t(`referenceValidation.${FIRST_FRAME_ROLES.has(issue.role ?? "") ? "firstFrame" : LAST_FRAME_ROLES.has(issue.role ?? "") ? "lastFrame" : issue.media}`)} {issue.index}
              </span>
              <span className="min-w-0 break-all text-sm font-semibold leading-5 text-foreground" title={issue.label || issue.name}>
                {issue.label || issue.name}
              </span>
            </div>
            {issue.nodeId && <button type="button" className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-[11px] py-1 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onClick={(event) => {
              event.stopPropagation();
              const store = useCanvasStore.getState();
              if (store.nodes.some((node) => node.id === issue.nodeId)) {
                selectNodeExclusively(issue.nodeId!);
                store.requestFocusNode(issue.nodeId!);
              }
              onClose();
            }}><MapPin className="size-3.5" aria-hidden="true" />{t("referenceValidation.locate")}</button>}
          </div>
          <p className="mt-2 text-sm leading-5 text-muted-foreground">
            {t(`referenceValidation.${issue.code}`, { actual: display(issue.actual), expected: display(issue.expected) })}
          </p>
        </li>)}
      </ul>
    </DialogContent>
  </Dialog>;
}
