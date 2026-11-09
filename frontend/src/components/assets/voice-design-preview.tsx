// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AudioPreviewPlayer } from "@/components/ui/audio-preview-player";
import { Button } from "@/components/ui/button";
import {
  fetchVoiceDesignAudio,
  VoiceDesignApiError,
} from "@/lib/queries/voice-design";
import type { VoiceDesignReady } from "@/types/voice-design";

export function VoicePreview({
  ready,
  disabled,
  onExpired,
}: {
  ready: VoiceDesignReady;
  disabled: boolean;
  onExpired: () => void;
}) {
  const { t } = useTranslation();
  const url = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const onExpiredRef = useRef(onExpired);
  const [source, setSource] = useState<string>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    onExpiredRef.current = onExpired;
  }, [onExpired]);
  const load = useCallback(async () => {
    if (disabled) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError("");
    try {
      const blob = await fetchVoiceDesignAudio(
        ready.preview_url,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      url.current = URL.createObjectURL(blob);
      setSource(url.current);
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
  }, [disabled, ready.preview_url]);
  useEffect(() => {
    void load();
    return () => {
      abort.current?.abort();
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = null;
      setSource(undefined);
    };
  }, [load]);
  return (
    <>
      <AudioPreviewPlayer
        src={source}
        durationSeconds={ready.duration_seconds}
        disabled={disabled || loading}
        label={t("voiceDesign.audioLabel")}
        playLabel={t("voiceDesign.play")}
        onError={() => {
          setError("voiceDesign.errors.playback");
          if (url.current) URL.revokeObjectURL(url.current);
          url.current = null;
          setSource(undefined);
        }}
      />
      {error && (
        <div className="flex items-center justify-between gap-2">
          <p role="alert" className="break-words text-xs">
            {t(error, { defaultValue: error })}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            disabled={disabled || loading}
          >
            {t("voiceDesign.retryPlayback")}
          </Button>
        </div>
      )}
    </>
  );
}
