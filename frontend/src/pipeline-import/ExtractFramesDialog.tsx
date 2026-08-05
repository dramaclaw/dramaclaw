// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clapperboard, FileVideo, Loader2, Upload, X } from "lucide-react";

import {
  submitFreezoneExtract,
  submitFreezoneAnalyze,
  uploadFreezoneImage,
} from "@/api/ops";
import { awaitTaskCompletion, type TaskState } from "@/api/tasks";
import { UiButton, UiInput, UiPanel } from "@/components/ui";
import {
  UI_CONTENT_OVERLAY_INSET_CLASS,
  UI_DIALOG_TRANSITION_MS,
} from "@/components/ui/motion";
import { useDialogTransition } from "@/components/ui/useDialogTransition";

interface ExtractFramesDialogProps {
  project: string;
  onClose: () => void;
  onDone: (msg: string) => void;
  /**
   * Drop the extracted frames onto the canvas. Receives the frame URL list +
   * optional analyses; the parent integrates them via `addNode`.
   */
  onFramesReady: (frames: ExtractedFrame[]) => void;
}

export interface ExtractedFrame {
  url: string;
  index: number;
  analysis?: ShotAnalysis | null;
}

export interface ShotAnalysis {
  shot_type?: string;
  angle?: string;
  camera_movement?: string;
  subject_action?: string;
  mood?: string;
  color_tone?: string;
  suggested_prompt?: string;
}

type Stage = "idle" | "uploading" | "extracting" | "analyzing" | "done" | "error";

interface ProgressState {
  stage: Stage;
  message: string;
  progress: number; // 0..1
}

export function ExtractFramesDialog({
  project,
  onClose,
  onDone,
  onFramesReady,
}: ExtractFramesDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [maxFrames, setMaxFrames] = useState(20);
  const [sceneThreshold, setSceneThreshold] = useState(0.3);
  const [analyzeShots, setAnalyzeShots] = useState(true);
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
      setProgress({ stage: "uploading", message: "上传视频...", progress: 0.1 });
      const upload = await uploadFreezoneImage(project, file, file.name);

      setProgress({
        stage: "extracting",
        message: "ffmpeg 抽帧（最多 60 秒）...",
        progress: 0.3,
      });
      const extractRef = await submitFreezoneExtract(project, {
        videoUrl: upload.url,
        maxFrames,
        sceneThreshold,
      });
      const extractTask = await awaitTaskCompletion(extractRef.task_key, project, { taskType: extractRef.task_type });
      const frameUrls = extractFrameUrls(extractTask);
      if (frameUrls.length === 0) {
        throw new Error("抽帧返回了空结果，可能视频太短或格式不支持");
      }

      let analyses: ShotAnalysis[] = [];
      if (analyzeShots) {
        setProgress({
          stage: "analyzing",
          message: `Vision 分析 ${frameUrls.length} 帧...`,
          progress: 0.7,
        });
        try {
          const analyzeRef = await submitFreezoneAnalyze(project, {
            frameUrls,
            provider: "openrouter",
          });
          const analyzeTask = await awaitTaskCompletion(analyzeRef.task_key, project, { taskType: analyzeRef.task_type });
          analyses = extractAnalyses(analyzeTask);
        } catch (err) {
          console.warn("[freezone] shot analysis failed (continuing without):", err);
        }
      }

      const frames: ExtractedFrame[] = frameUrls.map((url, i) => ({
        url,
        index: i,
        analysis: analyses[i] ?? null,
      }));
      onFramesReady(frames);
      setProgress({
        stage: "done",
        message: `已抽 ${frames.length} 帧${analyses.length > 0 ? "，并完成镜头分析" : ""}`,
        progress: 1,
      });
      onDone(`拉片完成：${frames.length} 帧已加入画布`);
      setTimeout(onClose, 600);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
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
        className={`relative w-[580px] max-w-[calc(100vw-2rem)] overflow-hidden transition-[opacity,transform] duration-200 ${
          isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"
        }`}
      >
        <header className="flex items-start gap-3 border-b border-[color:var(--ui-border-soft)] px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Clapperboard className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold leading-tight text-text-dark">拉片分析</h2>
            <p className="mt-1 text-xs leading-relaxed text-text-muted">
              视频 → ffmpeg 抽关键帧 →（可选）后端 Vision 分析镜头语言
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
          <Section title="视频文件">
            <FilePicker
              file={file}
              disabled={submitting}
              inputRef={fileInputRef}
              onChange={(f) => setFile(f)}
            />
          </Section>

          <Section title="抽帧参数">
            <div className="grid grid-cols-2 gap-3">
              <Field label="最大帧数" hint="3 - 50">
                <UiInput
                  type="number"
                  min={3}
                  max={50}
                  value={maxFrames}
                  onChange={(e) => setMaxFrames(Number(e.target.value))}
                  disabled={submitting}
                />
              </Field>
              <Field label="场景阈值" hint="0 - 1">
                <UiInput
                  type="number"
                  min={0.1}
                  max={0.9}
                  step={0.05}
                  value={sceneThreshold}
                  onChange={(e) => setSceneThreshold(Number(e.target.value))}
                  disabled={submitting}
                />
              </Field>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-text-muted/80">
              阈值越高 = 只在画面突变大时采样（长镜头视频选 0.2-0.3，快剪 MV 选 0.5+）
            </p>
          </Section>

          <Section title="后续处理">
            <label
              className={`flex w-full items-start gap-3 rounded-lg border border-[color:var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-3 py-2.5 text-left transition-colors hover:border-[color:var(--ui-border-strong)] ${
                submitting ? "cursor-not-allowed opacity-60" : "cursor-pointer"
              }`}
            >
              <input
                type="checkbox"
                checked={analyzeShots}
                onChange={(e) => setAnalyzeShots(e.target.checked)}
                disabled={submitting}
                className="sr-only peer"
              />
              <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-[rgba(255,255,255,0.2)] bg-bg-dark/60 text-transparent transition-colors peer-checked:border-accent/60 peer-checked:bg-accent/20 peer-checked:text-accent">
                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3.5 8.5l3 3 6-7" />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-text-dark">用 Vision 分析每帧的镜头语言</div>
                <div className="mt-0.5 text-[11px] text-text-muted">
                  景别 / 角度 / 运镜 / 氛围 / 色调 · 使用后端默认 Vision capability
                </div>
              </div>
            </label>
          </Section>

          {progress.stage !== "idle" && (
            <ProgressBar progress={progress} />
          )}

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
              "开始拉片"
            )}
          </UiButton>
        </footer>
      </UiPanel>
    </div>,
    document.body
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs text-text-muted">{label}</span>
        {hint && <span className="text-[10px] text-text-muted/70">{hint}</span>}
      </div>
      {children}
    </label>
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
  return Array.isArray(urls) ? (urls as string[]).filter((u) => typeof u === "string") : [];
}

function extractAnalyses(task: TaskState): ShotAnalysis[] {
  const result = task.result;
  if (!result) return [];
  const analyses = result["analyses"];
  return Array.isArray(analyses) ? (analyses as ShotAnalysis[]) : [];
}
