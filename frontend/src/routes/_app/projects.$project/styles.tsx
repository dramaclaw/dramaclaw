// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  CheckCircle2,
  Code,
  Image as ImageIcon,
  Info,
  Loader2,
  Pencil,
  Paintbrush,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";

import {
  useAnalyzeStyle,
  useCreateStyle,
  useDeleteStyle,
  useStyleDetail,
  useStyles,
} from "@/lib/queries/styles";
import { useProject, useUpdateProject } from "@/lib/queries/projects";
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SidebarListSkeleton, DetailPaneSkeleton } from "@/components/skeletons";
import type { Style } from "@/types/style";
import { stylePreviewUrl } from "@/lib/style-preview-url";
import { CreditCostInline } from "@/components/credit-cost-inline";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";

// ─── style constants (aligned with characters page) ─────────────────────────

const STYLES_INPUT_CLASS =
  "h-9 rounded-[8px] border-white/10 bg-white/[0.025] px-3 text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:border-white/20 focus-visible:ring-2 focus-visible:ring-white/8 dark:bg-white/[0.025]";
const STYLES_TEXTAREA_CLASS =
  "w-full resize-none rounded-[8px] border border-white/10 bg-white/[0.025] p-2.5 text-sm leading-relaxed shadow-none placeholder:text-muted-foreground/60 focus-visible:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/8";

// ─── helpers ────────────────────────────────────────────────────────────────

interface StyleConfig {
  label: string;
  style_instructions: string;
  avoid_instructions: string;
  style_tag: string;
}

const EMPTY_CONFIG: StyleConfig = {
  label: "",
  style_instructions: "",
  avoid_instructions: "",
  style_tag: "",
};

const CONFIG_KEYS: (keyof StyleConfig)[] = [
  "label",
  "style_instructions",
  "avoid_instructions",
  "style_tag",
];

const IGNORED_SAVE_KEYS = new Set([
  ...CONFIG_KEYS,
  "id",
  "name",
  "type",
  "is_preset",
]);

/** Read editable fields from a Style. Single GET returns top-level fields;
 * analyze/create flows may pass the same fields inside `config`. */
function extractConfig(style: Style | undefined | null): StyleConfig {
  if (!style) return { ...EMPTY_CONFIG };
  const nested = (style.config ?? {}) as Record<string, unknown>;
  const get = (k: keyof StyleConfig): string => {
    const top = (style as unknown as Record<string, unknown>)[k];
    if (typeof top === "string") return top;
    if (typeof nested[k] === "string") return nested[k] as string;
    return "";
  };
  return {
    label: get("label"),
    style_instructions: get("style_instructions"),
    avoid_instructions: get("avoid_instructions"),
    style_tag: get("style_tag"),
  };
}

/** Build a POST /styles payload preserving any extra unknown fields the
 * server returned (so we don't drop `base`, `created_by`, etc on save). */
function buildSavePayload(
  fields: StyleConfig,
  original: Style | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CONFIG_KEYS) {
    if (fields[k]) out[k] = fields[k];
  }
  if (original) {
    for (const [k, v] of Object.entries(
      original.config ?? (original as unknown as Record<string, unknown>),
    )) {
      if (!IGNORED_SAVE_KEYS.has(k) && !(k in out)) out[k] = v;
    }
  }
  return out;
}

function isPreset(style: Style | null | undefined): boolean {
  if (!style) return false;
  return style.type === "preset" || style.is_preset === true;
}

// ─── small components ───────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3.5">
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

function Section({
  title,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  icon,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  const toggleOpen = () => {
    const next = !open;
    if (onOpenChange) {
      onOpenChange(next);
    } else {
      setUncontrolledOpen(next);
    }
  };

  return (
    <div className="rounded-[10px] border border-white/[0.085] bg-white/[0.055]">
      <button
        type="button"
        onClick={toggleOpen}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs font-medium text-foreground/80 hover:bg-white/[0.045]"
      >
        <ChevronDown
          className={cn(
            "size-3.5 text-muted-foreground/85 transition-transform",
            !open && "-rotate-90",
          )}
        />
        {icon}
        <span className="flex-1">{title}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-white/[0.075] bg-background/45 p-4">
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Top bar ────────────────────────────────────────────────────────────────

function TopBar({ onCreate, onRefresh, refreshing }: { onCreate: () => void; onRefresh: () => Promise<void>; refreshing: boolean }) {
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 flex-col gap-3 border-b border-border/30 bg-background px-9 py-5 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Paintbrush className="size-[18px]" />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
            {t("nav.styles")}
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            {t("styles.selectStyleHint")}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
          className="h-8 gap-1.5 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none transition-transform hover:bg-white/[0.04] active:scale-95 dark:bg-transparent"
        >
          {refreshing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {t("common.refresh")}
        </Button>
        <Button
          size="sm"
          onClick={onCreate}
          className="h-8 gap-1.5 rounded-[8px] bg-primary px-3 text-xs font-normal text-primary-foreground shadow-none hover:bg-primary/85 active:bg-primary/75"
        >
          <Plus className="size-3.5" />
          {t("styles.createStyle")}
        </Button>
      </div>
    </div>
  );
}

// ─── Style list item ────────────────────────────────────────────────────────

function StyleListItem({
  style,
  selected,
  isProjectDefault,
  onSelect,
}: {
  style: Style;
  selected: boolean;
  isProjectDefault: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const preset = isPreset(style);
  const display = style.label || style.name;
  const previewSrc = preset ? stylePreviewUrl(style.id) : null;
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
      {previewSrc ? (
        <img
          src={previewSrc}
          alt={display}
          loading="lazy"
          className="size-9 shrink-0 rounded-[6px] border border-white/10 object-cover"
        />
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[6px] border border-white/10 bg-white/[0.025]">
          <Paintbrush className="size-4 text-muted-foreground/50" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-foreground">
            {display}
          </span>
          {isProjectDefault && (
            <CheckCircle2
              className="size-3.5 shrink-0 text-primary/70"
              aria-label={t("styles.projectDefault")}
            />
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {style.id} · {preset ? t("styles.preset") : t("styles.custom")}
        </p>
      </div>
    </button>
  );
}

// ─── Preview box ────────────────────────────────────────────────────────────

function PreviewBox({ style }: { style: Style }) {
  const { t } = useTranslation();
  const [hasError, setHasError] = useState(false);
  const preset = isPreset(style);

  // Reset error state when style switches.
  useEffect(() => {
    setHasError(false);
  }, [style.id]);

  if (!preset) {
    return (
      <div className="flex aspect-video items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-background/40 px-4 text-center">
        <Info className="size-4 shrink-0 text-muted-foreground/60" />
        <p className="text-xs leading-snug text-muted-foreground/80">
          {t("styles.customPreviewUnavailable")}
          <br />
          <span className="text-muted-foreground/50">
            {t("styles.customPreviewHint")}
          </span>
        </p>
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="flex aspect-video items-center justify-center rounded-lg border border-border bg-background/40">
        <ImageIcon className="size-8 text-muted-foreground/30" />
      </div>
    );
  }

  return (
    <img
      src={stylePreviewUrl(style.id)}
      alt={`${style.name} preview`}
      loading="lazy"
      decoding="async"
      className="aspect-video w-full rounded-lg border border-border object-cover"
      onError={() => setHasError(true)}
    />
  );
}

// ─── Detail panel ───────────────────────────────────────────────────────────

function StyleDetailPanel({
  style,
  project,
  isProjectDefault,
  onClearSelection,
}: {
  style: Style;
  project: string;
  isProjectDefault: boolean;
  onClearSelection: () => void;
}) {
  const { t } = useTranslation();
  const createStyle = useCreateStyle();
  const deleteStyle = useDeleteStyle();
  const updateProject = useUpdateProject(project);

  const preset = isPreset(style);
  const original = useMemo(() => extractConfig(style), [style]);
  const [fields, setFields] = useState<StyleConfig>(original);
  const [editingName, setEditingName] = useState(style.name);
  const [nameEditOpen, setNameEditOpen] = useState(false);
  const [nameEditValue, setNameEditValue] = useState(style.name);
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Reset on style change.
  useEffect(() => {
    setFields(original);
    setEditingName(style.name);
    setNameEditOpen(false);
    setNameEditValue(style.name);
    setShowJson(false);
    setJsonError(null);
    setJsonText(JSON.stringify(buildSavePayload(original, style), null, 2));
  }, [style, original]);

  const dirty = useMemo(() => {
    if (editingName !== style.name) return true;
    if (showJson) {
      return jsonText !== JSON.stringify(buildSavePayload(original, style), null, 2);
    }
    return CONFIG_KEYS.some((k) => fields[k] !== original[k]);
  }, [editingName, style.name, showJson, jsonText, original, style, fields]);

  const updateField = (k: keyof StyleConfig, v: string) =>
    setFields((prev) => ({ ...prev, [k]: v }));

  const handleSave = async () => {
    let configPayload: Record<string, unknown>;
    if (showJson) {
      try {
        configPayload = JSON.parse(jsonText) as Record<string, unknown>;
      } catch {
        setJsonError(t("styles.jsonFormatError"));
        return;
      }
      setJsonError(null);
    } else {
      configPayload = buildSavePayload(fields, style);
    }

    try {
      await createStyle.mutateAsync({
        id: style.id,
        name: editingName.trim() || style.name,
        project,
        config: configPayload,
      });
      toast.success(t("styles.styleSaved"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleApplyToProject = async () => {
    try {
      await updateProject.mutateAsync({ visual_style: style.id });
      toast.success(t("styles.setAsDefault", { name: style.label || style.name }));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleDelete = async () => {
    if (!confirm(t("styles.confirmDelete", { name: style.label || style.name }))) return;
    try {
      await deleteStyle.mutateAsync({ styleId: style.id, project });
      toast.success(t("styles.deleted"));
      onClearSelection();
    } catch {
      toast.error(t("common.error"));
    }
  };

  const setJsonEditorOpen = (nextOpen: boolean) => {
    if (nextOpen === showJson) return;

    if (nextOpen) {
      setJsonText(JSON.stringify(buildSavePayload(fields, style), null, 2));
      setJsonError(null);
    } else {
      try {
        const changed = jsonText !== JSON.stringify(buildSavePayload(fields, style), null, 2);
        const parsed = JSON.parse(jsonText) as Record<string, unknown>;
        const next = { ...EMPTY_CONFIG } as StyleConfig;
        for (const k of CONFIG_KEYS) {
          const val = parsed[k];
          if (typeof val === "string") next[k] = val;
        }
        setFields(next);
        if (changed) {
          toast.success(t("styles.jsonChangesApplied"));
        }
      } catch {
        // keep current structured fields if JSON invalid
      }
    }
    setShowJson(nextOpen);
  };

  const handleRename = async () => {
    const trimmed = nameEditValue.trim();
    if (!trimmed) return;
    try {
      await createStyle.mutateAsync({
        id: style.id,
        name: trimmed,
        project,
        config: buildSavePayload(fields, style),
      });
      setEditingName(trimmed);
      toast.success(t("styles.styleSaved"));
    } catch {
      toast.error(t("common.error"));
    }
    setNameEditOpen(false);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-1.5 px-4 pt-4 pb-2">
        <span className="min-w-0 truncate text-sm font-semibold text-foreground">
          {editingName}
        </span>
        <button
          type="button"
          onClick={() => {
            setNameEditValue(editingName);
            setNameEditOpen(true);
          }}
          className="shrink-0 inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-white/[0.04]"
          aria-label="Rename style"
        >
          <Pencil className="size-3" />
        </button>
        {isProjectDefault && (
          <span className="shrink-0 inline-flex items-center rounded-md border border-white/8 bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/80">
            项目默认
          </span>
        )}
        {dirty && (
          <span className="shrink-0 inline-flex items-center rounded-md border border-amber-500/20 bg-amber-500/5 px-1.5 py-0.5 text-[10px] font-medium text-amber-500/80">
            未保存
          </span>
        )}
      </div>

      {/* Rename dialog */}
      <Dialog open={nameEditOpen} onOpenChange={setNameEditOpen}>
        <DialogContent className="rounded-xl border border-white/8 bg-background/68 p-6 shadow-none backdrop-blur-3xl sm:max-w-sm">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-sm font-medium tracking-tight">
              {t("styles.renameTitle", "重命名风格")}
            </DialogTitle>
          </DialogHeader>
          <Input
            value={nameEditValue}
            onChange={(e) => setNameEditValue(e.target.value)}
            placeholder={style.name}
            className="h-9 rounded-[8px] border-white/10 bg-white/[0.025] px-3 text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:border-white/20 focus-visible:ring-2 focus-visible:ring-white/8"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename();
              if (e.key === "Escape") setNameEditOpen(false);
            }}
          />
          <DialogFooter className="mt-1 flex justify-end gap-2 border-0 bg-transparent p-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNameEditOpen(false)}
              className="h-8 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none hover:bg-white/[0.04]"
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={handleRename}
              disabled={createStyle.isPending || !nameEditValue.trim()}
              className="h-8 rounded-[8px] bg-primary px-3 text-xs font-normal text-primary-foreground shadow-none hover:bg-primary/90"
            >
              {createStyle.isPending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : null}
              {t("common.save", "保存")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Scrolling content */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {/* Preview */}
        <div className="mb-6 w-full max-w-[240px]">
          <PreviewBox style={style} />
        </div>

        {/* Editor */}
        <div className="space-y-3">
          <Field label={t("styles.labelField")}>
            <Input
              value={fields.label}
              onChange={(e) => updateField("label", e.target.value)}
              placeholder={t("styles.labelPlaceholder")}
              className={STYLES_INPUT_CLASS}
            />
          </Field>

          <Section title={t("styles.projectStyleSection")} defaultOpen={false}>
            <Field label={t("styles.styleDirective")}>
              <Textarea
                value={fields.style_instructions}
                onChange={(e) =>
                  updateField("style_instructions", e.target.value)
                }
                rows={4}
                className={STYLES_TEXTAREA_CLASS}
              />
            </Field>
            <Field label={t("styles.avoidDirective")}>
              <Textarea
                value={fields.avoid_instructions}
                onChange={(e) =>
                  updateField("avoid_instructions", e.target.value)
                }
                rows={3}
                className={STYLES_TEXTAREA_CLASS}
              />
            </Field>
            <Field
              label={t("styles.styleTag")}
              hint={t("styles.styleTagHint")}
            >
              <Input
                value={fields.style_tag}
                onChange={(e) =>
                  updateField("style_tag", e.target.value)
                }
                placeholder={t("styles.styleTagPlaceholder")}
                className={STYLES_INPUT_CLASS}
              />
            </Field>
          </Section>

          <Section
            title={t("styles.jsonEdit")}
            defaultOpen={false}
            open={showJson}
            onOpenChange={setJsonEditorOpen}
            icon={<Code className="size-3.5" />}
          >
            <textarea
              className={cn(STYLES_TEXTAREA_CLASS, "min-h-[300px] font-mono")}
              value={jsonText}
              onChange={(e) => {
                setJsonText(e.target.value);
                setJsonError(null);
              }}
              spellCheck={false}
            />
            {jsonError && (
              <p className="text-xs text-destructive">{jsonError}</p>
            )}
          </Section>
        </div>
      </div>

      {/* Actions bar */}
      <div className="flex items-center gap-2 border-t border-border/30 bg-background px-4 py-2">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={createStyle.isPending || !dirty}
          className="h-7 gap-1.5 rounded-[8px] bg-primary px-3 text-xs font-normal text-primary-foreground shadow-none hover:bg-primary/85 active:bg-primary/75"
        >
          {createStyle.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Save className="size-3" />
          )}
          {t("styles.save")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleApplyToProject}
          disabled={updateProject.isPending || isProjectDefault}
          className="h-7 gap-1.5 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none hover:bg-white/[0.04] dark:bg-transparent"
        >
          {updateProject.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Check className="size-3" />
          )}
          {isProjectDefault ? t("styles.alreadyDefault") : t("styles.applyToProject")}
        </Button>
        {!preset && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            disabled={deleteStyle.isPending}
            className="ml-auto gap-1.5 h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            {deleteStyle.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Trash2 className="size-3" />
            )}
            {t("styles.delete")}
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Empty detail ───────────────────────────────────────────────────────────

function EmptyDetail({
  hasStyles,
  onCreate,
}: {
  hasStyles: boolean;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <div className="flex size-16 items-center justify-center rounded-full border border-border bg-card">
          <Paintbrush className="size-6 text-muted-foreground" />
        </div>
        {hasStyles ? (
          <>
            <h2 className="text-sm font-semibold text-foreground">{t("styles.selectStyle")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("styles.selectStyleHint")}
            </p>
          </>
        ) : (
          <>
            <h2 className="text-sm font-semibold text-foreground">{t("styles.noStyles")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("styles.noStylesHint")}
            </p>
            <Button onClick={onCreate} className="mt-2 gap-1.5 h-8 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none hover:bg-white/[0.04]">
              <Plus className="size-3.5" />
              {t("styles.createStyle")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Create dialog ──────────────────────────────────────────────────────────

function CreateStyleDialog({
  open,
  onOpenChange,
  project,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  project: string;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const createStyle = useCreateStyle();
  const analyzeStyle = useAnalyzeStyle(project);
  const styleAnalyzeCost = useGenerationCreditCost("style_analyzer");

  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [analyzed, setAnalyzed] = useState<StyleConfig | null>(null);

  // Reset on open.
  useEffect(() => {
    if (open) {
      setId("");
      setName("");
      setAnalyzed(null);
    }
  }, [open]);

  const handleAnalyze = async (file: File) => {
    try {
      const res = await analyzeStyle.mutateAsync(file);
      const cfg = extractConfig({ id: "", name: "", config: res.data } as Style);
      setAnalyzed(cfg);
      toast.success(t("styles.paramsExtracted"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleCreate = async () => {
    const trimmedId = id.trim();
    const trimmedName = name.trim();
    if (!trimmedId || !trimmedName) {
      toast.error(t("styles.idNameRequired"));
      return;
    }
    try {
      await createStyle.mutateAsync({
        id: trimmedId,
        name: trimmedName,
        project,
        config: analyzed
          ? buildSavePayload(analyzed, null)
          : {},
      });
      toast.success(t("styles.styleCreated"));
      onCreated(trimmedId);
      onOpenChange(false);
    } catch {
      toast.error(t("common.error"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 overflow-hidden rounded-2xl border border-white/8 bg-background/68 p-7 shadow-none backdrop-blur-3xl sm:max-w-lg">
        <DialogHeader className="gap-2">
          <DialogTitle className="flex items-center gap-2 text-lg font-medium tracking-tight">
            <span aria-hidden="true">✨</span>
            <span>{t("styles.createTitle")}</span>
          </DialogTitle>
          <p className="text-xs leading-5 text-muted-foreground">
            {t("styles.createHint")}
          </p>
        </DialogHeader>
        <div className="mt-2 flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2.5">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("styles.styleId")}
              </Label>
              <Input
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="cyberpunk_v1"
                className="h-9 rounded-[8px] border-white/10 bg-white/[0.025] px-3 text-sm font-mono placeholder:text-muted-foreground/60 focus-visible:border-white/20 focus-visible:ring-2 focus-visible:ring-white/8 dark:bg-white/[0.025]"
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-2.5">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("styles.nameField")}
              </Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("styles.namePlaceholder")}
                className="h-9 rounded-[8px] border-white/10 bg-white/[0.025] px-3 text-sm placeholder:text-muted-foreground/60 focus-visible:border-white/20 focus-visible:ring-2 focus-visible:ring-white/8 dark:bg-white/[0.025]"
              />
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            <Label className="text-xs font-medium text-muted-foreground">
              {t("styles.aiAnalyze")}
            </Label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={analyzeStyle.isPending}
              className="h-9 w-fit rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none hover:bg-white/[0.04] gap-1.5 dark:bg-transparent"
            >
              {analyzeStyle.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              {analyzed ? t("styles.reupload") : t("styles.uploadRef")}
              <CreditCostInline display={styleAnalyzeCost.data?.data.display} />
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleAnalyze(file);
              }}
            />
          </div>

          {analyzed && (
            <div className="space-y-2 rounded-lg border border-white/10 bg-white/[0.04] p-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Sparkles className="size-3 text-primary" />
                {t("styles.aiExtractedHint")}
              </div>
              {analyzed.style_instructions && (
                <Field label={t("styles.styleDirective")}>
                  <p className="line-clamp-3 text-sm leading-relaxed text-foreground/80">
                    {analyzed.style_instructions}
                  </p>
                </Field>
              )}
              {analyzed.avoid_instructions && (
                <Field label={t("styles.avoidDirective")}>
                  <p className="line-clamp-2 text-sm leading-relaxed text-foreground/80">
                    {analyzed.avoid_instructions}
                  </p>
                </Field>
              )}
            </div>
          )}
        </div>
        <DialogFooter className="-mx-7 -mb-7 border-t-0 bg-transparent p-7 pt-3 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="h-10 rounded-md border-white/18 bg-white/[0.06] px-4 text-sm font-normal text-foreground/80 hover:border-white/28 hover:bg-white/[0.1] hover:text-foreground"
          >
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={createStyle.isPending || !id.trim() || !name.trim()}
            className="h-10 rounded-md bg-primary px-4 text-sm font-normal text-primary-foreground shadow-lg shadow-primary/15 hover:bg-primary/90"
          >
            {createStyle.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Plus className="size-4" />
            )}
            {t("styles.createStyle")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────

function StylesPage() {
  const { t } = useTranslation();
  const { project } = Route.useParams();

  const { data: stylesRes, isLoading, isRefetching, refetch } = useStyles(project);
  const { data: projectRes } = useProject(project);

  const styles = stylesRes?.data ?? [];
  const projectVisualStyle = projectRes?.data?.visual_style;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Auto-select first style when none selected (or selection vanished).
  useEffect(() => {
    if (styles.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !styles.find((s) => s.id === selectedId)) {
      setSelectedId(styles[0].id);
    }
  }, [styles, selectedId]);

  // Fetch full detail for the selected style (the list endpoint only ships metadata).
  const { data: detailRes, isFetching: detailFetching } = useStyleDetail(
    project,
    selectedId,
  );
  // Fall back to list metadata while detail loads.
  const fallbackListRecord = styles.find((s) => s.id === selectedId) ?? null;
  const selectedStyle: Style | null =
    detailRes?.data ?? fallbackListRecord;
  const isProjectDefault = !!selectedStyle && projectVisualStyle === selectedStyle.id;

  return (
    <div className="-m-6 flex h-[calc(100%+3rem)] flex-col overflow-hidden">
      <TopBar onCreate={() => setCreateOpen(true)} onRefresh={async () => { await refetch(); toast.success(t("common.refreshed")); }} refreshing={isRefetching} />

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* LEFT: list */}
        <div className="flex max-h-[45vh] w-full shrink-0 flex-col overflow-hidden border-b border-border/30 lg:max-h-none lg:w-[360px] lg:border-b-0 lg:border-r lg:border-border/30">
          <div className="flex-1 overflow-y-auto p-3">
            {isLoading ? (
              <SidebarListSkeleton label={t("common.loading")} />
            ) : styles.length === 0 ? (
              <div className="mt-8 flex flex-col items-center text-center">
                <div className="mb-3 flex size-12 items-center justify-center rounded-full border border-border bg-card">
                  <Paintbrush className="size-5 text-muted-foreground" />
                </div>
                <p className="max-w-xs text-sm text-muted-foreground">
                  {t("styles.noStylesAvailable")}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {styles.map((style) => (
                  <StyleListItem
                    key={style.id}
                    style={style}
                    selected={style.id === selectedId}
                    isProjectDefault={style.id === projectVisualStyle}
                    onSelect={() => setSelectedId(style.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: detail */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {selectedStyle ? (
            <StyleDetailPanel
              key={selectedStyle.id}
              style={selectedStyle}
              project={project}
              isProjectDefault={isProjectDefault}
              onClearSelection={() => setSelectedId(null)}
            />
          ) : detailFetching ? (
            <DetailPaneSkeleton label={t("common.loading")} />
          ) : (
            <EmptyDetail
              hasStyles={styles.length > 0}
              onCreate={() => setCreateOpen(true)}
            />
          )}
        </div>
      </div>

      <CreateStyleDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        project={project}
        onCreated={(id) => setSelectedId(id)}
      />
    </div>
  );
}

export const Route = createFileRoute("/_app/projects/$project/styles")({
  component: StylesPage,
});
