// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertTriangle,
  Loader2,
  Mic,
  Scissors,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Volume2,
} from "lucide-react";

import {
  useSaveGeneratedCharacterVoice,
  useCharacterVoiceSamples,
  useDeleteCharacterVoiceSample,
  useRecordCharacterVoiceSample,
  useTrimCharacterVoiceSample,
  useUploadCharacterVoiceSample,
} from "@/lib/queries/characters";
import { VoiceDesignDialog } from "@/components/assets/voice-design-dialog";
import { useVoiceDesignQuote } from "@/lib/queries/voice-design";
import { resolveMediaUrl } from "@/lib/media-url";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { Character, CharacterVoiceSlot, CharacterVoiceSlotId } from "@/types/character";

const AGE_SLOT_ORDER: CharacterVoiceSlotId[] = ["child", "youth", "middle", "elder"];
const SUPPORTED_AUDIO_ACCEPT = ".mp3,.wav,.m4a,.aac,.ogg,audio/*";
const EMPTY_VOICE_SLOTS: CharacterVoiceSlot[] = [];

type VoiceRow = {
  displaySlot: CharacterVoiceSlotId;
  actionSlot: CharacterVoiceSlot;
  label: string;
};

function emptySlot(slot: CharacterVoiceSlotId, label: string): CharacterVoiceSlot {
  return {
    slot,
    label,
    path: "",
    url: "",
    sha256: "",
    updated_at: "",
    inherited_from_default: false,
    required: slot === "default",
  };
}

function dataUrlFromBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function isOkResponse<T>(res: unknown): res is { ok: true; data: T } {
  return Boolean(res && typeof res === "object" && (res as { ok?: unknown }).ok === true);
}

function isErrorResponse(res: unknown): res is { ok: false; error?: string } {
  return Boolean(res && typeof res === "object" && (res as { ok?: unknown }).ok === false);
}

// getUserMedia rejects with a named DOMException. Map the common ones to
// actionable copy so a recording failure says *why* (permission blocked, no
// device, device busy…) instead of an opaque「录音失败」. Note: a server
// `Permissions-Policy: microphone=()` header also surfaces here as
// NotAllowedError — see worker/index.ts.
function recordErrorMessageKey(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "characters.voiceSamples.recordPermissionDenied";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "characters.voiceSamples.recordNoDevice";
    case "NotReadableError":
    case "TrackStartError":
      return "characters.voiceSamples.recordDeviceBusy";
    default:
      return "characters.voiceSamples.recordFailed";
  }
}

function VoiceActionButton({
  label,
  icon,
  onClick,
  disabled,
  destructive = false,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "text-muted-foreground hover:text-foreground",
        destructive && "hover:bg-destructive/10 hover:text-destructive",
      )}
    >
      {icon}
    </Button>
  );
}

export function CharacterVoicePanel({
  project,
  character,
}: {
  project: string;
  character: Character;
}) {
  const { t } = useTranslation();
  const samples = useCharacterVoiceSamples(project, character.name);
  const uploadVoice = useUploadCharacterVoiceSample(project, character.name);
  const recordVoice = useRecordCharacterVoiceSample(project, character.name);
  const trimVoice = useTrimCharacterVoiceSample(project, character.name);
  const deleteVoice = useDeleteCharacterVoiceSample(project, character.name);

  const queryClient = useQueryClient();
  const designQuote = useVoiceDesignQuote(project, "supertale");
  const saveGenerated = useSaveGeneratedCharacterVoice(project, character.name);
  const [designSlot, setDesignSlot] = useState<CharacterVoiceSlot | null>(null);
  const [designOpen, setDesignOpen] = useState(false);
  const designTrigger = useRef<HTMLElement | null>(null);
  const designOwner = useRef({ project, name: character.name });
  useEffect(() => {
    if (
      designOwner.current.project !== project ||
      designOwner.current.name !== character.name
    ) {
      setDesignOpen(false);
      setDesignSlot(null);
      designOwner.current = { project, name: character.name };
    }
  }, [project, character.name]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadSlotRef = useRef<string>("default");
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

  const [recordSlot, setRecordSlot] = useState<CharacterVoiceSlot | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordedDataUrl, setRecordedDataUrl] = useState("");
  const [recordedDuration, setRecordedDuration] = useState<number | null>(null);
  const [recordStatus, setRecordStatus] = useState("");
  const [trimSlot, setTrimSlot] = useState<CharacterVoiceSlot | null>(null);
  const [trimStart, setTrimStart] = useState("0");
  const [trimDuration, setTrimDuration] = useState("4");
  const [slotDurations, setSlotDurations] = useState<Record<string, number>>({});
  const voiceSamples = isOkResponse(samples.data) ? samples.data.data : undefined;
  const sampleSlots = voiceSamples?.slots ?? EMPTY_VOICE_SLOTS;
  const loadFailed = samples.isError || isErrorResponse(samples.data);

  const ageLabel = (slot: CharacterVoiceSlotId) => {
    const key =
      slot === "child"
        ? "characters.ageGroups.child"
        : slot === "youth"
          ? "characters.ageGroups.young"
          : slot === "middle"
            ? "characters.ageGroups.middle"
            : "characters.ageGroups.elder";
    return t(key);
  };

  const rows = useMemo<VoiceRow[]>(() => {
    const bySlot = new Map(sampleSlots.map((slot) => [slot.slot, slot]));
    const getSlot = (slot: CharacterVoiceSlotId) =>
      bySlot.get(slot) ?? emptySlot(slot, slot === "default" ? t("characters.voiceSamples.defaultRequired") : ageLabel(slot));
    const primaryAge = AGE_SLOT_ORDER.includes(character.age_group as CharacterVoiceSlotId)
      ? (character.age_group as CharacterVoiceSlotId)
      : "";

    if (primaryAge) {
      return AGE_SLOT_ORDER.map((slot) => {
        const actionSlot = slot === primaryAge ? getSlot("default") : getSlot(slot);
        return {
          displaySlot: slot,
          actionSlot,
          label:
            slot === primaryAge
              ? t("characters.voiceSamples.ageDefaultRequired", { age: ageLabel(slot) })
              : t("characters.voiceSamples.optionalOverride", { age: ageLabel(slot) }),
        };
      });
    }

    return [
      {
        displaySlot: "default" as const,
        actionSlot: getSlot("default"),
        label: t("characters.voiceSamples.defaultRequired"),
      },
      ...AGE_SLOT_ORDER.map((slot) => ({
        displaySlot: slot,
        actionSlot: getSlot(slot),
        label: t("characters.voiceSamples.optionalOverride", { age: ageLabel(slot) }),
      })),
    ];
  }, [character.age_group, sampleSlots, t]);

  const pending =
    uploadVoice.isPending ||
    recordVoice.isPending ||
    trimVoice.isPending ||
    deleteVoice.isPending;

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
    const slot = uploadSlotRef.current;
    try {
      const res = await uploadVoice.mutateAsync({ slot, file });
      finishMutation<CharacterVoiceSlot>(
        res,
        t("characters.voiceSamples.uploaded"),
      );
    } catch {
      toast.error(t("common.error"));
    }
  };

  const openRecord = (slot: CharacterVoiceSlot) => {
    setRecordSlot(slot);
    setRecordedDataUrl("");
    setRecordedDuration(null);
    setRecordStatus(t("characters.voiceSamples.recordReady"));
  };

  const stopRecorderTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const startRecording = async () => {
    if (!recordSlot) return;
    // Non-secure origins (plain http over a LAN IP, etc.) get no microphone at
    // all — browsers only expose getUserMedia on HTTPS or localhost. Say so
    // explicitly instead of falling through to a generic failure.
    if (!window.isSecureContext) {
      toast.error(t("characters.voiceSamples.recordInsecureContext"));
      setRecordStatus(t("characters.voiceSamples.recordInsecureContext"));
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast.error(t("characters.voiceSamples.recordUnavailable"));
      return;
    }

    try {
      setRecordedDataUrl("");
      setRecordedDuration(null);
      setRecordStatus(t("characters.voiceSamples.requestingMic"));
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
          const mimeType = recorder.mimeType || "audio/webm";
          const blob = new Blob(chunksRef.current, { type: mimeType });
          const dataUrl = await dataUrlFromBlob(blob);
          const duration = Math.max(0, (performance.now() - startedAtRef.current) / 1000);
          setRecordedDataUrl(dataUrl);
          setRecordedDuration(duration);
          setRecordStatus(
            t("characters.voiceSamples.recordedDuration", {
              seconds: duration.toFixed(1),
            }),
          );
        } catch {
          setRecordStatus(t("characters.voiceSamples.recordFailed"));
        } finally {
          setRecording(false);
          stopRecorderTracks();
        }
      };
      startedAtRef.current = performance.now();
      recorder.start();
      setRecording(true);
      setRecordStatus(t("characters.voiceSamples.recording"));
    } catch (error) {
      stopRecorderTracks();
      setRecording(false);
      // Don't swallow the rejection — log it and map the DOMException name to a
      // specific reason. (A `Permissions-Policy: microphone=()` server header
      // shows up here as NotAllowedError; fixed in worker/index.ts.)
      console.error("[voice-record] getUserMedia failed", error);
      const messageKey = recordErrorMessageKey(error);
      toast.error(t(messageKey));
      setRecordStatus(t(messageKey));
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
  };

  const saveRecording = async () => {
    if (!recordSlot || !recordedDataUrl) return;
    try {
      const res = await recordVoice.mutateAsync({
        slot: String(recordSlot.slot),
        dataUrl: recordedDataUrl,
      });
      if (finishMutation<CharacterVoiceSlot>(res, t("characters.voiceSamples.recorded"))) {
        setRecordSlot(null);
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
    setRecordSlot(null);
  };

  const openTrim = (slot: CharacterVoiceSlot) => {
    setTrimSlot(slot);
    setTrimStart("0");
    setTrimDuration("4");
  };

  const applyTrim = async () => {
    if (!trimSlot?.path) return;
    const startSeconds = Number(trimStart);
    const durationSeconds = Number(trimDuration);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(durationSeconds)) {
      toast.error(t("characters.voiceSamples.invalidTrim"));
      return;
    }
    try {
      const res = await trimVoice.mutateAsync({
        slot: String(trimSlot.slot),
        sourcePath: trimSlot.path,
        startSeconds,
        durationSeconds,
      });
      if (finishMutation<CharacterVoiceSlot>(res, t("characters.voiceSamples.trimmed"))) {
        setTrimSlot(null);
      }
    } catch {
      toast.error(t("common.error"));
    }
  };

  const clearSlot = async (slot: CharacterVoiceSlot) => {
    try {
      const res = await deleteVoice.mutateAsync(String(slot.slot));
      finishMutation<CharacterVoiceSlot>(res, t("characters.voiceSamples.cleared"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  return (
    <section className="rounded-[10px] border border-white/[0.06] bg-white/[0.018] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            {t("characters.voiceSamples.title")}
          </h3>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            {t("characters.voiceSamples.hint")}
          </p>
        </div>
        {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>

      {samples.isLoading ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {t("characters.voiceSamples.loading")}
        </p>
      ) : loadFailed ? (
        <p className="mt-4 rounded-[8px] border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          {t("characters.voiceSamples.loadFailed")}
        </p>
      ) : (
        <div className="mt-3 divide-y divide-white/[0.06]">
          {rows.map(({ displaySlot, actionSlot, label }) => {
            const hasVoice = Boolean(actionSlot.path);
            const audioSrc = resolveMediaUrl(actionSlot.url);
            const slotId = String(actionSlot.slot);
            const duration = slotDurations[slotId];
            const canGenerate = Boolean(designQuote.data && !designQuote.isError);
            const hasDraft = Boolean(queryClient.getQueryData(queryKeys.voiceDesignDraft(
              project, "supertale", `character:${JSON.stringify([character.name, actionSlot.slot])}`,
            )));
            return (
              <div
                key={`${displaySlot}:${slotId}`}
                className="flex flex-wrap items-center gap-3 py-3 first:pt-2 last:pb-0"
              >
                <div className="flex min-w-0 items-center gap-2 @[860px]:w-52 @[860px]:shrink-0">
                  <span
                    className={cn(
                      "inline-flex size-2 rounded-full",
                      hasVoice
                        ? "bg-emerald-400"
                        : actionSlot.required
                          ? "bg-amber-400"
                          : "bg-muted-foreground/40",
                    )}
                  />
                  <span className="truncate text-xs font-medium text-foreground">
                    {label}
                  </span>
                </div>

                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {hasVoice ? (
                    <>
                      {audioSrc && (
                        <audio
                          src={audioSrc}
                          controls
                          className="h-6 max-w-[220px] shrink-0"
                          onLoadedMetadata={(event) => {
                            const nextDuration = event.currentTarget.duration;
                            if (Number.isFinite(nextDuration)) {
                              setSlotDurations((prev) => ({
                                ...prev,
                                [slotId]: nextDuration,
                              }));
                            }
                          }}
                        />
                      )}
                      <span className="truncate text-[11px] text-muted-foreground/70" title={actionSlot.path}>
                        {actionSlot.path.split("/").pop()}
                      </span>
                      {Number.isFinite(duration) && (
                        <span className="shrink-0 text-[11px] text-muted-foreground/70">
                          {t("characters.voiceSamples.currentDuration", {
                            seconds: duration.toFixed(1),
                          })}
                        </span>
                      )}
                    </>
                  ) : actionSlot.required ? (
                    <p className="flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                      <AlertTriangle className="size-3.5" />
                      {t("characters.voiceSamples.missingDefault")}
                    </p>
                  ) : actionSlot.inherited_from_default ? (
                    <p className="text-[11px] italic text-muted-foreground">
                      {t("characters.voiceSamples.inheritedDefault")}
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      {t("characters.voiceSamples.missing")}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {(canGenerate || hasDraft) && (
                    <VoiceActionButton
                      label={t(canGenerate ? "voiceDesign.entry" : "voiceDesign.resume")}
                      icon={<Sparkles className="size-3.5" />}
                      disabled={pending}
                      onClick={() => {
                        designTrigger.current = document.activeElement instanceof HTMLElement
                          ? document.activeElement
                          : null;
                        setDesignSlot(actionSlot);
                        setDesignOpen(true);
                      }}
                    />
                  )}
                  <VoiceActionButton
                    label={t("characters.voiceSamples.upload")}
                    icon={<Upload className="size-3.5" />}
                    disabled={pending}
                    onClick={() => {
                      uploadSlotRef.current = slotId;
                      fileInputRef.current?.click();
                    }}
                  />
                  <VoiceActionButton
                    label={t("characters.voiceSamples.record")}
                    icon={<Mic className="size-3.5" />}
                    disabled={pending}
                    onClick={() => openRecord(actionSlot)}
                  />
                  {hasVoice && (
                    <>
                      <VoiceActionButton
                        label={t("characters.voiceSamples.trim")}
                        icon={<Scissors className="size-3.5" />}
                        disabled={pending}
                        onClick={() => openTrim(actionSlot)}
                      />
                      <VoiceActionButton
                        label={t("characters.voiceSamples.clear")}
                        icon={<Trash2 className="size-3.5" />}
                        disabled={pending}
                        destructive
                        onClick={() => clearSlot(actionSlot)}
                      />
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {designSlot && designOwner.current.project === project && designOwner.current.name === character.name && (
        <VoiceDesignDialog
          project={project}
          surface="supertale"
          open={designOpen}
          onOpenChange={(open) => {
            setDesignOpen(open);
            if (!open) requestAnimationFrame(() => designTrigger.current?.focus());
          }}
          target={{
            kind: "character",
            key: JSON.stringify([character.name, designSlot.slot]),
            label: `${character.name} · ${designSlot.label}`,
            saveLabel: t("voiceDesign.saveSlot", { slot: designSlot.label }),
            expectedSlot: {
              path: designSlot.path,
              sha256: designSlot.sha256,
              updated_at: designSlot.updated_at,
            },
            onSave: (input) => saveGenerated.mutateAsync({
              ...input, slot: String(designSlot.slot),
            }),
            onRefresh: async () => {
              const result = await samples.refetch();
              if (result.error) throw result.error;
              const refreshed = result.data?.data?.slots.find(
                slot => slot.slot === designSlot.slot,
              );
              if (!refreshed) throw new Error(t("characters.voiceSamples.loadFailed"));
              setDesignSlot(refreshed);
            },
          }}
        />
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

      <Dialog open={Boolean(recordSlot)} onOpenChange={closeRecordDialog}>
        <DialogContent className="gap-4 rounded-2xl border border-white/[0.08] bg-zinc-950/30 p-5 shadow-2xl shadow-black/40 backdrop-blur-2xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-lg font-medium tracking-tight text-foreground">
              {t("characters.voiceSamples.recordTitle", {
                slot: recordSlot?.label ?? "",
              })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm leading-5 text-muted-foreground/80">
              {t("characters.voiceSamples.recordHint")}
            </p>
            <div className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] p-3 text-sm text-muted-foreground/76">
              {recordStatus}
            </div>
            {recordedDataUrl && (
              <audio src={recordedDataUrl} controls className="h-9 w-full" />
            )}
            {recordedDuration !== null && (
              <p className="text-xs text-muted-foreground/65">
                {t("characters.voiceSamples.recordedDuration", {
                  seconds: recordedDuration.toFixed(1),
                })}
              </p>
            )}
          </div>
          <DialogFooter className="mt-2 flex flex-col gap-2 sm:flex-row sm:justify-end sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={startRecording}
              disabled={recording || recordVoice.isPending}
              className="h-9 rounded-md border-white/[0.10] bg-white/[0.04] px-4 text-sm font-normal text-foreground/80 shadow-none hover:border-white/[0.18] hover:bg-white/[0.07] hover:text-foreground"
            >
              <Mic className="size-4" />
              {t("characters.voiceSamples.startRecord")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={stopRecording}
              disabled={!recording}
              className="h-9 rounded-md border-white/[0.10] bg-white/[0.04] px-4 text-sm font-normal text-foreground/80 shadow-none hover:border-white/[0.18] hover:bg-white/[0.07] hover:text-foreground"
            >
              <Square className="size-4" />
              {t("characters.voiceSamples.stopRecord")}
            </Button>
            <Button
              type="button"
              onClick={saveRecording}
              disabled={!recordedDataUrl || recordVoice.isPending}
              className="h-9 rounded-md bg-primary px-4 text-sm font-normal text-primary-foreground shadow-lg shadow-primary/15 hover:bg-primary/90"
            >
              {recordVoice.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Volume2 className="size-4" />
              )}
              {t("characters.voiceSamples.saveRecording")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(trimSlot)} onOpenChange={(open) => !open && setTrimSlot(null)}>
        <DialogContent className="gap-4 rounded-2xl border border-white/[0.08] bg-zinc-950/30 p-5 shadow-2xl shadow-black/40 backdrop-blur-2xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-lg font-medium tracking-tight text-foreground">
              {t("characters.voiceSamples.trimTitle", {
                slot: trimSlot?.label ?? "",
              })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm leading-5 text-muted-foreground/80">
              {t("characters.voiceSamples.trimHint")}
            </p>
            {trimSlot?.url && resolveMediaUrl(trimSlot.url) && (
              <audio src={resolveMediaUrl(trimSlot.url) ?? ""} controls className="h-9 w-full" />
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  {t("characters.voiceSamples.startSeconds")}
                </Label>
                <Input
                  type="number"
                  min="0"
                  step="0.1"
                  value={trimStart}
                  onChange={(event) => setTrimStart(event.target.value)}
                  className="h-10 rounded-[8px] border-white/[0.10] bg-white/[0.04] text-sm shadow-none focus:border-white/[0.18]"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  {t("characters.voiceSamples.durationSeconds")}
                </Label>
                <Input
                  type="number"
                  min="0.1"
                  max="15"
                  step="0.1"
                  value={trimDuration}
                  onChange={(event) => setTrimDuration(event.target.value)}
                  className="h-10 rounded-[8px] border-white/[0.10] bg-white/[0.04] text-sm shadow-none focus:border-white/[0.18]"
                />
              </div>
            </div>
          </div>
          <DialogFooter className="mt-2 flex flex-col gap-2 sm:flex-row sm:justify-end sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setTrimSlot(null)}
              className="h-9 rounded-md border-white/[0.10] bg-white/[0.04] px-4 text-sm font-normal text-foreground/80 shadow-none hover:border-white/[0.18] hover:bg-white/[0.07] hover:text-foreground"
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={applyTrim}
              disabled={trimVoice.isPending}
              className="h-9 rounded-md bg-primary px-4 text-sm font-normal text-primary-foreground shadow-lg shadow-primary/15 hover:bg-primary/90"
            >
              {trimVoice.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Scissors className="size-4" />
              )}
              {t("characters.voiceSamples.applyTrim")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
