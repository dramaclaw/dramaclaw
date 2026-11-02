// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useId, useRef, useState } from "react";
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
  useVoiceDesignModels,
  VoiceDesignApiError,
} from "@/lib/queries/voice-design";
import { queryKeys } from "@/lib/query-keys";
import { matchesVoiceDesignModel } from "@/types/voice-design";
import type {
  ExpectedVoiceSlot,
  SaveGeneratedAccountVoice,
  SaveGeneratedCharacterVoice,
  VoiceDesignCandidate,
  VoiceDesignReady,
  VoiceDesignSurface,
  VoiceDesignModel,
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
type SaveOperation =
  | { kind: "idle" }
  | { kind: "pending" | "failed" | "saved"; attempt: SaveAttempt };
type Generation =
  | { kind: "idle" }
  | {
      kind: "submitting" | "tracking" | "unresolved";
      id: string;
      model: VoiceDesignModel;
    }
  | { kind: "settled" };
type ModelDraft = {
  generation: Generation;
  ready: VoiceDesignReady | null;
  error: string;
  save: SaveOperation;
  conflict: boolean;
};
function newModelDraft(): ModelDraft {
  return {
    generation: { kind: "idle" },
    ready: null,
    error: "",
    save: { kind: "idle" },
    conflict: false,
  };
}
type DraftInputs = { description: string; previewText: string; name: string };
type Draft = DraftInputs & {
  selectedCatalogId: string | null;
  models: Record<string, ModelDraft>;
};
function newDraft(): Draft {
  return {
    description: "",
    previewText: "",
    name: "",
    selectedCatalogId: null,
    models: {},
  };
}
function isLocked(draft: Draft): boolean {
  return Object.values(draft.models).some(
    (model) =>
      model.save.kind === "pending" ||
      ["submitting", "tracking", "unresolved"].includes(model.generation.kind),
  );
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
  const { data: session } = useQuery({
    queryKey: key,
    queryFn: newDraft,
    initialData: newDraft,
    enabled: false,
    gcTime: Infinity,
  });
  const catalogId = session.selectedCatalogId;
  const draft = session.models[catalogId ?? ""] ?? newModelDraft();
  const patch = (update: Partial<ModelDraft>, requestId?: string) =>
    qc.setQueryData<Draft>(key, (current) => {
      if (!current || !catalogId) return current;
      const model = current.models[catalogId] ?? newModelDraft();
      if (
        requestId &&
        (!("id" in model.generation) || model.generation.id !== requestId)
      )
        return current;
      return {
        ...current,
        models: { ...current.models, [catalogId]: { ...model, ...update } },
      };
    });
  const patchInputs = (update: Partial<DraftInputs>) =>
    qc.setQueryData<Draft>(key, (current) =>
      current ? { ...current, ...update } : current,
    );
  const models = useVoiceDesignModels(project);
  const selectedModel = models.isError
    ? undefined
    : models.data?.models.find((model) => model.catalog_id === catalogId);
  useEffect(() => {
    const first = models.data?.models[0];
    if (!first) return;
    qc.setQueryData<Draft>(key, (current) =>
      current?.selectedCatalogId === null
        ? { ...current, selectedCatalogId: first.catalog_id }
        : current,
    );
  }, [models.data]);
  const selectModel = (nextId: string) => {
    qc.setQueryData<Draft>(key, (current) =>
      current &&
      !isLocked(current) &&
      models.data?.models.some((model) => model.catalog_id === nextId)
        ? { ...current, selectedCatalogId: nextId }
        : current,
    );
  };
  const quote = useVoiceDesignQuote(project, surface, selectedModel);
  const saving = Object.values(session.models).some(
    (model) => model.save.kind === "pending",
  );
  const selectionLocked = isLocked(session);
  const [confirm, setConfirm] = useState(false);
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(true);
  const busy = useRef(false);
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
  function receive(
    result: VoiceDesignCandidate,
    { id, model }: { id: string; model: VoiceDesignModel },
  ) {
    const expected = { id, model };
    if (
      result.candidate_id !== expected.id ||
      !matchesVoiceDesignModel(result.model, expected.model)
    ) {
      patch(
        {
          generation: { kind: "unresolved", ...expected },
          error: "voiceDesign.errors.invalidResponse",
        },
        expected.id,
      );
      return;
    }
    patch(
      {
        generation:
          result.status === "generating"
            ? { kind: "tracking", ...expected }
            : result.status === "unknown"
              ? { kind: "unresolved", ...expected }
              : { kind: "settled" },
        ...(result.status === "ready"
          ? {
              ready: result,
              save: { kind: "idle" },
              conflict: false,
              error: "",
            }
          : {}),
        ...(result.status === "failed" || result.status === "unknown"
          ? { error: result.failure.message }
          : {}),
        ...(result.status === "expired"
          ? { error: "voiceDesign.expired" }
          : {}),
      },
      expected.id,
    );
  }
  useEffect(() => {
    if (
      candidate.data &&
      "id" in draft.generation &&
      candidate.data.candidate_id === activeId
    )
      receive(candidate.data, draft.generation);
  }, [candidate.data]);
  useEffect(() => {
    if (!candidate.error || !activeId || !("id" in draft.generation)) return;
    if (
      candidate.error instanceof VoiceDesignApiError &&
      ["candidate_expired", "candidate_not_found"].includes(
        candidate.error.code,
      )
    ) {
      patch(
        {
          generation: { kind: "idle" },
          error: knownMessage(candidate.error),
          ...(draft.ready?.candidate_id === activeId ? { ready: null } : {}),
        },
        activeId,
      );
    } else
      patch(
        {
          generation: { ...draft.generation, kind: "unresolved" },
          error: knownMessage(candidate.error),
        },
        activeId,
      );
  }, [candidate.error]);
  const generating =
    draft.generation.kind === "submitting" ||
    draft.generation.kind === "tracking";
  const uncertain = draft.generation.kind === "unresolved";
  const descriptionLength = Array.from(session.description.trim()).length;
  const previewLength = Array.from(session.previewText.trim()).length;
  const valid =
    descriptionLength > 0 &&
    descriptionLength <= 500 &&
    previewLength >= 15 &&
    previewLength <= 60;
  const expired = !!draft.ready && Date.parse(draft.ready.expires_at) <= now;
  const canSave =
    !!draft.ready &&
    !expired &&
    !selectionLocked &&
    draft.save.kind !== "saved" &&
    !draft.conflict &&
    (target.kind !== "account" || !!session.name.trim());
  const generate = async () => {
    const current = qc.getQueryData<Draft>(key);
    if (
      busy.current ||
      current?.selectedCatalogId !== catalogId ||
      generating ||
      uncertain ||
      (current && isLocked(current)) ||
      !valid ||
      !selectedModel ||
      !quote.data ||
      quote.isError
    )
      return;
    busy.current = true;
    const requestId = crypto.randomUUID();
    const expected = { id: requestId, model: quote.data.model };
    patch({ generation: { kind: "submitting", ...expected }, error: "" });
    try {
      const result = await createVoiceDesign(project, {
        request_id: requestId,
        catalog_id: expected.model.catalog_id,
        config_digest: expected.model.config_digest,
        surface,
        description: session.description.trim(),
        preview_text: session.previewText.trim(),
        language: "zh",
      });
      if (result.status === "unknown")
        patch(
          {
            generation: { kind: "tracking", ...expected },
            error: result.failure.message,
          },
          requestId,
        );
      else receive(result, expected);
    } catch (error) {
      const uncertainResult =
        !(error instanceof VoiceDesignApiError) || error.status >= 500;
      patch(
        {
          generation: uncertainResult
            ? { kind: "tracking", ...expected }
            : { kind: "idle" },
          error: knownMessage(error),
        },
        requestId,
      );
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
    if (result.data && "id" in draft.generation)
      receive(result.data, draft.generation);
    else if (result.error)
      patch({ error: knownMessage(result.error) }, activeId);
  };
  const save = async (replace: boolean) => {
    const currentSession = qc.getQueryData<Draft>(key);
    const current = currentSession?.models[catalogId ?? ""];
    if (
      !canSave ||
      !current?.ready ||
      !currentSession ||
      currentSession.selectedCatalogId !== catalogId ||
      isLocked(currentSession)
    )
      return;
    setConfirm(false);
    const common = {
      candidate_id: current.ready.candidate_id,
      save_request_id: crypto.randomUUID(),
    };
    const attempt: SaveAttempt =
      current.save.kind === "failed"
        ? current.save.attempt
        : target.kind === "character"
          ? {
              kind: "character",
              input: {
                ...common,
                expected_slot: { ...target.expectedSlot },
                replace_existing: replace,
              },
            }
          : {
              kind: "account",
              input: { ...common, name: currentSession.name.trim() },
            };
    patch({ save: { kind: "pending", attempt }, error: "" });
    const finish = (update: Partial<ModelDraft>) => {
      let applied = false;
      qc.setQueryData<Draft>(key, (latestSession) => {
        const latest = latestSession?.models[catalogId ?? ""];
        if (
          !latestSession ||
          !catalogId ||
          !latest ||
          latest.save.kind !== "pending" ||
          latest.save.attempt.input.save_request_id !==
            attempt.input.save_request_id ||
          latest.save.attempt.input.candidate_id !==
            attempt.input.candidate_id ||
          latest.ready?.candidate_id !== attempt.input.candidate_id
        )
          return latestSession;
        applied = true;
        return {
          ...latestSession,
          models: {
            ...latestSession.models,
            [catalogId]: { ...latest, ...update },
          },
        };
      });
      return applied;
    };
    try {
      if (attempt.kind === "character" && target.kind === "character")
        await target.onSave(attempt.input);
      else if (attempt.kind === "account" && target.kind === "account")
        await target.onSave(attempt.input);
      else return;
      if (finish({ save: { kind: "saved", attempt } }) && mounted.current) {
        target.onSaved?.();
        onOpenChange(false);
      }
    } catch (error) {
      finish({
        save: { kind: "failed", attempt },
        error: knownMessage(error),
        ...(error instanceof VoiceDesignApiError &&
        error.code === "candidate_expired"
          ? {
              ready: {
                ...current.ready,
                expires_at: new Date(0).toISOString(),
              },
            }
          : {}),
        conflict:
          error instanceof VoiceDesignApiError &&
          ["slot_changed", "slot_occupied"].includes(error.code),
      });
    }
  };
  const refreshTarget = async () => {
    if (target.kind !== "character") return;
    try {
      await target.onRefresh();
      patch({ conflict: false, save: { kind: "idle" }, error: "" });
    } catch (error) {
      patch({ error: knownMessage(error) });
    }
  };
  return {
    draft,
    session,
    patch,
    patchInputs,
    models,
    selectedModel,
    selectModel,
    selectionLocked,
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
    session,
    patch,
    patchInputs,
    models,
    selectedModel,
    selectModel,
    selectionLocked,
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
            <Label htmlFor={`${id}-model`}>{t("voiceDesign.model")}</Label>
            <select
              id={`${id}-model`}
              value={session.selectedCatalogId ?? ""}
              disabled={selectionLocked || !models.data?.models.length}
              onChange={(e) => selectModel(e.target.value)}
              className="w-full rounded-lg border border-input bg-[var(--ui-surface-field)] px-2.5 py-2 text-sm disabled:opacity-50"
            >
              {!selectedModel && (
                <option value={session.selectedCatalogId ?? ""}>
                  {t(
                    models.isPending
                      ? "voiceDesign.modelsLoading"
                      : session.selectedCatalogId
                        ? "voiceDesign.modelUnavailable"
                        : "voiceDesign.modelsEmpty",
                  )}
                </option>
              )}
              {models.data?.models.map((model) => (
                <option key={model.catalog_id} value={model.catalog_id}>
                  {model.label}
                </option>
              ))}
            </select>
            {models.isError ? (
              <p role="alert">{feedback(knownMessage(models.error))}</p>
            ) : !selectedModel ? (
              <p role="status">
                {t(
                  models.isPending
                    ? "voiceDesign.modelsLoading"
                    : session.selectedCatalogId
                      ? "voiceDesign.modelUnavailable"
                      : "voiceDesign.modelsEmpty",
                )}
              </p>
            ) : (
              <ModelDetails model={selectedModel} prefix="selected" />
            )}
          </div>
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
              value={session.description}
              onChange={(e) => patchInputs({ description: e.target.value })}
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
              value={session.previewText}
              onChange={(e) => patchInputs({ previewText: e.target.value })}
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
                value={session.name}
                disabled={saving}
                onChange={(e) => {
                  patchInputs({ name: e.target.value });
                  patch({ save: { kind: "idle" } });
                }}
              />
            </div>
          )}
          {generating && <p role="status">{t("voiceDesign.generating")}</p>}
          {draft.ready && (
            <div className="min-w-0 space-y-2 rounded-lg border p-3">
              <p className="font-medium">{t("voiceDesign.result")}</p>
              <ModelDetails model={draft.ready.model} prefix="result" />
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
          {draft.save.kind === "saved" && (
            <p role="status">{t("voiceDesign.saved")}</p>
          )}
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
            {!selectedModel
              ? t("voiceDesign.modelUnavailable")
              : quote.isError
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
              !selectedModel ||
              !quote.data ||
              quote.isError ||
              selectionLocked
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
function ModelDetails({
  model,
  prefix,
}: {
  model: VoiceDesignModel | null;
  prefix: "selected" | "result";
}) {
  const { t } = useTranslation();
  if (!model)
    return (
      <p className="text-xs text-muted-foreground">
        {t("voiceDesign.modelUnknown")}
      </p>
    );
  return (
    <div className="break-words text-xs text-muted-foreground">
      <p>{t(`voiceDesign.${prefix}Model`, { model: model.model })}</p>
      {model.target_model && (
        <p>
          {t(`voiceDesign.${prefix}Target`, {
            model: model.target_model.model,
          })}
        </p>
      )}
      {model.execution_mode === "test_replay" && (
        <p>{t("voiceDesign.testReplay")}</p>
      )}
    </div>
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
  const onExpiredRef = useRef(onExpired);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    onExpiredRef.current = onExpired;
  }, [onExpired]);
  const load = useCallback(
    async (playAfterLoad: boolean) => {
      if (disabled) return;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setLoading(true);
      setError("");
      try {
        if (!url.current) {
          const blob = await fetchVoiceDesignAudio(
            ready.preview_url,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          url.current = URL.createObjectURL(blob);
          if (audio.current) audio.current.src = url.current;
        }
        if (playAfterLoad && audio.current) {
          await audio.current.play();
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (
          error instanceof VoiceDesignApiError &&
          error.code === "candidate_expired"
        )
          onExpiredRef.current();
        setError(
          error instanceof VoiceDesignApiError
            ? error.message
            : "voiceDesign.errors.playback",
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [disabled, ready.preview_url],
  );
  useEffect(() => {
    const element = audio.current;
    void load(false);
    return () => {
      abort.current?.abort();
      element?.pause();
      element?.removeAttribute("src");
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = null;
    };
  }, [load]);
  return (
    <>
      <audio
        ref={audio}
        controls
        preload="metadata"
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
        onClick={() => void load(true)}
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
