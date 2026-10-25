// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 这三件套（contextMatching / contextPromptCompiler / contextOperations）目前没有任何
// 界面引用，reason / label 也直接拼进 contextPromptCompiler 那份锁中文的提示词。
// 等它真被挂到某个面板上时，这些串要一起入词条；在那之前整份免检。
// i18n-exempt-start
import { useTranslation } from "react-i18next";
import type { ContextMatch } from "./contextMatching";
import {
  matchForBeatToSketch,
  matchForDirectorCombinedToSketch,
  matchForFrameGeneration,
  matchForSelectedBackgroundToSketch,
} from "./contextMatching";
import {
  compileBeatToSketchPrompt,
  compileDirectorCombinedToSketchPrompt,
  compileFrameGenerationContextPrompt,
  compileSelectedBackgroundToSketchPrompt,
} from "./contextPromptCompiler";
import type { MainlineContext } from "./mainlineContext";

export interface ContextOperation {
  id: string;
  label: string;
  outputKind: "sketch" | "frame" | "video" | "audio";
  match: (contexts: MainlineContext[]) => ContextMatch;
  compilePrompt: (match: ContextMatch) => string;
}

export interface MatchedContextOperation {
  operation: ContextOperation;
  match: ContextMatch;
}

export function contextOperations(t: ReturnType<typeof useTranslation>["t"]): ContextOperation[] {
  return [
    {
      id: "beat_to_sketch",
      label: t("freezone.context.operation.beatSketch.label"),
      outputKind: "sketch",
      match: matchForBeatToSketch,
      compilePrompt: compileBeatToSketchPrompt,
    },
    {
      id: "director_combined_to_sketch",
      label: t("freezone.context.operation.directorCompositeSketch.label"),
      outputKind: "sketch",
      match: matchForDirectorCombinedToSketch,
      compilePrompt: compileDirectorCombinedToSketchPrompt,
    },
    {
      id: "selected_background_to_sketch",
      label: t("freezone.context.operation.backgroundAnchorSketch.label"),
      outputKind: "sketch",
      match: matchForSelectedBackgroundToSketch,
      compilePrompt: compileSelectedBackgroundToSketchPrompt,
    },
    {
      id: "sketch_to_frame",
      label: t("freezone.context.operation.generateStoryboardFromMainline.label"),
      outputKind: "frame",
      match: matchForFrameGeneration,
      compilePrompt: compileFrameGenerationContextPrompt,
    },
  ];
}

export function resolveMatchedContextOperations(
  contexts: MainlineContext[],
  t: ReturnType<typeof useTranslation>["t"],
): MatchedContextOperation[] {
  return contextOperations(t)
    .map((operation) => ({
      operation,
      match: operation.match(contexts),
    }))
    .filter((item) => item.match.matched);
}

export function ContextOperationsPanel({
  operations,
  onRun,
}: {
  operations: MatchedContextOperation[];
  onRun: (item: MatchedContextOperation) => void;
}) {
  const { t } = useTranslation();
  if (operations.length === 0) return null;

  return (
    <div className="mb-2 rounded-xl border border-amber-300/25 bg-amber-300/10 p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium text-amber-100">{t("freezone.context.mainlineContext")}</div>
        <div className="text-[10px] text-amber-100/65">{t("freezone.context.mainlineContextHint")}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        {operations.map((item) => (
          <button
            key={item.operation.id}
            type="button"
            className="nodrag min-w-[180px] max-w-full rounded-lg border border-amber-200/35 bg-black/20 px-3 py-2 text-left transition hover:bg-amber-200/15"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onRun(item);
            }}
            title={item.match.reason}
          >
            <div className="text-xs font-medium text-amber-50">{item.operation.label}</div>
            <div className="mt-0.5 truncate text-[10px] text-amber-100/75">
              {item.match.reason}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
// i18n-exempt-end
