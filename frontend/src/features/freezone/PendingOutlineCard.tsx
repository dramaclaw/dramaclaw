// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Outline plan card: surfaces the agent-saved `pendingStoryOutline` canvas
// metadata as a confirmable proposal. Confirmation goes exclusively through
// the backend confirm route (never the frontend canvas save path), then the
// canvas is re-pulled so metadata/revision reflect the new state. A successful
// confirm also hands off to `onConfirmed` so the shell can auto-continue the
// agent (「提交并继续」), and a revision conflict only refreshes for review —
// confirming is never retried behind the user's back.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock, LoaderCircle, Pencil, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  confirmStoryOutline,
  type ConfirmOutlineOutcome,
} from "@/api/interactiveStoryOutline";
import type {
  PendingOutlineStatus,
  PendingStoryOutline,
} from "@/features/canvas/story/pendingStoryOutline";
import { refreshRemoteFreezoneCanvas } from "@/features/freezone/canvasSyncRuntime";
import { FREEZONE_DOCK_OFFSET_ANIMATED_STYLE } from "@/features/freezone/dockOffset";
import { Button } from "@/components/ui/button";

function newConfirmIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `outline-confirm:${crypto.randomUUID()}`;
  }
  return `outline-confirm:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function OutlineStatusBadge({ status }: { status: PendingOutlineStatus }) {
  const { t } = useTranslation();
  const label = t(`freezone.outline.status.${status}`);
  if (status === "confirmed" || status === "linked") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
        <CheckCircle2 className="size-3" />
        {status === "linked" ? t("freezone.outline.status.linked") : label}
      </span>
    );
  }
  return (
    <span
      className={
        status === "needs_revision"
          ? "inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning"
          : "inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
      }
    >
      <Clock className="size-3" />
      {label}
    </span>
  );
}

export function PendingOutlineCard({
  projectId,
  canvasId,
  outline,
  canvasRevision,
  onConfirmed,
  onRevisionRequested,
}: {
  projectId: string;
  canvasId: string;
  outline: PendingStoryOutline;
  canvasRevision: number | null;
  /** 确认成功（画布已刷新）后触发：外壳据此把「继续创作」消息交给虾导。 */
  onConfirmed?: (outline: PendingStoryOutline) => void;
  /** 「需要修改」落定（画布已刷新）后触发：外壳展开虾导并预填修改意见草稿。 */
  onRevisionRequested?: (outline: PendingStoryOutline) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Local-only collapse: the card is metadata-driven, so dismissing must not
  // survive a new proposal round.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const outlineKey = `${outline.outline_id}:${outline.updated_at}`;
  useEffect(() => {
    setDismissedKey(null);
    setError(null);
  }, [outlineKey]);

  const refreshCanvas = useCallback(async () => {
    return await refreshRemoteFreezoneCanvas(projectId, canvasId, {
      protectUnsavedLocalEdits: true,
    });
  }, [canvasId, projectId]);

  const attempt = useCallback(
    async (status: "confirmed" | "needs_revision", baseRevision: number): Promise<ConfirmOutlineOutcome> =>
      confirmStoryOutline(projectId, {
        canvas_id: canvasId,
        outline_id: outline.outline_id,
        status,
        base_revision: baseRevision,
        idempotency_key: newConfirmIdempotencyKey(),
      }),
    [canvasId, outline.outline_id, projectId],
  );

  const handleDecision = useCallback(
    async (status: "confirmed" | "needs_revision") => {
      if (busy || canvasRevision === null) return;
      setBusy(true);
      setError(null);
      try {
        const outcome = await attempt(status, canvasRevision);
        if (outcome.kind === "stale") {
          // 冲突说明 Agent 已写入更新的画布。这里只刷新让用户看到最新大纲，
          // 绝不自动重试：同一 outline_id 下内容可能已被换掉，替用户确认一份
          // 没看过的新大纲是不可接受的。刷新后卡片按新 updated_at 重渲染，
          // 由用户重新点击确认。
          const refreshed = await refreshCanvas();
          setError(
            t(
              refreshed
                ? "freezone.outline.superseded"
                : "freezone.outline.refreshBlocked",
            ),
          );
        } else if (outcome.kind === "confirmed") {
          const refreshed = await refreshCanvas();
          if (!refreshed) {
            // 后端决策已经落定，但本地仍有未保存修改，受保护刷新拒绝覆盖。
            // 此时不能把旧 revision/metadata 交给后续聊天接力；等用户在画布
            // 冲突层处理完本地修改并加载最新版本后，再继续创作。
            setError(t("freezone.outline.refreshBlocked"));
            return;
          }
          // 注意：kind "confirmed" 只说明确认请求本身成功，两种决策都会走到这里。
          // 「提交并继续」只能挂在用户真正点了「确认大纲」且后端落定 confirmed 状态时，
          // 否则点「需要修改」会代投一条「大纲已确认」的误导消息。
          if (status === "confirmed" && outcome.result.status === "confirmed") {
            onConfirmed?.(outline);
          } else if (status === "needs_revision" && outcome.result.status === "needs_revision") {
            // 状态已是 needs_revision 时重点也走这里：Agent 只能从聊天里知道要改什么，
            // 不接这一手就是「点了没响应」。
            onRevisionRequested?.(outline);
          }
        } else if (outcome.kind === "superseded") {
          setError(t("freezone.outline.superseded"));
        } else if (outcome.kind === "error") {
          setError(outcome.message || t("freezone.outline.failed"));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t("freezone.outline.failed"));
      } finally {
        setBusy(false);
      }
    },
    [attempt, busy, canvasRevision, onConfirmed, onRevisionRequested, outline, refreshCanvas, t],
  );

  const durationLabel = useMemo(() => {
    if (outline.duration_budget_sec === null) return null;
    const seconds = outline.duration_budget_sec;
    // 短广告预算常不足一分钟：四舍五入到分钟会把 15 秒显示成「1 分钟」，
    // 预算不到 60 秒时直接按秒展示。
    if (seconds < 60) return t("freezone.outline.durationSeconds", { seconds });
    const minutes = Math.round(seconds / 60);
    return t("freezone.outline.duration", { minutes: Math.max(1, minutes) });
  }, [outline.duration_budget_sec, t]);
  const actionable = outline.status === "pending" || outline.status === "needs_revision";
  // 收起只是折叠：大纲内容还在画布 metadata 里，没地方确认的就找不回了。
  // 原地换成紧凑胶囊入口，点开重新展开；新方案（outline_id/updated_at 变化）到达时自动展开。
  if (dismissedKey === outlineKey) {
    // 状态用前置小圆点表达，不放实心徽章：实心 chip 挂在右端会把视觉重心拉偏、
    // 胶囊看着歪。圆点（左）+ 截断标题（右）+ 两端等宽 px-3 才对称。
    const dotClass =
      outline.status === "confirmed" || outline.status === "linked"
        ? "bg-success"
        : outline.status === "needs_revision"
          ? "bg-warning"
          : "bg-muted-foreground";
    return (
      <div
        style={FREEZONE_DOCK_OFFSET_ANIMATED_STYLE}
        className="pointer-events-auto absolute right-4 top-12 z-30"
      >
        <button
          type="button"
          onClick={() => setDismissedKey(null)}
          aria-label={t("freezone.outline.reopen")}
          title={t("freezone.outline.reopen")}
          // 外层容器的 marginRight 已按抽屉宽度整块左移让位，这里不能再减一次
          // dock-width——固定 20rem 减抽屉宽会变成负数，max-width 被夹成 0 而塌成只剩图标。
          className="flex max-w-[min(20rem,calc(100vw_-_3rem))] items-center gap-2 rounded-full border border-border/70 bg-background/95 px-3 py-1.5 text-xs leading-none shadow-lg backdrop-blur transition-colors hover:bg-muted/40"
        >
          <span
            className={`size-2 shrink-0 rounded-full ${dotClass}`}
            aria-hidden
          />
          <span className="min-w-0 truncate">{outline.title}</span>
        </button>
      </div>
    );
  }

  return (
    <div
      // 虾导抽屉是通屏高的 fixed 浮层，压在右侧 z 上；贴右的全局浮层不靠 z 抢，
      // 靠 --freezone-dock-width 自己往左让位（见 dockOffset），否则方案卡整个被盖住。
      style={FREEZONE_DOCK_OFFSET_ANIMATED_STYLE}
      className="pointer-events-auto absolute right-4 top-12 z-30 flex w-[380px] max-w-[calc(100%_-_2rem_-_var(--freezone-dock-width,0px))] flex-col gap-2 rounded-lg border border-border/70 bg-background/95 p-3 shadow-lg backdrop-blur"
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
          {t(outline.kind === "ad" ? "freezone.outline.kindAd" : "freezone.outline.kindStory")}
        </span>
        <div className="min-w-0 flex-1 truncate text-sm font-medium" title={outline.title}>
          {outline.title}
        </div>
        <OutlineStatusBadge status={outline.status} />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setDismissedKey(outlineKey)}
          aria-label={t("freezone.outline.dismiss")}
          title={t("freezone.outline.dismiss")}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="max-h-[40vh] space-y-1.5 overflow-y-auto text-xs leading-relaxed text-muted-foreground">
        <p>{outline.premise}</p>
        <p className="whitespace-pre-line">{outline.plot_summary}</p>
        {outline.interaction_summary && <p>{outline.interaction_summary}</p>}
        {outline.endings_summary && <p>{outline.endings_summary}</p>}
        {durationLabel && <p>{durationLabel}</p>}
        {outline.open_questions.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4">
            {outline.open_questions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        )}
      </div>
      {actionable && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="flex-1"
            onClick={() => void handleDecision("confirmed")}
            disabled={busy || canvasRevision === null}
          >
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
            {t("freezone.outline.confirm")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleDecision("needs_revision")}
            disabled={busy || canvasRevision === null}
          >
            <Pencil className="size-4" />
            {t("freezone.outline.needsRevision")}
          </Button>
        </div>
      )}
      {error && <div className="break-words text-xs text-destructive">{error}</div>}
    </div>
  );
}
