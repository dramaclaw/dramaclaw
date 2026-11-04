// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatAudioClock } from "@/components/ui/audio-preview-player";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  getVoiceDesign,
  useVoiceDesignQuote,
  useVoiceDesignModels,
  useVoiceDesignHistory,
  VoiceDesignApiError,
} from "@/lib/queries/voice-design";
import { AssetLibraryModal } from "@/features/canvas/ui/AssetLibraryModal";
import { VoiceDesignRetentionHint } from "@/components/assets/voice-design-history";
import { VoicePreview } from "@/components/assets/voice-design-preview";
import { queryKeys } from "@/lib/query-keys";
import { matchesVoiceDesignModel } from "@/types/voice-design";
import type {
  ExpectedVoiceSlot,
  SaveGeneratedAccountVoice,
  SaveGeneratedCharacterVoice,
  VoiceDesignCandidate,
  VoiceDesignCreate,
  VoiceDesignHistory,
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
      kind: "submitting" | "tracking" | "unresolved" | "unknown";
      id: string;
      model: VoiceDesignModel;
    }
  | { kind: "settled" };
type ModelDraft = {
  generation: Generation;
  pendingRequest: { input: VoiceDesignCreate; model: VoiceDesignModel } | null;
  ready: VoiceDesignReady | null;
  error: string;
  save: SaveOperation;
  conflict: boolean;
};
function newModelDraft(): ModelDraft {
  return {
    generation: { kind: "idle" },
    pendingRequest: null,
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
  failedSaves: Record<string, { attempt: SaveAttempt; conflict: boolean }>;
};
function newDraft(): Draft {
  return {
    description: "",
    previewText: "",
    name: "",
    selectedCatalogId: null,
    models: {},
    failedSaves: {},
  };
}
function matchesSaveTarget(attempt: SaveAttempt, target: VoiceDesignTarget, name: string): boolean {
  if (attempt.kind === "account")
    return target.kind === "account" && attempt.input.name === name.trim();
  return target.kind === "character" &&
    attempt.input.expected_slot.path === target.expectedSlot.path &&
    attempt.input.expected_slot.sha256 === target.expectedSlot.sha256 &&
    attempt.input.expected_slot.updated_at === target.expectedSlot.updated_at;
}
function isLocked(draft: Draft): boolean {
  return Object.values(draft.models).some(
    (model) =>
      model.save.kind === "pending" ||
      ["submitting", "tracking", "unresolved", "unknown"].includes(model.generation.kind),
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
  open,
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
  const history = useVoiceDesignHistory(project, open);
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
  const selectHistory = (ready: VoiceDesignReady) => {
    if (Date.parse(ready.expires_at) <= Date.now()) return;
    qc.setQueryData<Draft>(key, (current) => {
      if (!current || isLocked(current)) return current;
      const nextId = ready.model?.catalog_id ?? `legacy:${ready.candidate_id}`;
      const failed = current.failedSaves?.[ready.candidate_id];
      const failedAttempt = failed && matchesSaveTarget(failed.attempt, target, current.name)
        ? failed.attempt : undefined;
      return {
        ...current,
        description: ready.description,
        previewText: ready.preview_text,
        selectedCatalogId: nextId,
        models: {
          ...current.models,
          [nextId]: {
            ...newModelDraft(),
            generation: { kind: "settled" },
            ready,
            save: failedAttempt ? { kind: "failed", attempt: failedAttempt } : { kind: "idle" },
            conflict: !!failedAttempt && !!failed?.conflict,
          },
        },
      };
    });
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
    draft.generation.kind === "unresolved" ||
    draft.generation.kind === "unknown"
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
        ...(result.status !== "generating" ? { pendingRequest: null } : {}),
        generation:
          result.status === "generating"
            ? { kind: "tracking", ...expected }
            : result.status === "unknown"
              ? { kind: "unknown", ...expected }
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
    if (result.status === "ready") {
      qc.setQueryData<VoiceDesignHistory>(
        queryKeys.voiceDesignHistory(project),
        (current) => current ? ({
          ...current,
          candidates: [result, ...current.candidates.filter(
            (item) => item.candidate_id !== result.candidate_id,
          )].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 5),
        }) : current,
      );
      void qc.invalidateQueries({ queryKey: queryKeys.voiceDesignHistory(project) });
    }
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
          generation: { ...draft.generation, kind: draft.generation.kind === "unknown" ? "unknown" : "unresolved" },
          error: knownMessage(candidate.error),
        },
        activeId,
      );
  }, [candidate.error]);
  const generating =
    draft.generation.kind === "submitting" ||
    draft.generation.kind === "tracking";
  const uncertain = draft.generation.kind === "unresolved" || draft.generation.kind === "unknown";
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
  const expirePreview = () => {
    if (!draft.ready) return;
    const candidateId = draft.ready.candidate_id;
    patch({ ready: { ...draft.ready, expires_at: new Date(0).toISOString() } });
    qc.setQueryData<VoiceDesignHistory>(
      queryKeys.voiceDesignHistory(project),
      (current) => current ? { ...current, candidates: current.candidates.filter((item) => item.candidate_id !== candidateId) } : current,
    );
  };
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
    await submit({
      request_id: crypto.randomUUID(),
      catalog_id: quote.data.model.catalog_id,
      config_digest: quote.data.model.config_digest,
      surface,
      description: session.description.trim(),
      preview_text: session.previewText.trim(),
      language: "zh",
    }, quote.data.model);
  };
  const submit = async (input: VoiceDesignCreate, model: VoiceDesignModel) => {
    busy.current = true;
    const requestId = input.request_id;
    const expected = { id: requestId, model };
    patch({ generation: { kind: "submitting", ...expected }, pendingRequest: null, error: "" });
    try {
      const result = await createVoiceDesign(project, input);
      receive(result, expected);
    } catch (error) {
      const uncertainResult = !(error instanceof VoiceDesignApiError) ||
        error.code === "invalid_response" ||
        (error.status >= 500 && error.retryable);
      patch(
        {
          generation: uncertainResult
            ? { kind: "tracking", ...expected }
            : { kind: "idle" },
          pendingRequest: uncertainResult ? { input, model } : null,
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
  const retrySubmission = async () => {
    const current = qc.getQueryData<Draft>(key);
    const model = current?.models[catalogId ?? ""];
    if (busy.current || current?.selectedCatalogId !== catalogId || !model?.pendingRequest ||
      (model.generation.kind !== "tracking" && model.generation.kind !== "unresolved")) return;
    await submit(model.pendingRequest.input, model.pendingRequest.model);
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
  const restart = (requestId: string) => {
    if (busy.current || candidate.isFetching || !catalogId) return;
    qc.setQueryData<Draft>(key, (current) => {
      const model = current?.models[catalogId];
      if (
        !current || current.selectedCatalogId !== catalogId ||
        model?.generation.kind !== "unknown" || model.generation.id !== requestId
      ) return current;
      return {
        ...current,
        models: { ...current.models, [catalogId]: { ...model, generation: { kind: "idle" }, error: "" } },
      };
    });
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
      current.save.kind === "failed" &&
      matchesSaveTarget(current.save.attempt, target, currentSession.name) &&
      (current.save.attempt.kind !== "character" || current.save.attempt.input.replace_existing === replace)
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
          failedSaves: update.save?.kind === "failed"
            ? { ...latestSession.failedSaves, [attempt.input.candidate_id]: { attempt, conflict: update.conflict ?? false } }
            : update.save?.kind === "saved"
              ? Object.fromEntries(Object.entries(latestSession.failedSaves ?? {}).filter(([id]) => id !== attempt.input.candidate_id))
              : latestSession.failedSaves,
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
      await qc.cancelQueries({ queryKey: queryKeys.voiceDesignHistory(project) });
      qc.setQueryData<VoiceDesignHistory>(
        queryKeys.voiceDesignHistory(project),
        (current) => current ? {
          ...current,
          candidates: current.candidates.filter((item) => item.candidate_id !== attempt.input.candidate_id),
        } : current,
      );
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
    const candidateId = draft.ready?.candidate_id;
    if (!candidateId) return;
    try {
      await target.onRefresh();
      qc.setQueryData<Draft>(key, (current) => {
        if (!current || !catalogId) return current;
        const model = current.models[catalogId];
        return {
          ...current,
          failedSaves: Object.fromEntries(Object.entries(current.failedSaves ?? {}).filter(([id]) => id !== candidateId)),
          models: model?.ready?.candidate_id === candidateId && model.save.kind !== "pending"
            ? { ...current.models, [catalogId]: { ...model, conflict: false, save: { kind: "idle" }, error: "" } }
            : current.models,
        };
      });
    } catch (error) {
      qc.setQueryData<Draft>(key, (current) => {
        if (!current || !catalogId) return current;
        const model = current.models[catalogId];
        return model?.ready?.candidate_id === candidateId && model.save.kind !== "pending"
          ? { ...current, models: { ...current.models, [catalogId]: { ...model, error: knownMessage(error) } } }
          : current;
      });
    }
  };
  return {
    draft,
    session,
    patch,
    patchInputs,
    models,
    history,
    selectHistory,
    now,
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
    expirePreview,
    generate,
    retrySubmission,
    check,
    restart,
    save,
    refreshTarget,
  };
}
function VoiceDesignSession(props: Props) {
  const { t } = useTranslation();
  const { target, open, onOpenChange } = props;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restartId, setRestartId] = useState<string | null>(null);
  const {
    draft,
    session,
    patch,
    patchInputs,
    models,
    history,
    selectHistory,
    now,
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
    expirePreview,
    generate,
    retrySubmission,
    check,
    restart,
    save,
    refreshTarget,
  } = useVoiceDesignSession(props);
  const feedback = (message: string) => t(message, { defaultValue: message });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden bg-[var(--ui-surface-modal)] sm:max-w-xl"
        overlayClassName="backdrop-blur-none supports-backdrop-filter:backdrop-blur-none"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{t("voiceDesign.title")}</DialogTitle>
          <DialogDescription>
            {t("voiceDesign.target", { target: target.label })}
          </DialogDescription>
        </DialogHeader>
        <div className="ui-scrollbar min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <div className="space-y-2">
            <Label htmlFor={`${id}-model`}>{t("voiceDesign.model")}</Label>
            <Select
              value={session.selectedCatalogId}
              disabled={selectionLocked || !models.data?.models.length}
              onValueChange={(value) => {
                if (value) selectModel(value);
              }}
            >
              <SelectTrigger
                id={`${id}-model`}
                aria-label={t("voiceDesign.model")}
                className="h-8 w-full rounded-[8px] border-white/10 bg-[var(--ui-surface-field)] px-3 text-xs font-normal shadow-none hover:bg-white/[0.04] dark:bg-[var(--ui-surface-field)]"
              >
                <SelectValue>
                  {selectedModel?.label ??
                    (draft.ready ? t("voiceDesign.modelUnavailableShort", { model: draft.ready.model?.label ?? t("voiceDesign.modelUnknown") }) : undefined) ??
                    t(
                      models.isPending
                        ? "voiceDesign.modelsLoading"
                        : session.selectedCatalogId
                          ? "voiceDesign.modelUnavailable"
                          : "voiceDesign.modelsEmpty",
                    )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                align="start"
                alignItemWithTrigger={false}
                className="rounded-md border border-white/10 bg-popover p-1 shadow-xl shadow-black/20 ring-0"
              >
                {models.data?.models.map((model) => (
                  <SelectItem
                    key={model.catalog_id}
                    value={model.catalog_id}
                    className="min-h-8 gap-2 rounded-sm px-2 py-1.5 text-xs focus:bg-white/8 focus:text-current"
                  >
                    {model.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
          <section aria-label={t("voiceDesign.historyTitle")} className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{t("voiceDesign.historyTitle")}</h3>
              <Button size="sm" variant="ghost" disabled={selectionLocked} onClick={() => setHistoryOpen(true)}>{t("voiceDesign.viewAll")}</Button>
              {history.isError && (
                <Button variant="ghost" size="sm" onClick={() => void history.refetch()}>
                  {t("voiceDesign.historyRetry")}
                </Button>
              )}
            </div>
            <VoiceDesignRetentionHint seconds={history.data?.retention_seconds} />
            {history.isError ? <p role="alert" className="text-xs">{feedback(knownMessage(history.error))}</p> : (
              <div className="ui-scrollbar max-h-40 space-y-1 overflow-y-auto">
                {history.data?.candidates.filter((item) => Date.parse(item.expires_at) > now).slice(0, 5).map((item) => (
                  <button
                    key={item.candidate_id}
                    type="button"
                    aria-label={t("voiceDesign.selectHistory", { description: item.description })}
                    aria-pressed={draft.ready?.candidate_id === item.candidate_id}
                    disabled={selectionLocked}
                    onClick={() => selectHistory(item)}
                    className="w-full rounded-md border border-transparent bg-muted/20 px-3 py-2 text-left transition hover:bg-muted/50 aria-pressed:border-primary/50 aria-pressed:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span className="flex items-center justify-between gap-2 text-xs">
                      <span>{item.model?.label ?? t("voiceDesign.modelUnknown")}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{formatAudioClock(item.duration_seconds)}</span>
                    </span>
                    <span className="mt-1 block truncate text-sm">{item.description}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {new Date(item.created_at).toLocaleTimeString()} · {t("voiceDesign.expires", { time: new Date(item.expires_at).toLocaleString() })}
                    </span>
                  </button>
                ))}
                {!history.isPending && !history.data?.candidates.some((item) => Date.parse(item.expires_at) > now) && <p className="text-xs text-muted-foreground">{t("voiceDesign.historyEmpty")}</p>}
              </div>
            )}
          </section>
          {draft.ready && (
            <div className="min-w-0 space-y-2 rounded-lg border p-3">
              <p className="font-medium">{t("voiceDesign.result")}</p>
              <ModelDetails model={draft.ready.model} prefix="result" />
              <p className="break-words text-xs text-muted-foreground">{t("voiceDesign.originalDescription", { description: draft.ready.description })}</p>
              <VoicePreview
                key={draft.ready.candidate_id}
                ready={draft.ready}
                disabled={expired || !open || historyOpen}
                onExpired={expirePreview}
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
          {draft.pendingRequest && (draft.generation.kind === "tracking" || draft.generation.kind === "unresolved") && (
            <Button variant="outline" onClick={() => void retrySubmission()} disabled={candidate.isFetching}>
              {t("voiceDesign.retrySubmission")}
            </Button>
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
          {draft.generation.kind === "unknown" && (
            <Button
              variant="outline"
              disabled={candidate.isFetching}
              onClick={() => {
                if (draft.generation.kind === "unknown") setRestartId(draft.generation.id);
              }}
            >
              {t("voiceDesign.restart")}
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
        <DialogFooter className="shrink-0 px-0 pb-0">
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
          {draft.save.kind !== "saved" && <Button
            variant={draft.ready ? "default" : "outline"}
            disabled={!canSave}
            onClick={() =>
              target.kind === "character" && !!target.expectedSlot.path
                ? setConfirm(true)
                : void save(false)
            }
          >
            {saving ? t("voiceDesign.saving") : target.saveLabel}
          </Button>}
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
        <AlertDialog open={restartId !== null} onOpenChange={(open) => { if (!open) setRestartId(null); }}>
          <AlertDialogContent className="bg-[var(--ui-surface-modal)] backdrop-blur-none">
            <AlertDialogTitle>{t("voiceDesign.restartTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("voiceDesign.restartHint")}</AlertDialogDescription>
            <AlertDialogFooter>
              <Button variant="outline" onClick={() => setRestartId(null)}>{t("voiceDesign.cancel")}</Button>
              <Button disabled={candidate.isFetching} onClick={() => {
                if (restartId) restart(restartId);
                setRestartId(null);
              }}>{t("voiceDesign.restart")}</Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AssetLibraryModal
          mode="manage"
          open={open && historyOpen}
          project={props.project}
          initialView="recent"
          allowedMedia={["audio"]}
          selectionDisabled={selectionLocked}
          onClose={() => setHistoryOpen(false)}
          onSelectCandidate={ready => {
            if (!selectionLocked) {
              selectHistory(ready);
              setHistoryOpen(false);
            }
          }}
        />
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
      {prefix === "result" && <p className="font-medium text-foreground">{model.label}</p>}
      <details>
        <summary className="cursor-pointer">{t("voiceDesign.modelDetails")}</summary>
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
      </details>
    </div>
  );
}
