// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createLazyFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Play, Sparkles, Square } from "lucide-react";

import {
  isPlanEpisodeAssetsResult,
  useEpisodeBeats,
  useEpisodeDetail,
  usePlanEpisodeProps,
  usePlanEpisodeScenes,
  usePlanIdentities,
  useUpdateEpisode,
} from "@/lib/queries/episodes";
import { useCharacters } from "@/lib/queries/characters";
import { useProject } from "@/lib/queries/projects";
import { useGenerateRewrite, useGenerateScript } from "@/lib/queries/scripts";
import { useTaskController } from "@/hooks/use-task-controller";
import { queryKeys } from "@/lib/query-keys";
import {
  backendErrorToastMessage,
  BillingRuleNotConfiguredError,
} from "@/lib/api-errors";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { TASK_TYPES } from "@/lib/task-types";
import {
  getScriptReviewFeedback,
  type ScriptFeedback,
} from "@/lib/script-feedback";
import { IdentityPickerDialog } from "@/components/identity-picker-dialog";
import { CreditCostInline } from "@/components/credit-cost-inline";
import {
  EpisodeAssetPlanning,
  type AssetPlanningCategory,
} from "@/components/episode/episode-asset-planning";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EpisodeSourceEditor } from "@/components/episode/episode-source-editor";
import { EpisodeHealthSummary } from "@/components/episode/health-bar";
import { ScriptBeatPreview } from "@/components/episode/script-beat-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveScopes, trackSave } from "@/stores/save-status-store";
import type { Character } from "@/types/character";

const REWRITE_TARGET_BEATS_MIN = 5;
const REWRITE_TARGET_BEATS_MAX = 80;
const REWRITE_BEAT_CHARS_MIN_MIN = 4;
const REWRITE_BEAT_CHARS_MIN_MAX = 50;
const REWRITE_BEAT_CHARS_MAX_MIN = 4;
const REWRITE_BEAT_CHARS_MAX_MAX = 80;

// While typing, parse the raw value WITHOUT clamping to the min — clamping a
// half-typed value (e.g. "1" → min 4) would snap it back and make the next
// digit append instead of replace (typing 18 yielded 48). Min is enforced on
// blur via `clampRewriteNumber`.
function parseRewriteNumber(value: string, fallback: number) {
  if (value.trim() === "") return fallback;
  const next = Number(value);
  return Number.isFinite(next) ? Math.round(next) : fallback;
}

function clampRewriteNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function ScriptTabContent() {
  const { t } = useTranslation();
  const { project, episode } = Route.useParams();
  const epNum = parseInt(episode, 10);
  const queryClient = useQueryClient();
  const notifyScriptFeedback = (feedback: ScriptFeedback) => {
    const message = t(feedback.key, feedback.values);
    if (feedback.type === "warning") toast.warning(message);
    else toast.success(message);
  };

  const { data: episodeRes } = useEpisodeDetail(project, epNum);
  const { data: projectRes } = useProject(project);
  const { data: beatsRes, isLoading: beatsLoading } = useEpisodeBeats(
    project,
    epNum,
  );
  const { data: charactersRes } = useCharacters(project);
  const updateEpisode = useUpdateEpisode(project);
  const planIdentities = usePlanIdentities(project);
  const planIdentitiesCost = useGenerationCreditCost("feature", "identity_planner");
  const planIdentitiesCostDisplay =
    planIdentitiesCost.data?.data.display ??
    (planIdentitiesCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);
  const planScenes = usePlanEpisodeScenes(project);
  const planScenesCost = useGenerationCreditCost("feature", "episode_scene_planner");
  const planScenesCostDisplay =
    planScenesCost.data?.data.display ??
    (planScenesCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);
  const planProps = usePlanEpisodeProps(project);
  const planPropsCost = useGenerationCreditCost("feature", "episode_prop_planner");
  const planPropsCostDisplay =
    planPropsCost.data?.data.display ??
    (planPropsCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);
  const generateScript = useGenerateScript(project, epNum);
  const generateScriptCost = useGenerationCreditCost("feature", "script_writer");
  const generateScriptCostDisplay =
    generateScriptCost.data?.data.display ??
    (generateScriptCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);
  const generateRewrite = useGenerateRewrite(project, epNum);
  const scriptTask = useTaskController({
    key: { taskType: TASK_TYPES.SCRIPT_WRITER, project, episode: epNum },
    alsoReconcile: [TASK_TYPES.LITERAL_SCRIPT_WRITER],
    invalidateKeys: [
      queryKeys.script(project, epNum),
      queryKeys.beats(project, epNum),
      queryKeys.pipelineStatus(project),
    ],
    showCompleteToast: false,
    onComplete: (result) =>
      notifyScriptFeedback(getScriptReviewFeedback(result)),
  });

  const episodeData = episodeRes?.data;
  const characters: Character[] = charactersRes?.data ?? [];
  const identityIds = episodeData?.identity_ids ?? [];
  const identityDefaultMap = episodeData?.identity_default_map ?? {};
  const rawContent = episodeData?.raw_content ?? "";
  const sourceText = episodeData?.beat_source_text ?? "";
  const sourceTextForEditor = sourceText || rawContent;
  const sceneMenu = episodeData?.scene_menu ?? [];
  const propMenu = episodeData?.prop_menu ?? [];
  const beats = beatsRes?.data ?? [];
  const isNarratedProject = projectRes?.data?.spine_template === "narrated";

  const [pickerOpen, setPickerOpen] = useState(false);
  const [assetCategory, setAssetCategory] =
    useState<AssetPlanningCategory>("identities");
  const [rewriteTargetBeats, setRewriteTargetBeats] = useState(18);
  const [rewriteBeatCharsMin, setRewriteBeatCharsMin] = useState(14);
  const [rewriteBeatCharsMax, setRewriteBeatCharsMax] = useState(20);
  const initializedSourceRef = useRef("");

  const sourceScope = saveScopes.episodeSource(project, epNum);
  const identitiesScope = saveScopes.episodeIdentities(project, epNum);

  useEffect(() => {
    const initKey = `${project}:${epNum}`;
    if (!episodeData || initializedSourceRef.current === initKey) return;
    if (sourceText.trim() || !rawContent.trim()) return;

    initializedSourceRef.current = initKey;
    void trackSave(sourceScope, () =>
      updateEpisode.mutateAsync({
        episodeNum: epNum,
        data: { beat_source_text: rawContent },
      }),
    )
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: queryKeys.episodeDetail(project, epNum),
        }),
      )
      .catch(() => {
        initializedSourceRef.current = "";
        toast.error(t("common.error"));
      });
  }, [
    episodeData,
    epNum,
    project,
    queryClient,
    rawContent,
    sourceScope,
    sourceText,
    t,
    updateEpisode,
  ]);

  const invalidateIdentityData = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.episodes(project) });
    queryClient.invalidateQueries({
      queryKey: queryKeys.episodeDetail(project, epNum),
    });
    queryClient.invalidateQueries({ queryKey: queryKeys.characters(project) });
    queryClient.invalidateQueries({ queryKey: queryKeys.pipelineStatus(project) });
    for (const character of characters) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.identities(project, character.name),
      });
    }
  };

  const notifyIdentityPlanResult = (result: unknown) => {
    const data = (result ?? {}) as {
      new_count?: number;
      resolved_count?: number;
    };
    if ((data.new_count ?? 0) > 0) {
      toast.success(
        t("episode.script.planIdentitiesNew", { count: data.new_count }),
      );
    } else if ((data.resolved_count ?? 0) > 0) {
      toast.success(
        t("episode.script.planIdentitiesResolved", {
          count: data.resolved_count,
        }),
      );
    } else {
      toast.warning(t("episode.script.planIdentitiesNone"));
    }
  };

  const identityTask = useTaskController({
    key: { taskType: TASK_TYPES.IDENTITY_PLANNER, project, episode: epNum },
    invalidateKeys: [
      queryKeys.episodes(project),
      queryKeys.episodeDetail(project, epNum),
      queryKeys.characters(project),
      queryKeys.pipelineStatus(project),
    ],
    showCompleteToast: false,
    onComplete: (result) => {
      invalidateIdentityData();
      notifyIdentityPlanResult(result);
    },
  });

  const saveField = async (
    data: Parameters<typeof updateEpisode.mutateAsync>[0]["data"],
  ) => {
    try {
      await trackSave(identitiesScope, () =>
        updateEpisode.mutateAsync({ episodeNum: epNum, data }),
      );
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleIdentityChange = (
    next: string[],
    nextDefaultMap: Record<string, string>,
  ) => {
    void saveField({
      identity_ids: next,
      identity_default_map: nextDefaultMap,
    });
  };

  const handleSourceSave = async (next: string) => {
    const savePromise = trackSave(sourceScope, () =>
      updateEpisode.mutateAsync({
        episodeNum: epNum,
        data: { beat_source_text: next },
      }),
    );
    try {
      await toast
        .promise(savePromise, {
          loading: t("common.saveStatus.saving"),
          success: t("common.saveStatus.saved"),
          error: t("common.saveStatus.error"),
        })
        .unwrap();
    } catch {
      // toast.promise already renders the failure state.
    }
  };

  const ensureBeatSourceText = async () => {
    if (sourceText.trim()) return sourceText;

    const fallback = rawContent.trim();
    if (!fallback) {
      toast.error(t("episode.script.noRawText"));
      return "";
    }

    await trackSave(sourceScope, () =>
      updateEpisode.mutateAsync({
        episodeNum: epNum,
        data: { beat_source_text: rawContent },
      }),
    );
    await queryClient.invalidateQueries({
      queryKey: queryKeys.episodeDetail(project, epNum),
    });
    return rawContent;
  };

  const handleGenerateRewrite = async () => {
    if (rewriteBeatCharsMin > rewriteBeatCharsMax) {
      toast.error(t("episode.script.minGtMax"));
      return;
    }

    try {
      const rewriteRes = await generateRewrite.mutateAsync({
        target_beats: rewriteTargetBeats,
        beat_chars_min: rewriteBeatCharsMin,
        beat_chars_max: rewriteBeatCharsMax,
      });
      if (rewriteRes.ok === false) {
        toast.error(rewriteRes.error || t("common.error"));
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.episodeDetail(project, epNum),
      });
      toast.success(t("episode.script.rewriteComplete"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleGenerateScript = async () => {
    try {
      const readySource = await ensureBeatSourceText();
      if (!readySource.trim()) {
        return;
      }
      if (identityIds.length === 0) {
        toast.error(t("episode.script.identityRequired"));
        return;
      }
      const res = await generateScript.mutateAsync({});
      if (res.ok === false) {
        toast.error(backendErrorToastMessage(res.error, t));
        return;
      }
      scriptTask.start({ scope: res.scope });
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handlePlanIdentities = async () => {
    try {
      const res = await planIdentities.mutateAsync(epNum);
      if (res.ok === false) {
        toast.error(backendErrorToastMessage(res.error, t));
        return;
      }
      identityTask.start({ scope: res.scope });
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handlePlanScenes = async () => {
    try {
      const res = await planScenes.mutateAsync(epNum);
      if (res.ok === false) {
        toast.error(backendErrorToastMessage(res.error, t));
        return;
      }
      toast.success(
        isPlanEpisodeAssetsResult(res)
          ? t("episode.script.scenePlanComplete", {
              count: res.data.total_count,
            })
          : res.message,
      );
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handlePlanProps = async () => {
    try {
      const res = await planProps.mutateAsync(epNum);
      if (res.ok === false) {
        toast.error(backendErrorToastMessage(res.error, t));
        return;
      }
      toast.success(
        isPlanEpisodeAssetsResult(res)
          ? t("episode.script.propPlanComplete", {
              count: res.data.total_count,
            })
          : res.message,
      );
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const identitiesEmpty = identityIds.length === 0;
  const identityPlanning = planIdentities.isPending || identityTask.started;
  const generating = generateScript.isPending || scriptTask.started;
  const rawScriptProgressPercent = Math.round(
    (scriptTask.stream.progress ?? 0) * 100,
  );
  const scriptProgressPercent = Math.min(
    100,
    Math.max(0, rawScriptProgressPercent),
  );
  const scriptProgressLabel =
    scriptTask.stream.currentTask || t("common.preparing");
  const generateButtonBusy = generateScript.isPending || generateRewrite.isPending;
  const handleGenerateButtonClick = () => {
    if (scriptTask.started) {
      void scriptTask.stop();
      return;
    }
    void handleGenerateScript();
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border/30 px-5 py-3 text-xs">
        <EpisodeHealthSummary
          project={project}
          episode={epNum}
          className="pr-1"
        />
        <div className="inline-flex h-7 items-center gap-2 text-muted-foreground">
          <span className="text-[11px]">{t("episode.script.modeLabel")}</span>
          <span className="text-[11px] text-foreground/68">
            {t("episode.script.modeLiteral").replace(/^模式[：:]\s*/, "")}
          </span>
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {isNarratedProject && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex h-7 items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="shrink-0 whitespace-nowrap">
                    {t("episode.script.rewriteTargetBeats")}
                  </span>
                  <Input
                    type="number"
                    min={REWRITE_TARGET_BEATS_MIN}
                    max={REWRITE_TARGET_BEATS_MAX}
                    step={1}
                    value={rewriteTargetBeats}
                    disabled={generating || generateRewrite.isPending}
                    onChange={(event) =>
                      setRewriteTargetBeats(
                        parseRewriteNumber(event.target.value, rewriteTargetBeats),
                      )
                    }
                    onBlur={() =>
                      setRewriteTargetBeats((value) =>
                        clampRewriteNumber(
                          value,
                          REWRITE_TARGET_BEATS_MIN,
                          REWRITE_TARGET_BEATS_MAX,
                        ),
                      )
                    }
                    className="h-7 w-14 rounded-[7px] px-2 text-xs tabular-nums"
                  />
                </label>
                <label className="flex h-7 items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="shrink-0 whitespace-nowrap">
                    {t("episode.script.rewriteBeatCharsMin")}
                  </span>
                  <Input
                    type="number"
                    min={REWRITE_BEAT_CHARS_MIN_MIN}
                    max={REWRITE_BEAT_CHARS_MIN_MAX}
                    step={1}
                    value={rewriteBeatCharsMin}
                    disabled={generating || generateRewrite.isPending}
                    onChange={(event) =>
                      setRewriteBeatCharsMin(
                        parseRewriteNumber(event.target.value, rewriteBeatCharsMin),
                      )
                    }
                    onBlur={() =>
                      setRewriteBeatCharsMin((value) =>
                        clampRewriteNumber(
                          value,
                          REWRITE_BEAT_CHARS_MIN_MIN,
                          REWRITE_BEAT_CHARS_MIN_MAX,
                        ),
                      )
                    }
                    className="h-7 w-14 rounded-[7px] px-2 text-xs tabular-nums"
                  />
                </label>
                <label className="flex h-7 items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="shrink-0 whitespace-nowrap">
                    {t("episode.script.rewriteBeatCharsMax")}
                  </span>
                  <Input
                    type="number"
                    min={REWRITE_BEAT_CHARS_MAX_MIN}
                    max={REWRITE_BEAT_CHARS_MAX_MAX}
                    step={1}
                    value={rewriteBeatCharsMax}
                    disabled={generating || generateRewrite.isPending}
                    onChange={(event) =>
                      setRewriteBeatCharsMax(
                        parseRewriteNumber(event.target.value, rewriteBeatCharsMax),
                      )
                    }
                    onBlur={() =>
                      setRewriteBeatCharsMax((value) =>
                        clampRewriteNumber(
                          value,
                          REWRITE_BEAT_CHARS_MAX_MIN,
                          REWRITE_BEAT_CHARS_MAX_MAX,
                        ),
                      )
                    }
                    className="h-7 w-14 rounded-[7px] px-2 text-xs tabular-nums"
                  />
                </label>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleGenerateRewrite}
                disabled={generating || generateRewrite.isPending}
                className="h-7 gap-1.5 rounded-[7px] border-primary/35 bg-primary/[0.08] px-2.5 text-xs font-normal text-primary shadow-none hover:border-primary/55 hover:bg-primary/[0.14] hover:text-primary [&_svg]:size-3.5"
              >
                {generateRewrite.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                {t("episode.script.generateRewrite")}
              </Button>
            </>
          )}
          {scriptTask.started && (
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="flex min-w-[260px] max-w-[380px] items-center gap-2 rounded-[7px] border border-cyan-400/15 bg-cyan-400/[0.06] px-2.5 py-1.5 text-xs text-muted-foreground"
            >
              <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-white/[0.08]">
                <div
                  className="h-full rounded-full bg-cyan-400 transition-[width]"
                  style={{ width: `${scriptProgressPercent}%` }}
                />
              </div>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-cyan-100">
                {scriptProgressPercent}%
              </span>
              <span className="min-w-0 truncate text-foreground/80">
                {scriptProgressLabel}
              </span>
            </div>
          )}
          <Button
            size="sm"
            onClick={handleGenerateButtonClick}
            disabled={
              scriptTask.started
                ? scriptTask.stopping
                : generateButtonBusy
            }
            title={
              !scriptTask.started && identitiesEmpty
                ? t("episode.script.identityRequired")
                : undefined
            }
            className="h-7 gap-1.5 rounded-[7px] bg-primary px-2.5 text-xs font-normal text-primary-foreground shadow-none hover:bg-primary/85 active:bg-primary/75 [&_svg]:size-3.5"
          >
            {scriptTask.started ? (
              scriptTask.stopping ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Square className="size-3.5" />
              )
            ) : generateButtonBusy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            {scriptTask.started ? (
              t("common.stop")
            ) : (
              t("episode.script.generateScript")
            )}
            {!scriptTask.started && (
              <CreditCostInline
                display={generateScriptCostDisplay}
                className="text-black"
                iconClassName="text-black drop-shadow-none [&_path]:fill-current"
              />
            )}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid min-h-0 gap-5 px-5 pb-5 pt-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-5">
            <section>
              <div className="mb-2 flex h-7 items-center justify-between gap-3">
                <h2 className="text-sm font-semibold tracking-tight text-foreground">
                  {t("episode.script.assetPlanningTitle")}
                </h2>
                <Select
                  value={assetCategory}
                  onValueChange={(value) =>
                    setAssetCategory(value as AssetPlanningCategory)
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="inline-flex !h-6 w-[112px] shrink-0 items-center gap-1 !rounded-[6px] !border !border-white/[0.12] !bg-white/[0.04] px-2 text-[11px] font-normal text-foreground/78 shadow-none hover:!border-white/[0.2] hover:!bg-white/[0.05] hover:text-foreground focus-visible:!border-white/24 focus-visible:!ring-0 [&_svg]:!size-3"
                  >
                    {/* base-ui Select.Value renders the raw value by default — map
                        it to the localized label so the trigger shows 中文. */}
                    <SelectValue>
                      {(value) =>
                        value === "scenes"
                          ? t("episode.script.scenes")
                          : value === "props"
                            ? t("episode.script.props")
                            : t("episode.script.identities")
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectItem value="identities">
                      {t("episode.script.identities")}
                    </SelectItem>
                    <SelectItem value="scenes">
                      {t("episode.script.scenes")}
                    </SelectItem>
                    <SelectItem value="props">
                      {t("episode.script.props")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <EpisodeAssetPlanning
                project={project}
                selectedCategory={assetCategory}
                characters={characters}
                selectedIdentityIds={identityIds}
                identityDefaultMap={identityDefaultMap}
                sceneMenu={sceneMenu}
                propMenu={propMenu}
                identityPending={identityPlanning}
                scenePending={planScenes.isPending}
                propPending={planProps.isPending}
                sceneCostDisplay={planScenesCostDisplay}
                propCostDisplay={planPropsCostDisplay}
                onPlanIdentities={() => setPickerOpen(true)}
                onIdentityChange={handleIdentityChange}
                onPlanScenes={handlePlanScenes}
                onPlanProps={handlePlanProps}
                labels={{
                  identities: t("episode.script.identities"),
                  scenes: t("episode.script.scenes"),
                  props: t("episode.script.props"),
                  noIdentities: t("episode.script.noIdentities"),
                  noScenes: t("episode.script.noScenes"),
                  noProps: t("episode.script.noProps"),
                  planIdentities: t("episode.script.planIdentities"),
                  replanIdentities: t("episode.script.replanIdentities"),
                  defaultIdentity: t("identityPicker.defaultIdentity"),
                  planScenes: t("episode.script.planScenes"),
                  replanScenes: t("episode.script.replanScenes"),
                  planProps: t("episode.script.planProps"),
                  replanProps: t("episode.script.replanProps"),
                  propInGlobal: t("episode.script.propInGlobal"),
                  propCheckingGlobal: t("episode.script.propCheckingGlobal"),
                  promoteProp: t("episode.script.promoteProp"),
                  promotePropTitle: (name) =>
                    t("episode.script.promotePropTitle", { name }),
                  promotePropName: t("episode.script.promotePropName"),
                  promotePropType: t("episode.script.promotePropType"),
                  promoteVisualPrompt: t("episode.script.promoteVisualPrompt"),
                  promoteOwner: t("episode.script.promoteOwner"),
                  promoteSubmit: t("episode.script.promoteSubmit"),
                  promoteCancel: t("common.cancel"),
                  propTypeLabel: (value) =>
                    t(`assets.props.types.${value}`, { defaultValue: value }),
                  promoteSuccess: t("episode.script.promoteSuccess"),
                }}
              />
            </section>

            <EpisodeSourceEditor
              rawContent={rawContent}
              sourceText={sourceTextForEditor}
              saving={updateEpisode.isPending}
              onSave={handleSourceSave}
              labels={{
                rawLabel: t("episode.script.rawLabel"),
                rawActionLabel: t("episode.script.rawActionLabel"),
                noRawText: t("episode.script.noRawText"),
                sourceLabel: t(
                  isNarratedProject
                    ? "episode.script.sourceTextLabelNarrated"
                    : "episode.script.sourceTextLabelDrama",
                ),
                sourceMeta: (count) =>
                  t("episode.script.sourceTextMeta", { count }),
                sourcePlaceholder: t(
                  isNarratedProject
                    ? "episode.script.sourceTextPlaceholderNarrated"
                    : "episode.script.sourceTextPlaceholderDrama",
                ),
                linePreviewLabel: t("episode.script.linePreviewLabel"),
                lineCount: (count) => t("episode.script.lineCount", { count }),
                noLines: t("episode.script.noSourceLines"),
              }}
              className="min-w-0"
            />
          </div>

          <div className="min-w-0">
            <ScriptBeatPreview
              beats={beats}
              loading={beatsLoading}
              className="px-0 pb-0"
              labels={{
                title: t("episode.script.previewTitle"),
                count: (count) => t("episode.script.previewCount", { count }),
                loading: t("episode.script.previewLoading"),
                emptyTitle: t("episode.script.previewEmptyTitle"),
                empty: t("episode.script.previewEmpty"),
                audioType: (type) =>
                  t(`audioType.${type}`, { defaultValue: type }),
                speaker: t("episode.script.previewSpeaker"),
                noSpeaker: t("episode.script.previewNoSpeaker"),
                dialogueLine: t("episode.script.previewDialogueLine"),
                narrationLine: t("episode.script.previewNarrationLine"),
                noNarration: t("episode.script.previewNoNarration"),
                visualDescription: t("episode.script.previewVisualDescription"),
                noVisualDescription: t("episode.script.previewNoVisualDescription"),
              }}
            />
          </div>
        </div>
      </div>

      <IdentityPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        project={project}
        characters={characters}
        selected={identityIds}
        defaultMap={identityDefaultMap}
        onChange={handleIdentityChange}
        onPlan={handlePlanIdentities}
        planPending={identityPlanning}
        planCostDisplay={planIdentitiesCostDisplay}
      />
    </div>
  );
}

export const Route = createLazyFileRoute(
  "/_app/projects/$project/episodes/$episode/script",
)({
  component: ScriptTabContent,
});
