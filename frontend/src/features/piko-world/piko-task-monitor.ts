// SPDX-License-Identifier: Elastic-2.0
import { api } from "@/lib/api";
import type { TaskState } from "@/task-center/types";
import type { OkResponse } from "@/types/api";
import { isPikoTaskActive, type PikoTaskSession } from "./piko-task-session";

export interface PikoTaskTransport {
  projects(signal: AbortSignal): Promise<string[]>;
  tasks(project: string, signal: AbortSignal): Promise<TaskState[]>;
}
export const pikoTaskTransport: PikoTaskTransport = {
  async projects(signal) {
    const response = await api.get("api/v1/projects", { signal, retry: 0, timeout: 15000 }).json<OkResponse<(string | { id: string; status?: string })[]>>();
    return [...new Set(response.data.flatMap(item => typeof item === "string" ? [item] : item.status !== "deleted" && typeof item.id === "string" ? [item.id] : []))];
  },
  async tasks(project, signal) {
    return (await api.get(`api/v1/projects/${encodeURIComponent(project)}/tasks`, { signal, retry: 0, timeout: 15000 }).json<OkResponse<TaskState[]>>()).data;
  },
};

/** Bounded, cancellable polling across project home-node routes; no new backend endpoint required. */
export function startPikoTaskMonitor(options: {
  transport?: PikoTaskTransport;
  session: () => PikoTaskSession;
  onProjects: (projects: string[]) => void;
  onTasks: (project: string, tasks: TaskState[]) => void;
  onRevoked: (project: string) => void;
  onUnauthorized: () => void;
}) {
  const transport = options.transport ?? pikoTaskTransport;
  const abort = new AbortController();
  let projects = [...new Set(options.session().tasks.map(task => task.projectId))];
  let discoverAt = 0;
  const due = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let wakePending = false;
  const stop = () => { abort.abort(); clearTimeout(timer); };
  const statusOf = (error: unknown) => (error as { response?: { status?: number } })?.response?.status;
  const run = async () => {
    if (abort.signal.aborted) return;
    if (running) { wakePending = true; return; }
    clearTimeout(timer);
    running = true;
    try {
      if (Date.now() >= discoverAt) {
        discoverAt = Date.now() + 60000;
        try {
          projects = await transport.projects(abort.signal);
          if (abort.signal.aborted) return;
          options.onProjects(projects);
          for (const project of due.keys()) if (!projects.includes(project)) due.delete(project);
        } catch (error) {
          if (abort.signal.aborted) return;
          if (statusOf(error) === 401) { options.onUnauthorized(); stop(); return; }
          discoverAt = Date.now() + 15000;
        }
      }
      const queue = projects.filter(project => (due.get(project) ?? 0) <= Date.now());
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length && !abort.signal.aborted) {
          const project = queue.shift()!;
          try {
            const tasks = await transport.tasks(project, abort.signal);
            if (abort.signal.aborted) return;
            options.onTasks(project, tasks);
          } catch (error) {
            if (abort.signal.aborted) return;
            const status = statusOf(error);
            if (status === 401) { options.onUnauthorized(); stop(); return; }
            if (status === 403 || status === 404) options.onRevoked(project);
            // Connection failure preserves the last confirmed task state.
          }
          const active = options.session().tasks.some(task => task.projectId === project && isPikoTaskActive(task));
          due.set(project, Date.now() + (active ? 5000 : 30000));
        }
      }));
    } finally {
      running = false;
      if (!abort.signal.aborted) {
        const delay = wakePending ? 0 : 1000;
        wakePending = false;
        timer = setTimeout(() => { void run(); }, delay);
      }
    }
  };
  void run();
  return {
    stop,
    refresh() { discoverAt = 0; due.clear(); void run(); },
  };
}
