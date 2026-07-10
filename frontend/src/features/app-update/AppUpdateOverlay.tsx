// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { subscribeAppSelfUpdate } from "@/features/app-update/app-update-events";
import {
  applyAppUpdate,
  fetchAppUpdateStatus,
  type AppUpdateStatus,
} from "@/lib/queries/app-update";

const POLL_INTERVAL_MS = 2_000;
const OVERALL_TIMEOUT_MS = 15 * 60 * 1000;
// 安装/重启前的连续失联容忍(网络抖动);进入安装期后失联=服务在重启,不设限
const EARLY_MISS_LIMIT = 5;

export type OverlayState =
  | { kind: "hidden" }
  | {
      kind: "working";
      tag: string;
      label: "starting" | "downloading" | "installing" | "restarting";
      percent: number;
      misses: number;
    }
  | { kind: "done"; tag: string }
  | { kind: "failed"; tag: string; error: string };

export type PollInput =
  | { ok: true; status: AppUpdateStatus; baseline: string | null }
  | { ok: false };

// 纯函数状态机,便于单测:baseline = 更新发起时的旧版本号,
// 轮询到 current_version 与 baseline 不同即视为新版已起。
export function nextOverlayState(prev: OverlayState, input: PollInput): OverlayState {
  if (prev.kind !== "working") return prev;
  if (!input.ok) {
    if (prev.label === "installing" || prev.label === "restarting") {
      return { ...prev, label: "restarting", misses: 0 };
    }
    const misses = prev.misses + 1;
    if (misses >= EARLY_MISS_LIMIT) {
      return { kind: "failed", tag: prev.tag, error: "connection lost" };
    }
    return { ...prev, misses };
  }
  const { status, baseline } = input;
  if (
    baseline !== null &&
    status.current_version !== null &&
    status.current_version !== baseline
  ) {
    return { kind: "done", tag: prev.tag };
  }
  const progress = status.progress;
  if (progress.phase === "failed") {
    return { kind: "failed", tag: prev.tag, error: progress.error ?? "update failed" };
  }
  if (progress.phase === "downloading") {
    return { ...prev, label: "downloading", percent: progress.percent, misses: 0 };
  }
  if (progress.phase === "verifying" || progress.phase === "launching") {
    return { ...prev, label: "installing", percent: 100, misses: 0 };
  }
  // idle:老服务还在(下载未开始)或重启后的新进程还没换版本号,保持现状
  return { ...prev, misses: 0 };
}

export function AppUpdateOverlay() {
  const { t } = useTranslation();
  const [state, setState] = useState<OverlayState>({ kind: "hidden" });
  const baselineRef = useRef<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(
    () =>
      subscribeAppSelfUpdate(({ latestTag }) => {
        baselineRef.current = null;
        setState({ kind: "working", tag: latestTag, label: "starting", percent: 0, misses: 0 });
        applyAppUpdate().catch((error: unknown) => {
          setState({
            kind: "failed",
            tag: latestTag,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }),
    [],
  );

  useEffect(() => {
    if (state.kind !== "working") return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt > OVERALL_TIMEOUT_MS) {
        window.clearInterval(timer);
        setState((prev) =>
          prev.kind === "working" ? { kind: "failed", tag: prev.tag, error: "timeout" } : prev,
        );
        return;
      }
      void fetchAppUpdateStatus()
        .then((response) => {
          const status = response.data;
          if (baselineRef.current === null && status.current_version) {
            baselineRef.current = status.current_version;
          }
          setState((prev) =>
            nextOverlayState(prev, { ok: true, status, baseline: baselineRef.current }),
          );
        })
        .catch(() => {
          setState((prev) => nextOverlayState(prev, { ok: false }));
        });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // 只在进入/离开 working 时重建轮询,内部状态经函数式 setState 演进
  }, [state.kind]);

  useEffect(() => {
    if (state.kind !== "done") return;
    const timer = window.setTimeout(() => window.location.reload(), 800);
    return () => window.clearTimeout(timer);
  }, [state.kind]);

  if (state.kind === "hidden") return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-[min(calc(100vw-32px),380px)] rounded-[14px] bg-[#16161a] p-6 text-slate-100 shadow-[0_16px_48px_rgba(0,0,0,0.4)]">
        {state.kind === "failed" ? (
          <>
            <div className="flex items-center gap-2 text-[15px] font-medium">
              <TriangleAlert className="size-4 text-amber-400" aria-hidden="true" />
              {t("appUpdate.failedTitle")}
            </div>
            <p className="mt-3 break-all text-[12.5px] leading-6 text-slate-400">{state.error}</p>
            <Button
              type="button"
              className="mt-5 h-9 w-full rounded-[8px]"
              onClick={() => setState({ kind: "hidden" })}
            >
              {t("appUpdate.close")}
            </Button>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-[15px] font-medium">
              <Loader2 className="size-4 animate-spin text-cyan-400" aria-hidden="true" />
              {t("appUpdate.title", { tag: state.tag })}
            </div>
            <p className="mt-3 text-[12.5px] leading-6 text-slate-400">
              {state.kind === "done"
                ? t("appUpdate.done")
                : state.label === "downloading"
                  ? t("appUpdate.downloading", { percent: String(state.percent) })
                  : state.label === "installing"
                    ? t("appUpdate.installing")
                    : state.label === "restarting"
                      ? t("appUpdate.restarting")
                      : t("appUpdate.starting")}
            </p>
            {state.kind === "working" && state.label === "downloading" ? (
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-cyan-400 transition-[width] duration-500"
                  style={{ width: `${Math.max(2, state.percent)}%` }}
                />
              </div>
            ) : null}
            <p className="mt-4 text-[11.5px] leading-5 text-slate-500">{t("appUpdate.keepOpen")}</p>
          </>
        )}
      </div>
    </div>
  );
}
