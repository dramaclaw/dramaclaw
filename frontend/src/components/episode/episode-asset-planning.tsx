// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  CheckCircle2,
  Hourglass,
  Loader2,
  MapPinned,
  Package,
  Upload,
  UsersRound,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { CreditCostInline } from "@/components/credit-cost-inline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  useCreateProp,
  useProps,
  type PropPayload,
} from "@/lib/queries/props";
import { useCharacterIdentities } from "@/lib/queries/characters";
import { cn } from "@/lib/utils";
import type { ErrorResponse } from "@/types/api";
import type { Character } from "@/types/character";
import type { EpisodePropMenuItem, EpisodeSceneMenuItem } from "@/types/episode";

interface EpisodeAssetPlanningLabels {
  identities: string;
  scenes: string;
  props: string;
  noIdentities: string;
  noScenes: string;
  noProps: string;
  planIdentities: string;
  replanIdentities: string;
  defaultIdentity: string;
  planScenes: string;
  replanScenes: string;
  planProps: string;
  replanProps: string;
  propInGlobal: string;
  propCheckingGlobal: string;
  promoteProp: string;
  promotePropTitle: (name: string) => string;
  promotePropName: string;
  promotePropType: string;
  promoteVisualPrompt: string;
  promoteOwner: string;
  promoteSubmit: string;
  promoteCancel: string;
  propTypeLabel: (value: string) => string;
  promoteSuccess?: string;
}

export type AssetPlanningCategory = "identities" | "scenes" | "props";

interface EpisodeAssetPlanningProps {
  project: string;
  /** Which single asset panel to show (driven by the title-row dropdown). */
  selectedCategory?: AssetPlanningCategory;
  characters?: Character[] | null;
  selectedIdentityIds?: string[] | null;
  identityDefaultMap?: Record<string, string> | null;
  sceneMenu?: EpisodeSceneMenuItem[] | null;
  propMenu?: EpisodePropMenuItem[] | null;
  sceneCostDisplay?: string | null;
  propCostDisplay?: string | null;
  identityPending?: boolean;
  scenePending?: boolean;
  propPending?: boolean;
  labels: EpisodeAssetPlanningLabels;
  onPlanIdentities: () => void;
  /**
   * Persist an identity selection / default change made inline on the identity
   * card. Same shape as the picker dialog's `onChange`. When omitted, the card
   * renders read-only.
   */
  onIdentityChange?: (
    selectedIds: string[],
    defaultMap: Record<string, string>,
  ) => void;
  onPlanScenes: () => void;
  onPlanProps: () => void;
  className?: string;
}

const PROP_TYPE_VALUES = [
  "weapon",
  "accessory",
  "artifact",
  "document",
  "furniture",
  "object",
] as const;

const PROMOTE_FIELD_CLASS =
  "rounded-[9px] border-white/10 bg-white/[0.05] shadow-none focus-visible:border-white/24 focus-visible:ring-0 dark:bg-white/[0.05]";
const ASSET_PLAN_ACTION_BUTTON_CLASS =
  "!h-6 shrink-0 gap-1 !rounded-[6px] !border !border-white/[0.14] !bg-white/[0.03] px-2 text-[11px] font-normal text-foreground/75 shadow-none hover:!border-white/[0.24] hover:!bg-white/[0.07] hover:text-foreground disabled:!border-white/[0.08] disabled:!bg-white/[0.02] [&_svg]:!size-3";

function isErrorResponse(value: unknown): value is ErrorResponse {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { ok?: unknown }).ok === false,
  );
}

function propPromotionSeed(item: EpisodePropMenuItem): PropPayload {
  return {
    name: item.prop_id.trim(),
    prop_type: item.prop_type || "object",
    visual_prompt: (item.visual_prompt || item.description || "").trim(),
    owner: "",
  };
}

export function EpisodeAssetPlanning({
  project,
  selectedCategory = "identities",
  characters,
  selectedIdentityIds,
  identityDefaultMap,
  sceneMenu,
  propMenu,
  sceneCostDisplay,
  propCostDisplay,
  identityPending = false,
  scenePending = false,
  propPending = false,
  labels,
  onPlanIdentities,
  onIdentityChange,
  onPlanScenes,
  onPlanProps,
  className,
}: EpisodeAssetPlanningProps) {
  const propsQuery = useProps(project);
  const createProp = useCreateProp(project);
  const [promotingProp, setPromotingProp] =
    useState<EpisodePropMenuItem | null>(null);
  const scenes = (sceneMenu ?? [])
    .map((item) => item.scene_id?.trim())
    .filter(Boolean);
  const props = (propMenu ?? []).filter((item) => item.prop_id?.trim());
  const identityCharacters = characters ?? [];
  const selectedIdentitySet = useMemo(
    () => new Set(selectedIdentityIds ?? []),
    [selectedIdentityIds],
  );
  const hasIdentities = selectedIdentitySet.size > 0;

  // Pick the default identity for a character inline (mirrors the picker
  // dialog's per-character radio) and persist immediately.
  const handleSetDefaultIdentity = onIdentityChange
    ? (characterName: string, identityId: string) =>
        onIdentityChange(selectedIdentityIds ?? [], {
          ...(identityDefaultMap ?? {}),
          [characterName]: identityId,
        })
    : undefined;
  const globalPropNames = useMemo(
    () => new Set((propsQuery.data?.data ?? []).map((prop) => prop.name)),
    [propsQuery.data?.data],
  );

  const handlePromote = async (data: PropPayload) => {
    try {
      const res = await createProp.mutateAsync(data);
      if (isErrorResponse(res)) {
        toast.error(res.error);
        return;
      }
      toast.success(labels.promoteSuccess ?? labels.propInGlobal);
      setPromotingProp(null);
    } catch {
      toast.error(labels.promoteProp);
    }
  };

  return (
    <section className={cn("grid gap-3", className)}>
      {/* Only the category picked in the title-row dropdown is shown. */}
      {selectedCategory === "identities" && (
        <IdentityAssetCard
          className="w-full"
          project={project}
          characters={identityCharacters}
          selectedIdentitySet={selectedIdentitySet}
          identityDefaultMap={identityDefaultMap ?? {}}
          title={labels.identities}
          emptyLabel={labels.noIdentities}
          defaultLabel={labels.defaultIdentity}
          actionLabel={hasIdentities ? labels.replanIdentities : labels.planIdentities}
          pending={identityPending}
          onPlan={onPlanIdentities}
          onSetDefault={handleSetDefaultIdentity}
        />
      )}

      {selectedCategory === "scenes" && (
        <AssetPlanningRow
          className="w-full"
          icon={<MapPinned className="size-3.5 text-emerald-400" />}
          title={labels.scenes}
          emptyLabel={labels.noScenes}
          items={scenes}
          actionLabel={scenes.length > 0 ? labels.replanScenes : labels.planScenes}
          costDisplay={sceneCostDisplay}
          pending={scenePending}
          onPlan={onPlanScenes}
        />
      )}

      {selectedCategory === "props" && (
        <AssetPlanningRow
          className="w-full"
          icon={<Package className="size-3.5 text-amber-400" />}
          title={labels.props}
          emptyLabel={labels.noProps}
          items={props.map((item) => item.prop_id.trim())}
          actionLabel={props.length > 0 ? labels.replanProps : labels.planProps}
          costDisplay={propCostDisplay}
          pending={propPending}
          onPlan={onPlanProps}
          renderItem={(propId) => {
            const propItem = props.find(
              (item) => item.prop_id.trim() === propId,
            );
            const existsInGlobal = globalPropNames.has(propId);
            return (
              <EpisodePropBadge
                key={propId}
                propId={propId}
                existsInGlobal={existsInGlobal}
                checking={propsQuery.isLoading}
                labels={labels}
                onPromote={() => propItem && setPromotingProp(propItem)}
              />
            );
          }}
        />
      )}
      <PropPromotionDialog
        open={Boolean(promotingProp)}
        item={promotingProp}
        labels={labels}
        saving={createProp.isPending}
        onOpenChange={(open) => !open && setPromotingProp(null)}
        onSubmit={handlePromote}
      />
    </section>
  );
}

function AssetPlanningRow({
  icon,
  title,
  emptyLabel,
  items,
  actionLabel,
  costDisplay,
  pending,
  onPlan,
  renderItem,
  className,
}: {
  icon: ReactNode;
  title: string;
  emptyLabel: string;
  items: string[];
  actionLabel: string;
  costDisplay?: string | null;
  pending: boolean;
  onPlan: () => void;
  renderItem?: (item: string) => ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-[128px] min-w-0 flex-col overflow-hidden rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-4 pb-4 pt-3",
        className,
      )}
    >
      <div className="mb-3 flex h-6 shrink-0 items-center justify-between gap-3">
        <div className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {icon}
          <span>{title}</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onPlan}
          disabled={pending}
          className={ASSET_PLAN_ACTION_BUTTON_CLASS}
        >
          {pending && <Loader2 className="animate-spin" />}
          {actionLabel}
          <CreditCostInline display={costDisplay} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-wrap content-start items-center gap-1.5 overflow-y-auto">
        {items.length > 0 ? (
          items.map((item) =>
            renderItem ? (
              renderItem(item)
            ) : (
              <Badge
                key={item}
                variant="outline"
                className="max-w-40 truncate border-white/15 bg-white/[0.02]"
              >
                {item}
              </Badge>
            ),
          )
        ) : (
          <span className="text-xs italic text-muted-foreground/60">
            {emptyLabel}
          </span>
        )}
      </div>
    </div>
  );
}

function IdentityAssetCard({
  className,
  project,
  characters,
  selectedIdentitySet,
  identityDefaultMap,
  title,
  emptyLabel,
  defaultLabel,
  actionLabel,
  pending,
  onPlan,
  onSetDefault,
}: {
  className?: string;
  project: string;
  characters: Character[];
  selectedIdentitySet: Set<string>;
  identityDefaultMap: Record<string, string>;
  title: string;
  emptyLabel: string;
  defaultLabel: string;
  actionLabel: string;
  pending: boolean;
  onPlan: () => void;
  onSetDefault?: (characterName: string, identityId: string) => void;
}) {
  const hasSelection = selectedIdentitySet.size > 0 && characters.length > 0;
  return (
    <div
      className={cn(
        "flex h-[128px] min-w-0 flex-col overflow-hidden rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-4 pb-4 pt-3",
        className,
      )}
    >
      <div className="mb-3 flex h-6 shrink-0 items-center justify-between gap-3">
        <div className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <UsersRound className="size-3.5 text-sky-400" />
          <span>{title}</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onPlan}
          disabled={pending}
          className={ASSET_PLAN_ACTION_BUTTON_CLASS}
        >
          {pending && <Loader2 className="animate-spin" />}
          {actionLabel}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-wrap content-start items-start gap-x-6 gap-y-3 overflow-y-auto">
        {hasSelection ? (
          characters.map((character) => (
            <CharacterIdentityBadges
              key={character.name}
              project={project}
              character={character}
              selectedIdentitySet={selectedIdentitySet}
              defaultIdentityId={identityDefaultMap[character.name]}
              defaultLabel={defaultLabel}
              onSetDefault={onSetDefault}
            />
          ))
        ) : (
          <span className="text-xs italic text-muted-foreground/60">
            {emptyLabel}
          </span>
        )}
      </div>
    </div>
  );
}

function CharacterIdentityBadges({
  project,
  character,
  selectedIdentitySet,
  defaultIdentityId,
  defaultLabel,
  onSetDefault,
}: {
  project: string;
  character: Character;
  selectedIdentitySet: Set<string>;
  defaultIdentityId?: string;
  defaultLabel: string;
  onSetDefault?: (characterName: string, identityId: string) => void;
}) {
  const { data: identitiesRes } = useCharacterIdentities(project, character.name);
  const selected = (identitiesRes?.data ?? []).filter((identity) =>
    selectedIdentitySet.has(identity.identity_id),
  );
  if (selected.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="truncate text-[11px] text-muted-foreground/80">
        {character.name}
      </span>
      <div className="flex items-center gap-1.5">
        {selected.map((identity) => {
          const isDefault = defaultIdentityId === identity.identity_id;
          return (
            <div
              key={identity.identity_id}
              className={cn(
                "flex max-w-full items-center gap-2 rounded-[8px] border px-2.5 py-1 text-xs transition-colors",
                isDefault
                  ? "border-primary/60 bg-primary/10 text-foreground"
                  : "border-white/12 bg-white/[0.03] text-muted-foreground",
              )}
            >
              <span className="truncate">{identity.identity_name}</span>
              {/* Inline default picker — same affordance as the identity dialog. */}
              <label
                className={cn(
                  "flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground",
                  onSetDefault ? "cursor-pointer" : "cursor-default",
                )}
              >
                <input
                  type="radio"
                  name={`asset-default-identity-${character.name}`}
                  checked={isDefault}
                  disabled={!onSetDefault}
                  onChange={() =>
                    onSetDefault?.(character.name, identity.identity_id)
                  }
                  aria-label={`${identity.identity_name} ${defaultLabel}`}
                />
                {defaultLabel}
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EpisodePropBadge({
  propId,
  existsInGlobal,
  checking,
  labels,
  onPromote,
}: {
  propId: string;
  existsInGlobal: boolean;
  checking: boolean;
  labels: EpisodeAssetPlanningLabels;
  onPromote: () => void;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <Badge
        variant="outline"
        className="max-w-40 truncate border-white/15 bg-white/[0.02]"
      >
        {propId}
      </Badge>
      {existsInGlobal ? (
        <span
          className="inline-flex size-5 items-center justify-center rounded-full text-emerald-400"
          title={labels.propInGlobal}
          aria-label={labels.propInGlobal}
        >
          <CheckCircle2 className="size-3.5" />
        </span>
      ) : checking ? (
        <span
          className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground"
          title={labels.propCheckingGlobal}
          aria-label={labels.propCheckingGlobal}
        >
          <Hourglass className="size-3.5" />
        </span>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={labels.promoteProp}
          title={labels.promoteProp}
          onClick={onPromote}
          className="text-white/60 hover:bg-white/[0.06] hover:text-white/82"
        >
          <Upload className="size-3.5" />
        </Button>
      )}
    </span>
  );
}

function PropPromotionDialog({
  open,
  item,
  labels,
  saving,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  item: EpisodePropMenuItem | null;
  labels: EpisodeAssetPlanningLabels;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: PropPayload) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PropPayload>(() =>
    item
      ? propPromotionSeed(item)
      : { name: "", prop_type: "object", visual_prompt: "", owner: "" },
  );

  useEffect(() => {
    if (item) setDraft(propPromotionSeed(item));
  }, [item]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="bg-black/8 supports-backdrop-filter:backdrop-blur-sm"
        className="gap-5 overflow-hidden rounded-2xl border border-white/10 bg-black/35 bg-[linear-gradient(135deg,rgba(255,255,255,0.045),rgba(255,255,255,0.012))] p-7 shadow-none backdrop-blur-2xl sm:max-w-[560px]"
      >
        <DialogHeader className="gap-3">
          <DialogTitle>{labels.promotePropTitle(draft.name)}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-5 pt-1">
          <div className="grid gap-2.5">
            <Label>{labels.promotePropName}</Label>
            <div className="flex h-8 w-full cursor-default items-center rounded-[9px] border border-white/10 bg-white/[0.035] px-2.5 text-sm text-foreground/82">
              {draft.name}
            </div>
          </div>
          <div className="grid gap-2.5">
            <Label>{labels.promotePropType}</Label>
            <Select
              value={draft.prop_type || "object"}
              onValueChange={(value) =>
                setDraft((prev) => ({ ...prev, prop_type: String(value) }))
              }
            >
              <SelectTrigger className={cn("w-full", PROMOTE_FIELD_CLASS)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROP_TYPE_VALUES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {labels.propTypeLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2.5">
            <Label>{labels.promoteVisualPrompt}</Label>
            <Textarea
              className={PROMOTE_FIELD_CLASS}
              rows={4}
              value={draft.visual_prompt ?? ""}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, visual_prompt: event.target.value }))
              }
            />
          </div>
          <div className="grid gap-2.5">
            <Label>{labels.promoteOwner}</Label>
            <Input
              className={PROMOTE_FIELD_CLASS}
              value={draft.owner ?? ""}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, owner: event.target.value }))
              }
            />
          </div>
        </div>
        <DialogFooter className="-mx-7 -mb-7 border-t-0 bg-transparent p-7 pt-4 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {labels.promoteCancel}
          </Button>
          <Button
            type="button"
            onClick={() => onSubmit(draft)}
            disabled={saving || !draft.name.trim()}
          >
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            {labels.promoteSubmit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
