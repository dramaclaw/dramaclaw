// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createLazyFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  AlertTriangle,
  ExternalLink,
  History,
  ImageIcon,
  Loader2,
  Map,
  Mars,
  Mic2,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Shirt,
  Sparkles,
  Sliders,
  Star,
  Trash2,
  Upload,
  Users,
  UserSquare2,
  Venus,
  Waves,
} from "lucide-react";

import {
  useBuildCharacters,
  useCharacterAssetHistory,
  useCharacterIdentities,
  useCharacters,
  useCreateCharacter,
  useCreateIdentity,
  useDeleteCharacter,
  useDeleteIdentity,
  useDeleteIdentityCostume,
  useDeleteIdentityImage,
  useGenerateIdentityImageAsync,
  useGenerateIdentityPortraitAsync,
  useIdentityAttempts,
  useIdentityOwnerIndex,
  useGeneratePortraitAsync,
  useRestoreCharacterAsset,
  useUpdateCharacter,
  useUpdateIdentity,
  useUploadCostumeImage,
  useUploadIdentityImage,
  useUploadIdentityPortrait,
  useUploadPortrait,
} from "@/lib/queries/characters";
import {
  backendErrorToastMessage,
  BillingRuleNotConfiguredError,
} from "@/lib/api-errors";
import { useCharacterImageSelection } from "@/lib/queries/character-image-selection";
import { useProject } from "@/lib/queries/projects";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { isCeRuntime } from "@/lib/runtime-config";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useTaskController } from "@/hooks/use-task-controller";
import { useTaskStream } from "@/hooks/use-task-stream";
import { TaskControllerProvider } from "@/components/episode/task-controller-provider";
import { SlidingTabs } from "@/components/nav/sliding-tabs";
import { CharacterSearch, filterCharacters } from "@/components/assets/character-search";
import { CharacterImageSourceSelect } from "@/components/assets/character-image-source-select";
import { CharacterStatsStrip } from "@/components/assets/character-stats-strip";
import { CharacterVoicePanel } from "@/components/assets/character-voice-panel";
import { NarratorVoicePanel } from "@/components/assets/narrator-voice-panel";
import { ProjectStyleChip } from "@/components/assets/project-style-chip";
import { ScenesPanel } from "@/components/assets/scenes-panel";
import { PropsPanel } from "@/components/assets/props-panel";
import { UsageCountBadge } from "@/components/assets/usage-count-badge";
import { CopyAssetLinkButton } from "@/components/assets/copy-asset-link-button";
import { AssetBeatReferences } from "@/components/assets/asset-beat-references";
import {
  useAssetReferenceIndex,
  type AssetRefType,
  type BeatReference,
} from "@/lib/queries/asset-references";
import { useAssetsDeepLink } from "@/hooks/use-assets-deep-link";
import { useAssetFocus } from "@/hooks/use-asset-focus";
import { LightboxImage } from "@/components/lightbox-image";
import { CreditCostInline } from "@/components/credit-cost-inline";
import { EMPTY_STATE_ACTION_BUTTON_CLASS } from "@/components/ui/empty-state-styles";
import {
  AssetHeaderActionsSlotProvider,
  AssetHeaderActionsTarget,
} from "@/components/assets/asset-header-actions-slot";
import { resolveMediaUrl } from "@/lib/media-url";
import { queryKeys } from "@/lib/query-keys";
import { getProjectCover } from "@/lib/project-cover";
import { openPresetProjectionInMyCanvas } from "@/features/freezone/openPresetProjection";
import {
  characterMainCopyForSpineTemplate,
  type CharacterMainCopy,
} from "@/lib/character-main-copy";
import type { FreezonePresetCanvasRequest } from "@/api/canvas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { SaveStatus } from "@/components/save-status";
import { saveScopes, trackSave } from "@/stores/save-status-store";
import { SidebarListSkeleton } from "@/components/skeletons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Character, CharacterAssetHistory, CharacterAssetHistoryEntry, CharacterAssetKind, Identity, IdentityAttempts } from "@/types/character";

// ─── constants ───────────────────────────────────────────────────────────────

type AssetTab = "characters" | "scenes" | "props" | "voices";

const ASSET_TABS = ["characters", "scenes", "props", "voices"] as const;
const ASSET_TAB_STORAGE_KEY_PREFIX = "supertale-asset-tab:";

const TAB_BY_ASSET_TYPE: Record<AssetRefType, AssetTab> = {
  identity: "characters",
  scene: "scenes",
  prop: "props",
};
const ASSET_TYPE_BY_TAB: Partial<Record<AssetTab, AssetRefType>> = {
  characters: "identity",
  scenes: "scene",
  props: "prop",
};

const AGE_GROUP_OPTIONS = [
  { value: "child", labelKey: "characters.ageGroups.child" },
  { value: "youth", labelKey: "characters.ageGroups.young" },
  { value: "middle", labelKey: "characters.ageGroups.middle" },
  { value: "elder", labelKey: "characters.ageGroups.elder" },
] as const;

const GENDER_OPTIONS = [
  { value: "男", labelKey: "characters.genders.male" },
  { value: "女", labelKey: "characters.genders.female" },
] as const;

const ROLE_OPTIONS = [
  { value: "主角", labelKey: "characters.roles.lead" },
  { value: "配角", labelKey: "characters.roles.supporting" },
  { value: "反派", labelKey: "characters.roles.villain" },
] as const;

const ATTEMPT_WARN_THRESHOLD = 3;
const CHARACTER_SELECT_CONTENT_CLASS =
  "rounded-md p-1 shadow-xl shadow-black/20 data-[align-trigger=true]:animate-in [&_[data-slot=select-item]]:min-h-8 [&_[data-slot=select-item]]:rounded-sm [&_[data-slot=select-item]]:px-2 [&_[data-slot=select-item]]:py-1.5 [&_[data-slot=select-item]]:text-xs [&_[data-slot=select-item]:focus]:bg-white/8 [&_[data-slot=select-item]:focus]:text-current [&_[data-slot=select-item]_svg]:size-3.5";
const CHARACTER_INPUT_CLASS =
  "!h-9 rounded-[8px] border-white/10 bg-white/[0.025] px-3 text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:border-white/20 focus-visible:ring-2 focus-visible:ring-white/8 dark:bg-white/[0.025]";
const CHARACTER_TEXTAREA_CLASS =
  "w-full resize-none rounded-[8px] border border-white/10 bg-white/[0.025] p-2.5 text-sm leading-relaxed shadow-none placeholder:text-muted-foreground/60 focus-visible:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/8";
const CHARACTER_SELECT_TRIGGER_CLASS =
  "!h-9 w-full rounded-[8px] border-white/10 bg-white/[0.025] px-3 text-sm shadow-none focus-visible:border-white/20 focus-visible:ring-2 focus-visible:ring-white/8 dark:bg-white/[0.025]";
const CHARACTER_DIALOG_CONTENT_CLASS =
  "gap-4 overflow-hidden rounded-2xl border border-white/8 bg-background/68 p-7 shadow-none backdrop-blur-3xl";
const CHARACTER_DIALOG_FOOTER_CLASS =
  "-mx-7 -mb-7 border-t-0 bg-transparent p-7 pt-3 sm:flex-row sm:justify-end";
const CHARACTER_DIALOG_CANCEL_BUTTON_CLASS =
  "h-10 w-18 rounded-md border-white/18 bg-white/[0.06] px-0 text-sm font-normal text-foreground/80 hover:border-white/28 hover:bg-white/[0.1] hover:text-foreground";
const CHARACTER_DIALOG_ACTION_BUTTON_CLASS =
  "h-10 w-18 rounded-md bg-primary px-0 text-sm font-normal text-primary-foreground shadow-lg shadow-primary/15 hover:bg-primary/90";

// ─── form schema ─────────────────────────────────────────────────────────────

const addCharacterSchema = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  gender: z.string().optional(),
  description: z.string().optional(),
  face_prompt: z.string().optional(),
});

type AddCharacterForm = z.infer<typeof addCharacterSchema>;

// ─── helpers ─────────────────────────────────────────────────────────────────

function assetTabStorageKey(project: string): string {
  return `${ASSET_TAB_STORAGE_KEY_PREFIX}${encodeURIComponent(project)}`;
}

function isAssetTab(value: string | null): value is AssetTab {
  return !!value && ASSET_TABS.includes(value as AssetTab);
}

function readStoredAssetTab(project: string): AssetTab {
  if (typeof window === "undefined") return "characters";
  const stored = window.localStorage.getItem(assetTabStorageKey(project));
  return isAssetTab(stored) ? stored : "characters";
}

function writeStoredAssetTab(project: string, next: AssetTab): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(assetTabStorageKey(project), next);
}

function isOkResponse<T>(res: unknown): res is { ok: true; data: T } {
  return Boolean(res && typeof res === "object" && (res as { ok?: unknown }).ok === true);
}

function formatAssetHistoryTime(value: string | undefined, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatAssetHistoryBytes(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function labelKeyFor<T extends { value: string; labelKey: string }>(
  opts: readonly T[],
  value: string | undefined,
): string | undefined {
  return opts.find((o) => o.value === value)?.labelKey;
}

async function openFreezonePresetCanvas({
  project,
  request,
}: {
  project: string;
  request: FreezonePresetCanvasRequest;
}) {
  await openPresetProjectionInMyCanvas(project, request);
}

function CharacterAssetHistoryButton({
  project,
  characterName,
  kind,
  identityId,
  historyUrl,
  restoreUrl,
  disabled,
  className,
  iconOnly = false,
}: {
  project: string;
  characterName: string;
  kind: CharacterAssetKind;
  identityId?: string;
  historyUrl?: string;
  restoreUrl?: string;
  disabled?: boolean;
  className?: string;
  iconOnly?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const history = useCharacterAssetHistory(project, characterName, historyUrl, {
    enabled: open,
  });
  const restoreAsset = useRestoreCharacterAsset(project, characterName);

  if (!historyUrl || !restoreUrl) return null;

  const historyData = isOkResponse<CharacterAssetHistory>(history.data)
    ? history.data.data
    : null;
  const entries = historyData?.entries ?? [];
  const apiError =
    history.data && history.data.ok === false ? history.data.error : "";

  const handleRestore = async (entry: CharacterAssetHistoryEntry) => {
    try {
      const res = await restoreAsset.mutateAsync({
        restoreUrl,
        kind,
        historyId: entry.history_id,
        identityId,
      });
      if (res.ok === false) {
        toast.error(res.error || t("common.error"));
        return;
      }
      toast.success(t("characters.history.restored"));
      await history.refetch();
      setOpen(false);
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  return (
    <>
      <Button
        type="button"
        size={iconOnly ? "icon-xs" : "sm"}
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-label={t("characters.history.open")}
        title={t("characters.history.open")}
        className={cn(
          iconOnly
            ? "size-6 rounded-[4px] border-white/10 bg-black/45 p-0 text-white/80 shadow-none hover:bg-black/60"
            : "h-7 gap-1 rounded-[8px] px-2 text-xs",
          className,
        )}
      >
        <History className="size-3" />
        {iconOnly ? (
          <span className="sr-only">{t("characters.history.open")}</span>
        ) : (
          t("characters.history.short")
        )}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className={cn(CHARACTER_DIALOG_CONTENT_CLASS, "sm:max-w-3xl")}
        >
          <DialogHeader className="gap-2">
            <DialogTitle className="flex items-center gap-2 text-base font-medium tracking-tight">
              <History className="size-4" />
              {t("characters.history.title")}
            </DialogTitle>
            <DialogDescription>
              {t("characters.history.description")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid max-h-[70vh] gap-4 overflow-y-auto pr-1 md:grid-cols-[180px_minmax(0,1fr)]">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">
                {t("characters.history.current")}
              </Label>
              {historyData?.current_url ? (
                <LightboxImage
                  src={resolveMediaUrl(historyData.current_url) ?? ""}
                  alt={t("characters.history.current")}
                  className="aspect-square w-full rounded-[8px] bg-white/[0.025]"
                  fit="contain"
                />
              ) : (
                <div className="flex aspect-square w-full items-center justify-center rounded-[8px] border border-dashed border-border bg-background/40">
                  <ImageIcon className="size-8 text-muted-foreground/40" />
                </div>
              )}
            </div>

            <div className="min-w-0 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs text-muted-foreground">
                  {t("characters.history.entries")}
                </Label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void history.refetch()}
                  disabled={history.isFetching}
                  className="h-7 gap-1 rounded-[8px] px-2 text-xs"
                >
                  {history.isFetching ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3" />
                  )}
                  {t("characters.history.refresh")}
                </Button>
              </div>

              {history.isLoading ? (
                <div className="flex h-40 items-center justify-center rounded-[8px] border border-white/8 bg-white/[0.025] text-xs text-muted-foreground">
                  <Loader2 className="mr-2 size-3.5 animate-spin" />
                  {t("common.loading")}
                </div>
              ) : apiError ? (
                <div className="rounded-[8px] border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                  {apiError}
                </div>
              ) : entries.length === 0 ? (
                <div className="flex h-40 items-center justify-center rounded-[8px] border border-dashed border-border bg-background/40 text-xs text-muted-foreground">
                  {t("characters.history.empty")}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {entries.map((entry) => {
                    const restoring =
                      restoreAsset.isPending &&
                      restoreAsset.variables?.historyId === entry.history_id;
                    const createdAt = formatAssetHistoryTime(
                      entry.created_at,
                      i18n.language,
                    );
                    const sizeLabel = formatAssetHistoryBytes(entry.bytes);
                    return (
                      <div
                        key={entry.history_id}
                        className="rounded-[8px] border border-white/8 bg-white/[0.025] p-2"
                      >
                        <LightboxImage
                          src={resolveMediaUrl(entry.url) ?? ""}
                          alt={entry.filename}
                          className="aspect-square w-full rounded-[6px] bg-black/10"
                          fit="contain"
                        />
                        <div className="mt-2 min-w-0 space-y-1">
                          <p className="truncate text-xs font-medium">
                            {entry.filename}
                          </p>
                          {(createdAt || sizeLabel) && (
                            <p className="truncate text-[11px] text-muted-foreground">
                              {[createdAt, sizeLabel].filter(Boolean).join(" · ")}
                            </p>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void handleRestore(entry)}
                            disabled={restoreAsset.isPending}
                            className="mt-1 h-7 w-full gap-1 rounded-[8px] px-2 text-xs"
                          >
                            {restoring ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <RotateCcw className="size-3" />
                            )}
                            {restoring
                              ? t("characters.history.restoring")
                              : t("characters.history.restore")}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CharacterAvatar({
  character,
  size = "md",
}: {
  character: Character;
  size?: "sm" | "md" | "lg";
}) {
  const { gradient, initial } = useMemo(
    () => getProjectCover(character.name),
    [character.name],
  );
  const dim = size === "lg" ? "size-16" : size === "sm" ? "size-9" : "size-10";
  const textSize = size === "lg" ? "text-xl" : "text-sm";
  if (character.portrait_url) {
    return (
      <img
        src={resolveMediaUrl(character.portrait_url) ?? ""}
        alt={character.name}
        loading="lazy"
        decoding="async"
        className={cn(
          "shrink-0 rounded-full border border-border object-cover",
          dim,
        )}
      />
    );
  }
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-bold text-white/95",
        dim,
        textSize,
      )}
      style={{ background: gradient }}
    >
      {initial}
    </span>
  );
}

// ─── Top bar (spans full width) ──────────────────────────────────────────────

function CharactersPageHeader({
  onRebuild,
  rebuildDisabled,
  buildCharactersCostDisplay,
  onAdd,
  project,
  activeTab,
  setImageModel,
}: {
  onRebuild: () => void;
  rebuildDisabled: boolean;
  buildCharactersCostDisplay?: string | null;
  onAdd: () => void;
  project: string;
  activeTab: AssetTab;
  setImageModel: (model: string) => void;
}) {
  const { t } = useTranslation();
  const isCharactersTab = activeTab === "characters";

  return (
    <div className="flex shrink-0 flex-col gap-3 border-b border-border/30 bg-background px-9 py-5 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Waves className="size-[18px]" />
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
              {t("nav.assets")}
            </h1>
            <span className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {t(`characters.assetTabs.${activeTab}`)}
            </span>
            {isCharactersTab && <ProjectStyleChip project={project} />}
            {isCharactersTab && (
              <SaveStatus
                scope={saveScopes.charactersPage(project)}
                variant="header"
              />
            )}
          </div>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            {t(`characters.assetSubtitles.${activeTab}`)}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
        {isCharactersTab && (
          <>
            <CharacterImageSourceSelect
              project={project}
              className="shrink-0"
              disabled={rebuildDisabled}
              onSelectionChange={setImageModel}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={onAdd}
              className="h-8 gap-1.5 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none hover:bg-white/[0.04] dark:bg-transparent"
            >
              <Plus className="size-3.5" />
              {t("characters.addCharacter")}
            </Button>
            <Button
              size="sm"
              onClick={onRebuild}
              disabled={rebuildDisabled}
              className="h-8 gap-1.5 rounded-[8px] bg-primary px-3 text-xs font-normal text-primary-foreground shadow-none hover:bg-primary/85 active:bg-primary/75"
            >
              <RefreshCw className="size-3.5" />
              {t("characters.autoExtract")}
              <CreditCostInline
                display={buildCharactersCostDisplay}
                className="text-primary-foreground"
                iconClassName="text-primary-foreground drop-shadow-none [&_path]:fill-current"
              />
            </Button>
          </>
        )}
        <AssetHeaderActionsTarget className="contents" />
      </div>
    </div>
  );
}

function AssetTabs({
  value,
  onChange,
}: {
  value: AssetTab;
  onChange: (value: AssetTab) => void;
}) {
  const { t } = useTranslation();
  const tabs: { value: AssetTab; icon: React.ElementType }[] = [
    { value: "characters", icon: Users },
    { value: "scenes", icon: Map },
    { value: "props", icon: Package },
    { value: "voices", icon: Mic2 },
  ];

  return (
    <div className="flex shrink-0 justify-center border-b border-border/30 bg-background px-9 py-3">
      <SlidingTabs
        items={tabs.map(({ value: tab, icon }) => ({
          value: tab,
          icon,
          label: t(`characters.assetTabs.${tab}`),
        }))}
        value={value}
        onValueChange={onChange}
        aria-label={t("nav.assets")}
      />
    </div>
  );
}

// ─── Middle: Character list item ─────────────────────────────────────────────

function CharacterListItem({
  character,
  selected,
  onSelect,
  mainCharacterLabel,
}: {
  character: Character;
  selected: boolean;
  onSelect: () => void;
  mainCharacterLabel: string;
}) {
  const { t } = useTranslation();
  const ageKey = labelKeyFor(AGE_GROUP_OPTIONS, character.age_group);
  const metaParts = [
    ageKey ? t(ageKey) : undefined,
    character.gender || undefined,
    character.body_type || undefined,
  ].filter(Boolean);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[8px] border px-2.5 py-2 text-left transition-colors",
        "hover:border-white/10 hover:bg-white/[0.035]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-primary/50 bg-primary/[0.035]"
          : "border-transparent bg-transparent",
      )}
    >
      <CharacterAvatar character={character} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-foreground">
            {character.name}
          </span>
          {character.is_main && (
            <span
              className="inline-flex items-center gap-0.5 text-xs font-medium text-primary"
              title={mainCharacterLabel}
            >
              <Star className="size-3.5 fill-current" />
            </span>
          )}
        </div>
        {metaParts.length > 0 && (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {metaParts.join(" · ")}
          </p>
        )}
      </div>
    </button>
  );
}

// ─── Right detail: SECTIONS (all flat, no tabs) ──────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <Label className="text-xs font-medium leading-4 text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint && (
        <p className="-mt-0.5 text-xs leading-4 text-muted-foreground/70">
          {hint}
        </p>
      )}
    </div>
  );
}

// Full-width header: gender + name + role chip + toggle-main + delete
function CharacterHeaderRow({
  character,
  project,
  detailsScope,
  mainCopy,
  onDeleted,
}: {
  character: Character;
  project: string;
  detailsScope: string;
  mainCopy: CharacterMainCopy;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const updateChar = useUpdateCharacter(project, character.name);
  const deleteChar = useDeleteCharacter(project);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [freezonePending, setFreezonePending] = useState(false);
  const roleLabel = character.role ?? "";

  const handleToggleMain = async () => {
    try {
      await updateChar.mutateAsync({ is_main: !character.is_main });
      toast.success(
        character.is_main
          ? mainCopy.mainUnset
          : mainCopy.mainSet,
      );
    } catch {
      toast.error(t("common.error"));
    }
  };

  const confirmDelete = async () => {
    try {
      await deleteChar.mutateAsync(character.name);
      setDeleteOpen(false);
      toast.success(t("characters.toasts.deleted"));
      onDeleted();
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleOpenCharacterFreezone = async () => {
    setFreezonePending(true);
    try {
      await openFreezonePresetCanvas({
        project,
        request: {
          scope: "asset",
          asset_kind: "character",
          character: character.name,
        },
      });
      toast.success(t("characters.freezone.opened"));
    } catch {
      toast.error(t("characters.freezone.openFailed"));
    } finally {
      setFreezonePending(false);
    }
  };

  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1 flex flex-wrap items-center gap-2">
        {character.gender === "男" && (
          <Mars className="size-4 text-sky-400" aria-hidden />
        )}
        {character.gender === "女" && (
          <Venus className="size-4 text-pink-400" aria-hidden />
        )}
        <h2 className="truncate text-[19px] font-semibold tracking-tight text-foreground">
          {character.name}
        </h2>
        {(roleLabel || character.is_main) && (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
              character.is_main
                ? "border border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                : "border border-border bg-background/60 text-muted-foreground",
            )}
          >
            {character.is_main && <Star className="size-2.5 fill-current" />}
            {character.is_main ? mainCopy.label : roleLabel}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <div className="flex h-8 min-w-[112px] items-center justify-end">
          <SaveStatus scope={detailsScope} variant="inline" />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleOpenCharacterFreezone}
          disabled={freezonePending}
          className="gap-1.5 rounded-[8px] border border-white/12 bg-white/[0.035] text-foreground shadow-none transition-colors hover:border-white/22 hover:bg-white/[0.075] hover:text-white dark:bg-white/[0.035] disabled:border-transparent disabled:bg-transparent disabled:text-muted-foreground disabled:hover:border-transparent disabled:hover:bg-transparent"
          title={t("characters.freezone.openCharacterTip")}
        >
          {freezonePending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ExternalLink className="size-3.5" />
          )}
          {t("characters.freezone.openCharacter")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleToggleMain}
          disabled={updateChar.isPending}
          className={cn("gap-1.5", character.is_main && "text-primary")}
        >
          <Star
            className={cn("size-3.5", character.is_main && "fill-current")}
          />
          {character.is_main ? mainCopy.unsetMain : mainCopy.makeMain}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setDeleteOpen(true)}
          disabled={deleteChar.isPending}
          aria-label={t("characters.drawer.deleteChar")}
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("characters.drawer.deleteChar")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("characters.confirm.delete", { name: character.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={confirmDelete}
            >
              {deleteChar.isPending && (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              )}
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// Portrait block — image + generate/upload actions + attempt state
function PortraitBlock({
  character,
  project,
  imageModel,
  attemptCount,
  onAttempt,
}: {
  character: Character;
  project: string;
  imageModel?: string;
  attemptCount: number;
  onAttempt: () => void;
}) {
  const { t } = useTranslation();
  const genPortrait = useGeneratePortraitAsync(project, character.name);
  const uploadPortrait = useUploadPortrait(project, character.name);
  const portraitCostRes = useGenerationCreditCost("image_selection", imageModel, {
    surface: "supertale",
    imageRole: "character",
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [genConfirm, setGenConfirm] = useState(false);

  const portraitScope = `character:${character.name}:portrait`;

  // Task controller tracks the async portrait task by the backend scope so
  // re-generating a different character doesn't steal this card's progress.
  const portraitTask = useTaskController({
    key: {
      taskType: "character_portrait",
      project,
      episode: 0,
      scope: portraitScope,
    },
    invalidateKeys: [queryKeys.characters(project)],
    onError: () => toast.error(t("common.error")),
  });

  const handleGenerate = async () => {
    onAttempt();
    try {
      const res = await genPortrait.mutateAsync({
        model: imageModel || undefined,
      });
      if (res.ok === false) {
        toast.error(res.error || t("common.error"));
        return;
      }
      portraitTask.start({ scope: res.scope });
      toast.success(t("characters.toasts.imageGenerating"));
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const genBusy = genPortrait.isPending || portraitTask.started;
  const portraitCost = isOkResponse<{ display: string }>(portraitCostRes.data)
    ? portraitCostRes.data.data.display
    : "";

  return (
    <div className="flex w-full flex-col items-start gap-2">
      {character.portrait_url ? (
        <LightboxImage
          src={resolveMediaUrl(character.portrait_url) ?? ""}
          alt={character.name}
          className="aspect-square w-full max-w-[180px] rounded-[8px]"
        />
      ) : (
        <div className="flex aspect-square w-full max-w-[180px] items-center justify-center rounded-[8px] border border-dashed border-border bg-background/40">
          <ImageIcon className="size-10 text-muted-foreground/40" />
        </div>
      )}
      <div className="flex w-full max-w-[180px] flex-col gap-1.5">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setGenConfirm(true)}
          disabled={genBusy}
          className="relative h-7 w-full gap-1 rounded-[8px] px-2 text-xs"
        >
          {genBusy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Sparkles className="size-3" />
          )}
          {character.portrait_url
            ? t("characters.portrait.regenerate")
            : t("characters.summary.generateNew")}
          <CreditCostInline display={portraitCost} />
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadPortrait.isPending}
          className="h-7 w-full gap-1 rounded-[8px] px-2 text-xs"
        >
          <Upload className="size-3" />
          {t("characters.summary.uploadImage")}
        </Button>
        <CharacterAssetHistoryButton
          project={project}
          characterName={character.name}
          kind="portrait"
          historyUrl={character.history_url}
          restoreUrl={character.restore_url}
          className="h-7 w-full justify-center gap-1 rounded-[8px] px-2 text-xs"
        />
      </div>
      {attemptCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("characters.portrait.attemptsBadge", { count: attemptCount })}
        </p>
      )}
      {attemptCount >= ATTEMPT_WARN_THRESHOLD && (
        <div className="flex w-full items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{t("characters.portrait.attemptsWarning")}</span>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept="image/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            uploadPortrait
              .mutateAsync(file)
              .then(() => toast.success(t("common.upload") + " ✓"))
              .catch(() => toast.error(t("common.error")));
          }
          e.target.value = "";
        }}
      />
      <AlertDialog open={genConfirm} onOpenChange={setGenConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("characters.generatePortraitTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("characters.generatePortraitDesc")}
              {character.portrait_url
                ? t("characters.generatePortraitReplace")
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setGenConfirm(false);
                handleGenerate();
              }}
            >
              {t("common.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// Details form card — all editable fields with a single explicit save
function DetailsFormCard({
  character,
  project,
  onRenamed,
}: {
  character: Character;
  project: string;
  onRenamed?: (nextName: string) => void;
}) {
  const { t } = useTranslation();
  const updateChar = useUpdateCharacter(project, character.name);
  const detailsScope = saveScopes.characterDetails(project, character.name);

  const [displayName, setDisplayName] = useState(character.name);
  const [role, setRole] = useState(character.role ?? "");
  const [bodyType, setBodyType] = useState(character.body_type ?? "");
  const [aliases, setAliases] = useState((character.aliases ?? []).join(", "));
  const [desc, setDesc] = useState(character.description ?? "");
  const [facePrompt, setFacePrompt] = useState(character.face_prompt ?? "");

  useEffect(() => {
    setDisplayName(character.name);
    setRole(character.role ?? "");
    setBodyType(character.body_type ?? "");
    setAliases((character.aliases ?? []).join(", "));
    setDesc(character.description ?? "");
    setFacePrompt(character.face_prompt ?? "");
  }, [
    character.name,
    character.role,
    character.body_type,
    character.aliases,
    character.description,
    character.face_prompt,
  ]);

  const handleInstantSelect = async (
    field: "gender" | "age_group",
    value: string | null,
  ) => {
    if (value == null) return;
    try {
      await trackSave(detailsScope, () =>
        updateChar.mutateAsync({ [field]: value }),
      );
    } catch {
      toast.error(t("common.error"));
    }
  };

  const saveField = async (data: Record<string, unknown>) => {
    try {
      await trackSave(detailsScope, () => updateChar.mutateAsync(data));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleBlurName = async () => {
    const nextName = displayName.trim();
    if (!nextName) {
      setDisplayName(character.name);
      return;
    }
    if (nextName === character.name) {
      setDisplayName(nextName);
      return;
    }
    try {
      await trackSave(detailsScope, () =>
        updateChar.mutateAsync({ name: nextName }),
      );
      onRenamed?.(nextName);
    } catch {
      setDisplayName(character.name);
      toast.error(t("common.error"));
    }
  };

  const handleBlurRole = () => {
    if (role !== (character.role ?? "")) saveField({ role: role || undefined });
  };
  const handleBlurBodyType = () => {
    if (bodyType !== (character.body_type ?? ""))
      saveField({ body_type: bodyType || undefined });
  };
  const handleBlurAliases = () => {
    const prev = (character.aliases ?? []).join(", ");
    if (aliases !== prev) {
      const parsed = aliases
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      saveField({ aliases: parsed });
    }
  };
  const handleBlurDesc = () => {
    if (desc !== (character.description ?? ""))
      saveField({ description: desc || undefined });
  };
  const handleBlurFacePrompt = () => {
    if (facePrompt !== (character.face_prompt ?? ""))
      saveField({ face_prompt: facePrompt || undefined });
  };

  return (
    <div className="min-w-0">
      <div className="grid grid-cols-1 gap-5 @[900px]:grid-cols-[minmax(200px,0.78fr)_minmax(220px,0.86fr)_minmax(0,1.55fr)]">
        {/* Column 1: base attributes */}
        <div className="space-y-3">
          <Field label={t("characters.basics.name")}>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onBlur={handleBlurName}
              className={CHARACTER_INPUT_CLASS}
            />
          </Field>
          <Field label={t("characters.basics.role")}>
            <Input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              onBlur={handleBlurRole}
              placeholder={t("characters.rolePlaceholder")}
              className={CHARACTER_INPUT_CLASS}
            />
          </Field>
          <Field label={t("characters.basics.gender")}>
            <Select
              value={character.gender ?? ""}
              onValueChange={(v) => handleInstantSelect("gender", v)}
            >
              <SelectTrigger className={CHARACTER_SELECT_TRIGGER_CLASS}>
                <SelectValue placeholder={t("ingest.selectPlaceholder")}>
                  {(val: string) => {
                    const key = labelKeyFor(GENDER_OPTIONS, val);
                    return key ? t(key) : val;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                alignItemWithTrigger={false}
                sideOffset={8}
                className={CHARACTER_SELECT_CONTENT_CLASS}
              >
                {GENDER_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {t(o.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        {/* Column 2: aliases + age/body */}
        <div className="space-y-3">
          <Field label={t("characters.basics.aliases")}>
            <Input
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              onBlur={handleBlurAliases}
              placeholder={`${t("characters.aliasesPlaceholder")}，${t(
                "characters.basics.aliasesHint",
              )}`}
              className={CHARACTER_INPUT_CLASS}
            />
          </Field>
          <Field label={t("characters.basics.ageGroup")}>
            <Select
              value={character.age_group ?? ""}
              onValueChange={(v) => handleInstantSelect("age_group", v)}
            >
              <SelectTrigger className={CHARACTER_SELECT_TRIGGER_CLASS}>
                <SelectValue placeholder={t("ingest.selectPlaceholder")}>
                  {(val: string) => {
                    const key = labelKeyFor(AGE_GROUP_OPTIONS, val);
                    return key ? t(key) : val;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                alignItemWithTrigger={false}
                sideOffset={8}
                className={CHARACTER_SELECT_CONTENT_CLASS}
              >
                {AGE_GROUP_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {t(o.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("characters.basics.bodyType")}>
            <Input
              value={bodyType}
              onChange={(e) => setBodyType(e.target.value)}
              onBlur={handleBlurBodyType}
              placeholder={t("characters.bodyTypePlaceholder")}
              className={CHARACTER_INPUT_CLASS}
            />
          </Field>
        </div>

        {/* Column 3: prompts */}
        <div className="min-w-0 space-y-3">
          <Field label={t("characters.basics.description")}>
            <textarea
              className={cn(CHARACTER_TEXTAREA_CLASS, "min-h-[96px]")}
              rows={3}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              onBlur={handleBlurDesc}
            />
          </Field>
          <Field label={t("characters.basics.facePrompt")}>
            <textarea
              className={cn(CHARACTER_TEXTAREA_CLASS, "min-h-[96px]")}
              rows={3}
              value={facePrompt}
              onChange={(e) => setFacePrompt(e.target.value)}
              onBlur={handleBlurFacePrompt}
              placeholder="oval face, big eyes…"
            />
          </Field>
        </div>
      </div>
    </div>
  );
}

// Identity card — two image slots (body + costume) with full action set
function IdentityCard({
  identity,
  project,
  characterName,
  characterAgeGroup,
  imageModel,
  ageLabel,
  roleLabel,
  referenceCount = 0,
  references = [],
  onAttempt,
}: {
  identity: Identity;
  project: string;
  characterName: string;
  characterAgeGroup?: string;
  imageModel?: string;
  ageLabel: string;
  roleLabel: string;
  referenceCount?: number;
  references?: BeatReference[];
  onAttempt: () => void;
}) {
  const { t } = useTranslation();
  const updateIdentity = useUpdateIdentity(project, characterName);
  const deleteIdentity = useDeleteIdentity(project, characterName);
  const deleteIdentityImage = useDeleteIdentityImage(project, characterName);
  const deleteCostume = useDeleteIdentityCostume(project, characterName);
  const genImg = useGenerateIdentityImageAsync(project, characterName);
  const uploadImg = useUploadIdentityImage(project, characterName);
  const uploadCostume = useUploadCostumeImage(project, characterName);
  const uploadPortrait = useUploadIdentityPortrait(project, characterName);
  const genPortrait = useGenerateIdentityPortraitAsync(project, characterName);
  const identityCostRes = useGenerationCreditCost("image_selection", imageModel, {
    surface: "supertale",
    imageRole: "identity",
  });
  const identityImageScope = `character:${characterName}:identity:${identity.identity_name}`;
  const identityPortraitScope = `character:${characterName}:identity_portrait:${identity.identity_name}`;
  const identityImageTask = useTaskController({
    key: {
      taskType: "identity_image",
      project,
      episode: 0,
      scope: identityImageScope,
    },
    invalidateKeys: [queryKeys.identities(project, characterName)],
    onError: () => toast.error(t("common.error")),
  });
  const identityPortraitTask = useTaskController({
    key: {
      taskType: "character_portrait",
      project,
      episode: 0,
      scope: identityPortraitScope,
    },
    invalidateKeys: [queryKeys.identities(project, characterName)],
    onError: () => toast.error(t("common.error")),
  });
  const attemptsRes = useIdentityAttempts(
    project,
    characterName,
    identity.identity_id,
  );

  const identityAge = identity.age_group ?? "";
  const isAgeVariant =
    !!identityAge && identityAge !== (characterAgeGroup ?? "");

  const [appearance, setAppearance] = useState(
    identity.appearance_details ?? "",
  );
  const [facePrompt, setFacePrompt] = useState(identity.face_prompt ?? "");
  const [bodyType, setBodyType] = useState(identity.body_type ?? "");

  const imageInputRef = useRef<HTMLInputElement>(null);
  const costumeInputRef = useRef<HTMLInputElement>(null);
  const portraitInputRef = useRef<HTMLInputElement>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteImageOpen, setDeleteImageOpen] = useState(false);
  const [confirmGenOpen, setConfirmGenOpen] = useState(false);
  const [confirmGenPortraitOpen, setConfirmGenPortraitOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(identity.identity_name);

  const identityAttempts = isOkResponse<IdentityAttempts>(attemptsRes.data)
    ? attemptsRes.data.data
    : undefined;
  const imageAttempts = identityAttempts?.image_attempts ?? 0;
  const portraitAttempts = identityAttempts?.portrait_attempts ?? 0;
  const identityCost = isOkResponse<{ display: string }>(identityCostRes.data)
    ? identityCostRes.data.data.display
    : "";
  const identityCreditButtonClass =
    isCeRuntime()
      ? "h-7 gap-1 rounded-[8px] px-2 text-xs transition-transform active:scale-95"
      : "relative h-7 gap-1 rounded-[8px] px-2 pr-9 text-xs transition-transform active:scale-95";
  const identityCreditDialogActionClass =
    isCeRuntime()
      ? "transition-transform active:scale-95"
      : "relative border-[3px] border-[#007A87] bg-transparent pr-9 transition-transform hover:border-[#007A87] hover:bg-transparent active:scale-95 dark:border-[#007A87] dark:hover:border-[#007A87]";

  useEffect(() => {
    setAppearance(identity.appearance_details ?? "");
    setFacePrompt(identity.face_prompt ?? "");
    setBodyType(identity.body_type ?? "");
    setRenameValue(identity.identity_name);
  }, [
    identity.identity_id,
    identity.identity_name,
    identity.appearance_details,
    identity.face_prompt,
    identity.body_type,
    identity.age_group,
    identity.portrait_image_url,
  ]);

  const appearanceDirty = appearance !== (identity.appearance_details ?? "");
  const refsDirty =
    facePrompt !== (identity.face_prompt ?? "") ||
    bodyType !== (identity.body_type ?? "");

  const bumpAttempt = () => {
    onAttempt();
    attemptsRes.refetch();
  };

  const handleSaveAppearance = async () => {
    try {
      await updateIdentity.mutateAsync({
        identityId: identity.identity_id,
        data: { appearance_details: appearance },
      });
      toast.success(t("characters.toasts.identityUpdated"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleSaveRefs = async () => {
    try {
      await updateIdentity.mutateAsync({
        identityId: identity.identity_id,
        data: {
          face_prompt: facePrompt,
          body_type: bodyType,
        },
      });
      toast.success(t("characters.toasts.identityUpdated"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleAgeGroupChange = async (value: string) => {
    try {
      await updateIdentity.mutateAsync({
        identityId: identity.identity_id,
        data: { age_group: value },
      });
      toast.success(t("characters.toasts.identityUpdated"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const confirmDelete = async () => {
    try {
      await deleteIdentity.mutateAsync(identity.identity_id);
      setDeleteOpen(false);
      toast.success(t("characters.toasts.identityDeleted"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const runGenImage = async () => {
    bumpAttempt();
    try {
      const res = await genImg.mutateAsync({
        identityId: identity.identity_id,
        model: imageModel || undefined,
      });
      if (res.ok === false) {
        toast.error(res.error || t("common.error"));
        return;
      }
      identityImageTask.start({ scope: res.scope });
      toast.success(t("characters.toasts.imageGenerating"));
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handleGenImage = () => {
    setConfirmGenOpen(true);
  };


  const runGenPortrait = async () => {
    bumpAttempt();
    try {
      const res = await genPortrait.mutateAsync({
        identityId: identity.identity_id,
        model: imageModel || undefined,
      });
      if (res.ok === false) {
        toast.error(res.error || t("common.error"));
        return;
      }
      identityPortraitTask.start({ scope: res.scope });
      toast.success(t("characters.toasts.imageGenerating"));
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handleGenPortrait = () => {
    if (!isAgeVariant) {
      toast.error(t("characters.identities.variantOnly"));
      return;
    }
    if (!facePrompt.trim()) {
      toast.error(t("characters.identities.portraitNeedsFacePrompt"));
      return;
    }
    setConfirmGenPortraitOpen(true);
  };

  const handleDeleteImage = async () => {
    try {
      await deleteIdentityImage.mutateAsync(identity.identity_id);
      setDeleteImageOpen(false);
      toast.success(t("characters.identities.imageDeleted"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleDeleteCostume = async () => {
    try {
      await deleteCostume.mutateAsync(identity.identity_id);
      toast.success(t("characters.identities.costumeDeleted"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleRename = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === identity.identity_name) {
      setRenameOpen(false);
      return;
    }
    try {
      await updateIdentity.mutateAsync({
        identityId: identity.identity_id,
        data: { identity_name: trimmed },
      });
      setRenameOpen(false);
      toast.success(t("characters.toasts.identityUpdated"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  return (
    <article className="@container flex flex-col gap-4 rounded-[10px] border border-white/[0.06] bg-white/[0.035] p-5 pb-3">
      {/* Header: name + chips + delete */}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 flex flex-wrap items-center gap-1.5">
          <h4 className="truncate text-sm font-semibold text-foreground">
            {identity.identity_name}
          </h4>
          <code className="truncate rounded-[5px] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {identity.identity_id}
          </code>
          {isAgeVariant && (
            <span className="inline-flex items-center rounded-[6px] border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">
              {(() => {
                const lk = labelKeyFor(AGE_GROUP_OPTIONS, identityAge);
                return lk ? t(lk) : identityAge;
              })()}
              {t("characters.identities.variantSuffix")}
            </span>
          )}
          {roleLabel && !isAgeVariant && (
            <span className="inline-flex items-center rounded-[6px] border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">
              {roleLabel}
            </span>
          )}
          {!isAgeVariant && !roleLabel && ageLabel && (
            <span className="inline-flex items-center rounded-[6px] border border-border bg-background/40 px-1.5 py-0.5 text-xs text-muted-foreground">
              {ageLabel}
            </span>
          )}
          <UsageCountBadge count={referenceCount} />
        </div>
        <CopyAssetLinkButton type="identity" id={identity.identity_id} />
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => setRenameOpen(true)}
          aria-label={t("characters.identities.renameIdentity")}
          className="text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
        >
          <Pencil className="size-3.5" />
        </Button>
        <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <AlertDialogTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("characters.identities.deleteIdentity")}
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </Button>
            }
          />
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("characters.identities.deleteIdentity")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("characters.confirm.deleteIdentity", {
                  name: identity.identity_name,
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={confirmDelete}
                disabled={deleteIdentity.isPending}
              >
                {t("common.delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Hero row: identity image (left) + appearance editor (right) */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[180px_minmax(0,1fr)] xl:grid-cols-[200px_minmax(0,1fr)]">
        {/* Identity image preview */}
        <div className="relative">
          {identity.image_url ? (
            <LightboxImage
              src={resolveMediaUrl(identity.image_url) ?? ""}
              alt={identity.identity_name}
              className="aspect-[4/3] w-full rounded-[8px] bg-white/[0.025]"
              fit="contain"
            />
          ) : (
            <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 rounded-[8px] border border-dashed border-border bg-background/40 text-muted-foreground/50">
              <UserSquare2 className="size-8" />
              <span className="text-xs">
                {t("characters.identities.heroEmpty")}
              </span>
            </div>
          )}
          {identity.image_url && (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              onClick={(e) => { e.stopPropagation(); setDeleteImageOpen(true); }}
              disabled={deleteIdentityImage.isPending}
              aria-label={t("characters.identities.deleteImage")}
              className="absolute right-1.5 top-1.5 z-20 size-6 rounded-[4px] bg-black/50 p-0 text-white/70 hover:bg-destructive/30 hover:text-destructive backdrop-blur-sm"
            >
              {deleteIdentityImage.isPending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Trash2 className="size-3" />
              )}
            </Button>
          )}
        </div>

        {/* Appearance editor + primary actions */}
        <div className="flex min-w-0 flex-col gap-2.5">
          <Label className="flex items-center gap-1 text-xs font-medium leading-4 text-muted-foreground">
            {t("characters.identities.appearanceHeading")}
          </Label>
          <textarea
            className={cn(CHARACTER_TEXTAREA_CLASS, "min-h-[84px] flex-1")}
            value={appearance}
            onChange={(e) => setAppearance(e.target.value)}
            placeholder={t("characters.identities.appearancePlaceholder")}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className={identityCreditButtonClass}
              onClick={handleGenImage}
              disabled={
                genImg.isPending ||
                identityImageTask.started ||
                !appearance.trim()
              }
            >
              {genImg.isPending || identityImageTask.started ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Sparkles className="size-3" />
              )}
              {identity.image_url
                ? t("characters.identities.regenerate")
                : t("characters.identities.generate")}
              <CreditCostInline display={identityCost} />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 rounded-[8px] px-2 text-xs"
              onClick={() => imageInputRef.current?.click()}
            >
              <Upload className="size-3" />
              {t("characters.identities.upload")}
            </Button>
            <CharacterAssetHistoryButton
              project={project}
              characterName={characterName}
              kind="identity"
              identityId={identity.identity_id}
              historyUrl={identity.history_url}
              restoreUrl={identity.restore_url}
            />
            {identity.image_url && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 rounded-[8px] px-2 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDeleteImageOpen(true)}
                disabled={deleteIdentityImage.isPending}
              >
                {deleteIdentityImage.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Trash2 className="size-3" />
                )}
                {t("characters.identities.deleteImage")}
              </Button>
            )}
            {appearanceDirty && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-7 gap-1 rounded-[8px] px-2 text-xs"
                onClick={handleSaveAppearance}
                disabled={updateIdentity.isPending}
              >
                {updateIdentity.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Save className="size-3" />
                )}
                {t("characters.identities.saveAppearance")}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Refs: costume reference + age variant fields (always visible) */}
      <div className="border-t border-white/[0.06] pt-4">
        <div className="mb-4 flex items-center gap-2 text-xs font-medium leading-4 text-muted-foreground">
          <Sliders className="size-3" />
          {t("characters.identities.refsTitle")}
        </div>
        <div className="grid grid-cols-1 gap-5">
          {/* Costume reference */}
          <div className="grid grid-cols-[64px_1fr] gap-3">
            <div className="relative flex flex-col">
              {identity.costume_image_url ? (
                <>
                  <LightboxImage
                    src={resolveMediaUrl(identity.costume_image_url) ?? ""}
                    alt={`${identity.identity_name} ${t("characters.costumeAlt")}`}
                    className="aspect-square w-16 rounded-[8px]"
                  />
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    onClick={(e) => { e.stopPropagation(); handleDeleteCostume(); }}
                    disabled={deleteCostume.isPending || uploadCostume.isPending}
                    aria-label={t("characters.identities.deleteCostume")}
                    className="absolute right-1 top-1 z-20 size-5 rounded-[4px] bg-black/50 p-0 text-white/70 hover:bg-destructive/30 hover:text-destructive backdrop-blur-sm"
                  >
                    {deleteCostume.isPending ? (
                      <Loader2 className="size-2.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-2.5" />
                    )}
                  </Button>
                </>
              ) : (
                <div className="flex h-full w-full flex-1 flex-col items-center justify-center gap-1 rounded-[8px] border border-dashed border-white/10 bg-white/[0.02]">
                  <Shirt className="size-5 text-muted-foreground/40" />
                  <span className="text-[10px] text-muted-foreground/40">
                    {t("characters.identities.costumeRef")}
                  </span>
                </div>
              )}
            </div>
            <div className="flex flex-col justify-center gap-1">
              <Label className="text-xs font-medium leading-4 text-muted-foreground">
                {t("characters.identities.costumeRef")}
              </Label>
              <p className="text-xs leading-relaxed text-muted-foreground/70">
                {t("characters.identities.costumeRefHint")}
              </p>
              <div className="mt-1 flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 w-fit gap-1 rounded-[8px] border-white/10 bg-transparent px-2 text-xs font-normal shadow-none hover:bg-white/[0.04] dark:bg-transparent"
                  onClick={() => costumeInputRef.current?.click()}
                  disabled={uploadCostume.isPending || deleteCostume.isPending}
                >
                  {uploadCostume.isPending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Upload className="size-3" />
                  )}
                  {identity.costume_image_url
                    ? t("characters.identities.replaceCostume")
                    : t("characters.identities.uploadCostume")}
                </Button>
                <CharacterAssetHistoryButton
                  project={project}
                  characterName={characterName}
                  kind="identity_costume"
                  identityId={identity.identity_id}
                  historyUrl={identity.costume_history_url}
                  restoreUrl={identity.restore_url}
                  disabled={uploadCostume.isPending || deleteCostume.isPending}
                  className="h-7 w-fit gap-1 rounded-[8px] border-white/10 bg-transparent px-2 text-xs font-normal shadow-none hover:bg-white/[0.04] dark:bg-transparent"
                />
              </div>
            </div>
          </div>

          {/* Age variant fields */}
          <div className="border-t border-white/[0.06] pt-5">
            <div className="mb-3 flex items-center gap-2 text-xs font-medium leading-4 text-muted-foreground">
              <UserSquare2 className="size-3" />
              {t("characters.identities.ageVariantTitle")}
            </div>
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground/70">
              {t("characters.identities.ageVariantHint")}
            </p>
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">
                    {t("characters.basics.ageGroup")}
                  </Label>
                  <Select
                    value={identityAge || "__none__"}
                    onValueChange={(v) =>
                      handleAgeGroupChange(v === "__none__" ? "" : (v ?? ""))
                    }
                  >
                    <SelectTrigger className={CHARACTER_SELECT_TRIGGER_CLASS}>
                      <SelectValue>
                        {(val: string) =>
                          !val || val === "__none__"
                            ? t("characters.identities.inheritFromCharacter")
                            : (() => {
                                const lk = labelKeyFor(
                                  AGE_GROUP_OPTIONS,
                                  val,
                                );
                                return lk ? t(lk) : val;
                              })()
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent
                      alignItemWithTrigger={false}
                      sideOffset={8}
                      className={CHARACTER_SELECT_CONTENT_CLASS}
                    >
                      <SelectItem value="__none__">
                        {t("characters.identities.inheritFromCharacter")}
                      </SelectItem>
                      {AGE_GROUP_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {t(o.labelKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">
                    {t("characters.basics.bodyType")}
                  </Label>
                  <Input
                    value={bodyType}
                    onChange={(e) => setBodyType(e.target.value)}
                    onBlur={() => {
                      if (refsDirty) handleSaveRefs();
                    }}
                    className={CHARACTER_INPUT_CLASS}
                    placeholder={t(
                      "characters.identities.bodyTypePlaceholder",
                    )}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  {t("characters.basics.facePrompt")}
                </Label>
                <textarea
                  className={CHARACTER_TEXTAREA_CLASS}
                  rows={2}
                  value={facePrompt}
                  onChange={(e) => setFacePrompt(e.target.value)}
                  onBlur={() => {
                    if (refsDirty) handleSaveRefs();
                  }}
                  placeholder={t("characters.basics.facePromptHint")}
                />
              </div>

              {/* Identity-level face portrait */}
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  {t("characters.identities.portraitTitle")}
                </Label>
                <div className="grid grid-cols-[56px_1fr] gap-3">
                  {identity.portrait_image_url ? (
                    <LightboxImage
                      src={resolveMediaUrl(identity.portrait_image_url) ?? ""}
                      alt={`${identity.identity_name} portrait`}
                      className="size-14 rounded-[8px]"
                    />
                  ) : (
                    <div
                      className={cn(
                        "flex size-14 items-center justify-center rounded-[8px] border border-dashed border-border bg-background/40",
                        !isAgeVariant && "opacity-50",
                      )}
                    >
                      <UserSquare2 className="size-5 text-muted-foreground/40" />
                    </div>
                  )}
                  <TooltipProvider delay={200}>
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs leading-snug text-muted-foreground/70">
                        {!isAgeVariant
                          ? t("characters.identities.variantOnly")
                          : identity.portrait_image_url
                            ? t("characters.identities.portraitReady")
                            : facePrompt.trim()
                              ? t("characters.identities.portraitMissing")
                              : t(
                                  "characters.identities.portraitNeedsFacePrompt",
                                )}
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="sm"
                                variant="outline"
                                className={identityCreditButtonClass}
                                onClick={handleGenPortrait}
                                disabled={
                                  genPortrait.isPending ||
                                  identityPortraitTask.started ||
                                  !isAgeVariant ||
                                  !facePrompt.trim()
                                }
                              >
                                {genPortrait.isPending ||
                                identityPortraitTask.started ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  <Sparkles className="size-3" />
                                )}
                                {identity.portrait_image_url
                                  ? t("characters.identities.regenerate")
                                  : t("characters.identities.generate")}
                                <CreditCostInline display={identityCost} />
                              </Button>
                            }
                          />
                          <TooltipContent>
                            {!isAgeVariant
                              ? t("characters.identities.variantOnly")
                              : !facePrompt.trim()
                                ? t(
                                    "characters.identities.portraitNeedsFacePrompt",
                                  )
                                : t(
                                    "characters.identities.generatePortraitTip",
                                  )}
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1 rounded-[8px] px-2 text-xs"
                                onClick={() => {
                                  if (!isAgeVariant) {
                                    toast.error(
                                      t("characters.identities.variantOnly"),
                                    );
                                    return;
                                  }
                                  portraitInputRef.current?.click();
                                }}
                                disabled={
                                  uploadPortrait.isPending || !isAgeVariant
                                }
                              >
                                {uploadPortrait.isPending ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  <Upload className="size-3" />
                                )}
                                {t("characters.identities.upload")}
                              </Button>
                            }
                          />
                          <TooltipContent>
                            {!isAgeVariant
                              ? t("characters.identities.variantOnly")
                              : t("characters.identities.uploadPortraitTip")}
                          </TooltipContent>
                        </Tooltip>
                        <CharacterAssetHistoryButton
                          project={project}
                          characterName={characterName}
                          kind="identity_portrait"
                          identityId={identity.identity_id}
                          historyUrl={identity.portrait_history_url}
                          restoreUrl={identity.restore_url}
                          disabled={!isAgeVariant}
                        />
                      </div>
                    </div>
                  </TooltipProvider>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Hidden file inputs */}
      <input
        ref={imageInputRef}
        type="file"
        className="hidden"
        accept="image/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            uploadImg
              .mutateAsync({ identityName: identity.identity_name, file })
              .then(() => toast.success(t("characters.toasts.imageUploading")))
              .catch(() => toast.error(t("common.error")));
          }
          e.target.value = "";
        }}
      />
      <input
        ref={costumeInputRef}
        type="file"
        className="hidden"
        accept="image/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            uploadCostume
              .mutateAsync({ identityId: identity.identity_id, file })
              .then(() => toast.success(t("characters.toasts.imageUploading")))
              .catch(() => toast.error(t("common.error")));
          }
          e.target.value = "";
        }}
      />
      <input
        ref={portraitInputRef}
        type="file"
        className="hidden"
        accept="image/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            uploadPortrait
              .mutateAsync({ identityId: identity.identity_id, file })
              .then(() => toast.success(t("characters.toasts.imageUploading")))
              .catch(() => toast.error(t("common.error")));
          }
          e.target.value = "";
        }}
      />

      {/* Attempt footer (persistent across sessions) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/[0.06] pt-3 text-xs tabular-nums text-muted-foreground">
        <span
          className={cn(
            imageAttempts >= 5
              ? "text-destructive"
              : imageAttempts >= 3
                ? "text-amber-600 dark:text-amber-400"
                : imageAttempts === 2
                  ? "text-amber-700 dark:text-amber-300"
                  : imageAttempts === 1
                    ? "text-muted-foreground"
                    : "text-muted-foreground",
          )}
        >
          {imageAttempts >= 5
            ? t("characters.identities.attemptsRed", { count: imageAttempts })
            : imageAttempts >= 3
              ? t("characters.identities.attemptsPassword", {
                  count: imageAttempts,
                })
              : imageAttempts === 2
                ? t("characters.identities.attemptsConfirmNext")
                : imageAttempts > 0
                  ? t("characters.identities.attempts", {
                      count: imageAttempts,
                    })
                  : identity.image_url
                    ? t("characters.identities.ready")
                    : t("characters.identities.noAttempts")}
        </span>
        {isAgeVariant && (
          <span className="text-muted-foreground/80">
            · {t("characters.identities.portraitStatus")}:{" "}
            {identity.portrait_image_url
              ? t("characters.identities.portraitReady")
              : t("characters.identities.portraitMissing")}
            {portraitAttempts > 0 &&
              ` (${t("characters.identities.attempts", { count: portraitAttempts })})`}
          </span>
        )}
      </div>

      <AssetBeatReferences
        project={project}
        references={references}
        className="border-t border-white/[0.06] pt-3"
      />

      {/* Dialogs — zero-height wrapper so they don't affect flex gap spacing */}
      <div className="h-0 overflow-hidden" aria-hidden="true">
      {/* Confirm: generate identity image */}
      <AlertDialog open={confirmGenOpen} onOpenChange={setConfirmGenOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("characters.identities.confirmGenTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("characters.identities.confirmGenBody", {
                count: imageAttempts + 1,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="outline"
              onClick={() => {
                setConfirmGenOpen(false);
                runGenImage();
              }}
              className={identityCreditDialogActionClass}
            >
              {t("characters.identities.generate")}
              <CreditCostInline display={identityCost} />
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm: generate portrait */}
      <AlertDialog
        open={confirmGenPortraitOpen}
        onOpenChange={setConfirmGenPortraitOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("characters.identities.confirmGenPortraitTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("characters.identities.confirmGenBody", {
                count: portraitAttempts + 1,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="outline"
              onClick={() => {
                setConfirmGenPortraitOpen(false);
                runGenPortrait();
              }}
              className={identityCreditDialogActionClass}
            >
              {t("characters.identities.generate")}
              <CreditCostInline display={identityCost} />
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename identity (编辑 identity_name) */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent
          className={cn(CHARACTER_DIALOG_CONTENT_CLASS, "sm:max-w-md")}
        >
          <DialogHeader className="gap-2">
            <DialogTitle className="text-base font-medium tracking-tight">
              {t("characters.identities.renameIdentity")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3.5">
            <Label className="text-xs font-medium text-muted-foreground">
              {t("characters.identities.newNamePlaceholder")}
            </Label>
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
              }}
              autoFocus
              className={CHARACTER_INPUT_CLASS}
            />
            <p className="text-xs leading-relaxed text-muted-foreground/70">
              {t("characters.identities.renameHint")}
            </p>
            <DialogFooter className={CHARACTER_DIALOG_FOOTER_CLASS}>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRenameOpen(false)}
                className={CHARACTER_DIALOG_CANCEL_BUTTON_CLASS}
              >
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={handleRename}
                disabled={
                  updateIdentity.isPending ||
                  !renameValue.trim() ||
                  renameValue.trim() === identity.identity_name
                }
                className={CHARACTER_DIALOG_ACTION_BUTTON_CLASS}
              >
                {t("common.save")}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirm: delete generated identity image */}
      <AlertDialog open={deleteImageOpen} onOpenChange={setDeleteImageOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("characters.identities.deleteImage")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("characters.identities.deleteImageBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleDeleteImage}
              disabled={deleteIdentityImage.isPending}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </div>
    </article>
  );
}

function IdentitiesGridSection({
  character,
  project,
  imageModel,
  onAttempt,
}: {
  character: Character;
  project: string;
  imageModel?: string;
  onAttempt: () => void;
}) {
  const { t } = useTranslation();
  const { data: identitiesRes } = useCharacterIdentities(
    project,
    character.name,
  );
  const refIndex = useAssetReferenceIndex(project);
  const deepLink = useAssetsDeepLink();
  const createIdentity = useCreateIdentity(project, character.name);
  const identities = identitiesRes?.data ?? [];
  const gridRef = useAssetFocus(
    deepLink.type === "identity" ? deepLink.id : null,
    identities.length > 0,
  );
  const [newName, setNewName] = useState("");
  const [newAgeGroup, setNewAgeGroup] = useState("");
  const [newAppearance, setNewAppearance] = useState("");
  const [addIdentityOpen, setAddIdentityOpen] = useState(false);

  useEffect(() => {
    setNewName("");
    setNewAgeGroup("");
    setNewAppearance("");
    setAddIdentityOpen(false);
  }, [character.name]);

  const ageLabelKey = labelKeyFor(AGE_GROUP_OPTIONS, character.age_group);
  const ageLabel = ageLabelKey ? t(ageLabelKey) : "";
  const roleLabel = character.role ?? "";

  const handleAdd = async () => {
    if (!newName.trim()) return;
    try {
      await createIdentity.mutateAsync({
        identity_name: newName.trim(),
        age_group: newAgeGroup || undefined,
        appearance_details: newAppearance.trim() || undefined,
      });
      setNewName("");
      setNewAgeGroup("");
      setNewAppearance("");
      setAddIdentityOpen(false);
      toast.success(t("characters.toasts.identityAdded"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleDialogOpenChange = (open: boolean) => {
    setAddIdentityOpen(open);
    if (!open) {
      setNewName("");
      setNewAgeGroup("");
      setNewAppearance("");
    }
  };

  return (
    <section className="rounded-[10px] border border-white/[0.06] bg-white/[0.006] p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Shirt className="size-4 text-muted-foreground/80" />
          <h3 className="text-sm font-semibold text-foreground">
            {t("characters.identities.title")}
          </h3>
          <span className="rounded-[6px] bg-white/[0.04] px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
            {identities.length}
          </span>
        </div>
        {identities.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAddIdentityOpen(true)}
            className="h-8 gap-1 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none hover:bg-white/[0.04] dark:bg-transparent"
          >
            <Plus className="size-3.5" />
            {t("characters.identities.addNew")}
          </Button>
        )}
      </div>

      {identities.length === 0 ? (
        <button
          type="button"
          onClick={() => setAddIdentityOpen(true)}
          className="group flex min-h-14 w-full items-center justify-center rounded-[8px] border border-dashed border-white/10 bg-white/[0.015] px-4 text-center transition hover:border-white/18 hover:bg-white/[0.035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/10"
        >
          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground/72 transition group-hover:text-foreground">
            <Plus className="size-3.5 text-foreground/70 transition group-hover:text-foreground" />
            {t("characters.identities.empty")}
          </span>
        </button>
      ) : (
        <div ref={gridRef} className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {identities.map((id) => (
            <div key={id.identity_id} data-asset-id={id.identity_id}>
              <IdentityCard
                identity={id}
                project={project}
                characterName={character.name}
                characterAgeGroup={character.age_group}
                imageModel={imageModel}
                ageLabel={ageLabel}
                roleLabel={roleLabel}
                referenceCount={refIndex.countFor("identity", id.identity_id)}
                references={refIndex.referencesFor("identity", id.identity_id)}
                onAttempt={onAttempt}
              />
            </div>
          ))}
        </div>
      )}

      <Dialog open={addIdentityOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent
          className={cn(CHARACTER_DIALOG_CONTENT_CLASS, "sm:max-w-lg")}
        >
          <DialogHeader className="relative gap-2">
            <DialogTitle className="text-base font-medium tracking-tight">
              {t("characters.identities.addNew")}
            </DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleAdd();
            }}
            className="relative space-y-3.5"
          >
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("characters.identities.name")}
              </Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("characters.identities.newNamePlaceholder")}
                autoFocus
                className={CHARACTER_INPUT_CLASS}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("characters.basics.ageGroup")}
              </Label>
              <Select
                value={newAgeGroup || "__none__"}
                onValueChange={(value) =>
                  setNewAgeGroup(value === "__none__" ? "" : (value ?? ""))
                }
              >
                <SelectTrigger className={CHARACTER_SELECT_TRIGGER_CLASS}>
                  <SelectValue>
                    {(value: string) =>
                      !value || value === "__none__"
                        ? t("characters.identities.inheritFromCharacter")
                        : (() => {
                            const labelKey = labelKeyFor(
                              AGE_GROUP_OPTIONS,
                              value,
                            );
                            return labelKey ? t(labelKey) : value;
                          })()
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent
                  alignItemWithTrigger={false}
                  sideOffset={8}
                  className={CHARACTER_SELECT_CONTENT_CLASS}
                >
                  <SelectItem value="__none__">
                    {t("characters.identities.inheritFromCharacter")}
                  </SelectItem>
                  {AGE_GROUP_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("characters.identities.appearance")}
              </Label>
              <textarea
                className={cn(CHARACTER_TEXTAREA_CLASS, "min-h-24")}
                rows={4}
                value={newAppearance}
                onChange={(e) => setNewAppearance(e.target.value)}
                placeholder={t("characters.identities.appearancePlaceholder")}
              />
            </div>
            <DialogFooter className={CHARACTER_DIALOG_FOOTER_CLASS}>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleDialogOpenChange(false)}
                className={CHARACTER_DIALOG_CANCEL_BUTTON_CLASS}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={createIdentity.isPending || !newName.trim()}
                className={CHARACTER_DIALOG_ACTION_BUTTON_CLASS}
              >
                {createIdentity.isPending && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                {t("common.confirm")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ─── Right detail panel ──────────────────────────────────────────────────────

function DetailPanel({
  character,
  project,
  imageModel,
  attemptCount,
  mainCopy,
  onAttempt,
  onDeleted,
  onRenamed,
}: {
  character: Character | null;
  project: string;
  imageModel?: string;
  attemptCount: number;
  mainCopy: CharacterMainCopy;
  onAttempt: () => void;
  onDeleted: () => void;
  onRenamed: (nextName: string) => void;
}) {
  const { t } = useTranslation();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Reset scroll position when selected character changes
  useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [character?.name]);

  if (!character) {
    return (
      <aside className="flex h-full w-full flex-col items-center justify-center bg-background p-6 text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-full border border-border bg-card">
          <Users className="size-5 text-muted-foreground" />
        </div>
        <p className="max-w-[15rem] text-xs leading-5 text-muted-foreground">
          {t("characters.drawer.pickOne")}
        </p>
      </aside>
    );
  }

  const detailsScope = saveScopes.characterDetails(project, character.name);

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div
        ref={scrollContainerRef}
        className="@container flex-1 space-y-3 overflow-y-auto p-4"
      >
        <section className="rounded-[10px] border border-white/[0.06] bg-white/[0.018] p-4">
          <CharacterHeaderRow
            character={character}
            project={project}
            detailsScope={detailsScope}
            mainCopy={mainCopy}
            onDeleted={onDeleted}
          />
          <div className="mt-5 grid grid-cols-1 gap-5 @[900px]:grid-cols-[180px_minmax(0,1fr)]">
            <div className="w-full max-w-[180px] @[900px]:max-w-none">
              <PortraitBlock
                character={character}
                project={project}
                imageModel={imageModel}
                attemptCount={attemptCount}
                onAttempt={onAttempt}
              />
            </div>
            <div className="min-w-0">
              <DetailsFormCard
                character={character}
                project={project}
                onRenamed={onRenamed}
              />
            </div>
          </div>
        </section>
        <CharacterVoicePanel character={character} project={project} />
        <IdentitiesGridSection
          character={character}
          project={project}
          imageModel={imageModel}
          onAttempt={onAttempt}
        />
      </div>
    </aside>
  );
}

function ProjectVoicesPanel({
  project,
  isNarratedFirstPerson,
  narratorMain,
  onSelectNarratorMain,
}: {
  project: string;
  isNarratedFirstPerson: boolean;
  narratorMain: Character | null;
  onSelectNarratorMain: () => void;
}) {
  const { t } = useTranslation();
  const allowFirstPersonProjectVoice = !isNarratedFirstPerson;
  if (isNarratedFirstPerson) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto bg-background p-6">
        <section className="w-full max-w-[640px] rounded-[10px] border border-white/[0.055] bg-white/[0.012] p-4">
          <div className="flex items-center gap-3">
            <Mic2 className="size-4 text-muted-foreground/78" />
            <h2 className="text-sm font-semibold text-foreground">
              {t("characters.voices.firstPersonNarratedTitle")}
            </h2>
          </div>
          <p className="mt-5 text-xs leading-5 text-muted-foreground/78">
            {narratorMain
              ? t("characters.voices.firstPersonNarratedDesc", {
                  name: narratorMain.name,
                })
              : t("characters.voices.firstPersonNarratedMissingMain")}
          </p>
          {narratorMain && (
            <div className="mt-10 flex justify-center">
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={onSelectNarratorMain}
                className="h-7 gap-1 rounded-[7px] border-white/[0.11] bg-white/[0.03] px-2.5 text-[12px] font-normal text-foreground/76 shadow-none hover:border-white/[0.18] hover:bg-white/[0.055] hover:text-foreground dark:border-white/[0.11] dark:bg-white/[0.03] dark:hover:border-white/[0.18] dark:hover:bg-white/[0.055] dark:hover:text-foreground"
              >
                {t("characters.voices.openNarratorMainVoice")}
              </Button>
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background p-6">
      <div className="w-full max-w-3xl">
        <NarratorVoicePanel
          project={project}
          allowFirstPersonProjectVoice={allowFirstPersonProjectVoice}
        />
      </div>
    </div>
  );
}

// ─── Add character dialog ────────────────────────────────────────────────────

function AddCharacterDialog({
  project,
  open,
  onOpenChange,
}: {
  project: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const createChar = useCreateCharacter(project);
  const { register, handleSubmit, reset, watch, setValue } =
    useForm<AddCharacterForm>({
    resolver: zodResolver(addCharacterSchema),
  });
  const roleValue = watch("role") ?? "";
  const genderValue = watch("gender") ?? "";
  const inputClass =
    "h-10 rounded-[8px] border-white/12 bg-white/[0.04] px-3 text-sm placeholder:text-muted-foreground/70 focus-visible:border-white/25 focus-visible:ring-2 focus-visible:ring-white/8 dark:bg-white/[0.04]";
  const selectTriggerClass =
    "h-10 w-full rounded-[8px] border-white/12 bg-white/[0.04] px-3 text-sm text-foreground focus-visible:border-white/25 focus-visible:ring-2 focus-visible:ring-white/8 dark:bg-white/[0.04]";
  const labelClass = "text-xs font-medium text-muted-foreground";

  const onSubmit = async (data: AddCharacterForm) => {
    try {
      await createChar.mutateAsync(data);
      reset();
      onOpenChange(false);
      toast.success(t("characters.toasts.created"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(CHARACTER_DIALOG_CONTENT_CLASS, "sm:max-w-xl")}
      >
        <DialogHeader className="gap-2">
          <DialogTitle className="text-lg font-medium tracking-tight">
            {t("characters.addCharacter")}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={handleSubmit(onSubmit)}
          className="relative space-y-3.5"
        >
          <div className="space-y-1.5">
            <Label className={labelClass}>
              {t("characters.basics.name")} *
            </Label>
            <Input {...register("name")} autoFocus className={inputClass} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className={labelClass}>
                {t("characters.basics.role")}
              </Label>
              <Select
                value={roleValue}
                onValueChange={(value) => {
                  if (value !== null) {
                    setValue("role", value, { shouldDirty: true });
                  }
                }}
              >
                <SelectTrigger className={selectTriggerClass}>
                  <SelectValue placeholder={t("characters.rolePlaceholder")}>
                    {(val: string) => {
                      const opt = ROLE_OPTIONS.find((o) => o.value === val);
                      return opt ? t(opt.labelKey) : val;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent
                  alignItemWithTrigger={false}
                  sideOffset={8}
                  className={CHARACTER_SELECT_CONTENT_CLASS}
                >
                  {ROLE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className={labelClass}>
                {t("characters.basics.gender")}
              </Label>
              <Select
                value={genderValue}
                onValueChange={(value) => {
                  if (value !== null) {
                    setValue("gender", value, { shouldDirty: true });
                  }
                }}
              >
                <SelectTrigger className={selectTriggerClass}>
                  <SelectValue
                    placeholder={`${t("characters.genders.male")} / ${t(
                      "characters.genders.female",
                    )}`}
                  >
                    {(val: string) => {
                      const opt = GENDER_OPTIONS.find((o) => o.value === val);
                      return opt ? t(opt.labelKey) : val;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent
                  alignItemWithTrigger={false}
                  sideOffset={8}
                  className={CHARACTER_SELECT_CONTENT_CLASS}
                >
                  {GENDER_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className={labelClass}>
              {t("characters.basics.description")}
            </Label>
            <Input {...register("description")} className={inputClass} />
          </div>
          <div className="space-y-1.5">
            <Label className={labelClass}>
              {t("characters.basics.facePrompt")}
            </Label>
            <Input
              placeholder="oval face, big eyes"
              className={inputClass}
              {...register("face_prompt")}
            />
          </div>
          <DialogFooter className={CHARACTER_DIALOG_FOOTER_CLASS}>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className={CHARACTER_DIALOG_CANCEL_BUTTON_CLASS}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={createChar.isPending}
              className={CHARACTER_DIALOG_ACTION_BUTTON_CLASS}
            >
              {createChar.isPending && (
                <Loader2 className="size-4 animate-spin" />
              )}
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

/**
 * Character-list / detail split.
 *
 * Desktop (≥lg): fixed-width left sidebar (288px) + flexible right detail area.
 * Narrow: stacked layout (list on top, detail below).
 */
function CharactersSplit({
  project,
  isDesktop,
  buildStarted,
  taskStream,
  isLoading,
  characters,
  totalCharacters,
  imageModel,
  mainCopy,
  searchQuery,
  onSearchQueryChange,
  selectedName,
  setSelectedName,
  selectedChar,
  attempts,
  handleAttempt,
  onRebuild,
  rebuildDisabled,
  buildCharactersCostDisplay,
}: {
  project: string;
  isDesktop: boolean;
  buildStarted: boolean;
  taskStream: ReturnType<typeof useTaskStream>;
  isLoading: boolean;
  characters: Character[];
  totalCharacters: number;
  imageModel?: string;
  mainCopy: CharacterMainCopy;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  selectedName: string | null;
  setSelectedName: (name: string | null) => void;
  selectedChar: Character | null;
  attempts: Record<string, number>;
  handleAttempt: (name: string) => void;
  onRebuild: () => void;
  rebuildDisabled: boolean;
  buildCharactersCostDisplay?: string | null;
}) {
  const { t } = useTranslation();
  const isExtracting = buildStarted && taskStream.status !== "idle";
  const searchActive = searchQuery.trim().length > 0;
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const previousCharacterCountRef = useRef(characters.length);

  useEffect(() => {
    if (characters.length > previousCharacterCountRef.current) {
      listScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
    previousCharacterCountRef.current = characters.length;
  }, [characters.length]);

  const extractingProgress = (
    <div
      className="w-full max-w-[220px] rounded-[8px] bg-white/[0.05] p-3"
    >
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {taskStream.currentTask || t("characters.extracting")}
        </span>
        <span className="shrink-0 font-mono tabular-nums text-foreground/80">
          {Math.round(taskStream.progress * 100)}%
        </span>
      </div>
      <Progress value={taskStream.progress * 100} className="mt-3 h-1.5" />
    </div>
  );

  const listPane = (
    <>
      {totalCharacters > 0 && (
        <div className="p-3 pb-2">
          <CharacterSearch
            value={searchQuery}
            onValueChange={onSearchQueryChange}
            resultCount={characters.length}
            totalCount={totalCharacters}
            placeholder={t("characters.searchPlaceholder")}
          />
        </div>
      )}
      <div ref={listScrollRef} className="flex-1 overflow-y-auto p-3">
        {isLoading ? (
          <SidebarListSkeleton label={t("common.loading")} />
        ) : totalCharacters === 0 && isExtracting ? (
          <div className="mt-10 flex flex-col items-center text-center">
            <div className="mb-3 flex size-12 items-center justify-center rounded-full border border-border bg-card">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
            <h2 className="mb-1.5 text-sm font-semibold text-foreground">
              {t("characters.extractingEmpty.title")}
            </h2>
            <p className="max-w-[15rem] text-xs leading-5 text-muted-foreground">
              {t("characters.extractingEmpty.description")}
            </p>
            <div className="mt-4 flex justify-center">
              {extractingProgress}
            </div>
          </div>
        ) : totalCharacters === 0 ? (
          <div className="mt-10 flex flex-col items-center text-center">
            <div className="mb-3 flex size-12 items-center justify-center rounded-full border border-border bg-card">
              <Users className="size-5 text-muted-foreground" />
            </div>
            <h2 className="mb-1.5 text-sm font-semibold text-foreground">
              {t("characters.empty.title")}
            </h2>
            <p className="max-w-[15rem] text-xs leading-5 text-muted-foreground">
              {t("characters.empty.description")}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={onRebuild}
              disabled={rebuildDisabled}
              className={EMPTY_STATE_ACTION_BUTTON_CLASS}
            >
              <RefreshCw className="size-3.5" />
              {t("characters.autoExtract")}
              <CreditCostInline display={buildCharactersCostDisplay} />
            </Button>
          </div>
        ) : searchActive && characters.length === 0 ? (
          <div className="mt-10 flex flex-col items-center text-center">
            <div className="mb-3 flex size-12 items-center justify-center rounded-full border border-border bg-card">
              <Users className="size-5 text-muted-foreground" />
            </div>
            <h2 className="mb-1.5 text-sm font-semibold text-foreground">
              {t("characters.filter.noMatch")}
            </h2>
            <p className="max-w-[15rem] text-xs leading-5 text-muted-foreground">
              {t("characters.searchPlaceholder")}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {isExtracting && (
              <div className="flex justify-center">
                {extractingProgress}
              </div>
            )}
            <div className="flex flex-col gap-2">
              {characters.map((char) => (
                <CharacterListItem
                  key={char.name}
                  character={char}
                  selected={selectedName === char.name}
                  onSelect={() => setSelectedName(char.name)}
                  mainCharacterLabel={mainCopy.label}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );

  const detailPane = (
    <DetailPanel
      character={selectedChar}
      project={project}
      imageModel={imageModel}
      attemptCount={selectedChar ? (attempts[selectedChar.name] ?? 0) : 0}
      mainCopy={mainCopy}
      onAttempt={() => selectedChar && handleAttempt(selectedChar.name)}
      onDeleted={() => setSelectedName(null)}
      onRenamed={(nextName) => setSelectedName(nextName)}
    />
  );

  if (!isDesktop) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex max-h-[45vh] w-full shrink-0 flex-col overflow-hidden border-b border-border">
          {listPane}
        </div>
        <div className="min-w-0 flex-1">{detailPane}</div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 flex overflow-hidden bg-background">
      <div className="flex w-80 shrink-0 flex-col overflow-hidden border-r border-border/30 bg-background">
        {listPane}
      </div>
      <div className="min-w-0 flex-1 overflow-hidden bg-background">
        {detailPane}
      </div>
    </div>
  );
}

function CharactersPageContent() {
  const { t } = useTranslation();
  const { project } = Route.useParams();
  const { data: charsRes, isLoading } = useCharacters(project);
  const { data: projectRes } = useProject(project);
  const { data: imageSelectionRes } = useCharacterImageSelection(project);
  const buildChars = useBuildCharacters(project);
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const buildCharactersCost = useGenerationCreditCost("feature", "build_characters");
  const buildCharactersCostDisplay =
    buildCharactersCost.data?.data.display ??
    (buildCharactersCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [buildStarted, setBuildStarted] = useState(false);
  const [rebuildDialogOpen, setRebuildDialogOpen] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const deepLink = useAssetsDeepLink();
  const ownerIndex = useIdentityOwnerIndex(project);
  const appliedIdentityDeepLink = useRef<string | null>(null);
  const [assetTab, setAssetTab] = useState<AssetTab>(() =>
    deepLink.type ? TAB_BY_ASSET_TYPE[deepLink.type] : readStoredAssetTab(project),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [imageModel, setImageModel] = useState("");

  const taskStream = useTaskStream({
    taskType: "build_characters",
    project,
    episode: 0,
    enabled: buildStarted,
    invalidateKeys: [queryKeys.characters(project)],
    onComplete: () => setBuildStarted(false),
    onError: () => setBuildStarted(false),
  });

  const characters = charsRes?.data ?? [];
  const projectConfig = projectRes?.data;
  const savedImageModel =
    imageSelectionRes?.data.character_image_selection ?? "";
  const narratorMain = useMemo(
    () => characters.find((character) => character.is_main) ?? null,
    [characters],
  );
  const isNarratedFirstPerson =
    projectConfig?.spine_template === "narrated" &&
    projectConfig?.narration_style === "first_person";
  const mainCopy = characterMainCopyForSpineTemplate(
    projectConfig?.spine_template,
  );
  const filteredCharacters = useMemo(
    () => filterCharacters(characters, searchQuery),
    [characters, searchQuery],
  );

  useEffect(() => {
    setImageModel(savedImageModel);
  }, [savedImageModel]);

  useEffect(() => {
    if (deepLink.type) setAssetTab(TAB_BY_ASSET_TYPE[deepLink.type]);
    else setAssetTab(readStoredAssetTab(project));
  }, [project, deepLink.type]);

  const selectedIndex = useMemo(
    () =>
      selectedName
        ? filteredCharacters.findIndex((c) => c.name === selectedName)
        : -1,
    [filteredCharacters, selectedName],
  );
  const selectedChar =
    selectedIndex >= 0 ? filteredCharacters[selectedIndex] : null;

  // Auto-select first character when nothing is selected
  useEffect(() => {
    if (!selectedName && filteredCharacters.length > 0) {
      setSelectedName(filteredCharacters[0].name);
    } else if (
      selectedName &&
      !filteredCharacters.some((c) => c.name === selectedName)
    ) {
      setSelectedName(filteredCharacters[0]?.name ?? null);
    }
  }, [selectedName, filteredCharacters]);

  // Resolve an `?type=identity&id=` deep link to its owning character (the
  // identity list is lazy per character, so we wait for the owner index).
  const identityDeepLinkId =
    deepLink.type === "identity" ? deepLink.id : null;
  const identityOwner = identityDeepLinkId
    ? ownerIndex.ownerOf(identityDeepLinkId)
    : null;
  useEffect(() => {
    if (!identityDeepLinkId || !identityOwner) return;
    if (appliedIdentityDeepLink.current === identityDeepLinkId) return;
    setSelectedName(identityOwner);
    appliedIdentityDeepLink.current = identityDeepLinkId;
  }, [identityDeepLinkId, identityOwner]);

  const handleBuild = async () => {
    setRebuildDialogOpen(false);
    try {
      await buildChars.mutateAsync();
      setBuildStarted(true);
    } catch (error) {
      toast.error(backendErrorToastMessage(error, t));
    }
  };

  const handleAttempt = (name: string) => {
    setAttempts((prev) => ({ ...prev, [name]: (prev[name] ?? 0) + 1 }));
  };

  const handleAssetTabChange = (next: AssetTab) => {
    writeStoredAssetTab(project, next);
    setAssetTab(next);
    const assetRefType = ASSET_TYPE_BY_TAB[next];
    if (assetRefType) deepLink.select(assetRefType);
  };

  return (
    <AssetHeaderActionsSlotProvider>
      <div className="-m-6 flex h-[calc(100%+3rem)] flex-col overflow-hidden">
      <CharactersPageHeader
        onRebuild={() => setRebuildDialogOpen(true)}
        rebuildDisabled={buildChars.isPending || buildStarted}
        buildCharactersCostDisplay={buildCharactersCostDisplay}
        onAdd={() => setAddDialogOpen(true)}
        project={project}
        activeTab={assetTab}
        setImageModel={setImageModel}
      />

      <AssetTabs value={assetTab} onChange={handleAssetTabChange} />

      {assetTab === "characters" ? (
        <>
          <div className="shrink-0 border-b border-border/30 bg-background px-3 py-3 lg:px-9">
            <CharacterStatsStrip
              characters={characters}
              mainCharacterLabel={mainCopy.label}
            />
          </div>
          <CharactersSplit
            project={project}
            isDesktop={isDesktop}
            buildStarted={buildStarted}
            taskStream={taskStream}
            isLoading={isLoading}
            characters={filteredCharacters}
            totalCharacters={characters.length}
            imageModel={imageModel}
            mainCopy={mainCopy}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            selectedName={selectedName}
            setSelectedName={setSelectedName}
            selectedChar={selectedChar}
            attempts={attempts}
            handleAttempt={handleAttempt}
            onRebuild={() => setRebuildDialogOpen(true)}
            rebuildDisabled={buildChars.isPending || buildStarted}
            buildCharactersCostDisplay={buildCharactersCostDisplay}
          />
        </>
      ) : assetTab === "voices" ? (
        <ProjectVoicesPanel
          project={project}
          isNarratedFirstPerson={isNarratedFirstPerson}
          narratorMain={narratorMain}
          onSelectNarratorMain={() => {
            if (!narratorMain) return;
            writeStoredAssetTab(project, "characters");
            setAssetTab("characters");
            setSelectedName(narratorMain.name);
          }}
        />
      ) : assetTab === "scenes" ? (
        <ScenesPanel
          project={project}
          focusId={assetTab === "scenes" ? deepLink.id : null}
        />
      ) : (
        <PropsPanel
          project={project}
          focusId={assetTab === "props" ? deepLink.id : null}
        />
      )}

      {/* Rebuild confirm */}
      <AlertDialog open={rebuildDialogOpen} onOpenChange={setRebuildDialogOpen}>
        <AlertDialogTrigger className="hidden" />
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("characters.reExtractTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("characters.reExtractDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleBuild}>
              {t("common.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AddCharacterDialog
        project={project}
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
      />
      </div>
    </AssetHeaderActionsSlotProvider>
  );
}

function CharactersPage() {
  const { project } = Route.useParams();
  // `TaskControllerProvider` wraps the page so `useTaskController` on
  // character-scoped tasks (e.g. character_portrait) can resolve a registry.
  // episode=0 is the project-level sentinel used for non-episodic tasks.
  return (
    <TaskControllerProvider project={project} episode={0}>
      <CharactersPageContent />
    </TaskControllerProvider>
  );
}

export const Route = createLazyFileRoute("/_app/projects/$project/characters")({
  component: CharactersPage,
});
