// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useState } from "react";
import { Loader2, Package, Plus, RefreshCw, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { AssetHeaderActions } from "@/components/assets/asset-header-actions-slot";
import { PropAssetCard } from "@/components/assets/prop-asset-card";
import { AssetBeatReferences } from "@/components/assets/asset-beat-references";
import { CreditCostInline } from "@/components/credit-cost-inline";
import {
  AssetResultCount,
  AssetSearchBox,
  AssetSortSelect,
  filterBySearch,
  sortAssets,
  type AssetSortKey,
} from "@/components/assets/asset-search-box";
import {
  useAssetReferenceIndex,
  type BeatReference,
} from "@/lib/queries/asset-references";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { useAssetFocus } from "@/hooks/use-asset-focus";
import { StageProgressPanel } from "@/components/stage-progress-panel";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { EMPTY_STATE_ACTION_BUTTON_CLASS } from "@/components/ui/empty-state-styles";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { propReferenceAssetScope } from "@/lib/task-scope";
import { backendErrorToastMessage } from "@/lib/api-errors";
import {
  useBatchGeneratePropReferences,
  useCreateProp,
  useDeleteProp,
  useGeneratePropReferenceAsync,
  useProps,
  useUpdateProp,
  useUploadPropReference,
  type PropPayload,
} from "@/lib/queries/props";
import { openPresetProjectionInMyCanvas } from "@/features/freezone/openPresetProjection";
import { queryKeys } from "@/lib/query-keys";
import type { ErrorResponse } from "@/types/api";
import type { PropAsset } from "@/types/prop";

const PROP_FORM_DEFAULT: PropPayload = {
  name: "",
  prop_type: "object",
  visual_prompt: "",
  description: "",
  owner: "",
};

const PROP_TYPE_VALUES = [
  "weapon",
  "accessory",
  "artifact",
  "document",
  "furniture",
  "object",
] as const;

function isErrorResponse(value: unknown): value is ErrorResponse {
  return Boolean(value && typeof value === "object" && (value as { ok?: unknown }).ok === false);
}

function formatCreditCost(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

async function openPropFreezoneCanvas(project: string, propName: string) {
  await openPresetProjectionInMyCanvas(project, {
    scope: "asset",
    asset_kind: "prop",
    asset_id: propName,
  });
}

function PropDialog({
  open,
  initial,
  project,
  references,
  onOpenChange,
  onSubmit,
  saving,
}: {
  open: boolean;
  initial: PropAsset | null;
  project: string;
  references: BeatReference[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: PropPayload) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PropPayload>(PROP_FORM_DEFAULT);

  useEffect(() => {
    setDraft(
      initial
        ? {
            name: initial.name,
            aliases: initial.aliases ?? [],
            prop_type: initial.prop_type ?? "object",
            visual_prompt: initial.visual_prompt ?? "",
            description: initial.description ?? "",
            owner: initial.owner ?? "",
            notes: initial.notes ?? "",
          }
        : PROP_FORM_DEFAULT,
    );
  }, [initial, open]);

  const title = initial ? t("assets.props.editProp") : t("assets.props.newProp");
  const PROP_DIALOG_INPUT_CLASS = "h-11 rounded-[8px] border-white/12 bg-white/[0.04] px-3 text-sm placeholder:text-muted-foreground/70 focus-visible:border-white/25 focus-visible:ring-2 focus-visible:ring-white/8 dark:bg-white/[0.04]";
  const PROP_DIALOG_TEXTAREA_CLASS = "rounded-[8px] border-white/12 bg-white/[0.04] px-3 py-2 text-sm placeholder:text-muted-foreground/70 focus-visible:border-white/25 focus-visible:ring-2 focus-visible:ring-white/8 dark:bg-white/[0.04]";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 overflow-hidden rounded-2xl border border-white/8 bg-background/68 p-7 shadow-none backdrop-blur-3xl sm:max-w-lg">
        <DialogHeader className="gap-2">
          <DialogTitle className="flex items-center gap-2 text-lg font-medium tracking-tight">
            <span>{title}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label className="text-sm">{t("assets.props.fields.name")}</Label>
            <Input
              value={draft.name}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, name: event.target.value }))
              }
              className={PROP_DIALOG_INPUT_CLASS}
            />
          </div>
          <div className="grid gap-2">
            <Label className="text-sm">{t("assets.props.fields.type")}</Label>
            <Select
              value={draft.prop_type || "object"}
              onValueChange={(value) =>
                setDraft((prev) => ({ ...prev, prop_type: String(value) }))
              }
            >
              <SelectTrigger className={PROP_DIALOG_INPUT_CLASS}>
                <SelectValue>
                  {t(`assets.props.types.${draft.prop_type || "object"}`, {
                    defaultValue: draft.prop_type || "object",
                  })}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PROP_TYPE_VALUES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`assets.props.types.${value}`, { defaultValue: value })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label className="text-sm">{t("assets.props.fields.owner")}</Label>
            <Input
              value={draft.owner ?? ""}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, owner: event.target.value }))
              }
              className={PROP_DIALOG_INPUT_CLASS}
            />
          </div>
          <div className="grid gap-2">
            <Label className="text-sm">{t("assets.props.fields.visualPrompt")}</Label>
            <Textarea
              rows={4}
              value={draft.visual_prompt ?? ""}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, visual_prompt: event.target.value }))
              }
              className={PROP_DIALOG_TEXTAREA_CLASS}
            />
          </div>
          {initial && (
            <AssetBeatReferences
              project={project}
              references={references}
              className="border-t border-border/60 pt-4"
            />
          )}
        </div>
        <DialogFooter className="-mx-7 -mb-7 border-t-0 bg-transparent p-7 pt-3 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="h-10 w-18 rounded-md border-white/18 bg-white/[0.06] px-0 text-sm font-normal text-foreground/80 hover:border-white/28 hover:bg-white/[0.1] hover:text-foreground"
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => onSubmit(draft)}
            disabled={saving || !draft.name.trim()}
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

function PropAssetCardController({
  project,
  prop,
  referenceCount,
  onEdit,
  onDelete,
}: {
  project: string;
  prop: PropAsset;
  referenceCount: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const generateReference = useGeneratePropReferenceAsync(project, prop.name);
  const uploadReference = useUploadPropReference(project, prop.name);
  const referenceCost = useGenerationCreditCost("fixed_image", "prop_reference");
  const [freezonePending, setFreezonePending] = useState(false);
  const refTask = useTaskController({
    key: {
      taskType: "prop_reference_asset",
      project,
      episode: 0,
      // Must match the BE-hashed scope (see task-scope.ts), else the button
      // loses its loading state after a refresh.
      scope: propReferenceAssetScope(prop.name),
    },
    invalidateKeys: [queryKeys.props(project)],
  });

  async function handleGenerate() {
    try {
      const res = await generateReference.mutateAsync();
      if (isErrorResponse(res)) {
        toast.error(res.error);
        return;
      }
      refTask.start({ scope: res.scope });
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  }

  async function handleOpenFreezone() {
    setFreezonePending(true);
    try {
      await openPropFreezoneCanvas(project, prop.name);
      toast.success(t("assets.props.freezoneOpened"));
    } catch {
      toast.error(t("assets.props.freezoneOpenFailed"));
    } finally {
      setFreezonePending(false);
    }
  }

  async function handleUpload(file: File) {
    const res = await uploadReference.mutateAsync(file);
    if (isErrorResponse(res)) {
      toast.error(res.error);
      return;
    }
    toast.success(t("assets.props.uploadReferenceSuccess"));
  }

  return (
    <PropAssetCard
      prop={prop}
      generating={generateReference.isPending || refTask.started}
      uploading={uploadReference.isPending}
      referenceCount={referenceCount}
      referenceCost={referenceCost.data?.data.display}
      freezonePending={freezonePending}
      onEdit={onEdit}
      onDelete={onDelete}
      onGenerateReference={handleGenerate}
      onUploadReference={handleUpload}
      onOpenFreezone={handleOpenFreezone}
    />
  );
}

export function PropsPanel({
  project,
  focusId,
}: {
  project: string;
  focusId?: string | null;
}) {
  const { t } = useTranslation();
  const props = useProps(project);
  const createProp = useCreateProp(project);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PropAsset | null>(null);
  const updateProp = useUpdateProp(project, editing?.name ?? "");
  const deleteProp = useDeleteProp(project);
  const refIndex = useAssetReferenceIndex(project);
  const referenceCost = useGenerationCreditCost("fixed_image", "prop_reference");
  const batchGenerate = useBatchGeneratePropReferences(project);
  const batchTask = useTaskController({
    key: { taskType: "batch_prop_ref", project, episode: 0 },
    invalidateKeys: [queryKeys.props(project)],
  });
  const allItems = props.data?.data ?? [];
  const missingReferenceCount = useMemo(
    () => allItems.filter((prop) => !prop.reference_url && !prop.reference_path).length,
    [allItems],
  );
  const batchReferenceCost = useMemo(() => {
    const unitCost = referenceCost.data?.data.cost;
    if (!unitCost || missingReferenceCount <= 0) return null;
    return formatCreditCost(unitCost * missingReferenceCount);
  }, [missingReferenceCount, referenceCost.data?.data.cost]);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortKey, setSortKey] = useState<AssetSortKey>("name");
  const items = useMemo(() => {
    const filtered = filterBySearch(allItems, searchQuery, (prop) => [
      prop.name,
      prop.prop_type,
      prop.description,
      prop.visual_prompt,
      prop.owner,
      ...(prop.aliases ?? []),
    ]);
    return sortAssets(
      filtered,
      sortKey,
      (prop) => prop.name,
      (prop) => refIndex.countFor("prop", prop.name),
    );
  }, [allItems, searchQuery, sortKey, refIndex]);
  const gridRef = useAssetFocus(focusId, !props.isLoading && items.length > 0);
  const showBatchTask =
    batchTask.started || batchTask.stream.status !== "idle" || batchTask.logs.length > 0;
  const lastBatchLog = batchTask.logs[batchTask.logs.length - 1];
  const batchLogs =
    lastBatchLog === batchTask.stream.currentTask
      ? batchTask.logs.slice(0, -1)
      : batchTask.logs;

  async function handleSave(data: PropPayload) {
    const payload = { ...data, name: data.name.trim() };
    const res = editing
      ? await updateProp.mutateAsync(payload)
      : await createProp.mutateAsync(payload);
    if (isErrorResponse(res)) {
      toast.error(res.error);
      return;
    }
    setDialogOpen(false);
    setEditing(null);
  }

  async function handleBatchGenerate() {
    const res = await batchGenerate.mutateAsync();
    if (isErrorResponse(res)) {
      toast.error(res.error);
      return;
    }
    if (res.scope) {
      batchTask.start({ scope: res.scope });
    } else {
      batchTask.start();
    }
    toast.success(res.message);
  }

  async function handleDelete(prop: PropAsset) {
    if (!window.confirm(t("assets.props.confirmDelete", { name: prop.name }))) return;
    const res = await deleteProp.mutateAsync(prop.name);
    if (isErrorResponse(res)) {
      toast.error(res.error);
      return;
    }
    toast.success(t("assets.props.deleted"));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <AssetHeaderActions>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => { await props.refetch(); toast.success(t("common.refreshed")); }}
          data-props-refresh
          className="h-8 gap-1.5 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none transition-transform hover:bg-white/[0.04] active:scale-95 dark:bg-transparent"
        >
          <RefreshCw className="size-3.5" />
          {t("common.refresh")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleBatchGenerate}
          disabled={batchGenerate.isPending}
          className="relative h-8 gap-1.5 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none hover:bg-white/[0.04] dark:bg-transparent"
        >
          {batchGenerate.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          {t("assets.props.batchGenerate")}
          <CreditCostInline display={batchReferenceCost} />
        </Button>
        <TooltipProvider delay={80}>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  onClick={() => {
                    setEditing(null);
                    setDialogOpen(true);
                  }}
                  className="h-8 gap-1.5 rounded-[8px] px-3 text-xs font-normal shadow-none hover:bg-primary/85"
                />
              }
            >
              <Plus className="size-3.5" />
              {t("assets.props.newProp")}
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("assets.props.newPropHint")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </AssetHeaderActions>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {showBatchTask && (
          <div className="mb-4 overflow-hidden rounded-lg border border-border/70">
            <StageProgressPanel
              title={t("assets.props.batchStatusTitle")}
              currentTask={batchTask.stream.currentTask}
              progress={batchTask.stream.progress}
              logs={batchLogs}
              onStop={batchTask.stop}
              stopping={batchTask.stopping}
            />
          </div>
        )}
        {!props.isLoading && allItems.length > 0 && (
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <AssetSearchBox
                value={searchQuery}
                onValueChange={setSearchQuery}
                placeholder={t("assets.common.searchProps")}
                ariaLabel={t("assets.common.searchProps")}
              />
              <AssetSortSelect value={sortKey} onValueChange={setSortKey} />
            </div>
            <AssetResultCount
              resultCount={items.length}
              totalCount={allItems.length}
            />
          </div>
        )}
        {props.isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            {t("common.loading")}
          </div>
        ) : allItems.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-3 flex size-12 items-center justify-center rounded-full border border-border bg-card">
              <Package className="size-5 text-muted-foreground" />
            </div>
            <div>
              <h3 className="mb-1.5 text-sm font-semibold text-foreground">
                {t("assets.props.emptyTitle")}
              </h3>
              <p className="max-w-[15rem] text-xs leading-5 text-muted-foreground">
                {t("assets.props.emptyDescription")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
              className={EMPTY_STATE_ACTION_BUTTON_CLASS}
            >
              <Plus className="size-3.5" />
              {t("assets.props.newProp")}
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t("assets.common.noMatch")}
          </div>
        ) : (
          <div
            ref={gridRef}
            className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
          >
            {items.map((prop) => (
              <div key={prop.name} data-asset-id={prop.name}>
                <PropAssetCardController
                  project={project}
                  prop={prop}
                  referenceCount={refIndex.countFor("prop", prop.name)}
                  onEdit={() => {
                    setEditing(prop);
                    setDialogOpen(true);
                  }}
                  onDelete={() => handleDelete(prop)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      <PropDialog
        open={dialogOpen}
        initial={editing}
        project={project}
        references={editing ? refIndex.referencesFor("prop", editing.name) : []}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        onSubmit={handleSave}
        saving={createProp.isPending || updateProp.isPending}
      />
    </div>
  );
}
