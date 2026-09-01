// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useViewerImmersiveBody } from "@/features/viewer-kit/useViewerImmersiveBody";

import { PrevizRenderer } from "./engine/PrevizRenderer";
import { usePrevizStore } from "./store";
import type { PrevizScene } from "./domain/scene";

interface PrevizEditorProps {
  open: boolean;
  initialScene: PrevizScene;
  onOpenChange: (open: boolean) => void;
  /** 关闭时把当前场景交回节点落盘；编辑期不逐帧写 node.data。 */
  onFlush: (scene: PrevizScene) => void;
}

export function PrevizEditor({ open, initialScene, onOpenChange, onFlush }: PrevizEditorProps) {
  const { t } = useTranslation();
  // 不能用 useRef：base-ui 的 Dialog.Portal 靠 store 里的 `mounted` 决定是否渲染子树，
  // 而 `mounted` 是在 open 生效之后的一次提交里才置上的，所以本组件第一次跑 effect 时
  // 弹窗内容还没进 DOM、ref 还是 null；effect 只依赖 [open]，之后再也不会重跑，
  // 渲染器就永远建不起来。改成把 canvas 存进 state：元素真正挂上时触发一次重渲染，
  // effect 这才拿得到它。
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const loadScene = usePrevizStore((state) => state.loadScene);
  const durationFrames = usePrevizStore((state) => state.scene.settings.durationFrames);

  // 全屏时独占键盘，让画布的 Delete / 复制粘贴快捷键让位。
  useViewerImmersiveBody(open);

  useEffect(() => {
    if (!open) return;
    loadScene(initialScene);
  }, [open, initialScene, loadScene]);

  useEffect(() => {
    if (!open || !canvas) return undefined;

    let renderer: PrevizRenderer | null = null;
    let cancelled = false;

    void PrevizRenderer.create(canvas).then((created) => {
      // create() 是异步的，弹窗可能在 three chunk 落地前就关了。
      if (cancelled) {
        created.dispose();
        return;
      }
      // 这里不用再调 resize()：`create()` 内部已经在 `start()` 之前调过一次。
      // 下面 ResizeObserver 首次 observe 时也会立刻回调一次，但那一次很可能早于
      // create() 落地、`renderer` 还是 null——首帧尺寸正确靠的是 create() 内部那次。
      renderer = created;
    });

    const observer = new ResizeObserver(() => renderer?.resize());
    observer.observe(canvas);

    return () => {
      cancelled = true;
      observer.disconnect();
      renderer?.dispose();
    };
  }, [open, canvas]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) onFlush(usePrevizStore.getState().scene);
      onOpenChange(next);
    },
    [onFlush, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="inset-0 left-0 top-0 h-dvh w-dvw max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 p-0 ring-0 sm:max-w-none"
        overlayClassName="bg-black/55 supports-backdrop-filter:backdrop-blur-none"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t("previz.editor.title")}</DialogTitle>
          <DialogDescription>{t("previz.editor.description")}</DialogDescription>
        </DialogHeader>

        <div className="relative h-full w-full bg-[#101216]">
          <canvas ref={setCanvas} data-testid="previz-canvas" className="block h-full w-full" />

          <div className="pointer-events-none absolute left-4 top-4 rounded-lg bg-black/45 px-3 py-1.5 text-xs text-white/80">
            {t("previz.editor.duration", { frames: durationFrames })}
          </div>

          <Button
            variant="ghost"
            size="icon"
            aria-label={t("previz.editor.close")}
            className="absolute right-4 top-4 text-white/80 hover:text-white"
            onClick={() => handleOpenChange(false)}
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default PrevizEditor;
