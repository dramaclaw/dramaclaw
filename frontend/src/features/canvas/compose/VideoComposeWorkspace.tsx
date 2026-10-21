// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clapperboard } from "lucide-react";

import {
  openFreezoneVideoComposeStudio,
  type FreezoneVideoComposeStudioSession,
} from "@/api/ops";
import {
  CANVAS_NODE_TYPES,
  isVideoComposeNode,
} from "@/features/canvas/domain/canvasNodes";
import { localizeNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import { orderedComposeSeedNodeIds } from "@/features/canvas/compose/composeInputOrdering";
import { upstreamNodesInEdgeOrder } from "@/features/canvas/nodes/referenceOrdering";
import { useCanvasStore } from "@/stores/canvasStore";
import { canvasUrlFor } from "@/lib/url-params";
import { resolveComposeTimeline } from "./VideoComposeModal";
import {
  buildComposePayload,
  hasExportableClips,
  type ComposeTimelineState,
} from "./timelineModel";

type VideoComposeWorkspaceProps = {
  projectId: string;
  canvasId: string;
  nodeId: string;
  onExit: () => void;
};

/**
 * Page-level Studio workspace for one video-compose node: the editor fills the
 * left side, the docked assistant is the host's own panel outside this element.
 * The film is generated from the node's current upstream timeline.
 */
export function VideoComposeWorkspace({
  projectId,
  canvasId,
  nodeId,
  onExit,
}: VideoComposeWorkspaceProps) {
  const { t } = useTranslation();
  const [session, setSession] = useState<FreezoneVideoComposeStudioSession | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // StrictMode 的 setup→cleanup→setup 会在草稿落库前把同一个节点开两次：
  // 各自生成一套随机 clip id，Studio 素材库里同一条片段就出现两份。
  // 同一个打开请求复用同一个 Promise，两个 effect 只等结果、不重复建片。
  const openingRef = useRef<{
    key: string;
    promise: Promise<FreezoneVideoComposeStudioSession>;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setError(null);

    const store = useCanvasStore.getState();
    const node = store.nodes.find((item) => item.id === nodeId);
    if (!node || !isVideoComposeNode(node)) {
      setError(t("videoCompose.studio.missingNode"));
      return;
    }

    const seedNodeIds = orderedComposeSeedNodeIds(
      upstreamNodesInEdgeOrder(store.nodes, store.edges, nodeId),
      node.data.compositionInputOrder,
    );
    const draft = node.data.draftTimeline as ComposeTimelineState | undefined;
    const title = localizeNodeDisplayName(
      CANVAS_NODE_TYPES.videoCompose,
      node.data,
      t,
    );

    const openingKey = JSON.stringify([projectId, canvasId, nodeId, retryToken]);
    if (openingRef.current?.key !== openingKey) {
      openingRef.current = {
        key: openingKey,
        promise: (async () => {
          const timeline = await resolveComposeTimeline(draft, seedNodeIds);
          if (!hasExportableClips(timeline)) {
            throw new Error(t("videoCompose.studio.noMedia"));
          }
          // 首次打开就落草稿：随机 clip id 若每次重开都换一套，film 会被判定为
          // 新时间线而重建，Studio 素材库也会一份份堆叠。
          if (!draft?.tracks?.length) {
            store.updateNodeData(nodeId, { draftTimeline: timeline });
          }
          return openFreezoneVideoComposeStudio(projectId, {
            ...buildComposePayload(timeline, {
              title,
              canvasId,
              nodeId,
              fps: 30,
            }),
            hostBack: canvasUrlFor(projectId, canvasId),
            hostBackLabel: t("videoCompose.studio.backToCanvas"),
          });
        })(),
      };
    }
    void openingRef.current.promise.then(
      (next) => {
        if (!cancelled) setSession(next);
      },
      (err) => {
        if (!cancelled) {
          setError(
            `${t("videoCompose.studio.loadFailed")} ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [canvasId, nodeId, projectId, retryToken, t]);

  useEffect(() => {
    if (!session) return;
    const studioOrigin = new URL(session.origin).origin;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== studioOrigin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown } | null;
      if (data?.type !== "dramaclaw:studio-back") return;
      onExit();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onExit, session]);

  const retry = useCallback(() => setRetryToken((token) => token + 1), []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0b0b0c]">
      {error ? (
        <div className="flex h-full w-full items-center justify-center p-8">
          <div className="max-w-md rounded-2xl border border-white/10 bg-white/[0.04] px-6 py-8 text-center">
            <Clapperboard className="mx-auto mb-3 h-8 w-8 text-text-muted" />
            <p className="mb-5 text-sm leading-6 text-text-muted">{error}</p>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={retry}
                className="rounded-lg bg-accent px-4 py-2 text-sm text-white transition hover:bg-accent/90"
              >
                {t("videoCompose.studio.retry")}
              </button>
              <button
                type="button"
                onClick={onExit}
                className="rounded-lg border border-white/15 px-4 py-2 text-sm text-text transition hover:bg-white/[0.06]"
              >
                {t("videoCompose.studio.backToCanvas")}
              </button>
            </div>
          </div>
        </div>
      ) : session ? (
        <iframe
          ref={iframeRef}
          src={session.url}
          title={t("videoCompose.studio.title")}
          className="h-full w-full border-0"
          allow="autoplay; fullscreen; picture-in-picture"
          allowFullScreen
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#0b0b0c] text-text-muted">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" />
          <span className="text-sm">{t("videoCompose.studio.loading")}</span>
        </div>
      )}
    </div>
  );
}
