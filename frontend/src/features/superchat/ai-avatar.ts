// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";

/**
 * AI 头像视频(`/video/ai-avatar.mp4`)在每条 assistant 消息上都会渲染一个
 * `<video>`,过去每个元素各发一次请求(即便命中 304 也是一串网络往返,调试噪音大)。
 *
 * 这里把它做成「整会话只取一次」:首次 fetch 后把视频 blob 存进 IndexedDB,并在内存
 * 里共享一个 `blob:` 对象 URL。所有头像复用同一个 URL —— blob: 不走网络,所以多少条
 * 消息都只有一次(甚至零次)请求;重载后直接从 IndexedDB 读,不再 fetch。
 * IndexedDB 不可用(隐私模式等)时回退到原始路径,退化为旧行为,功能不受影响。
 */

const AVATAR_PATH = "/video/ai-avatar.mp4";
const DB_NAME = "supertale-media-cache";
const STORE_NAME = "blobs";
const CACHE_KEY = "ai-avatar.mp4";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<Blob | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as Blob | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Session-wide singleton: every caller awaits the same resolution, so the
// underlying fetch happens at most once.
let avatarUrlPromise: Promise<string> | null = null;

export function loadAiAvatarUrl(): Promise<string> {
  if (!avatarUrlPromise) {
    avatarUrlPromise = (async () => {
      try {
        const db = await openDb();
        const cached = await idbGet(db, CACHE_KEY);
        if (cached) {
          return URL.createObjectURL(cached);
        }
        const response = await fetch(AVATAR_PATH);
        if (!response.ok) {
          throw new Error(`avatar fetch failed: ${response.status}`);
        }
        const blob = await response.blob();
        // Best-effort persist; don't block the URL on the write succeeding.
        idbPut(db, CACHE_KEY, blob).catch(() => undefined);
        return URL.createObjectURL(blob);
      } catch {
        // IndexedDB unavailable / fetch blocked — fall back to the direct path
        // (browser HTTP cache still applies, same as before).
        return AVATAR_PATH;
      }
    })();
  }
  return avatarUrlPromise;
}

/**
 * Resolved AI-avatar source url (a shared `blob:` URL once cached, otherwise the
 * raw path). Returns `null` until ready so callers can hold off rendering the
 * `<video>` — that avoids the brief raw-path request from every freshly mounted
 * avatar before the blob is ready.
 */
export function useAiAvatarUrl(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void loadAiAvatarUrl().then((resolved) => {
      if (active) setUrl(resolved);
    });
    return () => {
      active = false;
    };
  }, []);
  return url;
}
