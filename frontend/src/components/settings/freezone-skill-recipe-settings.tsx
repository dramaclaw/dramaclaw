// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useMemo,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowUp, ChevronDown, ChevronRight, Copy, Download, Eye, Pencil, Plus, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  useDeleteFreezoneAgentConfigItem,
  useExportFreezoneAgentBundle,
  useFreezoneAgentConfigItems,
  useInstallFreezoneAgentBundle,
  useSaveFreezoneAgentConfigItem,
  type FreezoneCommunityCatalogItem,
  type FreezoneAgentBundlePayload,
  type FreezoneAgentConfigPayload,
} from "@/lib/queries/freezone-agent-config";
import { validateFreezoneAgentConfigPayload } from "@/lib/freezone-agent-config-schema";
import { cn } from "@/lib/utils";

type FreezoneCatalogKind = "skills" | "recipes";
type RecipeGenerationType = "image" | "video" | "audio" | "text";
type SkillInputParameterType = "single_select" | "multi_select" | "text" | "number" | "boolean";

const SKILL_INPUT_PARAMETER_TYPES: SkillInputParameterType[] = [
  "single_select",
  "multi_select",
  "text",
  "number",
  "boolean",
];

const NODE_SCOPE_OPTIONS = [
  "textGeneration",
  "imageGeneration",
  "videoGeneration",
  "audioGeneration",
] as const;

const NODE_SCOPE_LABELS: Record<(typeof NODE_SCOPE_OPTIONS)[number], string> = {
  textGeneration: "文本生成",
  imageGeneration: "图片生成",
  videoGeneration: "视频生成",
  audioGeneration: "音频生成",
};

function getBodyPortalContainer() {
  return typeof document === "undefined" ? null : document.body;
}

interface SkillDraft {
  id: string;
  name: string;
  schemaVersion: string;
  version: string;
  category: string;
  description: string;
  keywords: string[];
  nodeScopes: string[];
  allowedRecipeIds: string[];
  inputParameters: SkillInputParameterDraft[];
  planningNotes: string;
  promptGuide: string;
  conductRules: string[];
  qualityThreshold: string;
  domainConstraints: string;
}

interface SkillInputParameterDraft {
  id: number;
  parameterId: string;
  label: string;
  type: SkillInputParameterType;
  required: boolean;
  defaultValue: string;
  optionsText: string;
  expanded: boolean;
}

interface RecipeDraft {
  id: string;
  name: string;
  outputKind: RecipeGenerationType;
  actionKeys: string[];
  system_prompt: string;
  mustHaveItems: string[];
  planningPrompt: string;
  resultSummary: string;
  sourceMediaRequired: boolean;
}

interface RatingBandDraft {
  id: number;
  score: string;
  description: string;
}

interface DimensionDraft {
  id: number;
  name: string;
  weight: string;
  description: string;
}

interface FreezoneSkillRecipeSettingsProps {
  kind: FreezoneCatalogKind;
  onBackToSkills?: () => void;
  onOpenRecipes?: () => void;
  open: boolean;
}

export function FreezoneSkillRecipeSettings({
  kind,
  onBackToSkills,
  onOpenRecipes,
}: FreezoneSkillRecipeSettingsProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [addingSkill, setAddingSkill] = useState(false);
  const [addingRecipe, setAddingRecipe] = useState(false);
  const [editingSkill, setEditingSkill] = useState<FreezoneAgentConfigPayload | null>(null);
  const [editingRecipe, setEditingRecipe] = useState<FreezoneAgentConfigPayload | null>(null);
  const [skillDeleteCandidate, setSkillDeleteCandidate] = useState<SkillDeleteCandidate | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [showBackToTop, setShowBackToTop] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const bundleImportInputRef = useRef<HTMLInputElement | null>(null);
  const catalogQuery = useFreezoneAgentConfigItems(kind);
  const recipesCatalogQuery = useFreezoneAgentConfigItems("recipes");
  const isSkills = kind === "skills";
  const exportBundle = useExportFreezoneAgentBundle();
  const installBundle = useInstallFreezoneAgentBundle();
  const saveCatalogItem = useSaveFreezoneAgentConfigItem();
  const deleteCatalogItem = useDeleteFreezoneAgentConfigItem();
  const catalogItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const items = (catalogQuery.data ?? []).map((item) => toManagedCatalogItem(item, kind));
    if (!needle) return items;
    return items.filter((item) =>
      [item.id, item.title, item.description, ...item.tags].join(" ").toLowerCase().includes(needle),
    );
  }, [catalogQuery.data, query, kind]);
  const recipeItems = useMemo(
    () => (recipesCatalogQuery.data ?? []).map((item) => toManagedCatalogItem(item, "recipes")),
    [recipesCatalogQuery.data],
  );
  const itemCount = catalogItems.length;
  const selectedItems = catalogItems.filter((item) => selectedIds.has(item.id));
  const selectedCount = selectedItems.length;
  const allVisibleSelected = itemCount > 0 && selectedCount === itemCount;

  useEffect(() => {
    setSelectedIds(new Set());
  }, [kind]);

  useEffect(() => {
    const viewport = sectionRef.current?.closest<HTMLElement>("[data-slot='scroll-area-viewport']") ?? null;
    scrollViewportRef.current = viewport;
    if (!viewport) return;

    const updateBackToTop = () => {
      setShowBackToTop(viewport.scrollTop > 180);
    };
    updateBackToTop();
    viewport.addEventListener("scroll", updateBackToTop, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", updateBackToTop);
      if (scrollViewportRef.current === viewport) {
        scrollViewportRef.current = null;
      }
    };
  }, [kind]);

  const scrollToCatalogTop = () => {
    scrollViewportRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveItem = async (payload: FreezoneAgentConfigPayload) => {
    const cleanPayload = stripCatalogMetadata(payload);
    const validation = validateFreezoneAgentConfigPayload(kind, cleanPayload);
    if (!validation.ok) {
      toast.error(`${t("settings.freezoneCatalog.saveFailed")}：${validation.message}`);
      return;
    }
    try {
      await saveCatalogItem.mutateAsync({ kind, payload: cleanPayload });
      toast.success(t("settings.freezoneCatalog.saved"));
      if (kind === "skills") {
        setAddingSkill(false);
        setEditingSkill(null);
      } else {
        setAddingRecipe(false);
        setEditingRecipe(null);
      }
    } catch {
      toast.error(t("settings.freezoneCatalog.saveFailed"));
    }
  };

  const toggleItemEnabled = async (item: ManagedCatalogItem, enabled: boolean) => {
    try {
      const payload = { ...stripCatalogMetadata(item.payload), enabled };
      await saveCatalogItem.mutateAsync({
        kind,
        payload,
      });
    } catch {
      toast.error(t("settings.freezoneCatalog.saveFailed"));
    }
  };

  const deleteItem = async (item: ManagedCatalogItem) => {
    if (kind === "skills") {
      const allowedRecipeIds = getSkillAllowedRecipeIds(item.payload);
      const associatedRecipes = recipeItems.filter((recipe) => allowedRecipeIds.includes(recipe.id));
      const recipeUsageCounts = getRecipeUsageCounts(catalogItems);
      const exclusiveRecipes = associatedRecipes.filter((recipe) => (recipeUsageCounts.get(recipe.id) ?? 0) <= 1);
      const sharedRecipes = associatedRecipes.filter((recipe) => (recipeUsageCounts.get(recipe.id) ?? 0) > 1);
      setSkillDeleteCandidate({ item, exclusiveRecipes, sharedRecipes });
      return;
    }
    try {
      await deleteCatalogItem.mutateAsync({ kind, id: item.id });
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
      toast.success(t("settings.freezoneCatalog.deleted"));
    } catch (error) {
      const detail = error instanceof Error && error.message ? `：${error.message}` : "";
      toast.error(`${t("settings.freezoneCatalog.deleteFailed")}${detail}`);
    }
  };

  const deleteSkillCandidate = async (deleteRecipes: boolean) => {
    if (!skillDeleteCandidate) return;
    const { item, exclusiveRecipes } = skillDeleteCandidate;
    try {
      await deleteCatalogItem.mutateAsync({ kind: "skills", id: item.id });
      if (deleteRecipes && exclusiveRecipes.length > 0) {
        await Promise.all(
          exclusiveRecipes.map((recipe) =>
            deleteCatalogItem.mutateAsync({ kind: "recipes", id: recipe.id }),
          ),
        );
      }
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
      setSkillDeleteCandidate(null);
      toast.success(t("settings.freezoneCatalog.deleted"));
    } catch {
      toast.error(t("settings.freezoneCatalog.deleteFailed"));
    }
  };

  const deleteSelectedItems = async () => {
    if (selectedItems.length === 0) return;
    try {
      await Promise.all(
        selectedItems.map((item) => deleteCatalogItem.mutateAsync({ kind, id: item.id })),
      );
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const item of selectedItems) {
          next.delete(item.id);
        }
        return next;
      });
      toast.success(t("settings.freezoneCatalog.deleted"));
    } catch {
      toast.error(t("settings.freezoneCatalog.deleteFailed"));
    }
  };

  const exportItems = () => {
    const payloads = selectedItems.length > 0 ? selectedItems : catalogItems;
    if (payloads.length === 0) return;
    const exportPayload = payloads.length === 1
      ? stripCatalogMetadata(payloads[0].payload)
      : payloads.map((item) => stripCatalogMetadata(item.payload));
    downloadJson(
      exportPayload,
      `freezone-${kind}-${new Date().toISOString().slice(0, 10)}.json`,
    );
    toast.success(t("settings.freezoneCatalog.exported"));
  };

  const exportSelectedSkillBundle = async () => {
    if (!isSkills) {
      exportItems();
      return;
    }
    if (selectedItems.length !== 1) {
      toast.error(
        selectedItems.length === 0
          ? t("settings.freezoneCatalog.bundleExportSelectOne")
          : t("settings.freezoneCatalog.bundleExportOnlyOne"),
      );
      return;
    }
    const item = selectedItems[0];
    try {
      const bundle = await exportBundle.mutateAsync({
        skillId: item.id,
        bundle: createSkillBundleExportMeta(item),
      });
      downloadJson(bundle, `${item.id}-bundle.json`);
      toast.success(t("settings.freezoneCatalog.bundleExported"));
    } catch (error) {
      const message = error instanceof Error && error.message ? `：${error.message}` : "";
      toast.error(`${t("settings.freezoneCatalog.bundleExportFailed")}${message}`);
    }
  };

  const toggleAllSelected = (checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const item of catalogItems) {
        if (checked) {
          next.add(item.id);
        } else {
          next.delete(item.id);
        }
      }
      return next;
    });
  };

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const payloads = Array.isArray(parsed) ? parsed : [parsed];
      const normalizedPayloads = payloads.map((payload) => {
        if (!isPlainObject(payload)) throw new Error("invalid json");
        return payload as FreezoneAgentConfigPayload;
      });
      for (const payload of normalizedPayloads) {
        const validation = validateFreezoneAgentConfigPayload(kind, payload);
        if (!validation.ok) {
          throw new Error(validation.message);
        }
      }
      for (const payload of normalizedPayloads) {
        await saveCatalogItem.mutateAsync({
          kind,
          payload,
        });
      }
      toast.success(t("settings.freezoneCatalog.imported"));
    } catch (error) {
      const message = error instanceof Error && error.message ? `：${error.message}` : "";
      toast.error(`${t("settings.freezoneCatalog.importFailed")}${message}`);
    } finally {
      if (importInputRef.current) {
        importInputRef.current.value = "";
      }
    }
  };

  const handleBundleImportFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isFreezoneBundlePayload(parsed)) {
        throw new Error(t("settings.freezoneCatalog.bundleInvalidShape"));
      }
      const result = await installBundle.mutateAsync({ bundle: parsed });
      toast.success(
        t("settings.freezoneCatalog.bundleImported", {
          recipeCount: result.installed_recipes.length,
          skill: result.installed_skill,
        }),
      );
    } catch (error) {
      const message = error instanceof Error && error.message ? `：${error.message}` : "";
      toast.error(`${t("settings.freezoneCatalog.bundleImportFailed")}${message}`);
    } finally {
      if (bundleImportInputRef.current) {
        bundleImportInputRef.current.value = "";
      }
    }
  };

  return (
    <>
      <section ref={sectionRef} className="px-5 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-heading text-sm font-medium text-foreground">
              {t(isSkills ? "settings.pages.freezoneSkills" : "settings.pages.freezoneRecipes")}
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {t(
                isSkills
                  ? "settings.freezoneCatalog.skills.description"
                  : "settings.freezoneCatalog.recipes.description",
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isSkills && onOpenRecipes ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-white/[0.08] bg-white/[0.02] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
                onClick={onOpenRecipes}
              >
                {t("settings.freezoneCatalog.advancedManagement")}
              </Button>
            ) : null}
            {!isSkills && onBackToSkills ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-white/[0.08] bg-white/[0.02] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
                onClick={onBackToSkills}
              >
                {t("settings.freezoneCatalog.backToSkills")}
              </Button>
            ) : null}
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              aria-label={t("settings.freezoneCatalog.import")}
              className="hidden"
              onChange={(event) => {
                void handleImportFile(event.target.files?.[0]);
              }}
            />
            <input
              ref={bundleImportInputRef}
              type="file"
              accept=".json,application/json"
              aria-label={t("settings.freezoneCatalog.importBundle")}
              className="hidden"
              onChange={(event) => {
                void handleBundleImportFile(event.target.files?.[0]);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (isSkills) {
                  bundleImportInputRef.current?.click();
                  return;
                }
                importInputRef.current?.click();
              }}
              disabled={installBundle.isPending}
            >
              <Download className="size-3.5" />
              {t(
                isSkills
                  ? "settings.freezoneCatalog.importBundle"
                  : "settings.freezoneCatalog.import",
              )}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (isSkills) {
                  setEditingSkill(null);
                  setAddingSkill(true);
                  return;
                }
                setEditingRecipe(null);
                setAddingRecipe(true);
              }}
            >
              <Plus className="size-3.5" />
              {t("settings.freezoneCatalog.new")}
            </Button>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t(
                isSkills
                  ? "settings.freezoneCatalog.searchSkills"
                  : "settings.freezoneCatalog.searchRecipes",
              )}
              className="h-9 rounded-md border-input/80 pl-9 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
            />
          </div>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t(
              isSkills
                ? "settings.freezoneCatalog.skillsCount"
                : "settings.freezoneCatalog.recipesCount",
              { count: itemCount },
            )}
          </span>
        </div>

        <CatalogSelectionBar
          allSelected={allVisibleSelected}
          count={itemCount}
          selectedCount={selectedCount}
          label={t("settings.freezoneCatalog.selectAll")}
          onDeleteSelected={() => void deleteSelectedItems()}
          onExport={() => void exportSelectedSkillBundle()}
          onToggleAll={toggleAllSelected}
          onBackToTop={scrollToCatalogTop}
          exportLabel={t(
            isSkills
              ? "settings.freezoneCatalog.exportBundle"
              : "settings.freezoneCatalog.export",
          )}
          showBackToTop={showBackToTop}
        />
        <CatalogList
          kind={kind}
          items={catalogItems}
          loading={catalogQuery.isLoading}
          error={catalogQuery.isError}
          selectedIds={selectedIds}
          onRetry={() => void catalogQuery.refetch()}
          onToggleEnabled={(item, enabled) => void toggleItemEnabled(item, enabled)}
          onToggleSelected={toggleSelected}
          onEdit={(item) => {
            if (kind === "skills") {
              setAddingSkill(false);
              setEditingSkill(item.payload);
              return;
            }
            setAddingRecipe(false);
            setEditingRecipe(item.payload);
          }}
          onDelete={(item) => void deleteItem(item)}
        />
      </section>
      <NewSkillEditor
        open={addingSkill || editingSkill !== null}
        initialPayload={editingSkill}
        recipes={recipeItems}
        onOpenChange={(open) => {
          setAddingSkill(open);
          if (!open) setEditingSkill(null);
        }}
        onSave={saveItem}
        saving={saveCatalogItem.isPending}
      />
      <NewRecipeEditor
        open={addingRecipe || editingRecipe !== null}
        initialPayload={editingRecipe}
        onOpenChange={(open) => {
          setAddingRecipe(open);
          if (!open) setEditingRecipe(null);
        }}
        onSave={saveItem}
        saving={saveCatalogItem.isPending}
      />
      <SkillDeleteDialog
        candidate={skillDeleteCandidate}
        deleting={deleteCatalogItem.isPending}
        onCancel={() => setSkillDeleteCandidate(null)}
        onConfirm={(deleteRecipes) => void deleteSkillCandidate(deleteRecipes)}
      />
    </>
  );
}

function NewRecipeEditor({
  initialPayload,
  open,
  onOpenChange,
  onSave,
  saving,
}: {
  initialPayload: FreezoneAgentConfigPayload | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (payload: FreezoneAgentConfigPayload) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const [recipeDraft, setRecipeDraft] = useState<RecipeDraft>({
    id: "",
    name: "",
    outputKind: "image",
    actionKeys: [],
    system_prompt: "",
    mustHaveItems: [],
    planningPrompt: "",
    resultSummary: "",
    sourceMediaRequired: false,
  });
  const [rawJsonOpen, setRawJsonOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRecipeDraft(recipeDraftFromPayload(initialPayload));
    setRawJsonOpen(false);
  }, [initialPayload, open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setRecipeDraft({
        id: "",
        name: "",
        outputKind: "image",
        actionKeys: [],
        system_prompt: "",
        mustHaveItems: [],
        planningPrompt: "",
        resultSummary: "",
        sourceMediaRequired: false,
      });
      setRawJsonOpen(false);
    }
    onOpenChange(nextOpen);
  };

  const updateRecipeDraft = (patch: Partial<RecipeDraft>) => {
    setRecipeDraft((draft) => ({ ...draft, ...patch }));
  };

  const rawRecipeJson = useMemo(
    () => ({
      ...(initialPayload ?? {}),
      result_summary: recipeDraft.resultSummary,
      planning_prompt: recipeDraft.planningPrompt,
      action_keys: recipeDraft.actionKeys,
      id: recipeDraft.id,
      must_have_items: recipeDraft.mustHaveItems,
      system_prompt: recipeDraft.system_prompt,
      requires_source_media: recipeDraft.sourceMediaRequired,
      output_kind: recipeDraft.outputKind,
      name: recipeDraft.name,
    }),
    [initialPayload, recipeDraft],
  );
  const rawRecipeJsonText = useMemo(
    () => JSON.stringify(rawRecipeJson, null, 2),
    [rawRecipeJson],
  );
  const canSave = isValidRecipeDraft(recipeDraft) && !saving;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        portalContainer={getBodyPortalContainer()}
        className="grid h-[min(86vh,704px)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-lg border border-border bg-black p-0 text-foreground ring-0 sm:max-w-[720px]"
        overlayClassName="bg-black/35"
      >
        <DialogHeader className="flex-row items-center justify-between gap-4 border-b border-border px-6 py-5">
          <DialogTitle className="text-lg font-semibold text-foreground">
            {t("settings.freezoneCatalog.newRecipe.title")}
          </DialogTitle>
          <button
            type="button"
            aria-label={t("settings.freezoneCatalog.newRecipe.close")}
            onClick={() => handleOpenChange(false)}
            className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto px-6 py-5">
          <div className="grid gap-3 md:grid-cols-2">
            <EditorField
              required
              label={t("settings.freezoneCatalog.newRecipe.id")}
              placeholder="my-recipe"
              value={recipeDraft.id}
              onChange={(value) => updateRecipeDraft({ id: value })}
              hint={t("settings.freezoneCatalog.newRecipe.idHint")}
            />
            <EditorField
              required
              label={t("settings.freezoneCatalog.newRecipe.name")}
              placeholder={t("settings.freezoneCatalog.newRecipe.namePlaceholder")}
              value={recipeDraft.name}
              onChange={(value) => updateRecipeDraft({ name: value })}
            />
          </div>

          <div className="mt-4 max-w-28">
            <EditorLabel required>
              {t("settings.freezoneCatalog.newRecipe.outputKind")}
            </EditorLabel>
            <Select
              value={recipeDraft.outputKind}
              onValueChange={(value) =>
                updateRecipeDraft({ outputKind: value as RecipeGenerationType })
              }
            >
              <SelectTrigger className="h-9 w-full rounded-md border-input/80 bg-input/20 text-foreground focus-visible:ring-1 focus-visible:ring-ring/30">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" className="min-w-28">
                {(["image", "video", "audio", "text"] as const).map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(`settings.freezoneCatalog.newRecipe.outputKinds.${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <EditorFieldGroup>
            <TagInputField
              required
              label={t("settings.freezoneCatalog.newRecipe.actionKeys")}
              placeholder={t("settings.freezoneCatalog.newRecipe.actionKeysPlaceholder")}
              value={recipeDraft.actionKeys}
              onChange={(value) => updateRecipeDraft({ actionKeys: value })}
              hint={t("settings.freezoneCatalog.newRecipe.actionKeysHint")}
            />
          </EditorFieldGroup>

          <EditorFieldGroup>
            <EditorTextarea
              required
              label={t("settings.freezoneCatalog.newRecipe.system_prompt")}
              placeholder={t("settings.freezoneCatalog.newRecipe.system_promptPlaceholder")}
              value={recipeDraft.system_prompt}
              onChange={(value) => updateRecipeDraft({ system_prompt: value })}
              className="min-h-36"
            />
          </EditorFieldGroup>

          <EditorFieldGroup>
            <TagInputField
              label={t("settings.freezoneCatalog.newRecipe.mustHaveItems")}
              placeholder={t("settings.freezoneCatalog.newRecipe.mustHaveItemsPlaceholder")}
              value={recipeDraft.mustHaveItems}
              onChange={(value) => updateRecipeDraft({ mustHaveItems: value })}
              hint={t("settings.freezoneCatalog.newRecipe.mustHaveItemsHint")}
            />
            <EditorField
              label={t("settings.freezoneCatalog.newRecipe.planningPrompt")}
              placeholder={t("settings.freezoneCatalog.newRecipe.planningPromptPlaceholder")}
              value={recipeDraft.planningPrompt}
              onChange={(value) => updateRecipeDraft({ planningPrompt: value })}
            />
            <EditorField
              label={t("settings.freezoneCatalog.newRecipe.resultSummary")}
              placeholder={t("settings.freezoneCatalog.newRecipe.resultSummaryPlaceholder")}
              value={recipeDraft.resultSummary}
              onChange={(value) => updateRecipeDraft({ resultSummary: value })}
            />
            <ToggleRow
              label={t("settings.freezoneCatalog.newRecipe.sourceMediaRequired")}
              hint={t("settings.freezoneCatalog.newRecipe.sourceMediaRequiredHint")}
              checked={recipeDraft.sourceMediaRequired}
              onChange={(value) => updateRecipeDraft({ sourceMediaRequired: value })}
            />
          </EditorFieldGroup>

          <RawJsonDisclosure
            open={rawJsonOpen}
            onOpenChange={setRawJsonOpen}
            label={t("settings.freezoneCatalog.newRecipe.rawJson")}
            collapseLabel={t("settings.freezoneCatalog.newRecipe.collapseRawJson")}
            ariaLabel={t("settings.freezoneCatalog.newRecipe.rawJsonAria")}
            hint={t("settings.freezoneCatalog.newRecipe.rawJsonSyncHint")}
            jsonText={rawRecipeJsonText}
            copyLabel={t("settings.freezoneCatalog.newRecipe.copyRawJson")}
            copiedMessage={t("settings.freezoneCatalog.newRecipe.rawJsonCopied")}
            copyFailedMessage={t("settings.freezoneCatalog.newRecipe.rawJsonCopyFailed")}
          />
        </div>

        <DialogFooter className="border-t border-border bg-black px-6 py-4">
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            {t("settings.freezoneCatalog.newRecipe.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!canSave}
            onClick={() => {
              void onSave(rawRecipeJson);
            }}
          >
            {t("settings.freezoneCatalog.newRecipe.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewSkillEditor({
  initialPayload,
  open,
  onOpenChange,
  onSave,
  recipes,
  saving,
}: {
  initialPayload: FreezoneAgentConfigPayload | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (payload: FreezoneAgentConfigPayload) => Promise<void>;
  recipes: ManagedCatalogItem[];
  saving: boolean;
}) {
  const { t } = useTranslation();
  const [skillDraft, setSkillDraft] = useState<SkillDraft>({
    id: "",
    name: "",
    schemaVersion: "",
    version: "",
    category: "general",
    description: "",
    keywords: [],
    nodeScopes: [],
    allowedRecipeIds: [],
    inputParameters: [],
    planningNotes: "",
    promptGuide: "",
    conductRules: [],
    qualityThreshold: "",
    domainConstraints: "",
  });
  const [ratingBands, setRatingBands] = useState<RatingBandDraft[]>([]);
  const [visualReviewItems, setVisualDimensions] = useState<DimensionDraft[]>([]);
  const [textReviewItems, setTextDimensions] = useState<DimensionDraft[]>([]);
  const [rawJsonOpen, setRawJsonOpen] = useState(false);
  const [recipePickerOpen, setRecipePickerOpen] = useState(false);
  const [recipeDetail, setRecipeDetail] = useState<ManagedCatalogItem | null>(null);

  useEffect(() => {
    if (!open) return;
    const hydrated = skillDraftFromPayload(initialPayload);
    setSkillDraft(hydrated.draft);
    setRatingBands(hydrated.ratingBands);
    setVisualDimensions(hydrated.visualReviewItems);
    setTextDimensions(hydrated.textReviewItems);
    setRawJsonOpen(false);
    setRecipePickerOpen(false);
    setRecipeDetail(null);
  }, [initialPayload, open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setSkillDraft({
        id: "",
        name: "",
        schemaVersion: "",
        version: "",
        category: "general",
        description: "",
        keywords: [],
        nodeScopes: [],
        allowedRecipeIds: [],
        inputParameters: [],
        planningNotes: "",
        promptGuide: "",
        conductRules: [],
        qualityThreshold: "",
        domainConstraints: "",
      });
      setRatingBands([]);
      setVisualDimensions([]);
      setTextDimensions([]);
      setRawJsonOpen(false);
      setRecipePickerOpen(false);
      setRecipeDetail(null);
    }
    onOpenChange(nextOpen);
  };

  const updateSkillDraft = (patch: Partial<SkillDraft>) => {
    setSkillDraft((draft) => ({ ...draft, ...patch }));
  };

  const addRatingBand = () => {
    setRatingBands((items) => [
      ...items,
      { id: getNextDraftId(items), score: "0", description: "" },
    ]);
  };

  const updateRatingBand = (id: number, patch: Partial<Omit<RatingBandDraft, "id">>) => {
    setRatingBands((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const addDimension = (
    setItems: Dispatch<SetStateAction<DimensionDraft[]>>,
  ) => {
    setItems((items) => [
      ...items,
      { id: getNextDraftId(items), name: "", weight: "1", description: "" },
    ]);
  };

  const updateDimension =
    (setItems: Dispatch<SetStateAction<DimensionDraft[]>>) =>
    (id: number, patch: Partial<Omit<DimensionDraft, "id">>) => {
      setItems((items) =>
        items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      );
    };

  const inputParameters = useMemo(
    () => inputParametersPayloadFromDrafts(skillDraft.inputParameters),
    [skillDraft.inputParameters],
  );
  const rawSkillJson = useMemo(
    () => {
      const basePayload = { ...(initialPayload ?? {}) };
      return {
        ...basePayload,
        id: skillDraft.id,
        name: skillDraft.name.trim() || skillDraft.id,
        schema_version: skillDraft.schemaVersion || "dramaclaw.workflow-skill.v1",
        version: skillDraft.version || "1.0.0",
        description: skillDraft.description,
        category: skillDraft.category || "general",
        triggers: {
          keywords: skillDraft.keywords,
          node_scopes: skillDraft.nodeScopes,
        },
        ...(skillDraft.allowedRecipeIds.length > 0
          ? { allowed_recipe_ids: skillDraft.allowedRecipeIds }
          : {}),
        ...(inputParameters.length > 0
          ? { input_parameters: inputParameters }
          : {}),
        planning: {
          planning_notes: skillDraft.planningNotes,
          prompt_guide: skillDraft.promptGuide,
          conduct_rules: skillDraft.conductRules,
        },
        evaluation: {
          rating_bands: ratingBands.map((anchor) => ({
            score: parseNumericDraft(anchor.score, 0),
            description: anchor.description,
          })),
          visual_review_items: visualReviewItems.map((dimension) => ({
            name: dimension.name,
            weight: parseNumericDraft(dimension.weight, 1),
            description: dimension.description,
          })),
          text_review_items: textReviewItems.map((dimension) => ({
            name: dimension.name,
            weight: parseNumericDraft(dimension.weight, 1),
            description: dimension.description,
          })),
          quality_threshold: parseOptionalNumericDraft(skillDraft.qualityThreshold),
          domain_constraints: splitDraftList(skillDraft.domainConstraints),
        },
      };
    },
    [initialPayload, inputParameters, ratingBands, skillDraft, textReviewItems, visualReviewItems],
  );
  const rawSkillJsonText = useMemo(() => JSON.stringify(rawSkillJson, null, 2), [rawSkillJson]);
  const canSave = isValidSkillDraft(skillDraft) && !saving;
  const isEditing = Boolean(initialPayload);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        portalContainer={getBodyPortalContainer()}
        className="grid h-[min(86vh,704px)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-lg border border-border bg-black p-0 text-foreground ring-0 sm:max-w-[720px]"
        overlayClassName="bg-black/35"
      >
        <DialogHeader className="flex-row items-center justify-between gap-4 border-b border-border px-6 py-5">
          <DialogTitle className="text-lg font-semibold text-foreground">
            {t(
              isEditing
                ? "settings.freezoneCatalog.newSkill.editTitle"
                : "settings.freezoneCatalog.newSkill.title",
            )}
          </DialogTitle>
          <button
            type="button"
            aria-label={t("settings.freezoneCatalog.newSkill.close")}
            onClick={() => handleOpenChange(false)}
            className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto px-6 py-5">
          <div className="grid gap-3 md:grid-cols-3">
            <EditorField
              required
              label={t("settings.freezoneCatalog.newSkill.id")}
              placeholder="my-skill"
              value={skillDraft.id}
              onChange={(value) => updateSkillDraft({ id: value })}
              hint={t("settings.freezoneCatalog.newSkill.idHint")}
            />
            <EditorField
              label={t("settings.freezoneCatalog.newSkill.name")}
              placeholder={t("settings.freezoneCatalog.newSkill.namePlaceholder")}
              value={skillDraft.name}
              onChange={(value) => updateSkillDraft({ name: value })}
            />
            <EditorField
              required
              label={t("settings.freezoneCatalog.newSkill.category")}
              placeholder="general"
              value={skillDraft.category}
              onChange={(value) => updateSkillDraft({ category: value })}
            />
            <EditorField
              required
              className="md:col-span-3"
              label={t("settings.freezoneCatalog.newSkill.description")}
              placeholder={t("settings.freezoneCatalog.newSkill.descriptionPlaceholder")}
              value={skillDraft.description}
              onChange={(value) => updateSkillDraft({ description: value })}
            />
          </div>

          <EditorSection
            title={t("settings.freezoneCatalog.newSkill.workflow2Title")}
            description={t("settings.freezoneCatalog.newSkill.workflow2Description")}
          >
            <AllowedRecipesEditor
              availableRecipes={recipes}
              detailRecipe={recipeDetail}
              pickerOpen={recipePickerOpen}
              label={t("settings.freezoneCatalog.newSkill.allowedRecipeIds")}
              value={skillDraft.allowedRecipeIds}
              onChange={(value) => updateSkillDraft({ allowedRecipeIds: value })}
              onDetailChange={setRecipeDetail}
              onPickerOpenChange={setRecipePickerOpen}
              hint={t("settings.freezoneCatalog.newSkill.allowedRecipeIdsHint")}
            />
            <InputParametersEditor
              label={t("settings.freezoneCatalog.newSkill.inputParameters")}
              hint={t("settings.freezoneCatalog.newSkill.inputParametersHint")}
              emptyLabel={t("settings.freezoneCatalog.newSkill.inputParametersEmpty")}
              parameters={skillDraft.inputParameters}
              onAdd={() =>
                updateSkillDraft({
                  inputParameters: [
                    ...skillDraft.inputParameters,
                    createInputParameterDraft(skillDraft.inputParameters),
                  ],
                })
              }
              onChange={(id, patch) =>
                updateSkillDraft({
                  inputParameters: skillDraft.inputParameters.map((parameter) =>
                    parameter.id === id ? { ...parameter, ...patch } : parameter,
                  ),
                })
              }
              onRemove={(id) =>
                updateSkillDraft({
                  inputParameters: skillDraft.inputParameters.filter((parameter) => parameter.id !== id),
                })
              }
              addLabel={t("settings.freezoneCatalog.newSkill.addInputParameter")}
              defaultLabel={t("settings.freezoneCatalog.newSkill.inputParameterDefault")}
              defaultPlaceholder={t("settings.freezoneCatalog.newSkill.inputParameterDefaultPlaceholder")}
              deleteLabel={t("settings.freezoneCatalog.newSkill.deleteInputParameter")}
              idLabel={t("settings.freezoneCatalog.newSkill.inputParameterId")}
              idPlaceholder={t("settings.freezoneCatalog.newSkill.inputParameterIdPlaceholder")}
              parameterLabel={t("settings.freezoneCatalog.newSkill.inputParameterLabel")}
              labelPlaceholder={t("settings.freezoneCatalog.newSkill.inputParameterLabelPlaceholder")}
              optionsLabel={t("settings.freezoneCatalog.newSkill.inputParameterOptionList")}
              optionsCountLabel={(count) =>
                t("settings.freezoneCatalog.newSkill.inputParameterOptions", { count })}
              optionValueLabel={t("settings.freezoneCatalog.newSkill.inputParameterOptionValue")}
              optionValuePlaceholder={t("settings.freezoneCatalog.newSkill.inputParameterOptionValuePlaceholder")}
              addOptionLabel={t("settings.freezoneCatalog.newSkill.addInputParameterOption")}
              deleteOptionLabel={t("settings.freezoneCatalog.newSkill.deleteInputParameterOption")}
              requiredLabel={t("settings.freezoneCatalog.newSkill.inputParameterRequired")}
              typeFieldLabel={t("settings.freezoneCatalog.newSkill.inputParameterType")}
              expandLabel={t("settings.freezoneCatalog.newSkill.expandInputParameter")}
              collapseLabel={t("settings.freezoneCatalog.newSkill.collapseInputParameter")}
              typeLabel={(type) =>
                t(`settings.freezoneCatalog.newSkill.inputParameterTypes.${type}`, {
                  defaultValue: type || "text",
                })
              }
            />
            <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
              <span>
                {t("settings.freezoneCatalog.newSkill.schemaVersion")}
                {": "}
                {skillDraft.schemaVersion || "dramaclaw.workflow-skill.v1"}
              </span>
              <span>
                {t("settings.freezoneCatalog.newSkill.version")}
                {": "}
                {skillDraft.version || "1.0.0"}
              </span>
            </div>
          </EditorSection>

          <EditorSection
            title={t("settings.freezoneCatalog.newSkill.triggerTitle")}
            description={t("settings.freezoneCatalog.newSkill.triggerDescription")}
          >
            <TagInputField
              required
              label={t("settings.freezoneCatalog.newSkill.keywords")}
              placeholder={t("settings.freezoneCatalog.newSkill.keywordsPlaceholder")}
              value={skillDraft.keywords}
              onChange={(value) => updateSkillDraft({ keywords: value })}
              hint={t("settings.freezoneCatalog.newSkill.keywordsHint")}
            />
            <NodeScopeOptionsField
              label={t("settings.freezoneCatalog.newSkill.nodeScopes")}
              value={skillDraft.nodeScopes}
              onChange={(value) => updateSkillDraft({ nodeScopes: value })}
            />
          </EditorSection>

          <EditorSection
            title={t("settings.freezoneCatalog.newSkill.planningTitle")}
            description={t("settings.freezoneCatalog.newSkill.planningDescription")}
          >
            <EditorTextarea
              label={t("settings.freezoneCatalog.newSkill.planningNotes")}
              placeholder={t("settings.freezoneCatalog.newSkill.planningNotesPlaceholder")}
              value={skillDraft.planningNotes}
              onChange={(value) => updateSkillDraft({ planningNotes: value })}
            />
            <EditorTextarea
              label={t("settings.freezoneCatalog.newSkill.promptGuide")}
              placeholder={t("settings.freezoneCatalog.newSkill.promptGuidePlaceholder")}
              value={skillDraft.promptGuide}
              onChange={(value) => updateSkillDraft({ promptGuide: value })}
            />
            <TagInputField
              layout="stacked"
              label={t("settings.freezoneCatalog.newSkill.conductRules")}
              placeholder={t("settings.freezoneCatalog.newSkill.conductRulesPlaceholder")}
              value={skillDraft.conductRules}
              onChange={(value) => updateSkillDraft({ conductRules: value })}
            />
          </EditorSection>

          <EditorSection
            title={t("settings.freezoneCatalog.newSkill.evaluationTitle")}
            description={t("settings.freezoneCatalog.newSkill.evaluationDescription")}
          >
            <EditorField
              label={t("settings.freezoneCatalog.newSkill.qualityThreshold")}
              placeholder={t("settings.freezoneCatalog.newSkill.qualityThresholdPlaceholder")}
              className="max-w-[320px]"
              value={skillDraft.qualityThreshold}
              onChange={(value) => updateSkillDraft({ qualityThreshold: value })}
            />
            <EditorField
              label={t("settings.freezoneCatalog.newSkill.domainConstraints")}
              placeholder={t("settings.freezoneCatalog.newSkill.domainConstraintsPlaceholder")}
              value={skillDraft.domainConstraints}
              onChange={(value) => updateSkillDraft({ domainConstraints: value })}
            />
            <RatingBandsField
              anchors={ratingBands}
              onAdd={addRatingBand}
              onChange={updateRatingBand}
              onRemove={(id) =>
                setRatingBands((items) => items.filter((item) => item.id !== id))
              }
            />
            <DimensionListField
              label={t("settings.freezoneCatalog.newSkill.visualReviewItems")}
              dimensions={visualReviewItems}
              onAdd={() => addDimension(setVisualDimensions)}
              onChange={updateDimension(setVisualDimensions)}
              onRemove={(id) =>
                setVisualDimensions((items) => items.filter((item) => item.id !== id))
              }
            />
            <DimensionListField
              label={t("settings.freezoneCatalog.newSkill.textReviewItems")}
              dimensions={textReviewItems}
              onAdd={() => addDimension(setTextDimensions)}
              onChange={updateDimension(setTextDimensions)}
              onRemove={(id) =>
                setTextDimensions((items) => items.filter((item) => item.id !== id))
              }
            />
          </EditorSection>

          <RawJsonDisclosure
            open={rawJsonOpen}
            onOpenChange={setRawJsonOpen}
            label={t("settings.freezoneCatalog.newSkill.rawJson")}
            collapseLabel={t("settings.freezoneCatalog.newSkill.collapseRawJson")}
            ariaLabel={t("settings.freezoneCatalog.newSkill.rawJsonAria")}
            hint={t("settings.freezoneCatalog.newSkill.rawJsonSyncHint")}
            jsonText={rawSkillJsonText}
            copyLabel={t("settings.freezoneCatalog.newSkill.copyRawJson")}
            copiedMessage={t("settings.freezoneCatalog.newSkill.rawJsonCopied")}
            copyFailedMessage={t("settings.freezoneCatalog.newSkill.rawJsonCopyFailed")}
          />
        </div>

        <DialogFooter className="border-t border-border bg-black px-6 py-4">
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            {t("settings.freezoneCatalog.newSkill.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!canSave}
            onClick={() => {
              void onSave(rawSkillJson);
            }}
          >
            {t("settings.freezoneCatalog.newSkill.save")}
          </Button>
        </DialogFooter>
        <RecipeDetailDrawer recipe={recipeDetail} onClose={() => setRecipeDetail(null)} />
      </DialogContent>
    </Dialog>
  );
}

function getNextDraftId(items: Array<{ id: number }>) {
  return Math.max(0, ...items.map((item) => item.id)) + 1;
}

function recipeDraftFromPayload(payload: FreezoneAgentConfigPayload | null): RecipeDraft {
  return {
    id: getString(payload?.id),
    name: getString(payload?.name),
    outputKind: isRecipeGenerationType(payload?.output_kind) ? payload.output_kind : "image",
    actionKeys: getStringArray(payload?.action_keys),
    system_prompt: getString(payload?.system_prompt),
    mustHaveItems: getStringArray(payload?.must_have_items),
    planningPrompt: getString(payload?.planning_prompt),
    resultSummary: getString(payload?.result_summary),
    sourceMediaRequired: payload?.requires_source_media === true,
  };
}

function skillDraftFromPayload(payload: FreezoneAgentConfigPayload | null): {
  draft: SkillDraft;
  ratingBands: RatingBandDraft[];
  visualReviewItems: DimensionDraft[];
  textReviewItems: DimensionDraft[];
} {
  const triggers = getRecord(payload?.triggers);
  const planning = getRecord(payload?.planning);
  const evaluation = getRecord(payload?.evaluation);
  return {
    draft: {
      id: getString(payload?.id),
      name: getString(payload?.name),
      schemaVersion: getString(payload?.schema_version ?? payload?.schemaVersion),
      version: getString(payload?.version),
      category: getString(payload?.category) || "general",
      description: getString(payload?.description),
      keywords: getStringArray(triggers.keywords),
      nodeScopes: getStringArray(triggers.node_scopes ?? triggers.nodeTypes ?? triggers.node_types),
      allowedRecipeIds: getStringArray(payload?.allowed_recipe_ids ?? payload?.allowedRecipeIds),
      inputParameters: inputParameterDraftsFromPayload(payload?.input_parameters ?? payload?.inputParameters),
      planningNotes: getString(planning.planning_notes),
      promptGuide: getString(planning.prompt_guide),
      conductRules: getStringArray(planning.conduct_rules),
      qualityThreshold: optionalNumberText(evaluation.quality_threshold),
      domainConstraints: getStringArray(evaluation.domain_constraints).join("\n"),
    },
    ratingBands: getRecordArray(evaluation.rating_bands).map((item, index) => ({
      id: index + 1,
      score: optionalNumberText(item.score) || "0",
      description: getString(item.description),
    })),
    visualReviewItems: getRecordArray(evaluation.visual_review_items).map((item, index) => ({
      id: index + 1,
      name: getString(item.name),
      weight: optionalNumberText(item.weight) || "1",
      description: getString(item.description),
    })),
    textReviewItems: getRecordArray(evaluation.text_review_items).map((item, index) => ({
      id: index + 1,
      name: getString(item.name),
      weight: optionalNumberText(item.weight) || "1",
      description: getString(item.description),
    })),
  };
}

function isRecipeGenerationType(value: unknown): value is RecipeGenerationType {
  return value === "image" || value === "video" || value === "audio" || value === "text";
}

function isValidSkillDraft(draft: SkillDraft) {
  return (
    draft.id.trim().length > 0 &&
    draft.category.trim().length > 0 &&
    draft.description.trim().length > 0 &&
    draft.keywords.some((keyword) => keyword.trim().length > 0)
  );
}

function isValidRecipeDraft(draft: RecipeDraft) {
  return (
    draft.id.trim().length > 0 &&
    draft.name.trim().length > 0 &&
    isRecipeGenerationType(draft.outputKind) &&
    draft.actionKeys.some((key) => key.trim().length > 0) &&
    draft.system_prompt.trim().length > 0 &&
    draft.planningPrompt.trim().length > 0 &&
    draft.resultSummary.trim().length > 0
  );
}

function optionalNumberText(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function isSkillInputParameterType(value: unknown): value is SkillInputParameterType {
  return typeof value === "string"
    && (SKILL_INPUT_PARAMETER_TYPES as string[]).includes(value);
}

function createInputParameterDraft(items: SkillInputParameterDraft[]): SkillInputParameterDraft {
  return {
    id: getNextDraftId(items),
    parameterId: "",
    label: "",
    type: "text",
    required: false,
    defaultValue: "",
    optionsText: "",
    expanded: true,
  };
}

function inputParameterDraftsFromPayload(value: unknown): SkillInputParameterDraft[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isPlainObject)
    .map((item, index) => {
      const options = Array.isArray(item.options)
        ? item.options
          .map((option) => {
            if (isPlainObject(option)) {
              const optionValue = getString(option.value);
              const optionLabel = getString(option.label);
              return optionLabel && optionLabel !== optionValue
                ? `${optionValue} | ${optionLabel}`
                : optionValue;
            }
            return getString(option);
          })
          .filter(Boolean)
        : [];
      return {
        id: index + 1,
        parameterId: getString(item.id),
        label: getString(item.label),
        type: isSkillInputParameterType(item.type) ? item.type : "text",
        required: item.required === true,
        defaultValue: item.default === undefined ? "" : String(item.default),
        optionsText: options.join("\n"),
        expanded: false,
      };
    });
}

function inputParametersPayloadFromDrafts(items: SkillInputParameterDraft[]): Record<string, unknown>[] {
  return items.flatMap((item) => {
    const parameterId = item.parameterId.trim();
    const label = item.label.trim();
    if (!parameterId && !label) return [];
    const generatedId = label.toLowerCase().replace(/[^a-z0-9_-]+/giu, "-").replace(/^-+|-+$/gu, "");
    const payload: Record<string, unknown> = {
      id: parameterId || generatedId || `parameter-${item.id}`,
      label: label || parameterId,
      type: item.type,
      required: item.required,
    };
    if (item.defaultValue.trim()) {
      payload.default = item.defaultValue.trim();
    }
    const options = item.optionsText
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [valuePart] = line.split("|");
        return valuePart.trim();
      })
      .filter(Boolean);
    if (options.length > 0) {
      payload.options = options;
    }
    return [payload];
  });
}

interface InputParameterOptionRow {
  id: number;
  value: string;
}

function optionRowsFromText(value: string): InputParameterOptionRow[] {
  const rows = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [valuePart] = line.split("|");
      const optionValue = valuePart.trim();
      return {
        id: index + 1,
        value: optionValue,
      };
    });
  return rows.length > 0 ? rows : [{ id: 1, value: "" }];
}

function optionRowsToText(rows: InputParameterOptionRow[]): string {
  return rows
    .map((row) => {
      const value = row.value.trim();
      return value;
    })
    .filter(Boolean)
    .join("\n");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function getRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function parseNumericDraft(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalNumericDraft(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return parseNumericDraft(trimmed, 0);
}

function splitDraftList(value: string) {
  return value
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function EditorSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <div className="mt-5 border-t border-border pt-4">
      <h4 className="text-xs font-medium text-foreground">{title}</h4>
      {description ? (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      <div className="mt-3 space-y-3">{children}</div>
    </div>
  );
}

function EditorFieldGroup({ children }: { children: ReactNode }) {
  return <div className="mt-5 space-y-3 border-t border-border pt-4">{children}</div>;
}

function EditorLabel({ children, required }: { children: ReactNode; required?: boolean }) {
  return (
    <span className="mb-1.5 block text-xs font-medium text-foreground">
      {children}
      {required ? <span className="ml-1 text-destructive">*</span> : null}
    </span>
  );
}

function EditorField({
  className,
  defaultValue,
  hint,
  label,
  onChange,
  placeholder,
  readOnly,
  required,
  value,
}: {
  className?: string;
  defaultValue?: string;
  hint?: string;
  label: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  required?: boolean;
  value?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <EditorLabel required={required}>{label}</EditorLabel>
      <Input
        defaultValue={value === undefined ? defaultValue : undefined}
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
        placeholder={placeholder}
        className={cn(
          "h-9 rounded-md border-input/80 bg-input/20 text-foreground placeholder:text-muted-foreground focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30",
          readOnly ? "cursor-default text-muted-foreground" : "",
        )}
      />
      {hint ? <span className="mt-1 block text-[10px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function TagInputField({
  hint,
  label,
  layout = "inline",
  onChange,
  placeholder,
  required,
  value,
}: {
  hint?: string;
  label: string;
  layout?: "inline" | "stacked";
  onChange: (value: string[]) => void;
  placeholder?: string;
  required?: boolean;
  value: string[];
}) {
  const [draft, setDraft] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const items = Array.isArray(value) ? value : getStringArray(value);

  const addDraft = () => {
    const next = draft.trim();
    if (!next) return;
    onChange(items.includes(next) ? items : [...items, next]);
    setDraft("");
  };

  const removeTag = (indexToRemove: number) => {
    onChange(items.filter((_, index) => index !== indexToRemove));
  };

  const beginEditTag = (index: number, tag: string) => {
    setEditingIndex(index);
    setEditingDraft(tag);
    requestAnimationFrame(() => editInputRef.current?.focus({ preventScroll: true }));
  };

  const commitEditTag = () => {
    if (editingIndex === null) return;
    const nextTag = editingDraft.trim();
    const nextItems = nextTag
      ? items.map((item, index) => (index === editingIndex ? nextTag : item))
      : items.filter((_, index) => index !== editingIndex);
    onChange(Array.from(new Set(nextItems.filter(Boolean))));
    setEditingIndex(null);
    setEditingDraft("");
  };

  return (
    <div className="block">
      <EditorLabel required={required}>{label}</EditorLabel>
      <div
        className={cn(
          "flex min-h-9 items-center gap-1.5 rounded-md border border-input/80 bg-input/20 px-2 py-1 transition-colors focus-within:border-ring/70 focus-within:ring-1 focus-within:ring-ring/30",
          layout === "stacked" ? "flex-col items-stretch" : "flex-wrap",
        )}
      >
        {items.map((tag, index) => (
          <span
            key={`${tag}:${index}`}
            className={cn(
              "inline-flex max-w-full items-center gap-1 rounded bg-white/[0.07] px-2 text-xs text-foreground",
              layout === "stacked" ? "min-h-7 w-full py-1" : "h-6",
            )}
          >
            {editingIndex === index ? (
              <input
                ref={editInputRef}
                aria-label={`编辑 ${tag}`}
                value={editingDraft}
                onChange={(event) => setEditingDraft(event.target.value)}
                onBlur={commitEditTag}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitEditTag();
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setEditingIndex(null);
                    setEditingDraft("");
                  }
                }}
                style={layout === "stacked"
                  ? undefined
                  : { width: `${Math.min(Math.max(editingDraft.length + 1.5, 4.5), 26)}em` }}
                className={cn(
                  "h-5 max-w-full rounded-sm bg-black/20 px-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring/40",
                  layout === "stacked" && "w-full min-w-0 flex-1",
                )}
              />
            ) : (
              <button
                type="button"
                aria-label={`编辑 ${tag}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => beginEditTag(index, tag)}
                className={cn(
                  "min-w-0 flex-1 rounded-sm text-left transition-colors hover:text-cyan-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40",
                  layout === "stacked" ? "whitespace-normal break-words leading-4" : "truncate",
                )}
              >
                {tag}
              </button>
            )}
            <button
              type="button"
              aria-label={`删除 ${tag}`}
              onClick={() => removeTag(index)}
              className="grid size-3.5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addDraft();
              return;
            }
            if (event.key === "," || event.key === "，") {
              event.preventDefault();
              addDraft();
              return;
            }
            if ((event.key === "Backspace" || event.key === "Delete") && !draft && items.length) {
              event.preventDefault();
              onChange(items.slice(0, -1));
            }
          }}
          onBlur={addDraft}
          placeholder={items.length ? undefined : placeholder}
          className={cn(
            "h-6 min-w-24 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground",
            layout === "stacked" && "w-full flex-none",
          )}
        />
      </div>
      {hint ? <span className="mt-1 block text-[10px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function AllowedRecipesEditor({
  availableRecipes,
  detailRecipe,
  hint,
  label,
  onChange,
  onDetailChange,
  onPickerOpenChange,
  pickerOpen,
  value,
}: {
  availableRecipes: ManagedCatalogItem[];
  detailRecipe: ManagedCatalogItem | null;
  hint?: string;
  label: string;
  onChange: (value: string[]) => void;
  onDetailChange: (recipe: ManagedCatalogItem | null) => void;
  onPickerOpenChange: (open: boolean) => void;
  pickerOpen: boolean;
  value: string[];
}) {
  const [query, setQuery] = useState("");
  const [manualRecipeId, setManualRecipeId] = useState("");
  const [expanded, setExpanded] = useState(false);
  const recipeById = useMemo(() => {
    return new Map(availableRecipes.map((recipe) => [recipe.id, recipe]));
  }, [availableRecipes]);
  const linkedIds = useMemo(
    () => Array.from(new Set(value.map((id) => id.trim()).filter(Boolean))),
    [value],
  );
  const selectedIdSet = useMemo(() => new Set(linkedIds), [linkedIds]);
  const missingRecipeCount = useMemo(
    () => linkedIds.filter((recipeId) => !recipeById.has(recipeId)).length,
    [linkedIds, recipeById],
  );
  const filteredRecipes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return availableRecipes
      .filter((recipe) => !selectedIdSet.has(recipe.id))
      .filter((recipe) => {
        if (!needle) return true;
        return [recipe.id, recipe.title, recipe.description, ...recipe.tags]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      });
  }, [availableRecipes, query, selectedIdSet]);

  const removeRecipe = (recipeId: string) => {
    onChange(linkedIds.filter((id) => id !== recipeId));
    if (detailRecipe?.id === recipeId) {
      onDetailChange(null);
    }
  };

  const addRecipe = (recipeId: string) => {
    if (selectedIdSet.has(recipeId)) return;
    onChange([...linkedIds, recipeId]);
    onPickerOpenChange(false);
    setQuery("");
  };
  const addManualRecipe = () => {
    const recipeId = manualRecipeId.trim();
    if (!recipeId || selectedIdSet.has(recipeId)) return;
    onChange([...linkedIds, recipeId]);
    setManualRecipeId("");
    setQuery("");
    onPickerOpenChange(false);
  };

  return (
    <div className="block">
      <div className="overflow-hidden rounded-md border border-input/80 bg-input/10">
        <div className="flex items-center gap-3 px-3 py-2.5">
          <button
            type="button"
            aria-label={expanded ? "收起关联 Recipes" : "展开关联 Recipes"}
            onClick={() => setExpanded((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            {expanded ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-foreground">{label}</span>
              <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                {linkedIds.length > 0
                  ? `已关联 ${linkedIds.length} 个 Recipe${missingRecipeCount > 0 ? `，${missingRecipeCount} 个未找到配置` : ""}`
                  : "这个 Skill 暂时没有关联 Recipe"}
              </span>
            </span>
          </button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onPickerOpenChange(true)}
            className="h-8 shrink-0"
          >
            <Plus className="size-3.5" />
            添加 Recipe
          </Button>
        </div>
        {hint ? (
          <div className="border-t border-border/60 px-3 py-1.5 text-[10px] text-muted-foreground">
            {hint}
          </div>
        ) : null}
        {expanded ? (
          <div className="border-t border-border/60">
            {linkedIds.length > 0 ? (
              linkedIds.map((recipeId) => {
                const recipe = recipeById.get(recipeId);
                return (
                  <div
                    key={recipeId}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border/60 px-3 py-2.5 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        {recipe?.generationType ? (
                          <span className={catalogGenerationTypeBadgeClass(recipe.generationType)}>
                            {recipe.generationType}
                          </span>
                        ) : null}
                        <span className="truncate text-[13px] font-medium text-foreground">
                          {recipe?.title || recipeId}
                        </span>
                        <span className="truncate font-mono text-[11px] text-muted-foreground/70">
                          {recipeId}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                        {recipe?.description || "未找到本地 Recipe 配置，保存时仍会保留这个关联 ID。"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={!recipe}
                        onClick={() => recipe && onDetailChange(recipe)}
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <Eye className="size-3.5" />
                        查看
                      </Button>
                      <button
                        type="button"
                        aria-label={`移除 ${recipeId}`}
                        onClick={() => removeRecipe(recipeId)}
                        className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="px-3 py-3 text-xs text-muted-foreground">
                这个 Skill 暂时没有关联 Recipe
              </div>
            )}
          </div>
        ) : null}
      </div>

      <Dialog open={pickerOpen} onOpenChange={onPickerOpenChange}>
        <DialogContent
          portalContainer={getBodyPortalContainer()}
          className="max-w-[520px] gap-0 overflow-hidden rounded-lg border-border bg-black p-0"
        >
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle className="text-base">添加 Recipe</DialogTitle>
          </DialogHeader>
          <div className="p-5">
            <div className="mb-3 grid gap-2 rounded-md border border-border/70 bg-white/[0.02] p-3">
              <div className="text-[11px] font-medium text-foreground">手动添加 ID</div>
              <div className="flex gap-2">
                <Input
                  value={manualRecipeId}
                  onChange={(event) => setManualRecipeId(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addManualRecipe();
                    }
                  }}
                  placeholder="输入 Recipe ID"
                  className="h-9 rounded-md border-input/80 bg-input/20 text-foreground"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!manualRecipeId.trim()}
                  onClick={addManualRecipe}
                >
                  添加
                </Button>
              </div>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索 Recipe"
                className="h-9 rounded-md border-input/80 bg-input/20 pl-9 text-foreground"
              />
            </div>
            <div className="mt-3 max-h-[320px] overflow-y-auto rounded-md border border-border/70">
              {filteredRecipes.length > 0 ? (
                filteredRecipes.map((recipe) => (
                  <button
                    key={recipe.id}
                    type="button"
                    onClick={() => addRecipe(recipe.id)}
                    className="block w-full border-b border-border/60 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-white/[0.04]"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {recipe.generationType ? (
                        <span className={catalogGenerationTypeBadgeClass(recipe.generationType)}>
                          {recipe.generationType}
                        </span>
                      ) : null}
                      <span className="truncate text-[13px] font-medium text-foreground">
                        {recipe.title}
                      </span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground/70">
                        {recipe.id}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                      {recipe.description || "暂无描述"}
                    </p>
                  </button>
                ))
              ) : (
                <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                  没有可添加的 Recipe
                </div>
              )}
            </div>
          </div>
          <DialogFooter className="border-t border-border px-5 py-4">
            <Button type="button" variant="outline" onClick={() => onPickerOpenChange(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RecipeDetailDrawer({
  onClose,
  recipe,
}: {
  onClose: () => void;
  recipe: ManagedCatalogItem | null;
}) {
  if (!recipe) return null;
  const payload = recipe.payload;
  const actionKeys = getStringArray(payload.action_keys);
  const mustHaveItems = getStringArray(payload.must_have_items);
  const planningPrompt = getString(payload.planning_prompt);
  const resultSummary = getString(payload.result_summary);
  const systemPrompt = getString(payload.system_prompt);

  return (
    <div className="absolute inset-0 z-20 flex justify-end bg-black/35">
      <button type="button" aria-label="关闭 Recipe 详情背景" className="flex-1" onClick={onClose} />
      <aside className="flex h-full w-[min(430px,92vw)] flex-col border-l border-border bg-black shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                Recipe
              </span>
              {recipe.generationType ? (
                <span className={catalogGenerationTypeBadgeClass(recipe.generationType)}>
                  {recipe.generationType}
                </span>
              ) : null}
            </div>
            <h4 className="truncate text-base font-semibold text-foreground">{recipe.title}</h4>
            <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              {recipe.id}
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭 Recipe 详情"
            onClick={onClose}
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <RecipeDetailBlock title="描述">
            <p>{recipe.description || "暂无描述"}</p>
          </RecipeDetailBlock>
          {resultSummary ? (
            <RecipeDetailBlock title="结果摘要">
              <p>{resultSummary}</p>
            </RecipeDetailBlock>
          ) : null}
          {planningPrompt ? (
            <RecipeDetailBlock title="规划提示">
              <p>{planningPrompt}</p>
            </RecipeDetailBlock>
          ) : null}
          {actionKeys.length > 0 ? (
            <RecipeDetailBlock title="Action Keys">
              <div className="flex flex-wrap gap-1.5">
                {actionKeys.map((key) => (
                  <span key={key} className="rounded bg-white/[0.07] px-2 py-1 font-mono text-[11px]">
                    {key}
                  </span>
                ))}
              </div>
            </RecipeDetailBlock>
          ) : null}
          {mustHaveItems.length > 0 ? (
            <RecipeDetailBlock title="必含项">
              <ul className="space-y-1">
                {mustHaveItems.map((item) => (
                  <li key={item} className="rounded bg-white/[0.04] px-2 py-1">
                    {item}
                  </li>
                ))}
              </ul>
            </RecipeDetailBlock>
          ) : null}
          {systemPrompt ? (
            <RecipeDetailBlock title="System Prompt">
              <pre className="whitespace-pre-wrap break-words rounded-md bg-white/[0.04] p-3 font-sans text-[11px] leading-relaxed">
                {systemPrompt}
              </pre>
            </RecipeDetailBlock>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function RecipeDetailBlock({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section>
      <h5 className="mb-1.5 text-[11px] font-medium text-foreground">{title}</h5>
      <div className="text-[12px] leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

function InputParametersEditor({
  addLabel,
  defaultLabel,
  defaultPlaceholder,
  deleteLabel,
  emptyLabel,
  expandLabel,
  collapseLabel,
  idLabel,
  idPlaceholder,
  label,
  hint,
  labelPlaceholder,
  onAdd,
  onChange,
  onRemove,
  addOptionLabel,
  deleteOptionLabel,
  optionsCountLabel,
  optionsLabel,
  optionValueLabel,
  optionValuePlaceholder,
  parameterLabel,
  parameters,
  requiredLabel,
  typeFieldLabel,
  typeLabel,
}: {
  addLabel: string;
  defaultLabel: string;
  defaultPlaceholder: string;
  deleteLabel: string;
  emptyLabel: string;
  expandLabel: string;
  collapseLabel: string;
  idLabel: string;
  idPlaceholder: string;
  label: string;
  hint: string;
  labelPlaceholder: string;
  onAdd: () => void;
  onChange: (id: number, patch: Partial<Omit<SkillInputParameterDraft, "id">>) => void;
  onRemove: (id: number) => void;
  addOptionLabel: string;
  deleteOptionLabel: string;
  optionsCountLabel: (count: number) => string;
  optionsLabel: string;
  optionValueLabel: string;
  optionValuePlaceholder: string;
  parameterLabel: string;
  parameters: SkillInputParameterDraft[];
  requiredLabel: string;
  typeFieldLabel: string;
  typeLabel: (type: string) => string;
}) {
  return (
    <div className="block">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <EditorLabel>{label}</EditorLabel>
          <div className="mt-1 text-[10px] text-muted-foreground">{hint}</div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <Plus className="size-3.5" />
          {addLabel}
        </Button>
      </div>
      {parameters.length > 0 ? (
        <div className="grid gap-2">
          {parameters.map((parameter) => {
            const optionCount = parameter.optionsText
              .split(/\r?\n/u)
              .map((line) => line.trim())
              .filter(Boolean).length;
            const title = parameter.label || parameter.parameterId || label;
            return (
              <div
                key={parameter.id}
                className="overflow-hidden rounded-md border border-input/80 bg-input/20"
              >
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    aria-label={parameter.expanded ? collapseLabel : expandLabel}
                    onClick={() => onChange(parameter.id, { expanded: !parameter.expanded })}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    {parameter.expanded ? (
                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-foreground">
                        {title}
                      </span>
                      {parameter.parameterId ? (
                        <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                          {parameter.parameterId}
                        </span>
                      ) : null}
                    </span>
                    <span className="hidden shrink-0 flex-wrap items-center gap-1 md:flex">
                      <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {typeLabel(parameter.type)}
                      </span>
                      {parameter.defaultValue.trim() ? (
                        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {defaultLabel} {parameter.defaultValue.trim()}
                        </span>
                      ) : null}
                      {optionCount > 0 ? (
                        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {optionsCountLabel(optionCount)}
                        </span>
                      ) : null}
                      {parameter.required ? (
                        <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] text-cyan-200">
                          {requiredLabel}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={deleteLabel}
                    onClick={() => onRemove(parameter.id)}
                    className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-red-300"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                {parameter.expanded ? (
                  <div className="border-t border-input/70 px-3 pb-3 pt-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <EditorField
                        label={idLabel}
                        placeholder={idPlaceholder}
                        value={parameter.parameterId}
                        onChange={(value) => onChange(parameter.id, { parameterId: value })}
                      />
                      <EditorField
                        label={parameterLabel}
                        placeholder={labelPlaceholder}
                        value={parameter.label}
                        onChange={(value) => onChange(parameter.id, { label: value })}
                      />
                      <label className="block">
                        <EditorLabel>{typeFieldLabel}</EditorLabel>
                        <Select
                          value={parameter.type}
                          onValueChange={(value) =>
                            onChange(parameter.id, {
                              type: isSkillInputParameterType(value) ? value : "text",
                            })}
                        >
                          <SelectTrigger className="h-9 rounded-md border-input/80 bg-input/20 text-foreground">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {SKILL_INPUT_PARAMETER_TYPES.map((type) => (
                              <SelectItem key={type} value={type}>
                                {typeLabel(type)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </label>
                      <EditorField
                        label={defaultLabel}
                        placeholder={defaultPlaceholder}
                        value={parameter.defaultValue}
                        onChange={(value) => onChange(parameter.id, { defaultValue: value })}
                      />
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
                      <InputParameterOptionsEditor
                        label={optionsLabel}
                        value={parameter.optionsText}
                        onChange={(value) => onChange(parameter.id, { optionsText: value })}
                        addLabel={addOptionLabel}
                        deleteLabel={deleteOptionLabel}
                        optionValueLabel={optionValueLabel}
                        optionValuePlaceholder={optionValuePlaceholder}
                      />
                      <div className="self-start rounded-md border border-input/80 bg-black/20 p-3">
                        <ToggleRow
                          label={requiredLabel}
                          checked={parameter.required}
                          onChange={(checked) => onChange(parameter.id, { required: checked })}
                        />
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-input/80 bg-input/20 px-3 py-2 text-xs text-muted-foreground">
          {emptyLabel}
        </div>
      )}
    </div>
  );
}

function InputParameterOptionsEditor({
  addLabel,
  deleteLabel,
  label,
  onChange,
  optionValueLabel,
  optionValuePlaceholder,
  value,
}: {
  addLabel: string;
  deleteLabel: string;
  label: string;
  onChange: (value: string) => void;
  optionValueLabel: string;
  optionValuePlaceholder: string;
  value: string;
}) {
  const [rows, setRows] = useState(() => optionRowsFromText(value));

  useEffect(() => {
    setRows(optionRowsFromText(value));
  }, [value]);

  const updateRows = (nextRows: InputParameterOptionRow[]) => {
    setRows(nextRows);
    onChange(optionRowsToText(nextRows));
  };
  const updateRow = (id: number, patch: Partial<Omit<InputParameterOptionRow, "id">>) => {
    updateRows(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };
  const removeRow = (id: number) => {
    const nextRows = rows.filter((row) => row.id !== id);
    updateRows(nextRows.length > 0 ? nextRows : [{ id: 1, value: "" }]);
  };
  const addRow = () => {
    setRows([...rows, { id: getNextDraftId(rows), value: "" }]);
  };

  return (
    <div className="block">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <EditorLabel>{label}</EditorLabel>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={addRow}
        >
          <Plus className="size-3.5" />
          {addLabel}
        </Button>
      </div>
      <div className="grid gap-2">
        <div className="hidden grid-cols-[minmax(0,1fr)_28px] gap-2 sm:grid">
          <span className="text-[10px] font-medium text-muted-foreground">{optionValueLabel}</span>
          <span />
        </div>
        {rows.map((row) => (
          <div key={row.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_28px]">
            <Input
              aria-label={optionValueLabel}
              autoComplete="off"
              autoCorrect="off"
              name={`skill-input-parameter-option-${row.id}`}
              placeholder={optionValuePlaceholder}
              spellCheck={false}
              value={row.value}
              onChange={(event) => updateRow(row.id, { value: event.target.value })}
              className="h-8 rounded-md border-input/80 bg-input/20 text-xs text-foreground"
            />
            <button
              type="button"
              aria-label={deleteLabel}
              onClick={() => removeRow(row.id)}
              className="grid size-7 place-items-center self-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-red-300"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function NodeScopeOptionsField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string[]) => void;
  value: string[];
}) {
  const selected = Array.isArray(value) ? value.filter(Boolean) : [];
  const selectedSet = new Set(selected);

  const toggleScope = (scope: string, checked: boolean) => {
    if (checked) {
      onChange(selectedSet.has(scope) ? selected : [...selected, scope]);
      return;
    }
    onChange(selected.filter((item) => item !== scope));
  };

  return (
    <div className="block">
      <EditorLabel>{label}</EditorLabel>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {NODE_SCOPE_OPTIONS.map((scope) => {
          const checked = selectedSet.has(scope);
          return (
            <label
              key={scope}
              className={cn(
                "flex min-h-12 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 transition-colors",
                checked
                  ? "border-border/70 bg-white/[0.055] text-foreground"
                  : "border-input/80 bg-input/20 text-foreground hover:border-cyan-500/40 hover:bg-white/[0.035]",
              )}
            >
              <Checkbox
                checked={checked}
                onCheckedChange={(nextChecked) => toggleScope(scope, nextChecked === true)}
              />
              <span className="min-w-0">
                <span className="block text-xs font-medium">{NODE_SCOPE_LABELS[scope]}</span>
                {" "}
                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                  {scope}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function EditorTextarea({
  className,
  label,
  onChange,
  placeholder,
  required,
  value,
}: {
  className?: string;
  label: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  value?: string;
}) {
  return (
    <label className="block">
      <EditorLabel required={required}>{label}</EditorLabel>
      <Textarea
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        placeholder={placeholder}
        className={cn(
          "min-h-16 resize-y rounded-md border-input/80 bg-input/20 text-foreground placeholder:text-muted-foreground focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30",
          className,
        )}
      />
    </label>
  );
}

function ToggleRow({
  checked,
  hint,
  label,
  onChange,
}: {
  checked: boolean;
  hint?: string;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span className="min-w-0">
        <span className="block text-xs font-medium text-foreground">{label}</span>
        {hint ? (
          <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full border transition-colors",
          checked
            ? "border-transparent bg-[#111] dark:bg-white/[0.18]"
            : "border-transparent bg-black/[0.06] dark:bg-white/[0.08]",
        )}
      >
        <span
          className={cn(
            "absolute top-1/2 left-0.5 size-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform",
            checked ? "translate-x-4" : "translate-x-0",
          )}
        />
      </button>
    </label>
  );
}

function RawJsonDisclosure({
  ariaLabel,
  collapseLabel,
  copiedMessage,
  copyFailedMessage,
  copyLabel,
  hint,
  jsonText,
  label,
  onOpenChange,
  open,
}: {
  ariaLabel: string;
  collapseLabel: string;
  copiedMessage?: string;
  copyFailedMessage?: string;
  copyLabel?: string;
  hint: string;
  jsonText: string;
  label: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(jsonText);
      toast.success(copiedMessage ?? copyLabel ?? label);
    } catch {
      toast.error(copyFailedMessage ?? copyLabel ?? label);
    }
  };

  return (
    <>
      <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
        <button
          type="button"
          aria-label={open ? collapseLabel : label}
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="font-mono">{`{}`}</span>
          <ChevronDown className={cn("size-3 transition-transform", open ? "rotate-180" : "")} />
          <span className="truncate">{open ? collapseLabel : label}</span>
        </button>
        {open && copyLabel ? (
          <button
            type="button"
            aria-label={copyLabel}
            title={copyLabel}
            onClick={() => void handleCopyJson()}
            className="grid size-7 shrink-0 place-items-center rounded-md border border-border/70 text-muted-foreground transition-colors hover:border-ring/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
          >
            <Copy className="size-3.5" />
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2">
          <pre
            aria-label={ariaLabel}
            className="max-h-72 overflow-auto rounded-md border border-border/70 bg-white/[0.025] p-3 font-mono text-xs leading-relaxed text-foreground"
          >
            {jsonText}
          </pre>
          <p className="mt-2 text-[10px] text-muted-foreground">{hint}</p>
        </div>
      ) : null}
    </>
  );
}

function DimensionListField({
  dimensions,
  label,
  onAdd,
  onChange,
  onRemove,
}: {
  dimensions: DimensionDraft[];
  label: string;
  onAdd: () => void;
  onChange: (id: number, patch: Partial<Omit<DimensionDraft, "id">>) => void;
  onRemove: (id: number) => void;
}) {
  const { t } = useTranslation();

  return (
    <div>
      <EditorLabel>{label}</EditorLabel>
      <p className="mb-2 text-[10px] text-muted-foreground">
        {t("settings.freezoneCatalog.newSkill.dimensionWeightHint")}
      </p>
      <div className="space-y-2">
        {dimensions.map((dimension) => (
          <div
            key={dimension.id}
            className="rounded-md border border-border/70 bg-white/[0.015] p-2"
          >
            <div className="grid grid-cols-[minmax(0,1fr)_auto_56px_28px] items-center gap-2">
              <Input
                value={dimension.name}
                onChange={(event) =>
                  onChange(dimension.id, { name: event.target.value })
                }
                placeholder={t("settings.freezoneCatalog.newSkill.dimensionNamePlaceholder")}
                className="h-9 rounded-md border-input/80 bg-input/20 text-foreground placeholder:text-muted-foreground focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
              />
              <span className="text-[11px] text-muted-foreground">
                {t("settings.freezoneCatalog.newSkill.dimensionWeight")}
              </span>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={dimension.weight}
                onChange={(event) =>
                  onChange(dimension.id, { weight: event.target.value })
                }
                placeholder={t("settings.freezoneCatalog.newSkill.dimensionWeightPlaceholder")}
                className="h-9 rounded-md border-input/80 bg-input/20 text-foreground placeholder:text-muted-foreground focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
              />
              <button
                type="button"
                aria-label={t("settings.freezoneCatalog.newSkill.removeDimension")}
                onClick={() => onRemove(dimension.id)}
                className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <Input
              value={dimension.description}
              onChange={(event) =>
                onChange(dimension.id, { description: event.target.value })
              }
              placeholder={t("settings.freezoneCatalog.newSkill.dimensionDescriptionPlaceholder")}
              className="mt-2 h-9 rounded-md border-input/80 bg-input/20 text-foreground placeholder:text-muted-foreground focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
            />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <Plus className="size-3.5" />
          {t("settings.freezoneCatalog.newSkill.addDimension")}
        </Button>
      </div>
    </div>
  );
}

function RatingBandsField({
  anchors,
  onAdd,
  onChange,
  onRemove,
}: {
  anchors: RatingBandDraft[];
  onAdd: () => void;
  onChange: (id: number, patch: Partial<Omit<RatingBandDraft, "id">>) => void;
  onRemove: (id: number) => void;
}) {
  const { t } = useTranslation();

  return (
    <div>
      <EditorLabel>{t("settings.freezoneCatalog.newSkill.ratingBands")}</EditorLabel>
      <div className="space-y-2">
        {anchors.map((anchor) => (
          <div
            key={anchor.id}
            className="grid grid-cols-[64px_minmax(0,1fr)_28px] items-center gap-2"
          >
            <Input
              type="number"
              min={0}
              max={10}
              step={0.5}
              value={anchor.score}
              onChange={(event) => onChange(anchor.id, { score: event.target.value })}
              placeholder={t("settings.freezoneCatalog.newSkill.ratingBandScorePlaceholder")}
              className="h-9 rounded-md border-input/80 bg-input/20 text-foreground placeholder:text-muted-foreground focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
            />
            <Input
              value={anchor.description}
              onChange={(event) =>
                onChange(anchor.id, { description: event.target.value })
              }
              placeholder={t(
                "settings.freezoneCatalog.newSkill.ratingBandDescriptionPlaceholder",
              )}
              className="h-9 rounded-md border-input/80 bg-input/20 text-foreground placeholder:text-muted-foreground focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
            />
            <button
              type="button"
              aria-label={t("settings.freezoneCatalog.newSkill.removeRatingBand")}
              onClick={() => onRemove(anchor.id)}
              className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <Plus className="size-3.5" />
          {t("settings.freezoneCatalog.newSkill.addRatingBand")}
        </Button>
      </div>
    </div>
  );
}

interface ManagedCatalogItem {
  builtin: boolean;
  customized: boolean;
  enabled: boolean;
  generationType?: RecipeGenerationType;
  id: string;
  payload: FreezoneAgentConfigPayload;
  title: string;
  description: string;
  tags: string[];
}

interface SkillDeleteCandidate {
  item: ManagedCatalogItem;
  exclusiveRecipes: ManagedCatalogItem[];
  sharedRecipes: ManagedCatalogItem[];
}

function createSkillBundleExportMeta(item: ManagedCatalogItem): Record<string, unknown> {
  const payload = stripCatalogMetadata(item.payload);
  return {
    id: item.id,
    name: item.title || item.id,
    version: getString(payload.version) || "1.0.0",
    description: item.description || item.title || item.id,
    author: "",
    license: "",
    tags: item.tags,
  };
}

function isFreezoneBundlePayload(value: unknown): value is FreezoneAgentBundlePayload {
  if (!isPlainObject(value)) return false;
  return (
    value.schema_version === "dramaclaw.skill-bundle.v1" &&
    typeof value.id === "string" &&
    isPlainObject(value.skill) &&
    Array.isArray(value.recipes)
  );
}

export interface SkillDialogLocalItem {
  id: string;
  label: string;
  category?: string;
  description?: string;
}

export function CommunitySkillDialog({
  error,
  installedSkillIds,
  installing,
  installingBundleUrl,
  items,
  localItems = [],
  loading,
  mode = "community",
  onInstall,
  onModeChange,
  onOpenChange,
  onRetry,
  onSelectLocalSkill,
  open,
}: {
  error: boolean;
  installedSkillIds: Set<string>;
  installing: boolean;
  installingBundleUrl?: string;
  items: FreezoneCommunityCatalogItem[];
  localItems?: SkillDialogLocalItem[];
  loading: boolean;
  mode?: "community" | "mine";
  onInstall: (item: FreezoneCommunityCatalogItem) => void;
  onModeChange?: (mode: "community" | "mine") => void;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  onSelectLocalSkill?: (skillId: string) => void;
  open: boolean;
}) {
  const { t } = useTranslation();
  const isMine = mode === "mine";
  const showMineTab = typeof onModeChange === "function";
  const [skillQuery, setSkillQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState("all");
  const localFilterOptions = useMemo(() => {
    const categories = Array.from(
      new Set(
        localItems
          .map((item) => item.category?.trim())
          .filter((category): category is string => Boolean(category)),
      ),
    );
    return ["all", ...categories];
  }, [localItems]);
  const communityFilterOptions = useMemo(() => {
    const tags = Array.from(new Set(items.flatMap((item) => item.tags.map((tag) => tag.trim()).filter(Boolean))));
    return ["recommended", ...tags].slice(0, 8);
  }, [items]);
  const filterOptions = isMine ? localFilterOptions : communityFilterOptions;
  const normalizedSkillQuery = skillQuery.trim().toLowerCase();
  const visibleLocalItems = useMemo(
    () =>
      localItems.filter((item) => {
        const categoryMatched = activeFilter === "all" || item.category === activeFilter;
        if (!categoryMatched) return false;
        if (!normalizedSkillQuery) return true;
        return [item.id, item.label, item.category, item.description]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(normalizedSkillQuery);
      }),
    [activeFilter, localItems, normalizedSkillQuery],
  );
  const visibleCommunityItems = useMemo(
    () =>
      items.filter((item) => {
        const filterMatched =
          activeFilter === "recommended" || activeFilter === "all" || item.tags.includes(activeFilter);
        if (!filterMatched) return false;
        if (!normalizedSkillQuery) return true;
        return [item.id, item.name, item.description, item.author, ...item.tags]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(normalizedSkillQuery);
      }),
    [activeFilter, items, normalizedSkillQuery],
  );

  useEffect(() => {
    setActiveFilter(mode === "mine" ? "all" : "recommended");
    setSkillQuery("");
  }, [mode, open]);

  useEffect(() => {
    if (!filterOptions.includes(activeFilter)) {
      setActiveFilter(filterOptions[0] ?? (isMine ? "all" : "recommended"));
    }
  }, [activeFilter, filterOptions, isMine]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid h-[min(760px,86vh)] !w-[min(1120px,calc(100vw-40px))] !max-w-[min(1120px,calc(100vw-40px))] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-lg border-border/75 bg-[#070808] p-0 shadow-2xl sm:!max-w-[min(1120px,calc(100vw-40px))]"
        showCloseButton={false}
      >
        <DialogHeader className="border-b border-border/45 px-5 py-4">
          <div className="flex items-center gap-4">
            <div className="flex min-w-0 items-center gap-4">
              {showMineTab ? (
                <div className="flex items-center gap-2">
                  <DialogTitle className="text-base leading-8">
                    <button
                      type="button"
                      className={cn(
                        // 全窗统一走纯白 + 透明度分层：muted-foreground 是带蓝调的
                        // 中灰(oklch .66)，压在 #070808 上发闷，用户要求改白。
                        "rounded-[6px] px-1.5 py-1 text-base leading-6 transition hover:bg-white/[0.055]",
                        !isMine ? "text-white" : "text-white/60 hover:text-white/85",
                      )}
                      onClick={() => onModeChange?.("community")}
                    >
                      Skill
                    </button>
                  </DialogTitle>
                  <button
                    type="button"
                    className={cn(
                      "rounded-[6px] px-1.5 py-1 text-sm leading-5 transition hover:bg-white/[0.055]",
                      isMine ? "text-white" : "text-white/60 hover:text-white/85",
                    )}
                    onClick={() => onModeChange?.("mine")}
                  >
                    我的
                  </button>
                </div>
              ) : (
                <>
                  <DialogTitle className="text-base leading-8">
                    {t("settings.freezoneCatalog.community.title")}
                  </DialogTitle>
                  <span className="text-sm text-white/62">
                    {t("settings.freezoneCatalog.community.featured")}
                  </span>
                </>
              )}
            </div>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                aria-label={t("settings.freezoneCatalog.refresh")}
                className="grid size-8 shrink-0 place-items-center rounded-[6px] text-white/60 transition-colors hover:bg-white/[0.055] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                onClick={onRetry}
                disabled={loading}
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              </button>
              <button
                type="button"
                aria-label={t("settings.freezoneCatalog.community.close")}
                className="grid size-8 shrink-0 place-items-center rounded-[6px] text-white/60 transition-colors hover:bg-white/[0.055] hover:text-white"
                onClick={() => onOpenChange(false)}
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2">
            {filterOptions.map((key) => {
              const active = key === activeFilter;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveFilter(key)}
                  className={cn(
                    // 圆角写死 px：本项目 --radius=1rem，rounded-md 实际 14px，
                    // 这排小筛选片会圆成胶囊（用户要求收小）。
                    "rounded-[6px] border px-3 py-1.5 text-xs transition-colors",
                    active
                      ? "border-border bg-white/[0.08] text-white"
                      : "border-border/60 bg-white/[0.02] text-white/62 hover:border-white/20 hover:bg-white/[0.055] hover:text-white/85",
                  )}
                >
                  {isMine && key !== "all"
                    ? key
                    : t(`settings.freezoneCatalog.community.filters.${key}`, { defaultValue: key })}
                </button>
              );
            })}
            <div className="relative ml-auto w-[min(340px,36vw)]">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-white/45" />
              <Input
                value={skillQuery}
                onChange={(event) => setSkillQuery(event.target.value)}
                placeholder={t("settings.freezoneCatalog.community.searchPlaceholder")}
                className="h-9 rounded-[8px] border-border/60 bg-white/[0.03] pl-9 pr-3 text-xs text-white/80 placeholder:text-white/45 focus-visible:border-white/25 focus-visible:ring-1 focus-visible:ring-white/10"
              />
            </div>
          </div>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="grid h-full min-h-80 place-items-center text-sm text-white/70">
              <div className="flex items-center gap-2">
                <RefreshCw className="size-3.5 animate-spin" />
                {t("settings.freezoneCatalog.community.loading")}
              </div>
            </div>
          ) : error ? (
            <div className="grid h-full min-h-80 place-items-center text-center">
              <div>
                <p className="text-sm font-medium text-white">
                  {t("settings.freezoneCatalog.community.loadFailed")}
                </p>
                <p className="mt-1 text-xs text-white/70">
                  {t("settings.freezoneCatalog.community.loadFailedHint")}
                </p>
                <Button type="button" variant="outline" size="sm" className="mt-4 h-8" onClick={onRetry}>
                  {t("settings.freezoneCatalog.retry")}
                </Button>
              </div>
            </div>
          ) : isMine ? (
            visibleLocalItems.length === 0 ? (
              <div className="grid h-full min-h-80 place-items-center text-center">
                <div>
                  <p className="text-sm font-medium text-white">
                    这里暂时没有 Skill
                  </p>
                  <p className="mx-auto mt-1 max-w-[360px] text-xs leading-relaxed text-white/70">
                    可以先让虾导总结当前画布，或描述工作流来创建自己的 Skill。
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {visibleLocalItems.map((item) => (
                  <article
                    key={item.id}
                    // hover 整条给反馈（用户要求）：只提亮底色和描边，不换指针——
                    // 可点的只有右侧「使用」，整条并不是按钮。
                    className="group/skill-card flex min-h-[104px] items-center gap-3 rounded-md border border-border/70 bg-white/[0.015] px-3 py-3 transition-colors hover:border-white/20 hover:bg-white/[0.05]"
                  >
                    <div className="grid size-14 shrink-0 place-items-center rounded-md border border-white/[0.08] bg-white/[0.04] text-xs text-white/55 transition-colors group-hover/skill-card:bg-white/[0.07] group-hover/skill-card:text-white/75">
                      Skill
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <h4 className="truncate text-[13px] font-semibold text-white">
                          {item.label || item.id}
                        </h4>
                        {item.category ? (
                          <span className="shrink-0 rounded border border-white/[0.08] bg-white/[0.025] px-1.5 py-0.5 text-[10px] leading-none text-white/62">
                            {item.category}
                          </span>
                        ) : null}
                      </div>
                      {item.description ? (
                        <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-white/72">
                          {item.description}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => onSelectLocalSkill?.(item.id)}
                    >
                      使用
                    </Button>
                  </article>
                ))}
              </div>
            )
          ) : visibleCommunityItems.length === 0 ? (
            <div className="grid h-full min-h-80 place-items-center text-center">
              <div>
                <p className="text-sm font-medium text-white">
                  {t("settings.freezoneCatalog.community.empty")}
                </p>
                <p className="mx-auto mt-1 max-w-[360px] text-xs leading-relaxed text-white/70">
                  {t("settings.freezoneCatalog.community.emptyDescription")}
                </p>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {visibleCommunityItems.map((item) => {
                const installed = installedSkillIds.has(item.id);
                const itemInstalling = installing && installingBundleUrl === item.bundle_url;
                return (
                  <article
                    key={item.id}
                    className="group/skill-card flex min-h-[128px] items-center gap-3 rounded-md border border-border/70 bg-white/[0.015] px-3 py-3 transition-colors hover:border-white/20 hover:bg-white/[0.05]"
                  >
                    {item.cover_url ? (
                      <img
                        src={item.cover_url}
                        alt=""
                        className="h-24 w-40 shrink-0 rounded-md object-cover"
                      />
                    ) : (
                      <div className="grid h-24 w-40 shrink-0 place-items-center rounded-md bg-white/[0.04] text-xs text-white/55 transition-colors group-hover/skill-card:bg-white/[0.07] group-hover/skill-card:text-white/75">
                        Skill
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <h4 className="truncate text-[13px] font-semibold text-white">
                          {item.name || item.id}
                        </h4>
                        <span className="shrink-0 rounded border border-white/[0.08] bg-white/[0.025] px-1.5 py-0.5 text-[10px] leading-none text-white/62">
                          v{item.version}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-white/72">
                        {item.description}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-white/58">
                        <span>{item.author}</span>
                        <span>·</span>
                        <span>{item.license}</span>
                        {item.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-white/[0.035] px-1.5 py-0.5"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant={installed ? "outline" : "default"}
                      className="shrink-0"
                      disabled={installed || installing}
                      onClick={() => onInstall(item)}
                    >
                      {installed
                        ? t("settings.freezoneCatalog.community.installedState")
                        : itemInstalling
                          ? t("settings.freezoneCatalog.community.installing")
                          : t("settings.freezoneCatalog.community.install")}
                    </Button>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function downloadJson(payload: unknown, filename: string) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function CatalogSelectionBar({
  allSelected,
  count,
  exportLabel,
  label,
  onBackToTop,
  onDeleteSelected,
  onExport,
  onToggleAll,
  selectedCount,
  showBackToTop,
}: {
  allSelected: boolean;
  count: number;
  exportLabel: string;
  label: string;
  onBackToTop: () => void;
  onDeleteSelected: () => void;
  onExport: () => void;
  onToggleAll: (checked: boolean) => void;
  selectedCount: number;
  showBackToTop: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        "sticky top-0 z-10 mt-3 flex h-9 items-center justify-between rounded-md border border-border/70 px-3 backdrop-blur transition-[background-color,box-shadow]",
        showBackToTop
          ? "bg-background/95 shadow-[0_8px_18px_rgba(0,0,0,0.18)]"
          : "bg-white/[0.018]",
      )}
    >
      <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={allSelected}
          disabled={count === 0}
          onCheckedChange={(checked) => onToggleAll(checked === true)}
        />
        <span>{label}</span>
        <span>
          {t("settings.freezoneCatalog.selectionCount", { count, selectedCount })}
        </span>
      </label>
      <div className="flex items-center gap-2">
        {showBackToTop ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
            onClick={onBackToTop}
          >
            <ArrowUp className="size-3.5" />
            {t("settings.freezoneCatalog.backToTop")}
          </Button>
        ) : null}
        {selectedCount > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
            onClick={onDeleteSelected}
          >
            <Trash2 className="size-3.5" />
            {t("settings.freezoneCatalog.deleteSelected")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={count === 0}
          className="h-7 px-2 text-xs"
          onClick={onExport}
        >
          <Upload className="size-3.5" />
          {exportLabel}
        </Button>
      </div>
    </div>
  );
}

function SkillDeleteDialog({
  candidate,
  deleting,
  onCancel,
  onConfirm,
}: {
  candidate: SkillDeleteCandidate | null;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: (deleteRecipes: boolean) => void;
}) {
  const { t } = useTranslation();
  const exclusiveRecipeCount = candidate?.exclusiveRecipes.length ?? 0;
  const sharedRecipeCount = candidate?.sharedRecipes.length ?? 0;
  const recipeCount = exclusiveRecipeCount + sharedRecipeCount;

  return (
    <Dialog
      open={candidate !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="max-w-[420px] gap-0 overflow-hidden rounded-lg border-border bg-black p-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">
            {t("settings.freezoneCatalog.deleteSkillDialog.title")}
          </DialogTitle>
        </DialogHeader>
        <div className="px-5 pb-4">
          <p className="text-sm leading-relaxed text-foreground">
            {t("settings.freezoneCatalog.deleteSkillDialog.description", {
              id: candidate?.item.id ?? "",
            })}
          </p>
          {recipeCount > 0 ? (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t("settings.freezoneCatalog.deleteSkillDialog.recipeHint", {
                count: recipeCount,
                exclusiveCount: exclusiveRecipeCount,
                sharedCount: sharedRecipeCount,
              })}
            </p>
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t("settings.freezoneCatalog.deleteSkillDialog.noRecipeHint")}
            </p>
          )}
          {recipeCount > 0 ? (
            <div className="mt-3 space-y-2">
              {exclusiveRecipeCount > 0 ? (
                <RecipeDeleteList
                  title={t("settings.freezoneCatalog.deleteSkillDialog.exclusiveRecipes")}
                  recipes={candidate?.exclusiveRecipes ?? []}
                />
              ) : null}
              {sharedRecipeCount > 0 ? (
                <RecipeDeleteList
                  title={t("settings.freezoneCatalog.deleteSkillDialog.sharedRecipes")}
                  recipes={candidate?.sharedRecipes ?? []}
                  muted
                />
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter className="px-5 pb-5">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={deleting}>
            {t("settings.freezoneCatalog.deleteSkillDialog.cancel")}
          </Button>
          {exclusiveRecipeCount > 0 ? (
            <Button
              type="button"
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => onConfirm(true)}
              disabled={deleting}
            >
              {t("settings.freezoneCatalog.deleteSkillDialog.deleteWithRecipes")}
            </Button>
          ) : null}
          <Button type="button" onClick={() => onConfirm(false)} disabled={deleting}>
            {t("settings.freezoneCatalog.deleteSkillDialog.deleteSkillOnly")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecipeDeleteList({
  muted = false,
  recipes,
  title,
}: {
  muted?: boolean;
  recipes: ManagedCatalogItem[];
  title: string;
}) {
  return (
    <div className="rounded-md bg-white/[0.025] px-2 py-1.5">
      <div className="mb-1 text-[11px] text-muted-foreground">{title}</div>
      <div className="max-h-24 overflow-y-auto">
        {recipes.map((recipe) => (
          <div
            key={recipe.id}
            className={cn(
              "truncate py-0.5 font-mono text-[11px]",
              muted ? "text-muted-foreground/70" : "text-muted-foreground",
            )}
          >
            {recipe.id}
          </div>
        ))}
      </div>
    </div>
  );
}

function CatalogList({
  error,
  items,
  kind,
  loading,
  onDelete,
  onEdit,
  onRetry,
  onToggleEnabled,
  onToggleSelected,
  selectedIds,
}: {
  error: boolean;
  items: ManagedCatalogItem[];
  kind: FreezoneCatalogKind;
  loading: boolean;
  onDelete: (item: ManagedCatalogItem) => void;
  onEdit: (item: ManagedCatalogItem) => void;
  onRetry: () => void;
  onToggleEnabled: (item: ManagedCatalogItem, enabled: boolean) => void;
  onToggleSelected: (id: string, checked: boolean) => void;
  selectedIds: Set<string>;
}) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="mt-2 rounded-md border border-border/70 px-4 py-12 text-center text-sm text-muted-foreground">
        {t("settings.freezoneCatalog.loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-2 rounded-md border border-border/70 px-4 py-12 text-center">
        <p className="text-sm font-medium text-foreground">
          {t("settings.freezoneCatalog.loadFailed")}
        </p>
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          {t("settings.freezoneCatalog.retry")}
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="mt-2 rounded-md border border-border/70 px-4 py-12 text-center">
        <p className="text-sm font-medium text-foreground">
          {t(
            kind === "skills"
              ? "settings.freezoneCatalog.emptySkills"
              : "settings.freezoneCatalog.emptyRecipes",
          )}
        </p>
        <p className="mx-auto mt-2 max-w-[420px] text-xs leading-relaxed text-muted-foreground">
          {t("settings.freezoneCatalog.emptyDescription")}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {items.map((item) => (
        <article
          key={item.id}
          className={cn(
            "flex items-center gap-3 rounded-md border border-border/70 bg-white/[0.015] px-3 py-2.5 transition-opacity",
            item.enabled ? "" : "opacity-55",
          )}
        >
          <Checkbox
            checked={selectedIds.has(item.id)}
            onCheckedChange={(checked) => onToggleSelected(item.id, checked === true)}
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h4 className="truncate text-[13px] font-semibold text-foreground">
                {item.title}
              </h4>
              {item.generationType ? (
                <span className={catalogGenerationTypeBadgeClass(item.generationType)}>
                  {t(`settings.freezoneCatalog.newRecipe.outputKinds.${item.generationType}`)}
                </span>
              ) : null}
              {item.builtin ? (
                <span className="shrink-0 rounded border border-white/[0.08] bg-white/[0.025] px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground/70">
                  {t("settings.freezoneCatalog.builtIn")}
                </span>
              ) : null}
              {item.customized ? (
                <span className="shrink-0 rounded border border-white/[0.08] bg-white/[0.025] px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground/70">
                  {t("settings.freezoneCatalog.customizedShort", { defaultValue: "定制" })}
                </span>
              ) : null}
            </div>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">{item.description}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              role="switch"
              aria-checked={item.enabled}
              aria-label={t("settings.freezoneCatalog.toggleEnabled", { id: item.title })}
              onClick={() => onToggleEnabled(item, !item.enabled)}
              className={cn(
                "relative h-4 w-7 rounded-full border transition-colors",
                item.enabled
                  ? "border-transparent bg-[#111] dark:bg-white/[0.18]"
                  : "border-transparent bg-black/[0.06] dark:bg-white/[0.08]",
              )}
            >
              <span
                className={cn(
                  "absolute top-1/2 left-0.5 size-3 -translate-y-1/2 rounded-full bg-white transition-transform",
                  item.enabled ? "translate-x-3" : "translate-x-0",
                )}
              />
            </button>
            <button
              type="button"
              aria-label={t("settings.freezoneCatalog.editItem", { id: item.title })}
              onClick={() => onEdit(item)}
              className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground"
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={t("settings.freezoneCatalog.deleteItem", { id: item.title })}
              onClick={() => onDelete(item)}
              className="grid size-7 place-items-center rounded-md text-destructive transition-colors hover:bg-destructive/10"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function toManagedCatalogItem(
  item: FreezoneAgentConfigPayload,
  kind: FreezoneCatalogKind,
): ManagedCatalogItem {
  const id = typeof item.id === "string" ? item.id : "";
  if (kind === "recipes") {
    const generationType = isRecipeGenerationType(item.output_kind) ? item.output_kind : undefined;
    return {
      builtin: item._catalog_source === "builtin",
      customized: item._catalog_source === "user" && item._catalog_base_source === "builtin",
      enabled: item.enabled !== false,
      generationType,
      id,
      payload: item,
      title: typeof item.name === "string" ? item.name : id,
      description:
        getString(item.result_summary) ||
        getString(item.planning_prompt) ||
        getString(item.system_prompt),
      tags: [getString(item.output_kind), ...getStringArray(item.action_keys)].filter(Boolean),
    };
  }
  const triggers = typeof item.triggers === "object" && item.triggers ? item.triggers : {};
  return {
    builtin: item._catalog_source === "builtin",
    customized: item._catalog_source === "user" && item._catalog_base_source === "builtin",
    enabled: item.enabled !== false,
    id,
    payload: item,
    title: getString(item.name) || id,
    description: getString(item.description),
    tags: [
      getString(item.category),
      ...getStringArray((triggers as Record<string, unknown>).keywords),
    ].filter(Boolean),
  };
}

function getSkillAllowedRecipeIds(payload: FreezoneAgentConfigPayload): string[] {
  return getStringArray(payload.allowed_recipe_ids ?? payload.allowedRecipeIds);
}

function getRecipeUsageCounts(skillItems: ManagedCatalogItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const skill of skillItems) {
    for (const recipeId of getSkillAllowedRecipeIds(skill.payload)) {
      counts.set(recipeId, (counts.get(recipeId) ?? 0) + 1);
    }
  }
  return counts;
}

function catalogGenerationTypeBadgeClass(type: RecipeGenerationType) {
  return cn(
    "shrink-0 rounded border px-1.5 py-0.5 text-[10px] leading-none",
    type === "text" && "border-sky-400/35 bg-sky-400/10 text-sky-100/90",
    type === "image" && "border-emerald-400/35 bg-emerald-400/10 text-emerald-100/90",
    type === "video" && "border-violet-400/35 bg-violet-400/10 text-violet-100/90",
    type === "audio" && "border-amber-400/35 bg-amber-400/10 text-amber-100/90",
  );
}

function stripCatalogMetadata(payload: FreezoneAgentConfigPayload): FreezoneAgentConfigPayload {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => !key.startsWith("_catalog_")),
  ) as FreezoneAgentConfigPayload;
}

function getString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function getStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string") return splitDraftList(value);
  return [];
}
