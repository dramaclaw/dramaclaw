// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 画布自动保存的「暂缓」开关。
 *
 * 跨项目粘贴时，节点先带着源项目的媒体 URL 进 store，后端拷贝完成后才改写成目标
 * 项目的地址。中间这 800ms 的自动保存窗口若照常触发，源项目 URL 就会先落库一次——
 * 迁移一旦被打断（关标签、切项目、单条失败），那份脏数据就成了永久状态。
 *
 * 所以粘贴前先 `holdCanvasAutosave(project)`，迁移结束（成功或失败）再 release；
 * `useCanvasSync` 在 hold 期间只写本地草稿、不发 PUT，release 时补一次保存。
 * 每个 hold 都带安全上限，丢了 release 也不会把自动保存永远卡死。
 */

const DEFAULT_MAX_HOLD_MS = 90_000;

type ReleaseListener = (project: string) => void;

const holdsByProject = new Map<string, Set<symbol>>();
const listeners = new Set<ReleaseListener>();

function notifyRelease(project: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(project);
    } catch (error) {
      console.warn('[canvas-autosave-hold] release listener failed', error);
    }
  }
}

/**
 * 暂缓 `project` 的自动保存，返回 release。多个 hold 叠加，全部 release 后才恢复；
 * 超过 `maxMs` 自动 release。
 */
export function holdCanvasAutosave(
  project: string,
  options?: { maxMs?: number },
): () => void {
  const token = Symbol('canvas-autosave-hold');
  let holders = holdsByProject.get(project);
  if (!holders) {
    holders = new Set();
    holdsByProject.set(project, holders);
  }
  holders.add(token);

  let released = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    const current = holdsByProject.get(project);
    if (!current) {
      return;
    }
    current.delete(token);
    if (current.size > 0) {
      return;
    }
    holdsByProject.delete(project);
    notifyRelease(project);
  };

  const maxMs = options?.maxMs ?? DEFAULT_MAX_HOLD_MS;
  if (Number.isFinite(maxMs) && maxMs > 0) {
    timer = setTimeout(() => {
      timer = null;
      console.warn('[canvas-autosave-hold] hold expired, resuming autosave', { project, maxMs });
      release();
    }, maxMs);
  }
  return release;
}

export function isCanvasAutosaveHeld(project: string): boolean {
  const holders = holdsByProject.get(project);
  return Boolean(holders && holders.size > 0);
}

/** 某个项目的所有 hold 都 release 之后回调一次。返回取消订阅。 */
export function subscribeCanvasAutosaveRelease(listener: ReleaseListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
