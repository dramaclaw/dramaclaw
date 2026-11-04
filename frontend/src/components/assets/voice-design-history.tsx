// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VoicePreview } from "@/components/assets/voice-design-preview";
import {
  fetchVoiceDesignHistory,
  saveVoiceDesignToLibrary,
} from "@/lib/queries/voice-design";
import { queryKeys } from "@/lib/query-keys";
import type { VoiceDesignReady } from "@/types/voice-design";

export function VoiceDesignRetentionHint({ seconds }: { seconds?: number }) {
  const { t } = useTranslation();
  const duration =
    seconds === undefined
      ? null
      : seconds % 86400 === 0
        ? t("voiceDesign.retentionDays", {
            count: seconds / 86400,
          })
        : seconds % 3600 === 0
          ? t("voiceDesign.retentionHours", {
              count: seconds / 3600,
            })
          : seconds % 60 === 0
            ? t("voiceDesign.retentionMinutes", { count: seconds / 60 })
            : t("voiceDesign.retentionSeconds", { count: seconds });
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      {duration
        ? t("voiceDesign.temporaryHint", { duration })
        : t("voiceDesign.expiryHint")}
    </p>
  );
}

type Publication =
  | { kind: "idle" }
  | { kind: "editing"; candidate: VoiceDesignReady; name: string }
  | {
      kind: "pending" | "failed";
      candidate: VoiceDesignReady;
      name: string;
      requestId: string;
      error: string;
    };

export function VoiceDesignHistoryPanel({
  project,
  onSelect,
  selectionDisabled = false,
  onSaved,
}: {
  project: string;
  onSelect?: (candidate: VoiceDesignReady) => void;
  selectionDisabled?: boolean;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const history = useQuery({
    queryKey: [...queryKeys.voiceDesignHistory(project), "library", cursor],
    queryFn: ({ signal }) =>
      fetchVoiceDesignHistory(project, {
        cursor: cursor ?? undefined,
        limit: 20,
        signal,
      }),
    retry: false,
    staleTime: 0,
  });
  const [now, setNow] = useState(Date.now);
  const [active, setActive] = useState<VoiceDesignReady | null>(null);
  const [publication, setPublication] = useState<Publication>({ kind: "idle" });
  const inFlight = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const busy = publication.kind === "pending";
  const expired = (candidate: VoiceDesignReady) =>
    Date.parse(candidate.expires_at) <= now;
  const publish = async () => {
    if (
      publication.kind === "idle" ||
      publication.kind === "pending" ||
      selectionDisabled ||
      inFlight.current
    )
      return;
    const { candidate, name } = publication;
    if (!name.trim() || Date.parse(candidate.expires_at) <= Date.now()) return;
    inFlight.current = true;
    const requestId =
      publication.kind === "failed"
        ? publication.requestId
        : crypto.randomUUID();
    setPublication({ kind: "pending", candidate, name, requestId, error: "" });
    try {
      await saveVoiceDesignToLibrary(project, candidate.candidate_id, {
        save_request_id: requestId,
        name: name.trim(),
      });
      setPublication({ kind: "idle" });
      setActive(null);
      await qc.invalidateQueries({
        queryKey: queryKeys.voiceDesignHistory(project),
      });
      await qc.invalidateQueries({
        queryKey: queryKeys.freezoneAssetLibrary(project),
      });
      onSaved();
    } catch (error) {
      setPublication({
        kind: "failed",
        candidate,
        name,
        requestId,
        error:
          error instanceof Error ? error.message : "voiceDesign.errors.network",
      });
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-5"
      aria-label={t("voiceDesign.recentGenerations")}
    >
      <div className="space-y-2">
        <p className="text-sm font-medium">{t("voiceDesign.privateHistory")}</p>
        <VoiceDesignRetentionHint seconds={history.data?.retention_seconds} />
        <p className="text-xs text-muted-foreground">
          {t("voiceDesign.projectSaveHint")}
        </p>
      </div>
      {history.isPending && (
        <p role="status">{t("voiceDesign.historyLoading")}</p>
      )}
      {history.isError && (
        <div role="alert">
          <p>
            {t(history.error.message, { defaultValue: history.error.message })}
          </p>
          <Button variant="outline" onClick={() => void history.refetch()}>
            {t("voiceDesign.historyRetry")}
          </Button>
        </div>
      )}
      <ul className="ui-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto">
        {history.data?.candidates.map((candidate) => (
          <li
            key={candidate.candidate_id}
            className="rounded-lg border border-border bg-muted/20 p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {candidate.model?.label ?? t("voiceDesign.modelUnknown")} ·{" "}
                {t("voiceDesign.duration", {
                  seconds: candidate.duration_seconds.toFixed(1),
                })}
              </span>
              <time dateTime={candidate.created_at}>
                {new Date(candidate.created_at).toLocaleString()}
              </time>
            </div>
            <p className="mt-2 break-words text-sm">{candidate.description}</p>
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {candidate.preview_text}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {expired(candidate)
                ? t("voiceDesign.expired")
                : t("voiceDesign.expires", {
                    time: new Date(candidate.expires_at).toLocaleString(),
                  })}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || expired(candidate)}
                onClick={() => setActive(candidate)}
              >
                {t("voiceDesign.listenHistory")}
              </Button>
              {onSelect && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selectionDisabled || busy || expired(candidate)}
                  onClick={() => {
                    if (Date.parse(candidate.expires_at) > Date.now())
                      onSelect(candidate);
                  }}
                >
                  {t("voiceDesign.chooseHistory")}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={selectionDisabled || busy || expired(candidate)}
                onClick={() =>
                  setPublication({
                    kind: "editing",
                    candidate,
                      name: Array.from(candidate.description).slice(0, 60).join(""),
                  })
                }
              >
                {t("voiceDesign.saveToProject")}
              </Button>
            </div>
            {active?.candidate_id === candidate.candidate_id && (
              <div className="mt-3">
                <VoicePreview
                  ready={candidate}
                  disabled={expired(candidate)}
                  onExpired={() => void history.refetch()}
                />
              </div>
            )}
            {publication.kind !== "idle" &&
              publication.candidate.candidate_id === candidate.candidate_id && (
                <div className="mt-3 space-y-2 rounded-md bg-background/50 p-3">
                  <label className="block text-xs">
                    {t("voiceDesign.projectAssetName")}
                    <Input
                      className="mt-1"
                      maxLength={60}
                      value={publication.name}
                      disabled={publication.kind !== "editing"}
                      onChange={(event) =>
                        setPublication({
                          kind: "editing",
                          candidate,
                          name: event.target.value,
                        })
                      }
                    />
                  </label>
                  {publication.kind === "failed" && (
                    <p role="alert" className="text-xs text-destructive">
                      {t(publication.error, {
                        defaultValue: publication.error,
                      })}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={
                        busy ||
                        selectionDisabled ||
                        expired(candidate) ||
                        !publication.name.trim()
                      }
                      onClick={() => void publish()}
                    >
                      {t(
                        publication.kind === "failed"
                          ? "voiceDesign.retrySave"
                          : "voiceDesign.confirmProjectSave",
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setPublication({ kind: "idle" })}
                    >
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              )}
          </li>
        ))}
      </ul>
      {!history.isPending &&
        !history.isError &&
        history.data?.candidates.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t("voiceDesign.historyEmpty")}
          </p>
        )}
      <nav
        className="flex items-center justify-end gap-3"
        aria-label={t("voiceDesign.historyPages")}
      >
        <Button
          size="sm"
          variant="outline"
          disabled={cursors.length <= 1 || history.isFetching || busy}
          onClick={() => {
            setActive(null);
            setPublication({ kind: "idle" });
            setCursors((current) => current.slice(0, -1));
          }}
        >
          {t("voiceDesign.previousPage")}
        </Button>
        <span className="text-xs tabular-nums">{cursors.length}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={!history.data?.next_cursor || history.isFetching || busy}
          onClick={() => {
            const next = history.data?.next_cursor;
            if (next) {
              setActive(null);
              setPublication({ kind: "idle" });
              setCursors((current) => [...current, next]);
            }
          }}
        >
          {t("voiceDesign.nextPage")}
        </Button>
      </nav>
    </section>
  );
}
