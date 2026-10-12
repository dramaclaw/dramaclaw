// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Check, Copy, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { promptPreviewContextFromRoute } from "@/lib/prompt-preview-routes";
import {
  usePromptPreview,
  usePromptPreviewSteps,
  type PromptPart,
} from "@/lib/queries/prompt-preview";
import {
  PROMPT_PREVIEW_WIDTH_DEFAULT,
  clampPromptPreviewWidth,
  usePromptPreviewStore,
} from "@/stores/prompt-preview-store";

type PreviewTab = "preview" | "lastSent" | "inputs";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="size-6"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

function PromptBlock({ label, text, copyLabel }: { label: string; text: string; copyLabel: string }) {
  return (
    <section className="rounded-md border border-border/70 bg-muted/30">
      <header className="flex items-center justify-between border-b border-border/60 px-2.5 py-1">
        <span className="font-mono text-[11px] text-muted-foreground">{label}</span>
        <CopyButton text={text} label={copyLabel} />
      </header>
      <pre className="max-h-[48vh] overflow-auto whitespace-pre-wrap break-words p-2.5 text-xs leading-relaxed">
        {text}
      </pre>
    </section>
  );
}

const selectClass =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

function PromptPreviewBody({ project }: { project: string }) {
  const { t } = useTranslation();
  const setOpen = usePromptPreviewStore((s) => s.setOpen);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.search });
  const route = useMemo(
    () => promptPreviewContextFromRoute(pathname, search),
    [pathname, search],
  );

  const [stepOverride, setStepOverride] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [tab, setTab] = useState<PreviewTab>("preview");

  // Following the page again whenever the user navigates.
  useEffect(() => {
    setStepOverride(null);
    setTarget("");
  }, [route.step, route.episode, project]);

  const steps = usePromptPreviewSteps(project, route.episode, true);
  const stepList = steps.data ?? [];
  const activeStep =
    stepOverride ?? route.step ?? stepList.find((s) => s.supported)?.step ?? null;
  const stepInfo = stepList.find((s) => s.step === activeStep) ?? null;
  const targets = stepInfo?.targets ?? [];
  const activeTarget = targets.some((x) => x.id === target) ? target : (targets[0]?.id ?? "");
  const needsEpisode = !!stepInfo?.needs_episode && route.episode === null;
  const buildable = !!stepInfo?.supported && !needsEpisode && (targets.length === 0 || !!activeTarget);

  const preview = usePromptPreview(project, activeStep, route.episode, activeTarget, buildable);
  const data = preview.data;
  const refreshing = steps.isFetching || preview.isFetching;

  const refresh = useCallback(() => {
    void steps.refetch();
    void preview.refetch();
  }, [steps, preview]);

  const copyLabel = t("promptPreview.copy");
  let content: React.ReactNode;
  if (steps.isError || preview.isError) {
    content = <p className="text-xs text-destructive">{t("promptPreview.loadFailed")}</p>;
  } else if (!stepInfo) {
    content = <p className="text-xs text-muted-foreground">{t("promptPreview.loading")}</p>;
  } else if (!stepInfo.supported) {
    content = (
      <p className="text-xs text-muted-foreground">
        {stepInfo.note || t("promptPreview.unsupported")}
      </p>
    );
  } else if (needsEpisode) {
    content = <p className="text-xs text-muted-foreground">{t("promptPreview.needsEpisode")}</p>;
  } else if (targets.length === 0) {
    content = <p className="text-xs text-muted-foreground">{t("promptPreview.noTargets")}</p>;
  } else if (!data) {
    content = <p className="text-xs text-muted-foreground">{t("promptPreview.loading")}</p>;
  } else {
    content = (
      <div className="space-y-2">
        <div role="tablist" className="flex gap-1">
          {(["preview", "lastSent", "inputs"] as PreviewTab[]).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`rounded px-2 py-1 text-xs ${
                tab === id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
              }`}
            >
              {t(`promptPreview.tab.${id}`)}
            </button>
          ))}
        </div>
        {data.note ? <p className="text-xs text-muted-foreground">{data.note}</p> : null}
        {tab === "preview" &&
          (data.parts.length ? (
            data.parts.map((part: PromptPart, i: number) => (
              <PromptBlock
                key={`${part.label}-${i}`}
                label={`${part.role} · ${part.label}`}
                text={part.text}
                copyLabel={copyLabel}
              />
            ))
          ) : (
            <p className="text-xs text-muted-foreground">{t("promptPreview.empty")}</p>
          ))}
        {tab === "lastSent" &&
          (data.last_sent ? (
            <>
              <p className="text-[11px] text-muted-foreground">
                {new Date(data.last_sent.mtime * 1000).toLocaleString()}
              </p>
              <PromptBlock
                label={data.last_sent.path.split("/").slice(-2).join("/")}
                text={data.last_sent.text}
                copyLabel={copyLabel}
              />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t("promptPreview.noLastSent")}</p>
          ))}
        {tab === "inputs" && (
          <PromptBlock
            label="inputs"
            text={JSON.stringify(data.inputs, null, 2)}
            copyLabel={copyLabel}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
        <h2 className="text-sm font-medium">{t("promptPreview.title")}</h2>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            aria-label={t("promptPreview.refresh")}
            onClick={refresh}
          >
            <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            aria-label={t("promptPreview.close")}
            onClick={() => setOpen(false)}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
      <div className="space-y-2 border-b border-border/70 p-3">
        <select
          aria-label={t("promptPreview.step")}
          className={selectClass}
          value={activeStep ?? ""}
          onChange={(e) => {
            setStepOverride(e.target.value);
            setTarget("");
          }}
        >
          {stepList.map((s) => (
            <option key={s.step} value={s.step}>
              {s.label}
              {s.supported ? "" : ` (${t("promptPreview.soon")})`}
            </option>
          ))}
        </select>
        {targets.length > 0 ? (
          <select
            aria-label={t("promptPreview.target")}
            className={selectClass}
            value={activeTarget}
            onChange={(e) => setTarget(e.target.value)}
          >
            {targets.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{content}</div>
    </div>
  );
}

export function PromptPreviewPanel({ project }: { project: string | null }) {
  const { t } = useTranslation();
  const open = usePromptPreviewStore((s) => s.open);
  const setOpen = usePromptPreviewStore((s) => s.setOpen);
  const width = usePromptPreviewStore((s) => s.width);
  const setWidth = usePromptPreviewStore((s) => s.setWidth);
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [resizing, setResizing] = useState(false);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startWidth = width || PROMPT_PREVIEW_WIDTH_DEFAULT;
      let cleaned = false;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      setResizing(true);

      const onMove = (e: PointerEvent) => {
        if (e.pointerId === pointerId) setWidth(startWidth + startX - e.clientX);
      };
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        window.removeEventListener("blur", cleanup);
        target.removeEventListener("lostpointercapture", cleanup);
        try {
          if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
        } catch {
          // Pointer capture can already be released by the browser.
        }
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setResizing(false);
      };
      try {
        target.setPointerCapture(pointerId);
      } catch {
        // Some browsers reject capture for non-primary pointers.
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
      window.addEventListener("blur", cleanup);
      target.addEventListener("lostpointercapture", cleanup);
    },
    [setWidth, width],
  );

  if (!open || !project) return null;

  if (!isDesktop) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-full flex-col p-0 sm:!max-w-[560px]">
          <SheetHeader className="sr-only">
            <SheetTitle>{t("promptPreview.title")}</SheetTitle>
            <SheetDescription>{t("promptPreview.description")}</SheetDescription>
          </SheetHeader>
          <PromptPreviewBody project={project} />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <>
      <div
        className="group flex h-full w-2 shrink-0 cursor-col-resize touch-none items-stretch justify-center bg-border/25 transition-colors hover:bg-primary/20"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("promptPreview.resize")}
        title={t("promptPreview.resize")}
        onPointerDown={startResize}
      >
        <span className="h-full w-px bg-border/80 transition-colors group-hover:bg-primary" />
      </div>
      {resizing ? <div className="fixed inset-0 z-50 cursor-col-resize" aria-hidden="true" /> : null}
      <aside
        className="flex h-full shrink-0 flex-col overflow-hidden border-l border-border/70 bg-background"
        style={{ width: clampPromptPreviewWidth(width) }}
        aria-label={t("promptPreview.title")}
      >
        <PromptPreviewBody project={project} />
      </aside>
    </>
  );
}
