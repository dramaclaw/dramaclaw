// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo, useState } from "react";
import { FastForward, Loader2, Scissors } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AUDIO_TRANSFORM_MAX_SPEED,
  AUDIO_TRANSFORM_MIN_SPEED,
  type AudioTransformDraft,
  validateAudioTransform,
} from "@/features/canvas/application/audioTransform";

const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

interface AudioTransformMenuProps {
  mode: "trim" | "speed";
  durationMs: number | null | undefined;
  disabled: boolean;
  disabledReason?: string;
  busy?: boolean;
  buttonClassName: string;
  onSubmit: (draft: AudioTransformDraft) => Promise<void> | void;
}

function formatSeconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(2);
}

export function AudioTransformMenu({
  mode,
  durationMs,
  disabled,
  disabledReason,
  busy = false,
  buttonClassName,
  onSubmit,
}: AudioTransformMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [startSeconds, setStartSeconds] = useState("0");
  const [endSeconds, setEndSeconds] = useState(
    typeof durationMs === "number" ? formatSeconds(durationMs) : "",
  );
  const [speed, setSpeed] = useState(1);

  const draft = useMemo<AudioTransformDraft>(
    () => ({
      startMs: Number(startSeconds) * 1000,
      endMs: Number(endSeconds) * 1000,
      speed: mode === "trim" ? 1 : speed,
    }),
    [endSeconds, mode, speed, startSeconds],
  );
  const validation = validateAudioTransform(draft, durationMs);
  const Icon = mode === "trim" ? Scissors : FastForward;
  const label = t(`nodeToolbar.audio.${mode}`);

  const validationMessage = validation.ok
    ? null
    : t(`nodeToolbar.audio.validation.${validation.reason}`);

  const resetDraft = () => {
    setStartSeconds("0");
    setEndSeconds(typeof durationMs === "number" ? formatSeconds(durationMs) : "");
    setSpeed(1);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) resetDraft();
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            className={`${buttonClassName} inline-flex items-center gap-2 ${
              disabled ? "cursor-not-allowed opacity-50" : ""
            }`}
            title={disabled ? disabledReason : label}
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Icon className="h-3.5 w-3.5" />
        )}
        {label}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="z-[130] w-[320px] rounded-[16px] border border-white/10 bg-[#13141b] p-3 text-[#e8eaf0] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold">{label}</div>
        <div className="mt-1 text-xs text-[#6f7079]">
          {t("nodeToolbar.audio.derivedHint")}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="text-xs text-[#8696a0]">
            {t("nodeToolbar.audio.startTime")}
            <input
              type="number"
              min={0}
              max={typeof durationMs === "number" ? durationMs / 1000 : undefined}
              step={0.01}
              value={startSeconds}
              onChange={(event) => setStartSeconds(event.target.value)}
              className="mt-1 h-9 w-full rounded-[12px] border border-[#22232c] bg-[#0d0e14] px-3 text-sm text-[#e8eaf0] outline-none focus:border-[#5ba0ff]"
            />
          </label>
          <label className="text-xs text-[#8696a0]">
            {t("nodeToolbar.audio.endTime")}
            <input
              type="number"
              min={0}
              max={typeof durationMs === "number" ? durationMs / 1000 : undefined}
              step={0.01}
              value={endSeconds}
              onChange={(event) => setEndSeconds(event.target.value)}
              className="mt-1 h-9 w-full rounded-[12px] border border-[#22232c] bg-[#0d0e14] px-3 text-sm text-[#e8eaf0] outline-none focus:border-[#5ba0ff]"
            />
          </label>
        </div>

        {mode === "speed" ? (
          <div className="mt-3">
            <div className="text-xs text-[#8696a0]">
              {t("nodeToolbar.audio.speedValue")}
            </div>
            <div className="mt-1.5 grid grid-cols-6 gap-1">
              {SPEED_PRESETS.map((preset) => (
                <button
                  type="button"
                  key={preset}
                  className={`h-8 rounded-[12px] text-xs transition-colors ${
                    speed === preset
                      ? "bg-[#23334d] text-[#5ba0ff]"
                      : "bg-[#0d0e14] text-[#8696a0] hover:bg-[#182229]"
                  }`}
                  onClick={() => setSpeed(preset)}
                >
                  {preset}×
                </button>
              ))}
            </div>
            <input
              type="range"
              min={AUDIO_TRANSFORM_MIN_SPEED}
              max={AUDIO_TRANSFORM_MAX_SPEED}
              step={0.05}
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
              className="mt-2 w-full accent-[#5ba0ff]"
              aria-label={t("nodeToolbar.audio.speedValue")}
            />
          </div>
        ) : null}

        <div className="mt-2 min-h-4 text-xs text-[#efa831]">
          {validationMessage}
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            className="h-9 rounded-[14px] bg-[#182229] px-4 text-sm text-[#8696a0] hover:text-[#e9edef]"
            onClick={() => setOpen(false)}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={!validation.ok || busy}
            className="h-9 rounded-[14px] bg-[#00bdcf] px-4 text-sm font-semibold text-[#111b21] disabled:cursor-not-allowed disabled:opacity-45"
            onClick={() => {
              if (!validation.ok) return;
              setOpen(false);
              void onSubmit(validation.value);
            }}
          >
            {t("nodeToolbar.audio.createDerived")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
