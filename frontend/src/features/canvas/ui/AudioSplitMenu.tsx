// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo, useState } from "react";
import { Loader2, Scissors, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  buildCustomAudioSegments,
  type AudioSplitAnalysis,
  type AudioSplitSegment,
} from "@/features/canvas/application/audioSplit";

export interface SmartAudioSplitOptions {
  silenceThresholdDb: number;
  minSilenceSec: number;
  minSegmentSec: number;
}

interface AudioSplitMenuProps {
  mode: "smart" | "custom";
  durationMs: number | null | undefined;
  disabled: boolean;
  disabledReason?: string;
  buttonClassName: string;
  onAnalyze: (options: SmartAudioSplitOptions) => Promise<AudioSplitAnalysis>;
  onSubmit: (segments: AudioSplitSegment[]) => Promise<void> | void;
}

function formatTime(milliseconds: number): string {
  const totalSeconds = milliseconds / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${(totalSeconds - minutes * 60).toFixed(2).padStart(5, "0")}`;
}

export function AudioSplitMenu({
  mode,
  durationMs,
  disabled,
  disabledReason,
  buttonClassName,
  onAnalyze,
  onSubmit,
}: AudioSplitMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [cutPoints, setCutPoints] = useState("");
  const [silenceThresholdDb, setSilenceThresholdDb] = useState(-35);
  const [minSilenceSec, setMinSilenceSec] = useState(0.45);
  const [minSegmentSec, setMinSegmentSec] = useState(0.75);
  const [analysis, setAnalysis] = useState<AudioSplitAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisFailed, setAnalysisFailed] = useState(false);

  const customValidation = useMemo(
    () => buildCustomAudioSegments(cutPoints, durationMs),
    [cutPoints, durationMs],
  );
  const segments =
    mode === "smart"
      ? analysis?.segments ?? []
      : customValidation.ok
        ? customValidation.segments
        : [];
  const canCreate = segments.length > 1 && !analyzing;
  const smartOptionsValid =
    Number.isFinite(silenceThresholdDb) &&
    silenceThresholdDb >= -80 &&
    silenceThresholdDb <= -10 &&
    Number.isFinite(minSilenceSec) &&
    minSilenceSec >= 0.1 &&
    minSilenceSec <= 10 &&
    Number.isFinite(minSegmentSec) &&
    minSegmentSec >= 0.1 &&
    minSegmentSec <= 60;
  const label = t(`nodeToolbar.audio.${mode}Split`);
  const Icon = mode === "smart" ? Sparkles : Scissors;

  const reset = () => {
    setCutPoints("");
    setSilenceThresholdDb(-35);
    setMinSilenceSec(0.45);
    setMinSegmentSec(0.75);
    setAnalysis(null);
    setAnalyzing(false);
    setAnalysisFailed(false);
  };

  const analyze = async () => {
    setAnalyzing(true);
    setAnalysisFailed(false);
    setAnalysis(null);
    try {
      setAnalysis(
        await onAnalyze({ silenceThresholdDb, minSilenceSec, minSegmentSec }),
      );
    } catch (error) {
      console.error("[audio-split] preview failed", error);
      setAnalysisFailed(true);
    } finally {
      setAnalyzing(false);
    }
  };

  const customError =
    mode === "custom" && !customValidation.ok && cutPoints.trim()
      ? t(`nodeToolbar.audio.splitValidation.${customValidation.reason}`)
      : null;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) reset();
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
        <Icon className="h-3.5 w-3.5" />
        {label}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="z-[130] w-[360px] rounded-[16px] border border-white/10 bg-[#13141b] p-3 text-[#e8eaf0] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold">{label}</div>
        <div className="mt-1 text-xs text-[#6f7079]">
          {t("nodeToolbar.audio.splitDerivedHint")}
        </div>

        {mode === "smart" ? (
          <div className="mt-3">
            <div className="grid grid-cols-3 gap-2">
              <label className="text-xs text-[#8696a0]">
                {t("nodeToolbar.audio.silenceThreshold")}
                <input
                  type="number"
                  min={-80}
                  max={-10}
                  step={1}
                  value={silenceThresholdDb}
                  onChange={(event) => setSilenceThresholdDb(Number(event.target.value))}
                  className="mt-1 h-9 w-full rounded-[12px] border border-[#22232c] bg-[#0d0e14] px-2 text-sm text-[#e8eaf0] outline-none focus:border-[#5ba0ff]"
                />
              </label>
              <label className="text-xs text-[#8696a0]">
                {t("nodeToolbar.audio.minSilence")}
                <input
                  type="number"
                  min={0.1}
                  max={10}
                  step={0.05}
                  value={minSilenceSec}
                  onChange={(event) => setMinSilenceSec(Number(event.target.value))}
                  className="mt-1 h-9 w-full rounded-[12px] border border-[#22232c] bg-[#0d0e14] px-2 text-sm text-[#e8eaf0] outline-none focus:border-[#5ba0ff]"
                />
              </label>
              <label className="text-xs text-[#8696a0]">
                {t("nodeToolbar.audio.minSegment")}
                <input
                  type="number"
                  min={0.1}
                  max={60}
                  step={0.05}
                  value={minSegmentSec}
                  onChange={(event) => setMinSegmentSec(Number(event.target.value))}
                  className="mt-1 h-9 w-full rounded-[12px] border border-[#22232c] bg-[#0d0e14] px-2 text-sm text-[#e8eaf0] outline-none focus:border-[#5ba0ff]"
                />
              </label>
            </div>
            <button
              type="button"
              disabled={analyzing || !smartOptionsValid}
              className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-[14px] bg-[#182229] text-sm text-[#c7d0d6] hover:text-white disabled:opacity-45"
              onClick={() => void analyze()}
            >
              {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {t("nodeToolbar.audio.analyzeSplit")}
            </button>
          </div>
        ) : (
          <label className="mt-3 block text-xs text-[#8696a0]">
            {t("nodeToolbar.audio.customCutPoints")}
            <textarea
              rows={2}
              value={cutPoints}
              placeholder={t("nodeToolbar.audio.customCutPointsPlaceholder")}
              onChange={(event) => setCutPoints(event.target.value)}
              className="mt-1 w-full resize-none rounded-[12px] border border-[#22232c] bg-[#0d0e14] px-3 py-2 text-sm text-[#e8eaf0] outline-none focus:border-[#5ba0ff]"
            />
          </label>
        )}

        <div className="mt-2 min-h-4 text-xs text-[#efa831]">
          {analysisFailed
            ? t("nodeToolbar.audio.analysisFailed")
            : customError ??
              (analysis?.limited ? t("nodeToolbar.audio.splitLimited") : null) ??
              (analysis && analysis.segments.length < 2
                ? t("nodeToolbar.audio.noSplitDetected")
                : null)}
        </div>

        {segments.length > 0 ? (
          <div className="mt-2 max-h-44 overflow-y-auto rounded-[12px] border border-white/5 bg-[#0d0e14] p-2">
            <div className="mb-1 text-xs text-[#8696a0]">
              {t("nodeToolbar.audio.segmentCount", { count: segments.length })}
            </div>
            {segments.map((segment, index) => (
              <div
                key={`${segment.startMs}-${segment.endMs}`}
                className="flex h-7 items-center justify-between border-t border-white/5 text-xs first:border-t-0"
              >
                <span className="text-[#6f7079]">#{index + 1}</span>
                <span className="tabular-nums text-[#c7d0d6]">
                  {formatTime(segment.startMs)} – {formatTime(segment.endMs)}
                </span>
                <span className="tabular-nums text-[#6f7079]">
                  {((segment.endMs - segment.startMs) / 1000).toFixed(2)}s
                </span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="h-9 rounded-[14px] bg-[#182229] px-4 text-sm text-[#8696a0] hover:text-[#e9edef]"
            onClick={() => setOpen(false)}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={!canCreate}
            className="h-9 rounded-[14px] bg-[#00bdcf] px-4 text-sm font-semibold text-[#111b21] disabled:cursor-not-allowed disabled:opacity-45"
            onClick={() => {
              if (!canCreate) return;
              setOpen(false);
              void onSubmit(segments);
            }}
          >
            {t("nodeToolbar.audio.createSegments", { count: segments.length })}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
