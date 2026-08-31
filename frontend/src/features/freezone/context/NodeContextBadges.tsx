// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { isMainlineContext, type MainlineContext } from "./mainlineContext";
import { useTranslation } from "react-i18next";
import type { TFn } from "@/lib/i18n-types";
import type { CandidateBindingRole } from "./mainlineContext";

interface NodeContextBadgesProps {
  contexts?: unknown;
  variant?: "floating" | "subtle";
}

const KIND_KEYS = new Set([
  "identity",
  "voice",
  "narrator_voice",
  "bgm",
  "sfx",
  "ambient_audio",
  "scene",
  "prop",
  "beat",
  "sketch",
  "frame",
  "video",
  "audio",
  "director_combined",
  "selected_background",
]);

function kindLabel(kind: string, t: TFn): string {
  return KIND_KEYS.has(kind) ? t(`freezone.nodeContext.kind.${kind}`) : kind;
}

function badgeText(ctx: MainlineContext, t: TFn): string {
  if (typeof ctx.episode === "number" && typeof ctx.beat === "number") {
    if (ctx.kind === "beat") return `EP${ctx.episode} / Beat ${ctx.beat}`;
    if (
      ctx.kind === "sketch" ||
      ctx.kind === "frame" ||
      ctx.kind === "video" ||
      ctx.kind === "audio" ||
      ctx.kind === "director_combined" ||
      ctx.kind === "selected_background"
    ) {
      return t("freezone.nodeContext.withEpisodeBeat", {
        label: kindLabel(ctx.kind, t),
        episode: ctx.episode,
        beat: ctx.beat,
      });
    }
  }
  if (ctx.kind === "identity" || ctx.kind === "voice") {
    return t("freezone.nodeContext.withName", {
      label: kindLabel(ctx.kind, t),
      name: ctx.character || ctx.identityId || ctx.label || "",
    });
  }
  if (ctx.kind === "scene") {
    return t("freezone.nodeContext.withName", { label: kindLabel(ctx.kind, t), name: ctx.sceneId || ctx.label || "" });
  }
  if (ctx.kind === "prop") {
    return t("freezone.nodeContext.withName", { label: kindLabel(ctx.kind, t), name: ctx.propId || ctx.label || "" });
  }
  return kindLabel(ctx.kind, t);
}

function contextKey(ctx: MainlineContext, index: number): string {
  return [
    ctx.kind,
    ctx.episode ?? "",
    ctx.beat ?? "",
    ctx.identityId ?? "",
    ctx.sceneId ?? "",
    ctx.propId ?? "",
    ctx.role ?? "",
    index,
  ].join(":");
}

function contextPriority(ctx: MainlineContext): number {
  if (ctx.kind === "beat") return 0;
  if (
    ctx.kind === "sketch" ||
    ctx.kind === "frame" ||
    ctx.kind === "video" ||
    ctx.kind === "audio" ||
    ctx.kind === "director_combined" ||
    ctx.kind === "selected_background"
  ) {
    return 1;
  }
  if (ctx.kind === "identity") return 2;
  if (ctx.kind === "scene") return 3;
  if (ctx.kind === "prop") return 4;
  return 5;
}

export function validMainlineContexts(contexts?: unknown): MainlineContext[] {
  return Array.isArray(contexts)
    ? contexts.filter(isMainlineContext).sort((a, b) => contextPriority(a) - contextPriority(b))
    : [];
}

export function hasMainlineContexts(contexts?: unknown): boolean {
  return validMainlineContexts(contexts).length > 0;
}

export function NodeContextBadges({ contexts, variant = "floating" }: NodeContextBadgesProps) {
  const { t } = useTranslation();
  const valid = validMainlineContexts(contexts);
  if (!valid.length) return null;

  const primary = valid[0];
  const visible = valid.slice(1, 4);
  const restCount = Math.max(0, valid.length - 1 - visible.length);

  if (variant === "subtle") {
    return (
      <div className="flex max-w-full flex-wrap items-center gap-1">
        <div className="inline-flex max-w-full items-center gap-1 rounded-full border border-amber-200/18 bg-amber-200/8 px-2 py-0.5 text-[10px] font-medium leading-none tracking-wide text-amber-100/78 backdrop-blur">
          <LinkIconDot />
          <span className="shrink-0">{t("freezone.nodeContext.mainlineAsset")}</span>
          <span className="min-w-0 truncate text-amber-100/72">{badgeText(primary, t)}</span>
        </div>
        {visible.map((ctx, index) => (
          <span
            key={contextKey(ctx, index)}
            className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] font-medium text-amber-100/62"
          >
            {ctx.markerColor && (
              <span
                className="h-2 w-2 rounded-full border border-white/35"
                style={{ backgroundColor: ctx.markerColor }}
              />
            )}
            <span className="max-w-[180px] truncate">{badgeText(ctx, t)}</span>
          </span>
        ))}
        {restCount > 0 && (
          <span className="inline-flex items-center rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] text-amber-100/60">
            +{restCount}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute left-2 top-9 z-20 flex max-w-[calc(100%-16px)] flex-col items-start gap-1.5">
      <div className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-cyan-200/50 bg-cyan-950/80 px-2.5 py-1 text-[10px] font-semibold tracking-wide text-cyan-50 shadow-[0_0_18px_rgba(34,211,238,0.22)] backdrop-blur">
        <span className="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.9)]" />
        <span className="shrink-0">{t("freezone.nodeContext.mainlineAsset")}</span>
        <span className="min-w-0 truncate text-cyan-100/85">{badgeText(primary, t)}</span>
      </div>
      <div className="flex max-w-full flex-wrap gap-1">
        {visible.map((ctx, index) => (
        <span
          key={contextKey(ctx, index)}
          className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-white/15 bg-black/60 px-2 py-0.5 text-[10px] font-medium text-cyan-100 shadow-sm backdrop-blur"
        >
          {ctx.markerColor && (
            <span
              className="h-2 w-2 rounded-full border border-white/50"
              style={{ backgroundColor: ctx.markerColor }}
            />
          )}
          <span className="max-w-[180px] truncate">{badgeText(ctx, t)}</span>
        </span>
        ))}
        {restCount > 0 && (
          <span className="inline-flex items-center rounded-full border border-white/10 bg-black/55 px-2 py-0.5 text-[10px] text-cyan-100/80">
            +{restCount}
          </span>
        )}
      </div>
    </div>
  );
}

function LinkIconDot() {
  return <span className="h-1.5 w-1.5 rounded-full bg-amber-200/75" />;
}

export function CandidateBindingBadges({ roles }: { roles: CandidateBindingRole[] }) {
  const { t } = useTranslation();
  if (!roles.length) return null;
  return (
    <div className="pointer-events-none absolute right-2 top-9 z-20 flex max-w-[calc(100%-16px)] flex-col items-end gap-1">
      {roles.slice(0, 3).map((role) => (
        <span
          key={role}
          className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-amber-200/45 bg-amber-950/80 px-2 py-0.5 text-[10px] font-semibold text-amber-50 shadow-[0_0_14px_rgba(251,191,36,0.2)] backdrop-blur"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
          {t(`freezone.nodeContext.binding.${role}`)}
        </span>
      ))}
    </div>
  );
}
