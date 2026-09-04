// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Top-right floating debug dropdown for the freezone canvas. Lets the
 * developer inspect the canvas-save state machine without opening devtools:
 *
 * - Current revision / updated_at / backup_status / hydrated / switching /
 *   lastRemoteNodeCount.
 * - On demand, calls `GET /freezone/canvases/{id}/history` to list snapshot
 *   versions (returns 404 on environments where the backend reliability
 *   change is not deployed yet — surfaced as "接口未上线").
 * - Per history entry: a "恢复此版本" button that POSTs to
 *   `/history/restore`, then triggers a re-hydrate.
 *
 * Strictly debug-only. The panel adds no autosave hooks of its own; it reads
 * what the hook already exposes plus issues two ad-hoc API calls.
 */
// 这个面板只在 DEV 下挂载（而且当前在 FreezoneShell 里被 `false &&` 关着），
// 面向的是改画布同步的人，不是产品用户；文案入词条纯属浪费，整块保留中文。
// i18n-exempt-start

import { useState } from "react";
import { ChevronDown, ChevronUp, RotateCcw, Wrench } from "lucide-react";
import {
  extractHistoryId,
  getFreezoneCanvas,
  listFreezoneCanvasHistory,
  restoreFreezoneCanvasVersion,
  type CanvasBackupStatus,
  type FreezoneCanvasHistoryEntry,
} from "@/api/canvas";
import { ApiError } from "@/api/client";

interface CanvasDebugPanelProps {
  project: string;
  canvasId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placement?: "top-right" | "bottom-right";
  /** Pulled from `useCanvasSync` so the panel mirrors the live state. */
  status: string;
  backupStatus: CanvasBackupStatus | null;
  error: string | null;
  /** Called after a restore succeeds to force a fresh GET hydrate. */
  onRehydrate: () => void;
}

interface RemoteSnapshot {
  revision: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
  nodeCount: number;
  edgeCount: number;
}

export function CanvasDebugPanel({
  project,
  canvasId,
  open,
  onOpenChange,
  placement = "top-right",
  status,
  backupStatus,
  error,
  onRehydrate,
}: CanvasDebugPanelProps) {
  const [remote, setRemote] = useState<RemoteSnapshot | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [history, setHistory] = useState<FreezoneCanvasHistoryEntry[] | null>(
    null,
  );
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [busyHistoryId, setBusyHistoryId] = useState<string | null>(null);

  const fetchRemoteSnapshot = async (): Promise<RemoteSnapshot> => {
    const data = await getFreezoneCanvas(project, canvasId);
    return {
      revision: typeof data.revision === "number" ? data.revision : null,
      updatedAt: typeof data.updated_at === "string" ? data.updated_at : null,
      updatedBy: typeof data.updated_by === "string" ? data.updated_by : null,
      nodeCount: Array.isArray(data.nodes) ? data.nodes.length : 0,
      edgeCount: Array.isArray(data.edges) ? data.edges.length : 0,
    };
  };

  const refreshRemote = async () => {
    setRemoteLoading(true);
    setRemoteError(null);
    try {
      setRemote(await fetchRemoteSnapshot());
    } catch (err) {
      setRemoteError(formatErr(err));
    } finally {
      setRemoteLoading(false);
    }
  };

  const refreshHistory = async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const data = await listFreezoneCanvasHistory(project, canvasId);
      // Dump the raw response so the key-name shift between backend revisions
      // is visible in devtools. The panel itself tolerates several field
      // names via `extractHistoryId`, but seeing the literal shape here is
      // the fastest way to debug a missing `history_id` on the wire.
      console.log("[freezone:debug] history response", data);
      setHistory(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setHistoryError("接口未上线（后端 history endpoint 还没部署）");
      } else {
        setHistoryError(formatErr(err));
      }
      setHistory(null);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleRestore = async (entry: FreezoneCanvasHistoryEntry) => {
    const historyId = extractHistoryId(entry);
    if (!historyId) {
      console.error("[freezone:debug] history entry has no recognizable id", entry);
      window.alert(
        "无法识别此历史项的 id（list 响应里没找到 id / history_id / filename / name 任一字段）。请看 console。",
      );
      return;
    }
    if (!window.confirm(`确认恢复到 ${historyId}？当前版本会先写入 history。`)) {
      return;
    }
    setBusyHistoryId(historyId);
    try {
      // Always fetch the freshest revision right before restore so the
      // backend's optimistic-lock check gets the real "current" value, not
      // whatever the user happened to GET earlier. If another tab moved the
      // revision in between, we want the 409 — not a silent overwrite.
      let snapshot = remote;
      try {
        snapshot = await fetchRemoteSnapshot();
        setRemote(snapshot);
      } catch (probeErr) {
        // If the pre-restore GET fails (e.g. 404 on a fresh canvas), fall
        // back to whatever revision we had cached, including null. Restore
        // still gets a chance to succeed if the backend treats null as
        // "force replace"; if it doesn't, the user sees the real error.
        console.warn("[freezone:debug] pre-restore GET failed", probeErr);
      }
      await restoreFreezoneCanvasVersion(project, canvasId, {
        history_id: historyId,
        base_revision: snapshot?.revision ?? null,
      });
      onRehydrate();
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 404
          ? "接口未上线（后端 canvases/{id}/restore endpoint 还没部署）"
          : formatErr(err);
      window.alert(`恢复失败：${message}`);
    } finally {
      setBusyHistoryId(null);
    }
  };

  const isBottom = placement === "bottom-right";

  return (
    <div
      className={`absolute right-3 z-30 pointer-events-auto ${
        isBottom ? "bottom-3" : "top-3"
      }`}
    >
      <div
        className={`flex items-end gap-1.5 ${
          isBottom ? "flex-col-reverse" : "flex-col"
        }`}
      >
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          className="inline-flex h-6 items-center gap-1 rounded-full bg-white/[0.035] px-2 text-[10px] font-normal text-foreground/68 transition-colors backdrop-blur-sm hover:bg-white/[0.065] hover:text-foreground/86"
          title="画布调试面板（仅开发用）"
        >
          <Wrench className="h-2.5 w-2.5 text-foreground/64" />
          调试
          {open ? (
            <ChevronUp className="h-2.5 w-2.5 text-foreground/54" />
          ) : (
            <ChevronDown className="h-2.5 w-2.5 text-foreground/54" />
          )}
        </button>
        {open && (
          <div className="w-[360px] max-h-[70vh] overflow-y-auto rounded-md border border-white/[0.12] bg-surface text-[12px] shadow-lg backdrop-blur-sm">
            {/* ----- Hook state ----- */}
            <section className="border-b border-white/[0.10] px-3 py-2 space-y-1">
              <header className="text-[10px] uppercase tracking-wider text-foreground/58">
                Hook state
              </header>
              <Kv k="canvas_id" v={canvasId} mono />
              <Kv k="status" v={status} />
              <Kv k="backup_status" v={backupStatus ?? "—"} />
              {error && <Kv k="error" v={error} wrap />}
            </section>

            {/* ----- Server state ----- */}
            <section className="border-b border-white/[0.10] px-3 py-2 space-y-1">
              <header className="flex items-center justify-between text-[10px] uppercase tracking-wider text-foreground/58">
                <span>Server snapshot</span>
                <button
                  type="button"
                  onClick={() => void refreshRemote()}
                  disabled={remoteLoading}
                  className="rounded border border-white/[0.16] px-1.5 py-0.5 text-[10px] text-foreground/86 hover:bg-white/[0.06] disabled:opacity-50"
                >
                  {remoteLoading ? "..." : "GET"}
                </button>
              </header>
              {remote && (
                <>
                  <Kv k="revision" v={remote.revision ?? "—"} />
                  <Kv k="updated_at" v={remote.updatedAt ?? "—"} />
                  <Kv k="updated_by" v={remote.updatedBy ?? "—"} />
                  <Kv
                    k="nodes / edges"
                    v={`${remote.nodeCount} / ${remote.edgeCount}`}
                  />
                </>
              )}
              {!remote && !remoteLoading && !remoteError && (
                <div className="text-foreground/58 text-[11px]">
                  尚未拉取，点 GET 查询。
                </div>
              )}
              {remoteError && (
                <div className="text-red-300 text-[11px]">{remoteError}</div>
              )}
            </section>

            {/* ----- History ----- */}
            <section className="px-3 py-2 space-y-1">
              <header className="flex items-center justify-between text-[10px] uppercase tracking-wider text-foreground/58">
                <span>History versions</span>
                <button
                  type="button"
                  onClick={() => void refreshHistory()}
                  disabled={historyLoading}
                  className="rounded border border-white/[0.16] px-1.5 py-0.5 text-[10px] text-foreground/86 hover:bg-white/[0.06] disabled:opacity-50"
                >
                  {historyLoading ? "..." : "拉取"}
                </button>
              </header>
              {historyError && (
                <div className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-100">
                  {historyError}
                </div>
              )}
              {history && history.length === 0 && (
                <div className="text-foreground/58 text-[11px]">空（尚无历史快照）</div>
              )}
              {history && history.length > 0 && (
                <ul className="space-y-1">
                  {history.map((entry, index) => {
                    const entryHistoryId = extractHistoryId(entry);
                    const reactKey = entryHistoryId ?? `entry-${index}`;
                    return (
                      <li
                        key={reactKey}
                        className="flex items-start gap-1.5 rounded border border-white/[0.10] px-2 py-1.5"
                      >
                        <div className="flex-1 min-w-0">
                          <div
                            className="truncate font-mono text-[11px] text-text"
                            title={entryHistoryId ?? "(no id)"}
                          >
                            {entryHistoryId ?? "(no id)"}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-foreground/62">
                            {entry.revision != null && <span>rev {entry.revision}</span>}
                            {entry.save_source && <span>{entry.save_source}</span>}
                            {entry.updated_by && <span>by {entry.updated_by}</span>}
                            {typeof entry.size === "number" && (
                              <span>{(entry.size / 1024).toFixed(1)} KB</span>
                            )}
                            {entry.modified_at && (
                              <span title={entry.modified_at}>
                                {entry.modified_at.slice(0, 19).replace("T", " ")}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleRestore(entry)}
                          disabled={
                            busyHistoryId === entryHistoryId || !entryHistoryId
                          }
                          className="shrink-0 inline-flex items-center gap-1 rounded border border-amber-300/40 bg-amber-300/10 px-1.5 py-0.5 text-[10px] text-amber-100 hover:bg-amber-300/20 disabled:opacity-50"
                          title={entryHistoryId ? "恢复此版本" : "缺少 history_id，无法恢复"}
                        >
                          <RotateCcw className="h-3 w-3" />
                          {busyHistoryId === entryHistoryId ? "恢复中" : "恢复"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            <footer className="border-t border-white/[0.10] px-3 py-1.5 text-[10px] text-foreground/54">
              仅调试用 · 后端 history endpoint 未部署时这里会显示"接口未上线"
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}

function Kv({
  k,
  v,
  mono,
  wrap,
}: {
  k: string;
  v: string | number;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2 text-[11px]">
      <span className="shrink-0 w-[88px] text-foreground/56">{k}</span>
      <span
        className={
          (mono ? "font-mono " : "") +
          (wrap ? "break-words text-foreground/90" : "truncate text-foreground/90")
        }
        title={String(v)}
      >
        {String(v)}
      </span>
    </div>
  );
}

function formatErr(err: unknown): string {
  if (err instanceof ApiError) {
    return `${err.status} ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
// i18n-exempt-end
