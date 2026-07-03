// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  FishSymbol,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Square,
  X,
} from "lucide-react";

import { useProject, useUpdateProject } from "@/lib/queries/projects";
import {
  useChapters,
  useStartIngest,
  useUploadNovel,
  type FormatCheck,
} from "@/lib/queries/ingest";
import { FormatCheckDetailsDialog } from "@/components/ingest/FormatCheckDetailsDialog";
import { useStyles } from "@/lib/queries/styles";
import { useCharacters } from "@/lib/queries/characters";
import { useCancelTask } from "@/lib/queries/tasks";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { useTaskStream } from "@/hooks/use-task-stream";
import { queryKeys } from "@/lib/query-keys";
import {
  backendErrorToastMessage,
  BillingRuleNotConfiguredError,
} from "@/lib/api-errors";
import { CreditCostInline } from "@/components/credit-cost-inline";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import type { ProjectConfig, SpineTemplate } from "@/types/project";

// ─── form schema ─────────────────────────────────────────────────────────────

// Ingest page only edits ingest-time settings. TTS / video settings live on
// their owning pages (styles, video) since they are post-ingest concerns.
const settingsSchema = z.object({
  spine_template: z.enum(["drama", "narrated"]).optional(),
  visual_style: z.string().optional(),
  narration_style: z.string().optional(),
  ethnicity: z.string().optional(),
});

// Option sources — value is persisted to the API; label is what the user sees.
const SPINE_TEMPLATE_OPTIONS: { value: "drama" | "narrated"; labelKey: string }[] = [
  { value: "drama", labelKey: "ingest.projectTypes.drama" },
  { value: "narrated", labelKey: "ingest.projectTypes.narrated" },
];

const VISUAL_STYLE_OPTIONS: { value: string; labelKey: string }[] = [
  {
    value: "chinese_period_drama",
    labelKey: "ingest.visualStyles.chinesePeriodDrama",
  },
  { value: "anime", labelKey: "ingest.visualStyles.anime" },
  {
    value: "guoman_fantasy",
    labelKey: "ingest.visualStyles.guomanFantasy",
  },
  {
    value: "post_apocalyptic",
    labelKey: "ingest.visualStyles.postApocalyptic",
  },
  { value: "realistic", labelKey: "ingest.visualStyles.realistic" },
  {
    value: "republican_era_drama",
    labelKey: "ingest.visualStyles.republicanEraDrama",
  },
];

const ETHNICITY_OPTIONS: { value: string; labelKey: string }[] = [
  { value: "Chinese", labelKey: "ingest.ethnicities.chinese" },
  { value: "Japanese", labelKey: "ingest.ethnicities.japanese" },
  { value: "Korean", labelKey: "ingest.ethnicities.korean" },
  { value: "Western", labelKey: "ingest.ethnicities.western" },
  { value: "Mixed", labelKey: "ingest.ethnicities.mixed" },
];

// Narration uses i18n — keys resolved at render time.
const NARRATION_STYLE_OPTIONS: { value: string; labelKey: string }[] = [
  { value: "first_person", labelKey: "ingest.firstPerson" },
  { value: "third_person", labelKey: "ingest.thirdPerson" },
];

type SettingsForm = z.infer<typeof settingsSchema>;

const INGEST_SETTING_FIELDS = [
  "spine_template",
  "visual_style",
  "narration_style",
  "ethnicity",
] as const;
type IngestSettingsValues = {
  spine_template: SpineTemplate;
  visual_style: string;
  narration_style: string;
  ethnicity: string;
};

const DEFAULT_SPINE_TEMPLATE: SpineTemplate = SPINE_TEMPLATE_OPTIONS[0].value;
const DEFAULT_VISUAL_STYLE = VISUAL_STYLE_OPTIONS[0].value;
const DEFAULT_NARRATION_STYLE = NARRATION_STYLE_OPTIONS[0].value;
const DEFAULT_ETHNICITY = ETHNICITY_OPTIONS[0].value;
const LEGACY_DEFAULT_VISUAL_STYLE = "post_apocalyptic";
const LEGACY_DEFAULT_NARRATION_STYLE = "third_person";
const LEGACY_DEFAULT_ETHNICITY = "Japanese";

function normalizeLegacyDefaults(
  config: ProjectConfig | undefined,
): IngestSettingsValues {
  const isLegacyDefault =
    config?.visual_style === LEGACY_DEFAULT_VISUAL_STYLE &&
    config?.narration_style === LEGACY_DEFAULT_NARRATION_STYLE &&
    config?.ethnicity === LEGACY_DEFAULT_ETHNICITY;

  return {
    spine_template: config?.spine_template ?? DEFAULT_SPINE_TEMPLATE,
    visual_style: isLegacyDefault
      ? DEFAULT_VISUAL_STYLE
      : (config?.visual_style ?? DEFAULT_VISUAL_STYLE),
    narration_style: isLegacyDefault
      ? DEFAULT_NARRATION_STYLE
      : (config?.narration_style ?? DEFAULT_NARRATION_STYLE),
    ethnicity: isLegacyDefault
      ? DEFAULT_ETHNICITY
      : (config?.ethnicity ?? DEFAULT_ETHNICITY),
  };
}

function resolveIngestSettings(
  values: Partial<SettingsForm>,
  defaults: IngestSettingsValues,
): IngestSettingsValues {
  return {
    spine_template: values.spine_template ?? defaults.spine_template,
    visual_style: values.visual_style ?? defaults.visual_style,
    narration_style: values.narration_style ?? defaults.narration_style,
    ethnicity: values.ethnicity ?? defaults.ethnicity,
  };
}

function toProjectSettingsPayload(
  settings: IngestSettingsValues,
): Partial<ProjectConfig> {
  return { ...settings };
}

function hasIngestSettingsChanges(
  settings: IngestSettingsValues,
  config: ProjectConfig | undefined,
): boolean {
  return INGEST_SETTING_FIELDS.some((field) => {
    // 精品剧不消费 narration_style（隐藏入口 + 保存时剥离），其差异不应点亮
    // 「保存设置」按钮，否则会出现按钮可点但点了无事发生的割裂。
    if (field === "narration_style" && settings.spine_template !== "narrated") {
      return false;
    }
    return (config?.[field] ?? "") !== settings[field];
  });
}

type InputMode = "upload" | "paste";
type UploadedFileSource = "upload" | "paste";
type IngestFileStatus =
  | "uploaded"
  | "importing"
  | "completed"
  | "stopped"
  | "failed";

const PASTE_TEXT_MAX_LENGTH = 1000;
const HIDDEN_IMPORTED_PREVIEW_KEY_PREFIX =
  "supertale-ingest-hidden-imported-preview:";
const COMPACT_SELECT_TRIGGER_CLASS =
  "h-8 w-full rounded-[8px] border-white/10 bg-transparent px-2.5 text-xs dark:bg-transparent md:w-auto md:min-w-max";
const COMPACT_SELECT_CONTENT_CLASS =
  "min-w-max rounded-md p-1 shadow-xl shadow-black/20 data-[align-trigger=true]:animate-in [&_[data-slot=select-item]]:min-h-8 [&_[data-slot=select-item]]:rounded-sm [&_[data-slot=select-item]]:px-2 [&_[data-slot=select-item]]:py-1.5 [&_[data-slot=select-item]]:text-xs [&_[data-slot=select-item]:focus]:bg-white/8 [&_[data-slot=select-item]:focus]:text-current [&_[data-slot=select-item]_svg]:size-3.5";
const INGEST_SURFACE_CLASS = "border-white/[0.08] bg-white/[0.04] shadow-none";
const INGEST_SURFACE_SUBTLE_CLASS = "border-white/[0.06] bg-white/[0.03] shadow-none";
const INGEST_DIVIDER_CLASS = "border-white/[0.06]";

// ─── helpers ─────────────────────────────────────────────────────────────────

function resolveOptionLabel(
  options: { value: string; labelKey?: string; label?: string }[],
  value: string,
  t: (key: string) => string,
): string | undefined {
  const option = options.find((o) => o.value === value);
  if (!option) return undefined;
  return option.label ?? (option.labelKey ? t(option.labelKey) : undefined);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hiddenImportedPreviewKey(project: string): string {
  return `${HIDDEN_IMPORTED_PREVIEW_KEY_PREFIX}${encodeURIComponent(project)}`;
}

function readHiddenImportedPreview(project: string): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(hiddenImportedPreviewKey(project)) === "1";
}

function writeHiddenImportedPreview(project: string, hidden: boolean): void {
  if (typeof window === "undefined") return;
  const key = hiddenImportedPreviewKey(project);
  if (hidden) {
    window.localStorage.setItem(key, "1");
  } else {
    window.localStorage.removeItem(key);
  }
}

function splitFilename(filename: string): { name: string; extension: string } {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === filename.length - 1) {
    return { name: filename, extension: "FILE" };
  }
  return {
    name: filename.slice(0, dotIndex),
    extension: filename.slice(dotIndex).toUpperCase(),
  };
}

// ─── subcomponents ───────────────────────────────────────────────────────────

function UploadZone({
  onFile,
  pending,
  className,
}: {
  onFile: (file: File) => void;
  pending: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) onFile(file);
      }}
      className={cn(
        "group flex cursor-pointer flex-col items-center justify-center gap-5 rounded-lg px-6 py-16 text-center transition-colors sm:flex-row sm:gap-8 sm:text-left",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/10",
        dragging ? "bg-white/[0.04]" : "hover:bg-white/[0.02]",
        className,
      )}
    >
      <div className="flex h-[72px] w-14 -rotate-[6deg] items-center justify-center rounded-[10px] bg-white/[0.08] text-muted-foreground transition-all duration-300 ease-out group-hover:rotate-0 group-hover:bg-white/[0.1]">
        <Plus className="size-7 stroke-[1.25px]" />
      </div>
      <div className="space-y-1.5 sm:-mt-1">
        <p className="text-lg font-medium tracking-tight text-foreground">
          {t("ingest.dropzoneHint")}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("ingest.supportedFormats")}
        </p>
        {pending && (
          <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept=".txt,.md,.docx"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
        }}
      />
    </div>
  );
}

function UploadedFileCard({
  filename,
  size,
  status,
  progress,
  currentTask,
  error,
  isIngesting,
  canStart,
  isStarting,
  ingestCostDisplay,
  onStart,
  onCancel,
  isCancelling,
  onReupload,
  onDelete,
}: {
  filename: string;
  size: number | null;
  status: IngestFileStatus;
  progress: number;
  currentTask: string;
  error: string | null;
  isIngesting: boolean;
  canStart: boolean;
  isStarting: boolean;
  ingestCostDisplay?: string | null;
  onStart: () => void;
  onCancel: () => void;
  isCancelling: boolean;
  onReupload: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const percent = Math.round(progress * 100);
  const statusStyles: Record<IngestFileStatus, string> = {
    uploaded: "border-primary/30 bg-primary/10 text-primary",
    importing: "border-primary/30 bg-primary/10 text-primary",
    completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
    stopped: "border-muted-foreground/25 bg-muted/40 text-muted-foreground",
    failed: "border-destructive/35 bg-destructive/10 text-destructive",
  };
  const statusIcon =
    status === "importing" ? (
      <Loader2 className="size-2.5 animate-spin" />
    ) : status === "failed" ? (
      <AlertTriangle className="size-2.5" />
    ) : status === "stopped" ? (
      <Square className="size-2.5" />
    ) : (
      <CheckCircle2 className="size-2.5" />
    );

  return (
    <div className={cn("rounded-lg border p-4", INGEST_SURFACE_CLASS)}>
      <div className="flex items-center gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <FileText className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">
              {filename}
            </p>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium leading-4",
                statusStyles[status],
              )}
            >
              {statusIcon}
              {t(`ingest.status.${status}`)}
            </span>
          </div>
          {size != null && (
            <div className="mt-1 text-xs text-muted-foreground">
              {formatSize(size)}
            </div>
          )}
          {status === "failed" && error && (
            <p className="mt-2 text-xs leading-5 text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isIngesting ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancel}
              disabled={isCancelling}
              className="gap-1.5"
            >
              {isCancelling ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Square className="size-3.5" />
              )}
              {t("common.stop")}
            </Button>
          ) : (
            <>
              {canStart && (
                <Button
                  size="sm"
                  onClick={onStart}
                  disabled={isStarting}
                  className="gap-1.5"
                >
                  {isStarting ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Play className="size-3.5 fill-current" />
                  )}
                  {isStarting ? t("ingest.processing") : t("ingest.startIngest")}
                  <CreditCostInline display={ingestCostDisplay} />
                </Button>
              )}
              {/* 导入完成后去掉「重新上传」「删除」：已导入的小说不再允许就地换文件
                  或删除，避免误操作覆盖/清掉已建好的图谱；未导入（uploaded/stopped/
                  failed）时保留这两个入口。 */}
              {status !== "completed" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onReupload}
                  className="gap-1.5"
                >
                  <RefreshCw className="size-3.5" />
                  {t("common.reupload")}
                </Button>
              )}
              {status !== "completed" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onDelete}
                  className="gap-1.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                  {t("common.delete")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {isIngesting && (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">
              {currentTask || t("ingest.processing")}
            </span>
            <span className="shrink-0 font-mono tabular-nums">{percent}%</span>
          </div>
          <Progress value={percent} />
        </div>
      )}
    </div>
  );
}

function SelectedFileCard({
  filename,
  error,
  onDelete,
}: {
  filename: string;
  error: string | null;
  onDelete: () => void;
}) {
  const { name, extension } = splitFilename(filename);

  return (
    <div className="flex h-full items-center justify-center px-4">
      <div className="relative w-full max-w-[320px] rounded-lg bg-sky-500/20 px-5 py-4 pr-12 text-left">
        <button
          type="button"
          onClick={onDelete}
          aria-label="Remove selected file"
          className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full border border-white/10 bg-black/25 text-foreground/70 transition-colors hover:bg-black/35 hover:text-foreground"
        >
          <X className="size-3" />
        </button>
        <p
          className="truncate text-sm font-medium text-foreground"
          title={name}
        >
          {name}
        </p>
        <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <FileText className="size-4 text-sky-400" />
          <span>{extension}</span>
        </div>
        {error && (
          <p className="mt-3 text-xs leading-5 text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function InputModeToggle({
  value,
  onChange,
  className,
}: {
  value: InputMode;
  onChange: (value: InputMode) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const options: { value: InputMode; label: string }[] = [
    { value: "upload", label: t("ingest.inputMode.upload") },
    { value: "paste", label: t("ingest.inputMode.paste") },
  ];

  return (
    <div
      className={cn(
        "inline-flex h-8 items-center rounded-[8px] border border-white/10 bg-transparent p-1 text-xs",
        className,
      )}
    >
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            className={cn(
              "h-6 flex-1 rounded-[6px] px-2.5 text-xs font-normal leading-none transition-colors md:flex-none",
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={cn("rounded-lg border p-4", INGEST_SURFACE_CLASS)}>
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground/80">
        {label}
      </p>
      <p
        className="mt-2 truncate text-2xl font-bold tracking-tight text-foreground"
        style={{ fontFeatureSettings: '"cv01", "ss03", "tnum"' }}
      >
        {value}
      </p>
    </div>
  );
}

function ChapterPreviewSkeleton() {
  const { t } = useTranslation();

  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("common.loading")}
      className="space-y-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">
          {t("ingest.previewHeading")}
        </h2>
        <span className="text-xs text-muted-foreground">
          {t("ingest.previewGenerating")}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={cn("rounded-lg border p-4", INGEST_SURFACE_CLASS)}>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-8 w-24" />
          </div>
        ))}
      </div>

      <div className={cn("overflow-hidden rounded-lg border", INGEST_SURFACE_SUBTLE_CLASS)}>
        <div className={cn("grid grid-cols-[4rem_1fr_5rem] items-center gap-2 border-b px-4 py-2.5", INGEST_DIVIDER_CLASS)}>
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="ml-auto h-3 w-10" />
        </div>
        <div className="divide-y divide-white/[0.05]">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-[4rem_1fr_5rem] items-center gap-2 px-4 py-2.5"
            >
              <Skeleton className="h-3 w-4" />
              <Skeleton className="h-3 w-28" />
              <Skeleton className="ml-auto h-3 w-8" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── main component ──────────────────────────────────────────────────────────

function IngestPage() {
  const { project } = Route.useParams();
  return <IngestPageContent project={project} />;
}

export function IngestPageContent({ project }: { project: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Upload state
  const [uploadedFile, setUploadedFile] = useState<{
    filename: string;
    size: number;
  } | null>(null);
  const [uploadedFileSource, setUploadedFileSource] =
    useState<UploadedFileSource | null>(null);
  const [inputMode, setInputMode] = useState<InputMode>("upload");
  const [pastedText, setPastedText] = useState("");
  const [ingestSubmitted, setIngestSubmitted] = useState(false);
  const [hideImportedPreview, setHideImportedPreview] = useState(() =>
    readHiddenImportedPreview(project),
  );
  const [ingestFileStatus, setIngestFileStatus] =
    useState<IngestFileStatus>("uploaded");
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [ingestLogs, setIngestLogs] = useState<string[]>([]);
  const [formatCheckDetails, setFormatCheckDetails] = useState<{
    formatCheck: FormatCheck;
    filename: string;
  } | null>(null);
  const logsScrollRef = useRef<HTMLDivElement>(null);

  const uploadMutation = useUploadNovel(project);
  const startIngestMutation = useStartIngest(project);

  useEffect(() => {
    setHideImportedPreview(readHiddenImportedPreview(project));
  }, [project]);

  // Chapters are the durable project-level fact we can restore from after
  // route changes. Upload filename/size is only local session metadata.
  const { data: chaptersRes, isFetching: chaptersFetching } = useChapters(
    project,
    true,
  );
  const chaptersData = chaptersRes?.data;
  const hasImportedContent = (chaptersData?.chapters?.length ?? 0) > 0;

  // Re-import warning if characters already exist
  const { data: charactersRes } = useCharacters(project);
  const hasCharacters = (charactersRes?.data?.length ?? 0) > 0;
  const ingestFeatureCost = useGenerationCreditCost("feature", "ingest_fast");
  const ingestFeatureCostDisplay =
    ingestFeatureCost.data?.data.display ??
    (ingestFeatureCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);

  // SSE task streaming
  const [ingestStarted, setIngestStarted] = useState(false);
  const [reimporting, setReimporting] = useState(false);
  const [reuploadConfirmOpen, setReuploadConfirmOpen] = useState(false);
  const cancelTask = useCancelTask();
  const taskStream = useTaskStream({
    taskType: "ingest_fast",
    project,
    episode: 0,
    enabled: ingestStarted,
    invalidateKeys: [queryKeys.chapters(project)],
    onComplete: async () => {
      setIngestStarted(false);
      setIngestFileStatus("completed");
      setIngestError(null);
      await queryClient.refetchQueries({
        queryKey: queryKeys.chapters(project),
        type: "active",
      });
      toast.success(t("common.generate") + " ✓");
    },
    onError: (error) => {
      setIngestStarted(false);
      setIngestFileStatus("failed");
      setIngestError(error);
    },
  });

  const handleCancelIngest = useCallback(async () => {
    setIngestStarted(false);
    setIngestFileStatus("stopped");
    try {
      await cancelTask.mutateAsync({
        type: "ingest_fast",
        project,
        episode: 0,
      });
      toast.success(t("ingest.stopped"));
    } catch {
      // Already hidden locally; swallow.
    }
  }, [cancelTask, project, t]);

  // Collect ingest logs from SSE currentTask
  useEffect(() => {
    if (taskStream.currentTask && ingestStarted) {
      setIngestLogs((prev) => {
        if (prev[prev.length - 1] === taskStream.currentTask) return prev;
        return [...prev, taskStream.currentTask];
      });
    }
  }, [taskStream.currentTask, ingestStarted]);

  useEffect(() => {
    const root = logsScrollRef.current;
    if (!root) return;
    const viewport = root.querySelector<HTMLDivElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [ingestLogs]);

  // Project config & form
  const { data: projectRes } = useProject(project);
  const { data: stylesRes } = useStyles(project);
  const updateProject = useUpdateProject(project);
  const config = projectRes?.data;
  const normalizedDefaults = normalizeLegacyDefaults(config);
  const visualStyleOptions = useMemo(() => {
    const styles = stylesRes?.data ?? [];
    if (styles.length > 0) {
      return styles.map((style) => ({
        value: style.id,
        label: style.label || style.name || style.id,
      }));
    }
    return VISUAL_STYLE_OPTIONS.map((option) => ({
      value: option.value,
      label: t(option.labelKey),
    }));
  }, [stylesRes?.data, t]);

  const { watch, setValue, getValues } = useForm<SettingsForm>({
    resolver: zodResolver(settingsSchema),
    values: normalizedDefaults,
  });

  const formValues = watch();
  const settingsValues = resolveIngestSettings(formValues, normalizedDefaults);
  const settingsChanged =
    projectRes?.data !== undefined &&
    hasIngestSettingsChanges(settingsValues, config);
  const spineTemplateLabel =
    SPINE_TEMPLATE_OPTIONS.find((opt) => opt.value === settingsValues.spine_template)
      ?.labelKey ?? "ingest.projectTypes.drama";
  const spineTemplateLocked = ingestStarted || (hasImportedContent && !reimporting);
  // 解说风格（第一/第三人称）只对解说剧（narrated）有意义；精品剧（drama）不存在
  // 解说主角/旁白的人称概念，切到精品剧时隐藏入口并在保存时不落库该字段。
  const showNarrationStyle = settingsValues.spine_template === "narrated";

  const handleFieldChange = useCallback(
    (field: keyof SettingsForm, value: string | undefined) => {
      setValue(field, value, { shouldDirty: true });
    },
    [setValue],
  );

  // Surface a non-blocking format warning as a success+risk toast with a
  // "view details" affordance. warning never blocks — upload already succeeded.
  const warnFormatCheck = useCallback(
    (formatCheck: FormatCheck | undefined, filename: string) => {
      if (!formatCheck || formatCheck.level !== "warning") return;
      toast.warning(formatCheck.summary || t("aiAssistant.formatCheck.title"), {
        action: {
          label: t("aiAssistant.formatCheck.viewDetails"),
          onClick: () => setFormatCheckDetails({ formatCheck, filename }),
        },
      });
    },
    [t],
  );

  // Handlers
  const handleFile = useCallback(
    async (file: File) => {
      try {
        const result = await uploadMutation.mutateAsync(file);
        setUploadedFile(result.data);
        setUploadedFileSource("upload");
        setIngestFileStatus("uploaded");
        setIngestError(null);
        toast.success(`${t("common.upload")} ✓ — ${result.data.filename}`);
        warnFormatCheck(result.data.format_check, result.data.filename);
      } catch (error) {
        toast.error(backendErrorToastMessage(error, t));
      }
    },
    [uploadMutation, t, warnFormatCheck],
  );

  const handleReupload = useCallback(() => {
    setUploadedFile(null);
    setUploadedFileSource(null);
    setIngestSubmitted(false);
    setReimporting(true);
    // Transient-only: keep the upload form for the current view, but do NOT
    // persist the "hide preview" intent. If the user navigates away without
    // completing a new import, returning should restore the imported summary.
    setHideImportedPreview(true);
    setIngestFileStatus("uploaded");
    setIngestError(null);
    setIngestLogs([]);
  }, []);

  const handleDeleteFile = useCallback(() => {
    setUploadedFile(null);
    setUploadedFileSource(null);
    setIngestSubmitted(false);
    // 不要复位 reimporting：若用户正在「重新导入」已导入内容（此时 reimporting=true
    // 才让精品剧/解说剧类型可改），删掉刚选的文件只是想换一个文件、仍处于重新导入流程。
    // 复位成 false 会让 spineTemplateLocked 重新把类型选择器锁死，而提示却让人「重新导入」。
    setHideImportedPreview(true);
    writeHiddenImportedPreview(project, true);
    setIngestFileStatus("uploaded");
    setIngestError(null);
    setIngestLogs([]);
    // 上传接口（useUploadNovel.onSuccess）会把「预览章节」直接写进 chapters 缓存，使
    // hasImportedContent 变 true、进而锁住类型选择器。但这只是预览、并未真正导入；删文件后
    // 必须让缓存与后端重新同步，否则全新项目里删完文件类型仍被锁死（要刷新才解锁）。重拉后：
    // 全新项目 → 后端返回空 → 解锁；已真正导入的项目 → 后端仍有章节 → 维持原状（由 reimporting 决定是否可改）。
    queryClient.invalidateQueries({ queryKey: queryKeys.chapters(project) });
    toast.success(t("ingest.fileDeleted"));
  }, [project, queryClient, t]);

  const uploadPastedText = useCallback(async () => {
    const text = pastedText.trim();
    if (!text) return null;
    const file = new File([text], "pasted-novel.txt", {
      type: "text/plain;charset=utf-8",
    });
    const result = await uploadMutation.mutateAsync(file);
    setUploadedFile(result.data);
    setUploadedFileSource("paste");
    setIngestFileStatus("uploaded");
    setIngestError(null);
    warnFormatCheck(result.data.format_check, result.data.filename);
    return result.data;
  }, [pastedText, uploadMutation, warnFormatCheck]);

  const saveProjectSettings = useCallback(async () => {
    const defaults = normalizeLegacyDefaults(config);
    const currentSettings = resolveIngestSettings(
      getValues(),
      defaults,
    );
    const payload = toProjectSettingsPayload(currentSettings);
    // 精品剧（非 narrated）没有解说人称概念，绝不落库 narration_style，
    // 避免给后续流程（如人物声线的「第一人称解说声线」判断）留下误导性的脏值。
    if (currentSettings.spine_template !== "narrated") {
      delete payload.narration_style;
    }
    if (hasImportedContent && reimporting) {
      delete payload.spine_template;
    }
    const hasPayloadChanges = INGEST_SETTING_FIELDS.some((field) => {
      if (!(field in payload)) return false;
      return payload[field] !== defaults[field];
    });
    if (!hasPayloadChanges) return false;
    await updateProject.mutateAsync(payload);
    return true;
  }, [config, getValues, hasImportedContent, reimporting, updateProject]);

  const handleSaveSettings = useCallback(async () => {
    try {
      const saved = await saveProjectSettings();
      if (saved) {
        toast.success(t("ingest.settingsSaved"));
      }
    } catch {
      toast.error(t("ingest.settingsSaveFailed"));
    }
  }, [saveProjectSettings, t]);

  // Save-on-import: persist settings (if changed), then kick off ingest
  const handleStartIngest = useCallback(async () => {
    try {
      const sourceFile =
        inputMode === "upload" ? uploadedFile : await uploadPastedText();
      if (!sourceFile) return;
      await saveProjectSettings();
      setIngestLogs([]);
      setIngestError(null);
      await startIngestMutation.mutateAsync({
        filename: sourceFile.filename,
        rebuild: true,
        spine_template: resolveIngestSettings(getValues(), normalizeLegacyDefaults(config))
          .spine_template,
      });
      setIngestSubmitted(true);
      setHideImportedPreview(false);
      writeHiddenImportedPreview(project, false);
      setIngestStarted(true);
      setReimporting(false);
      setIngestFileStatus("importing");
    } catch (error) {
      setIngestFileStatus("failed");
      const message = backendErrorToastMessage(error, t);
      setIngestError(message);
      toast.error(message);
    }
  }, [
    uploadedFile,
    inputMode,
    uploadPastedText,
    saveProjectSettings,
    startIngestMutation,
    getValues,
    config,
    project,
    t,
  ]);

  const chapters = chaptersData?.chapters ?? [];
  const chapterCount = chapters.length;
  const shouldRestoreImportedPreview =
    hasImportedContent && !hideImportedPreview;
  const shouldShowPreview = ingestSubmitted || shouldRestoreImportedPreview;
  const previewFile =
    uploadedFile ??
    (shouldRestoreImportedPreview
      ? { filename: t("ingest.restoredFilename"), size: null }
      : null);
  const previewStatus: IngestFileStatus =
    uploadedFile || ingestSubmitted ? ingestFileStatus : "completed";
  const totalChars =
    typeof chaptersData?.total_chars === "number"
      ? chaptersData.total_chars
      : chapters.reduce(
          (sum, ch) =>
            sum + (ch.word_count ?? ch.char_count ?? ch.content?.length ?? 0),
          0,
        );
  const totalCharsUnknown = totalChars === 0 && !chaptersData?.total_chars;
  const isStarting = updateProject.isPending || startIngestMutation.isPending;

  // Fallback title for chapters with no title
  const chapterTitle = useCallback(
    (number: number, title?: string | null, content?: string) => {
      const firstLine = content?.split(/\r?\n/)[0]?.trim();
      return (
        title || firstLine || t("ingest.chapterTitleFallback", { n: number })
      );
    },
    [t],
  );

  const canStartFromCurrentInput =
    inputMode === "upload" ? !!uploadedFile : pastedText.trim().length > 0;
  const hasPastedText = pastedText.trim().length > 0;
  const hasUserUploadedFile = uploadedFileSource === "upload" && !!uploadedFile;
  const sourceHint =
    inputMode === "upload" && hasUserUploadedFile && hasPastedText
      ? t("ingest.sourceHint.uploadActive")
      : inputMode === "paste" && hasUserUploadedFile && hasPastedText
        ? t("ingest.sourceHint.pasteActive")
        : "";

  return (
    <div className="-m-6 flex h-[calc(100%+3rem)] flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-3 border-b border-border/30 bg-background px-9 py-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <FishSymbol className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
              {t("ingest.title")}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              {t("ingest.subtitle")}
            </p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-10">
        <div className="mx-auto w-full max-w-[1080px]">
          {!shouldShowPreview ? (
            <motion.section
              layout
              transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
              className="rounded-2xl bg-white/[0.05] p-4"
            >
              <div
                className={cn(
                  "grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out",
                  inputMode === "upload"
                    ? "grid-rows-[188px]"
                    : "grid-rows-[198px]",
                )}
              >
                <div className="relative min-h-0">
                  <div
                    className={cn(
                      "absolute inset-0 transition-all duration-200 ease-out",
                      inputMode === "upload"
                        ? "translate-y-0 opacity-100"
                        : "-translate-y-1 opacity-0 pointer-events-none",
                    )}
                    aria-hidden={inputMode !== "upload"}
                  >
                    {uploadedFile ? (
                      <SelectedFileCard
                        filename={uploadedFile.filename}
                        error={ingestFileStatus === "failed" ? ingestError : null}
                        onDelete={handleDeleteFile}
                      />
                    ) : (
                      <UploadZone
                        onFile={handleFile}
                        pending={uploadMutation.isPending}
                        className="h-full border-0 bg-transparent py-10 hover:border-transparent hover:bg-transparent"
                      />
                    )}
                  </div>
                  <div
                    className={cn(
                      "absolute inset-0 px-2 py-3 transition-all duration-200 ease-out",
                      inputMode === "paste"
                        ? "translate-y-0 opacity-100"
                        : "translate-y-1 opacity-0 pointer-events-none",
                    )}
                    aria-hidden={inputMode !== "paste"}
                  >
                    <Textarea
                      value={pastedText}
                      onChange={(event) =>
                        setPastedText(
                          event.target.value.slice(0, PASTE_TEXT_MAX_LENGTH),
                        )
                      }
                      maxLength={PASTE_TEXT_MAX_LENGTH}
                      placeholder={t("ingest.pastePlaceholder")}
                      className="h-[152px] resize-none rounded-[10px] border-white/10 bg-black/25 p-4 text-sm leading-6 placeholder:text-muted-foreground/55 focus-visible:border-white/25 focus-visible:ring-2 focus-visible:ring-white/8 md:text-sm dark:bg-black/25 [field-sizing:fixed]"
                    />
                    <div className="mt-1.5 flex items-center justify-between gap-3 text-xs leading-4 text-muted-foreground/70">
                      <span className="min-w-0 truncate">{sourceHint}</span>
                      <span className="shrink-0 tabular-nums">
                        {pastedText.length}/{PASTE_TEXT_MAX_LENGTH}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              {inputMode === "upload" && (
                <div className="mt-1.5 h-4 px-1 text-xs leading-4 text-muted-foreground/70">
                  {sourceHint}
                </div>
              )}
              <div className="mt-2.5 grid grid-cols-2 gap-2.5 px-1 md:flex md:items-center md:gap-3">
                <InputModeToggle
                  value={inputMode}
                  onChange={setInputMode}
                  className="col-span-2 w-full md:w-auto"
                />

                {spineTemplateLocked ? (
                  <span
                    className="inline-flex w-full md:w-auto"
                    title={t("ingest.projectTypeLocked")}
                  >
                    <Select value={settingsValues.spine_template} disabled>
                      <SelectTrigger
                        className={cn(COMPACT_SELECT_TRIGGER_CLASS, "opacity-70")}
                        aria-label={`${t("ingest.projectType")}: ${t(spineTemplateLabel)}`}
                      >
                        <SelectValue>
                          {(val: string) => {
                            const opt = SPINE_TEMPLATE_OPTIONS.find(
                              (o) => o.value === val,
                            );
                            return opt ? t(opt.labelKey) : t(spineTemplateLabel);
                          }}
                        </SelectValue>
                      </SelectTrigger>
                    </Select>
                  </span>
                ) : (
                  <Select
                    value={settingsValues.spine_template}
                    onValueChange={(val) =>
                      handleFieldChange("spine_template", val ?? undefined)
                    }
                  >
                    <SelectTrigger className={COMPACT_SELECT_TRIGGER_CLASS}>
                      <SelectValue placeholder={t("ingest.projectType")}>
                        {(val: string) => {
                          const opt = SPINE_TEMPLATE_OPTIONS.find(
                            (o) => o.value === val,
                          );
                          return opt ? t(opt.labelKey) : val;
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent
                      alignItemWithTrigger={false}
                      sideOffset={8}
                      className={COMPACT_SELECT_CONTENT_CLASS}
                    >
                      {SPINE_TEMPLATE_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {t(opt.labelKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                <Select
                  value={settingsValues.visual_style}
                  onValueChange={(val) =>
                    handleFieldChange("visual_style", val ?? undefined)
                  }
                >
                  <SelectTrigger className={COMPACT_SELECT_TRIGGER_CLASS}>
                    <SelectValue placeholder={t("ingest.selectPlaceholder")}>
                      {(val: string) => {
                        const opt = visualStyleOptions.find(
                          (o) => o.value === val,
                        );
                        return opt ? opt.label : val;
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    alignItemWithTrigger={false}
                    sideOffset={8}
                    className={COMPACT_SELECT_CONTENT_CLASS}
                  >
                    {visualStyleOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {showNarrationStyle && (
                  <Select
                    value={settingsValues.narration_style}
                    onValueChange={(val) =>
                      handleFieldChange("narration_style", val ?? undefined)
                    }
                  >
                    <SelectTrigger className={COMPACT_SELECT_TRIGGER_CLASS}>
                      <SelectValue placeholder={t("ingest.selectPlaceholder")}>
                        {(val: string) => {
                          const opt = NARRATION_STYLE_OPTIONS.find(
                            (o) => o.value === val,
                          );
                          return opt ? t(opt.labelKey) : val;
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent
                      alignItemWithTrigger={false}
                      sideOffset={8}
                      className={COMPACT_SELECT_CONTENT_CLASS}
                    >
                      {NARRATION_STYLE_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {t(opt.labelKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                <Select
                  value={settingsValues.ethnicity}
                  onValueChange={(val) =>
                    handleFieldChange("ethnicity", val ?? undefined)
                  }
                >
                  <SelectTrigger className={COMPACT_SELECT_TRIGGER_CLASS}>
                    <SelectValue placeholder={t("ingest.selectPlaceholder")}>
                      {(val: string) => {
                        const opt = ETHNICITY_OPTIONS.find(
                          (o) => o.value === val,
                        );
                        return opt ? t(opt.labelKey) : val;
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    alignItemWithTrigger={false}
                    sideOffset={8}
                    className={COMPACT_SELECT_CONTENT_CLASS}
                  >
                    {ETHNICITY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {t(opt.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Button
                  type="button"
                  variant="outline"
                  onClick={handleSaveSettings}
                  disabled={!settingsChanged || updateProject.isPending || ingestStarted}
                  className="h-8 gap-1.5 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none transition-colors hover:bg-white/8 md:ml-auto"
                >
                  {updateProject.isPending && !startIngestMutation.isPending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <CheckCircle2 className="size-3" />
                  )}
                  {updateProject.isPending && !startIngestMutation.isPending
                    ? t("ingest.processing")
                    : t("ingest.saveSettings")}
                </Button>

                <Button
                  onClick={handleStartIngest}
                  disabled={
                    !canStartFromCurrentInput ||
                    uploadMutation.isPending ||
                    isStarting ||
                    ingestStarted
                  }
                  className="h-8 gap-1.5 rounded-[8px] px-4 text-xs font-normal shadow-none transition-colors hover:bg-primary/85 active:bg-primary/75"
                >
                  <Play className="size-3 fill-current" />
                  {isStarting || ingestStarted
                    ? t("ingest.processing")
                    : t("ingest.startIngest")}
                  <CreditCostInline display={ingestFeatureCostDisplay} />
                </Button>
              </div>
            </motion.section>
          ) : (
            <div className="min-w-0 space-y-6">
              {/* Upload zone OR uploaded file card */}
              {previewFile && (
                <UploadedFileCard
                  filename={previewFile.filename}
                  size={previewFile.size}
                  status={previewStatus}
                  progress={taskStream.progress}
                  currentTask={taskStream.currentTask}
                  error={ingestError}
                  isIngesting={ingestStarted}
                  canStart={!!uploadedFile && !ingestSubmitted}
                  isStarting={isStarting}
                  ingestCostDisplay={ingestFeatureCostDisplay}
                  onStart={handleStartIngest}
                  onCancel={handleCancelIngest}
                  isCancelling={cancelTask.isPending}
                  onReupload={() => setReuploadConfirmOpen(true)}
                  onDelete={handleDeleteFile}
                />
              )}

              <AlertDialog
                open={reuploadConfirmOpen}
                onOpenChange={setReuploadConfirmOpen}
              >
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("ingest.reuploadConfirm.title")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("ingest.reuploadConfirm.description")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => {
                        setReuploadConfirmOpen(false);
                        handleReupload();
                      }}
                    >
                      {t("ingest.reuploadConfirm.confirm")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              {/* Re-import warning */}
              {previewFile && hasCharacters && (
                <div className="flex items-center gap-2 rounded-md bg-amber-300/[0.04] px-3 py-2.5 text-xs text-amber-200/75">
                  <AlertTriangle className="size-4 shrink-0 text-amber-200/70" />
                  <span>{t("ingest.reimportWarning")}</span>
                </div>
              )}

              {/* Preview — loading placeholder */}
              {!chaptersData && chaptersFetching && <ChapterPreviewSkeleton />}

              {/* Preview — empty state (file uploaded but no chapters detected) */}
              {chaptersData && chapterCount === 0 && (
                <div className="rounded-lg border border-dashed border-white/[0.08] bg-white/[0.025] p-8 text-center text-sm text-muted-foreground">
                  {t("ingest.emptyPreview")}
                </div>
              )}

              {/* Preview — populated */}
              {chaptersData && chapterCount > 0 && (
                <div className="space-y-4">
                  <h2 className="text-lg font-semibold text-foreground">
                    {t("ingest.previewHeading")}
                  </h2>

                  {/* Stat cards */}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <StatCard
                      label={t("ingest.statFilename")}
                      value={
                        <span
                          className="block truncate text-sm font-semibold"
                          title={previewFile?.filename}
                        >
                          {previewFile?.filename ??
                            t("ingest.restoredFilename")}
                        </span>
                      }
                    />
                    <StatCard
                      label={t("ingest.statTotalChars")}
                      value={
                        totalCharsUnknown
                          ? <span className="text-muted-foreground/60">—</span>
                          : totalChars.toLocaleString()
                      }
                    />
                    <StatCard
                      label={t("ingest.statChaptersDetected")}
                      value={chapterCount}
                    />
                    <StatCard
                      label={t("ingest.statEpisodesEstimated")}
                      value={
                        <span>
                          {chapterCount}{" "}
                          <span className="text-xs font-medium text-muted-foreground">
                            {t("ingest.episodesUnit")}
                          </span>
                        </span>
                      }
                    />
                  </div>

                  {/* Script details */}
                  <div className={cn("overflow-hidden rounded-lg border p-4", INGEST_SURFACE_SUBTLE_CLASS)}>
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {t("ingest.scriptDetails")}
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {[
                        {
                          label: t("ingest.projectType"),
                          options: SPINE_TEMPLATE_OPTIONS,
                          value: settingsValues.spine_template,
                        },
                        {
                          label: t("ingest.visualStyle"),
                          options: visualStyleOptions,
                          value: settingsValues.visual_style,
                        },
                        ...(showNarrationStyle
                          ? [
                              {
                                label: t("ingest.narrationStyle"),
                                options: NARRATION_STYLE_OPTIONS,
                                value: settingsValues.narration_style,
                              },
                            ]
                          : []),
                        {
                          label: t("ingest.ethnicity"),
                          options: ETHNICITY_OPTIONS,
                          value: settingsValues.ethnicity,
                        },
                      ].map((item) => {
                        const label = resolveOptionLabel(
                          item.options,
                          item.value,
                          t,
                        );
                        return (
                          <div key={item.label} className="min-w-0">
                            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                              {item.label}
                            </p>
                            <p className="mt-1 truncate text-sm font-medium text-foreground">
                              {label ?? item.value}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Chapter table */}
                  <div className={cn("overflow-hidden rounded-lg border", INGEST_SURFACE_SUBTLE_CLASS)}>
                    <div className={cn("grid grid-cols-[4rem_1fr_5rem] items-center gap-2 border-b px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground", INGEST_DIVIDER_CLASS)}>
                      <span>{t("ingest.tableChapterNo")}</span>
                      <span>{t("ingest.tableTitle")}</span>
                      <span className="text-right">
                        {t("ingest.tableCharCount")}
                      </span>
                    </div>
                    <div className="divide-y divide-white/[0.05]">
                      {chapters.slice(0, 20).map((ch) => (
                        <div
                          key={ch.number}
                          className="grid grid-cols-[4rem_1fr_5rem] items-center gap-2 px-4 py-2.5 text-xs"
                        >
                          <span className="tabular-nums text-muted-foreground">
                            {ch.number}
                          </span>
                          <span className="truncate text-foreground">
                            {chapterTitle(ch.number, ch.title, ch.content)}
                          </span>
                          <span className="text-right tabular-nums text-muted-foreground">
                            {(() => {
                              const count =
                                ch.word_count ??
                                ch.char_count ??
                                ch.content?.length;
                              return count != null
                                ? count.toLocaleString()
                                : "—";
                            })()}
                          </span>
                        </div>
                      ))}
                      {chapterCount > 20 && (
                        <div className="px-4 py-2.5 text-center text-xs text-muted-foreground">
                          {t("ingest.moreChapters", {
                            count: chapterCount - 20,
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Logs */}
              {ingestLogs.length > 0 && taskStream.status !== "idle" && (
                <div className="space-y-3">
                  <div className={cn("overflow-hidden rounded-lg border", INGEST_SURFACE_SUBTLE_CLASS)}>
                    <div className={cn("border-b px-4 py-2 text-xs font-medium text-muted-foreground", INGEST_DIVIDER_CLASS)}>
                      {t("ingest.logsPanel")}
                    </div>
                    <ScrollArea ref={logsScrollRef} className="h-48">
                      <div className="space-y-0.5 p-3">
                        {ingestLogs.map((log, i) => (
                          <p
                            key={i}
                            className="font-mono text-xs text-muted-foreground"
                          >
                            <span className="mr-2 text-muted-foreground/50">
                              [{String(i + 1).padStart(2, "0")}]
                            </span>
                            {log}
                          </p>
                        ))}
                      </div>
                    </ScrollArea>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <FormatCheckDetailsDialog
        formatCheck={formatCheckDetails?.formatCheck ?? null}
        filename={formatCheckDetails?.filename}
        open={Boolean(formatCheckDetails)}
        onOpenChange={(next) => {
          if (!next) setFormatCheckDetails(null);
        }}
      />
    </div>
  );
}

export const Route = createFileRoute("/_app/projects/$project/ingest")({
  component: IngestPage,
});
