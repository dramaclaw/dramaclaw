// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Map, Plus, RefreshCw, Sparkles } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { AssetHeaderActions } from "@/components/assets/asset-header-actions-slot";
import { SceneAssetCard } from "@/components/assets/scene-asset-card";
import { AssetBeatReferences } from "@/components/assets/asset-beat-references";
import {
  SceneEnvironmentPromptFields,
  parseEnvironmentPrompt,
  serializeEnvironmentPrompt,
  type SceneEnvironmentSections,
} from "@/components/assets/scene-environment-prompt";
import { PanoCaptureDialog } from "@/features/viewer-kit/pano/PanoCaptureDialog";
import type { PanoCaptureResult } from "@/features/viewer-kit/pano/panoManifest";
import { ThreeDDirectorDialog } from "@/features/viewer-kit/three-d/ThreeDDirectorDialog";
import type { ThreeDSceneSnapshot } from "@/features/viewer-kit/three-d/engine/viewerApp";
import {
  AssetSearchBox,
  AssetSortSelect,
  filterBySearch,
  sortAssets,
  type AssetSortKey,
} from "@/components/assets/asset-search-box";
import {
  useAssetReferenceIndex,
  type BeatReference,
  type SceneCoOccurrence,
} from "@/lib/queries/asset-references";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { useAssetFocus } from "@/hooks/use-asset-focus";
import { useNavigateToAsset } from "@/hooks/use-assets-deep-link";
import {
  backendErrorToastMessage,
  BillingRuleNotConfiguredError,
} from "@/lib/api-errors";
import { CreditCostInline } from "@/components/credit-cost-inline";
import { Button } from "@/components/ui/button";
import { EMPTY_STATE_ACTION_BUTTON_CLASS } from "@/components/ui/empty-state-styles";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useTaskController } from "@/hooks/use-task-controller";
import { openPresetProjectionInMyCanvas } from "@/features/freezone/openPresetProjection";
import { sceneTypeLabel, sceneTypeOptions } from "@/lib/scene-type";
import { timeOfDayLabel, timeOfDayOptions } from "@/lib/time-of-day";
import { resolveMediaUrl } from "@/lib/media-url";
import {
  useBuildScenes,
  useCreateScene,
  useDeleteScene,
  useDeleteSceneCustomPackage,
  useDeleteSceneMaster,
  useDeleteScenePano,
  useGenerateScene3gsPlyAsync,
  useGenerateSceneMasterAsync,
  useGenerateScenePanoAsync,
  useGenerateSceneReverseAsync,
  useClearSceneDirectorWorld,
  useSaveSceneDirectorWorld,
  useSceneDirectorStageManifest,
  useScenePanoManifest,
  useScenes,
  useUpdateScene,
  useUploadSceneCustomPackage,
  useUploadSceneMaster,
  useUploadScenePano,
  type ScenePayload,
} from "@/lib/queries/scenes";
import { queryKeys } from "@/lib/query-keys";
import type { ErrorResponse } from "@/types/api";
import type {
  SceneAsset,
  ScenePanoSource,
  SceneStagePlySource,
} from "@/types/scene";

const SCENE_FORM_DEFAULT: ScenePayload = {
  name: "",
  scene_type: "interior",
  base_scene_id: "",
  variant_id: "",
  time_of_day: "",
  environment_prompt: "",
  variant_prompt: "",
  description: "",
};

function trimScenePart(value: string | null | undefined): string {
  return String(value || "").trim();
}

function composeScenePlateName(
  payload: Pick<
    ScenePayload,
    "base_scene_id" | "variant_id" | "time_of_day"
  >,
): string {
  const parts = [
    trimScenePart(payload.base_scene_id),
    trimScenePart(payload.variant_id),
    trimScenePart(payload.time_of_day),
  ].filter(Boolean);
  return parts.join("_");
}

function isScenePlatePayload(
  payload: Partial<ScenePayload> | SceneAsset | null | undefined,
): boolean {
  if (!payload) return false;
  return Boolean(
    trimScenePart(payload.base_scene_id) ||
      trimScenePart((payload as SceneAsset).derived_from_scene) ||
      trimScenePart(payload.variant_id) ||
      trimScenePart(payload.time_of_day),
  );
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { ok?: unknown }).ok === false,
  );
}

async function openSceneFreezoneCanvas(project: string, sceneName: string) {
  await openPresetProjectionInMyCanvas(project, {
    scope: "asset",
    asset_kind: "scene",
    asset_id: sceneName,
  });
}

function SceneDialog({
  open,
  initial,
  draftSeed,
  project,
  references,
  coOccurrence,
  onOpenChange,
  onSubmit,
  saving,
}: {
  open: boolean;
  initial: SceneAsset | null;
  draftSeed?: Partial<ScenePayload> | null;
  project: string;
  references: BeatReference[];
  coOccurrence: SceneCoOccurrence;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: ScenePayload) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const navigateToAsset = useNavigateToAsset(project);
  const [draft, setDraft] = useState<ScenePayload>(SCENE_FORM_DEFAULT);
  // `environment_prompt` is one backend string in a fixed 7-heading template; we
  // edit it as seven fields and re-serialize on save. See scene-environment-prompt.
  const [envSections, setEnvSections] = useState<SceneEnvironmentSections>(() =>
    parseEnvironmentPrompt(""),
  );

  useEffect(() => {
    const nextDraft = initial
      ? {
          name: initial.name,
          aliases: initial.aliases ?? [],
          scene_type: initial.scene_type ?? "interior",
          base_scene_id: initial.base_scene_id ?? initial.derived_from_scene ?? "",
          variant_id: initial.variant_id ?? "",
          time_of_day: initial.time_of_day ?? "",
          environment_prompt: initial.environment_prompt ?? "",
          variant_prompt: initial.variant_prompt ?? "",
          description: initial.description ?? "",
          notes: initial.notes ?? "",
        }
      : { ...SCENE_FORM_DEFAULT, ...(draftSeed ?? {}) };
    setDraft(nextDraft);
    setEnvSections(parseEnvironmentPrompt(nextDraft.environment_prompt ?? ""));
  }, [draftSeed, initial, open]);

  const isPlateDialog = isScenePlatePayload(initial ?? draftSeed);
  const generatedPlateName = composeScenePlateName(draft);
  const hasPlateSuffix =
    Boolean(trimScenePart(draft.variant_id)) ||
    Boolean(trimScenePart(draft.time_of_day));
  const generatedPlateNamePreview =
    generatedPlateName && hasPlateSuffix
      ? generatedPlateName
      : t("assets.scenes.generatedPlateNamePlaceholder", {
          defaultValue: "填写变体或时间后自动生成",
        });
  const title = initial
    ? isPlateDialog
      ? t("assets.scenes.editPlate", { defaultValue: "编辑场景变体" })
      : t("assets.scenes.editScene")
    : isPlateDialog
      ? t("assets.scenes.newPlate", { defaultValue: "添加场景变体" })
      : t("assets.scenes.newScene");
  const SCENE_DIALOG_INPUT_CLASS =
    "h-11 rounded-[8px] border-white/12 bg-white/[0.04] px-3 text-sm placeholder:text-muted-foreground/70 focus-visible:border-white/25 focus-visible:ring-2 focus-visible:ring-white/8 dark:bg-white/[0.04]";
  const SCENE_DIALOG_SELECT_TRIGGER_CLASS =
    "!h-11 !w-full min-w-0 overflow-hidden rounded-[8px] border-white/12 bg-white/[0.04] !px-3 !py-0 text-sm leading-none focus-visible:border-white/25 focus-visible:ring-2 focus-visible:ring-white/8 dark:bg-white/[0.04] *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate *:data-[slot=select-value]:leading-none";
  const SCENE_DIALOG_DISPLAY_CLASS =
    "flex h-11 min-w-0 items-center rounded-[8px] border border-white/12 bg-white/[0.04] px-3 text-sm dark:bg-white/[0.04]";
  const SCENE_DIALOG_TEXTAREA_CLASS =
    "rounded-[8px] border-white/12 bg-white/[0.04] px-3 py-2 text-sm placeholder:text-muted-foreground/70 focus-visible:border-white/25 focus-visible:ring-2 focus-visible:ring-white/8 dark:bg-white/[0.04]";
  const sceneTimeChoices = useMemo(
    () => timeOfDayOptions(draft.time_of_day),
    [draft.time_of_day],
  );
  const canSave = isPlateDialog
    ? saving ||
      !trimScenePart(draft.base_scene_id) ||
      !(trimScenePart(draft.variant_id) || trimScenePart(draft.time_of_day))
    : saving || !draft.name.trim();
  const submitDraft = isPlateDialog
    ? {
        ...draft,
        name: generatedPlateName,
        base_scene_id: trimScenePart(draft.base_scene_id),
        variant_id: trimScenePart(draft.variant_id),
        time_of_day: trimScenePart(draft.time_of_day),
        environment_prompt: "",
        variant_prompt: trimScenePart(draft.variant_prompt),
      }
    : {
        ...draft,
        base_scene_id: "",
        variant_id: "",
        time_of_day: "",
        variant_prompt: "",
      };
  const renderSceneTypeField = () => (
    <div className="grid min-w-0 gap-2">
      <Label className="text-sm">{t("assets.scenes.fields.type")}</Label>
      <Select
        value={draft.scene_type || "other"}
        onValueChange={(value) =>
          setDraft((prev) => ({
            ...prev,
            scene_type: String(value || "other"),
          }))
        }
      >
        <SelectTrigger
          size="sm"
          aria-label={t("assets.scenes.fields.type")}
          className={SCENE_DIALOG_SELECT_TRIGGER_CLASS}
        >
          <SelectValue>{sceneTypeLabel(draft.scene_type)}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start" alignItemWithTrigger={false}>
          {sceneTypeOptions(draft.scene_type).map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] gap-4 overflow-hidden rounded-2xl border border-white/8 bg-background/68 px-7 pb-4 pt-7 shadow-none backdrop-blur-3xl sm:max-w-4xl">
        <DialogHeader className="gap-2">
          <DialogTitle className="flex items-center gap-2 text-lg font-medium tracking-tight">
            <span>{title}</span>
          </DialogTitle>
        </DialogHeader>
        {/* 镜头/共现等内容多时整体限高并在 body 内滚动，避免弹窗撑过屏幕、上方字段被裁切看不到。 */}
        <div className="grid max-h-[70vh] min-w-0 gap-4 overflow-y-auto overflow-x-hidden overscroll-contain pr-1">
          {isPlateDialog ? (
            <div className="grid min-w-0 gap-3">
              <div className="grid min-w-0 gap-2">
                <Label className="text-sm">
                  {t("assets.scenes.generatedPlateName", {
                    defaultValue: "资产名",
                  })}
                </Label>
                <div
                  aria-label={t("assets.scenes.generatedPlateName", {
                    defaultValue: "资产名",
                  })}
                  className={SCENE_DIALOG_DISPLAY_CLASS}
                >
                  <span
                    className={
                      hasPlateSuffix
                        ? "truncate font-medium text-foreground"
                        : "truncate text-muted-foreground/70"
                    }
                  >
                    {generatedPlateNamePreview}
                  </span>
                </div>
              </div>
              <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(14rem,1.25fr)_minmax(7.5rem,0.7fr)]">
                <div className="grid min-w-0 gap-2">
                  <Label className="text-sm">
                    {t("assets.scenes.fields.baseScene", {
                      defaultValue: "基础场景",
                    })}
                  </Label>
                  <Input
                    aria-label={t("assets.scenes.fields.baseScene", {
                      defaultValue: "基础场景",
                    })}
                    value={draft.base_scene_id ?? ""}
                    readOnly
                    className={SCENE_DIALOG_INPUT_CLASS}
                  />
                </div>
                <div className="grid min-w-0 gap-2">
                  <Label className="text-sm">
                    {t("assets.scenes.fields.variant", { defaultValue: "变体" })}
                  </Label>
                  <Input
                    aria-label={t("assets.scenes.fields.variant", {
                      defaultValue: "变体",
                    })}
                    value={draft.variant_id ?? ""}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        variant_id: event.target.value,
                      }))
                    }
                    placeholder="漏水"
                    className={SCENE_DIALOG_INPUT_CLASS}
                  />
                </div>
                <div className="grid min-w-0 gap-2">
                  <Label className="text-sm">
                    {t("assets.scenes.fields.timeOfDay", { defaultValue: "时间" })}
                  </Label>
                  <Select
                    value={draft.time_of_day || "__NO_SCENE_TIME__"}
                    onValueChange={(value) =>
                      setDraft((prev) => ({
                        ...prev,
                        time_of_day:
                          value === "__NO_SCENE_TIME__" ? "" : String(value || ""),
                      }))
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label={t("assets.scenes.fields.timeOfDay", {
                        defaultValue: "时间",
                      })}
                      className={SCENE_DIALOG_SELECT_TRIGGER_CLASS}
                    >
                      <SelectValue>{timeOfDayLabel(draft.time_of_day)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent align="start" alignItemWithTrigger={false}>
                      <SelectItem value="__NO_SCENE_TIME__">
                        {timeOfDayLabel("")}
                      </SelectItem>
                      {sceneTimeChoices.map((option) => (
                        <SelectItem key={option} value={option}>
                          {timeOfDayLabel(option)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {renderSceneTypeField()}
              </div>
            </div>
          ) : (
            <div className="grid gap-2">
              <Label className="text-sm">{t("assets.scenes.fields.name")}</Label>
              <Input
                aria-label={t("assets.scenes.fields.name")}
                value={draft.name}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, name: event.target.value }))
                }
                className={SCENE_DIALOG_INPUT_CLASS}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                {t("assets.scenes.fields.nameRule", {
                  defaultValue:
                    "普通独立场景只填名称；不要在这里填写变体或时间。需要状态/时间版时，在场景详情里添加变体。",
                })}
              </p>
            </div>
          )}
          {!isPlateDialog ? renderSceneTypeField() : null}
          {isPlateDialog ? (
            <div className="grid gap-2">
              <Label className="text-sm">
                {t("assets.scenes.fields.variantPrompt", {
                  defaultValue: "变体增量提示词",
                })}
              </Label>
              <Textarea
                aria-label={t("assets.scenes.fields.variantPrompt", {
                  defaultValue: "变体增量提示词",
                })}
                rows={4}
                value={draft.variant_prompt ?? ""}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    variant_prompt: event.target.value,
                  }))
                }
                placeholder={t("assets.scenes.fields.variantPromptPlaceholder", {
                  defaultValue:
                    "只写和基础场景不同的部分，例如积水反光、焦黑墙面、节日装饰。",
                })}
                className={SCENE_DIALOG_TEXTAREA_CLASS}
              />
            </div>
          ) : (
            <div className="grid gap-2">
              <Label className="text-sm">
                {t("assets.scenes.fields.environmentPrompt")}
              </Label>
              <SceneEnvironmentPromptFields
                sections={envSections}
                onChange={(key, value) =>
                  setEnvSections((prev) => ({ ...prev, [key]: value }))
                }
                textareaClassName={SCENE_DIALOG_TEXTAREA_CLASS}
              />
            </div>
          )}
          <div className="grid gap-2">
            <Label className="text-sm">
              {t("assets.scenes.fields.description")}
            </Label>
            <Textarea
              rows={3}
              value={draft.description ?? ""}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  description: event.target.value,
                }))
              }
              className={SCENE_DIALOG_TEXTAREA_CLASS}
            />
          </div>
          {initial && (
            <AssetBeatReferences
              project={project}
              references={references}
              className="border-t border-border/60 pt-4"
            />
          )}
          {initial &&
            (coOccurrence.identities.length > 0 ||
              coOccurrence.props.length > 0) && (
              <div className="grid gap-3 border-t border-border/60 pt-4">
                {coOccurrence.identities.length > 0 && (
                  <CoOccurrenceRow
                    label={t("assets.common.coIdentities")}
                    ids={coOccurrence.identities}
                    onJump={(id) => navigateToAsset("identity", id)}
                  />
                )}
                {coOccurrence.props.length > 0 && (
                  <CoOccurrenceRow
                    label={t("assets.common.coProps")}
                    ids={coOccurrence.props}
                    onJump={(id) => navigateToAsset("prop", id)}
                  />
                )}
              </div>
            )}
        </div>
        <DialogFooter className="border-t-0 bg-transparent pt-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="h-10 w-18 rounded-md border-white/18 bg-white/[0.06] px-0 text-sm font-normal text-foreground/80 hover:border-white/28 hover:bg-white/[0.1] hover:text-foreground"
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() =>
              onSubmit({
                ...submitDraft,
                environment_prompt: isPlateDialog
                  ? ""
                  : serializeEnvironmentPrompt(envSections),
              })
            }
            disabled={canSave}
            className="h-10 w-18 rounded-md bg-primary px-0 text-sm font-normal text-primary-foreground shadow-lg shadow-primary/15 hover:bg-primary/90"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CoOccurrenceRow({
  label,
  ids,
  onJump,
}: {
  label: string;
  ids: string[];
  onJump: (id: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {ids.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onJump(id)}
            className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/60 hover:bg-primary/10 hover:text-foreground"
          >
            {id}
          </button>
        ))}
      </div>
    </div>
  );
}

function SceneAssetCardController({
  project,
  scene,
  referenceCount,
  onEdit,
  onDelete,
}: {
  project: string;
  scene: SceneAsset;
  referenceCount: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [stagePlySource, setStagePlySource] =
    useState<SceneStagePlySource | null>(null);
  const masterInputRef = useRef<HTMLInputElement>(null);
  const panoInputRef = useRef<HTMLInputElement>(null);
  const [freezonePending, setFreezonePending] = useState(false);
  const [panoDialogOpen, setPanoDialogOpen] = useState(false);
  const [stageDialogOpen, setStageDialogOpen] = useState(false);
  const [stageViewerOpening, setStageViewerOpening] = useState(false);
  const panoManifest = useScenePanoManifest(
    project,
    scene.name,
    panoDialogOpen,
  );
  const stageManifest = useSceneDirectorStageManifest(
    project,
    scene.name,
    stageDialogOpen,
  );
  const sceneDirectorManifest = stageManifest.data?.ok
    ? stageManifest.data.data
    : null;
  const customInputRef = useRef<HTMLInputElement>(null);
  const uploadMaster = useUploadSceneMaster(project, scene.name);
  const uploadPano = useUploadScenePano(project, scene.name);
  const uploadCustom = useUploadSceneCustomPackage(project, scene.name);
  const deleteMaster = useDeleteSceneMaster(project, scene.name);
  const deletePano = useDeleteScenePano(project, scene.name);
  const deleteCustom = useDeleteSceneCustomPackage(project, scene.name);
  const generateMaster = useGenerateSceneMasterAsync(project, scene.name);
  const generateReverse = useGenerateSceneReverseAsync(project, scene.name);
  const generatePano = useGenerateScenePanoAsync(project, scene.name);
  const masterCost = useGenerationCreditCost("fixed_image", "scene_master");
  const reverseCost = useGenerationCreditCost(
    "fixed_image",
    "scene_reverse_master",
  );
  const panoCost = useGenerationCreditCost("fixed_image", "scene_pano");
  const generateStagePly = useGenerateScene3gsPlyAsync(project, scene.name);
  const saveDirectorWorld = useSaveSceneDirectorWorld(project, scene.name);
  const clearDirectorWorld = useClearSceneDirectorWorld(project, scene.name);
  const masterTask = useTaskController({
    key: {
      taskType: "scene_reference_asset",
      project,
      episode: 0,
      scope: `scene:${scene.name}:master`,
    },
    invalidateKeys: [queryKeys.scenes(project)],
  });
  const panoTask = useTaskController({
    key: {
      taskType: "stage_asset",
      project,
      episode: 0,
      scope: `scene:${scene.name}:pano`,
    },
    invalidateKeys: [queryKeys.scenes(project)],
  });
  const reverseTask = useTaskController({
    key: {
      taskType: "scene_reference_asset",
      project,
      episode: 0,
      scope: `scene:${scene.name}:reverse`,
    },
    invalidateKeys: [queryKeys.scenes(project)],
  });
  const stageSingleFaceTask = useTaskController({
    key: {
      taskType: "stage_asset",
      project,
      episode: 0,
      scope: `scene:${scene.name}:single_face_sharp`,
    },
    invalidateKeys: [queryKeys.scenes(project)],
    onComplete: () => setStagePlySource(null),
    onError: () => setStagePlySource(null),
  });
  const stagePanoTask = useTaskController({
    key: {
      taskType: "stage_asset",
      project,
      episode: 0,
      scope: `scene:${scene.name}:pano_sharp`,
    },
    invalidateKeys: [queryKeys.scenes(project)],
    onComplete: () => setStagePlySource(null),
    onError: () => setStagePlySource(null),
  });

  async function handleMasterFile(file: File | undefined) {
    if (!file) return;
    const res = await uploadMaster.mutateAsync(file);
    if (isErrorResponse(res)) {
      toast.error(res.error);
      return;
    }
    toast.success("Scene master uploaded");
  }

  async function handlePanoFile(file: File | undefined) {
    if (!file) return;
    const res = await uploadPano.mutateAsync(file);
    if (isErrorResponse(res)) {
      toast.error(res.error);
      return;
    }
    toast.success("360 uploaded");
  }

  async function handleCustomFile(file: File | undefined) {
    if (!file) return;
    const res = await uploadCustom.mutateAsync(file);
    if (isErrorResponse(res)) {
      toast.error(res.error);
      return;
    }
    toast.success("Custom scene package uploaded");
  }

  async function handleGenerateMaster() {
    try {
      const res = await generateMaster.mutateAsync();
      if (isErrorResponse(res)) {
        toast.error(res.error);
        return;
      }
      masterTask.start({ scope: res.scope });
      qc.invalidateQueries({ queryKey: queryKeys.tasks(project) });
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  }

  async function handleGeneratePano(source: ScenePanoSource) {
    try {
      const res = await generatePano.mutateAsync({ source });
      if (isErrorResponse(res)) {
        toast.error(res.error);
        return;
      }
      panoTask.start({ scope: res.scope });
      qc.invalidateQueries({ queryKey: queryKeys.tasks(project) });
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  }

  async function handleGenerateReverse() {
    try {
      const res = await generateReverse.mutateAsync();
      if (isErrorResponse(res)) {
        toast.error(res.error);
        return;
      }
      reverseTask.start({ scope: res.scope });
      qc.invalidateQueries({ queryKey: queryKeys.tasks(project) });
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  }

  async function handleGenerateStagePly(source: SceneStagePlySource) {
    setStagePlySource(source);
    try {
      const res = await generateStagePly.mutateAsync(source);
      if (isErrorResponse(res)) {
        setStagePlySource(null);
        toast.error(res.error);
        return;
      }
      if (source === "pano") {
        stagePanoTask.start({ scope: res.scope });
      } else {
        stageSingleFaceTask.start({ scope: res.scope });
      }
      qc.invalidateQueries({ queryKey: queryKeys.tasks(project) });
    } catch (err) {
      setStagePlySource(null);
      toast.error(backendErrorToastMessage(err, t));
    }
  }

  async function handleDeleteMaster() {
    const res = await deleteMaster.mutateAsync();
    if (isErrorResponse(res)) {
      toast.error(res.error);
      return;
    }
    toast.success("Scene master deleted");
  }

  async function handleDeletePano() {
    const res = await deletePano.mutateAsync();
    if (isErrorResponse(res)) {
      toast.error(res.error);
      return;
    }
    toast.success("360 deleted");
  }

  async function handleOpenFreezone() {
    setFreezonePending(true);
    try {
      await openSceneFreezoneCanvas(project, scene.name);
      toast.success(t("assets.scenes.freezoneOpened"));
    } catch {
      toast.error(t("assets.scenes.freezoneOpenFailed"));
    } finally {
      setFreezonePending(false);
    }
  }

  async function handleOpenStageViewer() {
    if (stageViewerOpening) return;
    setStageViewerOpening(true);
    try {
      const result = await stageManifest.refetch();
      if (result.error) {
        toast.error(backendErrorToastMessage(result.error, t));
        return;
      }
      setStageDialogOpen(true);
    } finally {
      setStageViewerOpening(false);
    }
  }

  async function handleDeleteCustom() {
    const res = await deleteCustom.mutateAsync();
    if (isErrorResponse(res)) {
      toast.error(res.error);
      return;
    }
    toast.success("Custom scene package deleted");
  }

  async function handleScenePanoCapture(result: PanoCaptureResult) {
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${scene.name}_360_${result.aspect.replace(":", "x")}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast.success(t("assets.scenes.panoScreenshotDownloaded"));
  }

  function sourceForDirectorWorldSave(activeSourceId?: string) {
    if (!activeSourceId) return undefined;
    const manifest = sceneDirectorManifest;
    if (!manifest) return undefined;
    const sourceFromList = manifest.sources?.find((source) => source.id === activeSourceId);
    if (sourceFromList) return sourceFromList;
    if (
      activeSourceId === `scene-pano:${scene.name}` &&
      manifest.source.source_type === "pano360"
    ) {
      return {
        id: activeSourceId,
        source_type: "pano360",
        source_kind: "pano",
        label: "360",
        url: manifest.source.pano_url ?? manifest.source.url,
        pano_url: manifest.source.pano_url ?? manifest.source.url,
        pano_fs: manifest.source.pano_fs,
        slot_kind: "scene_director_pano_360",
      };
    }
    const option = manifest.source_options?.find((item) => {
      if (
        activeSourceId === `scene-pano:${scene.name}` &&
        item.source_type === "pano360" &&
        item.slot_kind === "scene_director_pano_360"
      ) {
        return true;
      }
      return false;
    });
    if (!option) return undefined;
    return {
      id: activeSourceId,
      source_type: option.source_type ?? "sog",
      source_kind: option.kind === "active" ? manifest.source.source_kind : option.kind,
      label: option.label,
      ply_url: option.ply_url,
      url: option.url ?? option.ply_url ?? option.pano_url,
      pano_url: option.pano_url,
      pano_fs: option.pano_fs,
      slot_kind: option.slot_kind,
      fs: option.fs,
    };
  }

  async function handleSaveDirectorWorld(
    snapshot: ThreeDSceneSnapshot,
    activeSourceId?: string,
  ) {
    const sourceId = String(activeSourceId || "").trim();
    const res = await saveDirectorWorld.mutateAsync({
      active_source_id: sourceId,
      snapshot,
      active_source: sourceForDirectorWorldSave(sourceId) as Record<string, unknown> | undefined,
    });
    if (isErrorResponse(res)) {
      throw new Error(res.error);
    }
  }

  async function handleClearDirectorWorld(activeSourceId?: string) {
    const res = await clearDirectorWorld.mutateAsync(String(activeSourceId || ""));
    if (isErrorResponse(res)) {
      throw new Error(res.error);
    }
  }

  return (
    <>
      <SceneAssetCard
        scene={scene}
        referenceCount={referenceCount}
        masterRunning={generateMaster.isPending || masterTask.started}
        reverseRunning={generateReverse.isPending || reverseTask.started}
        panoRunning={generatePano.isPending || panoTask.started}
        stageBusy={
          generateStagePly.isPending ||
          stageSingleFaceTask.started ||
          stagePanoTask.started ||
          stageViewerOpening
        }
        masterPlyRunning={
          stagePlySource === "master" &&
          (generateStagePly.isPending || stageSingleFaceTask.started)
        }
        reversePlyRunning={
          stagePlySource === "reverse" &&
          (generateStagePly.isPending || stageSingleFaceTask.started)
        }
        panoPlyRunning={
          stagePlySource === "pano" &&
          (generateStagePly.isPending || stagePanoTask.started)
        }
        customUploading={uploadCustom.isPending}
        customDeleting={deleteCustom.isPending}
        masterCost={masterCost.data?.data.display}
        reverseCost={reverseCost.data?.data.display}
        panoCost={panoCost.data?.data.display}
        onEdit={onEdit}
        onDelete={onDelete}
        onUploadMaster={() => masterInputRef.current?.click()}
        onGenerateMaster={handleGenerateMaster}
        onDeleteMaster={handleDeleteMaster}
        onGenerateReverse={handleGenerateReverse}
        onUploadPano={() => panoInputRef.current?.click()}
        onGeneratePano={handleGeneratePano}
        onDeletePano={handleDeletePano}
        onOpenPanoViewer={() => setPanoDialogOpen(true)}
        onOpenStageViewer={handleOpenStageViewer}
        onOpenFreezone={handleOpenFreezone}
        freezonePending={freezonePending}
        onUploadCustomPackage={() => customInputRef.current?.click()}
        onDeleteCustomPackage={handleDeleteCustom}
        onGenerateStagePly={handleGenerateStagePly}
      />
      <input
        ref={masterInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          handleMasterFile(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={panoInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          handlePanoFile(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={customInputRef}
        type="file"
        accept=".ply,.sog,.splat,.ksplat"
        className="hidden"
        onChange={(event) => {
          handleCustomFile(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      <PanoCaptureDialog
        open={panoDialogOpen}
        onOpenChange={setPanoDialogOpen}
        manifest={panoManifest.data?.ok ? panoManifest.data.data : null}
        title={`${scene.name} 360`}
        description={t("assets.scenes.panoCaptureDescription")}
        viewerPurpose="asset"
        captureLabel={t("assets.scenes.downloadScreenshot")}
        onCapture={handleScenePanoCapture}
      />
      <ThreeDDirectorDialog
        open={stageDialogOpen}
        onOpenChange={setStageDialogOpen}
        manifest={sceneDirectorManifest}
        title={`${scene.name} ${t("viewer.threeD.directorWorld")}`}
        description={t("viewer.threeD.sceneDirectorWorldDescription")}
        viewerPurpose="asset"
        initialScene={sceneDirectorManifest?.scene ?? null}
        initialScenesBySourceId={sceneDirectorManifest?.scenes_by_source_id ?? null}
        onSaveScene={handleSaveDirectorWorld}
        onClearScene={handleClearDirectorWorld}
      />
    </>
  );
}

interface SceneGroup {
  baseName: string;
  scenes: SceneAsset[];
}

const SCENE_GROUP_SELECTION_STORAGE_KEY_PREFIX = "supertale-scene-group:";

function sceneGroupSelectionStorageKey(project: string): string {
  return `${SCENE_GROUP_SELECTION_STORAGE_KEY_PREFIX}${encodeURIComponent(project)}`;
}

function readStoredSceneGroupSelection(project: string): string | null {
  if (typeof window === "undefined") return null;
  return (
    window.localStorage.getItem(sceneGroupSelectionStorageKey(project))?.trim() ||
    null
  );
}

function writeStoredSceneGroupSelection(project: string, baseName: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(sceneGroupSelectionStorageKey(project), baseName);
}

function sceneGroupPreviewUrl(group: SceneGroup): string {
  const withMaster = group.scenes.find((scene) =>
    resolveMediaUrl(scene.master_url),
  );
  return resolveMediaUrl(withMaster?.master_url) ?? "";
}

function SceneGroupListItem({
  group,
  selected,
  referenceCount,
  onSelect,
}: {
  group: SceneGroup;
  selected: boolean;
  referenceCount: number;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const previewUrl = sceneGroupPreviewUrl(group);
  return (
    <button
      type="button"
      aria-label={t("assets.scenes.selectScene", {
        name: group.baseName,
        defaultValue: "选择场景 {{name}}",
      })}
      aria-pressed={selected}
      onClick={onSelect}
      className={[
        "flex w-full min-w-0 items-center gap-3 rounded-[10px] border p-2 text-left transition",
        selected
          ? "border-primary/35 bg-primary/[0.075] text-foreground"
          : "border-white/[0.06] bg-white/[0.018] text-foreground/82 hover:border-white/[0.12] hover:bg-white/[0.035]",
      ].join(" ")}
    >
      <div className="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-white/[0.08] bg-black/20">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover"
          />
        ) : (
          <Map className="size-4 text-muted-foreground/65" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{group.baseName}</div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {group.scenes.length > 1 ? (
            <span>
              {t("assets.scenes.variantCount", {
                count: group.scenes.length,
                defaultValue: "{{count}} 个变体",
              })}
            </span>
          ) : null}
          {referenceCount > 0 ? (
            <span>
              {t("assets.scenes.referenceCount", {
                count: referenceCount,
                defaultValue: "{{count}} 次使用",
              })}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  );
}

export function ScenesPanel({
  project,
  focusId,
}: {
  project: string;
  focusId?: string | null;
}) {
  const { t } = useTranslation();
  const scenes = useScenes(project);
  const createScene = useCreateScene(project);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SceneAsset | null>(null);
  const [draftSeed, setDraftSeed] = useState<Partial<ScenePayload> | null>(null);
  const [selectedBaseName, setSelectedBaseName] = useState<string | null>(() =>
    readStoredSceneGroupSelection(project),
  );
  const updateScene = useUpdateScene(project, editing?.name ?? "");
  const deleteScene = useDeleteScene(project);
  const buildScenes = useBuildScenes(project);
  const buildScenesCost = useGenerationCreditCost("feature", "build_scenes");
  const buildScenesCostDisplay =
    buildScenesCost.data?.data.display ??
    (buildScenesCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);
  const refIndex = useAssetReferenceIndex(project);

  const allItems = scenes.data?.data ?? [];
  const [searchQuery, setSearchQuery] = useState("");
  const [sortKey, setSortKey] = useState<AssetSortKey>("name");
  const allSceneGroups = useMemo<SceneGroup[]>(() => {
    const groups = new globalThis.Map<string, SceneAsset[]>();
    for (const scene of allItems) {
      const baseName =
        scene.base_scene_id?.trim() ||
        scene.derived_from_scene?.trim() ||
        scene.name;
      const group = groups.get(baseName) ?? [];
      group.push(scene);
      groups.set(baseName, group);
    }
    return Array.from(groups.entries()).map(([baseName, groupScenes]) => ({
      baseName,
      scenes: groupScenes,
    }));
  }, [allItems]);
  useEffect(() => {
    setSelectedBaseName(readStoredSceneGroupSelection(project));
  }, [project]);
  const rememberSelectedBaseName = useCallback(
    (baseName: string) => {
      setSelectedBaseName(baseName);
      writeStoredSceneGroupSelection(project, baseName);
    },
    [project],
  );
  const sceneGroups = useMemo(() => {
    const filtered = filterBySearch(allSceneGroups, searchQuery, (group) => [
      group.baseName,
      ...group.scenes.flatMap((scene) => [
        scene.name,
        scene.scene_type,
        scene.environment_prompt,
        scene.description,
        ...(scene.aliases ?? []),
      ]),
    ]);
    return sortAssets(
      filtered,
      sortKey,
      (group) => group.baseName,
      (group) =>
        group.scenes.reduce(
          (sum, scene) => sum + refIndex.countFor("scene", scene.name),
          0,
        ),
    );
  }, [allSceneGroups, searchQuery, sortKey, refIndex]);
  useEffect(() => {
    if (scenes.isLoading) {
      return;
    }
    if (focusId) {
      const focusedGroup = allSceneGroups.find((group) =>
        group.scenes.some((scene) => scene.name === focusId),
      );
      if (focusedGroup && focusedGroup.baseName !== selectedBaseName) {
        rememberSelectedBaseName(focusedGroup.baseName);
        return;
      }
    }
    if (
      selectedBaseName &&
      sceneGroups.some((group) => group.baseName === selectedBaseName)
    ) {
      return;
    }
    setSelectedBaseName(sceneGroups[0]?.baseName ?? null);
  }, [
    allSceneGroups,
    focusId,
    rememberSelectedBaseName,
    scenes.isLoading,
    sceneGroups,
    selectedBaseName,
  ]);
  const selectedGroup =
    sceneGroups.find((group) => group.baseName === selectedBaseName) ?? null;
  const selectedBaseScene =
    selectedGroup?.scenes.find((scene) => scene.name === selectedGroup.baseName) ??
    selectedGroup?.scenes[0] ??
    null;
  const gridRef = useAssetFocus(
    focusId,
    !scenes.isLoading &&
      Boolean(selectedGroup?.scenes.some((scene) => scene.name === focusId)),
  );

  async function handleSave(data: ScenePayload) {
    const payload = { ...data, name: data.name.trim() };
    const res = editing
      ? await updateScene.mutateAsync(payload)
      : await createScene.mutateAsync(payload);
    if (isErrorResponse(res)) {
      toast.error(res.error);
      return;
    }
    setDialogOpen(false);
    setEditing(null);
    setDraftSeed(null);
  }

  async function handleBuildScenes() {
    let res;
    try {
      res = await buildScenes.mutateAsync();
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
      return;
    }
    if (isErrorResponse(res)) {
      toast.error(backendErrorToastMessage(res.error, t));
      return;
    }
    toast.success(res.message);
  }

  async function handleDelete(scene: SceneAsset) {
    if (!window.confirm(t("assets.scenes.confirmDelete", { name: scene.name })))
      return;
    const res = await deleteScene.mutateAsync(scene.name);
    if (isErrorResponse(res)) {
      toast.error(res.error);
      return;
    }
    toast.success(t("assets.scenes.deleted"));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <AssetHeaderActions>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await scenes.refetch();
            toast.success(t("common.refreshed"));
          }}
          data-scenes-refresh
          className="h-8 gap-1.5 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none transition-transform hover:bg-white/[0.04] active:scale-95 dark:bg-transparent"
        >
          <RefreshCw className="size-3.5" />
          {t("common.refresh")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setEditing(null);
            setDraftSeed(null);
            setDialogOpen(true);
          }}
          className="h-8 gap-1.5 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none hover:bg-white/[0.04] dark:bg-transparent"
        >
          <Plus className="size-3.5" />
          {t("assets.scenes.newScene")}
        </Button>
        <Button
          size="sm"
          onClick={handleBuildScenes}
          disabled={buildScenes.isPending}
          className="h-8 gap-1.5 rounded-[8px] px-3 text-xs font-normal shadow-none hover:bg-primary/85"
        >
          {buildScenes.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          {t("assets.scenes.build")}
          <CreditCostInline display={buildScenesCostDisplay} />
        </Button>
      </AssetHeaderActions>
      {scenes.isLoading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          {t("common.loading")}
        </div>
      ) : allItems.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center text-center">
          <div className="mb-3 flex size-12 items-center justify-center rounded-full border border-border bg-card">
            <Map className="size-5 text-muted-foreground" />
          </div>
          <div>
            <h3 className="mb-1.5 text-sm font-semibold text-foreground">
              {t("assets.scenes.emptyTitle")}
            </h3>
            <p className="max-w-[15rem] text-xs leading-5 text-muted-foreground">
              {t("assets.scenes.emptyDescription")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditing(null);
              setDraftSeed(null);
              setDialogOpen(true);
            }}
            className={EMPTY_STATE_ACTION_BUTTON_CLASS}
          >
            <Plus className="size-3.5" />
            {t("assets.scenes.newScene")}
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden bg-background lg:flex">
          <aside className="flex max-h-[42vh] w-full shrink-0 flex-col overflow-hidden border-b border-border/30 bg-background lg:max-h-none lg:w-80 lg:border-b-0 lg:border-r">
            <div className="px-3 pb-2 pt-3">
              <div className="flex min-w-0 items-center gap-2">
                <AssetSearchBox
                  value={searchQuery}
                  onValueChange={setSearchQuery}
                  placeholder={t("assets.common.searchScenes")}
                  ariaLabel={t("assets.common.searchScenes")}
                  className="min-w-0 flex-1"
                />
                <div className="shrink-0">
                  <AssetSortSelect value={sortKey} onValueChange={setSortKey} />
                </div>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2">
              {sceneGroups.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {t("assets.common.noMatch")}
                </div>
              ) : (
                <div className="space-y-2">
                  {sceneGroups.map((group) => (
                    <SceneGroupListItem
                      key={group.baseName}
                      group={group}
                      selected={selectedBaseName === group.baseName}
                      referenceCount={group.scenes.reduce(
                        (sum, scene) => sum + refIndex.countFor("scene", scene.name),
                        0,
                      )}
                      onSelect={() => rememberSelectedBaseName(group.baseName)}
                    />
                  ))}
                </div>
              )}
            </div>
          </aside>
          <section className="min-w-0 flex-1 overflow-hidden bg-background">
            {!selectedGroup ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {t("assets.common.noMatch")}
              </div>
            ) : (
              <div className="@container h-full overflow-y-auto px-4 py-3">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-foreground">
                        {selectedGroup.baseName}
                      </h3>
                      <span className="rounded-[5px] bg-white/[0.11] px-1 py-0 text-[11px] font-medium leading-5 tabular-nums text-white/72">
                        {selectedGroup.scenes.length}
                      </span>
                    </div>
                  </div>
                  <TooltipProvider delay={80}>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setEditing(null);
                              setDraftSeed({
                                base_scene_id: selectedGroup.baseName,
                                variant_id: "",
                                time_of_day: "",
                                scene_type:
                                  selectedBaseScene?.scene_type ?? "interior",
                                environment_prompt: "",
                                variant_prompt: "",
                                description: "",
                              });
                              setDialogOpen(true);
                            }}
                            title={t("assets.scenes.newPlateHint", {
                              defaultValue:
                                "场景变体即「同一个地点的不同状态」",
                            })}
                            className="h-8 gap-1 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none hover:bg-white/[0.04] dark:bg-transparent"
                          />
                        }
                      >
                        <Plus className="size-3.5" />
                        {t("assets.scenes.newPlate", {
                          defaultValue: "添加场景变体",
                        })}
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {t("assets.scenes.newPlateHint", {
                          defaultValue: "场景变体即「同一个地点的不同状态」",
                        })}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <div
                  ref={gridRef}
                  className="mt-1.5 grid grid-cols-1 gap-3 xl:grid-cols-2"
                >
                  {selectedGroup.scenes.map((scene) => (
                    <div key={scene.name} data-asset-id={scene.name}>
                      <SceneAssetCardController
                        project={project}
                        scene={scene}
                        referenceCount={refIndex.countFor("scene", scene.name)}
                        onEdit={() => {
                          setEditing(scene);
                          setDraftSeed(null);
                          setDialogOpen(true);
                        }}
                        onDelete={() => handleDelete(scene)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      )}
      <SceneDialog
        open={dialogOpen}
        initial={editing}
        draftSeed={draftSeed}
        project={project}
        references={
          editing ? refIndex.referencesFor("scene", editing.name) : []
        }
        coOccurrence={
          editing
            ? refIndex.coOccurrenceForScene(editing.name)
            : { identities: [], props: [] }
        }
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setEditing(null);
            setDraftSeed(null);
          }
        }}
        onSubmit={handleSave}
        saving={createScene.isPending || updateScene.isPending}
      />
    </div>
  );
}
