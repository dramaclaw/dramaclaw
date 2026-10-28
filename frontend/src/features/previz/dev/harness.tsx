// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 预演台冒烟测试的独立页（`e2e/previz.html`）：不登录、不起后端，只把编辑器和它依赖的
 * 画布 store 挂起来。网络请求由 Playwright 拦掉，见 `e2e/previz-record.e2e.ts`。
 *
 * 没有任何应用代码引用这个文件，所以它不进产物；放在 `src` 下只是为了吃到类型检查。
 */
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";

import { ThemeProvider } from "@/components/theme-provider";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { PrevizEditor } from "@/features/previz/PrevizEditor";
import { createDefaultScene } from "@/features/previz/domain/scene";
import { useCanvasStore } from "@/stores/canvasStore";

import "@/i18n";
import "@/index.css";

declare global {
  interface Window {
    /** 给冒烟测试读结果用。 */
    __previzHarness?: {
      /** 画布上从预演台派生出来的视频节点。 */
      videoNodes: () => Array<{ videoUrl: unknown; durationMs: unknown }>;
    };
  }
}

const canvas = useCanvasStore.getState();
canvas.setCanvasData([], []);
canvas.addNode(CANVAS_NODE_TYPES.previz, { x: 0, y: 0 });
const nodeId = useCanvasStore.getState().nodes[0].id;

window.__previzHarness = {
  videoNodes: () =>
    useCanvasStore
      .getState()
      .nodes.filter((node) => node.type === CANVAS_NODE_TYPES.video)
      .map((node) => {
        const data = node.data as Record<string, unknown>;
        return { videoUrl: data.videoUrl, durationMs: data.durationMs };
      }),
};

function Harness() {
  const scene = useMemo(() => {
    const initial = createDefaultScene();
    const frames = Number(new URLSearchParams(window.location.search).get("frames"));
    if (Number.isFinite(frames) && frames > 0) initial.settings.durationFrames = frames;
    return initial;
  }, []);
  return (
    <PrevizEditor
      open
      nodeId={nodeId}
      initialScene={scene}
      onOpenChange={() => {}}
      onFlush={() => true}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <ThemeProvider>
      <Harness />
      {/* 应用里的 ThemedToaster 要读路由，这页没有路由。 */}
      <Toaster position="top-center" theme="dark" />
    </ThemeProvider>
  </QueryClientProvider>,
);
