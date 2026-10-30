// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  createVoiceDesign,
  fetchVoiceDesignAudio,
  getVoiceDesign,
  useVoiceDesignQuote,
  VoiceDesignApiError,
} from "@/lib/queries/voice-design";
import { queryKeys } from "@/lib/query-keys";
import type {
  ExpectedVoiceSlot,
  SaveGeneratedAccountVoice,
  SaveGeneratedCharacterVoice,
  VoiceDesignCandidate,
  VoiceDesignReady,
  VoiceDesignSurface,
} from "@/types/voice-design";

type TargetBase = {
  key: string;
  label: string;
  saveLabel: string;
  onSaved?: () => void;
};
export type VoiceDesignTarget = TargetBase &
  (
    | {
        kind: "character";
        expectedSlot: ExpectedVoiceSlot;
        onSave: (input: SaveGeneratedCharacterVoice) => Promise<unknown>;
        onRefresh: () => Promise<unknown>;
      }
    | {
        kind: "account";
        onSave: (input: SaveGeneratedAccountVoice) => Promise<unknown>;
      }
  );
type SaveAttempt =
  | { kind: "character"; input: SaveGeneratedCharacterVoice }
  | { kind: "account"; input: SaveGeneratedAccountVoice };
type Generation =
  | { kind: "idle" }
  | { kind: "submitting" | "tracking" | "unresolved"; id: string }
  | { kind: "settled"; candidate: VoiceDesignCandidate };
type Draft = {
  description: string;
  previewText: string;
  name: string;
  generation: Generation;
  ready: VoiceDesignReady | null;
  error: string;
  saveAttempt: SaveAttempt | null;
  saved: boolean;
  conflict: boolean;
};
function newDraft(): Draft {
  return {
    description: "",
    previewText: "",
    name: "",
    generation: { kind: "idle" },
    ready: null,
    error: "",
    saveAttempt: null,
    saved: false,
    conflict: false,
  };
}
function knownMessage(error: unknown): string {
  return error instanceof VoiceDesignApiError
    ? error.message
    : "voiceDesign.errors.network";
}

type Props = {
  project: string;
  surface: VoiceDesignSurface;
  target: VoiceDesignTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};
export function VoiceDesignDialog(props: Props) {
  return (
    <VoiceDesignSession
      key={JSON.stringify([
        props.project,
        props.surface,
        props.target.kind,
        props.target.key,
      ])}
      {...props}
    />
  );
}
function useVoiceDesignSession({
  project,
  surface,
  target,
  onOpenChange,
}: Props) {
  const qc = useQueryClient();
  const id = useId();
  const key = queryKeys.voiceDesignDraft(
    project,
    surface,
    `${target.kind}:${target.key}`,
  );
  const { data: draft } = useQuery({
    queryKey: key,
    queryFn: newDraft,
    initialData: newDraft,
    enabled: false,
    gcTime: Infinity,
  });
  const patch = (update: Partial<Draft>) =>
    qc.setQueryData<Draft>(key, (current) => ({
      ...(current ?? newDraft()),
      ...update,
    }));
  const quote = useVoiceDesignQuote(project, surface);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(true);
  const busy = useRef(false);
  const saveBusy = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const activeId =
    draft.generation.kind === "tracking" ||
    draft.generation.kind === "unresolved"
      ? draft.generation.id
      : "";
  const candidate = useQuery({
    queryKey: queryKeys.voiceDesignCandidate(project, activeId),
    queryFn: ({ signal }) => getVoiceDesign(project, activeId, signal),
    enabled: !!activeId && draft.generation.kind === "tracking",
    retry: false,
    refetchInterval: (q) =>
      !q.state.error && q.state.data?.status === "generating" ? 1500 : false,
  });
  function receive(result: VoiceDesignCandidate) {
    patch({
      generation:
        result.status === "generating"
          ? { kind: "tracking", id: result.candidate_id }
          : { kind: "settled", candidate: result },
      ...(result.status === "ready"
        ? {
            ready: result,
            saveAttempt: null,
            saved: false,
            conflict: false,
            error: "",
          }
        : {}),
      ...(result.status === "failed" || result.status === "unknown"
        ? { error: result.failure.message }
        : {}),
      ...(result.status === "expired" ? { error: "voiceDesign.expired" } : {}),
    });
  }
  useEffect(() => {
    if (candidate.data && candidate.data.candidate_id === activeId)
      receive(candidate.data);
  }, [candidate.data]);
  useEffect(() => {
    if (!candidate.error || !activeId) return;
    if (
      candidate.error instanceof VoiceDesignApiError &&
      ["candidate_expired", "candidate_not_found"].includes(
        candidate.error.code,
      )
    ) {
      patch({
        generation: { kind: "idle" },
        error: knownMessage(candidate.error),
        ...(draft.ready?.candidate_id === activeId ? { ready: null } : {}),
      });
    } else
      patch({
        generation: { kind: "unresolved", id: activeId },
        error: knownMessage(candidate.error),
      });
  }, [candidate.error]);
  const generating =
    draft.generation.kind === "submitting" ||
    draft.generation.kind === "tracking";
  const uncertain = draft.generation.kind === "unresolved";
  const descriptionLength = Array.from(draft.description.trim()).length;
  const previewLength = Array.from(draft.previewText.trim()).length;
  const valid =
    descriptionLength > 0 &&
    descriptionLength <= 500 &&
    previewLength >= 15 &&
    previewLength <= 60;
  const expired = !!draft.ready && Date.parse(draft.ready.expires_at) <= now;
  const canSave =
    !!draft.ready &&
    !expired &&
    !generating &&
    !uncertain &&
    !saving &&
    !draft.saved &&
    !draft.conflict &&
    (target.kind !== "account" || !!draft.name.trim());
  const generate = async () => {
    if (
      busy.current ||
      generating ||
      uncertain ||
      saving ||
      !valid ||
      !quote.data ||
      quote.isError
    )
      return;
    busy.current = true;
    const requestId = crypto.randomUUID();
    patch({ generation: { kind: "submitting", id: requestId }, error: "" });
    try {
      const result = await createVoiceDesign(project, {
        request_id: requestId,
        surface,
        description: draft.description.trim(),
        preview_text: draft.previewText.trim(),
        language: "zh",
      });
      if (result.status === "unknown")
        patch({
          generation: { kind: "tracking", id: requestId },
          error: result.failure.message,
        });
      else receive(result);
    } catch (error) {
      const uncertainResult =
        !(error instanceof VoiceDesignApiError) || error.status >= 500;
      patch({
        generation: uncertainResult
          ? { kind: "tracking", id: requestId }
          : { kind: "idle" },
        error: knownMessage(error),
      });
      if (
        error instanceof VoiceDesignApiError &&
        [401, 403, 402, 429, 503].includes(error.status)
      )
        void quote.refetch();
    } finally {
      busy.current = false;
    }
  };
  const check = async () => {
    if (!activeId) return;
    patch({ error: "" });
    const result = await candidate.refetch();
    if (result.data) receive(result.data);
    else if (result.error) patch({ error: knownMessage(result.error) });
  };
  const save = async (replace: boolean) => {
    if (!canSave || !draft.ready || saveBusy.current) return;
    saveBusy.current = true;
    setSaving(true);
    setConfirm(false);
    const common = {
      candidate_id: draft.ready.candidate_id,
      save_request_id: crypto.randomUUID(),
    };
    const attempt =
      draft.saveAttempt ??
      (target.kind === "character"
        ? {
            kind: "character" as const,
            input: {
              ...common,
              expected_slot: { ...target.expectedSlot },
              replace_existing: replace,
            },
          }
        : {
            kind: "account" as const,
            input: { ...common, name: draft.name.trim() },
          });
    patch({ saveAttempt: attempt, error: "" });
    try {
      if (attempt.kind === "character" && target.kind === "character")
        await target.onSave(attempt.input);
      else if (attempt.kind === "account" && target.kind === "account")
        await target.onSave(attempt.input);
      else return;
      patch({ saved: true });
      if (mounted.current) {
        target.onSaved?.();
        onOpenChange(false);
      }
    } catch (error) {
      patch({
        error: knownMessage(error),
        ...(error instanceof VoiceDesignApiError &&
        error.code === "candidate_expired"
          ? { ready: { ...draft.ready, expires_at: new Date(0).toISOString() } }
          : {}),
        conflict:
          error instanceof VoiceDesignApiError &&
          ["slot_changed", "slot_occupied"].includes(error.code),
      });
    } finally {
      saveBusy.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const refreshTarget = async () => {
    if (target.kind !== "character") return;
    try {
      await target.onRefresh();
      patch({ conflict: false, saveAttempt: null, error: "" });
    } catch (error) {
      patch({ error: knownMessage(error) });
    }
  };
  return {
    draft,
    patch,
    id,
    quote,
    saving,
    confirm,
    setConfirm,
    candidate,
    generating,
    uncertain,
    descriptionLength,
    previewLength,
    valid,
    expired,
    canSave,
    generate,
    check,
    save,
    refreshTarget,
  };
}
function VoiceDesignSession(props: Props) {
  const { t } = useTranslation();
  const { target, open, onOpenChange } = props;
  const {
    draft,
    patch,
    id,
    quote,
    saving,
    confirm,
    setConfirm,
    candidate,
    generating,
    uncertain,
    descriptionLength,
    previewLength,
    valid,
    expired,
    canSave,
    generate,
    check,
    save,
    refreshTarget,
  } = useVoiceDesignSession(props);
  const feedback = (message: string) => t(message, { defaultValue: message });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto bg-[var(--ui-surface-modal)] sm:max-w-xl"
        overlayClassName="backdrop-blur-none supports-backdrop-filter:backdrop-blur-none"
      >
        <DialogHeader>
          <DialogTitle>{t("voiceDesign.title")}</DialogTitle>
          <DialogDescription>
            {t("voiceDesign.target", { target: target.label })}
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={`${id}-description`}>
                {t("voiceDesign.description")}
              </Label>
              <span className="text-xs text-muted-foreground">
                {descriptionLength}/500
              </span>
            </div>
            <Textarea
              id={`${id}-description`}
              value={draft.description}
              onChange={(e) => patch({ description: e.target.value })}
              aria-describedby={`${id}-description-help`}
              aria-invalid={descriptionLength === 0 || descriptionLength > 500}
            />
            <p
              id={`${id}-description-help`}
              className="text-xs text-muted-foreground"
            >
              {t("voiceDesign.descriptionHint")}
            </p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={`${id}-preview`}>
                {t("voiceDesign.previewText")}
              </Label>
              <span className="text-xs text-muted-foreground">
                {previewLength}/60
              </span>
            </div>
            <Textarea
              id={`${id}-preview`}
              value={draft.previewText}
              onChange={(e) => patch({ previewText: e.target.value })}
              aria-describedby={`${id}-preview-help`}
              aria-invalid={previewLength < 15 || previewLength > 60}
            />
            <p
              id={`${id}-preview-help`}
              className="text-xs text-muted-foreground"
            >
              {t("voiceDesign.previewHint")}
            </p>
          </div>
          {target.kind === "account" && (
            <div className="space-y-2">
              <Label htmlFor={`${id}-name`}>{t("voiceDesign.name")}</Label>
              <Input
                id={`${id}-name`}
                value={draft.name}
                disabled={saving}
                onChange={(e) =>
                  patch({ name: e.target.value, saveAttempt: null })
                }
              />
            </div>
          )}
          {generating && <p role="status">{t("voiceDesign.generating")}</p>}
          {draft.ready && (
            <div className="min-w-0 space-y-2 rounded-lg border p-3">
              <p className="font-medium">{t("voiceDesign.result")}</p>
              <VoicePreview
                key={draft.ready.candidate_id}
                ready={draft.ready}
                disabled={expired || !open}
                onExpired={() =>
                  patch({
                    ready: draft.ready
                      ? {
                          ...draft.ready,
                          expires_at: new Date(0).toISOString(),
                        }
                      : null,
                  })
                }
              />
              <p>
                {t("voiceDesign.duration", {
                  seconds: draft.ready.duration_seconds.toFixed(1),
                })}
              </p>
              {draft.ready.duration_seconds > 5 && (
                <p className="text-xs text-muted-foreground">
                  {t("voiceDesign.videoHint")}
                </p>
              )}
              <p className="break-words text-xs text-muted-foreground">
                {t("voiceDesign.expires", {
                  time: new Date(draft.ready.expires_at).toLocaleString(),
                })}
              </p>
            </div>
          )}
          {draft.saved && <p role="status">{t("voiceDesign.saved")}</p>}
          {expired && <p role="status">{t("voiceDesign.expired")}</p>}
          {draft.error && (
            <p
              role="alert"
              className="break-words rounded-lg bg-muted p-3 text-sm"
            >
              {feedback(draft.error)}
            </p>
          )}
          {uncertain && (
            <Button
              variant="outline"
              onClick={() => void check()}
              disabled={candidate.isFetching}
            >
              {t("voiceDesign.check")}
            </Button>
          )}
          {draft.conflict && target.kind === "character" && (
            <Button variant="outline" onClick={() => void refreshTarget()}>
              {t("voiceDesign.refreshTarget")}
            </Button>
          )}
          <p
            className="break-words text-xs text-muted-foreground"
            role="status"
          >
            {quote.isError
              ? feedback(knownMessage(quote.error))
              : quote.data
                ? t("voiceDesign.price", { price: quote.data.display })
                : t("voiceDesign.quoteLoading")}
          </p>
        </div>
        <DialogFooter className="px-0 pb-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("voiceDesign.close")}
          </Button>
          <Button
            variant={draft.ready ? "outline" : "default"}
            disabled={
              !valid ||
              !quote.data ||
              quote.isError ||
              generating ||
              uncertain ||
              saving
            }
            onClick={() => void generate()}
          >
            {t(
              draft.ready || draft.generation.kind !== "idle"
                ? "voiceDesign.regenerate"
                : "voiceDesign.generate",
            )}
          </Button>
          <Button
            variant={draft.ready ? "default" : "outline"}
            disabled={!canSave}
            onClick={() =>
              target.kind === "character" && !!target.expectedSlot.path
                ? setConfirm(true)
                : void save(false)
            }
          >
            {saving ? t("voiceDesign.saving") : target.saveLabel}
          </Button>
        </DialogFooter>
        <AlertDialog open={confirm} onOpenChange={setConfirm}>
          <AlertDialogContent className="bg-[var(--ui-surface-modal)] backdrop-blur-none">
            <AlertDialogTitle>{t("voiceDesign.replaceTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("voiceDesign.replaceHint")}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <Button variant="outline" onClick={() => setConfirm(false)}>
                {t("voiceDesign.cancel")}
              </Button>
              <Button onClick={() => void save(true)}>
                {t("voiceDesign.replace")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
function VoicePreview({
  ready,
  disabled,
  onExpired,
}: {
  ready: VoiceDesignReady;
  disabled: boolean;
  onExpired: () => void;
}) {
  const { t } = useTranslation();
  const audio = useRef<HTMLAudioElement>(null);
  const url = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(
    () => () => {
      abort.current?.abort();
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );
  useEffect(() => {
    if (disabled) {
      abort.current?.abort();
      audio.current?.pause();
      audio.current?.removeAttribute("src");
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = null;
    }
  }, [disabled]);
  const play = async () => {
    if (disabled || loading) return;
    setLoading(true);
    setError("");
    abort.current = new AbortController();
    try {
      if (!url.current) {
        const blob = await fetchVoiceDesignAudio(
          ready.preview_url,
          abort.current.signal,
        );
        if (abort.current.signal.aborted) return;
        url.current = URL.createObjectURL(blob);
      }
      if (audio.current) {
        audio.current.src = url.current;
        await audio.current.play();
      }
    } catch (error) {
      if (
        error instanceof VoiceDesignApiError &&
        error.code === "candidate_expired"
      )
        onExpired();
      if (!abort.current.signal.aborted)
        setError(
          error instanceof VoiceDesignApiError
            ? error.message
            : "voiceDesign.errors.playback",
        );
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <audio
        ref={audio}
        controls
        aria-label={t("voiceDesign.audioLabel")}
        className="h-10 w-full min-w-0"
        onError={() => {
          setError("voiceDesign.errors.playback");
          if (url.current) URL.revokeObjectURL(url.current);
          url.current = null;
        }}
      />
      <Button
        variant="outline"
        onClick={() => void play()}
        disabled={disabled || loading}
      >
        {t(error ? "voiceDesign.retryPlayback" : "voiceDesign.play")}
      </Button>
      {error && (
        <p role="alert" className="break-words text-sm">
          {t(error, { defaultValue: error })}
        </p>
      )}
    </>
  );
}
