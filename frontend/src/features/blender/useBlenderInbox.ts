// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { takeBlenderInbox, type BlenderInboxItem } from "@/features/blender/api";
import { spawnAssetNode } from "@/features/canvas/domain/assetDrag";
import type { CanvasAssetDragPayload } from "@/features/canvas/domain/assetDrag";
import {
  measureAspectRatio,
  spawnedNodeSize,
  viewportCenteredPosition,
} from "@/features/freezone/spawnToViewport";
import { SESSION_EXPIRED_EVENT } from "@/lib/session-expiry";
import { useCanvasStore } from "@/stores/canvasStore";
import type { CanvasSyncStatus } from "@/features/freezone/useCanvasSync";

export const BLENDER_INBOX_POLL_MS = 5_000;

/** 连着失败这么多次就停表。网抖一下不该停，但也不该在一条死链上空转到用户离开。 */
const MAX_CONSECUTIVE_FAILURES = 3;

interface SyncGate {
  status: CanvasSyncStatus;
  hydratedProject: string | null;
  hydratedCanvasId: string | null;
}

function toPayload(item: BlenderInboxItem): CanvasAssetDragPayload {
  return {
    kind: item.kind,
    label: item.filename,
    url: item.url,
    sourceFileName: item.filename,
    // 留个出处，以后从节点能查回是哪次投递、哪个相机。
    source: { origin: "blender", delivery_id: item.delivery_id, camera: item.camera },
  };
}

/**
 * 画布页自动认领 Blender 投来的素材。
 *
 * 建完节点**什么都不做**：节点进 store 之后 useCanvasSync 的 subscribe 会发现内容签名
 * 变了，自己带着 base_revision 去 PUT。手写 PUT 会绕过乐观锁和去重。
 *
 * `inbox:take` 是有副作用的——返回的行服务端已经删了。所以拿到就必须用掉，
 * 中途不能因为某一条建不出来就整批扔掉。
 */
export function useBlenderInbox({
  projectId,
  canvasId,
  sync,
}: {
  projectId: string;
  canvasId: string;
  sync: SyncGate;
}) {
  const { t } = useTranslation();
  // hydrate 没完成就建节点，会被 hydrate 整个覆盖掉；冲突/错误态下画布已经存不进去，
  // 再塞节点只会加重冲突。两种情况都不如不轮询。
  const ready =
    sync.hydratedProject === projectId &&
    sync.hydratedCanvasId === canvasId &&
    sync.status !== "conflict" &&
    sync.status !== "error";

  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    let inFlight = false;
    let failures = 0;

    async function claim() {
      // 5 秒一次，一个慢请求就会叠上来。
      if (stopped || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const items = await takeBlenderInbox(projectId);
        failures = 0;
        if (stopped || items.length === 0) return;
        for (const [index, item] of items.entries()) {
          const payload = toPayload(item);
          const ratio = await measureAspectRatio(payload);
          const sized = ratio ? { ...payload, aspectRatio: ratio } : payload;
          const { width, height } = spawnedNodeSize(sized);
          const store = useCanvasStore.getState();
          const nodeId = spawnAssetNode(
            store,
            sized,
            viewportCenteredPosition(store, index, width, height),
          );
          if (index === items.length - 1) store.requestFocusNode(nodeId);
        }
        toast.success(t("blender.inbox.arrived", { count: items.length }));
      } catch {
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          stop();
          console.warn("[blender] 收件箱轮询连续失败，已停表"); // i18n-exempt
        }
      } finally {
        inFlight = false;
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void claim();
    };
    const onFocus = () => void claim();
    const onSessionExpired = () => stop();

    const timer = window.setInterval(() => void claim(), BLENDER_INBOX_POLL_MS);

    // 声明成函数而不是 `const stop = () => …`：`claim` 在 `timer` 之前就引用了它，
    // 箭头函数会在那儿撞上 TDZ。函数声明会提升，所以这个顺序是对的。
    function stop() {
      if (stopped) return;
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }

    window.addEventListener("focus", onFocus);
    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return stop;
  }, [ready, projectId, t]);
}
