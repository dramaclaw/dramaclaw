// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { getRegionCookie } from "@/lib/region-cookie";
import { SESSION_EXPIRED_EVENT } from "@/lib/session-expiry";
import { useAuthStore } from "@/stores/auth-store";
import { startPikoTaskMonitor } from "./piko-task-monitor";
import { isPikoTaskActive, newPikoTaskSession, pikoTaskStorageKey, readPikoTaskSession, reconcilePikoTasks, selectedPikoTask, writePikoTaskSession, type PikoTaskSession } from "./piko-task-session";
import type { PikoLabelClock, PikoTaskLabelStatus } from "./piko-task-label";

export function usePikoTaskStatus(owner: string | null) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const region = getRegionCookie();
  const key = owner ? pikoTaskStorageKey(owner, region) : null;
  const [value, setValue] = useState<{ key: string | null; session: PikoTaskSession }>({ key: null, session: newPikoTaskSession(Date.now()) });
  const live = useRef(value.session);
  const clock = useRef<PikoLabelClock | null>(null);
  const navigationAbort = useRef<AbortController | null>(null);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    clock.current = null;
    setOpening(false);
    if (!key || !owner) {
      live.current = newPikoTaskSession(Date.now());
      setValue({ key, session: live.current });
      return;
    }
    const commit = (session: PikoTaskSession) => {
      live.current = session;
      writePikoTaskSession(key, session);
      setValue({ key, session });
    };
    live.current = readPikoTaskSession(key, Date.now());
    setValue({ key, session: live.current });
    const monitor = startPikoTaskMonitor({
      session: () => live.current,
      onProjects: projects => commit({ ...live.current, tasks: live.current.tasks.filter(task => projects.includes(task.projectId)) }),
      onTasks: (project, tasks) => commit(reconcilePikoTasks(live.current, project, owner, tasks)),
      onRevoked: project => commit({ ...live.current, tasks: live.current.tasks.filter(task => task.projectId !== project) }),
      onUnauthorized: () => commit(newPikoTaskSession(Date.now())),
    });
    const expired = () => {
      monitor.stop();
      navigationAbort.current?.abort();
      navigationAbort.current = null;
      setOpening(false);
      commit(newPikoTaskSession(Date.now()));
    };
    const refresh = () => { if (!document.hidden) monitor.refresh(); };
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      monitor.stop(); navigationAbort.current?.abort(); navigationAbort.current = null;
      window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [key, owner]);

  const task = value.key === key ? selectedPikoTask(value.session) : null;
  const status: PikoTaskLabelStatus | null = task ? isPikoTaskActive(task) ? "running" : task.status === "failed" ? "failed" : "completed" : null;
  // Changing a selected active task or its progress must not restart the display cycle.
  const revision = status === "running" ? "running" : task ? `${status}:${task.id}` : "";
  const open = async () => {
    if (!task || !key || !owner || navigationAbort.current) return;
    const controller = new AbortController();
    navigationAbort.current = controller;
    setOpening(true);
    try {
      const base = `api/v1/projects/${encodeURIComponent(task.projectId)}`;
      const endpoint = task.canvasId ? `${base}/freezone/canvases/${encodeURIComponent(task.canvasId)}` : base;
      const response = await api.get(endpoint, { signal: controller.signal, retry: 0, timeout: 15000, throwHttpErrors: false });
      if (controller.signal.aborted || useAuthStore.getState().username !== owner || getRegionCookie() !== region) return;
      if (response.status === 401) return;
      if ([403, 404, 410].includes(response.status)) {
        toast.error(t("pikoWorld.taskLabel.unavailable"));
        await navigate({ to: "/" });
        return;
      }
      if (!response.ok) throw new Error("Task origin unavailable");
      // Acknowledge only this observed round. Polling may advance while navigation waits.
      const acknowledgedIds = new Set(isPikoTaskActive(task) ? [] : live.current.tasks
        .filter(item => !isPikoTaskActive(item) && !item.acknowledged).map(item => item.id));
      const commitAcknowledgement = (acknowledged: boolean) => {
        const session = { ...live.current, tasks: live.current.tasks.map(item =>
          acknowledgedIds.has(item.id) ? { ...item, acknowledged } : item) };
        live.current = session;
        writePikoTaskSession(key, session);
        setValue({ key, session });
      };
      commitAcknowledgement(true);
      try {
        const destination = new URL(task.destination, window.location.origin);
        await navigate({ to: destination.pathname, search: Object.fromEntries(destination.searchParams) });
      } catch (error) {
        if (!controller.signal.aborted) commitAcknowledgement(false);
        throw error;
      }
    } catch {
      if (!controller.signal.aborted) toast.error(t("pikoWorld.taskLabel.openError"));
    } finally {
      if (navigationAbort.current === controller) navigationAbort.current = null;
      if (!controller.signal.aborted) setOpening(false);
    }
  };
  return { status, revision, clock, opening, open };
}
export type PikoOwnTaskStatus = ReturnType<typeof usePikoTaskStatus>;
