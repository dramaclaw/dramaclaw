// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PushTarget } from "@/api/push";
import type { TFn } from "@/lib/i18n-types";
import { promoteToAsset } from "./promoteToAsset";

const GLOBAL_SLOT_KINDS = new Set<PushTarget["kind"]>([
  "identity",
  "portrait",
  "scene_master",
  "scene_reverse_master",
  "scene_spatial_layout",
  "scene_director_pano_360",
  "scene_3gs_master_ply",
  "scene_3gs_reverse_ply",
  "scene_3gs_pano_ply",
  "scene_3gs_custom_scene",
  "prop_ref",
]);

export interface BatchCommitItem {
  id: string;
  imageUrl: string;
  previewUrl: string | null;
  /** Filled when the node carries `__freezone_source` provenance. */
  target: PushTarget | null;
  /** Human label for the list. */
  label: string;
}

interface BatchCommitDialogProps {
  project: string;
  items: BatchCommitItem[];
  onClose: () => void;
  onDone: (msg: string) => void;
}

type ItemStatus = "pending" | "running" | "ok" | "failed" | "skipped";

interface RowState {
  status: ItemStatus;
  error?: string;
  result?: { target_path: string; backup: string | null };
}

/**
 * Send each selected image back to its origin slot (the slot it was originally
 * imported from, captured in `__freezone_source`). Items without provenance
 * are listed but skipped — they need single-source Commit instead.
 */
export function BatchCommitDialog({
  project,
  items,
  onClose,
  onDone,
}: BatchCommitDialogProps) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(
      items.map((it) => [
        it.id,
        { status: it.target ? "pending" : "skipped" } as RowState,
      ]),
    ),
  );
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const sendable = items.filter((it) => it.target !== null);
  const succeeded = Object.values(rows).filter((r) => r.status === "ok").length;
  const failed = Object.values(rows).filter((r) => r.status === "failed").length;

  const runCommit = async (only: "all" | "failed") => {
    setSubmitting(true);
    const queue = items.filter((it) => {
      if (!it.target) return false;
      const cur = rows[it.id]?.status;
      if (only === "failed") return cur === "failed";
      // all → run pending + retry failed
      return cur === "pending" || cur === "failed";
    });
    for (const it of queue) {
      setRows((r) => ({ ...r, [it.id]: { status: "running" } }));
      try {
        const result = await promoteToAsset(project, it.imageUrl, it.target!, {
          mark_stale: GLOBAL_SLOT_KINDS.has(it.target!.kind),
        });
        setRows((r) => ({
          ...r,
          [it.id]: {
            status: "ok",
            result: { target_path: result.target_path, backup: result.backup },
          },
        }));
      } catch (err) {
        setRows((r) => ({
          ...r,
          [it.id]: {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    }
    setSubmitting(false);
    setDone(true);
  };

  const handleClose = () => {
    if (done && succeeded > 0) {
      onDone(
        t("freezone.commit.batch.doneMessage", {
          succeeded,
          failed,
          skipped: items.length - sendable.length,
        }),
      );
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6">
      <div className="bg-surface border border-border-default rounded-2xl w-[640px] max-h-[80vh] overflow-hidden flex flex-col">
        <header className="flex items-center justify-between px-5 py-4 border-b border-border-default">
          <div>
            <div className="text-base font-semibold text-text">
              {t("freezone.commit.batch.title")}
            </div>
            <div className="text-xs text-text-muted mt-0.5">
              {t("freezone.commit.batch.subtitle", {
                project,
                total: items.length,
                sendable: sendable.length,
                skipped: items.length - sendable.length,
              })}
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="text-text-muted hover:text-text transition text-sm"
            aria-label={t("common.close")}
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="text-xs text-text-muted/80 mb-3 leading-relaxed">
            {t("freezone.commit.batch.hint")}
          </div>
          <ul className="space-y-1.5">
            {items.map((it) => {
              const state = rows[it.id] ?? { status: "pending" };
              return (
                <li
                  key={it.id}
                  className="flex items-center gap-3 px-2 py-2 rounded bg-bg-dark/50"
                >
                  {it.previewUrl ? (
                    <img
                      src={it.previewUrl}
                      alt=""
                      className="w-10 h-10 rounded object-cover shrink-0"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded bg-bg-dark shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-text truncate">{it.label}</div>
                    <div className="text-xs text-text-muted truncate">
                      {it.target
                        ? renderTargetLabel(it.target)
                        : t("freezone.commit.batch.noProvenance")}
                    </div>
                  </div>
                  <StatusBadge state={state} t={t} />
                </li>
              );
            })}
          </ul>
        </div>

        <footer className="px-5 py-4 border-t border-border-default flex items-center justify-between">
          <div className="text-sm text-text-muted">
            {done
              ? t("freezone.commit.batch.summaryDone", {
                  succeeded,
                  failed,
                  skipped: items.length - sendable.length,
                })
              : t("freezone.commit.batch.summaryReady", { count: sendable.length })}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="px-3 py-1.5 rounded-lg text-text-muted hover:text-text text-sm transition"
              disabled={submitting}
            >
              {done ? t("freezone.commit.batch.done") : t("common.cancel")}
            </button>
            {!done && (
              <button
                type="button"
                onClick={() => runCommit("all")}
                disabled={submitting || sendable.length === 0}
                className="px-4 py-1.5 rounded-lg bg-accent/90 hover:bg-accent text-white text-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting
                  ? t("freezone.commit.batch.submitting", {
                      current: succeeded + failed,
                      total: sendable.length,
                    })
                  : t("freezone.commit.batch.submit", { count: sendable.length })}
              </button>
            )}
            {done && failed > 0 && (
              <button
                type="button"
                onClick={() => runCommit("failed")}
                disabled={submitting}
                className="px-4 py-1.5 rounded-lg bg-yellow-600/90 hover:bg-yellow-500 text-white text-sm transition"
              >
                {t("freezone.commit.batch.retryFailed", { count: failed })}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function StatusBadge({ state, t }: { state: RowState; t: TFn }) {
  if (state.status === "pending")
    return (
      <span className="text-xs text-text-muted shrink-0">
        {t("freezone.commit.batch.status.pending")}
      </span>
    );
  if (state.status === "running")
    return (
      <span className="text-xs text-accent shrink-0">
        {t("freezone.commit.batch.status.running")}
      </span>
    );
  if (state.status === "ok")
    return (
      <span className="text-xs text-emerald-400 shrink-0">
        {t("freezone.commit.batch.status.ok")}
      </span>
    );
  if (state.status === "skipped")
    return (
      <span className="text-xs text-text-muted/70 shrink-0">
        {t("freezone.commit.batch.status.skipped")}
      </span>
    );
  return (
    <span
      className="text-xs text-red-400 shrink-0 cursor-help"
      title={state.error ?? ""}
    >
      {t("freezone.commit.batch.status.failed")}
    </span>
  );
}

function renderTargetLabel(t: PushTarget): string {
  if (
    t.kind === "frame" ||
    t.kind === "sketch" ||
    t.kind === "director_render" ||
    t.kind === "selected_background" ||
    t.kind === "video"
  ) {
    return `${t.kind} → ep${t.episode} / beat ${t.beat}`;
  }
  if (t.kind === "identity") return `identity → ${t.character} / ${t.identity_id}`;
  if (t.kind === "identity_costume") {
    return `identity costume → ${t.character} / ${t.identity_id}`;
  }
  if (t.kind === "identity_portrait") {
    return `identity portrait → ${t.character} / ${t.identity_id}`;
  }
  if (t.kind === "portrait") return `portrait → ${t.character}`;
  if (isSceneTargetKind(t.kind)) {
    return `${t.kind} → ${(t as unknown as Record<string, unknown>).scene_id}`;
  }
  return `prop_ref → ${(t as unknown as Record<string, unknown>).prop_id}`;
}

function isSceneTargetKind(kind: PushTarget["kind"]): boolean {
  return (
    kind === "scene_master" ||
    kind === "scene_reverse_master" ||
    kind === "scene_spatial_layout" ||
    kind === "scene_360" ||
    kind === "scene_director_pano_360" ||
    kind === "scene_3gs_active_ply" ||
    kind === "scene_3gs_master_ply" ||
    kind === "scene_3gs_reverse_ply" ||
    kind === "scene_3gs_pano_ply" ||
    kind === "scene_3gs_custom_scene" ||
    kind === "scene_3gs_collision_glb"
  );
}
