// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Loader2, Mic, Scissors, Square, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { resolveMediaUrl } from "@/lib/media-url";
import {
  useCopyProjectNarratorVoice,
  useDeleteNarratorVoice,
  useNarratorVoiceSources,
  useNarratorVoiceStatus,
  useRecordNarratorVoice,
  useTrimNarratorVoice,
  useUploadNarratorVoice,
  type NarratorVoiceSourceOption,
} from "@/lib/queries/video";
import { cn } from "@/lib/utils";

const SUPPORTED_AUDIO_ACCEPT = ".mp3,.wav,.m4a,.aac,.ogg,audio/*";
const SECONDARY_ACTION_CLASS =
  "h-7 gap-1 rounded-[7px] border-white/[0.11] bg-white/[0.03] px-2.5 text-[12px] font-normal text-foreground/76 shadow-none hover:border-white/[0.18] hover:bg-white/[0.055] hover:text-foreground disabled:border-white/[0.07] disabled:bg-white/[0.018] disabled:text-muted-foreground/45 dark:border-white/[0.11] dark:bg-white/[0.03] dark:hover:border-white/[0.18] dark:hover:bg-white/[0.055] dark:hover:text-foreground";

function dataUrlFromBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("failed to read audio blob"));
    reader.readAsDataURL(blob);
  });
}

function isOkResponse<T>(res: unknown): res is { ok: true; data: T } {
  return Boolean(res && typeof res === "object" && (res as { ok?: unknown }).ok === true);
}

function isErrorResponse(res: unknown): res is { ok: false; error?: string } {
  return Boolean(res && typeof res === "object" && (res as { ok?: unknown }).ok === false);
}

export function NarratorVoicePanel({
  project,
  allowFirstPersonProjectVoice = false,
}: {
  project: string;
  allowFirstPersonProjectVoice?: boolean;
}) {
  const { t } = useTranslation();
  const statusQuery = useNarratorVoiceStatus(project);
  const uploadVoice = useUploadNarratorVoice(project);
  const recordVoice = useRecordNarratorVoice(project);
  const copyProjectVoice = useCopyProjectNarratorVoice(project);
  const trimVoice = useTrimNarratorVoice(project);
  const deleteVoice = useDeleteNarratorVoice(project);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);

  // Stop the recorder and release the mic if we unmount mid-recording;
  // otherwise the MediaStream tracks stay live (mic indicator stays on).
  useEffect(() => {
    return () => {
      try {
        mediaRecorderRef.current?.stop();
      } catch {
        // recorder may already be inactive
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  const [recordOpen, setRecordOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordedDataUrl, setRecordedDataUrl] = useState("");
  const [recordStatus, setRecordStatus] = useState("");
  const [projectAudioOpen, setProjectAudioOpen] = useState(false);
  const [selectedSourcePath, setSelectedSourcePath] = useState("");
  const [trimOpen, setTrimOpen] = useState(false);
  const [trimStart, setTrimStart] = useState("0");
  const [trimDuration, setTrimDuration] = useState("4");

  const status = statusQuery.data?.data;
  const canEdit = Boolean(status && (allowFirstPersonProjectVoice || !status.is_first_person));
  const hasVoice = Boolean(status?.reference_path);
  const audioSrc = resolveMediaUrl(status?.reference_url);
  const pending =
    uploadVoice.isPending ||
    recordVoice.isPending ||
    copyProjectVoice.isPending ||
    trimVoice.isPending ||
    deleteVoice.isPending;
  const sources = useNarratorVoiceSources(project, projectAudioOpen && canEdit);
  const sourceOptions = sources.data?.data.options ?? [];

  useEffect(() => {
    if (!projectAudioOpen || selectedSourcePath || sourceOptions.length === 0) return;
    setSelectedSourcePath(sourceOptions[0].path);
  }, [projectAudioOpen, selectedSourcePath, sourceOptions]);

  const finishMutation = <T,>(res: unknown, successMessage: string): boolean => {
    if (isErrorResponse(res)) {
      toast.error(res.error || t("common.error"));
      return false;
    }
    if (isOkResponse<T>(res)) {
      toast.success(successMessage);
      return true;
    }
    toast.error(t("common.error"));
    return false;
  };

  const handleUploadFile = async (file: File) => {
    try {
      const res = await uploadVoice.mutateAsync(file);
      finishMutation(res, t("episode.workbench.video.narratorVoiceUploaded"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const stopRecorderTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const openRecord = () => {
    setRecordedDataUrl("");
    setRecordStatus(t("episode.workbench.video.narratorVoiceRecordReady"));
    setRecordOpen(true);
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast.error(t("episode.workbench.video.narratorVoiceRecordUnavailable"));
      return;
    }

    try {
      setRecordedDataUrl("");
      setRecordStatus(t("episode.workbench.video.narratorVoiceRequestingMic"));
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        try {
          const blob = new Blob(chunksRef.current, {
            type: recorder.mimeType || "audio/webm",
          });
          const dataUrl = await dataUrlFromBlob(blob);
          const seconds = Math.max(0, (performance.now() - startedAtRef.current) / 1000);
          setRecordedDataUrl(dataUrl);
          setRecordStatus(
            t("episode.workbench.video.narratorVoiceRecorded", {
              seconds: seconds.toFixed(1),
            }),
          );
        } catch {
          setRecordStatus(t("episode.workbench.video.narratorVoiceRecordFailed"));
        } finally {
          setRecording(false);
          stopRecorderTracks();
        }
      };
      startedAtRef.current = performance.now();
      recorder.start();
      setRecording(true);
      setRecordStatus(t("episode.workbench.video.narratorVoiceRecording"));
    } catch {
      stopRecorderTracks();
      setRecording(false);
      setRecordStatus(t("episode.workbench.video.narratorVoiceRecordFailed"));
      toast.error(t("episode.workbench.video.narratorVoiceRecordFailed"));
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
  };

  const saveRecording = async () => {
    if (!recordedDataUrl) return;
    try {
      const res = await recordVoice.mutateAsync(recordedDataUrl);
      if (finishMutation(res, t("episode.workbench.video.narratorVoiceSaved"))) {
        setRecordOpen(false);
      }
    } catch {
      toast.error(t("common.error"));
    }
  };

  const closeRecordDialog = (open: boolean) => {
    if (open) return;
    if (recording) {
      mediaRecorderRef.current?.stop();
    } else {
      stopRecorderTracks();
    }
    setRecordOpen(false);
  };

  const useProjectAudio = async () => {
    if (!selectedSourcePath) return;
    try {
      const res = await copyProjectVoice.mutateAsync(selectedSourcePath);
      if (finishMutation(res, t("episode.workbench.video.narratorVoiceCopied"))) {
        setProjectAudioOpen(false);
      }
    } catch {
      toast.error(t("common.error"));
    }
  };

  const clearNarratorVoice = async () => {
    try {
      const res = await deleteVoice.mutateAsync();
      finishMutation(res, t("episode.workbench.video.narratorVoiceDeleted"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const openTrim = () => {
    setTrimStart("0");
    setTrimDuration("4");
    setTrimOpen(true);
  };

  const trimNarratorVoice = async () => {
    const startSeconds = Number(trimStart);
    const durationSeconds = Number(trimDuration);
    if (!Number.isFinite(startSeconds) || startSeconds < 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      toast.error(t("episode.workbench.video.narratorVoiceTrimInvalid"));
      return;
    }
    try {
      const res = await trimVoice.mutateAsync({ startSeconds, durationSeconds });
      if (finishMutation(res, t("episode.workbench.video.narratorVoiceTrimmed"))) {
        setTrimOpen(false);
      }
    } catch {
      toast.error(t("common.error"));
    }
  };

  return (
    <section className="w-full max-w-[640px] rounded-[10px] border border-white/[0.055] bg-white/[0.012] p-4">
      {/* Header: title + status */}
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          {status?.heading_code
            ? t(status.heading_code, { defaultValue: status.heading })
            : status?.heading || t("episode.workbench.video.narratorVoice")}
        </h3>
        <div className="flex items-center gap-3">
          {pending && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
          <span
            className={cn(
              "inline-flex h-4 items-center rounded-full border px-1.5 text-[10px] leading-none",
              hasVoice
                ? "border-primary/35 bg-primary/[0.07] text-primary/90"
                : "border-white/[0.075] bg-white/[0.025] text-muted-foreground/78",
            )}
          >
            <span
              className={cn(
                "mr-1 size-1 rounded-full",
                hasVoice ? "bg-primary" : "bg-muted-foreground/35",
              )}
            />
            {hasVoice
              ? t("episode.workbench.video.seedance2Ready")
              : t("episode.workbench.video.narratorVoiceMissing")}
          </span>
        </div>
      </div>

      {/* Description */}
      {status?.explanation && (
        <p className="mt-2 text-xs leading-5 text-muted-foreground/78">
          {status.explanation_code
            ? t(status.explanation_code, { defaultValue: status.explanation })
            : status.explanation}
        </p>
      )}

      {/* Audio player */}
      {audioSrc && (
        <audio src={audioSrc} controls className="mt-8 h-7 w-full max-w-[608px]" />
      )}

      {/* Action buttons */}
      {canEdit && (
        <div className="mt-10 flex flex-wrap items-center justify-center gap-x-4 gap-y-3">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() => fileInputRef.current?.click()}
            className={SECONDARY_ACTION_CLASS}
          >
            <Upload className="size-3" />
            {t("episode.workbench.video.narratorVoiceUpload")}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={openRecord}
            className={SECONDARY_ACTION_CLASS}
          >
            <Mic className="size-3" />
            {t("episode.workbench.video.narratorVoiceRecord")}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() => {
              setSelectedSourcePath("");
              setProjectAudioOpen(true);
            }}
            className={SECONDARY_ACTION_CLASS}
          >
            <FolderOpen className="size-3" />
            {t("episode.workbench.video.narratorVoiceProjectAudio")}
          </Button>
          {hasVoice && (
            <>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={openTrim}
                className={SECONDARY_ACTION_CLASS}
              >
                <Scissors className="size-3" />
                {t("episode.workbench.video.narratorVoiceTrim")}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => void clearNarratorVoice()}
                className={cn(SECONDARY_ACTION_CLASS, "border-destructive/20 bg-destructive/[0.06] text-destructive hover:border-destructive/30 hover:bg-destructive/[0.10] hover:text-destructive disabled:border-destructive/10 disabled:bg-destructive/[0.03] disabled:text-destructive/40 dark:border-destructive/20 dark:bg-destructive/[0.06] dark:hover:border-destructive/30 dark:hover:bg-destructive/[0.10] dark:hover:text-destructive")}
              >
                <Trash2 className="size-3" />
                {t("episode.workbench.video.narratorVoiceDelete")}
              </Button>
            </>
          )}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept={SUPPORTED_AUDIO_ACCEPT}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleUploadFile(file);
          event.target.value = "";
        }}
      />

      <Dialog open={recordOpen} onOpenChange={closeRecordDialog}>
        <DialogContent className="gap-4 rounded-2xl border border-white/[0.08] bg-zinc-950/30 p-5 shadow-2xl shadow-black/40 backdrop-blur-2xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-lg font-medium tracking-tight text-foreground">
              {t("episode.workbench.video.narratorVoiceRecordTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm leading-5 text-muted-foreground/80">
              {t("episode.workbench.video.narratorVoiceRecordHint")}
            </p>
            <div className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] p-3 text-sm text-muted-foreground/76">
              {recordStatus}
            </div>
            {recordedDataUrl && <audio src={recordedDataUrl} controls className="h-9 w-full" />}
          </div>
          <DialogFooter className="mt-2 flex flex-col gap-2 sm:flex-row sm:justify-end sm:gap-2">
            <Button variant="outline" onClick={() => closeRecordDialog(false)} className="h-9 rounded-md border-white/[0.10] bg-white/[0.04] px-4 text-sm font-normal text-foreground/80 shadow-none hover:border-white/[0.18] hover:bg-white/[0.07] hover:text-foreground">
              {t("common.cancel")}
            </Button>
            {recording ? (
              <Button type="button" variant="outline" onClick={stopRecording} className="h-9 rounded-md border-white/[0.10] bg-white/[0.04] px-4 text-sm font-normal text-foreground/80 gap-1 shadow-none hover:border-white/[0.18] hover:bg-white/[0.07] hover:text-foreground">
                <Square className="size-4" />
                {t("common.stop")}
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={startRecording} className="h-9 rounded-md border-white/[0.10] bg-white/[0.04] px-4 text-sm font-normal text-foreground/80 gap-1 shadow-none hover:border-white/[0.18] hover:bg-white/[0.07] hover:text-foreground">
                <Mic className="size-4" />
                {t("episode.workbench.video.narratorVoiceRecordStart")}
              </Button>
            )}
            <Button
              type="button"
              onClick={saveRecording}
              disabled={!recordedDataUrl || recordVoice.isPending}
              className="h-9 rounded-md bg-primary px-4 text-sm font-normal text-primary-foreground shadow-lg shadow-primary/15 hover:bg-primary/90"
            >
              {recordVoice.isPending && <Loader2 className="size-4 animate-spin" />}
              {t("episode.workbench.video.narratorVoiceSaveRecording")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={projectAudioOpen} onOpenChange={setProjectAudioOpen}>
        <DialogContent className="gap-4 rounded-2xl border border-white/[0.08] bg-zinc-950/30 p-5 shadow-2xl shadow-black/40 backdrop-blur-2xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-lg font-medium tracking-tight text-foreground">
              {t("episode.workbench.video.narratorVoiceProjectAudioTitle")}
            </DialogTitle>
          </DialogHeader>
          {sources.isLoading ? (
            <p className="text-sm text-muted-foreground/80">
              {t("episode.workbench.video.narratorVoiceSourcesLoading")}
            </p>
          ) : sourceOptions.length > 0 ? (
            <ProjectAudioSourceSelect
              options={sourceOptions}
              value={selectedSourcePath}
              onChange={setSelectedSourcePath}
            />
          ) : (
            <div className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] p-3 text-sm text-muted-foreground/76">
              {t("episode.workbench.video.narratorVoiceNoSources")}
            </div>
          )}
          <DialogFooter className="mt-2 flex flex-col gap-2 sm:flex-row sm:justify-end sm:gap-2">
            <Button variant="outline" onClick={() => setProjectAudioOpen(false)} className="h-9 rounded-md border-white/[0.10] bg-white/[0.04] px-4 text-sm font-normal text-foreground/80 shadow-none hover:border-white/[0.18] hover:bg-white/[0.07] hover:text-foreground">
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={!selectedSourcePath || copyProjectVoice.isPending}
              onClick={useProjectAudio}
              className="h-9 rounded-md bg-primary px-4 text-sm font-normal text-primary-foreground shadow-lg shadow-primary/15 hover:bg-primary/90"
            >
              {copyProjectVoice.isPending && <Loader2 className="size-4 animate-spin" />}
              {t("episode.workbench.video.narratorVoiceUse")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={trimOpen} onOpenChange={setTrimOpen}>
        <DialogContent className="gap-4 rounded-2xl border border-white/[0.08] bg-zinc-950/30 p-5 shadow-2xl shadow-black/40 backdrop-blur-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg font-medium tracking-tight text-foreground">
              {t("episode.workbench.video.narratorVoiceTrimTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm leading-5 text-muted-foreground/80">
              {t("episode.workbench.video.narratorVoiceTrimHint")}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="narrator-voice-trim-start" className="text-xs text-muted-foreground">
                  {t("episode.workbench.video.narratorVoiceTrimStart")}
                </Label>
                <Input
                  id="narrator-voice-trim-start"
                  type="number"
                  min="0"
                  step="0.1"
                  value={trimStart}
                  onChange={(event) => setTrimStart(event.target.value)}
                  className="h-10 rounded-[8px] border-white/[0.10] bg-white/[0.04] text-sm shadow-none focus:border-white/[0.18]"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="narrator-voice-trim-duration" className="text-xs text-muted-foreground">
                  {t("episode.workbench.video.narratorVoiceTrimDuration")}
                </Label>
                <Input
                  id="narrator-voice-trim-duration"
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={trimDuration}
                  onChange={(event) => setTrimDuration(event.target.value)}
                  className="h-10 rounded-[8px] border-white/[0.10] bg-white/[0.04] text-sm shadow-none focus:border-white/[0.18]"
                />
              </div>
            </div>
          </div>
          <DialogFooter className="mt-2 flex flex-col gap-2 sm:flex-row sm:justify-end sm:gap-2">
            <Button variant="outline" onClick={() => setTrimOpen(false)} className="h-9 rounded-md border-white/[0.10] bg-white/[0.04] px-4 text-sm font-normal text-foreground/80 shadow-none hover:border-white/[0.18] hover:bg-white/[0.07] hover:text-foreground">
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={trimVoice.isPending}
              onClick={trimNarratorVoice}
              className="h-9 rounded-md bg-primary px-4 text-sm font-normal text-primary-foreground shadow-lg shadow-primary/15 hover:bg-primary/90"
            >
              {trimVoice.isPending && <Loader2 className="size-4 animate-spin" />}
              {t("episode.workbench.video.narratorVoiceTrimApply")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ProjectAudioSourceSelect({
  options,
  value,
  onChange,
}: {
  options: NarratorVoiceSourceOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value || options[0]?.path || ""}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
    >
      <SelectTrigger className="h-8 w-full min-w-0 text-xs rounded-md">
        <SelectValue className="truncate" />
      </SelectTrigger>
      <SelectContent className="max-h-[200px]">
        {options.map((option) => (
          <SelectItem key={option.path} value={option.path}>
            <span className="min-w-0 truncate">{option.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
