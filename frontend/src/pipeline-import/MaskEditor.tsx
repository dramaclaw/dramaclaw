// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import {
  submitFreezoneRedraw,
  uploadFreezoneImage,
  fetchFreezoneJobResult,
} from "@/api/ops";
import { awaitTaskCompletion } from "@/api/tasks";

interface MaskEditorProps {
  project: string;
  /** Base image URL (cookie-protected /static/...) */
  baseUrl: string;
  /** Optional readable label shown in header. */
  baseLabel?: string;
  onClose: () => void;
  /** Called with the new edited image URL once the OpenAI task completes. */
  onResult: (url: string) => void;
}

type Tool = "brush" | "eraser";

const BRUSH_SIZES = [10, 25, 50, 100, 150];
const DEFAULT_BRUSH = 50;

/**
 * Mask edit UI:
 *   - Canvas A renders the base image (read-only).
 *   - Canvas B floats above as a translucent red mask layer the user paints on.
 *   - On submit, we composite Canvas B into a "transparent-on-white" PNG
 *     (transparent = paint = editable region per OpenAI's mask convention),
 *     upload it to /freezone/upload, then POST /freezone/redraw with mask_url.
 */
export function MaskEditor({
  project,
  baseUrl,
  baseLabel,
  onClose,
  onResult,
}: MaskEditorProps) {
  const baseImgRef = useRef<HTMLImageElement | null>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  const [tool, setTool] = useState<Tool>("brush");
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH);
  const [prompt, setPrompt] = useState("");
  const [imageReady, setImageReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 1. Load base image, size both canvases, draw image on baseCanvas.
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = baseUrl;
    img.onload = () => {
      baseImgRef.current = img;
      const baseCanvas = baseCanvasRef.current;
      const maskCanvas = maskCanvasRef.current;
      if (!baseCanvas || !maskCanvas) return;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      baseCanvas.width = w;
      baseCanvas.height = h;
      maskCanvas.width = w;
      maskCanvas.height = h;
      const ctx = baseCanvas.getContext("2d");
      ctx?.drawImage(img, 0, 0);
      setImageReady(true);
    };
    img.onerror = () => setError("无法加载基底图（cookie 可能过期）");
  }, [baseUrl]);

  // 2. Painting handlers
  const canvasToImageCoords = (clientX: number, clientY: number) => {
    const canvas = maskCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  };

  const drawDot = (x: number, y: number) => {
    const canvas = maskCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (tool === "brush") {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(239, 68, 68, 0.55)";
    } else {
      ctx.globalCompositeOperation = "destination-out";
    }
    ctx.beginPath();
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
  };

  const drawLine = (
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) => {
    const canvas = maskCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = brushSize;
    if (tool === "brush") {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(239, 68, 68, 0.55)";
    } else {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    }
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (submitting) return;
    drawingRef.current = true;
    const coord = canvasToImageCoords(e.clientX, e.clientY);
    if (!coord) return;
    lastPointRef.current = coord;
    drawDot(coord.x, coord.y);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const coord = canvasToImageCoords(e.clientX, e.clientY);
    if (!coord) return;
    if (lastPointRef.current) drawLine(lastPointRef.current, coord);
    lastPointRef.current = coord;
  };
  const onPointerUp = () => {
    drawingRef.current = false;
    lastPointRef.current = null;
  };
  const clearMask = () => {
    const canvas = maskCanvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  };

  /**
   * Build the OpenAI-shaped mask PNG:
   *   transparent pixels = painted region (editable),
   *   opaque pixels (white) = preserve.
   * Our mask canvas already has paint at non-transparent pixels — we invert
   * by drawing a white background under "everywhere except where we painted":
   * a destination-out using current alpha then fill white in-place.
   */
  const buildMaskBlob = async (): Promise<Blob> => {
    const src = maskCanvasRef.current;
    if (!src) throw new Error("mask canvas not ready");
    const w = src.width;
    const h = src.height;
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d");
    if (!ctx) throw new Error("ctx");
    // 1. Fill the whole output canvas opaque white = "preserve everywhere".
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.fillRect(0, 0, w, h);
    // 2. Punch holes wherever the painted mask has non-transparent pixels.
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(src, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      out.toBlob((blob) => {
        if (!blob) reject(new Error("toBlob returned null"));
        else resolve(blob);
      }, "image/png");
    });
  };

  const hasPaint = (): boolean => {
    const canvas = maskCanvasRef.current;
    if (!canvas) return false;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    // Sample alpha at every 16th pixel — fast and good enough for "anything painted".
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 16 * 4) {
      if (data[i] > 8) return true;
    }
    return false;
  };

  const handleSubmit = async () => {
    if (!prompt.trim()) {
      setError("写一句 prompt 描述要把蒙版区域改成什么");
      return;
    }
    if (!hasPaint()) {
      setError("先涂个区域吧（红色画笔涂哪改哪）");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      setProgressMsg("生成 mask 文件...");
      const maskBlob = await buildMaskBlob();
      const maskFile = new File([maskBlob], "mask.png", { type: "image/png" });
      setProgressMsg("上传 mask...");
      const uploaded = await uploadFreezoneImage(project, maskFile);

      setProgressMsg("提交局部重绘...");
      const ref = await submitFreezoneRedraw(project, {
        sourceUrl: baseUrl,
        maskUrl: uploaded.url.split("?")[0],
        prompt,
      });
      setProgressMsg("处理中（30-60s）...");
      const completed = await awaitTaskCompletion(ref.task_key, project);
      const directUrl =
        (completed.result?.["output_url"] as string | undefined) || undefined;
      const url =
        directUrl ??
        (await fetchFreezoneJobResult(project, ref.task_type, ref.job_id))
          .url;
      setProgressMsg("完成");
      onResult(url);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgressMsg(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6">
      <div className="bg-surface border border-border-default rounded-2xl w-[90vw] max-w-[1200px] h-[85vh] flex flex-col overflow-hidden">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border-default">
          <div>
            <div className="text-sm font-semibold text-text">✏️ Mask 蒙版编辑</div>
            <div className="text-xs text-text-muted mt-0.5 truncate max-w-md">
              {baseLabel || baseUrl}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-text-muted hover:text-text text-sm disabled:opacity-30"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        {/* Toolbar */}
        <div className="px-5 py-2 border-b border-border-default flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <ToolBtn active={tool === "brush"} onClick={() => setTool("brush")}>
              🖌 笔刷
            </ToolBtn>
            <ToolBtn
              active={tool === "eraser"}
              onClick={() => setTool("eraser")}
            >
              🧽 橡皮
            </ToolBtn>
          </div>
          <div className="text-xs text-text-muted">|</div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-text-muted">大小</span>
            {BRUSH_SIZES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setBrushSize(s)}
                className={
                  "px-1.5 py-0.5 rounded text-xs transition " +
                  (brushSize === s
                    ? "bg-accent/30 text-accent"
                    : "text-text-muted hover:text-text")
                }
              >
                {s}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={clearMask}
            className="ml-auto px-2.5 py-1 rounded text-xs text-text-muted hover:text-red-400 transition"
            title="清空蒙版"
          >
            清空
          </button>
        </div>

        {/* Canvas */}
        <div className="flex-1 relative bg-bg-dark overflow-hidden flex items-center justify-center p-4">
          {!imageReady && (
            <div className="text-text-muted text-sm">加载基底图...</div>
          )}
          <div
            className={
              "relative max-w-full max-h-full " +
              (imageReady ? "" : "hidden")
            }
            style={{
              cursor: tool === "brush" ? "crosshair" : "cell",
            }}
          >
            <canvas
              ref={baseCanvasRef}
              className="block max-w-full max-h-[calc(85vh-220px)] h-auto pointer-events-none"
            />
            <canvas
              ref={maskCanvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              className="absolute inset-0 w-full h-full"
              style={{ touchAction: "none" }}
            />
          </div>
        </div>

        {/* Prompt + submit */}
        <footer className="px-5 py-3 border-t border-border-default space-y-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="蒙版区域改成什么？例：改成蓝色长发 / 加一束阳光 / 移除背景路人..."
            rows={2}
            disabled={submitting}
            className="w-full px-3 py-2 rounded-lg bg-bg-dark border border-border-default text-text text-sm focus:outline-none focus:border-accent transition resize-none"
          />
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-text-muted/80 flex-1 min-w-0 truncate">
              {progressMsg ? (
                <span className="text-accent">{progressMsg}</span>
              ) : error ? (
                <span className="text-red-400">{error}</span>
              ) : (
                <>红色 = 待编辑区域 · LingShan-G2 · 可能 30-60 秒</>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="px-3 py-1.5 rounded-lg text-text-muted hover:text-text text-sm transition disabled:opacity-30"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || !imageReady}
                className="px-4 py-1.5 rounded-lg bg-accent/90 hover:bg-accent text-white text-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? "处理中..." : "Apply"}
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

function ToolBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-2.5 py-1 rounded text-xs transition " +
        (active
          ? "bg-accent/20 text-accent border border-accent/40"
          : "border border-transparent text-text-muted hover:text-text")
      }
    >
      {children}
    </button>
  );
}
