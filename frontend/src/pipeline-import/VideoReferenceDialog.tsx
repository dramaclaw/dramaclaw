// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileVideo, Film, Loader2, Upload, X } from "lucide-react";

import { submitFreezoneExtract, uploadFreezoneImage } from "@/api/ops";
import { awaitTaskCompletion, type TaskState } from "@/api/tasks";
import { UiButton, UiPanel } from "@/components/ui";
import {
  UI_CONTENT_OVERLAY_INSET_CLASS,
  UI_DIALOG_TRANSITION_MS,
} from "@/components/ui/motion";
import { useDialogTransition } from "@/components/ui/useDialogTransition";
import { Slider } from "@/components/shadcn/slider";

interface VideoReferenceDialogProps {
  project: string;
  onClose: () => void;
  onDone: (msg: string) => void;
  /** Caller drops the resulting reference frames onto canvas as a coupled group. */
  onReferenceReady: (frames: ReferenceFrame[]) => void;
}

export interface ReferenceFrame {
  url: string;
  index: number;
}

type Stage = "idle" | "uploading" | "extracting" | "done" | "error";

interface ProgressState {
  stage: Stage;
  message: string;
  progress: number;
}

/**
 * Like ExtractFramesDialog but tuned for "use a clip as a single style/composition
 * reference":
 *   - Extracts only 3-5 keyframes by default (style refs need few frames).
 *   - Drops them onto canvas grouped + labeled as "Reference: <video name>".
 *   - Skips Gemini analysis (style ref doesn't need verbal breakdown).
 */
export function VideoReferenceDialog({
  project,
  onClose,
  onDone,
  onReferenceReady,
}: VideoReferenceDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [maxFrames, setMaxFrames] = useState(5);
  const [progress, setProgress] = useState<ProgressState>({
    stage: "idle",
    message: "",
    progress: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { shouldRender, isVisible } = useDialogTransition(true, UI_DIALOG_TRANSITION_MS);

  const submitting =
    progress.stage !== "idle" && progress.stage !== "error" && progress.stage !== "done";

  const requestClose = () => {
    if (submitting) return;
    onClose();
  };

  const handleSubmit = async () => {
    if (!file) {
      setError("请先选择视频文件");
      return;
    }
    setError(null);
    try {
      setProgress({ stage: "uploading", message: "上传视频...", progress: 0.2 });
      const upload = await uploadFreezoneImage(project, file, file.name);

      setProgress({
        stage: "extracting",
        message: `抽 ${maxFrames} 关键帧（构图 / 色调参考）...`,
        progress: 0.5,
      });
      const ref = await submitFreezoneExtract(project, {
        videoUrl: upload.url,
        maxFrames,
        sceneThreshold: 0.4,
      });
      const task = await awaitTaskCompletion(ref.task_key, project, { taskType: ref.task_type });
      const urls = extractFrameUrls(task);
      if (urls.length === 0) {
        throw new Error("抽帧返回了空结果");
      }
      const frames: ReferenceFrame[] = urls.map((url, i) => ({ url, index: i }));
      onReferenceReady(frames);
      setProgress({
        stage: "done",
        message: `完成 — ${frames.length} 帧已加入画布作为 reference`,
        progress: 1,
      });
      onDone(`影像参照：${frames.length} 帧已入画布`);
      setTimeout(onClose, 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress({ stage: "error", message: "失败", progress: 0 });
    }
  };

  if (!shouldRender || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-50 flex items-center justify-center`}>
      <div
        className={`absolute inset-0 bg-black/55 backdrop-blur-[2px] transition-opacity duration-200 ${
          isVisible ? "opacity-100" : "opacity-0"
        }`}
        onClick={requestClose}
      />
      <UiPanel
        className={`relative w-[540px] max-w-[calc(100vw-2rem)] overflow-hidden transition-[opacity,transform] duration-200 ${
          isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"
        }`}
      >
        <header className="flex items-start gap-3 border-b border-[color:var(--ui-border-soft)] px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Film className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold leading-tight text-text-dark">影像参照</h2>
            <p className="mt-1 text-xs leading-relaxed text-text-muted">
              上传一段电影 / 短片 → 抽 3-5 关键帧作为 style / 构图 / 色调参考，
              <br />
              连进 GenNode 作为 reference image，让 AI 复刻视觉语言。
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={submitting}
            className="text-text-muted hover:text-text-dark transition disabled:opacity-30"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="px-5 py-4 space-y-5">
          <Section title="参考视频">
            <FilePicker
              file={file}
              disabled={submitting}
              inputRef={fileInputRef}
              onChange={setFile}
            />
          </Section>

          <Section
            title="抽帧数量"
            trailing={
              <span className="text-xs font-semibold tabular-nums text-accent">{maxFrames} 帧</span>
            }
          >
            <div className="rounded-lg border border-[color:var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-3 py-3">
              <Slider
                min={3}
                max={10}
                step={1}
                value={[maxFrames]}
                onValueChange={(v) => setMaxFrames(v[0] ?? maxFrames)}
                disabled={submitting}
              />
              <div className="mt-2 flex items-center justify-between text-[10px] tabular-nums text-text-muted/70">
                <span>3</span>
                <span>5</span>
                <span>7</span>
                <span>10</span>
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-text-muted/80">
              5-7 帧通常够（多了模型反而抓不住 style 重点）
            </p>
          </Section>

          {progress.stage !== "idle" && <ProgressBar progress={progress} />}

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-300 break-words">
              {error}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[color:var(--ui-border-soft)] px-5 py-3.5">
          <UiButton variant="ghost" size="sm" onClick={requestClose} disabled={submitting}>
            取消
          </UiButton>
          <UiButton
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={!file || submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                处理中
              </>
            ) : (
              "导入参考"
            )}
          </UiButton>
        </footer>
      </UiPanel>
    </div>,
    document.body
  );
}

function Section({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          {title}
        </span>
        {trailing}
      </div>
      {children}
    </div>
  );
}

interface FilePickerProps {
  file: File | null;
  disabled: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (file: File | null) => void;
}

function FilePicker({ file, disabled, inputRef, onChange }: FilePickerProps) {
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border border-dashed px-3 py-3 transition-colors ${
        file
          ? "border-[color:var(--ui-border-soft)] bg-[var(--ui-surface-field)]"
          : "border-[color:var(--ui-border-soft)] bg-[var(--ui-surface-field)]/50 hover:border-accent/60"
      }`}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
        {file ? <FileVideo className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
      </div>
      <div className="min-w-0 flex-1">
        {file ? (
          <>
            <div className="truncate text-sm text-text-dark">{file.name}</div>
            <div className="mt-0.5 text-[11px] text-text-muted">
              {(file.size / 1024 / 1024).toFixed(1)} MB
            </div>
          </>
        ) : (
          <>
            <div className="text-sm text-text-dark">选择视频文件</div>
            <div className="mt-0.5 text-[11px] text-text-muted">支持 mp4 / mov / webm 等格式</div>
          </>
        )}
      </div>
      <UiButton
        variant="muted"
        size="sm"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {file ? "更换" : "浏览"}
      </UiButton>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="hidden"
        disabled={disabled}
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}

function ProgressBar({ progress }: { progress: ProgressState }) {
  const pct = Math.round(progress.progress * 100);
  const isDone = progress.stage === "done";
  return (
    <div className="rounded-lg border border-[color:var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-text-dark">
          {!isDone && <Loader2 className="h-3 w-3 animate-spin text-accent" />}
          {progress.message}
        </span>
        <span className="text-[11px] tabular-nums text-text-muted">
          {isDone ? "完成" : `${pct}%`}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-[rgba(255,255,255,0.06)]">
        <div
          className="h-full bg-accent transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function extractFrameUrls(task: TaskState): string[] {
  const result = task.result;
  if (!result) return [];
  const urls = result["frame_urls"];
  return Array.isArray(urls)
    ? (urls as string[]).filter((u) => typeof u === "string")
    : [];
}
