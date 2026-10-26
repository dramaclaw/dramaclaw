// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Clapperboard } from "lucide-react";

import { ApiError } from "@/api/client";
import {
  openFreezoneVideoComposeStudio,
  type FreezoneVideoComposeStudioSession,
} from "@/api/ops";
import { BackendStatusError } from "@/lib/api-errors";
import {
  CANVAS_NODE_TYPES,
  isVideoComposeNode,
} from "@/features/canvas/domain/canvasNodes";
import { localizeNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import { orderedComposeSeedNodeIds } from "@/features/canvas/compose/composeInputOrdering";
import { upstreamNodesInEdgeOrder } from "@/features/canvas/nodes/referenceOrdering";
import { useCanvasStore } from "@/stores/canvasStore";
import { normalize } from "@/i18n/languages";
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

type ComposeFailure = {
  message: string;
  hint?: string;
  retryable: boolean;
};

class NoMediaError extends Error {}

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
  const { t, i18n } = useTranslation();
  const [session, setSession] = useState<FreezoneVideoComposeStudioSession | null>(
    null,
  );
  const [error, setError] = useState<ComposeFailure | null>(null);
  const [conflict, setConflict] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [editorPainted, setEditorPainted] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 一次性开关：只有用户点了「重新生成」的那次打开带 rebuild，之后的语言切换等
  // 重开仍按默认复用，不会把刚生成的片又覆盖一遍。
  const rebuildOnNextOpen = useRef(false);
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
    setConflict(false);
    setEditorPainted(false);

    const store = useCanvasStore.getState();
    const node = store.nodes.find((item) => item.id === nodeId);
    if (!node || !isVideoComposeNode(node)) {
      setError({
        message: t("videoCompose.studio.missingNode"),
        retryable: false,
      });
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

    const language = normalize(i18n.language);
    const openingKey = JSON.stringify([
      projectId,
      canvasId,
      nodeId,
      retryToken,
      language,
    ]);
    if (openingRef.current?.key !== openingKey) {
      // 「重新生成」是一次性开关，必须在建 Promise 的当下就读走：若等到几个 await
      // 之后才读，用户在途中重试或切语言时，新请求会先清掉它，失败重发又退回 409。
      const rebuild = rebuildOnNextOpen.current;
      openingRef.current = {
        key: openingKey,
        promise: (async () => {
          const timeline = await resolveComposeTimeline(draft, seedNodeIds);
          if (!hasExportableClips(timeline)) {
            throw new NoMediaError();
          }
          // 首次打开就落草稿：随机 clip id 若每次重开都换一套，film 会被判定为
          // 新时间线而重建，Studio 素材库也会一份份堆叠。
          if (!draft?.tracks?.length) {
            store.updateNodeData(nodeId, { draftTimeline: timeline });
          }
          const opened = await openFreezoneVideoComposeStudio(projectId, {
            ...buildComposePayload(timeline, {
              title,
              canvasId,
              nodeId,
              fps: 30,
            }),
            hostBack: canvasUrlFor(projectId, canvasId),
            hostBackLabel: t("videoCompose.studio.backToCanvas"),
            lang: language,
            rebuild,
          });
          // 覆盖成功才算用掉；失败后重试仍要带着 rebuild，否则会再次被 409 拦下。
          if (rebuild) rebuildOnNextOpen.current = false;
          return opened;
        })(),
      };
    }
    void openingRef.current.promise.then(
      (next) => {
        if (!cancelled) setSession(next);
      },
      (err) => {
        if (cancelled) return;
        if (err instanceof NoMediaError) {
          setError({
            message: t("videoCompose.studio.noMedia"),
            hint: t("videoCompose.studio.noMediaHint"),
            retryable: false,
          });
          return;
        }
        // apiCall 会把后端的非 2xx 包装成 BackendStatusError 抛出，只认 ApiError 会
        // 把 409 当成未知失败，用户就永远看不到确认卡片。
        const status =
          err instanceof ApiError || err instanceof BackendStatusError
            ? err.status
            : 0;
        // 后端拒绝用画布草稿覆盖一份手改过的片，等这里问过用户再带 rebuild 重发。
        if (status === 409) {
          setConflict(true);
          return;
        }
        setError({
          message: t("videoCompose.studio.loadFailed"),
          hint:
            status === 404
              ? t("videoCompose.studio.errorNotFound")
              : status === 401
                ? t("videoCompose.studio.errorAuth")
                : t("videoCompose.studio.errorUnavailable"),
          retryable: true,
        });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [canvasId, i18n.language, nodeId, projectId, retryToken, t]);

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
  const confirmRebuild = useCallback(() => {
    rebuildOnNextOpen.current = true;
    setConflict(false);
    setRetryToken((token) => token + 1);
  }, []);

  const loadingSurface = (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#0b0b0c] text-text-muted">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" />
      <span className="text-sm">{t("videoCompose.studio.loading")}</span>
    </div>
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0b0b0c]">
      {conflict ? (
        <div className="flex h-full w-full items-center justify-center p-8">
          <div className="max-w-md rounded-2xl border border-white/10 bg-white/[0.04] px-6 py-8 text-center">
            <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-amber-400" />
            <div className="mb-5 space-y-2">
              <p className="text-sm leading-6 text-text">
                {t("videoCompose.studio.editedTitle")}
              </p>
              <p className="text-sm leading-6 text-text-muted">
                {t("videoCompose.studio.editedBody")}
              </p>
            </div>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={confirmRebuild}
                className="rounded-lg bg-destructive px-4 py-2 text-sm text-white transition hover:bg-destructive/90"
              >
                {t("videoCompose.studio.editedRebuild")}
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
      ) : error ? (
        <div className="flex h-full w-full items-center justify-center p-8">
          <div className="max-w-md rounded-2xl border border-white/10 bg-white/[0.04] px-6 py-8 text-center">
            <Clapperboard className="mx-auto mb-3 h-8 w-8 text-text-muted" />
            <div className="mb-5 space-y-2">
              <p className="text-sm leading-6 text-text">{error.message}</p>
              {error.hint ? (
                <p className="text-sm leading-6 text-text-muted">{error.hint}</p>
              ) : null}
            </div>
            <div className="flex items-center justify-center gap-2">
              {error.retryable ? (
                <button
                  type="button"
                  onClick={retry}
                  className="rounded-lg bg-accent px-4 py-2 text-sm text-white transition hover:bg-accent/90"
                >
                  {t("videoCompose.studio.retry")}
                </button>
              ) : null}
              <button
                type="button"
                onClick={onExit}
                className={
                  error.retryable
                    ? "rounded-lg border border-white/15 px-4 py-2 text-sm text-text transition hover:bg-white/[0.06]"
                    : "rounded-lg bg-accent px-4 py-2 text-sm text-white transition hover:bg-accent/90"
                }
              >
                {t("videoCompose.studio.backToCanvas")}
              </button>
            </div>
          </div>
        </div>
      ) : session ? (
        // iframe 一挂上去就是编辑器的启动过程：OpenFilm 自己的 splash 有它的标记和
        // 文案，刷新时会闪一下「另一个产品」。自家遮罩压到页面画出来为止。
        <div className="relative h-full w-full">
          <iframe
            ref={iframeRef}
            src={session.url}
            title={t("videoCompose.studio.title")}
            className="h-full w-full border-0"
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
            onLoad={() => setEditorPainted(true)}
          />
          {!editorPainted && <div className="absolute inset-0">{loadingSurface}</div>}
        </div>
      ) : (
        loadingSurface
      )}
    </div>
  );
}
