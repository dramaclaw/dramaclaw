// SPDX-License-Identifier: Elastic-2.0
import { getRegionCookie } from "@/lib/region-cookie";
import { useTaskCenterStore } from "@/task-center/store";
import { isPikoTaskActive, pikoTaskStorageKey, readPikoTaskSession, reconcilePikoTasks, selectedPikoTask, writePikoTaskSession } from "./piko-task-session";

/** Capture before the workbench provider unmounts and clears its task store. */
export function capturePikoTaskEntry(owner: string | null, href: string, now = Date.now()) {
  if (!owner) return;
  const key = pikoTaskStorageKey(owner, getRegionCookie());
  const previous = readPikoTaskSession(key, now);
  const store = useTaskCenterStore.getState();
  let session = { ...previous, startedAt: now, preferredId: undefined as string | undefined };
  if (store.projectId && (store.isHydrated || store.tasks.size > 0)) {
    session = { ...reconcilePikoTasks(session, store.projectId, owner, [...store.tasks.values()]), preferredId: undefined };
    const url = new URL(href);
    const canvas = url.searchParams.get("canvas");
    const candidates = session.tasks.filter(task => task.projectId === store.projectId && isPikoTaskActive(task));
    session.preferredId = candidates.find(task => task.taskKey === store.selectedTaskKey)?.id
      ?? (canvas ? candidates.filter(task => task.canvasId === canvas).sort((a, b) => b.createdAt - a.createdAt)[0]?.id : undefined)
      ?? selectedPikoTask({ ...session, tasks: candidates })?.id;
  }
  writePikoTaskSession(key, session);
}
